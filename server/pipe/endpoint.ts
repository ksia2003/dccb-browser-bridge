/**
 * DCCB Browser Bridge 1.1.0 — the engine-facing CDP endpoint of the pipe.
 *
 *   ws://127.0.0.1:<HTTP port>/cdp/<workspace>[?target=<browserId>]
 *
 * agent-browser (`pc-browser`) connects here with `--cdp`. Each connection is one PipeSession and
 * one channel on the chosen browser's relay WebSocket; the extension keeps one tab group per work
 * space, so a work space has at most one engine at a time. Only this relay's own Linux account may
 * connect (the same loopback peer check as the HTTP control routes, 1.0.9).
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { compareExtensionVersions, isExtensionVersion, PIPE_MIN_EXTENSION_VERSION, type BridgeMessage } from "../../shared/protocol.js";
import { loopbackPeerUid } from "../peer-uid.js";
import { PipeSession } from "./session.js";

export const PIPE_EXTENSION_INCIDENT = "browser-bridge-pipe-extension";

export interface PipeBrowser {
  id: string;
  name: string;
  ws: WebSocket;
  version: string | null;
}

export interface PipeEndpointDeps {
  /** The connected browser for `target` (or the only one); throws a person-readable error otherwise. */
  findBrowser(target: string | undefined): PipeBrowser;
  send(ws: WebSocket, message: BridgeMessage): void;
  log(...args: unknown[]): void;
  /** HOME incident: shown to the person, not only logged (11-06 major). No text clears it. */
  report(id: string, text?: string, hint?: string): void;
}

interface OpenChannel {
  session: PipeSession;
  client: WebSocket;
  browserWs: WebSocket;
  key: string;
}

const WORKSPACE = /^[A-Za-z0-9_-]{1,40}$/;

function refuse(socket: Duplex, status: number, reason: string, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n${message}\n`);
  socket.destroy();
}

export function createPipeEndpoint(deps: PipeEndpointDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 0 });
  const channels = new Map<string, OpenChannel>();
  const busy = new Set<string>();

  function closeChannel(channel: string, reason: string, notifyExtension: boolean): void {
    const open = channels.get(channel);
    if (!open) return;
    channels.delete(channel);
    busy.delete(open.key);
    open.session.close(reason);
    if (open.client.readyState === open.client.OPEN) open.client.close(1001, reason.slice(0, 120));
    if (notifyExtension) deps.send(open.browserWs, { type: "pipe_close", channel });
  }

  /** Returns false when the request is not for the pipe (the caller then handles it). */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL;
    try { url = new URL(req.url || "/", "http://127.0.0.1"); } catch { return false; }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "cdp" || parts.length > 2) return false;

    const address = req.socket.remoteAddress ?? "";
    const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
    if (!loopback || loopbackPeerUid(req.socket) !== process.getuid?.()) {
      refuse(socket, 403, "Forbidden", "only this HOME's account may drive its Chrome");
      return true;
    }
    const workspace = parts[1] ?? "default";
    if (!WORKSPACE.test(workspace)) {
      refuse(socket, 400, "Bad Request", "work space must be 1-40 characters [A-Za-z0-9_-]");
      return true;
    }
    let browser: PipeBrowser;
    try {
      browser = deps.findBrowser(url.searchParams.get("target") ?? undefined);
    } catch (error) {
      refuse(socket, 503, "Service Unavailable", error instanceof Error ? error.message : String(error));
      return true;
    }
    if (!isExtensionVersion(browser.version) || compareExtensionVersions(browser.version, PIPE_MIN_EXTENSION_VERSION) < 0) {
      const message = `${browser.name}의 Browser Bridge 확장(${browser.version ?? "버전 모름"})은 pc-browser를 지원하지 않습니다. ${PIPE_MIN_EXTENSION_VERSION} 이상이 필요합니다.`;
      deps.report(PIPE_EXTENSION_INCIDENT, message, "BB 대시보드에서 새 확장을 받아 바꾸고 chrome://extensions에서 새로고침하세요.");
      refuse(socket, 426, "Upgrade Required", message);
      return true;
    }
    const key = `${browser.id}/${workspace}`;
    if (busy.has(key)) {
      refuse(socket, 409, "Conflict", `work space "${workspace}" is already driven by another engine; use another --workspace or close that session`);
      return true;
    }
    busy.add(key);

    wss.handleUpgrade(req, socket, head, (client: WebSocket) => {
      const channel = randomUUID();
      const session = new PipeSession({
        channel,
        toExtension: frame => deps.send(browser.ws, frame),
        toClient: message => { if (client.readyState === client.OPEN) client.send(JSON.stringify(message)); },
      });
      channels.set(channel, { session, client, browserWs: browser.ws, key });
      deps.send(browser.ws, { type: "pipe_open", channel, workspace });
      session.ready().then(
        () => { deps.report(PIPE_EXTENSION_INCIDENT); deps.log(`pipe open: ${browser.id} ${workspace}`); },
        (error: unknown) => {
          deps.log(`pipe open failed: ${browser.id} ${workspace}: ${error instanceof Error ? error.message : error}`);
          client.close(1011, (error instanceof Error ? error.message : String(error)).slice(0, 120));
        },
      );
      client.on("message", data => {
        let message: { id: number; sessionId?: string; method: string; params?: Record<string, unknown> };
        try { message = JSON.parse(data.toString()); } catch { client.close(1007, "malformed CDP JSON"); return; }
        void session.onClientMessage(message);
      });
      client.on("close", () => closeChannel(channel, "engine disconnected", true));
      client.on("error", error => deps.log("pipe client error", error.message));
    });
    return true;
  }

  /** A pipe frame from an extension; returns false for other frame types. */
  function onExtensionFrame(browserWs: WebSocket, message: BridgeMessage): boolean {
    if (message.type !== "pipe_response" && message.type !== "pipe_event") return false;
    const open = channels.get(message.channel);
    if (!open || open.browserWs !== browserWs) return true;
    if (message.type === "pipe_response") open.session.onExtensionResponse(message.id, message.result, message.error);
    else open.session.onExtensionEvent(message.method, Array.isArray(message.params) ? message.params : []);
    return true;
  }

  /** The browser's relay WebSocket closed: end its engines too, so they fail now instead of hanging. */
  function onBrowserClosed(browserWs: WebSocket): void {
    for (const [channel, open] of channels) {
      if (open.browserWs !== browserWs) continue;
      closeChannel(channel, "Chrome disconnected from the relay", false);
    }
  }

  return { handleUpgrade, onExtensionFrame, onBrowserClosed };
}
