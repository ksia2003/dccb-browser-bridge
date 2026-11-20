import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserBridgeTabGroupEnabled } from "../server/browser-bridge-settings.ts";

const scratch = mkdtempSync(join(tmpdir(), "dccb-browser-bridge-settings-"));
try {
  const path = join(scratch, "settings.yaml");
  assert.equal(browserBridgeTabGroupEnabled(path), false);
  writeFileSync(path, "browserBridge:\n  tabGroup: true\n");
  assert.equal(browserBridgeTabGroupEnabled(path), true);
  process.env.DCCB_SETTINGS_PATH = path;
  assert.equal(browserBridgeTabGroupEnabled(), true);
  writeFileSync(path, "browserBridge:\n  tabGroup: false\n");
  assert.equal(browserBridgeTabGroupEnabled(path), false);
  writeFileSync(path, "browserBridge:\n  tabGroup: yes please\n");
  assert.equal(browserBridgeTabGroupEnabled(path), false);
  writeFileSync(path, "browserBridge: [broken\n");
  assert.equal(browserBridgeTabGroupEnabled(path), false);
  console.log("PASS Browser Bridge tab grouping is opt-in and invalid settings stay off");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
