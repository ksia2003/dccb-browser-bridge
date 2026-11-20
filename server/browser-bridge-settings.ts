import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** Read only the optional setting used by the Chrome extension; invalid or absent settings stay off. */
export function browserBridgeTabGroupEnabled(settingsPath = process.env.DCCB_SETTINGS_PATH): boolean {
  if (!settingsPath) return false;
  try {
    const settings = parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
    const browserBridge = (settings as Record<string, unknown>).browserBridge;
    return !!browserBridge && typeof browserBridge === "object" && !Array.isArray(browserBridge)
      && (browserBridge as Record<string, unknown>).tabGroup === true;
  } catch {
    return false;
  }
}
