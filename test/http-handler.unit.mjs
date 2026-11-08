import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { runHttpHandler } from "../server/http-handler.ts";

const server = createServer((req, res) => {
  if (req.url === "/reject") {
    runHttpHandler("/reject", res, async () => {
      throw new Error("intentional test rejection");
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("alive");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

const address = server.address();
assert.ok(address && typeof address === "object");
const logged = [];
const originalError = console.error;
console.error = (...args) => logged.push(args.join(" "));
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(String(reason));
process.on("unhandledRejection", onUnhandled);

try {
  const rejected = await fetch(`http://127.0.0.1:${address.port}/reject`);
  assert.equal(rejected.status, 500);
  assert.deepEqual(await rejected.json(), { error: "internal_error" });
  assert.ok(logged.some(line => line.includes("HTTP handler /reject failed: intentional test rejection")));

  const alive = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(alive.status, 200);
  assert.equal(await alive.text(), "alive");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(unhandled, []);
  console.log("  PASS  rejected async route returns HTTP 500, logs its cause, and leaves the process serving requests");
} finally {
  process.off("unhandledRejection", onUnhandled);
  console.error = originalError;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
