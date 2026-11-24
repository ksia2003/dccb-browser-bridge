/**
 * 6.1.0 relay connection handling against an isolated relay: the switched-off record survives a relay
 * restart (state folder), a rename frame renames the live connection without reconnecting, and a socket
 * that goes silent is closed by the relay (heartbeat) while one that keeps pinging stays.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "bb-connection-"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const free = () => new Promise(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const [wsPort, httpPort] = [await free(), await free()];

// Logins seeded in the relay's token store (what an enrollment leaves behind), so the bearer paths run
// without a dashboard: alice's browsers "aaaa…" (two logins, the second newer) and "bbbb…".
const binding = { person: "alice", boxId: "box", relayBinding: "rb", homeWsEndpoint: "ws://x/ws" };
const entry = (clientId, family) => ({ clientId, createdAt: Date.now(), expiresAt: Date.now() + 3600_000, family, enrollmentBinding: binding });
const idA = "aaaaaaaaaaaaaaaaaaaa";
const idB = "bbbbbbbbbbbbbbbbbbbb";
mkdirSync(join(temp, "state"), { recursive: true });
writeFileSync(join(temp, "state/tokens.json"), JSON.stringify({
  accessTokens: { tokA1: entry(`v8-alice-${idA}`, 1), tokA2: entry(`v8-alice-${idA}`, 2), tokB: entry(`v8-alice-${idB}`, 1) },
  refreshTokens: { refA1: { ...entry(`v8-alice-${idA}`, 1), expiresAt: Date.now() + 86400_000 }, refA2: { ...entry(`v8-alice-${idA}`, 2), expiresAt: Date.now() + 86400_000 }, refB: { ...entry(`v8-alice-${idB}`, 1), expiresAt: Date.now() + 86400_000 } },
}));

function startRelay() {
  return spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
    cwd: root,
    env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "state/tokens.json"), BRIDGE_BIND_HOST: "127.0.0.1",
      BRIDGE_WS_PORT: String(wsPort), BRIDGE_HTTP_PORT: String(httpPort), BRIDGE_TRUST_LOCAL: "1", BB_HEARTBEAT_TIMEOUT_MS: "1500" },
    stdio: "ignore",
  });
}
async function extension(id, name = "Laptop", token = null, respond = true) {
  let socket;
  for (let attempt = 0; ; attempt++) {
    const query = `${id ? `id=${id}&` : ""}name=${encodeURIComponent(name)}`;
    socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?${query}`, token ? [`bb-bearer.${token}`] : [], { headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
    const opened = await new Promise(resolve => { socket.once("open", () => resolve(true)); socket.once("error", () => resolve(false)); });
    if (opened) break;
    if (token && attempt >= 2) return null; // refused by the relay, not still starting
    if (attempt >= 50) throw new Error("the isolated relay did not accept connections");
    await sleep(200);
  }
  socket.send(JSON.stringify({ type: "extension_hello", version: "6.1.0" }));
  socket.on("message", data => {
    const message = JSON.parse(String(data));
    if (respond && message.type === "tool_request") socket.send(JSON.stringify({ type: "tool_response", id: message.id, result: { ok: true } }));
  });
  return socket;
}
const closed = socket => new Promise(resolve => socket.once("close", resolve));

let relay = startRelay();
try {
  const secretPath = join(temp, "state/http-control.secret");
  for (let i = 0; i < 100 && !existsSync(secretPath); i++) await sleep(100);
  const secret = readFileSync(secretPath, "utf8").trim();
  const call = (path, body) => fetch(`http://127.0.0.1:${httpPort}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-dccb-relay-secret": secret }, body: body && JSON.stringify(body) })
    .then(async response => ({ status: response.status, body: await response.json() }));

  // Rename over the open socket.
  let socket = await extension("laptop");
  await sleep(300);
  assert.equal((await call("/browsers")).body.browsers[0].name, "Laptop");
  let dropped = false;
  socket.on("close", () => { dropped = true; });
  socket.send(JSON.stringify({ type: "extension_rename", name: "  Desk Chrome  " }));
  await sleep(300);
  const renamed = (await call("/browsers")).body.browsers;
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].name, "Desk Chrome");
  assert.equal(dropped, false, "the socket stayed open");
  console.log("  PASS  a rename frame renames the live connection without dropping it");

  // Heartbeat: a socket that keeps pinging stays; a silent one is closed.
  for (let i = 0; i < 6; i++) { socket.send(JSON.stringify({ type: "ping" })); await sleep(500); }
  assert.equal(dropped, false, "a pinging socket is kept past the silence timeout");
  console.log("  PASS  a socket that keeps pinging stays connected past the silence timeout");
  const silent = await extension("silent-one", "Silent");
  const silentClosed = closed(silent);
  await Promise.race([silentClosed, sleep(5000).then(() => { throw new Error("the silent socket was not closed"); })]);
  await sleep(200);
  assert.ok(!(await call("/browsers")).body.browsers.some(b => b.id === "silent-one"));
  console.log("  PASS  a silent socket is closed by the relay and leaves /browsers");
  socket.close();
  await sleep(300);

  // A bearer's id is the browser it was enrolled for.
  assert.equal(await extension(idB, "Thief", "tokA1"), null, "browser A's login cannot claim browser B's id");
  let a1 = await extension(idA, "A", "tokA1");
  assert.ok(a1, "the right id is accepted");
  let a1Code = null;
  a1.on("close", code => { a1Code = code; });
  await sleep(300);
  let listed = (await call("/browsers")).body.browsers;
  assert.ok(listed.some(b => b.id === idA) && !listed.some(b => b.id === idB));
  const noId = await extension(null, "A again", "tokA1");
  await sleep(300);
  assert.ok((await call("/browsers")).body.browsers.some(b => b.id === idA && b.name === "A again"), "no claimed id: the enrolled id is used");
  noId.close();
  console.log("  PASS  a bearer connection is bound to the browser id of its enrollment");

  // The newer login of that browser, once admitted, closes the older login's socket at once (4401).
  a1 = await extension(idA, "A", "tokA1");
  a1Code = null;
  a1.on("close", code => { a1Code = code; });
  await sleep(200);
  const a2 = await extension(idA, "A", "tokA2");
  await sleep(500);
  assert.equal(a1Code, 4401, "the superseded login's socket was closed with 4401 at admission, not at a poll");
  assert.equal(await extension(idA, "A", "tokA1"), null, "and its token no longer opens a socket");
  assert.ok(a2.readyState === WebSocket.OPEN);
  console.log("  PASS  admitting a newer login ends the older login's connection at once");
  a2.close();
  await sleep(300);

  // The switched-off record survives a relay restart.
  const restart = async () => {
    relay.kill("SIGTERM");
    await new Promise(resolve => relay.once("exit", resolve));
    relay = startRelay();
    for (let i = 0; i < 100; i++) { if (await call("/browsers").catch(() => null)) break; await sleep(200); }
  };
  socket = await extension("sleepy", "Sleepy");
  await sleep(300);
  const gone = closed(socket);
  socket.send(JSON.stringify({ type: "extension_switched_off" }));
  socket.close();
  await gone;
  await sleep(300);
  await restart();
  let reply = await call("/send", { tool: "extension", args: {} });
  assert.equal(reply.status, 503);
  assert.equal(reply.body.switched_off?.[0].id, "sleepy");
  assert.match(reply.body.error, /switched Browser Bridge off/);
  assert.equal((await call("/browsers")).body.switched_off[0].name, "Sleepy");
  console.log("  PASS  a switched-off Chrome is still switched_off after the relay restarts");

  // The actual last departure is stored too: a plain drop after the switch-off stays no_extension across a restart.
  const plain = await extension("plain", "Plain");
  await sleep(300);
  plain.close();
  await sleep(300);
  reply = await call("/send", { tool: "extension", args: {} });
  assert.match(reply.body.error, /no extension connected/);
  await restart();
  reply = await call("/send", { tool: "extension", args: {} });
  assert.equal(reply.status, 503);
  assert.match(reply.body.error, /no extension connected/);
  assert.equal(reply.body.switched_off, undefined, "a restart must not turn no_extension into switched_off");
  assert.equal((await call("/browsers")).body.switched_off[0].id, "sleepy", "the record itself is still listed");
  console.log("  PASS  a plain drop after a switch-off is still exactly 503 no_extension after a restart");

  // Switching it back on clears the stored record.
  socket = await extension("sleepy", "Sleepy");
  await sleep(300);
  await restart();
  reply = await call("/send", { tool: "extension", args: {} });
  assert.equal(reply.status, 503);
  assert.match(reply.body.error, /no extension connected/);
  assert.equal(reply.body.switched_off, undefined);
  assert.equal((await call("/browsers")).body.switched_off, undefined);
  assert.ok(JSON.parse(readFileSync(join(temp, "state/switched-off.json"), "utf8")).entries.sleepy === undefined);
  console.log("  PASS  switching it back on clears the stored record (503 no_extension after a restart)");

  // A tool_response is accepted only from the socket the request went to.
  const target = await extension("target-one", "Target", null, false);
  const bystander = await extension("bystander", "Bystander");
  const requestSeen = new Promise(resolve => target.on("message", data => { const m = JSON.parse(String(data)); if (m.type === "tool_request") resolve(m); }));
  await sleep(300);
  const answered = call("/send", { tool: "extension", args: {}, target: "target-one" });
  const request = await requestSeen;
  bystander.send(JSON.stringify({ type: "tool_response", id: request.id, result: { forged: true } }));
  await sleep(300);
  target.send(JSON.stringify({ type: "tool_response", id: request.id, result: { genuine: true } }));
  const answer = await answered;
  assert.deepEqual(answer.body.result, { genuine: true }, "another socket cannot settle a request by id");
  target.close(); bystander.close();
  await sleep(300);
  console.log("  PASS  a tool_response from a socket the request was not sent to is ignored");

  // The notice-only connection: authenticated, not a browser, acknowledged, durable, and stale after a switch-on.
  const sendNotice = (token, id) => new Promise((resolve, reject) => {
    const notice = new WebSocket(`ws://127.0.0.1:${wsPort}/notice?id=${id}&name=NoticeName`, [`bb-bearer.${token}`], { headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
    notice.once("error", reject);
    notice.once("open", () => notice.send(JSON.stringify({ type: "extension_switched_off" })));
    notice.on("message", data => { resolve(JSON.parse(String(data))); });
  });
  const connectedBefore = (await call("/browsers")).body.browsers?.length ?? 0;
  const noticeAck = await sendNotice("tokB", idB);
  assert.equal(noticeAck.type, "switched_off_ack");
  assert.equal(noticeAck.applied, true);
  const afterNotice = await call("/browsers");
  assert.equal(afterNotice.body.switched_off?.find(entry => entry.id === idB)?.name, "NoticeName");
  assert.equal((afterNotice.body.browsers ?? []).length, connectedBefore, "the notice connection is not a browser");
  assert.equal(JSON.parse(readFileSync(join(temp, "state/switched-off.json"), "utf8")).entries[idB].name, "NoticeName", "recorded durably");
  const reply2 = await call("/send", { tool: "extension", args: {}, target: idB });
  assert.match(reply2.body.error, /switched Browser Bridge off/);
  console.log("  PASS  the notice-only connection records the switch-off, is acknowledged, and is never a browser");
  assert.equal((await sendNotice("tokA1", idB).then(() => "accepted", () => "refused")), "refused", "another browser's login cannot send a notice for this id");
  const live = await extension(idB, "B", "tokB");
  await sleep(300);
  const staleAck = await sendNotice("tokB", idB);
  assert.equal(staleAck.applied, false, "a notice for a Chrome that is connected right now is stale");
  assert.ok(!((await call("/browsers")).body.switched_off ?? []).some(entry => entry.id === idB), "and no record is left for it");
  live.close();
  await sleep(300);
  console.log("  PASS  a stale notice (the person switched on again) is acknowledged but not applied");

  // Early 6.1.0 builds (never released) wrote switched-off.json as a flat id map: its unexpired records are kept.
  const [wsPort3, httpPort3] = [await free(), await free()];
  mkdirSync(join(temp, "state3"), { recursive: true });
  writeFileSync(join(temp, "state3/switched-off.json"), JSON.stringify({ oldrecord: { name: "Old", at: new Date().toISOString() }, expired: { name: "Gone", at: "2020-01-01T00:00:00.000Z" } }));
  const migrated = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
    cwd: root,
    env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "state3/tokens.json"), BRIDGE_BIND_HOST: "127.0.0.1", BRIDGE_WS_PORT: String(wsPort3), BRIDGE_HTTP_PORT: String(httpPort3), BRIDGE_TRUST_LOCAL: "1" },
    stdio: "ignore",
  });
  try {
    const secret3Path = join(temp, "state3/http-control.secret");
    for (let i = 0; i < 100 && !existsSync(secret3Path); i++) await sleep(100);
    const secret3 = readFileSync(secret3Path, "utf8").trim();
    let listing;
    for (let i = 0; i < 50 && !listing; i++) { listing = await fetch(`http://127.0.0.1:${httpPort3}/browsers`, { headers: { "x-dccb-relay-secret": secret3 } }).then(r => r.json()).catch(() => null); if (!listing) await sleep(200); }
    assert.deepEqual(listing.switched_off?.map(entry => entry.id), ["oldrecord"], "the flat file's unexpired record survived the upgrade, the expired one did not");
    console.log("  PASS  a flat switched-off file from an earlier build is migrated, not dropped");
  } finally {
    migrated.kill("SIGTERM");
  }

  // Expired records are pruned while the relay keeps running, and the file is rewritten.
  const [wsPort2, httpPort2] = [await free(), await free()];
  mkdirSync(join(temp, "state2"), { recursive: true });
  const short = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
    cwd: root,
    env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "state2/tokens.json"), BRIDGE_BIND_HOST: "127.0.0.1", BRIDGE_WS_PORT: String(wsPort2),
      BRIDGE_HTTP_PORT: String(httpPort2), BRIDGE_TRUST_LOCAL: "1", BB_SWITCHED_OFF_KEEP_MS: "1500" },
    stdio: "ignore",
  });
  try {
    const secret2Path = join(temp, "state2/http-control.secret");
    for (let i = 0; i < 100 && !existsSync(secret2Path); i++) await sleep(100);
    const secret2 = readFileSync(secret2Path, "utf8").trim();
    let shortSocket;
    for (let attempt = 0; ; attempt++) {
      shortSocket = new WebSocket(`ws://127.0.0.1:${wsPort2}/ws?id=short&name=Short`, { headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
      if (await new Promise(resolve => { shortSocket.once("open", () => resolve(true)); shortSocket.once("error", () => resolve(false)); })) break;
      if (attempt >= 50) throw new Error("second relay did not start");
      await sleep(200);
    }
    const goneShort = closed(shortSocket);
    shortSocket.send(JSON.stringify({ type: "extension_switched_off" }));
    shortSocket.close();
    await goneShort;
    const list2 = () => fetch(`http://127.0.0.1:${httpPort2}/browsers`, { headers: { "x-dccb-relay-secret": secret2 } }).then(response => response.json());
    await sleep(300);
    assert.equal((await list2()).switched_off?.[0].id, "short");
    await sleep(2500);
    assert.equal((await list2()).switched_off, undefined, "the expired record is gone without a restart");
    assert.deepEqual(JSON.parse(readFileSync(join(temp, "state2/switched-off.json"), "utf8")).entries, {});
    console.log("  PASS  expired switched-off records are pruned while running and the file is rewritten");
  } finally {
    short.kill("SIGTERM");
  }
  console.log("\n12 passed");
} finally {
  relay.kill("SIGTERM");
  await sleep(300);
  rmSync(temp, { recursive: true, force: true });
}
