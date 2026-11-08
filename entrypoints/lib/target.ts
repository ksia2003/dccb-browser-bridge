/**
 * DCCB Browser Bridge — the AI's tabs: ONE "AI · <device>" tab group per connected Chrome, the
 * idle tab that keeps it alive, and the optional dedicated AI window. Work spaces share the group;
 * which tab belongs to which work space is kept per browser session (owner 11-08: four AI groups
 * left in Chrome's saved-groups bar is not acceptable — Chrome pins every group there).
 *
 * The pipe (lib/pipe.ts) offers an engine only its work space's tabs and opens a tab only when
 * there is none (owner 11-06: never a new tab per connection). The bridge never drives the person's
 * own tabs; the popup's "AI 작업 탭 보기" and `handoff` bring the AI tab forward.
 */

import { snapshot, connectionKey as clientKey } from "./v8-auth";

const GROUPS_KEY = "v8ClientGroups";
export const DEDICATED_WINDOW_KEY = "v8DedicatedWindow";
export const LAST_WORKSPACE_KEY = "v8LastWorkspace";
const DEFAULT_WORKSPACE = "default";
const currentTargets = new Map<string, number | null>();
let lastWorkspace = DEFAULT_WORKSPACE;

export function normalizeWorkspace(value?: unknown): string {
  if (value === undefined) return DEFAULT_WORKSPACE;
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value)) return value;
  throw new Error("workspace는 1~40자 [A-Za-z0-9_-]");
}

/**
 * Tab → work space, for this browser session (tab ids do not outlive it). A tab of the group with
 * no owner (after a Chrome restart) belongs to the default work space.
 */
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
/** The idle tab belongs to no work space. */
export function forgetTabOwner(tabId: number): Promise<void> {
  return setOwner(tabId, null);
}
async function ownerOf(tabId: number): Promise<string> {
  return (await loadOwners())[tabId] ?? DEFAULT_WORKSPACE;
}

let workspaceStorageQueue: Promise<void> = Promise.resolve();
function storeWorkspaceEntry(key: string, entryKey: string, value: number): Promise<void> {
  const task = workspaceStorageQueue.then(async () => {
    const stored = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: { ...stored[key], [entryKey]: value } });
  });
  workspaceStorageQueue = task.catch(() => {});
  return task;
}

/**
 * The tab the AI group keeps when its last working tab is closed. Chrome closes
 * a group with its last tab and files it under Saved Tab Groups, where no
 * extension API can reopen it; the next tab then got a second group of the same
 * name, every time (seen 2026-11-04: three closed "AI · Windows의 Chrome").
 * Chrome closes this page when the extension reloads or updates, and the group
 * with it, but that group is not saved: the next connection makes one new group
 * (owner PC 11-07). about:blank opened by the extension or its debugger closes
 * the same way, so the page that explains itself stays.
 */
export const idleUrl = (): string => chrome.runtime.getURL("/idle.html");

export function groupTitle(): string {
  return "AI · " + snapshot().deviceName;
}

async function clientGroup(): Promise<number | null> {
  const stored = await chrome.storage.local.get(GROUPS_KEY);
  const id = stored[GROUPS_KEY]?.[clientKey()];
  let found = typeof id === "number" && await chrome.tabGroups.get(id).catch(() => null) ? id : null;
  if (found === null) {
    // Group ids change when Chrome restarts and when this connection is paired
    // again, so an open group with this connection's title is the same group.
    const [named] = await chrome.tabGroups.query({ title: groupTitle() });
    // No group of that name but a 1.2.0 work space group: rename it into the one group rather than
    // open another (an emptied or closed group is what piles up in Chrome's saved-groups bar).
    const legacy = named ? undefined : (await chrome.tabGroups.query({})).find(group => group.title?.startsWith(groupTitle() + " · "));
    if (legacy) {
      const workspace = legacy.title!.slice(groupTitle().length + 3);
      for (const tab of await chrome.tabs.query({ groupId: legacy.id })) if (tab.id !== undefined) await setOwner(tab.id, tab.url === idleUrl() ? null : workspace);
      await chrome.tabGroups.update(legacy.id, { title: groupTitle() });
      log("renamed a work space group into the AI group", { workspace });
    }
    const adopted = named ?? legacy;
    if (adopted) {
      found = adopted.id;
      await storeWorkspaceEntry(GROUPS_KEY, clientKey(), adopted.id);
    }
  }
  if (found !== null) await mergeWorkspaceGroups(found);
  return found;
}

/**
 * Before 1.2.1 each work space had its own "AI · <device> · <work space>" group. Fold any that are
 * still open into the one group, keeping each tab's work space and a single idle tab.
 */
async function mergeWorkspaceGroups(main: number): Promise<void> {
  const prefix = groupTitle() + " · ";
  for (const group of await chrome.tabGroups.query({})) {
    if (group.id === main || !group.title?.startsWith(prefix)) continue;
    const workspace = group.title.slice(prefix.length);
    const tabs = await chrome.tabs.query({ groupId: group.id });
    for (const tab of tabs) if (tab.id !== undefined) await setOwner(tab.id, tab.url === idleUrl() ? null : workspace);
    const ids = tabs.map(tab => tab.id).filter((id): id is number => id !== undefined);
    if (ids.length) await chrome.tabs.group({ tabIds: ids, groupId: main });
    log("merged work space group into the AI group", { workspace, tabs: ids.length });
  }
  // Merging can bring several idle tabs; one is enough (the next AI tab reuses it).
  const extra = (await chrome.tabs.query({ groupId: main })).filter(tab => tab.url === idleUrl()).slice(1);
  if (extra.length) await chrome.tabs.remove(extra.map(tab => tab.id!));
}
const creationQueues = new Map<string, Promise<unknown>>();
export function createControlledTab(url?: string, workspace?: unknown): Promise<chrome.tabs.Tab> {
  const workspaceName = normalizeWorkspace(workspace);
  // One queue for the one group: two work spaces must not both claim the idle tab.
  const task = (creationQueues.get("") ?? Promise.resolve()).then(() => createClientTab(url, workspaceName));
  creationQueues.set("", task.catch(() => {}));
  return task;
}
async function createClientTab(url?: string, workspace = DEFAULT_WORKSPACE): Promise<chrome.tabs.Tab> {
  workspace = normalizeWorkspace(workspace);
  const stored = await chrome.storage.local.get(DEDICATED_WINDOW_KEY);
  const group = await clientGroup();
  const windowId = group === null ? undefined : (await chrome.tabGroups.get(group)).windowId;
  let tab: chrome.tabs.Tab;
  const windows = await chrome.storage.local.get("v8ClientWindows");
  const dedicatedId = windows.v8ClientWindows?.[clientKey()];
  const dedicated = typeof dedicatedId === "number" ? await chrome.windows.get(dedicatedId).catch(() => null) : null;
  // Match patterns cannot name an extension page, so filter by URL here.
  const idle = group === null ? undefined : (await chrome.tabs.query({ groupId: group })).find(t => t.url === idleUrl());
  if (idle?.id !== undefined) {
    tab = await chrome.tabs.update(idle.id, { url: url ?? "about:blank" }) ?? idle;
  } else if (stored[DEDICATED_WINDOW_KEY] === true && dedicated && windowId === undefined) {
    // The group is gone (an extension reload closes its idle tab) but the AI window is still open:
    // reuse it instead of opening one more window per reload (owner PC 11-07: two AI windows).
    tab = await chrome.tabs.create({ active: false, windowId: dedicated.id, url: url ?? "about:blank" });
  } else if (stored[DEDICATED_WINDOW_KEY] === true && (!dedicated || windowId === undefined || windowId !== dedicated.id)) {
    const window = await chrome.windows.create({ focused: false, url: url ?? "about:blank" });
    tab = window.tabs![0];
    if (group !== null) await chrome.tabGroups.move(group, { windowId: window.id!, index: -1 });
    await storeWorkspaceEntry("v8ClientWindows", clientKey(), window.id!);
  } else {
    tab = await chrome.tabs.create({ active: false, ...(url ? { url } : {}), ...(windowId !== undefined ? { windowId } : {}) });
  }
  await addToDccbGroup(tab.id!, workspace);
  setTargetTab(tab.id!, workspace);
  return tab;
}

export async function focusControlledTab(explicitTabId?: unknown, workspace?: unknown) {
  const workspaceName = normalizeWorkspace(workspace);
  const tabId = await resolveTabId(explicitTabId, workspaceName);
  const [previous] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = await chrome.tabs.get(tabId);
  const window = await chrome.windows.get(tab.windowId);
  await chrome.windows.update(tab.windowId, { focused: true, ...(window.state === "minimized" ? { state: "normal" as const } : {}) });
  await chrome.tabs.update(tabId, { active: true });
  setTargetTab(tabId, workspaceName);
  return { action: "focus", tabId, previousActiveTabId: previous?.id ?? null, ok: true };
}

/**
 * The popup's "작업 탭으로 이동": the last work space's tab, else any tab of the
 * AI group (the idle tab last). False when there is no AI group yet.
 */
export async function focusAnyGroupTab(workspace?: unknown): Promise<boolean> {
  try {
    await focusControlledTab(undefined, workspace);
    return true;
  } catch (error) {
    log("focus fell back to the group:", error instanceof Error ? error.message : String(error));
  }
  const tabs = await listGroupTabs();
  const tab = tabs.find(t => t.url !== idleUrl()) ?? tabs[0];
  if (tab?.id === undefined) return false;
  const window = await chrome.windows.get(tab.windowId);
  await chrome.windows.update(tab.windowId, { focused: true, ...(window.state === "minimized" ? { state: "normal" as const } : {}) });
  await chrome.tabs.update(tab.id, { active: true });
  return true;
}


function log(...args: unknown[]): void {
  console.log("[bb-v6 target]", ...args);
}

/**
 * The bridge's dedicated working tab. Set when the AI creates a tab
 * (`tabs` create) or navigates (`navigate`); cleared when that tab is closed
 * (tabs.onRemoved) or the debugger detaches from it. Tools target THIS tab —
 * never the user's active/focused tab.
 */
/** Set the bridge's working tab (called by navigate / tabs-create). */
export function setTargetTab(tabId: number, workspace?: unknown): void {
  const workspaceName = normalizeWorkspace(workspace);
  const currentTargetTabId = currentTargets.get(workspaceName) ?? null;
  if (currentTargetTabId !== tabId) {
    log("currentTargetTabId:", workspaceName, currentTargetTabId, "->", tabId);
  }
  currentTargets.set(workspaceName, tabId);
  setLastWorkspace(workspaceName);
}

/** The bridge's current working tab id, or null if none is set yet. */
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
    if (currentTargetTabId === tabId && (workspace === undefined || key === normalizeWorkspace(workspace))) {
      log("currentTargetTabId cleared (workspace", key, "tab", tabId, "gone)");
      currentTargets.set(key, null);
    }
  }
}

/** True if a tab still exists. */
async function tabExists(tabId: number, workspace = DEFAULT_WORKSPACE): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return Boolean(tab && tab.id !== undefined && await isControlledTab(tabId, workspace));
}

/**
 * Resolve the tab a command applies to: an explicit `tabId` (it must be one of the group's), else
 * the working tab, else a tab of the group. Never the person's active tab.
 */
export async function resolveTabId(explicitTabId?: unknown, workspace?: unknown): Promise<number> {
  return resolveTabIdRaw(explicitTabId, normalizeWorkspace(workspace));
}

async function resolveTabIdRaw(explicitTabId: unknown, workspace: string): Promise<number> {
  // (a) explicit tabId wins, but only for an already-controlled tab. A caller
  // supplying an arbitrary personal tab must never turn it into a target.
  if (typeof explicitTabId === "number") {
    const tab = await chrome.tabs.get(explicitTabId).catch(() => undefined);
    if (!tab || tab.id === undefined) {
      throw new Error(`tabId ${explicitTabId} not found`);
    }
    if (!(await isControlledTab(explicitTabId, workspace))) {
      throw new Error(`tabId ${explicitTabId} is not a bridge-controlled DCCB tab`);
    }
    return tab.id;
  }

  // (b) the bridge's dedicated working tab, if it still exists.
  const currentTargetTabId = getTargetTab(workspace);
  if (currentTargetTabId !== null) {
    if (await tabExists(currentTargetTabId, workspace)) return currentTargetTabId;
    // It was closed out from under us — forget it.
    clearTargetTabIfMatches(currentTargetTabId, workspace);
  }

  // (c) any tab in the DCCB group (recovery after SW restart loses the cache).
  const groupTab = await firstDccbTabId(workspace);
  if (groupTab !== null) {
    // Adopt it as the working tab so subsequent tools are stable.
    setTargetTab(groupTab, workspace);
    return groupTab;
  }

  // (d) NO active-tab fallback. The bridge must work in its OWN tab.
  throw new Error("no AI tab in this work space yet — open one with pc-browser first");
}

/**
 * Add `tabId` to this connection’s AI group, creating it on first use.
 * Surface Chrome’s grouping error rather than claim an ungrouped tab is owned.
 */
let groupQueue: Promise<void> = Promise.resolve();
export function addToDccbGroup(tabId: number, workspace?: unknown): Promise<void> {
  const workspaceName = normalizeWorkspace(workspace);
  const task = groupQueue.then(() => addToClientGroup(tabId, workspaceName));
  groupQueue = task.catch(() => {});
  return task;
}
async function addToClientGroup(tabId: number, workspace: string): Promise<void> {
  try {
    const existing = await findDccbGroupId();
    const groupId = await chrome.tabs.group(
      existing !== null ? { tabIds: tabId, groupId: existing } : { tabIds: tabId },
    );
    await setOwner(tabId, workspace);
    if (existing === null) {
      await chrome.tabGroups.update(groupId, {
        title: groupTitle(),
        color: (["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const)[Array.from(clientKey()).reduce((n, c) => n + c.charCodeAt(0), 0) % 8],
        collapsed: false,
      });
      await storeWorkspaceEntry(GROUPS_KEY, clientKey(), groupId);
      log("created client group", groupId);
    }
  } catch (e) {
    log("group add failed:", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Find this connection’s AI group (one for every work space), or null. */
export async function findDccbGroupId(): Promise<number | null> {
  return clientGroup();
}

/** First tab of the group the debugger can drive (not the idle tab, not chrome:// pages), or null. */
async function firstDccbTabId(workspace = DEFAULT_WORKSPACE): Promise<number | null> {
  const tabs = await listDccbTabs(workspace);
  for (const t of tabs) {
    const url = (t.url ?? "").toLowerCase();
    if (t.id !== undefined && !/^(chrome|chrome-extension|devtools|edge|view-source):/.test(url)) return t.id;
  }
  return null;
}

/** Every tab of the AI group, all work spaces and the idle tab (empty if there is no group yet). */
export async function listGroupTabs(): Promise<chrome.tabs.Tab[]> {
  const groupId = await findDccbGroupId();
  if (groupId === null) return [];
  return chrome.tabs.query({ groupId });
}

/** The work space's tabs in the AI group (not the idle tab). */
export async function listDccbTabs(workspace?: unknown): Promise<chrome.tabs.Tab[]> {
  const workspaceName = normalizeWorkspace(workspace);
  const tabs: chrome.tabs.Tab[] = [];
  for (const tab of await listGroupTabs()) {
    if (tab.id !== undefined && tab.url !== idleUrl() && await ownerOf(tab.id) === workspaceName) tabs.push(tab);
  }
  return tabs;
}

/**
 * Is `tabId` a member of the connection’s AI group? The new-target adopter applies this to
 * webNavigation's actual `sourceTabId`; `openerTabId` and creation timing are
 * not ownership evidence.
 */
export async function isControlledTab(tabId: number, workspace?: unknown): Promise<boolean> {
  const workspaceName = normalizeWorkspace(workspace);
  const groupId = await findDccbGroupId();
  if (groupId === null) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return Boolean(tab && tab.groupId === groupId && await ownerOf(tabId) === workspaceName);
}

async function workspaceForTab(tabId: number): Promise<string | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const groupId = await findDccbGroupId();
  if (!tab || groupId === null || tab.groupId !== groupId) return null;
  return ownerOf(tabId);
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
    const workspace = await workspaceForTab(details.sourceTabId);
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
    await addToDccbGroup(tabId, workspace);
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
