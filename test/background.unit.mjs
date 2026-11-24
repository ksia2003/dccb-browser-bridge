/**
 * 6.0.2 service-worker behaviour (entrypoints/background.ts) with a fake Chrome, a fake WebSocket and a
 * virtual clock: frames of an abandoned socket never reach its successor, no work is taken before the
 * relay is bound, a stalled handshake and a dead socket are dropped (but a pause only probes), a rename
 * made during the handshake is sent after binding, the off-notice survives a socket that never bound, and
 * switching off counts the AI's tabs only after in-flight work settled.
 */
// --- virtual clock -----------------------------------------------------------------------------
const real = { setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now };
let clock = 1_800_000_000_000;
let nextTimer = 1;
const timers = new Map();
Date.now = () => clock;
let mono = 0; // monotonic clock: moves with time, but not with a pause (a sleeping PC)
performance.now = () => mono;
globalThis.setTimeout = (fn, ms = 0) => { const id = nextTimer++; timers.set(id, { at: clock + ms, fn, every: null }); return id; };
globalThis.setInterval = (fn, ms = 0) => { const id = nextTimer++; timers.set(id, { at: clock + ms, fn, every: ms }); return id; };
globalThis.clearTimeout = globalThis.clearInterval = (id) => { timers.delete(id); };
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => real.setTimeout(resolve, 0)); };
/** Run every timer that is due now, once (an interval that was starved runs once, as after a pause). */
async function runDue() {
  for (const [id, timer] of [...timers]) {
    if (!timers.has(id) || timer.at > clock) continue;
    if (timer.every !== null) timer.at = clock + timer.every; else timers.delete(id);
    timer.fn();
    await flush();
  }
}
/** Move time forward step by step, running timers as they fall due. */
async function advance(ms, step = 1000) {
  for (let spent = 0; spent < ms; spent += step) { const d = Math.min(step, ms - spent); clock += d; mono += d; await runDue(); }
}
/** A pause: the wall clock moves (the PC slept), the monotonic clock and the timers do not. */
const pause = (ms) => { clock += ms; };

// --- fake chrome ---------------------------------------------------------------------------------
const local = new Map();
const session = new Map();
const area = (map) => ({
  async get(keys) { const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : [...map.keys()]; return Object.fromEntries(list.map(key => [key, map.get(key)])); },
  async set(values) { for (const [key, value] of Object.entries(values)) map.set(key, value); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key); },
});
const stub = () => new Proxy(function () {}, { get: (_t, key) => key === "then" ? undefined : stub(), apply: () => Promise.resolve(undefined) });
let tabs = [];
const tabCalls = { query: 0, removed: [] };
let onMessage;
let onAlarm;
let onNavigationTarget;
const withStub = (object) => new Proxy(object, { get: (target, key) => key in target ? target[key] : stub() });
globalThis.chrome = new Proxy(Object.fromEntries(Object.entries({
  storage: { local: area(local), session: area(session), onChanged: stub() },
  runtime: { getManifest: () => ({ version: "6.0.2" }), getURL: (p) => p, onMessage: { addListener(fn) { onMessage = fn; } }, onInstalled: stub(), sendMessage: () => Promise.resolve() },
  alarms: { create() {}, onAlarm: { addListener(fn) { onAlarm = fn; } } },
  tabs: { async query() { tabCalls.query++; return tabs; }, async remove(ids) { tabCalls.removed.push(...ids); tabs = tabs.filter(tab => !ids.includes(tab.id)); }, onRemoved: stub(), onUpdated: stub(), onCreated: stub(), onActivated: stub(), onAttached: stub(), onDetached: stub() },
  tabGroups: { async query() { return []; }, onRemoved: stub() },
  permissions: { async contains() { return true; } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  webNavigation: { onCreatedNavigationTarget: { addListener(fn) { onNavigationTarget = fn; } } },
}).map(([name, value]) => [name, withStub(value)])), { get: (target, key) => key in target ? target[key] : stub() });

// --- fake WebSocket ------------------------------------------------------------------------------
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; this.handlers = {}; this.closedWith = undefined; FakeWebSocket.instances.push(this); }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code) { this.closedWith ??= code ?? 1000; this.readyState = 2; }
  emit(type, event = {}) { for (const fn of this.handlers[type] ?? []) fn(event); }
  open() { this.readyState = 1; this.emit("open"); }
  receive(message) { this.emit("message", { data: JSON.stringify(message) }); }
  framesOf(type) { return this.sent.filter(frame => frame.type === type); }
}
globalThis.WebSocket = FakeWebSocket;
const live = () => FakeWebSocket.instances.filter(socket => socket.closedWith === undefined);
const last = () => FakeWebSocket.instances.at(-1);

// --- a profile as an enrolment leaves it, and a relay that answers refreshes ------------------
const profile = (overrides = {}) => ({ schemaVersion: 8, addressOrigin: "https://door.example", wsEndpoint: "wss://door.example/ws", relayBinding: "home:alice:1",
  browserId: "b".repeat(32), accessToken: "access-1", refreshToken: "refresh-1", tokenExpiresAt: clock + 7_200_000, ...overrides });
let refreshFetches = 0;
let refreshAnswer = () => new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", token_type: "bearer", expires_in: 7200 }), { status: 200 });
globalThis.fetch = async () => { refreshFetches++; return refreshAnswer(); };

let passed = 0;
let failed = 0;
function check(name, value, detail = "") {
  if (value) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const binding = { type: "relay_binding", relay_binding: "home:alice:1", browser_id: "x", switched_off_notice: true };
const popup = (request) => new Promise(resolve => { onMessage(request, {}, resolve); });

// --- boot ----------------------------------------------------------------------------------------
local.set("v8BrowserBridgeProfile", profile());
local.set("v8BrowserBridgeName", "Old name");
session.set("v8TabWorkspaces", { 5: "default" }); // tab 5 is the AI's, once it exists
globalThis.defineBackground = (main) => main;
const { default: main } = await import("../entrypoints/background.ts");
const { register } = await import("../entrypoints/lib/registry.ts");
const realLog = console.log;
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[bb")) return; realLog(...args); };
main();
await flush();

// 1. A socket opens with the bearer; nothing is accepted before the relay is bound.
let first = last();
check("boot opens a socket with the stored bearer", FakeWebSocket.instances.length === 1 && first.protocols[0] === "bb-bearer.access-1", JSON.stringify(first?.protocols));
first.open();
first.receive({ type: "tool_request", id: "t0", tool: "extension", args: {} });
await flush();
check("a tool request before the relay is bound is refused, not run", first.framesOf("tool_response").length === 1 && /not connected/.test(first.framesOf("tool_response")[0].error));

// 2. A rename during the handshake is sent once, right after binding.
await popup({ type: "setDeviceName", name: "New name" });
check("a rename before binding sends nothing yet", first.framesOf("extension_rename").length === 0);
first.receive(binding);
await flush();
check("after binding the current name is sent, once", first.framesOf("extension_rename").length === 1 && first.framesOf("extension_rename")[0].name === "New name", JSON.stringify(first.sent));
await popup({ type: "setDeviceName", name: "Newer name" });
check("a rename on a bound socket goes out at once", first.framesOf("extension_rename").length === 2 && first.framesOf("extension_rename")[1].name === "Newer name");

// 3. Frames of an abandoned socket do not reach its successor.
let release;
register("slow", () => new Promise(resolve => { release = resolve; }));
first.receive({ type: "tool_request", id: "t1", tool: "slow", args: {} });
await flush();
first.emit("close", { code: 1006, reason: "" });
await flush();
await advance(1500); // backoff 1 s
const second = last();
check("a dropped socket is replaced by a new one", second !== first && second.protocols[0] === "bb-bearer.access-1");
second.open();
second.receive(binding);
await flush();
first.receive({ type: "tool_request", id: "ghost", tool: "extension", args: {} });
release("late answer");
await flush();
check("frames from the abandoned socket and answers to its requests never reach the new one",
  second.framesOf("tool_response").length === 0, JSON.stringify(second.sent));

// 4. Heartbeat: a dead socket is dropped; a pause only probes.
const pings = () => second.framesOf("ping").length;
await advance(20_000, 1000);
check("a ping goes out every 20 s", pings() >= 1);
second.receive({ type: "pong" });
const before = FakeWebSocket.instances.length;
pause(5 * 60_000); // the PC slept
await runDue();
check("after a long pause the socket is probed, not dropped", second.closedWith === undefined && pings() >= 2);
second.receive({ type: "pong" }); // the relay answers the probe
await advance(20_000, 1000);
check("an answered probe keeps the connection", second.closedWith === undefined);
pause(5 * 60_000);
await runDue(); // probe out
await advance(20_000, 1000); // nothing came back
check("an unanswered probe drops the socket and reconnects", second.closedWith !== undefined && FakeWebSocket.instances.length === before, "closedWith=" + second.closedWith);
await advance(2000);
const third = last();
check("... a new socket follows", third !== second && third.readyState === 0);

// 5. Handshake deadlines: no upgrade, then no relay_binding.
await advance(16_000);
check("a socket that never opens is dropped at the deadline", third.closedWith !== undefined);
await advance(3000);
const fourth = last();
fourth.open();
await advance(16_000);
check("a socket that opens but is never bound is dropped at the deadline", fourth.closedWith !== undefined);
await advance(5000);
const fifth = last();
fifth.open();
fifth.receive(binding);
await flush();

// 6. Alarm recovery with a socket that looks open but a token that cannot be refreshed.
pause(2 * 3600_000 + 60_000); // the access token has run out while the socket stayed open
refreshAnswer = () => new Response("not json", { status: 200 });
const fetchesBefore = refreshFetches;
onAlarm({ name: "bb-reconnect" });
await flush();
check("the alarm retries the refresh even though the socket is open; garbled JSON is a retry, not a wipe",
  refreshFetches > fetchesBefore && (await popup({ type: "getState" })).state !== "setup", `fetches ${fetchesBefore}→${refreshFetches}`);
refreshAnswer = () => new Response(JSON.stringify({ access_token: "access-3", refresh_token: "refresh-3", token_type: "bearer", expires_in: 7200 }), { status: 200 });
await advance(31_000);
check("... and the next attempt succeeds and stores the new login", local.get("v8BrowserBridgeProfile")?.refreshToken === "refresh-3");

// 7. Switching off with no bound socket: the notice is kept, and only the relay's ack clears it.
const sixth = live().at(-1) ?? fifth;
sixth.emit("close", { code: 1006, reason: "" });
await flush();
await advance(2000);
const hanging = last();
hanging.open(); // opened, relay has not said anything yet
await popup({ type: "setEnabled", enabled: false });
await flush();
check("the off-notice is kept when no bound socket can carry it", local.get("v8BrowserBridgeOffNoticePending") === true && hanging.framesOf("extension_switched_off").length === 0);
await advance(1000);
const notice = last();
check("a notice-only connection (?notice=1) is opened while switched off", notice !== hanging && new URL(notice.url).searchParams.get("notice") === "1" && notice.protocols[0]?.startsWith("bb-bearer."));
notice.open();
notice.receive({ type: "tool_request", id: "off1", tool: "extension", args: {} });
await advance(500);
check("the notice connection carries the notice and takes no work", notice.framesOf("extension_switched_off").length === 1 && notice.framesOf("tool_response").length === 0);
check("the stored notice stays until the relay acknowledges it", local.get("v8BrowserBridgeOffNoticePending") === true);
notice.emit("close", { code: 1006, reason: "" }); // the connection died before an ack
await advance(1000);
local.set("v8BrowserBridgeOffNoticePending", true);
onAlarm({ name: "bb-reconnect" }); // the alarm retries
await advance(1000);
const retry = last();
check("an unacknowledged notice is retried", retry !== notice && new URL(retry.url).searchParams.get("notice") === "1");
retry.open();
retry.receive({ type: "switched_off_ack", applied: true });
await advance(500);
check("the relay's acknowledgement clears the stored notice", local.get("v8BrowserBridgeOffNoticePending") === undefined);
const socketsAfterOff = FakeWebSocket.instances.length;
await advance(90_000);
check("and nothing reconnects while it is off", FakeWebSocket.instances.length === socketsAfterOff);

// 8. Switching off: work that may open tabs is aborted or awaited, and a child adopted meanwhile is closed.
await popup({ type: "setEnabled", enabled: true });
await advance(2000);
const seventh = last();
seventh.open();
seventh.receive(binding);
await flush();
tabs = [{ id: 5, windowId: 1, url: "https://example.com", title: "x" }];
let finishTool;
register("opens-tab", () => new Promise(resolve => { finishTool = resolve; }));
seventh.receive({ type: "tool_request", id: "w1", tool: "opens-tab", args: {} });
// A fetch whose response body never ends must not hold the shutdown.
const realFetch = globalThis.fetch;
globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
seventh.receive({ type: "tool_request", id: "w2", tool: "fetch", args: { url: "https://stalled.example/" } });
await flush();
const off = popup({ type: "setEnabled", enabled: false });
await flush();
check("no tab is closed while work that may open one is still running", tabCalls.removed.length === 0);
// A child page opened by the AI's tab is confirmed while the shutdown is under way.
onNavigationTarget({ tabId: 6, sourceTabId: 5, sourceFrameId: 0, url: "https://child.example/", timeStamp: 1 });
await flush();
finishTool("done");
await off;
await flush();
check("the stalled fetch was aborted, so the shutdown finished without waiting out its drain timer", tabCalls.removed.includes(5));
check("a child tab confirmed during the shutdown is closed too", tabCalls.removed.includes(6), JSON.stringify(tabCalls.removed));
globalThis.fetch = realFetch;

console.log = realLog;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
