/**
 * AI tab group tests for lib/target.ts: ownership, the idle tab, the dedicated AI window and the
 * new-tab adopter. These run without Chrome: the small chrome.* double below models only the APIs
 * target.ts uses.
 *
 * Run: npm run test:unit
 */

const listeners = () => {
  const items = [];
  return {
    addListener(fn) { items.push(fn); },
    emit(...args) { return Promise.all(items.map((fn) => fn(...args))); },
  };
};

const onCreated = listeners();
const onActivated = listeners();
const onRemoved = listeners();
const onReplaced = listeners();
const onWindowCreated = listeners();
const onWindowRemoved = listeners();
const onFocusChanged = listeners();
const onCreatedNavigationTarget = listeners();
const tabsById = new Map([
  [10, { id: 10, groupId: 1, windowId: 1, active: false, url: "https://controlled.test/", title: "Controlled" }],
  [20, { id: 20, groupId: -1, windowId: 1, active: true, url: "https://personal.test/", title: "Personal" }],
  [30, { id: 30, groupId: -1, openerTabId: 10, windowId: 2, active: true, url: "https://popup.test/", title: "Popup" }],
  [40, { id: 40, groupId: 1, windowId: 1, url: "https://accounts.google.com/", title: "Blocked controlled" }],
]);
const removed = [];
const updates = [];
const windowUpdates = [];
const creations = [];
const moves = [];
const grouped = [];
// The connection finds its group by title when storage has no id (1.0.8), as after a Chrome restart.
const groups = new Map([[1, { id: 1, title: "AI · 이 컴퓨터의 Chrome" }]]);
const stored = {};
const sessionStored = {};
const windowsById = new Map([
  [1, { id: 1, focused: true, type: "normal" }],
  [2, { id: 2, focused: false, type: "popup" }],
]);

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test${path}` },
  tabs: {
    onCreated,
    onActivated,
    onRemoved,
    onReplaced,
    async get(id) {
      const tab = tabsById.get(id);
      if (!tab) throw new Error(`tab ${id} not found`);
      return { ...tab };
    },
    async query(query) {
      let values = [...tabsById.values()];
      if (query?.groupId !== undefined) values = values.filter((tab) => tab.groupId === query.groupId);
      if (query?.windowId !== undefined) values = values.filter((tab) => tab.windowId === query.windowId);
      if (query?.active !== undefined) values = values.filter((tab) => Boolean(tab.active) === query.active);
      return values.map((tab) => ({ ...tab }));
    },
    async update(id, changes) {
      const tab = tabsById.get(id);
      if (!tab) throw new Error(`tab ${id} not found`);
      const previousActive = [...tabsById.values()].find(other => other.windowId === tab.windowId && other.active);
      if (changes.active === true) {
        for (const other of tabsById.values()) {
          if (other.windowId === tab.windowId) other.active = false;
        }
      }
      Object.assign(tab, changes);
      updates.push({ id, changes: { ...changes } });
      if (changes.active === true && previousActive?.id !== id) {
        await onActivated.emit({ tabId: id, windowId: tab.windowId, previousTabId: previousActive?.id });
      }
      return { ...tab };
    },
    async move(id, changes) {
      const tab = tabsById.get(id);
      if (!tab) throw new Error(`tab ${id} not found`);
      const oldWindowId = tab.windowId;
      const wasActive = tab.active;
      const priorDestinationActive = [...tabsById.values()].find(other => other.id !== id
        && other.windowId === changes.windowId && other.active);
      if (wasActive) {
        const replacement = [...tabsById.values()].find(other => other.id !== id && other.windowId === oldWindowId);
        if (replacement) replacement.active = true;
        if (priorDestinationActive) priorDestinationActive.active = false;
      }
      Object.assign(tab, { windowId: changes.windowId, active: wasActive });
      moves.push({ id, changes: { ...changes } });
      if (wasActive) await onActivated.emit({ tabId: id, windowId: changes.windowId,
        previousTabId: priorDestinationActive?.id });
      return { ...tab };
    },
    async remove(ids) {
      for (const id of [ids].flat()) {
        if (!tabsById.has(id)) throw new Error(`tab ${id} not found`);
        removed.push(id);
        tabsById.delete(id);
        await onRemoved.emit(id);
      }
    },
    async group({ tabIds, groupId }) {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const id of ids) {
        const tab = tabsById.get(id);
        if (tab) tab.groupId = groupId ?? 1;
      }
      if (!groups.has(groupId ?? 1)) groups.set(groupId ?? 1, { id: groupId ?? 1, title: "" });
      grouped.push({ ids, groupId: groupId ?? 1 });
      return groupId ?? 1;
    },
    async create(createProperties = {}) {
      const id = Math.max(...tabsById.keys()) + 1;
      const tab = { id, groupId: -1, windowId: createProperties.windowId ?? 1, active: createProperties.active !== false, url: createProperties.url ?? "about:blank" };
      creations.push({ properties: { ...createProperties }, tab: { ...tab } });
      tabsById.set(id, tab);
      await onCreated.emit({ ...tab });
      return { ...tab };
    },
  },
  tabGroups: {
    async get(id) { if (!groups.has(id)) throw new Error(`group ${id} not found`); return { ...groups.get(id) }; },
    async query(query) {
      return [...groups.values()].filter((group) => !query?.title || group.title === query.title).map(group => ({ ...group }));
    },
    async update(id, patch) {
      Object.assign(groups.get(id), patch);
    },
  },
  windows: {
    onCreated: onWindowCreated,
    onRemoved: onWindowRemoved,
    onFocusChanged,
    WINDOW_ID_NONE: -1,
    async getAll() { return [...windowsById.values()].map(window => ({ ...window })); },
    async get(id) { if (!windowsById.has(id)) throw new Error(`window ${id} not found`); return { ...windowsById.get(id) }; },
    async create({ url }) {
      const id = Math.max(...windowsById.keys()) + 1;
      windowsById.set(id, { id, focused: false, type: "normal" });
      return { id, tabs: [await chrome.tabs.create({ url, windowId: id, active: true })] };
    },
    async update(id, changes) {
      const window = windowsById.get(id);
      if (!window) throw new Error(`window ${id} not found`);
      if (changes.focused === true) {
        for (const other of windowsById.values()) other.focused = false;
        window.focused = true;
        await onFocusChanged.emit(id);
      } else Object.assign(window, changes);
      windowUpdates.push({ id, changes: { ...changes } });
    },
  },
  webNavigation: { onCreatedNavigationTarget },
  storage: {
    session: {
      async get(key) { return key in sessionStored ? { [key]: sessionStored[key] } : {}; },
      async set(values) { Object.assign(sessionStored, values); },
    },
    local: {
      async get(key) { return typeof key === "string" ? (key in stored ? { [key]: stored[key] } : {}) : { ...stored }; },
      async set(values) { Object.assign(stored, values); },
    },
  },
};

const {
  resolveTabId,
  createControlledTab,
  installNewTabAdopter,
  idleUrl,
  listDccbTabs,
  isControlledTab,
  focusAnyGroupTab,
} = await import("../entrypoints/lib/target.ts");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectReject(promise, text) {
  try {
    await promise;
    return false;
  } catch (error) {
    return String(error?.message ?? error).includes(text);
  }
}

installNewTabAdopter();
await new Promise((resolve) => setTimeout(resolve, 0));

// All resolveTabId callers, including evaluate/page/etc., share this gate.
check(
  "explicit personal tab is rejected by resolveTabId",
  await expectReject(resolveTabId(20), "not a bridge-controlled DCCB tab"),
);
check(
  "explicit controlled tab is accepted by resolveTabId",
  await resolveTabId(10) === 10,
);
// A new tab is only observed at creation time. Its (misreported) opener does
// not grant ownership or trigger movement/deactivation until the browser's
// sourceTabId proves that the controlled renderer opened it.
await onCreated.emit({ ...tabsById.get(30) });
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  "new tab is untouched until source navigation confirms ownership",
  tabsById.get(30)?.groupId === -1 && tabsById.get(30)?.active === true
    && tabsById.get(30)?.windowId === 2 && grouped.every((entry) => !entry.ids.includes(30))
    && moves.length === 0 && updates.length === 0 && windowUpdates.length === 0,
  JSON.stringify({ popup: tabsById.get(30), grouped, moves, updates }),
);
await onCreatedNavigationTarget.emit({ tabId: 30, sourceTabId: 10, sourceFrameId: 0,
  url: "https://popup.test/", timeStamp: Date.now() });
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  "sourceTabId adopts a child even when Chrome misreports openerTabId",
  tabsById.get(30)?.groupId === 1 && tabsById.get(30)?.active === false
    && tabsById.get(20)?.active === true && grouped.some((entry) => entry.ids.includes(30)),
  JSON.stringify({ child: tabsById.get(30), human: tabsById.get(20), updates, grouped }),
);

// Simulate a user's tab created during a controlled operation before the
// target navigation attribution arrives. It must remain active and personal.
tabsById.set(50, { id: 50, groupId: -1, windowId: 1, active: true, openerTabId: 20,
  url: "https://child.test/", title: "Misreported opener child" });
tabsById.get(20).active = false;
const movesBeforeMisreportedChild = moves.length;
const groupsBeforeMisreportedChild = grouped.length;
await onCreated.emit({ ...tabsById.get(50) });
await onActivated.emit({ tabId: 50, windowId: 1 });
check("misreported-opener candidate has no pre-attribution side effects",
  tabsById.get(50)?.groupId === -1 && tabsById.get(50)?.active === true
    && moves.length === movesBeforeMisreportedChild && grouped.length === groupsBeforeMisreportedChild,
  JSON.stringify({ child: tabsById.get(50), moves, grouped }));
tabsById.set(60, { id: 60, groupId: -1, windowId: 1, active: true,
  url: "https://user-created.test/", title: "User-created" });
tabsById.get(50).active = false;
await onCreated.emit({ ...tabsById.get(60) });
await onActivated.emit({ tabId: 60, windowId: 1 });
await onCreatedNavigationTarget.emit({ tabId: 50, sourceTabId: 10, sourceFrameId: 0,
  url: "https://child.test/", timeStamp: Date.now() });
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  "concurrent user-created tab stays active and outside DCCB while AI child is adopted",
  tabsById.get(50)?.groupId === 1 && tabsById.get(50)?.active === false
    && tabsById.get(60)?.groupId === -1 && tabsById.get(60)?.active === true
    && tabsById.get(60)?.windowId === 1,
  JSON.stringify({ child: tabsById.get(50), personal: tabsById.get(60), updates, grouped }),
);

// An unconfirmed user window is likewise only observed. A page-sourced popup
// is moved/grouped and its original focus restored only after webNavigation
// identifies the controlled source tab.
windowsById.set(3, { id: 3, focused: true, type: "normal" });
windowsById.get(1).focused = false;
await onWindowCreated.emit({ ...windowsById.get(3) });
await onFocusChanged.emit(3);
tabsById.set(61, { id: 61, groupId: -1, windowId: 3, active: true,
  url: "https://personal-window.test/", title: "User window" });
await onCreated.emit({ ...tabsById.get(61) });
await onActivated.emit({ tabId: 61, windowId: 3 });
check("user-created window receives no pre-attribution focus or tab changes",
  tabsById.get(61)?.windowId === 3 && tabsById.get(61)?.active === true
    && tabsById.get(61)?.groupId === -1 && windowsById.get(3)?.focused === true,
  JSON.stringify({ tab: tabsById.get(61), windows: [...windowsById.values()], moves, windowUpdates }));

await chrome.windows.update(1, { focused: true });
windowsById.set(4, { id: 4, focused: true, type: "popup" });
windowsById.get(1).focused = false;
await onWindowCreated.emit({ ...windowsById.get(4) });
await onFocusChanged.emit(4);
tabsById.set(70, { id: 70, groupId: -1, windowId: 4, active: true, openerTabId: 20,
  url: "https://ai-popup.test/", title: "AI popup" });
await onCreated.emit({ ...tabsById.get(70) });
await onActivated.emit({ tabId: 70, windowId: 4 });
const movesBeforePopupAttribution = moves.length;
const focusUpdatesBeforePopupAttribution = windowUpdates.length;
check("AI popup is not moved or refocused before source signal",
  tabsById.get(70)?.windowId === 4 && windowsById.get(4)?.focused === true
    && moves.length === movesBeforePopupAttribution
    && windowUpdates.length === focusUpdatesBeforePopupAttribution,
  JSON.stringify({ tab: tabsById.get(70), windows: [...windowsById.values()], moves, windowUpdates }));
await onCreatedNavigationTarget.emit({ tabId: 70, sourceTabId: 10, sourceFrameId: 0,
  url: "https://ai-popup.test/", timeStamp: Date.now() });
await new Promise((resolve) => setTimeout(resolve, 0));
check("source-confirmed AI popup is grouped/inactive and restores prior window focus",
  tabsById.get(70)?.groupId === 1 && tabsById.get(70)?.active === false
    && tabsById.get(70)?.windowId === 1 && windowsById.get(1)?.focused === true,
  JSON.stringify({ tab: tabsById.get(70), windows: [...windowsById.values()], moves, windowUpdates }));

// The group's idle tab is reused (navigated, inactive) for the next AI tab instead of a new tab.
tabsById.set(45, { id: 45, groupId: 1, windowId: 1, active: false, url: idleUrl(), title: "" });
const reused = await createControlledTab("https://next.test/");
check(
  "the next AI tab reuses the idle tab",
  reused.id === 45 && tabsById.get(45).url === "https://next.test/"
    && creations.length === 0,
  JSON.stringify({ reused, creations }),
);
const fresh = await createControlledTab("https://another.test/");
check(
  "with no idle tab a new AI tab opens inactive in the group",
  creations.at(-1)?.properties.active === false && tabsById.get(fresh.id)?.groupId === 1,
  JSON.stringify(creations.at(-1)),
);

// One group for every work space (owner 11-08): two work spaces share the group, each sees only its
// own tabs, and a work space group left by 1.2.0 is folded in.
const groupCount = () => new Set([...tabsById.values()].map(tab => tab.groupId).filter(id => id > 0)).size;
const research = await createControlledTab("https://research.test/", "research");
const shopping = await createControlledTab("https://shopping.test/", "shopping");
check(
  "two work spaces share one AI group and each sees only its own tabs",
  tabsById.get(research.id).groupId === tabsById.get(shopping.id).groupId && groupCount() === 1
    && (await listDccbTabs("research")).map(tab => tab.id).join() === String(research.id)
    && !(await isControlledTab(shopping.id, "research")) && await isControlledTab(shopping.id, "shopping"),
  JSON.stringify({ research: tabsById.get(research.id), shopping: tabsById.get(shopping.id), groups: [...groups.values()] }),
);
groups.set(7, { id: 7, title: "AI · 이 컴퓨터의 Chrome · youtube" });
tabsById.set(80, { id: 80, groupId: 7, windowId: 1, active: false, url: "https://youtube.test/", title: "old" });
tabsById.set(81, { id: 81, groupId: 7, windowId: 1, active: false, url: idleUrl(), title: "" });
const youtube = await listDccbTabs("youtube");
check(
  "a 1.2.0 work space group is folded into the one group, keeping its tab's work space",
  youtube.map(tab => tab.id).join() === "80" && groupCount() === 1
    && [...tabsById.values()].filter(tab => tab.url === idleUrl()).length <= 1,
  JSON.stringify({ youtube, tabs: [...tabsById.values()].filter(tab => tab.id >= 80) }),
);

// With only 1.2.0 work space groups open, one of them is renamed into the AI group (no new group).
for (const tab of [...tabsById.values()]) if (tab.groupId === 1) tabsById.delete(tab.id);
groups.clear();
stored.v8ClientGroups = {};
groups.set(5, { id: 5, title: "AI · 이 컴퓨터의 Chrome · mail" });
groups.set(6, { id: 6, title: "AI · 이 컴퓨터의 Chrome · docs" });
tabsById.set(90, { id: 90, groupId: 5, windowId: 1, active: false, url: "https://mail.test/", title: "" });
tabsById.set(91, { id: 91, groupId: 6, windowId: 1, active: false, url: "https://docs.test/", title: "" });
const mail = await listDccbTabs("mail");
const docs = await listDccbTabs("docs");
check(
  "1.2.0 work space groups become the one AI group by renaming and merging, no new group",
  mail.map(tab => tab.id).join() === "90" && docs.map(tab => tab.id).join() === "91" && groupCount() === 1
    && groups.get(5)?.title === "AI · 이 컴퓨터의 Chrome" && creations.every(c => !c.tab.url?.includes("mail")),
  JSON.stringify({ mail, docs, groups: [...groups.values()], tabs: [...tabsById.values()].filter(tab => tab.id >= 90) }),
);

// With the dedicated AI window on, a group that is gone (its idle tab closed by an extension
// reload) is rebuilt in the AI window that is still open, not in one more window (owner PC 11-07).
const { connectionKey } = await import("../entrypoints/lib/v8-auth.ts");
for (const tab of [...tabsById.values()]) if (tab.groupId === 1) tabsById.delete(tab.id);
groups.clear();
windowsById.set(9, { id: 9, focused: false, type: "normal" });
stored.v8DedicatedWindow = true;
stored.v8ClientWindows = { [connectionKey()]: 9 };
stored.v8ClientGroups = {};
const windowsBefore = windowsById.size;
const inAiWindow = await createControlledTab("https://after-reload.test/");
check(
  "a lost group is rebuilt in the open AI window, not a new window",
  inAiWindow.windowId === 9 && windowsById.size === windowsBefore && creations.at(-1)?.properties.active === false,
  JSON.stringify({ tab: inAiWindow, creation: creations.at(-1) }),
);

// The popup's "작업 탭으로 이동": a work space with no tab left falls back to another tab of the
// group instead of showing Chrome's error; with no group at all it says so (F04b 11-08).
windowsById.get(9).state = "minimized";
const focusedFallback = await focusAnyGroupTab("shopping");
check(
  "the popup shows another AI tab when the last work space has none",
  focusedFallback === true && tabsById.get(inAiWindow.id).active === true && windowsById.get(9).focused === true,
  JSON.stringify({ focusedFallback, tab: tabsById.get(inAiWindow.id), window: windowsById.get(9) }),
);
for (const tab of [...tabsById.values()]) if (tab.groupId > 0) tabsById.delete(tab.id);
groups.clear();
stored.v8ClientGroups = {};
const groupsBeforeEmptyFocus = groups.size;
check(
  "with no AI group the popup is told there is no AI tab, and no group is made",
  await focusAnyGroupTab("shopping") === false && groups.size === groupsBeforeEmptyFocus,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`FAILURES: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("ALL TARGET UNIT ASSERTIONS PASSED");
