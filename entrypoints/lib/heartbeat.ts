import { EXTENSION_SILENCE_TIMEOUT_MS } from "../../shared/protocol";

/** What one keepalive tick does: drop a socket that heard nothing for too long, else ping. */
export function heartbeatAction(lastInboundAt: number, now: number): "ping" | "drop" {
  return now - lastInboundAt > EXTENSION_SILENCE_TIMEOUT_MS ? "drop" : "ping";
}
