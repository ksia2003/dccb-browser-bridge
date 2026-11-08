/** Tool: hand control to a person and wait for the popup response. */
import { register, type ToolArgs } from "../registry";

type HandoffController = (message: string, timeoutSec: number, workspace: string) => Promise<unknown>;
let controller: HandoffController | null = null;

export function setHandoffController(next: HandoffController): void {
  controller = next;
}

async function handoff(args: ToolArgs): Promise<unknown> {
  if (typeof args.message !== "string") throw new Error("handoff: 'message' (string) is required");
  const timeoutSec = args.timeoutSec === undefined ? 600 : args.timeoutSec;
  if (typeof timeoutSec !== "number" || !Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 1800) {
    throw new Error("handoff: timeoutSec must be an integer from 1 to 1800");
  }
  if (!controller) throw new Error("handoff: service worker is not ready");
  return controller(args.message, timeoutSec, typeof args.workspace === "string" ? args.workspace : "default");
}

register("handoff", handoff);
