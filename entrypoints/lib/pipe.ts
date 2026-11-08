/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Source: microsoft/playwright@1af60d94ac714d4007828bafa02b0f1cbd8646b9
//   packages/extension/src/relayConnection.ts (protocol v2: the five forwarded chrome.* commands,
//   the four forwarded events, extension.initialized).
// Modified by DCCB (2026-11-06) — Browser Bridge 1.1.0 pipe:
//   - frames ride Browser Bridge's relay WebSocket as pipe_* messages, one channel per engine;
//   - a channel may attach only to the tabs the AI opened for its work space (lib/target.ts; the
//     original accepts any tabId); the next engine of the work space gets those tabs back instead
//     of a new one (owner 11-06); they close only when the AI says it is done, and not once the
//     person has looked at them (6.0.0, owner 11-08);
//   - attach goes through lib/cdp.ts: focus emulation, the mute guard, Bridge on/off;
//   - Input.* goes through cdp.sendInput (Claude in Chrome's draw-if-held, 5 s acknowledgement:
//     an unacknowledged input is an error, never a silent "done");
//   - Page.captureScreenshot falls back to the first Page.startScreencast frame when the window is
//     minimized or covered (measured on Windows 11 / Chrome 157, research 05-pipe-trial);
//   - a held input draws the tab with one screencast frame, not a screenshot: a covered window
//     leaves Page.captureScreenshot unanswered, so each click cost 3 × 2 s (owner PC 11-07).

import * as cdp from "./cdp";
import { closedByPerson, createControlledTab, isControlledTab, listDccbTabs, normalizeWorkspace, releaseTab, removeAiTabs, setClosedByPerson, wasSeen } from "./target";
import type { PipeCommand, PipeEvent, PipeResponse } from "../../shared/protocol";

type Send = (frame: PipeResponse | PipeEvent) => void;

interface Channel {
  workspace: string;
  /** Tabs this channel attached to; events of only these tabs are forwarded. */
  attached: Set<number>;
  /** Tabs announced to the engine (the work space's tabs plus tabs it created or that they opened). */
  known: Set<number>;
  /** Tabs where the engine runs its own screencast. */
  screencasts: Set<number>;
}

const channels = new Map<string, Channel>();
let send: Send = () => {};
let onChange: () => void = () => {};
/** Why Chrome refuses AI work right now (not enrolled), or null. */
let refusal: () => string | null = () => null;
/** Tabs whose screenshot fallback is running: their screencast frames are ours, not the engine's. */
const screencastOwners = new Map<number, (data: string, sessionId: number) => void>();

const CAPTURE_WAIT_MS = 1_500;
const SCREENCAST_WAIT_MS = 8_000;
const DRAW_FRAME_WAIT_MS = 2_000;

/**
 * The AI is done: a tab the person has looked at (to log in, solve a captcha, see the result) or
 * has in front of them now becomes theirs; the rest close.
 */
async function letGo(tabs: chrome.tabs.Tab[]): Promise<number[]> {
  const closing: number[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    if (tab.active || await wasSeen(tab.id)) await releaseTab(tab.id);
    else closing.push(tab.id);
  }
  if (closing.length) await removeAiTabs(closing).catch(error => console.log("[bb pipe] closing AI tabs failed", String(error)));
  return closing;
}

/** The AI is done with a work space (`pc-browser close`): its tabs close now. */
/** What the engine hears when it tries to open a tab after the person closed the AI's last one. */
export const PERSON_CLOSED_MESSAGE = "the person closed the AI's tab. Ask them in chat whether to go on; if they agree, run pc-browser close and start again.";

export async function closeWorkspaceTabs(workspaceValue: unknown): Promise<number[]> {
  const workspace = normalizeWorkspace(workspaceValue);
  const closed = await letGo(await listDccbTabs(workspace));
  // The AI finished; whatever the person closed before, the next task may open a tab again.
  await setClosedByPerson(workspace, false);
  onChange();
  return closed;
}


export function pipeChannelCount(): number {
  return channels.size;
}

function tabForWire(tab: chrome.tabs.Tab) {
  return { id: tab.id, index: tab.index, windowId: tab.windowId, openerTabId: tab.openerTabId, url: tab.url, title: tab.title, active: tab.active, pinned: tab.pinned };
}

function debuggable(tab: chrome.tabs.Tab): boolean {
  const url = tab.url ?? tab.pendingUrl ?? "";
  return tab.id !== undefined && !/^(chrome|chrome-extension|devtools|edge):/i.test(url);
}

function event(channel: string, method: string, params: unknown[]): void {
  send({ type: "pipe_event", channel, method, params });
}

/** Install the chrome.* listeners once; `sendFrame` writes to the relay socket. */
export function installPipe(sendFrame: Send, changed: () => void, refuse: () => string | null): void {
  send = sendFrame;
  onChange = changed;
  refusal = refuse;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    if (method === "Page.screencastFrame" && !(source as { sessionId?: string }).sessionId) {
      const owner = screencastOwners.get(source.tabId);
      if (owner) {
        const frame = params as { data: string; sessionId: number };
        owner(frame.data, frame.sessionId);
        return;
      }
    }
    for (const [id, channel] of channels) {
      if (channel.attached.has(source.tabId)) event(id, "chrome.debugger.onEvent", [source, method, params]);
    }
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    for (const [id, channel] of channels) {
      if (!channel.attached.delete(source.tabId)) continue;
      event(id, "chrome.debugger.onDetach", [source, reason]);
    }
  });
  chrome.tabs.onCreated.addListener(tab => {
    // A tab opened by a channel's tab (window.open, target=_blank) joins that work space.
    if (tab.id === undefined || tab.openerTabId === undefined) return;
    for (const [id, channel] of channels) {
      if (!channel.known.has(tab.openerTabId)) continue;
      channel.known.add(tab.id);
      event(id, "chrome.tabs.onCreated", [tabForWire(tab)]);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    for (const [id, channel] of channels) {
      if (!channel.known.delete(tabId)) continue;
      channel.attached.delete(tabId);
      event(id, "chrome.tabs.onRemoved", [tabId, removeInfo]);
    }
  });
}

/** Open a channel: announce the work space's tabs, opening one background tab only when it has none. */
export async function openPipe(channel: string, workspaceValue: string): Promise<void> {
  try {
    const refused = refusal();
    if (refused) throw new Error(refused);
    const workspace = normalizeWorkspace(workspaceValue);
    const entry: Channel = { workspace, attached: new Set(), known: new Set(), screencasts: new Set() };
    channels.set(channel, entry);
    let tabs = (await listDccbTabs(workspace)).filter(debuggable);
    // No tab to give back: open one, unless the person closed the last one (the engine then hears
    // why when it tries to open a page).
    if (tabs.length === 0 && !(await closedByPerson(workspace))) tabs = [await createControlledTab("about:blank", workspace)];
    for (const tab of tabs) {
      entry.known.add(tab.id!);
      event(channel, "chrome.tabs.onCreated", [tabForWire(tab)]);
    }
    event(channel, "extension.initialized", []);
    onChange();
  } catch (error) {
    channels.delete(channel);
    const message = error instanceof Error ? error.message : String(error);
    event(channel, "extension.error", [message]);
  }
}

/** A tab an engine is driving right now: the old Bridge tools leave its events to the engine. */
export function pipeDrives(tabId: number): boolean {
  return [...channels.values()].some(entry => entry.attached.has(tabId));
}

export function closePipe(channel: string): void {
  const entry = channels.get(channel);
  if (!entry) return;
  channels.delete(channel);
  // The engine left (pc-browser's 3 idle minutes, a crash, or before `close`). Its tabs stay for the
  // next engine of this work space; nothing closes on a timer (owner 11-08). The debugger lets go so
  // Chrome's "started debugging" bar goes away; the next engine attaches again.
  releaseDebugger(entry);
  onChange();}

/** The relay socket closed (relay restart, network, service worker): the same as every engine leaving. */
export function closeAllPipes(): void {
  const entries = [...channels.values()];
  channels.clear();
  for (const entry of entries) releaseDebugger(entry);
  onChange();
}

/** Detach from the tabs a gone engine was attached to, unless another engine still uses them. */
function releaseDebugger(entry: Channel): void {
  const inUse = new Set([...channels.values()].flatMap(other => [...other.attached]));
  for (const tabId of entry.attached) if (!inUse.has(tabId)) void cdp.detach(tabId).catch(() => undefined);
  entry.attached.clear();
}

async function owned(entry: Channel, tabId: unknown): Promise<number> {
  if (typeof tabId !== "number") throw new Error("tabId (number) is required");
  if (entry.known.has(tabId) || await isControlledTab(tabId, entry.workspace)) {
    entry.known.add(tabId);
    return tabId;
  }
  throw new Error(`tab ${tabId} is not in this AI work space; only tabs the AI opened for "${entry.workspace}" can be driven`);
}

/**
 * Draw one frame for an input Chromium is holding. Like cdp.drawTab, but with a screencast frame:
 * a covered window does not answer Page.captureScreenshot and a screencast frame still comes.
 */
async function drawFrame(tabId: number): Promise<void> {
  // The engine's own screencast (agent-browser record/stream) already makes frames; never stop it.
  if (screencastOwners.has(tabId) || [...channels.values()].some(entry => entry.screencasts.has(tabId))) return;
  const tab = await chrome.tabs.get(tabId);
  if ((await chrome.windows.get(tab.windowId)).state === "minimized") return;
  const frame = new Promise<void>(resolve => {
    const timer = setTimeout(() => { screencastOwners.delete(tabId); resolve(); }, DRAW_FRAME_WAIT_MS);
    screencastOwners.set(tabId, (_data, sessionId) => {
      clearTimeout(timer);
      screencastOwners.delete(tabId);
      void cdp.send(tabId, "Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      resolve();
    });
  });
  try {
    await cdp.send(tabId, "Page.startScreencast", { format: "jpeg", quality: 1, maxWidth: 64, maxHeight: 64, everyNthFrame: 1 });
    await frame;
  } catch {
    // No frame: the input still waits for its acknowledgement and fails honestly after 5 s.
    screencastOwners.delete(tabId);
  } finally {
    void cdp.send(tabId, "Page.stopScreencast").catch(() => undefined);
  }
}

/** Viewport screenshot that still works when the window is minimized or covered. */
async function captureScreenshot(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  // A minimized window answers capture late or never (PC 11-06: time-outs and 3 s); go straight to the screencast.
  const minimized = (await chrome.windows.get((await chrome.tabs.get(tabId)).windowId)).state === "minimized";
  if (!minimized || params.clip || params.captureBeyondViewport) {
    const capture = cdp.send(tabId, "Page.captureScreenshot", params);
    const quick = await Promise.race([
      capture.then(result => ({ result }), (error: unknown) => ({ error })),
      new Promise<null>(resolve => setTimeout(() => resolve(null), CAPTURE_WAIT_MS)),
    ]);
    if (quick && "result" in quick) return quick.result;
    if (quick && "error" in quick) throw quick.error;
    void capture.catch(() => undefined);
  }
  if (params.clip || params.captureBeyondViewport) {
    throw new Error("Chrome 창이 최소화되었거나 가려져 있어 부분·전체 페이지 스크린샷을 찍지 못했습니다. 화면에 보이는 영역 스크린샷은 됩니다.");
  }
  const format = params.format === "jpeg" || params.format === "webp" ? "jpeg" : "png";
  const frame = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      screencastOwners.delete(tabId);
      reject(new Error("Chrome 창이 최소화되었거나 가려져 있어 8초 안에 화면을 받지 못했습니다. Chrome 창을 화면에 띄워 달라고 요청하세요."));
    }, SCREENCAST_WAIT_MS);
    screencastOwners.set(tabId, (data, sessionId) => {
      clearTimeout(timer);
      screencastOwners.delete(tabId);
      void cdp.send(tabId, "Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      resolve(data);
    });
  });
  await cdp.send(tabId, "Page.startScreencast", { format, ...(format === "jpeg" ? { quality: Number(params.quality ?? 80) } : {}), everyNthFrame: 1 });
  try {
    const data = await frame;
    return { data };
  } catch (error) {
    // The AI gets this error and retries; nothing for the person to do.
    console.log("[bb-v6 pipe] screenshot frame failed", tabId, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    void cdp.send(tabId, "Page.stopScreencast").catch(() => undefined);
  }
}

async function run(channelId: string, entry: Channel, method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case "chrome.debugger.attach": {
      const tabId = await owned(entry, (params[0] as { tabId?: unknown })?.tabId);
      await cdp.ensureAttached(tabId);
      entry.attached.add(tabId);
      return {};
    }
    case "chrome.debugger.detach": {
      const tabId = await owned(entry, (params[0] as { tabId?: unknown })?.tabId);
      entry.attached.delete(tabId);
      return {};
    }
    case "chrome.debugger.sendCommand": {
      const target = params[0] as { tabId?: unknown; sessionId?: string };
      const tabId = await owned(entry, target?.tabId);
      if (!entry.attached.has(tabId)) throw new Error(`tab ${tabId} is not attached`);
      const cdpMethod = String(params[1]);
      const cdpParams = (params[2] ?? {}) as Record<string, unknown>;
      if (cdpMethod.startsWith("Input.")) return await cdp.sendInput(tabId, cdpMethod, cdpParams, { sessionId: target.sessionId, draw: drawFrame }) ?? {};
      if (cdpMethod === "Page.startScreencast" && !target.sessionId) entry.screencasts.add(tabId);
      if (cdpMethod === "Page.stopScreencast" && !target.sessionId) entry.screencasts.delete(tabId);
      if (cdpMethod === "Page.captureScreenshot" && !target.sessionId) return await captureScreenshot(tabId, cdpParams);
      return await cdp.send(tabId, cdpMethod, cdpParams, target.sessionId) ?? {};
    }
    case "chrome.tabs.create": {
      if (await closedByPerson(entry.workspace)) throw new Error(PERSON_CLOSED_MESSAGE);
      const url = (params[0] as { url?: string } | undefined)?.url;
      const tab = await createControlledTab(url || "about:blank", entry.workspace);
      entry.known.add(tab.id!);
      return tabForWire(tab);
    }
    case "chrome.tabs.remove": {
      const ids = [params[0]].flat();
      for (const id of ids) await owned(entry, id);
      await removeAiTabs(ids as number[]);
      return {};
    }
  }
  throw new Error(`Unknown method: ${method}`);
}

export async function handlePipeCommand(frame: PipeCommand): Promise<void> {
  const entry = channels.get(frame.channel);
  const response: PipeResponse = { type: "pipe_response", channel: frame.channel, id: frame.id };
  try {
    if (!entry) throw new Error("this Chrome work space was closed; reconnect");
    const refused = refusal();
    if (refused) throw new Error(refused);
    response.result = await run(frame.channel, entry, frame.method, Array.isArray(frame.params) ? frame.params : []);
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  send(response);
}
