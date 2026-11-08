/** Common V8 relay archive contract; no service, Funnel, or Chrome is started. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "dccb-browser-bridge-release-"));
try {
  const result = spawnSync("node", ["scripts/package-relay.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(lines[1], "utf8"));
  assert.equal(manifest.schemaVersion, 8);
  assert.equal(manifest.kind, "dccb-browser-bridge-relay");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.archive, `dccb-browser-bridge-v8-${pkg.version}-relay.tgz`);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  for (const required of ["server/index.ts", "server/public-door-entry.ts", "node_modules/tsx/dist/loader.mjs"]) {
    assert.ok(manifest.required.includes(required), required);
  }
  const listing = spawnSync("tar", ["--list", "--gzip", "--file", lines[0]], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /^server\/index\.ts$/m);
  assert.match(listing.stdout, /^server\/public-door-entry\.ts$/m);
  assert.doesNotMatch(listing.stdout, /\.bb-v6-tokens/);
  console.log("PASS common relay archive has the declared Node entrypoints and no token file");

  // Only the relay's runtime packages ship; the extension build tools do not.
  const modules = new Set(listing.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("node_modules/"))
    .map((line) => line.split("/")[1]));
  for (const name of ["ws", "tsx", "esbuild"]) assert.ok(modules.has(name), name);
  for (const name of ["wxt", "typescript", "vite", "@types"]) assert.ok(!modules.has(name), name);

  // The unpacked archive starts on its own, the way the HOME launches it.
  const unpacked = join(scratch, "release");
  spawnSync("mkdir", ["-p", unpacked]);
  const extract = spawnSync("tar", ["--extract", "--gzip", "--file", lines[0], "--directory", unpacked], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  const started = spawnSync(process.execPath, [
    "--import", join(unpacked, "node_modules/tsx/dist/loader.mjs"),
    "--input-type=module", "--eval",
    `const shared = await import(${JSON.stringify(join(unpacked, "shared/protocol.ts"))});
     const door = await import(${JSON.stringify(join(unpacked, "server/public-door.ts"))});
     if (typeof shared.isExtensionVersion !== "function" || Object.keys(door).length === 0) process.exit(3);`,
  ], { cwd: unpacked, encoding: "utf8", timeout: 30_000 });
  assert.equal(started.status, 0, started.stderr || started.stdout);
  console.log("PASS common relay archive ships only runtime packages and loads TypeScript from them");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
