/**
 * Tool: extension — the extension's own lifecycle.
 *
 * args:
 *   action  "version" | "reload"   (default "version")
 *
 * version  { version } from the manifest.
 * reload   chrome.runtime.reload() after replying, so an unpacked install picks
 *          up files replaced on disk without anyone opening chrome://extensions.
 */
import { register, type ToolArgs } from "../registry";

async function extensionTool(args: ToolArgs): Promise<unknown> {
  const version = chrome.runtime.getManifest().version;
  if (args.action === "reload") {
    setTimeout(() => chrome.runtime.reload(), 200);
    return { action: "reload", version, ok: true };
  }
  return { action: "version", version };
}

register("extension", extensionTool);
