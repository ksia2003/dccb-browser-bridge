/**
 * 6.1.0: a Chrome the person switched off in the extension popup is told apart from "nothing connected".
 * The extension sends `extension_switched_off` and closes; the relay then answers a tool with
 * `switched_off` (503, like no_extension), lists no connected browser, and forgets it on reconnect.
 * A browser that merely drops (PC off) stays a plain no_extension. Runs against an isolated relay.
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
const temp = mkdtempSync(join(tmpdir(), "bb-switched-off-"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const free = () => new Promise(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

const [wsPort, httpPort] = [await free(), await free()];
const relay = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
  cwd: root,
  env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "state/tokens.json"), BRIDGE_BIND_HOST: "127.0.0.1",
    BRIDGE_WS_PORT: String(wsPort), BRIDGE_HTTP_PORT: String(httpPort), BRIDGE_TRUST_LOCAL: "1" },
  stdio: "ignore",
});

async function extension(id) {
  let socket;
  for (let attempt = 0; ; attempt++) {
    socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?id=${id}&name=Laptop`, { headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
    const opened = await new Promise(resolve => { socket.once("open", () => resolve(true)); socket.once("error", () => resolve(false)); });
    if (opened) break;
    if (attempt >= 50) throw new Error("the isolated relay did not accept connections");
    await sleep(200);
  }
  socket.send(JSON.stringify({ type: "extension_hello", version: "6.1.0" }));
  socket.on("message", data => {
    const message = JSON.parse(String(data));
    if (message.type === "tool_request") socket.send(JSON.stringify({ type: "tool_response", id: message.id, result: { ok: true } }));
  });
  return socket;
}
const closed = socket => new Promise(resolve => socket.once("close", resolve));

try {
  const secretPath = join(temp, "state/http-control.secret");
  for (let i = 0; i < 100 && !existsSync(secretPath); i++) await sleep(100);
  const secret = readFileSync(secretPath, "utf8").trim();
  const call = (path, body) => fetch(`http://127.0.0.1:${httpPort}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-dccb-relay-secret": secret }, body: body && JSON.stringify(body) })
    .then(async response => ({ status: response.status, body: await response.json() }));

  // A plain drop: no_extension.
  let socket = await extension("laptop");
  await sleep(200);
  assert.equal((await call("/send", { tool: "extension", args: {} })).body.result?.ok, true);
  socket.close();
  await sleep(300);
  let reply = await call("/send", { tool: "extension", args: {} });
  assert.equal(reply.status, 503);
  assert.match(reply.body.error, /no extension connected/);
  assert.equal(reply.body.switched_off, undefined);
  console.log("  PASS  a dropped browser is still no_extension (503)");

  // The person switches it off.
  socket = await extension("laptop");
  await sleep(200);
  const gone = closed(socket);
  socket.send(JSON.stringify({ type: "extension_switched_off" }));
  socket.close();
  await gone;
  await sleep(300);
  reply = await call("/send", { tool: "extension", args: {} });
  assert.equal(reply.status, 503, "same status as no_extension");
  assert.match(reply.body.error, /switched Browser Bridge off.*extension popup/);
  assert.equal(reply.body.switched_off[0].id, "laptop");
  assert.equal((await call("/send", { tool: "extension", args: {}, target: "laptop" })).body.switched_off[0].name, "Laptop");
  const listed = await call("/browsers");
  assert.equal(listed.status, 503);
  assert.deepEqual(listed.body.browsers, []);
  assert.equal(listed.body.switched_off[0].id, "laptop");
  console.log("  PASS  a browser the person switched off answers switched_off and is not listed as connected");

  // Turning it on again clears the memory.
  socket = await extension("laptop");
  await sleep(300);
  assert.equal((await call("/send", { tool: "extension", args: {} })).body.result?.ok, true);
  assert.equal((await call("/browsers")).body.switched_off, undefined);
  console.log("  PASS  switching it back on clears the switched-off record");

  // After being on again, a plain drop is no_extension again (the last departure was not the person's).
  socket.close();
  await sleep(300);
  reply = await call("/send", { tool: "extension", args: {} });
  assert.match(reply.body.error, /no extension connected/);
  console.log("  PASS  a later plain drop is no_extension, not switched_off");
  console.log("\n4 passed");
} finally {
  relay.kill("SIGTERM");
  await sleep(300);
  rmSync(temp, { recursive: true, force: true });
}
