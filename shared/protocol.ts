/**
 * DCCB Browser Bridge v6 — wire protocol.
 *
 * Shared between the Node relay server (`server/`) and the Chrome MV3
 * extension service worker (`entrypoints/background.ts`). Keep this file
 * dependency-free so both sides can import it directly.
 */

/** Server → extension: asks the extension to run a tool. */
export interface ToolRequest {
  id: string;
  type: "tool_request";
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Optional, structured error shape an extension-side tool may surface inside
 * `ToolResponse.error`. v6 keeps `error` as a plain string on the wire (see
 * below) for relay simplicity; this interface documents the convention the
 * dispatcher uses when serialising a thrown error to that string.
 */
export interface ToolError {
  message: string;
  /** e.g. "unknown_tool" | "cdp" | "no_target_tab" | "timeout". */
  code?: string;
}

/** Extension → server: result (or error) for a prior ToolRequest. */
export interface ToolResponse {
  id: string;
  type: "tool_response";
  result?: unknown;
  error?: string;
}

/** Liveness probe (extension → server keepalive). */
export interface Ping {
  type: "ping";
}

/** First extension frame after opening the relay WebSocket. */
export interface ExtensionHello {
  type: "extension_hello";
  version: string;
}

/** Relay → extension: current version of the ZIP this HOME distributes. */
export interface LatestExtensionVersion {
  type: "latest_extension_version";
  version: string | null;
}

/** Liveness reply (server → extension). */
export interface Pong {
  type: "pong";
}

/** First server frame after a V8 connection. The extension refuses a changed HOME binding. */
export interface RelayBinding {
  type: "relay_binding";
  relay_binding: string;
  browser_id: string;
  latest_extension_version?: string | null;
}

/**
 * Pipe (1.1.0): a raw chrome.debugger channel for an engine on the HOME (agent-browser through
 * `pc-browser`). One channel per engine connection and work space. The payload is Playwright's
 * extension protocol v2 (chrome.debugger.* / chrome.tabs.* commands and events); see
 * server/pipe/protocol.ts.
 */
export interface PipeOpen {
  type: "pipe_open";
  channel: string;
  workspace: string;
}

/** Relay → extension: the engine disconnected; detach this channel's tabs. */
export interface PipeClose {
  type: "pipe_close";
  channel: string;
}

/** Relay → extension: one Playwright protocol-v2 command. */
export interface PipeCommand {
  type: "pipe_command";
  channel: string;
  id: number;
  method: string;
  params: unknown[];
}

/** Extension → relay: the answer to a PipeCommand. */
export interface PipeResponse {
  type: "pipe_response";
  channel: string;
  id: number;
  result?: unknown;
  error?: string;
}

/** Extension → relay: a protocol-v2 event, or `extension.initialized` once the channel's tabs are announced. */
export interface PipeEvent {
  type: "pipe_event";
  channel: string;
  method: string;
  params: unknown[];
}

/** First extension release that understands pipe frames. */
export const PIPE_MIN_EXTENSION_VERSION = "1.1.0";

/** Any message that can cross the wire in either direction. */
export type BridgeMessage = ToolRequest | ToolResponse | Ping | Pong | RelayBinding | ExtensionHello | LatestExtensionVersion
  | PipeOpen | PipeClose | PipeCommand | PipeResponse | PipeEvent;

/** Chrome's manifest version for this release line is three numeric components. */
export function isExtensionVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value)
    && value.split(".").every(part => Number.isSafeInteger(Number(part)));
}

export function compareExtensionVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export interface EnrollRedeemResponse {
  ws_endpoint: string;
  relay_binding: string;
  browser_id: string;
  /** Public-door enrollment returns a v6-compatible bearer pair; direct Tailnet does not. */
  access_token?: string;
  refresh_token?: string;
  token_type?: "bearer";
  expires_in?: number;
}

// ---------------------------------------------------------------------------
// Auth (RFC 8628 Device Authorization Grant) — HTTP JSON shapes.
//
// These are NOT WebSocket frames; they cross the HTTP auth endpoints between
// the extension and the relay server. Kept here so both sides share one
// source of truth for field names.
// ---------------------------------------------------------------------------

/** Response to `POST /api/auth/device`. */
/** Success body for `POST /api/auth/token` and `/api/auth/refresh`. */
export interface TokenResponse {
  access_token: string;
  /** Absent on refresh (refresh token is long-lived and reused). */
  refresh_token?: string;
  token_type: "bearer";
  /** Access-token lifetime, seconds. */
  expires_in: number;
}

/**
 * RFC 8628 polling error codes (plus refresh's invalid_token). The extension
 * branches on these during pairing/refresh.
 */
export type AuthErrorCode =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "invalid_token"
  | "invalid_request";

/** Error body returned by the auth endpoints. */
export interface AuthErrorResponse {
  error: AuthErrorCode | string;
}

/**
 * WebSocket close code used when the relay rejects/expires a bearer mid-session.
 * The extension treats 4401 as "refresh then reconnect".
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** Subprotocol prefix used to pass the bearer token in the WS handshake. */
export const WS_BEARER_SUBPROTOCOL_PREFIX = "bb-bearer.";
