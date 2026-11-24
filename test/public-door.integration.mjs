/**
 * Loopback-only protocol proof for the V8 public door.  It does not invoke
 * Funnel or Chrome: the test proves that only the local issuer can create a
 * code and the public redeemer obtains a bearer bound to that same HOME route.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const directory = mkdtempSync(join(tmpdir(), "dccb-public-door-"));
process.env.BB_V6_TOKENS_FILE = join(directory, "door-tokens.json");

const { startPublicDoor } = await import("../server/public-door.ts");

function once(server) {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", data => resolve(data.toString()));
    socket.once("error", reject);
  });
}

const origin = "https://home-box.example.ts.net";
const homeHttp = createServer();
const homeWss = new WebSocketServer({ noServer: true });
const homeUpgradeOrigins = [];
const homeUpgradeUrls = [];
let homeSendsBinding = true;
const homeNoticeFrames = [];
homeHttp.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/notice") {
    // The notice path: HOME records only notice frames and answers with the ack.
    homeUpgradeUrls.push(req.url);
    homeWss.handleUpgrade(req, socket, head, ws => ws.on("message", data => {
      homeNoticeFrames.push(JSON.parse(data.toString()).type);
      ws.send(JSON.stringify({ type: "relay_binding", relay_binding: "home:bob:home-box" })); // not an ack: must not cross
      ws.send(JSON.stringify({ type: "switched_off_ack", applied: true }));
    }));
    return;
  }
  if (path !== "/ws") { socket.destroy(); return; }
  homeUpgradeOrigins.push(req.headers.origin);
  homeUpgradeUrls.push(req.url);
  homeWss.handleUpgrade(req, socket, head, ws => {
    if (homeSendsBinding) ws.send(JSON.stringify({ type: "relay_binding", relay_binding: "home:bob:home-box", browser_id: "public_door_browser_0001" }));
    ws.on("message", data => ws.send(data));
  });
});
homeHttp.listen(0, "127.0.0.1");
await once(homeHttp);
const homePort = homeHttp.address().port;
const route = {
  person: "bob",
  boxId: "home-box",
  accessPath: "public-entrance",
  relayBinding: "home:bob:home-box",
  address: origin,
  wsEndpoint: "wss://home-box.example.ts.net/ws",
  homeWsEndpoint: `ws://127.0.0.1:${homePort}/ws`,
  // Only this HOME account may ask for the route's setup code (11-06).
  linuxUser: userInfo().username,
};
const door = startPublicDoor({
  // The runtime entrypoint passes the normalized config returned by
  // publicDoorConfigFromEnvironment(), not the schema-bearing disk object.
  config: { boxId: "home-box", address: origin, routes: [route] },
  publicPort: 0,
  issuerPort: 0,
});

try {
  await Promise.all([once(door.publicServer), once(door.issuerServer)]);
  const publicPort = door.publicServer.address().port;
  const issuerPort = door.issuerServer.address().port;
  const issue = await fetch(`http://127.0.0.1:${issuerPort}/api/enroll/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ person: "bob", box_id: "home-box" }),
  });
  assert.equal(issue.status, 200);
  assert.equal(issue.headers.get("access-control-allow-origin"), null);
  const issued = await issue.json();
  assert.match(issued.setup_code, /^[A-Z2-9]{8}$/);
  assert.equal(issued.address, origin);

  const wrong = await fetch(`http://127.0.0.1:${issuerPort}/api/enroll/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ person: "carol", box_id: "home-box" }),
  });
  assert.equal(wrong.status, 409);

  const redeemed = await fetch(`http://127.0.0.1:${publicPort}/api/enroll/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setup_code: issued.setup_code, stable_browser_id: "public_door_browser_0001" }),
  });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.headers.get("access-control-allow-origin"), null);
  const profile = await redeemed.json();
  assert.equal(profile.ws_endpoint, route.wsEndpoint);
  assert.equal(profile.relay_binding, route.relayBinding);
  assert.equal(profile.browser_id, "public_door_browser_0001");
  assert.equal(profile.token_type, "bearer");
  assert.equal(typeof profile.refresh_token, "string");

  const refresh = await fetch(`http://127.0.0.1:${publicPort}/api/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: profile.refresh_token }),
  });
  assert.equal(refresh.status, 200);
  assert.equal(refresh.headers.get("access-control-allow-origin"), null);
  const refreshed = await refresh.json();
  assert.equal(refreshed.token_type, "bearer");
  assert.notEqual(refreshed.access_token, profile.access_token);
  console.log("  PASS  local issue → public redeem → refresh preserves one declared HOME route");

  const publicWsUrl = `ws://127.0.0.1:${publicPort}/ws?id=public_door_browser_0001`;
  const hostile = new WebSocket(publicWsUrl, [`bb-bearer.${refreshed.access_token}`], {
    headers: { Origin: "https://hostile.example" },
  });
  const hostileStatus = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostile.terminate();
      reject(new Error("public door did not answer hostile Origin probe"));
    }, 3_000);
    hostile.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode);
    });
    hostile.once("open", () => {
      clearTimeout(timer);
      hostile.close();
      resolve(101);
    });
    hostile.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(hostileStatus, 403);
  console.log("  PASS  public WebSocket rejects a valid bearer paired with hostile Origin");

  const extension = new WebSocket(publicWsUrl, [`bb-bearer.${refreshed.access_token}`], {
    headers: { Origin: "chrome-extension://hcohflmcefamngmhofgnkiomkeklhioo" },
  });
  await new Promise((resolve, reject) => {
    extension.once("open", resolve);
    extension.once("error", reject);
  });
  assert.deepEqual(JSON.parse(await nextMessage(extension)), {
    type: "relay_binding", relay_binding: route.relayBinding, browser_id: "public_door_browser_0001",
  });
  extension.send(JSON.stringify({ type: "extension-origin" }));
  assert.equal(await nextMessage(extension), JSON.stringify({ type: "extension-origin" }));
  extension.close();
  assert.ok(homeUpgradeOrigins.every(origin => origin === undefined));
  console.log("  PASS  Chrome extension Origin and Origin-less door→HOME Node WS remain accepted");

  const client = new WebSocket(`ws://127.0.0.1:${publicPort}/ws?id=public_door_browser_0001`, [`bb-bearer.${refreshed.access_token}`]);
  await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  const binding = JSON.parse(await nextMessage(client));
  assert.equal(binding.relay_binding, route.relayBinding);
  client.send(JSON.stringify({ type: "ping" }));
  assert.equal(await nextMessage(client), JSON.stringify({ type: "ping" }));
  client.close();
  console.log("  PASS  public WebSocket terminates at the door and forwards frames only to its local HOME relay");

  // The door verifies the id: a login enrolled for one browser cannot name another's, and the id
  // forwarded to HOME is the enrolled one even when the caller sends none.
  const refusedClaim = new WebSocket(`ws://127.0.0.1:${publicPort}/ws?id=some_other_browser_00000001`, [`bb-bearer.${refreshed.access_token}`]);
  const refusedStatus = await new Promise((resolve, reject) => {
    refusedClaim.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); });
    refusedClaim.once("open", () => { refusedClaim.close(); resolve(101); });
    refusedClaim.once("error", reject);
  });
  assert.equal(refusedStatus, 403);
  const noClaim = new WebSocket(`ws://127.0.0.1:${publicPort}/ws`, [`bb-bearer.${refreshed.access_token}`]);
  await new Promise((resolve, reject) => { noClaim.once("open", resolve); noClaim.once("error", reject); });
  await nextMessage(noClaim);
  assert.match(homeUpgradeUrls.at(-1), /[?&]id=public_door_browser_0001(&|$)/);
  noClaim.close();
  console.log("  PASS  the door binds the connection id to the enrolled browser and forwards the verified id");

  // Re-enrolling the same browser: the newer login's admission ends the older login's connection at once,
  // and its tokens are gone; before admission the older one keeps working.
  const oldLive = new WebSocket(publicWsUrl, [`bb-bearer.${refreshed.access_token}`]);
  await new Promise((resolve, reject) => { oldLive.once("open", resolve); oldLive.once("error", reject); });
  await nextMessage(oldLive);
  let oldCode = null;
  oldLive.on("close", code => { oldCode = code; });
  const issue2 = await (await fetch(`http://127.0.0.1:${issuerPort}/api/enroll/issue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ person: "bob", box_id: "home-box" }) })).json();
  const profile2 = await (await fetch(`http://127.0.0.1:${publicPort}/api/enroll/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setup_code: issue2.setup_code, stable_browser_id: "public_door_browser_0001" }) })).json();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(oldCode, null, "issuing a new login alone does not end the old connection");
  const newLive = new WebSocket(publicWsUrl, [`bb-bearer.${profile2.access_token}`]);
  await new Promise((resolve, reject) => { newLive.once("open", resolve); newLive.once("error", reject); });
  await nextMessage(newLive);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(oldCode, 4401, "admission of the newer login closed the older connection with 4401");
  const staleRefresh = await fetch(`http://127.0.0.1:${publicPort}/api/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: profile.refresh_token }) });
  assert.equal(staleRefresh.status, 401);
  newLive.close();
  console.log("  PASS  re-enrolling: the older login ends at the newer one's admission");

  // Admission is HOME's relay_binding, not an upstream 101; a refresh retires nothing.
  const issue3 = await (await fetch(`http://127.0.0.1:${issuerPort}/api/enroll/issue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ person: "bob", box_id: "home-box" }) })).json();
  const profile3 = await (await fetch(`http://127.0.0.1:${publicPort}/api/enroll/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setup_code: issue3.setup_code, stable_browser_id: "public_door_browser_0001" }) })).json();
  const refreshWith = (token, rotate = false) => fetch(`http://127.0.0.1:${publicPort}/api/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: token, ...(rotate ? { accepts_rotation: true } : {}) }) });
  assert.equal((await refreshWith(profile3.refresh_token)).status, 200, "the newest login refreshes before it ever connected");
  assert.equal((await refreshWith(profile2.refresh_token)).status, 200, "...and that retires nothing: the working login still refreshes");
  homeSendsBinding = false;
  const silentHome = new WebSocket(publicWsUrl, [`bb-bearer.${profile3.access_token}`]);
  await new Promise((resolve, reject) => { silentHome.once("open", resolve); silentHome.once("error", reject); });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await refreshWith(profile2.refresh_token)).status, 200, "HOME accepted the upgrade but never sent relay_binding: no admission, the older login stays");
  silentHome.close();
  homeSendsBinding = true;
  const admitted = new WebSocket(publicWsUrl, [`bb-bearer.${profile3.access_token}`]);
  await new Promise((resolve, reject) => { admitted.once("open", resolve); admitted.once("error", reject); });
  assert.equal(JSON.parse(await nextMessage(admitted)).type, "relay_binding");
  assert.equal((await refreshWith(profile2.refresh_token)).status, 401, "after HOME's relay_binding the newer login is admitted and the older one ends");
  admitted.close();
  console.log("  PASS  the door admits a new login on HOME's relay_binding only; refreshing retires nothing");

  // The notice-only connection is relayed as such, and a frame sent before HOME is ready is not lost.
  const noticeThroughDoor = new WebSocket(`ws://127.0.0.1:${publicPort}/notice`, [`bb-bearer.${(await (await refreshWith(profile3.refresh_token)).json()).access_token}`]);
  noticeThroughDoor.once("open", () => {
    noticeThroughDoor.send(JSON.stringify({ type: "tool_response", id: "x", result: {} })); // not a notice: must not cross
    noticeThroughDoor.send(JSON.stringify({ type: "extension_switched_off" }));
  });
  const received = await new Promise(resolve => { const seen = []; noticeThroughDoor.on("message", data => { seen.push(JSON.parse(data.toString()).type); resolve(seen); }); });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(homeNoticeFrames, ["extension_switched_off"], "the early frame reached HOME (buffered), and only the notice crossed");
  assert.deepEqual(received, ["switched_off_ack"], "only the ack came back");
  assert.equal(new URL(homeUpgradeUrls.at(-1), "http://x").pathname, "/notice", "HOME was asked for /notice, not /ws");
  noticeThroughDoor.close();
  console.log("  PASS  the door relays the dedicated /notice path, only notice and ack frames cross, early frames are buffered");

  // Another account on the box reaches the issuer over loopback too; it must not get this person's code.
  const foreign = startPublicDoor({
    config: { boxId: "home-box", address: origin, routes: [{ ...route, linuxUser: "root" }] },
    publicPort: 0,
    issuerPort: 0,
  });
  try {
    await Promise.all([once(foreign.publicServer), once(foreign.issuerServer)]);
    const refused = await fetch(`http://127.0.0.1:${foreign.issuerServer.address().port}/api/enroll/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ person: "bob", box_id: "home-box" }),
    });
    assert.equal(refused.status, 403);
    console.log("  PASS  the issuer refuses a setup code to a loopback caller that is not the route's HOME account");
  } finally {
    await foreign.close();
  }
} finally {
  await door.close();
  for (const client of homeWss.clients) client.terminate();
  await new Promise(resolve => homeHttp.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
