/**
 * Produce the common V8 HOME/public-door runtime archive.
 *
 * This is deliberately separate from `wxt zip`: Chrome receives the extension
 * ZIP through its dashboard card, while each HOME/box receives this Node
 * runtime as an externally staged, versioned release.  The archive contains no
 * profiles, hostnames, tokens, mesh declarations, or person-specific files.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
  throw new Error("package.json must contain an exact Browser Bridge release version");
}

const output = join(root, ".output");
// The previous DCCB updater reads this v8 schema prefix during the one-release
// lag. Keep it while resetting the product SemVer to 1.0.0.
const archive = join(output, `dccb-browser-bridge-v8-${version}-relay.tgz`);
const manifest = join(output, `dccb-browser-bridge-v8-${version}-relay.json`);
const required = [
  "server/index.ts",
  "server/public-door-entry.ts",
  "server/auth.ts",
  "server/enrollment.ts",
  "server/public-door.ts",
  "shared/protocol.ts",
  "node_modules/tsx/dist/loader.mjs",
  "node_modules/ws/index.js",
];
for (const relative of required) {
  const path = join(root, relative);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`relay release is missing ${relative}`);
}

// The relay runs `server/` through tsx and talks WebSocket through ws; nothing
// else from node_modules is loaded. Ship only those two packages and what they
// pull in (esbuild and its native binary), not the extension build tools.
const RUNTIME_PACKAGES = ["ws", "tsx"];
function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root || dir === dirname(dir)) return undefined;
  }
}
const runtimeDirs = new Set();
const pending = RUNTIME_PACKAGES.map((name) => {
  const dir = findPackage(name, root);
  if (!dir) throw new Error(`relay runtime package ${name} is not installed`);
  return dir;
});
while (pending.length > 0) {
  const dir = pending.pop();
  if (runtimeDirs.has(dir)) continue;
  runtimeDirs.add(dir);
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  // Optional dependencies are platform builds (esbuild) or macOS-only
  // (fsevents); only the ones npm installed here exist and are shipped.
  for (const name of [...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {})]) {
    const found = findPackage(name, dir);
    if (found) pending.push(found);
  }
}
const runtimeModules = [...runtimeDirs].map((dir) => relative(root, dir)).sort();

mkdirSync(output, { recursive: true });
rmSync(archive, { force: true });
rmSync(manifest, { force: true });
const packed = spawnSync("tar", [
  "--create", "--gzip", "--file", archive,
  "--directory", root,
  "--exclude=.bb-v6-tokens*",
  "--exclude=.output",
  "--exclude=.wxt",
  "package.json",
  "package-lock.json",
  "server",
  "shared/protocol.ts",
  ...runtimeModules,
], { encoding: "utf8" });
if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr || packed.stdout}`);
const bytes = readFileSync(archive);
writeFileSync(manifest, `${JSON.stringify({
  schemaVersion: 8,
  kind: "dccb-browser-bridge-relay",
  version,
  archive: archive.split("/").at(-1),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  required,
}, null, 2)}\n`);
console.log(archive);
console.log(manifest);
