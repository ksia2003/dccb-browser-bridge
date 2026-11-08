/** Pipe relay (1.1.0): the engine-facing CDP session and endpoint, with a fake extension and a fake engine. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { PipeSession } from "../server/pipe/session.ts";
import { createPipeEndpoint, PIPE_EXTENSION_INCIDENT } from "../server/pipe/endpoint.ts";

/** A fake extension: two tabs in the work space, answers chrome.* commands like lib/pipe.ts. */
function fakeExtension() {
  const commands = [];
  const tabs = new Map([[11, { id: 11, index: 0, windowId: 1, url: "https://example.com/", title: "Example", active: false, pinned: false }]]);
  let nextTab = 12;
  const answer = (method, params) => {
    commands.push(method === "chrome.debugger.sendCommand" ? `${method} ${params[1]}` : method);
    if (method === "chrome.debugger.attach") return {};
    if (method === "chrome.debugger.sendCommand" && params[1] === "Target.getTargetInfo") {
      const tab = tabs.get(params[0].tabId);
      return { targetInfo: { targetId: `T${tab.id}`, type: "page", title: tab.title, url: tab.url, attached: false } };
    }
    if (method === "chrome.debugger.sendCommand") return { echoed: params[1], tabId: params[0].tabId, sessionId: params[0].sessionId };
    if (method === "chrome.tabs.create") {
      const tab = { id: nextTab++, index: 1, windowId: 1, url: params[0].url, title: "", active: params[0].active, pinned: false };
      tabs.set(tab.id, tab);
      return tab;
    }
    if (method === "chrome.tabs.remove") return {};
    throw new Error(`Unknown method: ${method}`);
  };
  return { commands, tabs, answer };
}

function harness() {
  const extension = fakeExtension();
  const toClient = [];
  let session;
  session = new PipeSession({
    channel: "c1",
    toExtension: frame => queueMicrotask(() => {
      try { session.onExtensionResponse(frame.id, extension.answer(frame.method, frame.params), undefined); }
      catch (error) { session.onExtensionResponse(frame.id, undefined, error.message); }
    }),
    toClient: message => toClient.push(message),
  });
  for (const tab of extension.tabs.values()) session.onExtensionEvent("chrome.tabs.onCreated", [tab]);
  session.onExtensionEvent("extension.initialized", []);
  let id = 0;
  const call = async (method, params, sessionId) => {
    const callId = ++id;
    await session.onClientMessage({ id: callId, method, params, sessionId });
    return toClient.find(message => message.id === callId);
  };
  return { session, extension, toClient, call };
}

{
  // agent-browser's connect sequence (discover → getTargets → attach) reuses the work space's tab.
  const { extension, toClient, call } = harness();
  assert.deepEqual((await call("Target.setDiscoverTargets", { discover: true })).result, {});
  const targets = (await call("Target.getTargets", {})).result.targetInfos;
  assert.deepEqual(targets.map(target => target.targetId), ["T11"], "the existing group tab is offered, no new tab");
  assert.ok(toClient.some(message => message.method === "Target.targetCreated"), "discover mode announces targetCreated");
  assert.ok(!toClient.some(message => message.method === "Target.attachedToTarget"), "discover mode does not push attachedToTarget");
  const { sessionId } = (await call("Target.attachToTarget", { targetId: "T11", flatten: true })).result;
  const forwarded = (await call("Runtime.evaluate", { expression: "1" }, sessionId)).result;
  assert.deepEqual(forwarded, { echoed: "Runtime.evaluate", tabId: 11, sessionId: undefined });
  assert.ok(!extension.commands.includes("chrome.tabs.create"), "no tab was opened");
  console.log("  PASS  agent-browser discovery attaches to the work space's existing tab");
}

{
  // The AI works in the background: nothing raises the person's tab, Browser.close never closes Chrome.
  const { extension, call } = harness();
  await call("Target.setDiscoverTargets", { discover: true });
  assert.deepEqual((await call("Target.activateTarget", { targetId: "T11" })).result, {});
  assert.deepEqual((await call("Page.bringToFront", {}, "pw-tab-1")).result, {});
  assert.deepEqual((await call("Browser.close", {})).result, {});
  const created = await call("Target.createTarget", { url: "https://example.org/" });
  assert.equal(created.result.targetId, "T12");
  assert.ok(!extension.commands.some(command => /activateTarget|bringToFront|Browser\.close/.test(command)), "none reached the extension");
  assert.equal([...extension.tabs.values()].find(tab => tab.id === 12).active, false, "new tabs open inactive");
  const refused = await call("Target.createBrowserContext", {});
  assert.match(refused.error.message, /not available on a person's Chrome/);
  console.log("  PASS  background mode: no activation, no Browser.close, inactive new tabs, no browser contexts");
}

{
  // Playwright's auto-attach path still works (unchanged upstream behaviour).
  const { toClient, call } = harness();
  await call("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
  assert.ok(toClient.some(message => message.method === "Target.attachedToTarget" && message.params.targetInfo.targetId === "T11"));
  console.log("  PASS  Playwright auto-attach announces the existing tab");
}

{
  // An extension error answers the engine's command with that error (never a silent success).
  const { call } = harness();
  await call("Target.setDiscoverTargets", { discover: true });
  const { sessionId } = (await call("Target.attachToTarget", { targetId: "T11", flatten: true })).result;
  const unknown = await call("Target.attachToTarget", { targetId: "nope" });
  assert.match(unknown.error.message, /No target with given id/);
  const closedSession = new PipeSession({ channel: "c2", toExtension: () => {}, toClient: () => {} });
  closedSession.onExtensionEvent("extension.error", ["사람이 작업 중입니다"]);
  await assert.rejects(closedSession.ready(), /사람이 작업 중/);
  assert.ok(sessionId);
  console.log("  PASS  errors from the extension and refused work spaces reach the engine");
}

{
  // Endpoint: only this account, valid work space names, extension ≥ 1.1.0, one engine per work space.
  const reports = [];
  const sent = [];
  const fakeBrowserWs = { readyState: 1, OPEN: 1 };
  let version = "1.0.9";
  const endpoint = createPipeEndpoint({
    findBrowser: () => ({ id: "b1", name: "Windows의 Chrome", ws: fakeBrowserWs, version }),
    send: (_ws, message) => {
      sent.push(message);
      if (message.type === "pipe_open") queueMicrotask(() => endpoint.onExtensionFrame(fakeBrowserWs, { type: "pipe_event", channel: message.channel, method: "extension.initialized", params: [] }));
    },
    log: () => {},
    report: (id, text) => reports.push([id, text]),
  });
  const server = createServer((_req, res) => res.end());
  server.on("upgrade", (req, socket, head) => { if (!endpoint.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const open = path => new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.once("open", () => resolve({ ws, status: 101 }));
    ws.once("unexpected-response", (_req, res) => { let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body })); });
    ws.once("error", () => resolve({ status: 0 }));
  });

  const old = await open("/cdp/default");
  assert.equal(old.status, 426);
  assert.match(old.body, /1\.0\.9.*pc-browser를 지원하지 않습니다/);
  assert.equal(reports.at(-1)[0], PIPE_EXTENSION_INCIDENT, "an old extension is a HOME incident, not only a log line");

  version = "1.1.0";
  assert.equal((await open("/cdp/bad%20name")).status, 400);
  const first = await open("/cdp/research");
  assert.equal(first.status, 101);
  assert.equal(sent.find(message => message.type === "pipe_open").workspace, "research");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(reports.at(-1), [PIPE_EXTENSION_INCIDENT, undefined], "a working pipe clears the incident");
  const second = await open("/cdp/research");
  assert.equal(second.status, 409);
  first.ws.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(sent.some(message => message.type === "pipe_close"), "the extension hears that the engine left");
  const again = await open("/cdp/research");
  assert.equal(again.status, 101, "the work space is free again");
  endpoint.onBrowserClosed(fakeBrowserWs);
  await new Promise(resolve => again.ws.once("close", resolve));
  assert.equal((await open("/cdp/a/b/c")).status, 0, "other paths are not the pipe");
  server.close();
  console.log("  PASS  endpoint: work space names, old extension incident, one engine per work space, Chrome disconnect ends the engine");
}
