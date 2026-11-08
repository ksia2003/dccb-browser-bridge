/** Build and zip the extension with the clean source commit in the artifact. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicSourcePath = join(root, "public", "browser-bridge-source.json");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;

writeFileSync(publicSourcePath, `${JSON.stringify({ version: pkg.version, sourceCommit, dirty }, null, 2)}\n`);
let status = 1;
try {
  const result = spawnSync("wxt", ["zip"], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally {
  rmSync(publicSourcePath, { force: true });
}
if (status !== 0) process.exit(status);
