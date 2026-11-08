/** HOME-local control HTTP authentication smoke test; starts an isolated relay. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "bb-http-control-"));

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

async function responseWithRetry(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return await fetch(url); }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new Error("isolated relay did not start");
}

const wsPort = await freePort();
let httpPort = await freePort();
while (httpPort === wsPort) httpPort = await freePort();
const tokenFile = join(temp, "state", "tokens.json");
const child = spawn(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    BB_V6_TOKENS_FILE: tokenFile,
    BRIDGE_BIND_HOST: "127.0.0.1",
    BRIDGE_WS_PORT: String(wsPort),
    BRIDGE_HTTP_PORT: String(httpPort),
    BRIDGE_TRUST_LOCAL: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.setEncoding("utf8").on("data", value => { logs += value; });
child.stderr.setEncoding("utf8").on("data", value => { logs += value; });

try {
  const base = `http://127.0.0.1:${httpPort}`;
  const unauthenticated = await responseWithRetry(`${base}/browsers`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("access-control-allow-origin"), null);

  const secretPath = join(temp, "state", "http-control.secret");
  const secretMode = statSync(secretPath).mode & 0o777;
  const secret = readFileSync(secretPath, "utf8").trim();
  assert.equal(secretMode, 0o600);
  assert.match(secret, /^[a-f0-9]{64}$/);

  const wrong = await fetch(`${base}/browsers`, { headers: { "x-dccb-relay-secret": "wrong" } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("access-control-allow-origin"), null);

  const valid = await fetch(`${base}/browsers`, { headers: { "x-dccb-relay-secret": secret } });
  assert.equal(valid.status, 503); // Authorized; no extension is attached to this isolated relay.
  assert.equal(valid.headers.get("access-control-allow-origin"), null);

  const issueWithoutSecret = await fetch(`${base}/api/enroll/issue`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(issueWithoutSecret.status, 401);
  const issueWithSecret = await fetch(`${base}/api/enroll/issue`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dccb-relay-secret": secret },
    body: "{}",
  });
  assert.equal(issueWithSecret.status, 400);

  const protectedPreflight = await fetch(`${base}/send`, { method: "OPTIONS" });
  assert.equal(protectedPreflight.status, 401);
  assert.equal(protectedPreflight.headers.get("access-control-allow-origin"), null);

  // Extension callback routes remain capability-authenticated and never gain CORS.
  const refresh = await fetch(`${base}/api/auth/refresh`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: "unknown" }),
  });
  assert.equal(refresh.headers.get("access-control-allow-origin"), null);
  assert.notEqual((await refresh.json()).error, "missing_relay_secret");

  for (const path of ["/api/auth/refresh", "/api/enroll/redeem"]) {
    for (const body of ["null", "[]", "17", '"not-an-object"']) {
      const invalid = await fetch(`${base}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      assert.equal(invalid.status, 400, `${path} must reject JSON ${body} as an invalid object`);
      assert.deepEqual(await invalid.json(), { error: "invalid_request" });
    }
  }
  const stillAlive = await fetch(`${base}/browsers`, { headers: { "x-dccb-relay-secret": secret } });
  assert.equal(stillAlive.status, 503);

  console.log("  PASS  HOME HTTP secret is 0600; callback JSON must be an object, malformed callbacks return 400, relay stays live, and no CORS is emitted");
} catch (error) {
  process.stderr.write(logs);
  throw error;
} finally {
  child.kill("SIGTERM");
  await once(child, "exit");
  rmSync(temp, { recursive: true, force: true });
}
