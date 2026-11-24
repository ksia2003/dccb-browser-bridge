/**
 * 6.0.2 relay connection handling against an isolated relay: the switched-off record survives a relay
 * restart (state folder), a rename frame renames the live connection without reconnecting, and a socket
 * that goes silent is closed by the relay (heartbeat) while one that keeps pinging stays.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function startRelay() {
  return spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
    cwd: root,
    env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "state/tokens.json"), BRIDGE_BIND_HOST: "127.0.0.1",
      BRIDGE_WS_PORT: String(wsPort), BRIDGE_HTTP_PORT: String(httpPort), BRIDGE_TRUST_LOCAL: "1", BB_HEARTBEAT_TIMEOUT_MS: "1500" },
    stdio: "ignore",
  });
}
async function extension(id, name = "Laptop") {
  let socket;
  for (let attempt = 0; ; attempt++) {
    socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?id=${id}&name=${encodeURIComponent(name)}`, { headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
    const opened = await new Promise(resolve => { socket.once("open", () => resolve(true)); socket.once("error", () => resolve(false)); });
    if (opened) break;
    if (attempt >= 50) throw new Error("the isolated relay did not accept connections");
    await sleep(200);
  }
  socket.send(JSON.stringify({ type: "extension_hello", version: "6.0.2" }));
  socket.on("message", data => {
    const message = JSON.parse(String(data));
    if (message.type === "tool_request") socket.send(JSON.stringify({ type: "tool_response", id: message.id, result: { ok: true } }));
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

  // The switched-off record survives a relay restart.
  socket = await extension("sleepy", "Sleepy");
  await sleep(300);
  const gone = closed(socket);
  socket.send(JSON.stringify({ type: "extension_switched_off" }));
  socket.close();
  await gone;
  await sleep(300);
  relay.kill("SIGTERM");
  await new Promise(resolve => relay.once("exit", resolve));
  relay = startRelay();
  for (let i = 0; i < 100; i++) {
    const ready = await call("/browsers").catch(() => null);
    if (ready) break;
    await sleep(200);
  }
  const reply = await call("/send", { tool: "extension", args: {} });
  assert.equal(reply.status, 503);
  assert.equal(reply.body.switched_off?.[0].id, "sleepy");
  assert.match(reply.body.error, /switched Browser Bridge off/);
  assert.equal((await call("/browsers")).body.switched_off[0].name, "Sleepy");
  console.log("  PASS  a switched-off Chrome is still switched_off after the relay restarts");
  socket = await extension("sleepy", "Sleepy");
  await sleep(300);
  relay.kill("SIGTERM");
  await new Promise(resolve => relay.once("exit", resolve));
  relay = startRelay();
  for (let i = 0; i < 100; i++) { if (await call("/browsers").catch(() => null)) break; await sleep(200); }
  assert.equal((await call("/send", { tool: "extension", args: {} })).body.switched_off, undefined);
  console.log("  PASS  switching it back on clears the stored record");
  console.log("\n5 passed");
} finally {
  relay.kill("SIGTERM");
  await sleep(300);
  rmSync(temp, { recursive: true, force: true });
}
