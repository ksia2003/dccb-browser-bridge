/**
 * lib/pipe.ts + lib/target.ts (6.0.0, owner 11-08): nothing disappears on its own. An engine that
 * leaves keeps its tabs (and lets go of the debugger, so Chrome's debugging bar goes away); `close`
 * closes only the tabs the person never looked at; a tab they looked at becomes theirs. AI tabs are
 * muted until the person looks at them.
 */
import assert from "node:assert/strict";

const listeners = () => { const items = []; return { addListener(fn) { items.push(fn); }, removeListener() {}, emit: (...args) => Promise.all(items.map(fn => fn(...args))) }; };
const tabs = new Map([[3, { id: 3, windowId: 1, active: true, url: "https://person.test/" }]]);
const session = {};
const detached = [];
const onActivated = listeners();
const onRemoved = listeners();
const debuggerDetach = listeners();
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://test${path}`, lastError: undefined },
  tabs: {
    onRemoved, onCreated: listeners(), onActivated,
    async query() { return [...tabs.values()].map(tab => ({ ...tab })); },
    async get(id) { if (!tabs.has(id)) throw new Error("no tab"); return { ...tabs.get(id), mutedInfo: { muted: Boolean(tabs.get(id).muted) } }; },
    async remove(ids) { for (const id of [ids].flat()) { tabs.delete(id); await onRemoved.emit(id); } },
    async update(id, changes) { Object.assign(tabs.get(id), changes); return { ...tabs.get(id) }; },
    async create(props) { const id = Math.max(...tabs.keys()) + 1; tabs.set(id, { id, windowId: props.windowId ?? 1, active: false, url: props.url }); return { ...tabs.get(id) }; },
  },
  windows: { async getLastFocused() { return { id: 1, type: "normal" }; } },
  debugger: {
    onEvent: listeners(), onDetach: debuggerDetach,
    attach(_target, _version, callback) { callback(); },
    detach(target, callback) { detached.push(target.tabId); callback(); },
    sendCommand(_target, _method, _params, callback) { callback({}); },
    getTargets(callback) { callback([]); },
  },
  storage: {
    session: { async get(key) { return key in session ? { [key]: structuredClone(session[key]) } : {}; }, async set(values) { Object.assign(session, structuredClone(values)); } },
    local: { async get() { return {}; }, async set() {} },
  },
};

const pipe = await import("../entrypoints/lib/pipe.ts");
const target = await import("../entrypoints/lib/target.ts");
pipe.installPipe(() => {}, () => {}, () => null);
target.installSeenWatch();
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

await pipe.openPipe("c1", "default");
const [first] = await target.listDccbTabs("default");
assert.ok(first && tabs.get(first.id).muted === true, "a new AI tab opens muted");
await pipe.handlePipeCommand({ type: "pipe_command", channel: "c1", id: 1, method: "chrome.debugger.attach", params: [{ tabId: first.id }] });
pipe.closePipe("c1");
await tick(10);
assert.ok(tabs.has(first.id), "an engine that leaves keeps its tab");
assert.ok(detached.includes(first.id), "and lets go of the debugger, so Chrome's debugging bar goes away");
console.log("  PASS  an engine that leaves keeps its muted tab and detaches the debugger");

await pipe.openPipe("c2", "default");
assert.deepEqual((await target.listDccbTabs("default")).map(tab => tab.id), [first.id], "the next engine gets the same tab back");
const second = await target.createControlledTab("https://result.test/", "default");
// The person looks at the second tab (it stays in front for a moment): it is seen and unmuted.
tabs.get(second.id).active = true;
await onActivated.emit({ tabId: second.id, windowId: 1 });
await tick(1700);
assert.equal(await target.wasSeen(second.id), true);
assert.equal(tabs.get(second.id).muted, false, "looking at an AI tab turns its sound on");
tabs.get(second.id).active = false;
assert.deepEqual(await pipe.closeWorkspaceTabs("default"), [first.id], "close closes only the tab the person never looked at");
assert.ok(tabs.has(second.id) && await target.ownerOf(second.id) === null, "the tab the person looked at stays and becomes theirs");
console.log("  PASS  close closes the unseen tab; the one the person looked at stays theirs");

// A moment in front that Chrome takes back at once (a page an AI tab opened) is not looking.
const blink = await target.createControlledTab("https://popup.test/", "other");
tabs.get(blink.id).active = true;
await onActivated.emit({ tabId: blink.id, windowId: 1 });
tabs.get(blink.id).active = false;
await tick(1700);
assert.equal(await target.wasSeen(blink.id), false);
console.log("  PASS  a tab Chrome shows for an instant is not counted as looked at");

// The person closes the work space's last AI tab: no new one opens until the AI finishes with close.
await pipe.openPipe("c3", "mine");
const [mine] = await target.listDccbTabs("mine");
await chrome.tabs.remove(mine.id);
await tick(10);
assert.equal(await target.closedByPerson("mine"), true);
const refused = [];
await pipe.handlePipeCommand({ type: "pipe_command", channel: "c3", id: 9, method: "chrome.tabs.create", params: [{ url: "https://again.test/" }] });
pipe.installPipe(frame => refused.push(frame), () => {}, () => null);
await pipe.handlePipeCommand({ type: "pipe_command", channel: "c3", id: 10, method: "chrome.tabs.create", params: [{ url: "https://again.test/" }] });
assert.match(refused.at(-1)?.error ?? "", /the person closed the AI's tab/);
await pipe.closeWorkspaceTabs("mine");
assert.equal(await target.closedByPerson("mine"), false, "close (the AI finishing) lifts it");
// Tabs the bridge closes on the AI's behalf do not count as the person closing them.
await pipe.openPipe("c4", "theirs");
const [theirs] = await target.listDccbTabs("theirs");
await pipe.handlePipeCommand({ type: "pipe_command", channel: "c4", id: 11, method: "chrome.tabs.remove", params: [theirs.id] });
await tick(10);
assert.equal(await target.closedByPerson("theirs"), false);
console.log("  PASS  the person closing the AI's last tab stops new tabs until the AI finishes; the AI's own closes do not");

// Cancel on Chrome's debugging bar: the work space stops; the engine cannot quietly re-attach.
const frames = [];
pipe.installPipe(frame => frames.push(frame), () => {}, () => null);
await pipe.openPipe("c5", "cancel");
const [cancelTab] = await target.listDccbTabs("cancel");
await pipe.handlePipeCommand({ type: "pipe_command", channel: "c5", id: 20, method: "chrome.debugger.attach", params: [{ tabId: cancelTab.id }] });
await debuggerDetach.emit({ tabId: cancelTab.id }, "canceled_by_user");
await tick(10);
assert.equal(await target.stoppedByPerson("cancel"), "cancelled");
await pipe.handlePipeCommand({ type: "pipe_command", channel: "c5", id: 21, method: "chrome.debugger.attach", params: [{ tabId: cancelTab.id }] });
assert.match(frames.at(-1)?.error ?? "", /pressed Cancel on Chrome's debugging bar/);
await pipe.closeWorkspaceTabs("cancel");
assert.equal(await target.stoppedByPerson("cancel"), null, "close lifts it");
console.log("  PASS  Cancel on the debugging bar stops the work space until the AI finishes with close");
