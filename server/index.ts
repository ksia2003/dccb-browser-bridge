/**
 * DCCB Browser Bridge v6 — relay server hub (now auth-gated).
 *
 * Listeners:
 *   - WebSocket on ws://<WS_HOST>:8765 — accepts MULTIPLE enrolled extensions.
 *     Remote connections require a route-bound bearer issued by code redemption.
 *     A same-box loopback connection may still use the legacy local path.
 *   - HTTP on <HTTP_HOST>:8766 — POST /send injects a tool_request (10s timeout;
 *     fetch ends on the extension's own limits),
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
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { loopbackPeerUid, trustedLocalUids } from "./peer-uid.js";
import type { Duplex } from "node:stream";
import type { BridgeMessage, EnrollRedeemResponse, ToolRequest, ToolResponse } from "../shared/protocol.js";
import { compareExtensionVersions, HEARTBEAT_INTERVAL_MS, isExtensionVersion, RELAY_SILENCE_TIMEOUT_MS, WS_CLOSE_UNAUTHORIZED } from "../shared/protocol.js";
import {
  loadTokensFromDisk,
  startAuthSweep,
  handleRefresh,
  issueEnrollmentTokens,
  checkWsBearer,
  enrollmentBindingForAccessToken,
  isSessionLive,
  sessionForAccessToken,
  activateLogin,
  watchSession,
  STATE_DIR,
  loadOrCreateHttpControlSecret,
  type AuthResult,
} from "./auth.js";
import { createPipeEndpoint } from "./pipe/endpoint.js";
import { runHttpHandler } from "./http-handler.js";
import { allowExtensionOrigin, isChromeExtensionOrigin } from "./origin.js";
import { browserBridgeTabGroupEnabled } from "./browser-bridge-settings.js";
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
  /** Set when the extension said the person switched it off; the socket is about to close. */
  switchedOffAt?: string;
  /**
   * The tailnet address the Chrome connected from, so a HOME can show it on the person's device row
   * (6.0.2). Absent when it came through a loopback hop (the public door), where the address says nothing.
   */
  address?: string;
}
const browsers = new Map<string, ConnectedBrowser>();
/**
 * Browsers the person switched off in the extension popup (6.0.2), kept after their socket closes so
 * a dispatch can say so instead of "no extension connected". Cleared when that browser connects again.
 */
const switchedOff = new Map<string, { name: string; at: string; address?: string }>();
/**
 * The switched-off record is also kept in the state folder, because the relay restarts on every DCCB
 * update and a switched-off Chrome holds no connection to announce itself again. The extension's own
 * setting stays the truth: its next connection (the person switching on) clears the record, and a record
 * older than SWITCHED_OFF_KEEP_MS (a Chrome that was removed) is dropped.
 */
const SWITCHED_OFF_FILE = join(STATE_DIR, "switched-off.json");
const SWITCHED_OFF_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * The file holds the records and, separately, which browser LEFT last (`lastGone`, an id or null), so a
 * restart does not turn "this PC dropped" (no_extension) into "the person switched it off" just
 * because an older switched-off record exists.
 */
function loadSwitchedOff(): void {
  try {
    const data = JSON.parse(readFileSync(SWITCHED_OFF_FILE, "utf8")) as { entries?: Record<string, { name?: unknown; at?: unknown; address?: unknown }>; lastGone?: unknown };
    for (const [id, v] of Object.entries(data.entries ?? {})) {
      if (typeof v?.name !== "string" || typeof v.at !== "string" || !(Date.now() - Date.parse(v.at) < SWITCHED_OFF_KEEP_MS)) continue;
      switchedOff.set(id, { name: v.name, at: v.at, ...(typeof v.address === "string" ? { address: v.address } : {}) });
    }
    lastGoneSwitchedOff = typeof data.lastGone === "string" && switchedOff.has(data.lastGone) ? data.lastGone : null;
  } catch { /* no record yet, or an unreadable one: start empty */ }
}
function saveSwitchedOff(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${SWITCHED_OFF_FILE}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 2, entries: Object.fromEntries(switchedOff), lastGone: lastGoneSwitchedOff }), { mode: 0o600 });
    renameSync(temporary, SWITCHED_OFF_FILE);
  } catch (e) { log("could not save the switched-off record:", (e as Error).message); }
}
/** Drop records past SWITCHED_OFF_KEEP_MS while running too (a relay can stay up for months) and rewrite the file. */
function pruneSwitchedOff(): void {
  let changed = false;
  for (const [id, v] of switchedOff) {
    if (Date.now() - Date.parse(v.at) < SWITCHED_OFF_KEEP_MS) continue;
    switchedOff.delete(id);
    if (lastGoneSwitchedOff === id) lastGoneSwitchedOff = null;
    changed = true;
  }
  if (changed) saveSwitchedOff();
}
setInterval(pruneSwitchedOff, 10 * 60 * 1000).unref();
/** Test hook: how long a socket may stay silent before the relay closes it. */
const SILENCE_TIMEOUT_MS = Number(process.env.BB_HEARTBEAT_TIMEOUT_MS) || RELAY_SILENCE_TIMEOUT_MS;
/** The browser whose socket closed last, if the person switched it off; any other last departure clears it. */
let lastGoneSwitchedOff: string | null = null;
loadSwitchedOff();
/** The first Browser Bridge from the Chrome Web Store; older copies were unpacked from a ZIP. */
const STORE_EXTENSION_VERSION = "6.0.0";
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
  // A bearer connection's id is the browser id its login was enrolled for; one browser cannot take
  // another's slot (and its switched-off record) by naming it. Only the tokenless same-box path
  // (trusted-local, which includes the public door that has verified the id itself) self-reports.
  let selfId = url.searchParams.get("id")?.trim() || undefined;
  if (check.clientId !== "trusted-local") {
    if (check.browserId && selfId && selfId !== check.browserId) {
      log("WS rejected: id does not match the browser this login was enrolled for");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    selfId = check.browserId;
  }
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

  // Admission: a bearer login must still be live, and only now does it replace the browser's earlier
  // logins (auth.ts activateLogin). A connection of a replaced login is closed at once, not at a poll.
  const bearer = extractBearer(req, subprotocols);
  const session = bearer ? sessionForAccessToken(bearer) : null;
  if (bearer && !session) { ws.close(WS_CLOSE_UNAUTHORIZED, "token_expired"); return; }
  if (session && !activateLogin(session)) { ws.close(1011, "state_unwritable"); return; }
  const unwatch = session ? watchSession(session, () => {
    log(`login replaced by a newer enrollment; closing ${id}`);
    ws.close(WS_CLOSE_UNAUTHORIZED, "login_replaced");
  }) : null;

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

  const from = req.socket.remoteAddress?.replace("::ffff:", "");
  const entry: ConnectedBrowser = {
    ws,
    id,
    name,
    connectedAt: new Date().toISOString(),
    version: null,
    ...(from && from !== "127.0.0.1" && from !== "::1" ? { address: from } : {}),
  };
  browsers.set(id, entry);
  switchedOff.delete(id);
  lastGoneSwitchedOff = null;
  saveSwitchedOff();
  log(`extension connected: ${id} (${name}); ${browsers.size} now connected`);
  const route = routeFromEnvironment();
  const latestExtensionVersion = refreshDistributedExtensionVersion();
  if (route) send(ws, {
    type: "relay_binding",
    relay_binding: route.relayBinding,
    browser_id: id,
    latest_extension_version: latestExtensionVersion,
    tab_group: browserBridgeTabGroupEnabled(),
  });

  // If this connection was bearer-authed (not trusted-local), close 4401 once its LOGIN ends (refresh
  // token expired or superseded by a re-enrollment). The 2 h access token that opened the socket does
  // not bound it: the extension refreshes it over HTTP and keeps this socket, so work in progress
  // survives (6.0.2; 4401 at every access-token expiry used to end the AI's running work).
  let tokenWatch: ReturnType<typeof setInterval> | null = null;
  if (bearer) {
    tokenWatch = setInterval(() => {
      if (!session || !isSessionLive(session)) {
        log("login ended mid-session; closing 4401");
        ws.close(WS_CLOSE_UNAUTHORIZED, "login_ended");
      }
    }, 30_000);
  }

  // Heartbeat: any frame from the extension counts; the extension pings every HEARTBEAT_INTERVAL_MS.
  // A socket that went silent (PC asleep, network gone without a FIN) never closes by itself, and its
  // pipes would stay "open" for an engine that talks to nobody.
  // Monotonic clock: a wall-clock jump must not read as silence.
  let lastFrameAt = performance.now();
  const silenceWatch = setInterval(() => {
    if (performance.now() - lastFrameAt > SILENCE_TIMEOUT_MS) {
      log(`extension ${id} silent for over ${Math.round(SILENCE_TIMEOUT_MS / 1000)} s; closing the dead socket`);
      ws.terminate();
    }
  }, Math.min(HEARTBEAT_INTERVAL_MS, Math.max(250, SILENCE_TIMEOUT_MS / 4)));

  ws.on("message", (data) => {
    // A connection whose login ended or was replaced accepts no more work from the extension.
    if (session && !isSessionLive(session)) { ws.close(WS_CLOSE_UNAUTHORIZED, "login_ended"); return; }
    lastFrameAt = performance.now();
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
        send(ws, { type: "pong", tab_group: browserBridgeTabGroupEnabled() });
        break;
      case "extension_hello": {
        const current = browsers.get(id);
        if (current?.ws === ws) current.version = isExtensionVersion(msg.version) ? msg.version : null;
        break;
      }
      case "extension_switched_off": {
        const current = browsers.get(id);
        if (current?.ws === ws) {
          current.switchedOffAt = new Date().toISOString();
          switchedOff.set(id, { name: current.name, at: current.switchedOffAt, ...(current.address ? { address: current.address } : {}) });
          saveSwitchedOff();
          log(`extension switched off by the person: ${id} (${current.name})`);
        }
        break;
      }
      case "extension_rename": {
        const current = browsers.get(id);
        const renamed = typeof msg.name === "string" ? msg.name.trim().slice(0, 40) : "";
        if (current?.ws === ws && renamed) {
          current.name = renamed;
          log(`extension ${id} renamed to ${renamed}`);
        }
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
    unwatch?.();
    clearInterval(silenceWatch);
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
      lastGoneSwitchedOff = entry.switchedOffAt ? id : null;
      saveSwitchedOff();
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
 *   - switched_off    → the person switched Browser Bridge off in that Chrome (503, like no_extension)
 */
export class ToolDispatchError extends Error {
  constructor(
    message: string,
    readonly code: "no_extension" | "switched_off" | "unknown_target" | "ambiguous" | "timeout",
    /** Extra data for the JSON body (e.g. the list of connected browsers). */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolDispatchError";
  }
}

/** A browser that is connected and has not just been switched off by the person (its socket closes next). */
function isAvailable(b: ConnectedBrowser): boolean {
  return b.ws.readyState === b.ws.OPEN && !b.switchedOffAt;
}

function switchedOffError(id: string): ToolDispatchError {
  const off = switchedOff.get(id);
  return new ToolDispatchError(
    `the person switched Browser Bridge off in this Chrome${off ? ` (${off.name}, at ${off.at})` : ""}; it stays off until they turn it back on in the Browser Bridge extension popup. Ask them in chat to switch it on`,
    "switched_off",
    { target: id, switched_off: [{ id, ...off }] },
  );
}

/** Snapshot of currently-connected browsers (for the list endpoint / errors). */
function listBrowsers(): { id: string; name: string; connectedAt: string; version: string | null; address?: string }[] {
  return [...browsers.values()]
    .filter(isAvailable)
    .map(({ id, name, connectedAt, version, address }) => ({ id, name, connectedAt, version, ...(address ? { address } : {}) }));
}

/** Browsers the person switched off, for listings; absent when there are none (old callers see no change). */
function switchedOffBody(): { switched_off?: { id: string; name: string; at: string; address?: string }[] } {
  const off = [...switchedOff].filter(([id]) => !browsers.get(id) || !isAvailable(browsers.get(id)!)).map(([id, v]) => ({ id, ...v }));
  return off.length ? { switched_off: off } : {};
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
    if ((!b || !isAvailable(b)) && switchedOff.has(target)) throw switchedOffError(target);
    if (!b || !isAvailable(b)) {
      throw new ToolDispatchError(
        `unknown target browser: ${target}`,
        "unknown_target",
        { target, browsers: listBrowsers() },
      );
    }
    return b;
  }

  const open = [...browsers.values()].filter(isAvailable);
  if (open.length === 0) {
    if (lastGoneSwitchedOff !== null && switchedOff.has(lastGoneSwitchedOff)) throw switchedOffError(lastGoneSwitchedOff);
    // A browser told the relay it was switched off but its socket has not closed yet.
    const pendingOff = [...browsers.values()].find((b) => b.switchedOffAt);
    if (pendingOff) throw switchedOffError(pendingOff.id);
    throw new ToolDispatchError("no extension connected", "no_extension");
  }
  if (open.length === 1) {
    return open[0];
  }
  // Someone who installs the Web Store copy (6.0.0) and keeps the old unpacked one connects twice
  // from one Chrome. The only current copy among outdated ones is the one to use (owner 11-08).
  const current = open.filter((b) => isExtensionVersion(b.version) && compareExtensionVersions(b.version, STORE_EXTENSION_VERSION) >= 0);
  if (current.length === 1) {
    return current[0];
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

    // fetch ends on the extension's own limits.
    const timer = tool === "fetch" ? undefined : setTimeout(() => {
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
  // secret. Only these two answer CORS, and only to a chrome-extension:// origin (origin.ts).
  const extensionHttpCallback = (req.method === "POST" || req.method === "OPTIONS")
    && (req.url === "/api/enroll/redeem" || req.url === "/api/auth/refresh");
  if (extensionHttpCallback) allowExtensionOrigin(req, res);
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
    writeJson(res, list.length ? 200 : 503, { browsers: list, ...switchedOffBody() });
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
    const status = result.error === "expired_code" || result.error === "used_code" || result.error === "unknown_code" ? 400
      : result.error === "route_unavailable" ? 503 : 409;
    log(`enrollment refused: ${result.error}`);
    writeJson(res, status, { error: result.error });
    return;
  }
  log("enrollment redeemed");
  const route = result.value!;
  let bearer;
  try {
    bearer = issueEnrollmentTokens(`v8-${route.person}-${route.browserId}`, {
      person: route.person, boxId: route.boxId, relayBinding: route.relayBinding,
      homeWsEndpoint: route.wsEndpoint,
    });
  } catch (error) {
    log(`enrollment not completed: ${(error as Error).message}`);
    writeJson(res, 503, { error: "server_error" });
    return;
  }
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
      result: { browsers: list, ...switchedOffBody() },
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
    case "switched_off":
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
