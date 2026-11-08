/**
 * DCCB Browser Bridge — MV3 service worker (6.0.0).
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
import { isExtensionVersion, WS_CLOSE_UNAUTHORIZED } from "../shared/protocol";
import { dispatch, toolNames } from "./lib/registry";
import { installDetachListener, onDetach, setExecutionEnabled } from "./lib/cdp";
import { closeAllPipes, closePipe, handlePipeCommand, installPipe, openPipe, pipeChannelCount } from "./lib/pipe";
import { clearTargetTabIfMatches, focusPopupTarget, installNewTabAdopter, installSeenWatch, LAST_WORKSPACE_KEY, migrateFromTabGroups, popupTarget, setLastWorkspace } from "./lib/target";
import * as auth from "./lib/v8-auth";
import "./lib/tools"; // side-effect: registers the tools into the registry

const KEEPALIVE_MS = 20_000;
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
  socket.addEventListener("open", () => {
    if (socket !== openedSocket) return;
    log("connected");
    socketOpened = true;
    backoff = BACKOFF_MIN_MS;
    send({ type: "extension_hello", version: chrome.runtime.getManifest().version });
    // Connected is not declared until the relay echoes the profile's binding.
    // Otherwise an old endpoint could briefly look successful before its
    // identity mismatch is detected.
    startKeepalive();
  });

  socket.addEventListener("message", (event) => {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(String(event.data)) as BridgeMessage;
    } catch {
      log("dropping non-JSON frame");
      return;
    }
    handleMessage(msg);
  });

  socket.addEventListener("close", (event) => {
    if (socket !== openedSocket) return;
    log("closed", event.code, "reason:", event.reason || "(none)");
    stopKeepalive();
    socket = null;
    closeAllPipes();
    void handleClose(event.code);
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

async function handleClose(code: number): Promise<void> {
  // Ask the auth machine what to do. 4401 → it refreshes + re-opens internally.
  const decision = await auth.onWsClosed(
    code === WS_CLOSE_UNAUTHORIZED ? WS_CLOSE_UNAUTHORIZED : code,
  );
  if (decision === "reconnect") {
    scheduleReconnect();
  }
  // "stop": either disabled, re-pairing, or auth already re-opened the socket.
}

function scheduleReconnect(): void {
  if (!auth.isEnabled()) return;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  log("reconnecting in", backoff, "ms");
  auth.markRetry(Date.now() + backoff);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, backoff);
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
}

// --- Message handling -------------------------------------------------------

function handleMessage(msg: BridgeMessage): void {
  switch (msg.type) {
    case "relay_binding":
      void auth.onRelayBinding(msg.relay_binding).then(accepted => {
        if (accepted) {
          latestExtensionVersion = isExtensionVersion(msg.latest_extension_version) ? msg.latest_extension_version : null;
          auth.markConnected();
        }
      });
      break;
    case "latest_extension_version":
      latestExtensionVersion = isExtensionVersion(msg.version) ? msg.version : null;
      pushSnapshot();
      break;
    case "tool_request":
      if (!auth.isEnabled()) {
        send({ type: "tool_response", id: msg.id, error: "Browser Bridge is not connected" });
        return;
      }
      // Dispatch never throws: an accepted request always gets exactly one answer.
      void dispatch(msg).then(send);
      break;
    case "pipe_open":
      void openPipe(msg.channel, msg.workspace);
      break;
    case "pipe_command":
      void handlePipeCommand(msg);
      break;
    case "pipe_close":
      closePipe(msg.channel);
      break;
    case "pong":
      // keepalive acknowledged; nothing to do.
      break;
    default:
      log("ignoring inbound", msg.type);
  }
}

function send(msg: BridgeMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function startKeepalive(): void {
  stopKeepalive();
  keepalive = setInterval(() => send({ type: "ping" }), KEEPALIVE_MS);
}

function stopKeepalive(): void {
  if (keepalive !== null) {
    clearInterval(keepalive);
    keepalive = null;
  }
}

// --- Popup ------------------------------------------------------------------

interface PopupRequest {
  type: "getState" | "setup" | "reset" | "setDeviceName" | "focusTarget";
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
    working,
    page: tab ? { title: tab.title ?? "", url: tab.url ?? "", favIconUrl: tab.favIconUrl ?? null } : null,
  };
}

/** The toolbar badge: a dot while the AI works in this Chrome, nothing otherwise. */
function updateBadge(): void {
  const working = pipeChannelCount() > 0;
  void chrome.action.setBadgeText({ text: working ? " " : "" });
  void chrome.action.setBadgeBackgroundColor({ color: "#6d5efc" });
}

function pushSnapshot(): void {
  updateBadge();
  // Best-effort: there is no receiver while the popup is closed.
  void popupSnapshot().then(snapshot => chrome.runtime.sendMessage({ type: "stateUpdate", snapshot })).catch(() => {});
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
      case "reset":
        void setExecutionEnabled(false).then(() => auth.reset()).then(reply);
        return true;
      case "setDeviceName":
        void auth.setDeviceName(req.name ?? "").then(reply);
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
      onChange: snap => {
        void setExecutionEnabled(snap.state === "connected" || snap.state === "connecting");
        pushSnapshot();
      },
    });
  });
});
