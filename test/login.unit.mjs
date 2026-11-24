/**
 * 6.0.2 login handling in the extension (lib/v8-auth.ts): the rotated refresh token is stored, a stale
 * access token is refreshed before a socket opens (one shared request), a login that ended keeps the
 * address and has its own state, renaming applies over the open socket without reconnecting, reset
 * forgets everything, and the retry reason reaches the snapshot.
 */
const store = new Map();
/** Ordered record of what happened: "refresh" (request out), "persist" (profile written), "open" (socket). */
const trace = [];
globalThis.chrome = {
  storage: { local: {
    async get(keys) { return Object.fromEntries((typeof keys === "string" ? [keys] : keys).map(key => [key, store.get(key)])); },
    async set(values) { if ("v8BrowserBridgeProfile" in values) trace.push("persist"); for (const [key, value] of Object.entries(values)) store.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key); },
  } },
};
let passed = 0;
let failed = 0;
function check(name, value, detail = "") {
  if (value) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

let refreshCalls = [];
const refreshBodies = [];
let refreshReply = (body) => new Response(JSON.stringify({ access_token: `access-after-${body.refresh_token}`, refresh_token: `${body.refresh_token}+`, token_type: "bearer", expires_in: 7200 }), { status: 200 });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (String(url).endsWith("/api/enroll/redeem")) {
    return new Response(JSON.stringify({ ws_endpoint: "wss://door.example/ws", relay_binding: "home:alice:1", browser_id: body.stable_browser_id,
      access_token: "access-1", refresh_token: "r1", token_type: "bearer", expires_in: 7200 }), { status: 200 });
  }
  refreshCalls.push(body.refresh_token);
  refreshBodies.push(body);
  trace.push("refresh");
  await new Promise(resolve => setTimeout(resolve, 20));
  return refreshReply(body);
};

let sockets;
async function boot() {
  const auth = await import(`../entrypoints/lib/v8-auth.ts?boot=${boot.n = (boot.n ?? 0) + 1}`);
  sockets = { events: [], names: [] };
  await auth.init({
    openSocket() { sockets.events.push("open"); trace.push("open"); }, closeSocket() { sockets.events.push("close"); },
    announceName(name) { sockets.names.push(name); }, onChange() {},
  });
  return auth;
}

let auth = await boot();
await auth.setup("https://door.example/", "ABCD-EFGH");
check("a fresh token is not stale", auth.accessTokenStale() === false);

// Rotation stored.
check("refresh stores the new access AND refresh token", await auth.refreshAccessToken()
  && store.get("v8BrowserBridgeProfile").refreshToken === "r1+" && store.get("v8BrowserBridgeProfile").accessToken === "access-after-r1");
refreshReply = (body) => new Response(JSON.stringify({ access_token: "a-old-relay", token_type: "bearer", expires_in: 7200 }), { status: 200 });
await auth.refreshAccessToken();
check("an older relay sends no refresh token: the stored one is kept", store.get("v8BrowserBridgeProfile").refreshToken === "r1+");
refreshReply = (body) => new Response(JSON.stringify({ access_token: `access-after-${body.refresh_token}`, refresh_token: `${body.refresh_token}+`, token_type: "bearer", expires_in: 7200 }), { status: 200 });

// Stale token before opening a socket; concurrent callers share one request.
const profile = store.get("v8BrowserBridgeProfile");
store.set("v8BrowserBridgeProfile", { ...profile, tokenExpiresAt: Date.now() + 30_000 });
trace.length = 0;
auth = await boot();
check("init with a token about to expire: refresh request, then the profile is written, then the socket opens (and nothing else)", trace.join() === "refresh,persist,open", trace.join());
check("the refresh says it can store a rotated refresh token", refreshBodies.at(-1).accepts_rotation === true);
refreshCalls = [];
const staleAuth = await boot();
check("a booted worker holds a fresh token", staleAuth.accessTokenStale() === false);
refreshCalls = [];
const both = await Promise.all([staleAuth.refreshAccessToken(), staleAuth.refreshAccessToken()]);
check("two callers at once make one refresh request", both.every(Boolean) && refreshCalls.length === 1, JSON.stringify(refreshCalls));
auth = staleAuth;

// Rename: no reconnect, announced once.
sockets.events.length = 0;
await auth.setDeviceName("Desk Chrome");
await auth.setDeviceName("Desk Chrome");
check("rename announces once over the open socket and never closes or reopens it", sockets.names.join() === "Desk Chrome" && sockets.events.length === 0 && store.get("v8BrowserBridgeName") === "Desk Chrome", JSON.stringify(sockets));

// Retry reason.
auth.markRetry(Date.now() + 5000, "unreachable");
check("the retry reason reaches the snapshot and clears on connect", auth.snapshot().retryReason === "unreachable" && (auth.markConnected(), auth.snapshot().retryReason === null));
check("last connection time is stored", typeof store.get("v8BrowserBridgeLastConnected") === "number");

// Login ended: refresh 401.
refreshReply = () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
sockets.events.length = 0;
await auth.refreshAccessToken();
let snap = auth.snapshot();
check("a refused refresh token is 'login_ended', not the code-expired state", snap.state === "login_ended" && snap.error === null, JSON.stringify(snap));
check("the profile is gone but the address stays for the form", !store.has("v8BrowserBridgeProfile") && snap.address === "https://door.example" && sockets.events.includes("close"));
auth = await boot();
check("... also after a service-worker restart: still login_ended, with the address", auth.snapshot().state === "login_ended" && auth.snapshot().address === "https://door.example" && auth.snapshot().error === null, JSON.stringify(auth.snapshot()));

// A bad code while the login has ended keeps the state and the address.
auth = await boot();
refreshReply = () => new Response("{}", { status: 401 });
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/api/enroll/redeem")) return new Response(JSON.stringify({ error: "unknown_code" }), { status: 404 });
  return new Response("{}", { status: 401 });
};
store.set("v8BrowserBridgeProfile", { schemaVersion: 8, addressOrigin: "https://door.example", wsEndpoint: "wss://door.example/ws", relayBinding: "home:alice:1", browserId: "b".repeat(32), accessToken: "x", refreshToken: "y", tokenExpiresAt: Date.now() - 1 });
auth = await boot();
check("expired access token and refused refresh at start → login_ended", auth.snapshot().state === "login_ended");
await auth.setup("https://door.example", "ZZZZ-9999");
check("a wrong code afterwards keeps 'login_ended' with the reason", auth.snapshot().state === "login_ended" && /코드가 맞지 않거나/.test(auth.snapshot().error ?? ""), JSON.stringify(auth.snapshot()));

// A slow refresh of an old login must not overwrite or wipe a newer one (re-enrolment during the refresh).
const hold = () => { let release; const gate = new Promise(resolve => { release = resolve; }); return { gate, release }; };
const redeemOk = (body, token) => new Response(JSON.stringify({ ws_endpoint: "wss://door.example/ws", relay_binding: "home:alice:1", browser_id: body.stable_browser_id,
  access_token: token, refresh_token: `${token}-refresh`, token_type: "bearer", expires_in: 7200 }), { status: 200 });
let gateRefresh = null;
let redeemGate = null;
let redeemCount = 0;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (String(url).endsWith("/api/enroll/redeem")) { redeemCount++; if (redeemGate) await redeemGate.gate; return redeemOk(body, `new-${redeemCount}`); }
  await gateRefresh.gate;
  return gateRefresh.reply(body);
};
auth = await boot();
await auth.setup("https://door.example", "ABCD-EFGH"); // login A (access "new-1")
let loginA = store.get("v8BrowserBridgeProfile");
gateRefresh = { ...hold(), reply: () => new Response(JSON.stringify({ access_token: "stale-access", refresh_token: "stale-refresh", token_type: "bearer", expires_in: 7200 }), { status: 200 }) };
const slow = auth.refreshAccessToken();
await new Promise(resolve => setTimeout(resolve, 10));
await auth.setup("https://door.example", "WXYZ-2345", true); // re-enrolment while that refresh is out: login B
const loginB = store.get("v8BrowserBridgeProfile");
gateRefresh.release();
check("a refresh of the old login that returns after a re-enrolment is discarded", (await slow) === false
  && store.get("v8BrowserBridgeProfile").accessToken === loginB.accessToken && store.get("v8BrowserBridgeProfile").refreshToken === loginB.refreshToken, JSON.stringify(store.get("v8BrowserBridgeProfile")));
gateRefresh = { ...hold(), reply: () => new Response("{}", { status: 401 }) };
const slow401 = auth.refreshAccessToken();
await new Promise(resolve => setTimeout(resolve, 10));
await auth.setup("https://door.example", "WXYZ-2345", true); // login C while a refresh of B is out
const loginC = store.get("v8BrowserBridgeProfile");
gateRefresh.release();
await slow401;
check("a refused refresh of a superseded login does not wipe the newer one", auth.snapshot().state === "connecting" && store.get("v8BrowserBridgeProfile")?.accessToken === loginC.accessToken, JSON.stringify(auth.snapshot()));

// A cancelled re-connect never replaces the connection, even if its code is accepted late; one submission at a time.
const before = JSON.stringify(store.get("v8BrowserBridgeProfile"));
redeemGate = hold();
redeemCount = 100;
const pendingSetup = auth.setup("https://door.example", "ABCD-EFGH", true);
await new Promise(resolve => setTimeout(resolve, 10));
const countDuring = redeemCount;
await auth.setup("https://door.example", "ABCD-EFGH", true); // a paste that also submits: ignored
check("a second submission while one is running is ignored", redeemCount === countDuring);
auth.cancelSetup();
redeemGate.release();
await pendingSetup;
check("a cancelled attempt does not replace the connection", JSON.stringify(store.get("v8BrowserBridgeProfile")) === before && auth.snapshot().state === "connecting");
redeemGate = null;
await auth.setup("https://door.example", "ABCD-EFGH", true);
check("after a cancel a new attempt works", store.get("v8BrowserBridgeProfile").accessToken.startsWith("new-"));

// An address error survives a worker restart with its reason.
await auth.onRelayBinding("home:someone-else:9");
auth = await boot();
check("an address error is still shown with its reason after a restart", auth.snapshot().state === "address_error" && /연결 주소가 변경/.test(auth.snapshot().error ?? ""), JSON.stringify(auth.snapshot()));

// Reset forgets everything stored for the connection.
globalThis.fetch = async (url, init) => new Response(JSON.stringify({ ws_endpoint: "wss://door.example/ws", relay_binding: "home:alice:1", browser_id: JSON.parse(init.body).stable_browser_id,
  access_token: "access-1", refresh_token: "r1", token_type: "bearer", expires_in: 7200 }), { status: 200 });
await auth.setup("https://door.example", "ABCD-EFGH");
auth.markConnected();
sockets.events.length = 0;
await auth.reset();
snap = auth.snapshot();
check("reset: profile, address and last-connected are gone, socket closed, state setup",
  snap.state === "setup" && snap.address === null && snap.lastConnectedAt === null && !store.has("v8BrowserBridgeProfile")
  && !store.has("v8BrowserBridgeLastAddress") && !store.has("v8BrowserBridgeLastConnected") && sockets.events.includes("close"), JSON.stringify([snap, [...store.keys()]]));
check("reset keeps the device name and the browser id", store.get("v8BrowserBridgeName") === "Desk Chrome" && typeof store.get("v8BrowserBridgeId") === "string");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
