/**
 * Tool: fetch — make an HTTP(S) request from Chrome's extension service worker.
 *
 * This is intentionally not a tab operation. Requests use the user's Chrome
 * network and include eligible site cookies; the JSON relay carries the
 * response bytes as base64. The public DCCB fetch CLI is a thin /send client.
 */
import { register, type ToolArgs } from "../registry";

function requestHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (value === undefined) return headers;

  const entries: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null
      ? Object.entries(value as Record<string, unknown>)
      : [];
  if (!Array.isArray(value) && (typeof value !== "object" || value === null)) {
    throw new Error("fetch: 'headers' must be an object or [name, value] pairs");
  }

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2
      || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error("fetch: each header must be a [name, value] pair");
    }
    headers.append(entry[0], entry[1]);
  }
  return headers;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function readResponseBody(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchFromChrome(args: ToolArgs): Promise<unknown> {
  if (typeof args.url !== "string" || args.url.trim().length === 0) {
    throw new Error("fetch: 'url' (string) is required");
  }
  const method = typeof args.method === "string" ? args.method : "GET";
  const headers = requestHeaders(args.headers);
  const hasTextBody = args.body !== undefined;
  const hasBinaryBody = args.bodyBase64 !== undefined;
  if (hasTextBody && typeof args.body !== "string") {
    throw new Error("fetch: 'body' must be a string");
  }
  if (hasBinaryBody && typeof args.bodyBase64 !== "string") {
    throw new Error("fetch: 'bodyBase64' must be a base64 string");
  }
  if (hasTextBody && hasBinaryBody) {
    throw new Error("fetch: provide either 'body' or 'bodyBase64', not both");
  }

  const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
    ? Math.max(1, Math.floor(args.timeoutMs))
    : null;
  const controller = timeoutMs === null ? null : new AbortController();
  const timeout = controller && timeoutMs !== null
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const init: RequestInit = {
      method,
      headers,
      credentials: "include",
      redirect: "follow",
    };
    if (controller) init.signal = controller.signal;
    if (hasTextBody) init.body = args.body as string;
    if (hasBinaryBody) {
      // A copied buffer has the concrete ArrayBuffer type required by BlobPart
      // on current TypeScript DOM declarations (not ArrayBufferLike).
      const bytes = decodeBase64(args.bodyBase64 as string);
      init.body = new Blob([bytes.slice().buffer as ArrayBuffer]);
    }

    const response = await fetch(args.url, init);
    const body = await readResponseBody(response);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      redirected: response.redirected,
      headers: Object.fromEntries(response.headers.entries()),
      contentType: response.headers.get("content-type"),
      byteLength: body.byteLength,
      bodyBase64: encodeBase64(body),
    };
  } catch (error) {
    if (controller?.signal.aborted) throw new Error(`fetch: timed out after ${timeoutMs}ms`);
    throw new Error(`fetch: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

register("fetch", fetchFromChrome);
