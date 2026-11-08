/** The Chrome fetch tool buffers complete responses and adds no default timeout. */
import assert from "node:assert/strict";
// cdp.ts registers chrome.* listeners at import; the fetch tool needs none of them.
const listener = { addListener() {} };
globalThis.chrome = { tabs: { onRemoved: listener, onReplaced: listener }, debugger: { onDetach: listener, onEvent: listener } };
const { dispatch } = await import("../entrypoints/lib/registry.ts");

await import("../entrypoints/lib/tools/fetch.ts");

const previousFetch = globalThis.fetch;
const responseBytes = 8_000_001;
let requestInit;
globalThis.fetch = async (_url, init) => {
  requestInit = init;
  return new Response(new Uint8Array(responseBytes), {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
};

try {
  const response = await dispatch({
    id: "fetch-response-cap-smoke",
    type: "tool_request",
    tool: "fetch",
    args: { url: "https://example.test/large.bin" },
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.byteLength, responseBytes);
  assert.equal(Buffer.from(response.result.bodyBase64, "base64").length, responseBytes);
  assert.equal(requestInit.signal, undefined);
  console.log("  PASS  fetch returns an 8,000,001-byte body without adding a timeout or response cap");
} finally {
  globalThis.fetch = previousFetch;
}
