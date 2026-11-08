/**
 * DCCB Browser Bridge v6 — relay server hub (now auth-gated).
 *
 * Listeners:
 *   - WebSocket on ws://<WS_HOST>:8765 — accepts MULTIPLE enrolled extensions.
 *     Remote connections require a route-bound bearer issued by code redemption.
 *     A same-box loopback connection may still use the legacy local path.
 *   - HTTP on <HTTP_HOST>:8766 — POST /send injects a tool_request (10s timeout;
 *     handoff waits for the extension's human-response timeout),
 *     optional `target` browserId selects which browser; GET /browsers lists the
 *     connected browsers (so the AI can discover targets); plus the auth routes:
 *     AND hosts the RFC 8628 auth endpoints:
 *         POST /api/auth/device   issue device_code + user_code
 *         POST /api/auth/token    poll (authorization_pending / slow_down)
 *         POST /api/auth/refresh  exchange refresh → new access token
 *         POST /api/auth/approve  loopback only: legacy pairing approval
 *         POST /api/auth/deny     INTERNAL: AI denies a pairing
 *
 * The HTTP server may bind to a Tailnet address; approve/deny are explicitly
 * loopback-only rather than relying on that bind address.
 * WebSocket bearer auth protects extension connections; a HOME-local secret
 * protects browser-control HTTP routes from other local processes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { loopbackPeerUid, trustedLocalUids } from "./peer-uid.js";
import type { Duplex } from "node:stream";
import type { BridgeMessage, EnrollRedeemResponse, ToolRequest, ToolResponse } from "../shared/protocol.js";
import { isExtensionVersion, WS_CLOSE_UNAUTHORIZED } from "../shared/protocol.js";
import {
  loadTokensFromDisk,
  startAuthSweep,
  handleRefresh,
  issueEnrollmentTokens,
  checkWsBearer,
  enrollmentBindingForAccessToken,
  isAccessTokenValid,
  loadOrCreateHttpControlSecret,
  type AuthResult,
} from "./auth.js";
import { createPipeEndpoint } from "./pipe/endpoint.js";
import { runHttpHandler } from "./http-handler.js";
import { isChromeExtensionOrigin } from "./origin.js";
import {
  BrowserBridgeEnrollmentStore,
  routeFromEnvironment,
  type BrowserBridgeAccessPath,
} from "./enrollment.js";

// BRIDGE_BIND_HOST is the single bind address for BOTH the WS and HTTP
// listeners. Default stays loopback (127.0.0.1); set it to 0.0.0.0 so a remote
// (Tailscale) extension can reach :8765/:8766. The per-listener BRIDGE_WS_HOST/
// (legacy) override still wins for the WS port if explicitly set.
const BIND_HOST = process.env.BRIDGE_BIND_HOST || "127.0.0.1";
const WS_HOST = process.env.BRIDGE_WS_HOST || BIND_HOST;
const WS_PORT = Number(process.env.BRIDGE_WS_PORT || 8765);
const HTTP_HOST = process.env.BRIDGE_HTTP_HOST || BIND_HOST;
// A Tailnet-direct HOME must expose enrollment on its declared Tailnet address
// while its DCCB runtime continues to control the same relay through loopback.
// A second address on the *same* HTTP port provides that local control surface;
// it is deliberately not a second public route or a different command handler.
const CONTROL_HTTP_HOST = process.env.BRIDGE_CONTROL_HTTP_HOST || null;
const HTTP_PORT = Number(process.env.BRIDGE_HTTP_PORT || 8766);
const REQUEST_TIMEOUT_MS = 10_000;
const HTTP_CONTROL_SECRET = loadOrCreateHttpControlSecret();
const enrollment = new BrowserBridgeEnrollmentStore(routeFromEnvironment);
const DOOR_ISSUER_URL = configuredDoorIssuerUrl();

/**
 * Legacy local connection mode:
 *
 *   - TRUST_LOCAL  (BRIDGE_TRUST_LOCAL, default ON): loopback sources
 *     (127.0.0.1 / ::1) may connect WITHOUT a bearer. This preserves the
 *     same-box legacy path; it does not isolate Linux accounts from each other.
 * Tailnet source addresses are never an authentication factor. Direct V8
 * enrollment issues a route-bound bearer after the human enters a setup code.
 */
const TRUST_LOCAL = process.env.BRIDGE_TRUST_LOCAL !== "0";

/**
 * Connected extensions, keyed by browserId (multi-browser-per-user, restoring
 * a v5 capability the v6 rewrite dropped). A single per-user server now accepts
 * MULTIPLE browsers from its own user; the AI targets one via `/send`'s
 * `target` field. Cross-USER isolation is unchanged (separate server processes).
 *
 * The browserId is self-reported by the extension on the `/ws` query string
 * (`?id=&name=`, mirroring v5); its version arrives in the first WS hello frame.
 * `name` is a human label for the AI to pick by.
 */
interface ConnectedBrowser {
  ws: WebSocket;
  id: string;
  name: string;
  connectedAt: string;
  version: string | null;
}
const browsers = new Map<string, ConnectedBrowser>();
let cachedReleaseVersion: { path: string; size: number; mtimeMs: number; version: string | null } | undefined;
let lastAnnouncedReleaseVersion: string | null | undefined;

/** Read the product version from this HOME's distributed extension ZIP, not source code. */
function distributedExtensionVersion(): string | null {
  const path = process.env.DCCB_BROWSER_BRIDGE_RELEASE_ZIP;
  if (!path) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    if (cachedReleaseVersion?.path === path && cachedReleaseVersion.size === stat.size && cachedReleaseVersion.mtimeMs === stat.mtimeMs) {
      return cachedReleaseVersion.version;
    }
    const archive = readFileSync(path);
    const scanStart = Math.max(0, archive.length - 22 - 0xffff);
    let end = -1;
    for (let offset = archive.length - 22; offset >= scanStart; offset--) {
      if (archive.readUInt32LE(offset) === 0x06054b50
        && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) { end = offset; break; }
    }
    if (end < 0 || archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0) return null;
    const count = archive.readUInt16LE(end + 10);
    const directoryEnd = archive.readUInt32LE(end + 16) + archive.readUInt32LE(end + 12);
    let offset = archive.readUInt32LE(end + 16);
    let manifestEntry: { method: number; compressedSize: number; localOffset: number } | undefined;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > directoryEnd || archive.readUInt32LE(offset) !== 0x02014b50) return null;
      const nameLength = archive.readUInt16LE(offset + 28);
      const extraLength = archive.readUInt16LE(offset + 30);
      const commentLength = archive.readUInt16LE(offset + 32);
      const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
      if (name === "manifest.json") {
        if (manifestEntry) return null;
        manifestEntry = {
          method: archive.readUInt16LE(offset + 10),
          compressedSize: archive.readUInt32LE(offset + 20),
          localOffset: archive.readUInt32LE(offset + 42),
        };
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    if (!manifestEntry || manifestEntry.localOffset + 30 > archive.length || archive.readUInt32LE(manifestEntry.localOffset) !== 0x04034b50) return null;
    const dataStart = manifestEntry.localOffset + 30 + archive.readUInt16LE(manifestEntry.localOffset + 26) + archive.readUInt16LE(manifestEntry.localOffset + 28);
    const dataEnd = dataStart + manifestEntry.compressedSize;
    if (dataEnd > archive.length) return null;
    const compressed = archive.subarray(dataStart, dataEnd);
    const json = manifestEntry.method === 0 ? compressed.toString("utf8")
      : manifestEntry.method === 8 ? inflateRawSync(compressed).toString("utf8") : "";
    const manifest = JSON.parse(json) as { version?: unknown };
    const version = isExtensionVersion(manifest.version) ? manifest.version : null;
    cachedReleaseVersion = { path, size: stat.size, mtimeMs: stat.mtimeMs, version };
    return version;
  } catch {
    return null;
  }
}

/** Refresh on connections, issuer reads and keepalives so an in-place ZIP update reaches live clients. */
function refreshDistributedExtensionVersion(): string | null {
  const version = distributedExtensionVersion();
  if (version !== lastAnnouncedReleaseVersion) {
    lastAnnouncedReleaseVersion = version;
    for (const browser of browsers.values()) {
      if (browser.ws.readyState === browser.ws.OPEN) send(browser.ws, { type: "latest_extension_version", version });
    }
  }
  return version;
}

/** Pending HTTP /send calls awaiting their tool_response, keyed by request id. */
const pending = new Map<
  string,
  {
    resolve: (r: ToolResponse) => void;
    reject: (err: ToolDispatchError) => void;
    timer?: NodeJS.Timeout;
    ws: WebSocket;
    tool: string;
  }
>();

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), "[server]", ...args);
}

// --- Boot: load persisted tokens + start TTL sweep --------------------------

loadTokensFromDisk();
const authSweep = startAuthSweep();

// --- WebSocket hub (auth-gated upgrade) -------------------------------------

// `handleProtocols` lets `ws` echo the bearer subprotocol back in the 101 so
// the handshake is well-formed when the client passes `bb-bearer.<token>` as a
// Sec-WebSocket-Protocol. (The header path needs no echo.) Returning false here
// would 400 the upgrade, so we only ever pick a protocol we recognise.
const wss = new WebSocketServer({
  // No fixed frame cap: a fetch response arrives as one frame of any size.
  maxPayload: 0,
  noServer: true,
  handleProtocols: (protocols) => {
    for (const p of protocols) {
      if (p.startsWith("bb-bearer.")) return p;
    }
    return false;
  },
});

const wsHttp = createServer((_req, res) => {
  // No plain-HTTP routes on the WS port; it exists purely for the upgrade.
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("upgrade required");
});

wsHttp.on("upgrade", (req, socket, head) => {
  // A malformed request-target must not reach an uncaught throw (it would stop
  // the relay); treat it like any other non-/ws upgrade.
  let url: URL;
  try {
    url = new URL(req.url || "/", `http://${WS_HOST}:${WS_PORT}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  // Browser WebSocket connections always carry Origin. Only the paired
  // extension origin is expected here; ordinary loopback web pages must not
  // be able to impersonate a browser by opening a socket to this listener.
  // Node clients used by the same-box public door intentionally omit Origin.
  const origin = req.headers.origin;
  if (origin !== undefined && !isChromeExtensionOrigin(origin)) {
    log("WS rejected: Origin is not a Chrome extension");
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const subprotocols = (req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const check = checkWsBearer({
    authorization: req.headers["authorization"],
    subprotocols,
    trustLocal: isTrustedSource(socket),
  });

  // A direct V8 socket must present a token minted by this HOME's one-time
  // setup code. Legacy device-flow tokens have no route binding and cannot
  // stand in for the dashboard's human enrollment action.
  const route = routeFromEnvironment();
  if (check.ok && route?.accessPath === "tailnet-direct" && !isLoopback(socket)) {
    const token = extractBearer(req, subprotocols);
    const binding = token ? enrollmentBindingForAccessToken(token) : null;
    if (!binding || binding.person !== route.person || binding.boxId !== route.boxId
      || binding.relayBinding !== route.relayBinding || binding.homeWsEndpoint !== route.wsEndpoint) {
      log("WS rejected: direct bearer is not bound to this HOME; enter the current dashboard code to re-enroll");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  if (!check.ok) {
    // 401 at the HTTP layer: the upgrade never completes, so the client's
    // WebSocket fails to open and the extension drops back to refresh/repair.
    log(route?.accessPath === "tailnet-direct" && !extractBearer(req, subprotocols)
      ? "WS rejected: tokenless Tailnet-direct enrollment is no longer accepted; reinstall the current extension and enter a fresh dashboard address/code"
      : "WS rejected: missing, invalid, or expired bearer");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Multi-browser identity: the extension MAY self-report `?id=&name=` (v5
  // style). When it doesn't (today's v6 extension supplies neither), assign a
  // short random id and derive a friendly name from the bearer's clientId.
  const selfId = url.searchParams.get("id")?.trim() || undefined;
  const selfName = url.searchParams.get("name")?.trim() || undefined;

  // `handleProtocols` (set on the WebSocketServer) already echoes the
  // `bb-bearer.*` subprotocol back into the 101, so no per-upgrade options are
  // needed here. handleUpgrade's signature is (request, socket, head, cb).
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    handleConnection(ws, req, subprotocols, {
      id: selfId,
      name: selfName,
      clientId: check.clientId,
    });
  });
});

/** Normalised remote IP of the upgrade socket (IPv4-mapped IPv6 unwrapped). */
function remoteAddr(socket: Duplex): string | undefined {
  // The upgrade socket is a net.Socket at runtime, but the upgrade event types
  // it as a bare Duplex (which has no remoteAddress). Read it through a narrow
  // cast rather than widening the param to net.Socket (which Duplex isn't).
  return (socket as { remoteAddress?: string }).remoteAddress?.replace(
    "::ffff:",
    "",
  );
}

function isLoopback(socket: Duplex): boolean {
  const addr = remoteAddr(socket);
  return addr === "127.0.0.1" || addr === "::1";
}

const TRUSTED_LOCAL_UIDS = trustedLocalUids();

/** Same account (or the box's public door), not merely the same box. */
function isTrustedLocalAccount(socket: { remotePort?: number; localPort?: number }): boolean {
  const uid = loopbackPeerUid(socket);
  return uid !== null && TRUSTED_LOCAL_UIDS.has(uid);
}

/** Only the legacy same-box loopback path may omit a bearer, and only from this account or the door. */
function isTrustedSource(socket: Duplex): boolean {
  return TRUST_LOCAL && isLoopback(socket) && isTrustedLocalAccount(socket as { remotePort?: number; localPort?: number });
}

function handleConnection(
  ws: WebSocket,
  req: IncomingMessage,
  subprotocols: string[],
  identity: { id?: string; name?: string; clientId?: string },
): void {
  // Resolve the browser key. Self-reported id wins; otherwise assign a short
  // random one. A stable clientId (bearer/WSS mode) is used as the fallback id
  // so the SAME paired browser keeps one slot across reconnects.
  const id =
    identity.id ||
    (identity.clientId && identity.clientId !== "trusted-local"
      ? `c-${identity.clientId.slice(0, 8)}`
      : `b-${randomUUID().slice(0, 8)}`);
  const name = identity.name || defaultBrowserName(id, identity.clientId);

  // Multi-browser: accept this connection. If a browser with the SAME id is
  // already registered, drop the stale one (a reconnect of the same extension)
  // so we never keep a dead dupe. Different ids coexist.
  const existing = browsers.get(id);
  if (existing && existing.ws !== ws) {
    log(`replacing existing connection for browser ${id} (stale dupe)`);
    try {
      existing.ws.close(1012, "replaced by newer connection");
    } catch {
      /* already closing */
    }
  }

  const entry: ConnectedBrowser = {
    ws,
    id,
    name,
    connectedAt: new Date().toISOString(),
    version: null,
  };
  browsers.set(id, entry);
  log(`extension connected: ${id} (${name}); ${browsers.size} now connected`);
  const route = routeFromEnvironment();
  const latestExtensionVersion = refreshDistributedExtensionVersion();
  if (route) send(ws, {
    type: "relay_binding",
    relay_binding: route.relayBinding,
    browser_id: id,
    latest_extension_version: latestExtensionVersion,
  });

  // If this connection was bearer-authed (not trusted-local), poll the token's
  // validity and close 4401 once it expires so the client refreshes+reconnects.
  const bearer = extractBearer(req, subprotocols);
  let tokenWatch: ReturnType<typeof setInterval> | null = null;
  if (bearer) {
    tokenWatch = setInterval(() => {
      if (!isAccessTokenValid(bearer)) {
        log("bearer expired mid-session; closing 4401");
        ws.close(WS_CLOSE_UNAUTHORIZED, "token_expired");
      }
    }, 30_000);
  }

  ws.on("message", (data) => {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(data.toString()) as BridgeMessage;
    } catch {
      log("dropping non-JSON frame");
      return;
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      log("dropping non-object frame");
      return;
    }

    if (pipe.onExtensionFrame(ws, msg)) return;
    switch (msg.type) {
      case "ping":
        refreshDistributedExtensionVersion();
        send(ws, { type: "pong" });
        break;
      case "extension_hello": {
        const current = browsers.get(id);
        if (current?.ws === ws) current.version = isExtensionVersion(msg.version) ? msg.version : null;
        break;
      }
      case "tool_response": {
        const waiter = pending.get(msg.id);
        if (waiter) {
          if (waiter.timer) clearTimeout(waiter.timer);
          pending.delete(msg.id);
          waiter.resolve(msg);
        } else {
          log("tool_response for unknown id", msg.id);
        }
        break;
      }
      default:
        log("ignoring inbound", msg.type);
    }
  });

  ws.on("close", () => {
    if (tokenWatch) clearInterval(tokenWatch);
    pipe.onBrowserClosed(ws);
    for (const [requestId, waiter] of pending) {
      if (waiter.ws !== ws) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      pending.delete(requestId);
      waiter.reject(new ToolDispatchError(`browser disconnected: ${waiter.tool}`, "no_extension"));
    }
    // Only delete if this exact socket still owns the slot (a same-id replace
    // above may have already swapped a newer socket in under the same key).
    if (browsers.get(id)?.ws === ws) {
      browsers.delete(id);
      log(`extension disconnected: ${id}; ${browsers.size} now connected`);
    }
  });

  ws.on("error", (err) => log("ws error", err.message));
}

/** Human-friendly default label for a browser that didn't self-report a name. */
function defaultBrowserName(id: string, clientId?: string): string {
  if (clientId && clientId !== "trusted-local") return `browser ${id}`;
  return `browser ${id} (tailscale)`;
}

function extractBearer(req: IncomingMessage, subprotocols: string[]): string | null {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const proto = subprotocols.find((p) => p.startsWith("bb-bearer."));
  if (proto) return proto.slice("bb-bearer.".length);
  return null;
}

function send(ws: WebSocket, msg: BridgeMessage): void {
  ws.send(JSON.stringify(msg));
}

// --- Reusable tool dispatch (send-and-await-by-id) --------------------------

/**
 * Raised when a tool can't be dispatched or its result doesn't arrive in time.
 * `code` lets callers (HTTP /send, the code-mode SDK) map the failure to the
 * right status without string-matching the message.
 *   - no_extension    → zero browsers connected (503)
 *   - unknown_target  → a `target` was given but no browser has that id (404)
 *   - ambiguous       → multiple browsers, no `target` given; caller must pick (409)
 *   - timeout         → the chosen browser didn't respond in time (504)
 */
export class ToolDispatchError extends Error {
  constructor(
    message: string,
    readonly code: "no_extension" | "unknown_target" | "ambiguous" | "timeout",
    /** Extra data for the JSON body (e.g. the list of connected browsers). */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolDispatchError";
  }
}

/** Snapshot of currently-connected browsers (for the list endpoint / errors). */
function listBrowsers(): { id: string; name: string; connectedAt: string; version: string | null }[] {
  return [...browsers.values()]
    .filter((b) => b.ws.readyState === b.ws.OPEN)
    .map(({ id, name, connectedAt, version }) => ({ id, name, connectedAt, version }));
}

/**
 * Pick the browser to dispatch to, given an optional `target` browserId.
 *   - target given      → that browser, or throw `unknown_target` (404).
 *   - no target, 0      → throw `no_extension` (503).
 *   - no target, 1      → use it (backward-compatible single-browser path).
 *   - no target, 2+     → throw `ambiguous` (409) listing the choices.
 */
function resolveTarget(target?: string): ConnectedBrowser {
  if (target) {
    const b = browsers.get(target);
    if (!b || b.ws.readyState !== b.ws.OPEN) {
      throw new ToolDispatchError(
        `unknown target browser: ${target}`,
        "unknown_target",
        { target, browsers: listBrowsers() },
      );
    }
    return b;
  }

  const open = [...browsers.values()].filter((b) => b.ws.readyState === b.ws.OPEN);
  if (open.length === 0) {
    throw new ToolDispatchError("no extension connected", "no_extension");
  }
  if (open.length === 1) {
    return open[0];
  }
  throw new ToolDispatchError(
    `multiple browsers connected; specify a "target" browserId`,
    "ambiguous",
    { browsers: listBrowsers() },
  );
}

/**
 * Forward a single `tool_request` to the chosen extension and resolve with its
 * `ToolResponse`, correlated by request id. This is the ONE send-and-await
 * primitive: HTTP `POST /send` and the code-mode `BrowserSDK` both go through
 * it, so the extension protocol lives in exactly one place.
 *
 * `target` (optional) selects which connected browser to route to; resolution
 * follows {@link resolveTarget}. Rejects with `ToolDispatchError` (no_extension
 * / unknown_target / ambiguous) when no single browser can be chosen, and
 * `timeout` if the response doesn't arrive within REQUEST_TIMEOUT_MS. `fetch`
 * has no relay timer: it ends with the extension's response or the browser
 * connection closing. A
 * non-undefined `ToolResponse.error` is surfaced by the CALLER (it's a valid,
 * resolved response on the wire), not here.
 */
export function invokeTool(
  tool: string,
  args: Record<string, unknown> = {},
  target?: string,
  signal?: AbortSignal,
): Promise<ToolResponse> {
  return new Promise<ToolResponse>((resolve, reject) => {
    let browser: ConnectedBrowser;
    try {
      browser = resolveTarget(target);
    } catch (err) {
      reject(err);
      return;
    }

    const request: ToolRequest = {
      id: randomUUID(),
      type: "tool_request",
      tool,
      args,
    };

    // fetch and handoff (which waits for a person) end on the extension's own limits.
    const timer = tool === "fetch" || tool === "handoff" ? undefined : setTimeout(() => {
      pending.delete(request.id);
      reject(new ToolDispatchError(`tool timeout: ${tool}`, "timeout"));
    }, REQUEST_TIMEOUT_MS);

    pending.set(request.id, { resolve, reject, timer, ws: browser.ws, tool });
    // The caller went away (e.g. the HTTP client closed): stop waiting so no
    // waiter outlives its request. A later response is logged as unknown.
    signal?.addEventListener("abort", () => {
      if (!pending.has(request.id)) return;
      if (timer) clearTimeout(timer);
      pending.delete(request.id);
      reject(new ToolDispatchError(`caller closed: ${tool}`, "timeout"));
    }, { once: true });
    send(browser.ws, request);
    log("forwarded tool_request", request.tool, request.id, "→", browser.id);
  });
}

// --- HTTP server: /send + auth endpoints ------------------------------------

/** Local HTTP control is for this HOME's DCCB process, not other local callers. */
function requireLocalControl(req: IncomingMessage, res: ServerResponse): boolean {
  const supplied = req.headers["x-dccb-relay-secret"];
  if (typeof supplied !== "string") {
    writeJson(res, 401, { error: "missing_relay_secret" });
    return false;
  }
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(HTTP_CONTROL_SECRET);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    writeJson(res, 401, { error: "invalid_relay_secret" });
    return false;
  }
  // The secret can leak (process arguments are visible to every account on a
  // shared box); only this relay's own account may use it.
  if (isLoopbackHttp(req) && loopbackPeerUid(req.socket) === process.getuid?.()) return true;
  writeJson(res, 403, { error: "route_unavailable" });
  return false;
}

const handleHttpRequest = (req: IncomingMessage, res: ServerResponse) => {
  // Current extensions perform these two capability-authenticated bootstrap
  // calls directly against their configured HOME/public origin. Every local
  // control, issuer, legacy auth, and unknown HTTP route requires this HOME's
  // secret; no response grants browser-page CORS access.
  const extensionHttpCallback = (req.method === "POST" || req.method === "OPTIONS")
    && (req.url === "/api/enroll/redeem" || req.url === "/api/auth/refresh");
  if (req.method === "OPTIONS") {
    if (!extensionHttpCallback && !requireLocalControl(req, res)) return;
    writeJson(res, 204, {});
    return;
  }
  if (!extensionHttpCallback && !requireLocalControl(req, res)) return;

  if (req.method === "GET" && req.url === "/browsers") {
    // Discovery endpoint: which browsers are connected, so the AI can pick a
    // `target`. 503 (not 200 with []) when none, mirroring /send's 503 so the
    // "nothing connected" case is one consistent status.
    const list = listBrowsers();
    writeJson(res, list.length ? 200 : 503, { browsers: list });
    return;
  }

  if (req.method === "POST" && req.url === "/send") {
    runHttpHandler("/send", res, () => handleSend(req, res));
    return;
  }

  if (req.method === "POST" && req.url === "/api/enroll/issue") {
    runHttpHandler("/api/enroll/issue", res, () => handleEnrollmentIssue(req, res));
    return;
  }

  if (req.method === "POST" && req.url === "/api/enroll/redeem") {
    runHttpHandler("/api/enroll/redeem", res, () => handleEnrollmentRedeem(req, res));
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/api/auth/")) {
    // Refresh is handled above as an extension callback; this local-secret path keeps it for tests.
    runHttpHandler(req.url, res, () => handleAuth(req, res));
    return;
  }

  writeJson(res, 404, { error: "not found" });
};

const http = createServer(handleHttpRequest);

/** HOME incidents go to the DCCB relay entry over IPC, which shows them to the person (11-06 major). */
function reportIncident(id: string, text?: string, hint?: string): void {
  process.send?.({ type: "dccb_incident", id, text, hint });
}

// Pipe (1.1.0): agent-browser drives the person's Chrome over ws://127.0.0.1:<HTTP port>/cdp/<workspace>.
const pipe = createPipeEndpoint({
  findBrowser: target => resolveTarget(target),
  send,
  log,
  report: reportIncident,
});
const pipeUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (!pipe.handleUpgrade(req, socket, head)) socket.destroy();
};
http.on("upgrade", pipeUpgrade);
const controlHttp = CONTROL_HTTP_HOST && CONTROL_HTTP_HOST !== HTTP_HOST
  ? createServer(handleHttpRequest)
  : null;
// A HOME relay serves 127.0.0.1 on this separate control server; without its own upgrade listener
// Node hands the upgrade to handleHttpRequest, which answers 401 (1.1.0 on the HOME).
controlHttp?.on("upgrade", pipeUpgrade);

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function isLoopbackHttp(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace("::ffff:", "");
  return address === "127.0.0.1" || address === "::1";
}

/** The HOME-local issuer forwards external codes only to its same-box public door. */
function configuredDoorIssuerUrl(value = process.env.BB_V8_DOOR_ISSUER_URL): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
    if (url.protocol !== "http:" || !local || url.pathname !== "/api/enroll/issue" || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

interface DoorIssueResult {
  status: number;
  error?: string;
  value?: { address: string; setup_code: string; expires_at: number; relay_binding: string };
}

/** Preserve the original loopback issuer surface while making code state door-owned for external people. */
async function issueAtPublicDoor(
  issuer: URL,
  request: { person: string; boxId: string; accessPath: BrowserBridgeAccessPath },
): Promise<DoorIssueResult> {
  const route = routeFromEnvironment();
  if (!route || route.person !== request.person || route.boxId !== request.boxId || route.accessPath !== request.accessPath) {
    return { status: 409, error: "route_mismatch" };
  }
  try {
    const response = await fetch(issuer, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ person: request.person, box_id: request.boxId }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error : "route_unavailable";
      return { status: response.status >= 500 ? 503 : response.status, error };
    }
    if (!body || typeof body !== "object") return { status: 503, error: "route_unavailable" };
    const value = body as Record<string, unknown>;
    if (typeof value.address !== "string" || typeof value.setup_code !== "string"
      || typeof value.expires_at !== "number" || typeof value.relay_binding !== "string") {
      return { status: 503, error: "route_unavailable" };
    }
    return {
      status: 200,
      value: {
        address: value.address,
        setup_code: value.setup_code,
        expires_at: value.expires_at,
        relay_binding: value.relay_binding,
      },
    };
  } catch {
    return { status: 503, error: "route_unavailable" };
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function handleEnrollmentIssue(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!body || typeof body.person !== "string" || typeof body.box_id !== "string"
    || (body.access_path !== "tailnet-direct" && body.access_path !== "public-entrance")) {
    writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const request = {
    person: body.person,
    boxId: body.box_id,
    accessPath: body.access_path as BrowserBridgeAccessPath,
  };
  const latestExtensionVersion = refreshDistributedExtensionVersion();
  const route = routeFromEnvironment();
  if (route?.accessPath === "public-entrance") {
    if (!DOOR_ISSUER_URL) {
      writeJson(res, 503, { error: "route_unavailable" });
      return;
    }
    const result = await issueAtPublicDoor(DOOR_ISSUER_URL, request);
    if (result.status !== 200 || !result.value) {
      writeJson(res, result.status, { error: result.error });
      return;
    }
    writeJson(res, 200, { ...result.value, latest_extension_version: latestExtensionVersion, connected_browsers: listBrowsers() });
    return;
  }
  const result = enrollment.issue(request);
  if (!result.ok) {
    writeJson(res, result.error === "route_unavailable" ? 503 : 409, { error: result.error });
    return;
  }
  writeJson(res, 200, {
    address: result.value!.address,
    setup_code: result.value!.setupCode,
    expires_at: result.value!.expiresAt,
    relay_binding: result.value!.relayBinding,
    latest_extension_version: latestExtensionVersion,
    connected_browsers: listBrowsers(),
  });
}

async function handleEnrollmentRedeem(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!body || typeof body.setup_code !== "string" || typeof body.stable_browser_id !== "string") {
    writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  // An external extension redeems at its Funnel public door.  HOME never
  // accepts that code directly, so a private loopback endpoint cannot become a
  // parallel public entrance by accident.
  if (routeFromEnvironment()?.accessPath === "public-entrance") {
    writeJson(res, 403, { error: "route_unavailable" });
    return;
  }
  const result = enrollment.redeem(body.setup_code, body.stable_browser_id);
  if (!result.ok) {
    const status = result.error === "expired_code" || result.error === "used_code" ? 400
      : result.error === "route_unavailable" ? 503 : 409;
    writeJson(res, status, { error: result.error });
    return;
  }
  const route = result.value!;
  const bearer = issueEnrollmentTokens(`v8-${route.person}-${route.browserId}`, {
    person: route.person, boxId: route.boxId, relayBinding: route.relayBinding,
    homeWsEndpoint: route.wsEndpoint,
  });
  const response: EnrollRedeemResponse = {
    ws_endpoint: route.wsEndpoint,
    relay_binding: route.relayBinding,
    browser_id: route.browserId,
    ...(bearer ?? {}),
  };
  writeJson(res, 200, response);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed) {
    writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  let result: AuthResult;
  switch (req.url) {
    case "/api/auth/refresh":
      result = handleRefresh(parsed as { refresh_token?: string });
      break;
    default:
      result = { status: 404, body: { error: "not found" } };
  }
  writeJson(res, result.status, result.body);
}

async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    writeJson(res, 400, { error: "body too large" });
    return;
  }

  let parsed: { tool?: string; args?: Record<string, unknown>; target?: unknown; workspace?: unknown };
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    writeJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  const tool = parsed.tool;
  if (typeof tool !== "string" || tool.length === 0) {
    writeJson(res, 400, { error: "missing 'tool'" });
    return;
  }

  // Optional `target` (browserId) routes to a specific connected browser.
  // Anything non-string is treated as "no target" (let resolution decide).
  const target = typeof parsed.target === "string" && parsed.target ? parsed.target : undefined;

  // Server-side meta-tool: list connected browsers without a round-trip to any
  // extension, so the AI can discover targets through the same POST /send path
  // it already uses (`{"tool":"browsers","args":{"action":"list"}}`).
  if (tool === "browsers") {
    const list = listBrowsers();
    writeJson(res, list.length ? 200 : 503, {
      type: "tool_response",
      result: { browsers: list },
    });
    return;
  }

  const caller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) caller.abort(); });
  try {
    const args = { ...(parsed.args ?? {}) };
    if (!Object.prototype.hasOwnProperty.call(args, "workspace") && parsed.workspace !== undefined) args.workspace = parsed.workspace;
    const response = await invokeTool(tool, args, target, caller.signal);
    writeJson(res, 200, response);
  } catch (err) {
    if (err instanceof ToolDispatchError) {
      writeJson(res, dispatchStatus(err.code), {
        error: err.message,
        ...(err.detail ?? {}),
      });
    } else {
      writeJson(res, 500, { error: (err as Error).message });
    }
  }
}

/** Map a ToolDispatchError code to its HTTP status. */
function dispatchStatus(code: ToolDispatchError["code"]): number {
  switch (code) {
    case "no_extension":
      return 503;
    case "unknown_target":
      return 404;
    case "ambiguous":
      return 409;
    case "timeout":
      return 504;
  }
}

// --- Listen -----------------------------------------------------------------

wsHttp.listen(WS_PORT, WS_HOST, () => {
  const trusted = TRUST_LOCAL ? ["loopback"] : [];
  const authDesc = trusted.length
    ? `bearer|trust-source[${trusted.join(",")}]`
    : "bearer-required";
  log(`WS listening on ws://${WS_HOST}:${WS_PORT}/ws (auth=${authDesc})`);
});

http.listen(HTTP_PORT, HTTP_HOST, () => {
  log(`HTTP listening on http://${HTTP_HOST}:${HTTP_PORT} (POST /send, /api/auth/refresh, /cdp/<work space>)`);
});
if (controlHttp && CONTROL_HTTP_HOST) {
  controlHttp.listen(HTTP_PORT, CONTROL_HTTP_HOST, () => {
    log(`HOME control HTTP listening on http://${CONTROL_HTTP_HOST}:${HTTP_PORT}`);
  });
}

// --- Shutdown ---------------------------------------------------------------

function shutdown(): void {
  log("shutting down");
  clearInterval(authSweep);
  wsHttp.close();
  http.close();
  controlHttp?.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
