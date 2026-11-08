/**
 * lib/target.ts (6.0.0): the AI's tabs are ordinary background tabs it opened itself, never grouped,
 * never brought forward except from the popup's card; pages they open join their work space; the
 * pre-6.0.0 tab group is left behind once. These run without Chrome: the small chrome.* double below
 * models only the APIs target.ts uses (it has no tabs.group, so any grouping fails the run).
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
const createdWindows = [];
const ungrouped = [];
const stored = {};
// Tabs 10 and 40 were opened for the AI in this browser session.
const sessionStored = { v8TabWorkspaces: { 10: "default", 40: "default" } };
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
    async ungroup(ids) {
      for (const id of [ids].flat()) {
        const tab = tabsById.get(id);
        if (tab) tab.groupId = -1;
        ungrouped.push(id);
      }
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
  windows: {
    onCreated: onWindowCreated,
    onRemoved: onWindowRemoved,
    onFocusChanged,
    WINDOW_ID_NONE: -1,
    async getAll() { return [...windowsById.values()].map(window => ({ ...window })); },
    async get(id) { if (!windowsById.has(id)) throw new Error(`window ${id} not found`); return { ...windowsById.get(id) }; },
    async getLastFocused({ windowTypes } = {}) {
      const normal = [...windowsById.values()].filter(window => !windowTypes || windowTypes.includes(window.type));
      const window = normal.find(window => window.focused) ?? normal.at(-1);
      if (!window) throw new Error("No last-focused window");
      return { ...window };
    },
    async create({ url, focused }) {
      const id = Math.max(0, ...windowsById.keys()) + 1;
      windowsById.set(id, { id, focused: focused !== false, type: "normal" });
      createdWindows.push({ id, focused });
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
      async remove(keys) { for (const key of [keys].flat()) delete stored[key]; },
    },
  },
};

const {
  createControlledTab,
  installNewTabAdopter,
  listDccbTabs,
  listAiTabs,
  isControlledTab,
  ownerOf,
  popupTarget,
  focusPopupTarget,
  migrateFromTabGroups,
  setTargetTab,
  installSeenWatch,
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

installNewTabAdopter();
installSeenWatch();
await tick();

check(
  "only tabs the AI opened belong to a work space; the person's tab belongs to none",
  await isControlledTab(10) && !(await isControlledTab(20)) && await ownerOf(20) === null
    && (await listDccbTabs()).map(tab => tab.id).join() === "10,40",
);

// A new tab is only observed at creation time. Its (misreported) opener does not grant ownership or
// trigger movement/deactivation until the browser's sourceTabId proves an AI tab opened it.
await onCreated.emit({ ...tabsById.get(30) });
await tick();
check(
  "a new tab is untouched until source navigation confirms it",
  await ownerOf(30) === null && tabsById.get(30)?.active === true && tabsById.get(30)?.windowId === 2
    && moves.length === 0 && updates.length === 0 && windowUpdates.length === 0,
  JSON.stringify({ popup: tabsById.get(30), moves, updates }),
);
await onCreatedNavigationTarget.emit({ tabId: 30, sourceTabId: 10, sourceFrameId: 0, url: "https://popup.test/", timeStamp: Date.now() });
await tick();
check(
  "a page an AI tab opens joins its work space, inactive, without a tab group",
  await ownerOf(30) === "default" && tabsById.get(30)?.active === false && tabsById.get(30)?.groupId === -1
    && tabsById.get(20)?.active === true,
  JSON.stringify({ child: tabsById.get(30), human: tabsById.get(20), updates }),
);

// A tab the person opens while the AI works stays theirs and stays in front.
tabsById.set(50, { id: 50, groupId: -1, windowId: 1, active: true, openerTabId: 20, url: "https://child.test/", title: "Misreported opener child" });
tabsById.get(20).active = false;
await onCreated.emit({ ...tabsById.get(50) });
await onActivated.emit({ tabId: 50, windowId: 1 });
tabsById.set(60, { id: 60, groupId: -1, windowId: 1, active: true, url: "https://user-created.test/", title: "User-created" });
tabsById.get(50).active = false;
await onCreated.emit({ ...tabsById.get(60) });
await onActivated.emit({ tabId: 60, windowId: 1 });
await onCreatedNavigationTarget.emit({ tabId: 50, sourceTabId: 10, sourceFrameId: 0, url: "https://child.test/", timeStamp: Date.now() });
await tick();
check(
  "a tab the person opens meanwhile stays theirs and in front while the AI's child is adopted",
  await ownerOf(50) === "default" && tabsById.get(50)?.active === false
    && await ownerOf(60) === null && tabsById.get(60)?.active === true,
  JSON.stringify({ child: tabsById.get(50), personal: tabsById.get(60), updates }),
);
await onCreatedNavigationTarget.emit({ tabId: 60, sourceTabId: 20, sourceFrameId: 0, url: "https://user-created.test/", timeStamp: Date.now() });
await tick();
check("a page the person's tab opens is never adopted", await ownerOf(60) === null);

// A window.open popup from an AI tab moves next to its source; the person's focus comes back.
await chrome.windows.update(1, { focused: true });
windowsById.set(4, { id: 4, focused: true, type: "popup" });
windowsById.get(1).focused = false;
await onWindowCreated.emit({ ...windowsById.get(4) });
await onFocusChanged.emit(4);
tabsById.set(70, { id: 70, groupId: -1, windowId: 4, active: true, openerTabId: 20, url: "https://ai-popup.test/", title: "AI popup" });
await onCreated.emit({ ...tabsById.get(70) });
await onActivated.emit({ tabId: 70, windowId: 4 });
await onCreatedNavigationTarget.emit({ tabId: 70, sourceTabId: 10, sourceFrameId: 0, url: "https://ai-popup.test/", timeStamp: Date.now() });
await tick();
check(
  "an AI popup window's tab moves next to its source, inactive, and the prior window keeps focus",
  await ownerOf(70) === "default" && tabsById.get(70)?.active === false && tabsById.get(70)?.windowId === 1
    && windowsById.get(1)?.focused === true,
  JSON.stringify({ tab: tabsById.get(70), windows: [...windowsById.values()] }),
);

// New AI tabs: inactive, never grouped, next to the work space's other tabs or in the last focused
// normal window; a second work space gets its own tabs in the same way.
const research = await createControlledTab("https://research.test/", "research");
check(
  "a work space's first tab opens inactive at the end of the last focused normal window",
  creations.at(-1)?.properties.active === false && research.windowId === 1 && tabsById.get(research.id)?.groupId === -1
    && await ownerOf(research.id) === "research",
  JSON.stringify(creations.at(-1)),
);
windowsById.set(5, { id: 5, focused: true, type: "normal" });
windowsById.get(1).focused = false;
const second = await createControlledTab("https://research.test/2", "research");
check("its next tab opens beside it, not in the window the person moved to", second.windowId === 1, JSON.stringify(second));
const shopping = await createControlledTab("https://shopping.test/", "shopping");
check(
  "work spaces see only their own tabs",
  shopping.windowId === 5
    && (await listDccbTabs("research")).map(tab => tab.id).join() === `${research.id},${second.id}`
    && (await listDccbTabs("shopping")).map(tab => tab.id).join() === String(shopping.id)
    && !(await isControlledTab(shopping.id, "research")),
);
await onRemoved.emit(shopping.id);
tabsById.delete(shopping.id);
check("a closed tab leaves its work space", (await listDccbTabs("shopping")).length === 0 && await ownerOf(shopping.id) === null);

// With no normal window open (Chrome running in the background), one opens without taking focus.
const savedWindows = new Map(windowsById);
windowsById.clear();
const lonely = await createControlledTab("https://alone.test/", "alone");
check("with no browser window one opens unfocused for the AI tab", createdWindows.at(-1)?.focused === false && await ownerOf(lonely.id) === "alone");
windowsById.clear();
for (const [id, window] of savedWindows) windowsById.set(id, window);

// The popup's card shows the last work space's working tab and brings it forward when pressed.
windowsById.get(1).state = "minimized";
setTargetTab(second.id, "research");
const target = await popupTarget();
const focused = await focusPopupTarget();
check(
  "the popup card's tab is the working tab and pressing it brings that tab forward",
  target?.id === second.id && focused && tabsById.get(second.id)?.active === true
    && windowsById.get(1)?.focused === true && windowUpdates.at(-1)?.changes.state === "normal",
  JSON.stringify({ target, window: windowsById.get(1), last: windowUpdates.at(-1) }),
);
check("listAiTabs lists every AI tab with its work space", (await listAiTabs()).some(entry => entry.tab.id === research.id && entry.workspace === "research"));

// Leaving 1.2.x behind: its idle tab closes, the rest of its group is ungrouped, retired settings go.
const idle = "chrome-extension://test/idle.html";
tabsById.set(80, { id: 80, groupId: 9, windowId: 1, active: false, url: idle, title: "" });
tabsById.set(81, { id: 81, groupId: 9, windowId: 1, active: false, url: "https://left.test/", title: "left" });
tabsById.set(82, { id: 82, groupId: 7, windowId: 1, active: false, url: "https://stored.test/", title: "stored group" });
tabsById.set(83, { id: 83, groupId: 6, windowId: 1, active: false, url: "https://person-group.test/", title: "the person's own group" });
Object.assign(stored, { v8ClientGroups: { key: 7 }, v8DedicatedWindow: true, v8BrowserBridgeHandoff: true });
await migrateFromTabGroups();
check(
  "1.2.x's idle tab closes and its groups are ungrouped; the person's own group stays",
  !tabsById.has(80) && tabsById.get(81)?.groupId === -1 && tabsById.get(82)?.groupId === -1 && tabsById.get(83)?.groupId === 6
    && stored.v8ClientGroups === undefined && stored.v8DedicatedWindow === undefined && stored.v8BrowserBridgeHandoff === undefined,
  JSON.stringify({ ungrouped, removed, stored }),
);
tabsById.set(84, { id: 84, groupId: 9, windowId: 1, active: false, url: idle, title: "" });
await migrateFromTabGroups();
check("going back to 1.2.x and up again is cleaned up as well", !tabsById.has(84) && tabsById.get(83)?.groupId === 6);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`FAILURES: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("ALL TARGET UNIT ASSERTIONS PASSED");
