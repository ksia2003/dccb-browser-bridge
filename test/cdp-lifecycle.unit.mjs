import assert from "node:assert/strict";

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

const onTabRemoved = event();
const onDebuggerDetach = event();
const onDebuggerEvent = event();
const commands = [];
const attachedTargets = new Set();
const attachCalls = [];
const detachCalls = [];
let lastError;
let holdEmulation;
let failEmulation = false;
let busyTarget = false;
let failAttach = false;
globalThis.chrome = {
  runtime: { get lastError() { return lastError; } },
  tabs: { onRemoved: onTabRemoved, async get(id) { return { id, active: true }; }, async update() {} },
  debugger: {
    onDetach: onDebuggerDetach,
    onEvent: onDebuggerEvent,
    getTargets(callback) {
      callback(busyTarget
        ? [{ tabId: 324, attached: true }]
        : [...attachedTargets].map(tabId => ({ tabId, attached: true })));
    },
    attach({ tabId }, _version, callback) {
      attachCalls.push(tabId);
      if (failAttach) {
        lastError = { message: "another debugger is already attached" };
        callback();
        lastError = undefined;
        return;
      }
      attachedTargets.add(tabId);
      callback();
    },
    detach({ tabId }, callback) {
      detachCalls.push(tabId);
      attachedTargets.delete(tabId);
      onDebuggerDetach.emit({ tabId }, "target_closed");
      callback();
    },
    sendCommand({ tabId }, method, params, callback) {
      commands.push({ tabId, method, params });
      if (method === "Emulation.setFocusEmulationEnabled" && holdEmulation) {
        holdEmulation(callback);
        return;
      }
      if (method === "Emulation.setFocusEmulationEnabled" && failEmulation) {
        lastError = { message: "emulation rejected" };
        callback({});
        lastError = undefined;
        return;
      }
      callback(method === "Runtime.evaluate"
        ? { result: { value: { revision: 1, capturedRevision: 0 } } }
        : {});
    },
  },
};

const cdp = await import("../entrypoints/lib/cdp.ts");
const tabId = 321;
let cleanupHookCalls = 0;
cdp.onDetach(id => {
  if (id === tabId) cleanupHookCalls++;
});
cdp.installDetachListener();
// Focus emulation must be configured before the attachment is published, and
// must be applied again after a fresh detach/reattach.
await cdp.attach(tabId);
assert.equal(commands[0]?.method, "Emulation.setFocusEmulationEnabled",
  "focus emulation is the first CDP command on a fresh attachment");
assert.deepEqual(commands[0]?.params, { enabled: true });
assert.equal(cdp.isAttached(tabId), true, "the attachment is published once focus emulation is set");
await cdp.attach(tabId);
assert.equal(commands.filter(item => item.method === "Emulation.setFocusEmulationEnabled").length, 1,
  "idempotent attach does not reconfigure focus emulation");

// 1.0.8 dropped the surface-frame observer (screenshots draw, then capture),
// so detach only has to clear attachment state and run cleanup hooks.
await cdp.detach(tabId);
assert.equal(cdp.isAttached(tabId), false);
assert.ok(cleanupHookCalls >= 1, "screenshot baseline detach hook must run");
await cdp.attach(tabId);
assert.equal(commands.filter(item => item.method === "Emulation.setFocusEmulationEnabled").length, 2,
  "fresh reattach restores focus emulation");

const cleanupBeforeRemoval = cleanupHookCalls;
onTabRemoved.emit(tabId);
assert.ok(cleanupHookCalls > cleanupBeforeRemoval, "tab removal must also run cleanup hooks");

// A failed setting must roll back only the attachment this call created.
failEmulation = true;
const detachCountBeforeFailure = detachCalls.length;
await assert.rejects(cdp.attach(322), /debugger attach failed.*emulation rejected/);
assert.equal(cdp.isAttached(322), false);
assert.equal(attachedTargets.has(322), false, "failed emulation rolls back raw attachment");
assert.equal(detachCalls.length, detachCountBeforeFailure + 1);
failEmulation = false;

// Turning off while setup is pending must drain raw attach even if CDP never
// returns the emulation callback; a later on transition cannot publish it.
let finishEmulation;
holdEmulation = callback => { finishEmulation = callback; };
const raceAttach = cdp.attach(323);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(cdp.isAttached(323), false, "pending setup is not published as attached");
await cdp.setExecutionEnabled(false);
assert.equal(cdp.isAttached(323), false, "off resolves only after pending attachment is cleared");
assert.equal(attachedTargets.has(323), false, "off drains raw attachment while emulation callback is withheld");
assert.ok(detachCalls.includes(323));
await cdp.setExecutionEnabled(true);
finishEmulation({});
await assert.rejects(raceAttach, /Browser Bridge is off/);
assert.equal(cdp.isAttached(323), false);
assert.equal(attachedTargets.has(323), false, "bridge-off race rolls back raw attachment");
holdEmulation = undefined;

// Simultaneous same-tab sends share one pending attach; neither is misread as
// a second debugger owner while the first focus-emulation command is pending.
const attachCountBeforeConcurrent = attachCalls.filter(id => id === 326).length;
holdEmulation = callback => { finishEmulation = callback; };
const firstSend = cdp.send(326, "Page.enable");
const secondSend = cdp.send(326, "Runtime.enable");
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(attachCalls.filter(id => id === 326).length - attachCountBeforeConcurrent, 1,
  "concurrent sends perform one raw attach");
assert.equal(cdp.isAttached(326), false, "concurrent sends wait for shared setup");
finishEmulation({});
await Promise.all([firstSend, secondSend]);
assert.equal(cdp.isAttached(326), true);
assert.equal(commands.filter(item => item.tabId === 326 && ["Page.enable", "Runtime.enable"].includes(item.method)).length, 2,
  "both original commands run after the shared emulation setup");
await cdp.detach(326);
holdEmulation = undefined;

// Explicit detach also cancels and drains an unpublished fresh attachment.
holdEmulation = callback => { finishEmulation = callback; };
const pendingDetachAttach = cdp.attach(327);
await new Promise(resolve => setTimeout(resolve, 0));
await cdp.detach(327);
assert.equal(attachedTargets.has(327), false, "detach drains raw pending attachment");
assert.equal(cdp.isAttached(327), false);
finishEmulation({});
await assert.rejects(pendingDetachAttach, /Browser Bridge is off/);
holdEmulation = undefined;

// Preflight and raw attach failures are owned by someone else; do not detach.
const detachCountBeforeBusy = detachCalls.length;
busyTarget = true;
await assert.rejects(cdp.attach(324), /target already has a debugger client/);
busyTarget = false;
assert.equal(detachCalls.length, detachCountBeforeBusy, "preflight busy failure never detaches another owner");
failAttach = true;
await assert.rejects(cdp.attach(325), /already attached/);
failAttach = false;
assert.equal(detachCalls.length, detachCountBeforeBusy, "raw attach failure never detaches another owner");

console.log("  PASS  focus emulation before attach, detach and tab removal clear attachment state and run cleanup hooks");
