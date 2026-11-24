/**
 * DCCB Browser Bridge — MV3 service worker (6.1.0).
 *
 * Keeps a WebSocket to the person's DCCB HOME relay. Page work arrives as `pipe_*` frames: a thin
 * chrome.debugger channel that agent-browser on the HOME drives (`pc-browser`, lib/pipe.ts).
 * `tool_request` runs the extension's own two tools (fetch, extension). Nothing here asks the
 * person for anything: the AI talks to them in chat (owner 11-08), and the popup only shows state.
 *
 * Auth: the WebSocket is opened ONLY when `lib/v8-auth` holds a usable profile; a bearer rides as
 * the `bb-bearer.<token>` WebSocket subprotocol (a browser WebSocket cannot set headers, and a
 * `?token=` query string is never used). The auth machine owns enrollment/refresh/expiry; this
 * module owns the socket and reports its lifecycle (open/close 4401) back to auth.
 */
import type { BridgeMessage } from "../shared/protocol";
import { HEARTBEAT_INTERVAL_MS, isExtensionVersion, WS_CLOSE_UNAUTHORIZED } from "../shared/protocol";
import { dispatch, toolNames } from "./lib/registry";
import { installDetachListener, onDetach, setExecutionEnabled } from "./lib/cdp";
import { closeAllPipes, closePipe, handlePipeCommand, installPipe, openPipe, pipeChannelCount } from "./lib/pipe";
import { abortAllFetches } from "./lib/tools/fetch";
import { clearTargetTabIfMatches, focusPopupTarget, installNewTabAdopter, pendingAdoptions, stopAiWork, resumeAiWork, installSeenWatch, LAST_WORKSPACE_KEY, listAiTabs, migrateFromTabGroups, ownerOf, removeAiTabs, popupTarget, setAiTabGroupingEnabled, setLastWorkspace } from "./lib/target";
import * as auth from "./lib/v8-auth";
import type { ConnectionIssue } from "./lib/v8-auth";
import { badgeFor, updateAvailable } from "./lib/badge";
import { heartbeatTick, type HeartbeatState } from "./lib/heartbeat";
import "./lib/tools"; // side-effect: registers the tools into the registry

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// MV3 durable wake: chrome.alarms survive SW termination and wake the SW to
// fire onAlarm. The in-SW reconnect timer + keepalive interval both DIE when
// Chrome kills the idle SW (30s idle / 5min cap), so on their own the bridge
// could stay DARK after a termination until some unrelated event woke the SW.
// This alarm is the only reconnect trigger that outlives the SW.
const RECONNECT_ALARM = "bb-reconnect";
const RECONNECT_ALARM_PERIOD_MIN = 1;

let socket: WebSocket | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = BACKOFF_MIN_MS;
/** True once the current socket fired 'open'; reset per connect attempt. Lets
 *  handleClose tell "never reached the server" from a transient drop of an
 *  established connection. */
let socketOpened = false;
let latestExtensionVersion: string | null = null;
let heartbeat: HeartbeatState = { lastInboundMono: 0, lastTickWall: 0, lastTickMono: 0, probeSince: null };
/** True once the relay's `relay_binding` was accepted on the current socket; no work is taken before. */
let bound = false;
/** The device name the current socket's URL carried; a different current name is sent after binding. */
let socketName = "";
/** Deadline for the current handshake phase (upgrade, then binding); a stalled one is dropped and retried. */
let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
const HANDSHAKE_DEADLINE_MS = 15_000;
/** The off-notice the relay has not received yet (the person switched off while no socket was bound). */
const OFF_NOTICE_KEY = "v8BrowserBridgeOffNoticePending";
/**
 * The route (auth.routeIdentity) whose relay said, in an accepted `relay_binding`, that it understands the
 * notice-only path. Only that route is trusted with it: a different profile or address, or a relay that
 * never said so, gets no notice (an older relay would not know the path and an older door would drop it).
 */
const NOTICE_SUPPORTED_KEY = "v8BrowserBridgeRelayNotice";
/** Work in flight that may create tabs (pipe open/command, tool calls); switching off waits for it before it counts tabs. */
const inflightWork = new Set<Promise<unknown>>();
function tracked<T>(work: Promise<T>): Promise<T> {
  inflightWork.add(work);
  void work.finally(() => inflightWork.delete(work)).catch(() => {});
  return work;
}
function clearHandshakeTimer(): void {
  if (handshakeTimer !== null) clearTimeout(handshakeTimer);
  handshakeTimer = null;
}
/** A Web Store install carries update_url and Chrome updates it by itself; an unpacked copy does not.
 *  (Read when needed, not at import: WXT imports this file in Node at build time, with no manifest.) */
function installedFromStore(): boolean {
  return Boolean((chrome.runtime.getManifest() as { update_url?: string }).update_url);
}

function log(...args: unknown[]): void {
  console.log("[bb bg]", ...args);
}

// --- Durable wake-and-reconnect (chrome.alarms) ----------------------------

/**
 * Register the periodic alarm. Idempotent: chrome.alarms.create with the same
 * name replaces any existing schedule, so re-running on every SW wake is safe.
 */
function installReconnectAlarm(): void {
  chrome.alarms.create(RECONNECT_ALARM, {
    periodInMinutes: RECONNECT_ALARM_PERIOD_MIN,
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== RECONNECT_ALARM) return;
    // Recovery that does not depend on the socket: an expired token with a refresh that keeps failing
    // (the in-worker retry timer dies with the worker), and an off-notice still waiting for the relay.
    if (auth.isEnabled() && auth.accessTokenStale()) void auth.refreshAccessToken();
    void deliverOffNotice();
    // The alarm fired — the SW is awake now. If the bridge should be connected
    // but the socket died (typically alongside a prior SW termination), bring
    // it back. backoff is reset so the wake reconnects promptly.
    if (auth.isEnabled() && !wsIsLive()) {
      log("alarm wake: enabled but WS down → reconnecting");
      backoff = BACKOFF_MIN_MS;
      openSocket();
    }
  });
}

/** True when the WS is open or mid-handshake (i.e. no reconnect is needed). */
function wsIsLive(): boolean {
  return (
    socket !== null &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  );
}

// --- WebSocket (bearer via subprotocol) ------------------------------------

/** Open the gated WS. No-op if a socket is already live or no bearer exists. */
function openSocket(): void {
  // The person's switch is off: nothing reconnects (alarm, backoff and token refresh all land here).
  if (!auth.isEnabled()) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  // After a long sleep the stored access token is long expired: refresh first instead of presenting it
  // (the relay rejects it, and the retry came 20 s late). The refresh opens the socket when it succeeds.
  if (auth.accessTokenStale()) {
    log("openSocket: access token expired or near expiry → refreshing first");
    void auth.refreshAccessToken();
    return;
  }

  // V8 profile decides whether the redeemed route needs a bearer. The popup
  // never exposes a mode, host default, or another relay to choose from.
  const bearerRequired = auth.requiresBearer();
  const sub = auth.bearerSubprotocol();
  if (bearerRequired && !sub) {
    log("openSocket: profile bearer is not available yet");
    return;
  }
  const url = auth.wsUrl();
  if (!url) return;

  auth.markConnecting();
  log("connecting to enrolled relay", bearerRequired ? "(bearer)" : "(direct)");
  socketOpened = false;
  try {
    // A public-door bearer rides as a subprotocol; a direct enrolled relay has
    // no bearer. Both were fixed by the address+code redeem response.
    socket = bearerRequired
      ? new WebSocket(url, [sub as string])
      : new WebSocket(url);
  } catch (e) {
    log("WebSocket construct failed:", (e as Error).message);
    scheduleReconnect();
    return;
  }

  const openedSocket = socket;
  bound = false;
  socketName = auth.snapshot().deviceName;
  // What this socket's relay_binding is checked against: the login as it is NOW, not as it may be when the frame arrives.
  const expectation = auth.connectionExpectation();
  // Upgrade deadline: a handshake that neither opens nor fails (a black-holed route) is dropped and retried.
  clearHandshakeTimer();
  handshakeTimer = setTimeout(() => { if (socket === openedSocket) dropSocket("unreachable", "no upgrade"); }, HANDSHAKE_DEADLINE_MS);
  socket.addEventListener("open", () => {
    if (socket !== openedSocket) return;
    log("connected");
    socketOpened = true;
    heartbeat = { lastInboundMono: performance.now(), lastTickWall: Date.now(), lastTickMono: performance.now(), probeSince: null };
    // Binding deadline: the relay must identify itself (`relay_binding`) soon after the socket opens.
    clearHandshakeTimer();
    handshakeTimer = setTimeout(() => { if (socket === openedSocket && !bound) dropSocket("silent", "no relay_binding"); }, HANDSHAKE_DEADLINE_MS);
    backoff = BACKOFF_MIN_MS;
    send({ type: "extension_hello", version: chrome.runtime.getManifest().version });
    // Connected is not declared until the relay echoes the profile's binding.
    // Otherwise an old endpoint could briefly look successful before its
    // identity mismatch is detected.
    startKeepalive();
  });

  socket.addEventListener("message", (event) => {
    // A socket this worker already gave up on (replaced, dropped as dead) must not reach its successor.
    if (socket !== openedSocket) return;
    heartbeat.lastInboundMono = performance.now();
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(String(event.data)) as BridgeMessage;
    } catch {
      log("dropping non-JSON frame");
      return;
    }
    handleMessage(msg, openedSocket, expectation);
  });

  socket.addEventListener("close", (event) => {
    if (socket !== openedSocket) return;
    log("closed", event.code, "reason:", event.reason || "(none)");
    clearHandshakeTimer();
    bound = false;
    stopKeepalive();
    socket = null;
    closeAllPipes();
    void handleClose(event.code, socketOpened ? "dropped" : "unreachable");
  });

  socket.addEventListener("error", () => {
    // 'close' fires after 'error'; let it drive the reconnect.
    log("socket error");
  });
}

/** Close the WS without scheduling a reconnect (user disconnect / disable). */
function closeSocket(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopKeepalive();
  clearHandshakeTimer();
  bound = false;
  if (socket) {
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    socket = null;
    closeAllPipes();
  }
}

async function handleClose(code: number, issue: ConnectionIssue): Promise<void> {
  // Ask the auth machine what to do. 4401 → it refreshes + re-opens internally.
  const decision = await auth.onWsClosed(
    code === WS_CLOSE_UNAUTHORIZED ? WS_CLOSE_UNAUTHORIZED : code,
  );
  if (decision === "reconnect") {
    scheduleReconnect(issue);
  }
  // "stop": either disabled, re-pairing, or auth already re-opened the socket.
}

function scheduleReconnect(issue: ConnectionIssue = "unreachable"): void {
  if (!auth.isEnabled()) return;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  log("reconnecting in", backoff, "ms");
  auth.markRetry(Date.now() + backoff, issue);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, backoff);
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
}

// --- Message handling -------------------------------------------------------

function handleMessage(msg: BridgeMessage, from: WebSocket, expectation: auth.ConnectionExpectation | null): void {
  switch (msg.type) {
    case "relay_binding":
      setAiTabGroupingEnabled(msg.tab_group === true);
      if (!expectation) break;
      void auth.onRelayBinding(msg.relay_binding, expectation, () => socket === from).then(accepted => {
        // The answer is for the socket that asked; if it was replaced meanwhile, it is dropped.
        if (!accepted || socket !== from) return;
        bound = true;
        clearHandshakeTimer();
        // Advertised support belongs to this route; advertising nothing forgets what an earlier relay on it said.
        void chrome.storage.local.set({ [NOTICE_SUPPORTED_KEY]: msg.switched_off_notice === true ? auth.routeIdentity() : null });
        latestExtensionVersion = isExtensionVersion(msg.latest_extension_version) ? msg.latest_extension_version : null;
        // A rename made during the handshake (or before this socket opened with it) goes out now.
        const name = auth.snapshot().deviceName;
        if (name !== socketName) { sendOn(from, { type: "extension_rename", name }); socketName = name; }
        auth.markConnected();
      });
      break;
    case "latest_extension_version":
      latestExtensionVersion = isExtensionVersion(msg.version) ? msg.version : null;
      pushSnapshot();
      break;
    case "tool_request":
      if (!auth.isEnabled() || !bound) {
        sendOn(from, { type: "tool_response", id: msg.id, error: "Browser Bridge is not connected" });
        return;
      }
      // Dispatch never throws: an accepted request always gets exactly one answer, on the socket it came in on.
      void tracked(dispatch(msg)).then(response => sendOn(from, response));
      break;
    case "pipe_open":
      if (bound) void tracked(openPipe(msg.channel, msg.workspace));
      break;
    case "pipe_command":
      if (bound) void tracked(handlePipeCommand(msg));
      break;
    case "pipe_close":
      if (bound) closePipe(msg.channel);
      break;
    case "pong":
      setAiTabGroupingEnabled(msg.tab_group === true);
      break;
    default:
      log("ignoring inbound", msg.type);
  }
}

function send(msg: BridgeMessage): void { sendOn(socket, msg); }

/** Send on a specific socket (an answer goes back where its request came from, never to a successor). */
function sendOn(target: WebSocket | null, msg: BridgeMessage): void {
  if (target && target === socket && target.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(msg));
  }
}

/**
 * Heartbeat: ping every HEARTBEAT_INTERVAL_MS; the relay answers each with a pong. A socket that has
 * received nothing for EXTENSION_SILENCE_TIMEOUT_MS is dead (network gone without a close): drop it and
 * reconnect. After a pause the first tick only probes (lib/heartbeat.ts). The relay applies the mirror
 * rule to this side (server/index.ts). Relies on WebSocket traffic keeping the MV3 worker alive
 * (Chrome 116+, hence minimum_chrome_version).
 */
function startKeepalive(): void {
  stopKeepalive();
  heartbeat.lastTickWall = Date.now();
  heartbeat.lastTickMono = performance.now();
  keepalive = setInterval(() => {
    const tick = heartbeatTick(heartbeat, Date.now(), performance.now());
    heartbeat = tick.state;
    if (tick.action === "drop") { dropSocket("silent", "no frame from the relay"); return; }
    send({ type: "ping" });
  }, HEARTBEAT_INTERVAL_MS);
}

/** Give up on the current socket (stalled handshake or dead link) and reconnect. */
function dropSocket(issue: ConnectionIssue, why: string): void {
  const dead = socket;
  log("dropping the socket:", why);
  stopKeepalive();
  clearHandshakeTimer();
  bound = false;
  socket = null;
  try { dead?.close(); } catch { /* already closing */ }
  closeAllPipes();
  // The close event of a dead socket may take minutes; it is ignored once `socket` was cleared.
  scheduleReconnect(issue);
}

function stopKeepalive(): void {
  if (keepalive !== null) {
    clearInterval(keepalive);
    keepalive = null;
  }
}

// --- Popup ------------------------------------------------------------------

interface PopupRequest {
  type: "getState" | "setup" | "reconnect" | "setEnabled" | "setDeviceName" | "reset" | "cancelSetup" | "focusTarget";
  enabled?: boolean;
  address?: string;
  code?: string;
  name?: string;
}

/** What the popup draws: connection state, and the AI's page (the one it is on, or left open). */
async function popupSnapshot() {
  const snap = auth.snapshot();
  const working = pipeChannelCount() > 0;
  const tab = await popupTarget();
  return {
    state: snap.state,
    error: snap.error,
    address: snap.address,
    deviceName: snap.deviceName,
    version: chrome.runtime.getManifest().version,
    latestExtensionVersion,
    lastConnectedAt: snap.lastConnectedAt,
    nextRetryAt: snap.nextRetryAt,
    retryReason: snap.retryReason,
    outageStartedAt: snap.outageStartedAt,
    working,
    page: tab ? { title: tab.title ?? "", url: tab.url ?? "", favIconUrl: tab.favIconUrl ?? null } : null,
    // The person can limit the extension's site access in Chrome; only they can open it again.
    siteAccess: await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => true),
  };
}

/** The toolbar badge: one mark at a time (lib/badge.ts): working dot, OFF, "!" not connected, NEW version. */
function updateBadge(): void {
  const snap = auth.snapshot();
  const mark = badgeFor({
    working: pipeChannelCount() > 0,
    state: snap.state,
    retryReason: snap.retryReason,
    updateAvailable: updateAvailable(chrome.runtime.getManifest().version, latestExtensionVersion, installedFromStore()),
  });
  void chrome.action.setBadgeText({ text: mark.text });
  void chrome.action.setBadgeBackgroundColor({ color: mark.color });
}

function pushSnapshot(): void {
  updateBadge();
  // Best-effort: there is no receiver while the popup is closed.
  void popupSnapshot().then(snapshot => chrome.runtime.sendMessage({ type: "stateUpdate", snapshot })).catch(() => {});
}

/**
 * Stop the AI's work, then close its tabs. Order matters: first `stop` (closes the socket, which ends
 * every pipe; from then on `auth.isEnabled()` is false and new pipe/tool work is refused), then
 * execution is blocked and detached, then work already past those checks is awaited, and only then
 * are the AI's tabs counted and closed (twice, for a page that opened a tab as the first pass ran).
 * Tabs counted before the work stopped would miss one the in-flight work was still opening.
 */
async function stopWorkAndCloseAiTabs(stop: () => Promise<void>): Promise<void> {
  stopAiWork(); // every tab operation that completes from now on, however late, is closed, not kept
  {
    await stop();
    abortAllFetches(); // a stalled response body must not hold the shutdown
    await setExecutionEnabled(false);
    // Work already past the checks, and child tabs being adopted, get a bounded time to settle; the
    // sweeps below do not depend on them finishing.
    const settled = Promise.allSettled([...inflightWork, ...pendingAdoptions()]);
    await Promise.race([settled, new Promise(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_MS))]);
    for (let pass = 0; pass < 2; pass++) {
      const tabIds = (await listAiTabs()).flatMap(entry => entry.tab.id === undefined ? [] : [entry.tab.id]);
      if (!tabIds.length) break;
      await removeAiTabs(tabIds).catch(error => log("closing AI tabs failed", String(error)));
    }
  }
  pushSnapshot();
}
const SHUTDOWN_DRAIN_MS = 5_000;

/**
 * The popup's on/off switch. Off: tell the relay it was the person (a PC that merely went offline looks
 * different to the AI), stop the AI's work, close the AI's tabs without asking (turning it off is the
 * point), and close the socket without reconnecting. The profile stays, so on reconnects with no code.
 * The relay notice is stored first and cleared only once the relay has it: sent now when a bound socket
 * is open, otherwise delivered later by a notice-only connection (deliverOffNotice) that takes no work.
 */
async function setEnabledByPerson(on: boolean): Promise<void> {
  if (on) {
    await chrome.storage.local.remove(OFF_NOTICE_KEY);
    await auth.setEnabled(true);
    return;
  }
  // The notice is stored first and cleared only when the relay answers that it has it (deliverOffNotice).
  await chrome.storage.local.set({ [OFF_NOTICE_KEY]: true });
  await stopWorkAndCloseAiTabs(() => auth.setEnabled(false)); // closes the socket and sets state "off"
  void deliverOffNotice();
}

/**
 * Tell the relay the person switched off, over the notice-only connection (`/notice`). It is not the
 * bridge socket: the relay does not register it as a browser, never sends it work, activates no login and
 * replaces no socket; the worker adds no handler for tool or pipe frames on it. The relay records the
 * notice durably and answers `switched_off_ack`; only that answer clears the stored notice. A relay that
 * never said it understands the notice (an older one would treat the connection as a browser) is not
 * tried. The alarm retries until acknowledged or until the person switches on again.
 */
let noticeInFlight = false;
async function deliverOffNotice(): Promise<void> {
  if (noticeInFlight) return;
  const stored = await chrome.storage.local.get([OFF_NOTICE_KEY, NOTICE_SUPPORTED_KEY]);
  if (stored[OFF_NOTICE_KEY] !== true) return;
  if (auth.snapshot().enabled || !auth.hasProfile() || stored[NOTICE_SUPPORTED_KEY] !== auth.routeIdentity()) { await chrome.storage.local.remove(OFF_NOTICE_KEY); return; }
  noticeInFlight = true;
  try {
    if (auth.accessTokenStale() && (!(await auth.refreshAccessToken()) || auth.accessTokenStale())) return;
    const base = auth.wsUrl();
    const subprotocol = auth.bearerSubprotocol();
    if (!base || (auth.requiresBearer() && !subprotocol)) return;
    // The dedicated path: a relay or door without it refuses the upgrade rather than registering a browser.
    const url = new URL(base);
    if (!/\/ws$/.test(url.pathname)) { await chrome.storage.local.remove(OFF_NOTICE_KEY); return; }
    url.pathname = url.pathname.replace(/\/ws$/, "/notice");
    const acknowledged = await new Promise<boolean>(resolve => {
      let notice: WebSocket;
      try { notice = auth.requiresBearer() ? new WebSocket(url.toString(), [subprotocol as string]) : new WebSocket(url.toString()); }
      catch { resolve(false); return; }
      const give = (ok: boolean): void => { clearTimeout(timer); try { notice.close(); } catch { /* closing */ } resolve(ok); };
      const timer = setTimeout(() => give(false), 10_000);
      notice.addEventListener("open", () => notice.send(JSON.stringify({ type: "extension_switched_off" } satisfies BridgeMessage)));
      notice.addEventListener("message", event => {
        try { if ((JSON.parse(String(event.data)) as BridgeMessage).type === "switched_off_ack") give(true); } catch { /* not a frame */ }
      });
      notice.addEventListener("error", () => give(false));
      notice.addEventListener("close", () => give(false));
    });
    // A switch-on during the exchange wins: the person's setting is the truth, whatever the relay recorded.
    if (acknowledged && !auth.snapshot().enabled) await chrome.storage.local.remove(OFF_NOTICE_KEY);
  } finally {
    noticeInFlight = false;
  }
}

/**
 * "연결 정보 지우기": forget the address and login. The AI loses this Chrome, so its work stops and its
 * tabs close as with the off switch; the socket is closed (auth.reset), the relay's tokens simply expire.
 */
async function resetByPerson(): Promise<void> {
  await chrome.storage.local.remove(OFF_NOTICE_KEY);
  await stopWorkAndCloseAiTabs(() => auth.reset());
}

function installPopupBridge(): void {
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (snapshot: unknown) => void): boolean => {
    const req = raw as PopupRequest;
    const reply = (): void => void popupSnapshot().then(sendResponse);
    switch (req?.type) {
      case "getState":
        reply();
        return true;
      case "setup":
        void auth.setup(req.address ?? "", req.code ?? "").then(reply);
        return true;
      case "reconnect":
        // A new address and code replace the profile only once redeemed; until then nothing changes.
        void auth.setup(req.address ?? "", req.code ?? "", true).then(reply);
        return true;
      case "setEnabled":
        void setEnabledByPerson(req.enabled === true).then(reply);
        return true;
      case "setDeviceName":
        void auth.setDeviceName(req.name ?? "").then(reply);
        return true;
      case "cancelSetup":
        auth.cancelSetup();
        reply();
        return true;
      case "reset":
        void resetByPerson().then(reply);
        return true;
      case "focusTarget":
        // The person asked to see the AI's tab; a Chrome error here is only logged.
        void focusPopupTarget().catch(error => log("focus AI tab failed", String(error))).then(reply);
        return true;
      default:
        return false;
    }
  });
}

// --- Boot -------------------------------------------------------------------

// This body runs on EVERY service-worker start (cold boot AND every wake after
// an MV3 termination), so it is the single re-init point for module state that
// does not survive SW death:
//   - cdp attached-tabs Set → empty on restart; the pipe re-attaches and
//     installDetachListener re-registers below.
//   - pipe channels → the relay WS dies with the SW, so the relay ends every
//     engine and the next pc-browser command reconnects.
//   - WS connection → reconnect is durable via the alarm + auth.init's
//     cold-start openSocket(); auth state lives in chrome.storage.
export default defineBackground(() => {
  log("service worker started; tools:", toolNames().join(", "));
  installReconnectAlarm();
  installDetachListener();
  // Forget the working tab when it closes or its debugger detaches.
  onDetach((tabId) => clearTargetTabIfMatches(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => clearTargetTabIfMatches(tabId));
  // Pages a controlled tab opens (target=_blank, window.open) join its work space, confirmed by
  // webNavigation's sourceTabId; Chrome's own focus change for them is undone.
  installNewTabAdopter();
  installSeenWatch();
  // The popup shows the AI's page: refresh it when an AI tab's title, address or icon changes.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!("title" in change || "url" in change || "favIconUrl" in change)) return;
    void ownerOf(tabId).then(owner => {
      if (owner === null || refreshTimer !== null) return;
      refreshTimer = setTimeout(() => { refreshTimer = null; pushSnapshot(); }, 300);
    });
  });
  installPipe(
    frame => send(frame),
    () => pushSnapshot(),
    () => auth.isEnabled() ? null : "Browser Bridge is not connected",
  );
  installPopupBridge();
  // A fresh install opens the setup page once: Chrome hides a new extension's icon in the puzzle
  // menu, so the popup alone would leave the person looking for it.
  chrome.runtime.onInstalled.addListener(details => {
    if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("/popup.html?welcome=1") });
  });
  // Once, on the first start of 6.0.0 (guarded by a stored flag): leave 1.2.x's tab group behind.
  void migrateFromTabGroups().catch(error => log("migration failed", String(error)));

  void chrome.storage.local.get([LAST_WORKSPACE_KEY]).then(stored => {
    if (stored[LAST_WORKSPACE_KEY] !== undefined) {
      try { setLastWorkspace(stored[LAST_WORKSPACE_KEY]); } catch { /* stale workspace storage is ignored */ }
    }
    return auth.init({
      openSocket,
      closeSocket,
      // Before the relay bound this socket the new name waits: it is sent right after binding (handleMessage).
      announceName: name => { if (bound) { send({ type: "extension_rename", name }); socketName = name; } },
      onChange: snap => {
        const on = snap.state === "connected" || snap.state === "connecting";
        if (on) resumeAiWork();
        void setExecutionEnabled(on);
        pushSnapshot();
      },
    }).then(() => deliverOffNotice());
  });
});
