/**
 * V8 box public door.
 *
 * The Funnel-facing listener owns public setup-code redemption, bearer refresh,
 * and the external WebSocket.  It never owns a Chrome connection.  A redeemed
 * code resolves one declared resident and the door terminates the external WS
 * before copying frames to that resident's loopback HOME relay.
 *
 * The code issuer is deliberately a second loopback-only listener.  A Funnel
 * reverse proxy also arrives from loopback, so source-address checks on the
 * public listener cannot distinguish an internet request from the DCCB runtime.
 * Keeping issuance off the Funnel listener preserves the address+code contract
 * without inventing another browser-facing credential.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Duplex } from "node:stream";
import type { EnrollRedeemResponse } from "../shared/protocol.js";
import { WS_CLOSE_UNAUTHORIZED } from "../shared/protocol.js";
import {
  checkWsBearer,
  enrollmentBindingForAccessToken,
  handleRefresh,
  isAccessTokenValid,
  issueEnrollmentTokens,
  type EnrollmentTokenBinding,
} from "./auth.js";
import {
  BrowserBridgeEnrollmentStore,
  type BrowserBridgeRouteBinding,
  type EnrollmentResult,
  type IssuedSetupCode,
  type RedeemedSetupCode,
} from "./enrollment.js";
import { allowExtensionOrigin, isChromeExtensionOrigin } from "./origin.js";
import { loopbackPeerUid, uidOfUser } from "./peer-uid.js";

export interface PublicDoorRoute extends BrowserBridgeRouteBinding {
  /** Always a local HOME relay endpoint; the public door never routes cross-box. */
  homeWsEndpoint: string;
  /** The HOME's Linux account: only it may ask the issuer for this route's setup code. */
  linuxUser?: string;
}

export interface PublicDoorConfig {
  boxId: string;
  /** The HTTPS Funnel origin shown to an external extension. */
  address: string;
  routes: readonly PublicDoorRoute[];
}

interface PublicDoorRoutesFile {
  schemaVersion: 8;
  boxId: string;
  routes: readonly PublicDoorRoute[];
}

export interface PublicDoorStartOptions {
  config: PublicDoorConfig;
  /** Funnel forwards public HTTPS/WSS here.  Bind it only to loopback. */
  publicPort: number;
  /** DCCB HOME relays call this local-only issuer; Funnel never forwards here. */
  issuerPort: number;
  host?: string;
}

export interface RunningPublicDoor {
  publicServer: Server;
  issuerServer: Server;
  close(): Promise<void>;
}

const LOOPBACK_HOST = "127.0.0.1";
const CODE_ROUTE_SEPARATOR = "\u0000";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > 64 * 1024) return null;
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    return null;
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace("::ffff:", "");
  return address === "127.0.0.1" || address === "::1";
}

function routeKey(route: Pick<PublicDoorRoute, "person" | "boxId">): string {
  return `${route.person}${CODE_ROUTE_SEPARATOR}${route.boxId}`;
}

function socketEndpoint(address: string): string {
  const url = new URL(address);
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}/ws`;
}

function loopbackWsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:"
      && (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost")
      && url.pathname === "/ws";
  } catch {
    return false;
  }
}

function routeIsValid(route: unknown, boxId: string): route is PublicDoorRoute {
  if (!route || typeof route !== "object") return false;
  const value = route as Record<string, unknown>;
  return typeof value.person === "string" && value.person.length > 0
    && value.boxId === boxId
    && value.accessPath === "public-entrance"
    && typeof value.relayBinding === "string" && value.relayBinding.length > 0
    && typeof value.address === "string" && value.address.length > 0
    && typeof value.wsEndpoint === "string" && value.wsEndpoint.length > 0
    && typeof value.homeWsEndpoint === "string" && loopbackWsEndpoint(value.homeWsEndpoint);
}

/** Validate the declaration-derived, box-local door route file before opening listeners. */
export function parsePublicDoorConfig(value: unknown): PublicDoorConfig {
  if (!value || typeof value !== "object") throw new Error("public door config must be an object");
  const raw = value as Partial<PublicDoorRoutesFile> & { address?: unknown };
  if (raw.schemaVersion !== 8 || typeof raw.boxId !== "string" || raw.boxId.length === 0 || !Array.isArray(raw.routes)) {
    throw new Error("public door config is missing schemaVersion, boxId, or routes");
  }
  const address = typeof raw.address === "string" ? raw.address : undefined;
  if (!address) throw new Error("public door config is missing Funnel address");
  const publicUrl = new URL(address);
  if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("public door Funnel address must be an https origin");
  }
  const routes = raw.routes.map((route) => {
    if (!routeIsValid(route, raw.boxId!)) throw new Error("public door route is invalid or crosses boxes");
    const value = route as PublicDoorRoute;
    if (value.address !== publicUrl.toString().replace(/\/$/, "") && value.address !== publicUrl.origin) {
      throw new Error("public door route address must equal its Funnel origin");
    }
    if (value.wsEndpoint !== socketEndpoint(publicUrl.origin)) throw new Error("public door route WebSocket endpoint must be the Funnel /ws path");
    return value;
  });
  if (new Set(routes.map(route => route.person)).size !== routes.length) throw new Error("public door routes contain duplicate people");
  return { boxId: raw.boxId, address: publicUrl.origin, routes };
}

/** Read the immutable route list produced from the V8 mesh declaration by installation. */
export function publicDoorConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): PublicDoorConfig | null {
  const path = env.BB_V8_DOOR_ROUTES_FILE;
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return parsePublicDoorConfig({ ...raw, address: env.BB_V8_DOOR_ADDRESS ?? raw.address });
  } catch {
    return null;
  }
}

function accessToken(req: IncomingMessage, subprotocols: readonly string[] = []): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim() || null;
  const protocol = subprotocols.find(value => value.startsWith("bb-bearer."));
  return protocol ? protocol.slice("bb-bearer.".length) || null : null;
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/** Start one box's public Funnel target and its separate loopback issuer. */
export function startPublicDoor(options: PublicDoorStartOptions): RunningPublicDoor {
  // `publicDoorConfigFromEnvironment()` already returns the normalized runtime
  // shape, which intentionally omits the on-disk schema marker. Reattach that
  // marker before the shared validator runs so entrypoint startup validates the
  // same routes instead of rejecting its own normalized config.
  const config = parsePublicDoorConfig({ schemaVersion: 8, ...options.config });
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST && host !== "::1") throw new Error("public door must bind to loopback; Tailscale Funnel provides public ingress");
  const routes = new Map(config.routes.map(route => [routeKey(route), route]));
  const stores = new Map(config.routes.map(route => [routeKey(route), new BrowserBridgeEnrollmentStore(() => route)]));
  const wss = new WebSocketServer({
    // No fixed frame cap: fetch responses pass through as single frames.
    maxPayload: 0,
    noServer: true,
    handleProtocols(protocols) {
      for (const protocol of protocols) if (protocol.startsWith("bb-bearer.")) return protocol;
      return false;
    },
  });

  const issuerServer = createServer((req, res) => {
    if (req.method === "OPTIONS") { json(res, 204, {}); return; }
    if (!isLoopback(req)) { json(res, 403, { error: "route_unavailable" }); return; }
    if (req.method !== "POST" || req.url !== "/api/enroll/issue") { json(res, 404, { error: "not_found" }); return; }
    void (async () => {
      const body = await readJson(req);
      if (!body || typeof body.person !== "string" || body.box_id !== config.boxId) {
        json(res, 400, { error: "invalid_request" });
        return;
      }
      const key = routeKey({ person: body.person, boxId: config.boxId });
      const route = routes.get(key);
      const store = stores.get(key);
      if (!route || !store) { json(res, 409, { error: "route_mismatch" }); return; }
      // Loopback is every account on the box; the code is the person's, so only their HOME account gets it.
      const owner = route.linuxUser ? uidOfUser(route.linuxUser) : null;
      if (owner === null || loopbackPeerUid(req.socket) !== owner) { json(res, 403, { error: "route_unavailable" }); return; }
      const issued = store.issue({ person: route.person, boxId: route.boxId, accessPath: "public-entrance" });
      if (!issued.ok) { json(res, issued.error === "route_unavailable" ? 503 : 409, { error: issued.error }); return; }
      json(res, 200, {
        address: issued.value!.address,
        setup_code: issued.value!.setupCode,
        expires_at: issued.value!.expiresAt,
        relay_binding: issued.value!.relayBinding,
      });
    })();
  });

  const publicServer = createServer((req, res) => {
    if (req.url === "/api/enroll/redeem" || req.url === "/api/auth/refresh") allowExtensionOrigin(req, res);
    if (req.method === "OPTIONS") { json(res, 204, {}); return; }
    if (req.method === "POST" && req.url === "/api/enroll/redeem") {
      void (async () => {
        const body = await readJson(req);
        if (!body || typeof body.setup_code !== "string" || typeof body.stable_browser_id !== "string") {
          json(res, 400, { error: "invalid_request" });
          return;
        }
        let redeemed: EnrollmentResult<RedeemedSetupCode> | null = null;
        let route: PublicDoorRoute | undefined;
        for (const [key, store] of stores) {
          const result = store.redeem(body.setup_code, body.stable_browser_id);
          // A code this route does not hold is another route's (or no one's): keep looking.
          if (result.ok || (result.error !== "route_unavailable" && result.error !== "unknown_code")) {
            redeemed = result;
            route = routes.get(key);
            break;
          }
        }
        if (!redeemed || !redeemed.ok || !route) {
          const error = redeemed?.error ?? "unknown_code";
          json(res, error === "route_unavailable" ? 503 : error === "route_mismatch" ? 409 : 400, { error });
          return;
        }
        const binding: EnrollmentTokenBinding = {
          person: route.person,
          boxId: route.boxId,
          relayBinding: route.relayBinding,
          homeWsEndpoint: route.homeWsEndpoint,
        };
        const tokens = issueEnrollmentTokens(`v8-${route.person}-${redeemed.value!.browserId}`, binding);
        const response: EnrollRedeemResponse = {
          ws_endpoint: route.wsEndpoint,
          relay_binding: route.relayBinding,
          browser_id: redeemed.value!.browserId,
          ...tokens,
        };
        json(res, 200, response);
      })();
      return;
    }
    if (req.method === "POST" && req.url === "/api/auth/refresh") {
      void (async () => {
        const body = await readJson(req);
        if (!body) { json(res, 400, { error: "invalid_request" }); return; }
        const result = handleRefresh(body as { refresh_token?: string });
        json(res, result.status, result.body);
      })();
      return;
    }
    json(res, 404, { error: "not_found" });
  });

  publicServer.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", config.address);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws") { socket.destroy(); return; }
    const origin = req.headers.origin;
    if (origin !== undefined && !isChromeExtensionOrigin(origin)) {
      console.warn("[public door] WS rejected: Origin is not a Chrome extension");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const subprotocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim()).filter(Boolean);
    const check = checkWsBearer({ authorization: req.headers.authorization, subprotocols, trustLocal: false });
    const bearer = accessToken(req, subprotocols);
    const binding = bearer ? enrollmentBindingForAccessToken(bearer) : null;
    const key = binding ? routeKey(binding) : null;
    const current = key ? routes.get(key) : undefined;
    if (!check.ok || !bearer || !binding || !current
      || current.relayBinding !== binding.relayBinding || current.homeWsEndpoint !== binding.homeWsEndpoint) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, browser => bridgeToHome(browser, current, bearer, url));
  });

  issuerServer.listen(options.issuerPort, host);
  publicServer.listen(options.publicPort, host);
  return {
    publicServer,
    issuerServer,
    async close() {
      for (const client of wss.clients) client.terminate();
      await Promise.all([closeServer(publicServer), closeServer(issuerServer)]);
    },
  };
}

function isSendableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
    || (code >= 3000 && code <= 4999);
}

function bridgeToHome(browser: WebSocket, route: PublicDoorRoute, bearer: string, incomingUrl: URL): void {
  const homeUrl = new URL(route.homeWsEndpoint);
  const browserId = incomingUrl.searchParams.get("id");
  const browserName = incomingUrl.searchParams.get("name");
  if (browserId) homeUrl.searchParams.set("id", browserId);
  if (browserName) homeUrl.searchParams.set("name", browserName);
  const home = new WebSocket(homeUrl, { maxPayload: 0 });
  let closed = false;
  let watch: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!isAccessTokenValid(bearer)) close(WS_CLOSE_UNAUTHORIZED, "token_expired");
  }, 30_000);
  const clearWatch = (): void => { if (watch) clearInterval(watch); watch = null; };
  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    clearWatch();
    // close() throws for a code or reason a close frame cannot carry; the
    // socket must still end, or the browser keeps a dead relay link.
    try { browser.close(code, reason); } catch { browser.terminate(); }
    try { home.close(); } catch { home.terminate(); }
  };
  const forward = (target: WebSocket, data: RawData, isBinary: boolean): void => {
    if (target.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary });
  };
  browser.on("message", (data, isBinary) => forward(home, data, isBinary));
  home.on("message", (data, isBinary) => forward(browser, data, isBinary));
  browser.on("close", () => close(1000, "browser_closed"));
  // 1005/1006/1015 report how a connection ended and are never sent in a frame.
  home.on("close", (code, reason) => close(
    code === 1000 || !isSendableCloseCode(code) ? 1011 : code,
    reason.toString() || "home_closed",
  ));
  browser.on("error", () => close(1011, "browser_error"));
  home.on("error", () => close(1011, "home_unavailable"));
}
