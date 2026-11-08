/**
 * DCCB Browser Bridge — MV3 service worker.
 *
 * Maintains a WebSocket to the HOME relay. Page work arrives as `pipe_*` frames: a thin
 * chrome.debugger channel that agent-browser on the HOME drives (`pc-browser`, lib/pipe.ts).
 * `tool_request` runs the extension's own few tools (fetch, handoff, notify, extension).
 *
 * Auth: the WebSocket is opened ONLY when `lib/auth` holds a usable bearer, and
 * the bearer is carried as the `bb-bearer.<token>` WebSocket subprotocol — the
 * browser WebSocket cannot set request headers, and we never use a `?token=`
 * query string. The auth state machine owns pairing/refresh/expiry; this module
 * owns the socket and reports lifecycle (open/close 4401) back to auth.
 *
 * The popup talks to this worker over chrome.runtime messaging:
 *   getState | enable | disable | newCode  →  always replies with an AuthSnapshot.
 * The worker also pushes `stateUpdate` messages on every auth transition.
 */
import type { BridgeMessage } from "../shared/protocol";
import { compareExtensionVersions, isExtensionVersion, WS_CLOSE_UNAUTHORIZED } from "../shared/protocol";
import { dispatch, toolNames } from "./lib/registry";
import { installDetachListener, onDetach, setExecutionEnabled } from "./lib/cdp";
import { closeAllPipes, closePipe, handlePipeCommand, installPipe, openPipe, pipeChannelCount, pipeProblem } from "./lib/pipe";
import { clearTargetTabIfMatches, getTargetTab, getLastWorkspace, setLastWorkspace, installNewTabAdopter, listDccbTabs, focusControlledTab, focusAnyGroupTab, DEDICATED_WINDOW_KEY, LAST_WORKSPACE_KEY, findDccbGroupId, groupTitle } from "./lib/target";
import * as auth from "./lib/v8-auth";
import type { AuthSnapshot } from "./lib/v8-auth";
import { setHandoffController } from "./lib/tools/handoff";
import { takeNotificationWorkspace } from "./lib/tools/notify";
import "./lib/tools"; // side-effect: registers all tools into the registry

const KEEPALIVE_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// MV3 durable wake: chrome.alarms survive SW termination and wake the SW to
// fire onAlarm. The in-SW reconnect timer + keepalive interval both DIE when
// Chrome kills the idle SW (30s idle / 5min cap), so on their own the bridge
// could stay DARK after a termination until some unrelated event woke the SW.
// This alarm is the only reconnect trigger that outlives the SW. 1 min is just
// above the MV3 minimum alarm period (~30s) and cheap enough to run idle.
const RECONNECT_ALARM = "bb-reconnect";
const RECONNECT_ALARM_PERIOD_MIN = 1;

let socket: WebSocket | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = BACKOFF_MIN_MS;
/** True once the current socket fired 'open'; reset per connect attempt. Lets
 *  handleClose tell "never reached the server" (tailscale unreachable) from a
 *  transient drop of an established connection. */
let socketOpened = false;
let latestExtensionVersion: string | null = null;
let working = 0;
let dedicatedWindow = false;
let targetInfo: { title: string; url: string } | null = null;
let popupError: string | null = null;
let humanHandoff = false;
let handoffMessage: string | null = null;
let pendingHandoff: {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  startedAt: number;
  tabId: number;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
let activity: { label: string; at: number }[] = [];
const ACTIVITY_KEY = "v8BrowserBridgeActivity";
const HANDOFF_KEY = "v8BrowserBridgeHandoff";
const HANDOFF_MESSAGE_KEY = "v8BrowserBridgeHandoffMessage";
const ACTIVITY_LABELS: Record<string, string> = {
  fetch: "페이지 가져오기", handoff: "사람에게 넘기기", notify: "알림", pipe: "AI 작업 공간 연결",
};

function log(...args: unknown[]): void {
  console.log("[bb-v6 bg]", ...args);
}

/** True when the WS is open or mid-handshake (i.e. no reconnect is needed). */
function wsIsLive(): boolean {
  return (
    socket !== null &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  );
}

// --- Durable wake-and-reconnect (chrome.alarms) ----------------------------

/**
 * Register the periodic reconnect alarm. Idempotent: chrome.alarms.create with
 * the same name replaces any existing schedule, so re-running on every SW wake
 * is safe. Must be called at SW top-level (it is, from defineBackground) so the
 * alarm is (re)established on every cold start.
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
      pushSnapshot(auth.snapshot());
      break;
    case "tool_request":
      if (!auth.isEnabled() || humanHandoff) {
        send({ type: "tool_response", id: msg.id, error: humanHandoff ? "사람이 작업 중입니다. 계속을 누른 뒤 다시 시도하세요" : "Browser Bridge is off" });
        return;
      }
      working += 1;
      recordActivity(msg.tool);
      updateBadge();
      // Dispatch never throws. An accepted request always gets exactly one
      // answer: its result (a hand-off to the person does not undo work already
      // started), or an "off" error when the bridge was switched off meanwhile.
      void dispatch(msg).then(response => {
        send(auth.isEnabled() ? response : { type: "tool_response", id: msg.id, error: "Browser Bridge is off" });
      })
        .finally(() => { working = Math.max(0, working - 1); updateBadge(); pushSnapshot(auth.snapshot()); });
      break;
    case "pipe_open":
      recordActivity("pipe");
      void openPipe(msg.channel, msg.workspace).finally(() => pushSnapshot(auth.snapshot()));
      break;
    case "pipe_command":
      working += 1;
      updateBadge();
      void handlePipeCommand(msg).finally(() => { working = Math.max(0, working - 1); updateBadge(); });
      break;
    case "pipe_close":
      closePipe(msg.channel);
      pushSnapshot(auth.snapshot());
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

async function beginHandoff(message: string, timeoutSec: number, workspace: string): Promise<unknown> {
  if (humanHandoff) throw new Error("사람이 작업 중입니다. 계속을 누른 뒤 다시 시도하세요");
  humanHandoff = true;
  handoffMessage = message;
  await chrome.storage.local.set({ [HANDOFF_KEY]: true, [HANDOFF_MESSAGE_KEY]: message });
  await setExecutionEnabled(false);

  try {
    const focused = await focusControlledTab(undefined, workspace);
    const tabId = focused.tabId as number;
    await chrome.notifications.create(`bb-handoff-${crypto.randomUUID()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("/icon/128.png"),
      title: "AI가 도움을 요청합니다",
      message,
    });
    const startedAt = Date.now();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { void finishHandoff("timeout", timeoutSec); }, timeoutSec * 1000);
      pendingHandoff = { resolve, reject, startedAt, tabId, timer };
    });
    pushSnapshot(auth.snapshot());
    return await result;
  } catch (error) {
    if (humanHandoff) {
      humanHandoff = false;
      handoffMessage = null;
      await chrome.storage.local.set({ [HANDOFF_KEY]: false, [HANDOFF_MESSAGE_KEY]: null });
      await setExecutionEnabled(auth.isEnabled());
      pushSnapshot(auth.snapshot());
    }
    throw error;
  }
}

async function finishHandoff(action: "resumed" | "stopped" | "timeout", timeoutSec?: number): Promise<void> {
  const waiting = pendingHandoff;
  pendingHandoff = null;
  if (waiting) clearTimeout(waiting.timer);
  humanHandoff = false;
  handoffMessage = null;
  await chrome.storage.local.set({ [HANDOFF_KEY]: false, [HANDOFF_MESSAGE_KEY]: null });
  await setExecutionEnabled(auth.isEnabled());
  pushSnapshot(auth.snapshot());
  if (!waiting) return;

  if (action === "resumed") {
    const tab = await chrome.tabs.get(waiting.tabId).catch(() => undefined);
    waiting.resolve({ resumed: true, waitedMs: Date.now() - waiting.startedAt, url: tab?.url ?? "", title: tab?.title ?? "" });
  } else if (action === "stopped") {
    waiting.reject(new Error("사람이 작업을 중단했습니다"));
  } else {
    waiting.reject(new Error(`사람 응답 없음(${timeoutSec}초)`));
  }
}

// --- Popup messaging --------------------------------------------------------

interface PopupRequest {
  type: "getState" | "reset" | "setup" | "setEnabled" | "setDeviceName" | "setHandoff" | "stopHandoff" | "focusTarget" | "setDedicatedWindow";
  address?: string;
  code?: string;
  enabled?: boolean;
  name?: string;
  handoff?: boolean;
}

function popupSnapshot(snap: AuthSnapshot) { return { ...snap, latestExtensionVersion, working: working > 0, humanHandoff, handoffMessage, activity, dedicatedWindow, targetInfo, popupError, pipeProblem: pipeProblem(), pipeChannels: pipeChannelCount() }; }

function updateBadge(): void {
  const state = auth.snapshot().state;
  const currentVersion = chrome.runtime.getManifest().version;
  const updateAvailable = isExtensionVersion(currentVersion) && isExtensionVersion(latestExtensionVersion)
    && compareExtensionVersions(currentVersion, latestExtensionVersion) < 0;
  const badge = working > 0 ? "AI" : updateAvailable ? "NEW" : !auth.isEnabled() ? "OFF" : humanHandoff ? "HOLD" : state === "connected" ? "" : "…";
  const color = badge === "NEW" ? "#e67e22" : badge === "OFF" || badge === "HOLD" ? "#777" : badge === "AI" ? "#1769c2" : badge === "" ? "#238153" : "#aa7617";
  void chrome.action.setBadgeText({ text: badge });
  void chrome.action.setBadgeBackgroundColor({ color });
}

function recordActivity(tool: string): void {
  activity = [{ label: ACTIVITY_LABELS[tool] ?? "브라우저 작업", at: Date.now() }, ...activity].slice(0, 5);
  void chrome.storage.local.set({ [ACTIVITY_KEY]: activity });
  pushSnapshot(auth.snapshot());
}

async function refreshTargetInfo(): Promise<void> {
  const workspace = getLastWorkspace();
  const tabs = await listDccbTabs(workspace);
  const tab = tabs.find(t => t.id === getTargetTab(workspace)) ?? tabs[0];
  targetInfo = tab ? { title: tab.title ?? "", url: tab.url ?? "" } : null;
}

function pushSnapshot(snap: AuthSnapshot): void {
  void refreshTargetInfo().then(() => chrome.runtime.sendMessage({ type: "stateUpdate", snapshot: popupSnapshot(auth.snapshot()) }).catch(() => {}));
  updateBadge();
  // Best-effort: ignore "no receiver" when the popup is closed.
  chrome.runtime
    .sendMessage({ type: "stateUpdate", snapshot: popupSnapshot(snap) })
    .catch(() => {});
}

function installPopupBridge(): void {
  chrome.runtime.onMessage.addListener(
    (
      raw: unknown,
      _sender,
      sendResponse: (snap: ReturnType<typeof popupSnapshot>) => void,
    ): boolean => {
      const req = raw as PopupRequest;
      const reply = (): void => sendResponse(popupSnapshot(auth.snapshot()));
      switch (req?.type) {
        case "getState":
          void refreshTargetInfo().then(reply);
          return true;
        case "setup":
          void auth.setup(req.address ?? "", req.code ?? "").then(reply);
          return true;
        case "reset":
          humanHandoff = false;
          void chrome.storage.local.set({ [HANDOFF_KEY]: false });
          void setExecutionEnabled(false).then(() => auth.reset()).then(reply);
          return true;
        case "setEnabled":
          void (async () => {
            if (req.enabled === false) await setExecutionEnabled(false);
            await auth.setEnabled(req.enabled === true);
            if (req.enabled === true && !humanHandoff) await setExecutionEnabled(true);
            reply();
          })();
          return true;
        case "setDeviceName":
          void findDccbGroupId().then(async groupId => {
            // The group is found by its title, so rename it together with the device.
            await auth.setDeviceName(req.name ?? "");
            if (groupId !== null) await chrome.tabGroups.update(groupId, { title: groupTitle() });
            reply();
          });
          return true;
        case "focusTarget":
          // A Chrome error here is not something the person can act on: log it
          // and only say so when there is simply no AI tab to show.
          void focusAnyGroupTab(getLastWorkspace())
            .then(found => { popupError = found ? null : "아직 AI 작업 탭이 없습니다"; })
            .catch(e => { log("focus AI tab failed", String(e)); popupError = null; })
            .then(reply);
          return true;
        case "setDedicatedWindow":
          dedicatedWindow = req.enabled === true;
          void chrome.storage.local.set({ [DEDICATED_WINDOW_KEY]: dedicatedWindow }).then(reply);
          return true;
        case "setHandoff":
          if (req.handoff === true) {
            if (!humanHandoff) {
              humanHandoff = true;
              handoffMessage = null;
              void chrome.storage.local.set({ [HANDOFF_KEY]: true, [HANDOFF_MESSAGE_KEY]: null });
              void setExecutionEnabled(false);
              pushSnapshot(auth.snapshot());
            }
            reply();
          } else {
            void finishHandoff("resumed").then(reply);
          }
          return true;
        case "stopHandoff":
          void finishHandoff("stopped").then(reply);
          return true;
        default:
          return false;
      }
    },
  );
}

// --- Boot -------------------------------------------------------------------

// This body runs on EVERY service-worker start (cold boot AND every wake after
// an MV3 termination), so it is the single re-init point for all module state
// that does not survive SW death. What is lost on SW death, and why it is safe:
//   - cdp attached-tabs Set       → empty on restart; the pipe re-attaches via
//     ensureAttached, and installDetachListener re-registers below. SAFE.
//   - pipe channels               → the relay WS dies with the SW, so the relay
//     ends every engine and the next pc-browser command reconnects. SAFE.
//   - WS connection               → closed by SW death. Reconnect is durable via
//     the chrome.alarms wake below + auth.init's cold-start openSocket(), since
//     the in-SW setTimeout/keepalive die with the SW. Auth state (enabled,
//     tokens) lives in chrome.storage, so on wake the SW knows to reconnect.
export default defineBackground(() => {
  log("service worker started; tools:", toolNames().join(", "));
  // Durable wake-and-reconnect: outlives SW termination, unlike the in-SW
  // reconnect timer + keepalive. Registered first so it is in place even if a
  // later init step throws.
  installReconnectAlarm();
  installDetachListener();
  // Forget the working tab when it closes or its debugger detaches, so the popup and handoff
  // never target a dead tab.
  onDetach((tabId) => clearTargetTabIfMatches(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => clearTargetTabIfMatches(tabId));
  // Discoverability for pages opened by a controlled renderer. webNavigation's
  // sourceTabId—not openerTabId or click timing—identifies the source. Chrome
  // may activate/focus a target before that event arrives; only after source
  // confirmation do we group it and restore the prior selection/focus.
  installNewTabAdopter();
  // Pipe (1.1.0): raw chrome.debugger channel for agent-browser on the HOME (`pc-browser`).
  installPipe(
    frame => send(frame),
    () => pushSnapshot(auth.snapshot()),
    () => !auth.isEnabled() ? "Browser Bridge is off" : humanHandoff ? "사람이 작업 중입니다. 계속을 누른 뒤 다시 시도하세요" : null,
  );
  setHandoffController(beginHandoff);
  chrome.notifications.onClicked.addListener((notificationId) => {
    void focusControlledTab(undefined, takeNotificationWorkspace(notificationId) ?? getLastWorkspace()).catch(() => {});
  });
  installPopupBridge();

  void chrome.storage.local.get([ACTIVITY_KEY, HANDOFF_KEY, HANDOFF_MESSAGE_KEY, DEDICATED_WINDOW_KEY, LAST_WORKSPACE_KEY]).then(stored => {
    dedicatedWindow = stored[DEDICATED_WINDOW_KEY] === true;
    if (stored[LAST_WORKSPACE_KEY] !== undefined) {
      try { setLastWorkspace(stored[LAST_WORKSPACE_KEY]); } catch { /* stale workspace storage is ignored */ }
    }
    activity = Array.isArray(stored[ACTIVITY_KEY]) ? stored[ACTIVITY_KEY].slice(0, 5) : [];
    humanHandoff = stored[HANDOFF_KEY] === true;
    handoffMessage = humanHandoff && typeof stored[HANDOFF_MESSAGE_KEY] === "string" ? stored[HANDOFF_MESSAGE_KEY] : null;
    if (humanHandoff) void setExecutionEnabled(false);
    pushSnapshot(auth.snapshot());
    // Enrollment is loaded only after the persisted handoff gate, so a service
    // worker wake never briefly accepts work while the person has the tab.
    return auth.init({
      openSocket,
      closeSocket,
      onChange: snap => {
        if (!snap.enabled || snap.state === "off" || snap.state === "setup" || snap.state === "expired" || snap.state === "address_error") void setExecutionEnabled(false);
        else if (!humanHandoff) void setExecutionEnabled(true);
        pushSnapshot(snap);
      },
    });
  });
});
