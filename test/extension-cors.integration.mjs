/**
 * The extension's two bootstrap routes answer CORS to a chrome-extension:// origin only (6.0.0): a
 * person who limited the extension's site access in Chrome could otherwise not connect, since Chrome
 * then preflights the extension's JSON POST. Runs against an isolated local relay process.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "bb-cors-"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const free = () => new Promise(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const [wsPort, httpPort] = [await free(), await free()];
const relay = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "state/tokens.json"), BRIDGE_BIND_HOST: "127.0.0.2", BRIDGE_CONTROL_HTTP_HOST: "127.0.0.1",
    BRIDGE_WS_PORT: String(wsPort), BRIDGE_HTTP_PORT: String(httpPort), BRIDGE_TRUST_LOCAL: "0" },
});
const preflight = (path, origin, extra = {}) => fetch(`http://127.0.0.2:${httpPort}${path}`, { method: "OPTIONS",
  headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type", ...extra } });
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.2:${httpPort}/`); break; } catch { await sleep(100); } }
  const extension = "chrome-extension://kfdhdklmlpeagfgiebhmflmbnagifooc";
  for (const path of ["/api/enroll/redeem", "/api/auth/refresh"]) {
    const ok = await preflight(path, extension, { "Access-Control-Request-Private-Network": "true" });
    assert.equal(ok.headers.get("access-control-allow-origin"), extension, path);
    assert.match(ok.headers.get("access-control-allow-headers") ?? "", /content-type/);
    assert.equal(ok.headers.get("access-control-allow-private-network"), "true");
    const page = await preflight(path, "https://evil.example");
    assert.equal(page.headers.get("access-control-allow-origin"), null, `a web page gets no CORS on ${path}`);
  }
  const redeem = await fetch(`http://127.0.0.2:${httpPort}/api/enroll/redeem`, { method: "POST", headers: { Origin: extension, "content-type": "application/json" }, body: "{}" });
  assert.equal(redeem.headers.get("access-control-allow-origin"), extension, "the extension can read the answer");
  const control = await preflight("/send", extension);
  assert.equal(control.headers.get("access-control-allow-origin"), null, "control routes never answer CORS");
  console.log("  PASS  the bootstrap routes answer CORS to the extension only, so limited site access still connects");
} finally {
  relay.kill("SIGTERM");
  await sleep(300);
  rmSync(temp, { recursive: true, force: true });
}
