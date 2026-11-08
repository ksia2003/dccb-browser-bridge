/** V8 extension setup storage ignores v6 keys and requires explicit setup on a changed relay binding. */
const store = new Map([
  ["relayHost", "wrong-v6-host.example"],
  ["connectionMode", "wss"],
  ["accessToken", "old-v6-token"],
]);
const listeners = [];
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: store.get(keys) };
        return Object.fromEntries(keys.map((key) => [key, store.get(key)]));
      },
      async set(values) { for (const [key, value] of Object.entries(values)) store.set(key, value); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key); },
    },
  },
};

const auth = await import("../entrypoints/lib/v8-auth.ts");
const events = [];
await auth.init({ openSocket() { events.push("open"); }, closeSocket() { events.push("close"); }, onChange(snapshot) { events.push(snapshot.state); } });

let passed = 0;
let failed = 0;
function check(name, value, detail = "") {
  if (value) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

check("does not read or migrate v6 relay/token storage", auth.snapshot().state === "setup" && !events.includes("open"), JSON.stringify({ store: [...store], events }));

const fetches = [];
globalThis.fetch = async (url, init) => {
  fetches.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({
    ws_endpoint: "wss://door.example/ws",
    relay_binding: "home:alice:1",
    browser_id: fetches[0].body.stable_browser_id,
    access_token: "access", refresh_token: "refresh", token_type: "bearer", expires_in: 7200,
  }), { status: 200, headers: { "content-type": "application/json" } });
};
await auth.setup("https://door.example/anything", "ABCD-EFGH");
check("redeems exactly the pasted address and code without an AI approval round", fetches.length === 1
  && fetches[0].url === "https://door.example/api/enroll/redeem"
  && fetches[0].body.setup_code === "ABCDEFGH"
  && auth.wsUrl()?.startsWith("wss://door.example/ws?id="), JSON.stringify({ fetches, state: auth.snapshot() }));

await auth.onRelayBinding("home:another-person:9");
check("binding mismatch clears only V8 profile and requires explicit setup", auth.snapshot().state === "address_error"
  && !store.has("v8BrowserBridgeProfile")
  && store.get("relayHost") === "wrong-v6-host.example", JSON.stringify({ store: [...store], state: auth.snapshot() }));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
