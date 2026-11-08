/** WS Origin smoke test; runs only against an isolated local relay process. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import WebSocket from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "bb-ws-origin-"));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function connect(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => reject(new Error("WebSocket handshake timed out")), 5_000);
    socket.once("open", () => { clearTimeout(timer); resolve({ socket, status: 101 }); });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      resolve({ socket, status: response.statusCode });
    });
    socket.once("error", error => {
      if (socket.readyState !== WebSocket.CONNECTING) return;
      clearTimeout(timer);
      reject(error);
    });
  });
}

const wsPort = await freePort();
const child = spawn(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"], {
  cwd: root,
  env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "state", "tokens.json"),
    BRIDGE_BIND_HOST: "127.0.0.1", BRIDGE_WS_PORT: String(wsPort), BRIDGE_HTTP_PORT: String(await freePort()),
    BRIDGE_TRUST_LOCAL: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.setEncoding("utf8").on("data", value => { logs += value; });
child.stderr.setEncoding("utf8").on("data", value => { logs += value; });

try {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (logs.includes("WS listening")) break;
    if (child.exitCode !== null) throw new Error(`isolated relay exited ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(logs.includes("WS listening"), "isolated relay did not start");
  const url = `ws://127.0.0.1:${wsPort}/ws`;

  const hostile = await connect(url, { headers: { Origin: "https://hostile.example" } });
  assert.equal(hostile.status, 403, "non-extension browser Origin must be rejected");

  const extension = await connect(url, { headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
  assert.equal(extension.status, 101, "Chrome extension Origin must remain accepted");
  const extensionClosed = once(extension.socket, "close");
  extension.socket.close();
  await extensionClosed;

  const nodeClient = await connect(url);
  assert.equal(nodeClient.status, 101, "Node public-door client without Origin must remain accepted");
  const nodeClosed = once(nodeClient.socket, "close");
  nodeClient.socket.close();
  await nodeClosed;

  console.log("  PASS  hostile HTTPS Origin rejected with 403; chrome-extension:// and absent-Origin Node clients accepted");
} catch (error) {
  process.stderr.write(logs);
  throw error;
} finally {
  child.kill("SIGTERM");
  await once(child, "exit");
  rmSync(temp, { recursive: true, force: true });
}
