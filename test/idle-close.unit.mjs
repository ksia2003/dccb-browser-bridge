/**
 * lib/pipe.ts (6.0.0): a work space's AI tabs close when its engine leaves, or IDLE_CLOSE_MS after
 * the relay socket dropped and no engine came back; tabs of a work space with an engine, and the
 * person's tabs, stay.
 */
import assert from "node:assert/strict";

const listeners = () => ({ addListener() {}, removeListener() {} });
const tabs = new Map([
  [1, { id: 1, windowId: 1, url: "https://ai.test/" }],
  [2, { id: 2, windowId: 1, url: "https://busy.test/" }],
  [3, { id: 3, windowId: 1, url: "https://person.test/" }],
]);
const session = { v8TabWorkspaces: { 1: "default", 2: "busy" } };
const removed = [];
const sent = [];
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://test${path}` },
  tabs: {
    onRemoved: listeners(), onCreated: listeners(),
    async query() { return [...tabs.values()].map(tab => ({ ...tab })); },
    async get(id) { if (!tabs.has(id)) throw new Error("no tab"); return { ...tabs.get(id) }; },
    async remove(ids) { for (const id of [ids].flat()) { removed.push(id); tabs.delete(id); } },
    async create(props) { const id = Math.max(...tabs.keys()) + 1; tabs.set(id, { id, windowId: props.windowId ?? 1, url: props.url }); return { ...tabs.get(id) }; },
  },
  windows: { async getLastFocused() { return { id: 1, type: "normal" }; } },
  debugger: { onEvent: listeners(), onDetach: listeners() },
  storage: {
    session: { async get(key) { return key in session ? { [key]: structuredClone(session[key]) } : {}; }, async set(values) { Object.assign(session, structuredClone(values)); } },
    local: { async get() { return {}; }, async set() {} },
  },
};

const { closeAllPipes, closeIdleAiTabs, closePipe, installPipe, openPipe, IDLE_CLOSE_MS } = await import("../entrypoints/lib/pipe.ts");
const { createControlledTab } = await import("../entrypoints/lib/target.ts");
installPipe(frame => sent.push(frame), () => {}, () => null);

// An engine that leaves takes its work space's tabs with it.
await openPipe("c-done", "done");
const doneTab = [...tabs.values()].find(tab => session.v8TabWorkspaces[tab.id] === "done");
assert.ok(doneTab, "an engine with no tab gets one background tab");
closePipe("c-done");
await new Promise(resolve => setTimeout(resolve, 20));
assert.ok(!tabs.has(doneTab.id), "the work space's tab closes when its engine leaves");
console.log("  PASS  an engine that leaves closes its work space's tabs");

// "busy" has an engine; "default" lost its relay socket at t0 (its tabs wait for the engine to return).
await openPipe("c-busy", "busy");
await openPipe("c-default", "default");
closeAllPipes();
await openPipe("c-busy", "busy");
await new Promise(resolve => setTimeout(resolve, 0));
const t0 = session.v8WorkspaceLastUse.default;
assert.ok(typeof t0 === "number" && tabs.has(1), "a dropped socket keeps the tabs and starts the clock");

assert.deepEqual(await closeIdleAiTabs(t0 + IDLE_CLOSE_MS - 1), [], "nothing closes before the period ends");
assert.deepEqual(await closeIdleAiTabs(t0 + IDLE_CLOSE_MS), [1], "the idle work space's tab closes");
assert.ok(tabs.has(2) && tabs.has(3), "a work space with an engine and the person's tab stay");
console.log("  PASS  after a dropped socket the tabs wait 10 minutes for their engine; busy work spaces and the person's tabs stay");

// A tab whose clock was lost (service worker restart) waits a full period from when it is first seen.
const orphan = await createControlledTab("https://orphan.test/", "orphan");
delete session.v8WorkspaceLastUse.orphan;
const seen = Date.now();
assert.deepEqual(await closeIdleAiTabs(seen), [], "an AI tab without a clock is not closed at once");
assert.deepEqual(await closeIdleAiTabs(seen + IDLE_CLOSE_MS), [orphan.id], "it closes a full period later");
console.log("  PASS  an AI tab whose clock was lost gets a full period");
