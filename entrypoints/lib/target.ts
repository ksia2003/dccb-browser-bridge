/**
 * DCCB Browser Bridge — the AI's tabs (6.0.0, owner 11-08).
 *
 * The AI works in ordinary tabs it opened itself: background tabs at the end of a normal window,
 * never brought forward and never grouped (Chrome files every tab group in its saved-groups bar and
 * keeps it there after the window closes; nothing an extension can remove). Which tab belongs to
 * which work space is kept for this browser session; a tab nobody opened for the AI is the
 * person's and is never offered to an engine. The person brings an AI tab forward only from the
 * popup's card.
 */


export const LAST_WORKSPACE_KEY = "v8LastWorkspace";
const DEFAULT_WORKSPACE = "default";
const currentTargets = new Map<string, number | null>();
let lastWorkspace = DEFAULT_WORKSPACE;

export function normalizeWorkspace(value?: unknown): string {
  if (value === undefined) return DEFAULT_WORKSPACE;
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value)) return value;
  throw new Error("workspace는 1~40자 [A-Za-z0-9_-]");
}

/** Tab → work space, for this browser session (tab ids do not outlive it). */
const OWNERS_KEY = "v8TabWorkspaces";
let owners: Record<string, string> | null = null;
let ownerQueue: Promise<void> = Promise.resolve();
async function loadOwners(): Promise<Record<string, string>> {
  owners ??= ((await chrome.storage.session.get(OWNERS_KEY))[OWNERS_KEY] as Record<string, string> | undefined) ?? {};
  return owners;
}
function setOwner(tabId: number, workspace: string | null): Promise<void> {
  const task = ownerQueue.then(async () => {
    const current = await loadOwners();
    if (workspace === null) delete current[tabId];
    else current[tabId] = workspace;
    await chrome.storage.session.set({ [OWNERS_KEY]: current });
  });
  ownerQueue = task.catch(() => {});
  return task;
}
/** The work space a tab was opened for, or null for the person's own tabs. */
export async function ownerOf(tabId: number): Promise<string | null> {
  return (await loadOwners())[tabId] ?? null;
}

/** The person took this AI tab (it was in front when the AI let go): it is theirs from now on. */
export function releaseTab(tabId: number): Promise<void> {
  return setOwner(tabId, null);
}

/** Every open tab the AI opened, with its work space. */
export async function listAiTabs(): Promise<{ tab: chrome.tabs.Tab; workspace: string }[]> {
  const current = await loadOwners();
  const tabs = await chrome.tabs.query({});
  return tabs.flatMap(tab => tab.id !== undefined && current[tab.id] ? [{ tab, workspace: current[tab.id] }] : []);
}

/** The work space's tabs. */
export async function listDccbTabs(workspace?: unknown): Promise<chrome.tabs.Tab[]> {
  const workspaceName = normalizeWorkspace(workspace);
  return (await listAiTabs()).filter(entry => entry.workspace === workspaceName).map(entry => entry.tab);
}

/** Is `tabId` one the AI opened for this work space? */
export async function isControlledTab(tabId: number, workspace?: unknown): Promise<boolean> {
  return await ownerOf(tabId) === normalizeWorkspace(workspace)
    && Boolean(await chrome.tabs.get(tabId).catch(() => undefined));
}

/**
 * Open a background tab for the work space: next to its other tabs if it has any, else at the end
 * of the last focused normal window. One queue, so two engines never race for a window.
 */
let creationQueue: Promise<unknown> = Promise.resolve();
export function createControlledTab(url?: string, workspace?: unknown): Promise<chrome.tabs.Tab> {
  const workspaceName = normalizeWorkspace(workspace);
  const task = creationQueue.then(() => createClientTab(url, workspaceName));
  creationQueue = task.catch(() => {});
  return task;
}
async function createClientTab(url: string | undefined, workspace: string): Promise<chrome.tabs.Tab> {
  const sibling = (await listDccbTabs(workspace))[0];
  const window = sibling ? undefined : await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  const windowId = sibling?.windowId ?? (window?.type === "normal" ? window.id : undefined);
  let tab: chrome.tabs.Tab;
  if (windowId !== undefined) {
    tab = await chrome.tabs.create({ active: false, windowId, ...(url ? { url } : {}) });
  } else {
    // No browser window is open (Chrome running in the background): open one without taking focus.
    const created = await chrome.windows.create({ focused: false, ...(url ? { url } : {}) });
    tab = created.tabs![0];
  }
  await setOwner(tab.id!, workspace);
  setTargetTab(tab.id!, workspace);
  return tab;
}

/** The AI tab the popup shows: the last work space's working tab, else any AI tab. */
export async function popupTarget(): Promise<chrome.tabs.Tab | null> {
  const workspace = getLastWorkspace();
  const tabs = await listDccbTabs(workspace);
  const working = getTargetTab(workspace);
  return tabs.find(tab => tab.id === working) ?? tabs[0] ?? (await listAiTabs())[0]?.tab ?? null;
}

/** The popup's card: bring that AI tab forward (the person asked). */
export async function focusPopupTarget(): Promise<boolean> {
  const tab = await popupTarget();
  if (tab?.id === undefined) return false;
  const window = await chrome.windows.get(tab.windowId);
  await chrome.windows.update(tab.windowId, { focused: true, ...(window.state === "minimized" ? { state: "normal" as const } : {}) });
  await chrome.tabs.update(tab.id, { active: true });
  return true;
}

/**
 * Before 6.0.0 the AI's tabs sat in an "AI · <device>" tab group kept alive by an idle tab. On the
 * first run of 6.0.0, close the idle tabs and ungroup what is left of those groups, so nothing new
 * reaches Chrome's saved-groups bar. Labels Chrome already saved there stay (no API removes them).
 */
const MIGRATED_KEY = "v8Migrated600";
const RETIRED_KEYS = ["v8ClientGroups", "v8ClientWindows", "v8DedicatedWindow", "v8BrowserBridgeHandoff", "v8BrowserBridgeHandoffMessage", "v8BrowserBridgeActivity"];
export async function migrateFromTabGroups(): Promise<void> {
  const stored = await chrome.storage.local.get([MIGRATED_KEY, "v8ClientGroups"]);
  if (stored[MIGRATED_KEY] === true) return;
  const idlePage = chrome.runtime.getURL("/idle.html");
  const tabs = await chrome.tabs.query({});
  const groups = new Set<number>(Object.values((stored.v8ClientGroups ?? {}) as Record<string, unknown>).filter((id): id is number => typeof id === "number"));
  for (const tab of tabs) if (tab.url === idlePage && tab.groupId !== undefined && tab.groupId >= 0) groups.add(tab.groupId);
  const idle = tabs.filter(tab => tab.url === idlePage).map(tab => tab.id!).filter(id => id !== undefined);
  const grouped = tabs.filter(tab => tab.id !== undefined && tab.groupId !== undefined && groups.has(tab.groupId) && !idle.includes(tab.id)).map(tab => tab.id!);
  if (grouped.length) await chrome.tabs.ungroup(grouped).catch(error => log("ungroup failed", String(error)));
  if (idle.length) await chrome.tabs.remove(idle).catch(error => log("idle tab close failed", String(error)));
  await chrome.storage.local.remove(RETIRED_KEYS);
  await chrome.storage.local.set({ [MIGRATED_KEY]: true });
  log("left the tab group behind", { ungrouped: grouped.length, idleClosed: idle.length });
}

function log(...args: unknown[]): void {
  console.log("[bb target]", ...args);
}

/** Set the work space's working tab. */
export function setTargetTab(tabId: number, workspace?: unknown): void {
  const workspaceName = normalizeWorkspace(workspace);
  currentTargets.set(workspaceName, tabId);
  setLastWorkspace(workspaceName);
}

/** The work space's working tab id, or null if none is set yet. */
export function getTargetTab(workspace?: unknown): number | null {
  return currentTargets.get(normalizeWorkspace(workspace)) ?? null;
}

export function setLastWorkspace(workspace: unknown): void {
  const next = normalizeWorkspace(workspace);
  if (lastWorkspace === next) return;
  lastWorkspace = next;
  void chrome.storage.local.set({ [LAST_WORKSPACE_KEY]: lastWorkspace });
}

export function getLastWorkspace(): string {
  return lastWorkspace;
}

/** Clear the working tab if `tabId` matches it (called on tab-removed/detach). */
export function clearTargetTabIfMatches(tabId: number, workspace?: unknown): void {
  for (const [key, currentTargetTabId] of currentTargets) {
    if (currentTargetTabId === tabId && (workspace === undefined || key === normalizeWorkspace(workspace))) currentTargets.set(key, null);
  }
}

let newTabAdopterInstalled = false;

interface CreatedTargetCandidate {
  windowId: number;
  previousActiveTabId?: number;
  previousFocusedWindowId?: number;
}

interface CreatedWindowCandidate {
  previousFocusedWindowId?: number;
}

// `tabs.onCreated` is only an inert observation. It captures state needed to
// undo Chrome's initial popup selection if webNavigation later proves that the
// controlled renderer created this target. No unconfirmed tab/window is moved,
// grouped, deactivated, or refocused.
const createdTargetCandidates = new Map<number, CreatedTargetCandidate>();
const createdWindowCandidates = new Map<number, CreatedWindowCandidate>();
const lastActiveTabByWindow = new Map<number, number>();
const activeStateVersionByWindow = new Map<number, number>();
let lastFocusedWindowId: number | undefined;
let focusedStateVersion = 0;
/** Tab activations Chrome reported, in order (trimmed from the front). */
const activationHistory: { windowId: number; tabId: number }[] = [];
let activationHistoryBase = 0;
/** Window ids Chrome reported focus moving to, in order (trimmed from the front). */
const focusHistory: number[] = [];
let focusHistoryBase = 0;
const handledNavigationTargets = new Set<number>();

/**
 * Track the browser's prior selection without assigning ownership. Only
 * `webNavigation.onCreatedNavigationTarget` with a controlled source may cause
 * a tab to be adopted. This is independent of click/evaluate/form duration, so
 * delayed popups are classified by their actual source page.
 */
export function installNewTabAdopter(): void {
  if (newTabAdopterInstalled) return;
  newTabAdopterInstalled = true;
  chrome.tabs.onReplaced.addListener((added, removed) => {
    for (const [workspace, currentTargetTabId] of currentTargets) {
      if (currentTargetTabId === removed) setTargetTab(added, workspace);
    }
  });

  void seedBrowserSelection();
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id === undefined || tab.windowId === undefined) return;
    const windowCandidate = createdWindowCandidates.get(tab.windowId);
    createdTargetCandidates.set(tab.id, {
      windowId: tab.windowId,
      previousActiveTabId: lastActiveTabByWindow.get(tab.windowId),
      previousFocusedWindowId: windowCandidate?.previousFocusedWindowId ?? lastFocusedWindowId,
    });
    log("observed tab creation; ownership pending source navigation", {
      tabId: tab.id, windowId: tab.windowId, active: tab.active === true,
      openerTabId: tab.openerTabId ?? null,
    });
  });
  chrome.tabs.onActivated.addListener((info) => {
    const previousActiveTabId = lastActiveTabByWindow.get(info.windowId);
    const candidate = createdTargetCandidates.get(info.tabId);
    if (candidate && previousActiveTabId !== undefined && previousActiveTabId !== info.tabId) {
      candidate.previousActiveTabId = previousActiveTabId;
    }
    activeStateVersionByWindow.set(info.windowId, (activeStateVersionByWindow.get(info.windowId) ?? 0) + 1);
    activationHistory.push({ windowId: info.windowId, tabId: info.tabId });
    if (activationHistory.length > 200) {
      activationHistory.splice(0, 100);
      activationHistoryBase += 100;
    }
    lastActiveTabByWindow.set(info.windowId, info.tabId);
    log("tab activation observed; no ownership action until source navigation", {
      tabId: info.tabId, windowId: info.windowId, previousActiveTabId: previousActiveTabId ?? null,
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void setOwner(tabId, null);
    createdTargetCandidates.delete(tabId);
    for (const [windowId, activeTabId] of lastActiveTabByWindow) {
      if (activeTabId === tabId) lastActiveTabByWindow.delete(windowId);
    }
  });
  chrome.windows.onCreated.addListener((window) => {
    if (window.id === undefined) return;
    createdWindowCandidates.set(window.id, { previousFocusedWindowId: lastFocusedWindowId });
    log("observed window creation; focus unchanged until source navigation", {
      windowId: window.id, focused: window.focused === true,
      previousFocusedWindowId: lastFocusedWindowId ?? null,
    });
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    const previousFocusedWindowId = lastFocusedWindowId;
    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
      const candidate = createdWindowCandidates.get(windowId);
      if (candidate && candidate.previousFocusedWindowId === undefined) {
        candidate.previousFocusedWindowId = previousFocusedWindowId;
      }
      lastFocusedWindowId = windowId;
    }
    focusedStateVersion++;
    focusHistory.push(windowId);
    if (focusHistory.length > 200) {
      focusHistory.splice(0, 100);
      focusHistoryBase += 100;
    }
    log("window focus observed; focus unchanged until source navigation", {
      windowId, previousFocusedWindowId: previousFocusedWindowId ?? null,
    });
  });
  chrome.windows.onRemoved.addListener((windowId) => {
    createdWindowCandidates.delete(windowId);
    for (const [tabId, candidate] of createdTargetCandidates) {
      if (candidate.windowId === windowId) createdTargetCandidates.delete(tabId);
    }
  });
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    void handleCreatedNavigationTarget(details).catch((error) => {
      log("controlled-target navigation handling failed:", error instanceof Error ? error.message : String(error));
    });
  });
}

async function seedBrowserSelection(): Promise<void> {
  const activeVersions = new Map(activeStateVersionByWindow);
  const focusVersion = focusedStateVersion;
  try {
    const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
    for (const tab of tabs) {
      if (tab.active && tab.id !== undefined && tab.windowId !== undefined
        && (activeVersions.get(tab.windowId) ?? 0) === 0
        && (activeStateVersionByWindow.get(tab.windowId) ?? 0) === 0) {
        lastActiveTabByWindow.set(tab.windowId, tab.id);
      }
    }
    if (focusVersion === 0 && focusedStateVersion === 0) {
      lastFocusedWindowId = windows.find((window) => window.focused)?.id;
    }
  } catch (error) {
    log("initial selection snapshot unavailable:", error instanceof Error ? error.message : String(error));
  }
}

async function handleCreatedNavigationTarget(details: chrome.webNavigation.WebNavigationSourceCallbackDetails): Promise<void> {
  const tabId = details.tabId;
  if (handledNavigationTargets.has(tabId)) return;
  handledNavigationTargets.add(tabId);
  const candidate = createdTargetCandidates.get(tabId);
  try {
    const workspace = await ownerOf(details.sourceTabId);
    if (workspace === null) {
      log("ignored new target from uncontrolled source", {
        tabId, sourceTabId: details.sourceTabId, sourceFrameId: details.sourceFrameId,
        openerTabId: (await chrome.tabs.get(tabId).catch(() => undefined))?.openerTabId ?? null,
      });
      return;
    }

    const [child, source] = await Promise.all([
      chrome.tabs.get(tabId).catch(() => undefined),
      chrome.tabs.get(details.sourceTabId).catch(() => undefined),
    ]);
    if (!child || child.id === undefined || !source || source.windowId === undefined) {
      log("controlled page target disappeared before it could be adopted", { tabId, sourceTabId: details.sourceTabId });
      return;
    }

    const originalWindowId = child.windowId;
    const focusMark = focusHistoryBase + focusHistory.length;
    const activationMark = activationHistoryBase + activationHistory.length;
    const focusedBeforeMove = (await chrome.windows.getAll().catch(() => []))
      .find((window) => window.focused)?.id;
    const candidatePrevious = candidate?.previousActiveTabId !== undefined
      ? await chrome.tabs.get(candidate.previousActiveTabId).catch(() => undefined)
      : undefined;
    const restoreCandidate: CreatedTargetCandidate = {
      windowId: candidate?.windowId ?? child.windowId ?? source.windowId,
      previousActiveTabId: candidatePrevious?.windowId === source.windowId && candidatePrevious.id !== tabId
        ? candidatePrevious.id
        : lastActiveTabByWindow.get(source.windowId),
      previousFocusedWindowId: candidate?.previousFocusedWindowId
        ?? createdWindowCandidates.get(originalWindowId ?? -1)?.previousFocusedWindowId
        ?? lastFocusedWindowId,
    };
    if (child.windowId !== source.windowId) {
      // A named window.open popup is born in a separate window. Move only after
      // the webNavigation event proves the controlled source created it.
      await chrome.tabs.move(tabId, { windowId: source.windowId, index: -1 });
    }
    await setOwner(tabId, workspace);
    await restoreChildSelection(tabId, details.sourceTabId, source.windowId, restoreCandidate, activationMark);
    await restoreChildWindowFocus(originalWindowId, source.windowId, restoreCandidate, focusedBeforeMove, focusMark);
    log("adopted target created by controlled page", {
      tabId, sourceTabId: details.sourceTabId, sourceFrameId: details.sourceFrameId,
      openerTabId: child.openerTabId ?? null,
      movedFromWindowId: originalWindowId === source.windowId ? null : originalWindowId,
    });
  } finally {
    createdTargetCandidates.delete(tabId);
    const candidateWindowId = candidate?.windowId;
    if (candidateWindowId !== undefined && candidateWindowId !== (await chrome.tabs.get(tabId).catch(() => undefined))?.windowId) {
      createdWindowCandidates.delete(candidateWindowId);
    }
    handledNavigationTargets.delete(tabId);
  }
}

async function restoreChildSelection(
  childTabId: number,
  sourceTabId: number,
  sourceWindowId: number,
  candidate: CreatedTargetCandidate | undefined,
  activationMark: number,
): Promise<void> {
  const child = await chrome.tabs.get(childTabId).catch(() => undefined);
  if (!child?.active) return; // The user selected something else during attribution.
  const [active] = await chrome.tabs.query({ active: true, windowId: sourceWindowId });
  if (active?.id !== childTabId) return;

  const rememberedId = candidate?.previousActiveTabId;
  const remembered = rememberedId !== undefined
    ? await chrome.tabs.get(rememberedId).catch(() => undefined)
    : undefined;
  const fallback = remembered?.windowId === sourceWindowId ? remembered
    : await chrome.tabs.get(sourceTabId).catch(() => undefined);
  // The lookups above yield to Chrome. A tab the user selected meanwhile is the
  // user's decision; do not overwrite it with the remembered selection.
  if (userSelectedAfter(childTabId, sourceWindowId, activationMark)) return;
  const [stillActive] = await chrome.tabs.query({ active: true, windowId: sourceWindowId });
  if (stillActive?.id !== childTabId || userSelectedAfter(childTabId, sourceWindowId, activationMark)) return;
  if (fallback?.id !== undefined && fallback.id !== childTabId && fallback.windowId === sourceWindowId) {
    await chrome.tabs.update(fallback.id, { active: true });
    log("restored prior tab selection after source-confirmed child", {
      childTabId, activeTabId: fallback.id, sourceTabId,
    });
  } else {
    await chrome.tabs.update(childTabId, { active: false });
    log("deactivated source-confirmed child after selection race", { childTabId, sourceTabId });
  }
}

/**
 * True when Chrome reported another tab selected in the window since adoption
 * began, even if the child was selected again afterwards: that is the person
 * choosing, and their latest choice stays.
 */
function userSelectedAfter(childTabId: number, windowId: number, activationMark: number): boolean {
  const lastActive = lastActiveTabByWindow.get(windowId);
  if (lastActive !== undefined && lastActive !== childTabId) return true;
  return activationHistory.slice(Math.max(0, activationMark - activationHistoryBase))
    .some((entry) => entry.windowId === windowId && entry.tabId !== childTabId);
}

async function restoreChildWindowFocus(
  childWindowId: number,
  sourceWindowId: number,
  candidate: CreatedTargetCandidate | undefined,
  focusedBeforeMove: number | undefined,
  focusMark: number,
): Promise<void> {
  if (childWindowId === sourceWindowId) return;
  const previousWindowId = candidate?.previousFocusedWindowId
    ?? createdWindowCandidates.get(childWindowId)?.previousFocusedWindowId;
  if (previousWindowId === undefined || previousWindowId === childWindowId) return;
  const focusVersion = focusedStateVersion;
  const windows = await chrome.windows.getAll().catch(() => []);
  const focused = windows.find((window) => window.focused);
  // Moving the only popup tab may automatically focus the source window; treat
  // that as the same transient popup focus only if the popup was focused before
  // the move. Otherwise leave the user's later focus decision alone.
  if (focused?.id !== childWindowId
    && !(focusedBeforeMove === childWindowId && focused?.id === sourceWindowId)) return;
  if (!windows.some((window) => window.id === previousWindowId)) return;
  // Moving the popup tab only hands focus between the popup and its source
  // window. Focus reported on any other window since adoption began came from
  // the person; keep their choice. (A person clicking the source window itself
  // cannot be told apart from that handoff.)
  const sinceAdoption = focusHistory.slice(Math.max(0, focusMark - focusHistoryBase));
  if (sinceAdoption.some((id) => id !== childWindowId && id !== sourceWindowId && id !== chrome.windows.WINDOW_ID_NONE)) return;
  // A focus change Chrome reports while or after taking the snapshot, to a window
  // other than the one the snapshot saw, is a later choice (the user's, whichever window it
  // is); keep it. A late echo of the snapshot's own focus is not.
  if (focusedStateVersion !== focusVersion && lastFocusedWindowId !== focused?.id) return;
  try {
    await chrome.windows.update(previousWindowId, { focused: true });
    log("restored prior window focus after source-confirmed popup", {
      childWindowId, focusedWindowId: previousWindowId,
    });
  } catch (error) {
    log("prior window focus restore failed:", error instanceof Error ? error.message : String(error));
  }
}
