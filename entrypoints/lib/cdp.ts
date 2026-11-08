/**
 * DCCB Browser Bridge v6 — chrome.debugger (CDP) lifecycle + send helper.
 *
 * Pure CDP over `chrome.debugger` (NOT a remote CDP socket). The `debugger`
 * permission is declared in the manifest. We track attached tabs so attach is
 * idempotent, and we clear state on `onDetach` (user closed DevTools, tab gone,
 * "Cancel" on the debugging banner, etc).
 *
 * Flat session model (Chrome 125+): `send()` accepts an optional `sessionId`
 * so callers can target child frames / OOPIFs once they discover their session
 * via Target.attachToTarget(flatten:true). The proof tools in this phase only
 * touch the page-level session (no sessionId), but the wrapper is ready for it.
 *
 * LATER (ref engine): Chrome 148 made Accessibility.getFullAXTree require an
 * explicit `frameId` for cross-frame trees. That requirement is irrelevant to
 * the 3 proof tools here but MUST be honoured when the content-side ref engine
 * is built — resolve frameId via Page.getFrameTree and pass it through.
 */

const PROTOCOL_VERSION = "1.3";

/**
 * Flat-session-aware debuggee target. Chrome 125+ accepts an optional
 * `sessionId` on the target passed to sendCommand to route a command to a child
 * frame / OOPIF session. `@types/chrome` (0.0.280) hasn't added this field to
 * `Debuggee` yet, so we extend it locally and cast at the call site.
 */
type FlatDebuggee = chrome.debugger.Debuggee & { sessionId?: string };

/** Tabs we currently hold a debugger attachment for. value = attach time (ms). */
const attached = new Map<number, number>();
interface PendingAttachment {
  promise: Promise<void>;
  cancellation: Promise<void>;
  cancel: () => void;
  cancelled: boolean;
}
const pendingAttachments = new Map<number, PendingAttachment>();
let executionEnabled = true;
/** Tabs muted by the focus-emulation guard, with the timer that unmutes them. */
const focusEmulationMutes = new Map<number, ReturnType<typeof setTimeout>>();
type DetachHook = (tabId: number) => void;
const detachHooks = new Set<DetachHook>();

function forgetTabState(tabId: number): void {
  const mute = focusEmulationMutes.get(tabId);
  if (mute !== undefined) clearTimeout(mute);
  focusEmulationMutes.delete(tabId);
  for (const hook of detachHooks) {
    try { hook(tabId); }
    catch (error) { log("detach cleanup hook failed", tabId, error instanceof Error ? error.message : error); }
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  pendingAttachments.get(tabId)?.cancel();
  forgetTabState(tabId);
});

/** Register per-tab state that must be cleared with CDP/ref state on detach. */
export function onDetach(hook: DetachHook): () => void {
  detachHooks.add(hook);
  return () => detachHooks.delete(hook);
}

/** Turning the bridge off blocks new CDP commands and releases every attachment. */
export async function setExecutionEnabled(enabled: boolean): Promise<void> {
  executionEnabled = enabled;
  if (!enabled) {
    const pending = [...pendingAttachments.values()];
    for (const record of pending) record.cancel();
    const drains = [
      ...[...attached.keys()].map(tabId => detach(tabId)),
      ...pending.map(record => record.promise),
    ];
    await Promise.allSettled(drains);
  }
}

/** Raised when attach fails because another client (DevTools) owns the tab. */
export class DebuggerBusyError extends Error {
  constructor(tabId: number, cause?: string) {
    super(
      `cannot attach debugger to tab ${tabId}` +
        (cause ? `: ${cause}` : "") +
        " — close DevTools / other debugger clients for this tab",
    );
    this.name = "DebuggerBusyError";
  }
}

function log(...args: unknown[]): void {
  console.log("[bb-v6 cdp]", ...args);
}

/** Promisified chrome.debugger.attach. */
function rawAttach(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

/** Promisified chrome.debugger.detach. */
function rawDetach(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      // Swallow lastError: detaching an already-detached tab is fine.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/** Send directly to an already-attached target (used during attach setup). */
function rawSend<T = unknown>(
  target: FlatDebuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params ?? {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method} failed: ${err.message}`));
      else resolve(result as T);
    });
  });
}

/** Promisified chrome.debugger.getTargets. */
function getTargets(): Promise<chrome.debugger.TargetInfo[]> {
  return new Promise((resolve) => {
    chrome.debugger.getTargets((targets) => {
      void chrome.runtime.lastError;
      resolve(targets ?? []);
    });
  });
}

/**
 * Attach the debugger to `tabId`. Idempotent: a no-op if already attached.
 * Throws `DebuggerBusyError` if the tab already has another debugger client
 * (typically an open DevTools window).
 */
export function attach(tabId: number): Promise<void> {
  if (!executionEnabled) return Promise.reject(new Error("Browser Bridge is off"));
  if (attached.has(tabId)) return Promise.resolve();
  const existing = pendingAttachments.get(tabId);
  if (existing) return existing.promise;

  let cancel!: () => void;
  const record: PendingAttachment = {
    promise: Promise.resolve(),
    cancellation: new Promise<void>(resolve => { cancel = resolve; }),
    cancel: () => {
      if (record.cancelled) return;
      record.cancelled = true;
      cancel();
    },
    cancelled: false,
  };
  const work = attachFresh(tabId, record);
  record.promise = work.finally(() => {
    if (pendingAttachments.get(tabId) === record) pendingAttachments.delete(tabId);
  });
  pendingAttachments.set(tabId, record);
  return record.promise;
}

async function attachFresh(tabId: number, record: PendingAttachment): Promise<void> {
  // Pre-flight: if a target reports it already has a debugger attached, give a
  // clean error instead of the opaque chrome.runtime.lastError string.
  try {
    const targets = await getTargets();
    const t = targets.find((x) => x.tabId === tabId);
    if (t && t.attached) {
      throw new DebuggerBusyError(tabId, "target already has a debugger client");
    }
  } catch (e) {
    if (e instanceof DebuggerBusyError) throw e;
    // getTargets failures are non-fatal; fall through to the real attach.
  }

  if (!executionEnabled || record.cancelled) throw new Error("Browser Bridge is off");
  let rawAttached = false;
  try {
    await rawAttach({ tabId });
    rawAttached = true;
    if (!executionEnabled || record.cancelled) {
      throw new Error("Browser Bridge is off");
    }
    // Match Playwright's Chromium setup. Configure page-level focus emulation
    // before publishing attachment state or invoking observers, without
    // calling send() (which would recursively enter attach()).
    await muteForFocusEmulation(tabId);
    await Promise.race([
      rawSend({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }),
      record.cancellation.then(() => { throw new Error("Browser Bridge is off"); }),
    ]);
    if (!executionEnabled || record.cancelled) throw new Error("Browser Bridge is off");
    attached.set(tabId, Date.now());
    log("attached", tabId);
  } catch (e) {
    if (rawAttached) {
      await rawDetach({ tabId });
      attached.delete(tabId);
      forgetTabState(tabId);
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Chrome reports the busy case via lastError, not getTargets, in practice.
    if (/already attached|another debugger|devtools/i.test(msg)) {
      throw new DebuggerBusyError(tabId, msg);
    }
    throw new Error(`debugger attach failed for tab ${tabId}: ${msg}`);
  }
}

/** Detach from `tabId` if attached; clears tracked state. Safe to over-call. */
export async function detach(tabId: number): Promise<void> {
  const pending = pendingAttachments.get(tabId);
  if (pending) {
    pending.cancel();
    await pending.promise.catch(() => undefined);
  }
  if (!attached.has(tabId)) {
    forgetTabState(tabId);
    return;
  }
  await rawDetach({ tabId });
  attached.delete(tabId);
  forgetTabState(tabId);
  log("detached", tabId);
}

/** Ensure attachment exists (auto-attach on first tool use for a tab). */
/** True if we believe we hold an attachment for this tab. */
export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (!attached.has(tabId)) await attach(tabId);
}

/**
 * Send a CDP command to `tabId`. When `sessionId` is provided the command is
 * routed to that flat session (child frame / OOPIF); otherwise it hits the
 * page-level session. Returns the typed result (caller asserts the shape).
 */
export async function send<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<T> {
  if (!executionEnabled) throw new Error("Browser Bridge is off");
  await ensureAttached(tabId);
  if (!executionEnabled) throw new Error("Browser Bridge is off");
  const target: FlatDebuggee = sessionId ? { tabId, sessionId } : { tabId };
  return rawSend<T>(target, method, params);
}

// --- Hidden-tab draw ----------------------------------------------------------
//
// Claude in Chrome 1.0.105 (`drawTab`, feature flag `cic_hidden_tab_draw`).
// A tab the person is not looking at produces almost no compositor frames on
// Windows even with focus emulation (measured 2026-11-04, Chrome 157: one rAF in
// 5 s). Chromium then holds frame-aligned input (mouseMoved, wheel) for up to
// 5 s, and after every navigation it drops clicks and keys until the new page
// has painted once (paint holding). A throwaway Page.captureScreenshot makes
// the compositor draw: the held input is released and the dropped-input window
// ends. The image is discarded.

const DRAW_TIMEOUT_MS = 2_000;
const INPUT_ACK_CAP_MS = 50;
const INPUT_TIMEOUT_MS = 5_000;

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** Make Chromium draw one frame of `tabId`. A minimized window cannot draw; then this does nothing. */
export async function drawTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const window = await chrome.windows.get(tab.windowId);
  if (window.state === "minimized") return;
  await withTimeout(
    send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 1, captureBeyondViewport: false, fromSurface: true }),
    DRAW_TIMEOUT_MS,
    `draw timed out on tab ${tabId}`,
  ).catch((error: unknown) => log("draw failed", tabId, error instanceof Error ? error.message : error));
}

/**
 * Send an `Input.*` command. If Chromium has not acknowledged it within 50 ms
 * the tab is not drawing, so draw once and keep waiting (Claude in Chrome's
 * `ackCapMs: 50, drawIfHeld: true`). `waitForAck: false` returns right after
 * that point — the click path uses it for its leading mouseMoved, which only
 * serves to find out whether the tab draws. `draw` replaces the screenshot-based draw (the pipe
 * draws with a screencast frame, which a covered window still produces).
 */
export async function sendInput<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
  options: { sessionId?: string; waitForAck?: boolean; draw?: (tabId: number) => Promise<void> } = {},
): Promise<T | undefined> {
  releaseFocusEmulationMute(tabId);
  const pending = send<T>(tabId, method, params, options.sessionId);
  let acknowledged = false;
  pending.then(() => { acknowledged = true; }, () => { acknowledged = true; });
  await Promise.race([pending.catch(() => undefined), new Promise(resolve => setTimeout(resolve, INPUT_ACK_CAP_MS))]);
  if (!acknowledged) await (options.draw ?? drawTab)(tabId);
  if (options.waitForAck === false) {
    void pending.catch(() => undefined);
    return undefined;
  }
  return withTimeout(pending, INPUT_TIMEOUT_MS, `${method} was not acknowledged within ${INPUT_TIMEOUT_MS} ms on tab ${tabId}`);
}

// --- Focus-emulation mute guard -------------------------------------------------
//
// Claude in Chrome (`muteForFocusEmulation`): focus emulation makes a hidden tab
// report itself visible, so a page may start playing media the person cannot
// see. Mute it while it is hidden, for at most 5 s or until the first input.

const FOCUS_EMULATION_MUTE_MS = 5_000;

async function muteForFocusEmulation(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || tab.active || tab.mutedInfo?.muted) return;
  await chrome.tabs.update(tabId, { muted: true }).catch(() => undefined);
  focusEmulationMutes.set(tabId, setTimeout(() => releaseFocusEmulationMute(tabId), FOCUS_EMULATION_MUTE_MS));
}

function releaseFocusEmulationMute(tabId: number): void {
  const timer = focusEmulationMutes.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  focusEmulationMutes.delete(tabId);
  void chrome.tabs.update(tabId, { muted: false }).catch(() => undefined);
}

// --- Detach event handling --------------------------------------------------

let listenerInstalled = false;

/** Install the onDetach listener once (called from background startup). */
export function installDetachListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId !== undefined) {
      pendingAttachments.get(source.tabId)?.cancel();
      if (attached.has(source.tabId)) {
        attached.delete(source.tabId);
        log("auto-detached", source.tabId, "reason:", reason);
      }
      forgetTabState(source.tabId);
    }
  });
}
