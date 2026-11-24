/**
 * 6.1.0: the popup's on/off switch and re-connecting (lib/v8-auth.ts). The switch persists (ENABLED_KEY)
 * and init honours it; off keeps the profile and closes the socket without reopening; on reopens with
 * no code. Re-connecting keeps the old profile and socket when the redeem fails, and replaces them
 * only after it succeeds.
 */
const store = new Map();
globalThis.chrome = {
  storage: { local: {
    async get(keys) { return Object.fromEntries((typeof keys === "string" ? [keys] : keys).map(key => [key, store.get(key)])); },
    async set(values) { for (const [key, value] of Object.entries(values)) store.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key); },
  } },
};

let passed = 0;
let failed = 0;
function check(name, value, detail = "") {
  if (value) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

let redeem = (body) => new Response(JSON.stringify({
  ws_endpoint: "wss://door.example/ws", relay_binding: "home:alice:1", browser_id: body.stable_browser_id,
  access_token: "access-1", refresh_token: "refresh-1", token_type: "bearer", expires_in: 7200,
}), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (_url, init) => redeem(JSON.parse(init.body));

async function boot() {
  // A fresh module per boot: the service worker restarts with nothing in memory but chrome.storage.
  const auth = await import(`../entrypoints/lib/v8-auth.ts?boot=${boot.n = (boot.n ?? 0) + 1}`);
  const events = [];
  await auth.init({ openSocket() { events.push("open"); }, closeSocket() { events.push("close"); }, onChange(snapshot) { events.push(snapshot.state); } });
  return { auth, events };
}

let { auth, events } = await boot();
await auth.setup("https://door.example", "ABCD-EFGH");
const profileBefore = JSON.stringify(store.get("v8BrowserBridgeProfile"));
check("connects after a first setup", auth.snapshot().state === "connecting" && events.includes("open"));

events.length = 0;
await auth.setEnabled(false);
check("off: state off, socket closed, no reopen", auth.snapshot().state === "off" && events.includes("close") && !events.includes("open"), JSON.stringify(events));
check("off: the profile is kept and the flag is stored", JSON.stringify(store.get("v8BrowserBridgeProfile")) === profileBefore && store.get("v8BrowserBridgeEnabled") === false);
check("off: isEnabled is false", auth.isEnabled() === false && auth.snapshot().enabled === false);

({ auth, events } = await boot());
check("init honours the stored off flag after a restart: off, nothing opened", auth.snapshot().state === "off" && !events.includes("open") && store.get("v8BrowserBridgeEnabled") === false, JSON.stringify(events));

await auth.setEnabled(true);
check("on: reconnects with the stored profile, no code", auth.snapshot().state === "connecting" && events.includes("open") && store.get("v8BrowserBridgeEnabled") === true);
({ auth, events } = await boot());
check("init with the flag on connects", auth.snapshot().state === "connecting" && events.includes("open"));

// Re-connecting.
let attempts = 0;
redeem = () => { attempts++; return new Response(JSON.stringify({ error: "unknown_code" }), { status: 404, headers: { "content-type": "application/json" } }); };
events.length = 0;
await auth.setup("https://new.example", "ZZZZ-9999", true);
check("re-connect with a bad code: reason shown, state and profile unchanged, socket untouched",
  attempts === 1 && /코드가 맞지 않거나/.test(auth.snapshot().error ?? "") && auth.snapshot().state === "connecting"
  && auth.snapshot().address === "https://door.example" && JSON.stringify(store.get("v8BrowserBridgeProfile")) === profileBefore
  && !events.includes("close") && !events.includes("open"), JSON.stringify({ events, snapshot: auth.snapshot() }));

redeem = () => { throw new TypeError("offline"); };
const realLog = console.log; console.log = () => {};
const wait = globalThis.setTimeout; globalThis.setTimeout = (fn) => wait(fn, 0);
await auth.setup("https://new.example", "ZZZZ-9999", true);
globalThis.setTimeout = wait; console.log = realLog;
check("re-connect when the address is unreachable: old connection stands", /주소에 연결할 수 없습니다/.test(auth.snapshot().error ?? "")
  && auth.snapshot().address === "https://door.example" && JSON.stringify(store.get("v8BrowserBridgeProfile")) === profileBefore);

redeem = (body) => new Response(JSON.stringify({
  ws_endpoint: "wss://new.example/ws", relay_binding: "home:alice:2", browser_id: body.stable_browser_id,
  access_token: "access-2", refresh_token: "refresh-2", token_type: "bearer", expires_in: 7200,
}), { status: 200, headers: { "content-type": "application/json" } });
events.length = 0;
await auth.setup("https://new.example", "ZZZZ-9999", true);
const stored = store.get("v8BrowserBridgeProfile");
check("re-connect with a good code: profile replaced, old socket closed, new one opened",
  stored.addressOrigin === "https://new.example" && stored.accessToken === "access-2" && auth.snapshot().error === null
  && events.indexOf("close") !== -1 && events.indexOf("open") > events.indexOf("close"), JSON.stringify({ events, stored }));

// A new code also switches a Chrome that was off back on.
await auth.setEnabled(false);
await auth.setup("https://new.example", "ZZZZ-9999", true);
check("re-connect from the off state switches it on", store.get("v8BrowserBridgeEnabled") === true && auth.snapshot().state === "connecting");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0); // the token-refresh timer would keep the process alive
