/**
 * Pipe live check (1.1.0): a real relay, a real Chromium with the built extension enrolled through
 * its popup, and agent-browser driving it over /cdp. Everything lives in a temporary folder.
 * Like a HOME relay, the public side (WS, enrollment) is on another address (127.0.0.2) and
 * 127.0.0.1 is the separate control server the engine connects to.
 *
 *   npx wxt build && DISPLAY=:77 AGENT_BROWSER=<path> node test/pipe.live.mjs
 *
 * Run it before raising the agent-browser version DCCB pins: the relay imitates the Target
 * discovery commands agent-browser uses, so a new agent-browser may need a change here.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const agentBrowser = process.env.AGENT_BROWSER ?? join(process.env.HOME, ".local/share/dccb/agent-browser/0.41.2/agent-browser");
const chromium = process.env.CHROMIUM ?? "chromium";
const extensionDir = join(root, ".output/chrome-mv3");
if (!existsSync(join(extensionDir, "manifest.json"))) throw new Error("build the extension first: npx wxt build");
if (!process.env.DISPLAY) throw new Error("set DISPLAY to an X server (e.g. Xvfb :77)");

const temp = mkdtempSync(join(tmpdir(), "bb-pipe-live-"));
const free = () => new Promise(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
const session = `bb-pipe-live-${process.pid}`;

function extensionId() {
  const key = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8")).key;
  return [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once("error", reject);
    ws.once("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })));
    ws.on("message", data => { const message = JSON.parse(data); if (message.id === 1) { ws.close(); resolve(message.result?.result?.value); } });
  });
}

const ab = (...args) => {
  try { return { ok: true, out: execFileSync(agentBrowser, ["--session", session, ...args], { encoding: "utf8", timeout: 40_000, stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (error) { return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() }; }
};

try {
  const [wsPort, httpPort, chromePort] = [await free(), await free(), await free()];
  const relay = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "server/index.ts"], {
    cwd: root, stdio: "ignore",
    env: { ...process.env, BB_V6_TOKENS_FILE: join(temp, "relay/tokens.json"), BRIDGE_BIND_HOST: "127.0.0.2", BRIDGE_CONTROL_HTTP_HOST: "127.0.0.1", BRIDGE_WS_PORT: String(wsPort), BRIDGE_HTTP_PORT: String(httpPort), BRIDGE_TRUST_LOCAL: "0",
      BB_V8_PERSON: "live", BB_V8_BOX_ID: "live-box", BB_V8_ACCESS_PATH: "tailnet-direct", BB_V8_RELAY_BINDING: "live-binding",
      BB_V8_ENROLL_ADDRESS: `http://127.0.0.2:${httpPort}`, BB_V8_WS_ENDPOINT: `ws://127.0.0.2:${wsPort}/ws` },
  });
  children.push(relay);
  const secretPath = join(temp, "relay/http-control.secret");
  for (let i = 0; i < 100 && !existsSync(secretPath); i++) await sleep(100);
  const secret = readFileSync(secretPath, "utf8").trim();
  const control = (path, body) => fetch(`http://127.0.0.1:${httpPort}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-dccb-relay-secret": secret }, body: body && JSON.stringify(body) }).then(response => response.json());
  const { setup_code: code } = await control("/api/enroll/issue", { person: "live", box_id: "live-box", access_path: "tailnet-direct" });

  const chrome = spawn(chromium, [`--user-data-dir=${join(temp, "profile")}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", `--load-extension=${extensionDir}`, `--remote-debugging-port=${chromePort}`, "about:blank"], { stdio: "ignore" });
  children.push(chrome);
  const id = extensionId();
  let worker;
  for (let i = 0; i < 100 && !worker; i++) {
    await sleep(200);
    worker = await fetch(`http://127.0.0.1:${chromePort}/json/list`).then(r => r.json()).then(list => list.find(t => t.url === `chrome-extension://${id}/background.js`)).catch(() => undefined);
  }
  assert.ok(worker, "the extension's service worker started");
  const popup = await fetch(`http://127.0.0.1:${chromePort}/json/new?chrome-extension://${id}/popup.html`, { method: "PUT" }).then(r => r.json());
  await sleep(800);
  await evaluate(popup.webSocketDebuggerUrl, `chrome.runtime.sendMessage({ type: "setup", address: "http://127.0.0.2:${httpPort}", code: "${code}" })`);
  let browsers = [];
  for (let i = 0; i < 50 && !browsers[0]?.version; i++) { await sleep(200); browsers = (await control("/browsers")).browsers ?? []; }
  assert.equal(browsers[0]?.version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "the enrolled extension reports its version");
  console.log("  PASS  extension enrolled through its popup");

  const pages = async () => (await fetch(`http://127.0.0.1:${chromePort}/json/list`).then(r => r.json())).filter(t => t.type === "page" && !t.url.startsWith("chrome")).map(t => t.url);
  const cdp = `ws://127.0.0.1:${httpPort}/cdp/live`;
  assert.ok(ab("--cdp", cdp, "open", "https://example.com/").ok);
  const page = `document.body.innerHTML='<input id=t><button id=b onclick="this.textContent=\\'clicked\\'">go</button><div style=height:2500px></div><button id=far onclick="this.textContent=\\'far-ok\\'">far</button>'; 1`;
  assert.ok(ab("eval", page).ok);
  assert.ok(ab("click", "#b").ok); assert.equal(ab("get", "text", "#b").out, "clicked");
  assert.ok(ab("fill", "#t", "hello").ok); assert.equal(ab("get", "value", "#t").out, "hello");
  assert.ok(ab("click", "#far").ok); assert.equal(ab("get", "text", "#far").out, "far-ok");
  // Drag in the background tab: press, ten moves with the button held, release (PC 11-07: 9.7-10.7 s
  // minimized or covered, one draw-and-ack wait per move).
  assert.ok(ab("eval", `document.body.insertAdjacentHTML('afterbegin','<div id=src style=width:40px;height:40px>s</div><div id=dst style=width:40px;height:40px>d</div>');window.drag={down:0,move:0,up:0};addEventListener('mousedown',()=>drag.down++);addEventListener('mousemove',e=>{if(e.buttons)drag.move++});addEventListener('mouseup',()=>drag.up++);window.scrollTo(0,0);1`).ok);
  const dragStart = Date.now();
  assert.ok(ab("drag", "#src", "#dst").ok);
  const dragMs = Date.now() - dragStart;
  const dragEvents = JSON.parse(JSON.parse(ab("eval", "JSON.stringify(drag)").out));
  assert.ok(dragEvents.down === 1 && dragEvents.move >= 1 && dragEvents.up === 1, JSON.stringify(dragEvents));
  console.log(`  PASS  background drag: ${JSON.stringify(dragEvents)} in ${dragMs} ms`);
  const shot = join(temp, "shot.png");
  assert.ok(ab("screenshot", shot).ok && existsSync(shot), "screenshot (the AI tab is in the background)");
  console.log("  PASS  open, click, fill, off-screen click, background screenshot");

  // The old Bridge network tool used to continue every paused request, so the engine's mock failed.
  assert.ok(ab("network", "route", "https://example.com/mock", "--body", '{"mocked":1}').ok);
  assert.match(ab("eval", "fetch('https://example.com/mock').then(r => r.text())").out, /mocked/);
  console.log("  PASS  network route mock");

  const before = (await pages()).length;
  for (let i = 1; i <= 3; i++) {
    assert.ok(ab("close").ok);
    assert.ok(ab("--cdp", cdp, "open", `https://example.org/?run=${i}`).ok);
  }
  assert.equal((await pages()).length, before, "reconnecting reuses the work space's tab");
  console.log("  PASS  three reconnects open no new tab");

  // Another work space uses the same one AI group (owner 11-08: no group per work space).
  execFileSync(agentBrowser, ["--session", `${session}-ws2`, "--cdp", `ws://127.0.0.1:${httpPort}/cdp/second`, "open", "https://example.org/"], { stdio: "ignore", timeout: 40_000 });
  execFileSync(agentBrowser, ["--session", `${session}-ws2`, "close"], { stdio: "ignore", timeout: 40_000 });
  const sw = (await fetch(`http://127.0.0.1:${chromePort}/json/list`).then(r => r.json())).find(t => t.url === `chrome-extension://${id}/background.js`);
  const titles = await evaluate(sw.webSocketDebuggerUrl, "chrome.tabGroups.query({}).then(groups => groups.map(group => group.title))");
  assert.deepEqual(titles, ["AI · Linux의 Chrome"], "one AI group for both work spaces");
  console.log("  PASS  a second work space shares the one AI group");

  // The extension's own tools that stay in 1.2.0 (fetch, notify, handoff, extension) still answer
  // over /send; a page tool that moved to the pipe says so.
  const send = body => control("/send", body);
  const fetched = await send({ tool: "fetch", args: { url: "https://example.com/" } });
  assert.equal(fetched.result?.status, 200, JSON.stringify(fetched).slice(0, 200));
  assert.equal((await send({ tool: "notify", args: { message: "pipe live" } })).result?.ok, true);
  assert.equal((await send({ tool: "extension", args: {} })).result?.version, browsers[0].version);
  assert.match((await send({ tool: "handoff", args: { message: "live", timeoutSec: 1, workspace: "live" } })).error ?? "", /사람 응답 없음\(1초\)/);
  assert.match((await send({ tool: "page", args: { action: "snapshot" } })).error ?? "", /unknown_tool: page .*pc-browser/);
  console.log("  PASS  the extension's own tools: fetch, notify, handoff (times out honestly), extension; old page tools are gone");

  const other = execFileSync(agentBrowser, ["--session", `${session}-2`, "--cdp", cdp, "open", "https://example.com/"], { encoding: "utf8", timeout: 40_000, stdio: ["ignore", "pipe", "pipe"] }).toString();
  assert.fail(`a second engine on the same work space must be refused, got: ${other}`);
} catch (error) {
  if (!(error instanceof assert.AssertionError) && /409 Conflict/.test(`${error.stdout ?? ""}${error.stderr ?? ""}${error.message}`)) {
    console.log("  PASS  a second engine on the same work space is refused (409)");
  } else {
    throw error;
  }
} finally {
  ab("close");
  for (const child of children) child.kill("SIGTERM");
  await sleep(500);
  rmSync(temp, { recursive: true, force: true });
}
