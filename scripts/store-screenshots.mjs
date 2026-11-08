/**
 * Chrome Web Store screenshots (1280x800): a throwaway relay and Chromium with the built extension,
 * enrolled through its popup, one AI tab opened by agent-browser next to the person's own tab.
 * Writes store/screenshot-*.png. Temporary state only.
 *
 *   BB_STORE_BUILD=1 npx wxt build && DISPLAY=:77 node scripts/store-screenshots.mjs
 *
 * DISPLAY must be a 1280x800 X server with no window manager (e.g. `Xvfb :77 -screen 0 1280x800x24`).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const agentBrowser = process.env.AGENT_BROWSER ?? join(process.env.HOME, ".local/share/dccb/agent-browser/0.41.2/agent-browser");
const chromium = process.env.CHROMIUM ?? "chromium";
const extensionDir = join(root, ".output/chrome-mv3");
const outDir = join(root, "store");
if (!existsSync(join(extensionDir, "manifest.json"))) throw new Error("build the extension first");
if (!process.env.DISPLAY) throw new Error("set DISPLAY to a 1280x800 X server");
mkdirSync(outDir, { recursive: true });

const temp = mkdtempSync(join(tmpdir(), "bb-store-shots-"));
const free = () => new Promise(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
const session = `bb-store-shots-${process.pid}`;
const ab = (...args) => execFileSync(agentBrowser, ["--session", session, ...args], { encoding: "utf8", timeout: 40_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

function extensionId() {
  const key = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8")).key;
  const source = key ? Buffer.from(key, "base64") : Buffer.from(realpathSync(extensionDir));
  return [...createHash("sha256").update(source).digest("hex").slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function cdpCall(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", data => { const message = JSON.parse(String(data)); if (message.id === 1) { ws.close(); message.error ? reject(new Error(message.error.message)) : resolve(message.result); } });
    ws.on("error", reject);
  });
}
const evaluate = (wsUrl, expression) => cdpCall(wsUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

try {
  const [wsPort, httpPort, chromePort] = [await free(), await free(), await free()];
  const relay = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
    cwd: root, stdio: "ignore",
    env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "relay/tokens.json"), BRIDGE_BIND_HOST: "127.0.0.2", BRIDGE_CONTROL_HTTP_HOST: "127.0.0.1", BRIDGE_WS_PORT: String(wsPort), BRIDGE_HTTP_PORT: String(httpPort), BRIDGE_TRUST_LOCAL: "0",
      BB_V8_PERSON: "demo", BB_V8_BOX_ID: "demo-box", BB_V8_ACCESS_PATH: "tailnet-direct", BB_V8_RELAY_BINDING: "demo-binding",
      BB_V8_ENROLL_ADDRESS: `http://127.0.0.2:${httpPort}`, BB_V8_WS_ENDPOINT: `ws://127.0.0.2:${wsPort}/ws` },
  });
  children.push(relay);
  const secretPath = join(temp, "relay/http-control.secret");
  for (let i = 0; i < 100 && !existsSync(secretPath); i++) await sleep(100);
  const secret = readFileSync(secretPath, "utf8").trim();
  const control = (path, body) => fetch(`http://127.0.0.1:${httpPort}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-dccb-relay-secret": secret }, body: body && JSON.stringify(body) }).then(response => response.json());
  const { setup_code: code } = await control("/api/enroll/issue", { person: "demo", box_id: "demo-box", access_path: "tailnet-direct" });

  const chrome = spawn(chromium, [`--user-data-dir=${join(temp, "profile")}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic",
    "--window-position=0,0", "--window-size=1280,800", "--lang=ko", `--load-extension=${extensionDir}`, `--remote-debugging-port=${chromePort}`,
    "https://ko.wikipedia.org/wiki/위키백과:대문"], { stdio: "ignore", env: { ...process.env, LANGUAGE: "ko" } });
  children.push(chrome);
  const id = extensionId();
  const list = () => fetch(`http://127.0.0.1:${chromePort}/json/list`).then(r => r.json());
  for (let i = 0; i < 100 && !(await list().catch(() => [])).some(t => t.url === `chrome-extension://${id}/background.js`); i++) await sleep(200);

  // Enroll through the popup page, name the device, then close that tab.
  const popup = await fetch(`http://127.0.0.1:${chromePort}/json/new?chrome-extension://${id}/popup.html`, { method: "PUT" }).then(r => r.json());
  await sleep(800);
  await evaluate(popup.webSocketDebuggerUrl, `chrome.runtime.sendMessage({ type: "setup", address: "http://127.0.0.2:${httpPort}", code: "${code}" })`);
  for (let i = 0; i < 50 && !((await control("/browsers")).browsers ?? [])[0]?.version; i++) await sleep(200);
  await evaluate(popup.webSocketDebuggerUrl, `chrome.runtime.sendMessage({ type: "setDeviceName", name: "내 노트북" })`);
  await fetch(`http://127.0.0.1:${chromePort}/json/close/${popup.id}`);

  // The AI works in its own tab group; the person's tab stays where it is.
  const cdp = `ws://127.0.0.1:${httpPort}/cdp/demo`;
  ab("--cdp", cdp, "open", "https://ko.wikipedia.org/wiki/인공지능");
  ab("snapshot", "-i");
  await sleep(1500);

  // 1. The browser window: the person's tab in front, the AI's tab in the "AI · 내 노트북" group.
  execFileSync("import", ["-window", "root", "-crop", "1280x800+0+0", join(outDir, "screenshot-1-group.png")]);

  // 2. The AI tab brought forward (only for the picture; the bridge itself never does this).
  const aiTab = (await list()).find(t => t.type === "page" && decodeURI(t.url).includes("인공지능"));
  if (aiTab) await fetch(`http://127.0.0.1:${chromePort}/json/activate/${aiTab.id}`);
  await sleep(1200);
  execFileSync("import", ["-window", "root", "-crop", "1280x800+0+0", join(outDir, "screenshot-2-ai-tab.png")]);

  // 3. The popup, connected, rendered at its own size.
  const shown = await fetch(`http://127.0.0.1:${chromePort}/json/new?chrome-extension://${id}/popup.html`, { method: "PUT" }).then(r => r.json());
  await sleep(1200);
  await cdpCall(shown.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: 340, height: 720, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  // The throwaway relay's loopback address and a percent-encoded URL read badly in a picture.
  await evaluate(shown.webSocketDebuggerUrl, `document.getElementById("connected-address").textContent = "https://my-home.example.net"; const info = document.getElementById("target-info"); info.textContent = decodeURI(info.textContent); 1`);
  const { result: height } = await evaluate(shown.webSocketDebuggerUrl, "Math.ceil(document.body.getBoundingClientRect().height)");
  const shot = await cdpCall(shown.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 340, height: height.value, scale: 1 } });
  writeFileSync(join(temp, "popup.png"), Buffer.from(shot.data, "base64"));
  execFileSync("python3", [join(root, "scripts/store-compose.py"), join(temp, "popup.png"), join(outDir, "screenshot-3-popup.png")]);
  console.log(`wrote ${outDir}/screenshot-{1-group,2-ai-tab,3-popup}.png`);
} finally {
  try { ab("close"); } catch {}
  for (const child of children) child.kill("SIGTERM");
  await sleep(500);
  rmSync(temp, { recursive: true, force: true });
}
