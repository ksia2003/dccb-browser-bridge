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
//   packages/playwright-core/src/tools/mcp/cdpRelay.ts (CDPRelayServer._handleCDPCommand,
//   ExtensionConnection) and cdpRelayV2.ts (ExtensionProtocolV2).
// Modified by DCCB (2026-11-06):
//   - the extension link is a channel on Browser Bridge's existing relay WebSocket (pipe_* frames),
//     not a separate socket, so it rides the public door and the 1.0.9 account checks;
//   - always "background" mode: Page.bringToFront / Target.activateTarget never raise the person's
//     tab, Target.createTarget opens an inactive tab in the work space's group;
//   - Target discovery for Puppeteer-style clients (agent-browser);
//   - Browser.close and browser-context commands never reach the person's Chrome.

import { BrowserModel, type CDPMessage } from "./browserModel.js";
import type { ExtensionEventsV2 } from "./protocol.js";

/** Commands an engine may send that must not act on a person's whole browser. */
const REFUSED_BROWSER_COMMANDS = new Set([
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.getBrowserContexts",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.crash",
]);

const READY_TIMEOUT_MS = 15_000;
/** Longer than any extension-side limit (input 5 s, screenshot fallback ~10 s), so the extension answers first. */
const COMMAND_TIMEOUT_MS = 60_000;

export interface PipeSessionOptions {
  channel: string;
  /** Sends one frame to the extension over the relay WebSocket. */
  toExtension: (frame: { type: "pipe_command"; channel: string; id: number; method: string; params: unknown[] }) => void;
  /** Sends one CDP message to the engine. */
  toClient: (message: CDPMessage) => void;
}

export class PipeSession {
  readonly channel: string;
  private readonly model: BrowserModel;
  private readonly toExtension: PipeSessionOptions["toExtension"];
  private readonly toClient: PipeSessionOptions["toClient"];
  private lastId = 0;
  private readonly callbacks = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(options: PipeSessionOptions) {
    this.channel = options.channel;
    this.toExtension = options.toExtension;
    this.toClient = options.toClient;
    this.readyPromise = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.readyPromise.catch(() => {});
    const timer = setTimeout(() => this.rejectReady(new Error("Chrome did not open the work space within 15 s")), READY_TIMEOUT_MS);
    this.readyPromise.finally(() => clearTimeout(timer)).catch(() => {});
    this.model = new BrowserModel((method, params) => this.command(method, params));
    this.model.connectOverCDP(message => { if (!this.closed) this.toClient(message); });
  }

  /** Resolves once the extension announced the work space's tabs (`extension.initialized`). */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private command(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("pipe closed"));
    const id = ++this.lastId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`Chrome did not answer ${method} within ${COMMAND_TIMEOUT_MS / 1000} s`));
      }, COMMAND_TIMEOUT_MS);
      this.callbacks.set(id, { resolve, reject, timer });
      this.toExtension({ type: "pipe_command", channel: this.channel, id, method, params: (params ?? []) as unknown[] });
    });
  }

  onExtensionResponse(id: number, result: unknown, error: string | undefined): void {
    const callback = this.callbacks.get(id);
    if (!callback) return;
    this.callbacks.delete(id);
    clearTimeout(callback.timer);
    if (error !== undefined) callback.reject(new Error(error));
    else callback.resolve(result);
  }

  onExtensionEvent(method: string, params: unknown[]): void {
    switch (method) {
      case "chrome.debugger.onEvent": {
        const [source, cdpMethod, cdpParams] = params as ExtensionEventsV2["chrome.debugger.onEvent"]["params"];
        this.model.onDebuggerEvent(source, cdpMethod, cdpParams);
        break;
      }
      case "chrome.debugger.onDetach": {
        const [source] = params as ExtensionEventsV2["chrome.debugger.onDetach"]["params"];
        this.model.onDebuggerDetach(source);
        break;
      }
      case "chrome.tabs.onCreated": {
        const [tab] = params as ExtensionEventsV2["chrome.tabs.onCreated"]["params"];
        this.model.onTabCreated(tab);
        break;
      }
      case "chrome.tabs.onRemoved": {
        const [tabId] = params as ExtensionEventsV2["chrome.tabs.onRemoved"]["params"];
        this.model.onTabRemoved(tabId);
        break;
      }
      case "extension.initialized":
        this.resolveReady();
        break;
      case "extension.error":
        // The extension refused to open the work space (Bridge off, person working, …).
        this.rejectReady(new Error(String(params[0] ?? "Chrome refused the work space")));
        break;
    }
  }

  /** One CDP message from the engine. Always answers with exactly one response. */
  async onClientMessage(message: { id: number; sessionId?: string; method: string; params?: Record<string, unknown> }): Promise<void> {
    const { id, sessionId, method, params } = message;
    try {
      const result = await this.handle(method, params, sessionId);
      this.toClient({ id, sessionId, result });
    } catch (error) {
      this.toClient({ id, sessionId, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private async handle(method: string, params: Record<string, unknown> | undefined, sessionId: string | undefined): Promise<unknown> {
    await this.readyPromise;
    switch (method) {
      case "Browser.getVersion":
        return { protocolVersion: "1.3", product: "Chrome/DCCB-Browser-Bridge", revision: "", userAgent: "DCCB-Browser-Bridge-pipe", jsVersion: "" };
      case "Browser.setDownloadBehavior":
      case "Browser.close":
        // Downloads stay with Chrome's own settings; closing the engine must never close the person's Chrome.
        return {};
    }
    if (!sessionId && REFUSED_BROWSER_COMMANDS.has(method)) throw new Error(`${method} is not available on a person's Chrome`);
    switch (method) {
      case "Target.setAutoAttach":
        if (sessionId) break;
        await this.model.enableAutoAttach();
        return {};
      case "Target.setDiscoverTargets":
        if (sessionId) break;
        await this.model.enableDiscover();
        return {};
      case "Target.getTargets":
        if (sessionId) break;
        return { targetInfos: this.model.getTargets() };
      case "Target.attachToTarget":
        if (sessionId) break;
        return this.model.attachToTarget(params?.targetId as string | undefined);
      case "Target.detachFromTarget":
        if (sessionId) break;
        return {};
      case "Target.createTarget":
        return await this.model.createTarget(params?.url as string | undefined, false);
      case "Page.bringToFront":
      case "Target.activateTarget":
        // The AI works in the background; only the person brings a tab forward (popup).
        return {};
      case "Target.closeTarget":
        return await this.model.closeTarget(params?.targetId as string | undefined);
      case "Target.getTargetInfo":
        if (!sessionId && !params?.targetId) return { targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false } };
        return { targetInfo: this.model.getTargetInfo(sessionId) };
    }
    if (!sessionId) return await this.model.sendBrowserCommand(method, params);
    return await this.model.sendCommand(sessionId, method, params);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectReady(new Error(reason));
    for (const callback of this.callbacks.values()) {
      clearTimeout(callback.timer);
      callback.reject(new Error(reason));
    }
    this.callbacks.clear();
  }
}
