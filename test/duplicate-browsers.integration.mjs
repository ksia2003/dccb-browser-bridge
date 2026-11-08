/**
 * Someone who installs the Web Store copy (6.0.0) and keeps the old unpacked one connects twice:
 * the relay uses the only current copy instead of asking which (owner 11-08). Two current copies are
 * still a real choice. Runs against an isolated local relay process.
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
const temp = mkdtempSync(join(tmpdir(), "bb-duplicate-"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const free = () => new Promise(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

const [wsPort, httpPort] = [await free(), await free()];
const relay = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
  cwd: root,
  env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "state/tokens.json"), BRIDGE_BIND_HOST: "127.0.0.1",
    BRIDGE_WS_PORT: String(wsPort), BRIDGE_HTTP_PORT: String(httpPort), BRIDGE_TRUST_LOCAL: "1" },
  stdio: "ignore",
});

/** A fake extension that says its version and answers every tool with its own name. */
async function extension(id, version) {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?id=${id}&name=Chrome`, { headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "extension_hello", version }));
  socket.on("message", data => {
    const message = JSON.parse(String(data));
    if (message.type === "tool_request") socket.send(JSON.stringify({ type: "tool_response", id: message.id, result: { who: id } }));
  });
  return socket;
}

try {
  const secretPath = join(temp, "state/http-control.secret");
  for (let i = 0; i < 100 && !existsSync(secretPath); i++) await sleep(100);
  const secret = readFileSync(secretPath, "utf8").trim();
  const send = body => fetch(`http://127.0.0.1:${httpPort}/send`, { method: "POST", headers: { "content-type": "application/json", "x-dccb-relay-secret": secret }, body: JSON.stringify(body) }).then(response => response.json());

  const old = await extension("unpacked", "1.2.1");
  const store = await extension("store", "6.0.0");
  await sleep(300);
  assert.equal((await send({ tool: "extension", args: {} })).result?.who, "store", "the Web Store copy is used");
  console.log("  PASS  an old unpacked copy next to the Web Store copy: the current one is used");

  const another = await extension("laptop", "6.0.0");
  await sleep(300);
  const ambiguous = await send({ tool: "extension", args: {} });
  assert.match(JSON.stringify(ambiguous), /multiple browsers connected/, JSON.stringify(ambiguous));
  console.log("  PASS  two current Chromes are still a choice to make");
  for (const socket of [old, store, another]) socket.close();
} finally {
  relay.kill("SIGTERM");
  await sleep(300);
  rmSync(temp, { recursive: true, force: true });
}
