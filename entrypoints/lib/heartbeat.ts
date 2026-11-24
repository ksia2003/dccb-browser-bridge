import { EXTENSION_SILENCE_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS } from "../../shared/protocol";

/** A keepalive tick later than this since the previous one means the worker (or the PC) was paused or the clock jumped. */
export const STALL_MS = HEARTBEAT_INTERVAL_MS * 1.5;

export interface HeartbeatState {
  /** When the relay last sent anything on this socket. */
  lastInboundAt: number;
  /** When the previous tick ran. */
  lastTickAt: number;
  /** Set while a probe is out: the ping sent right after a stall, which the relay must answer before the next tick. */
  probeSince: number | null;
}

/**
 * What one keepalive tick does. Silence beyond EXTENSION_SILENCE_TIMEOUT_MS means a dead socket, but
 * after a pause (a sleeping PC, a suspended worker, a clock jump) the silence is the pause's, not the
 * connection's: the first tick after it only PINGS and opens a one-beat probe window; the socket is dropped
 * only if nothing came back by the following tick.
 */
export function heartbeatTick(state: HeartbeatState, now: number): { action: "ping" | "probe" | "drop"; state: HeartbeatState } {
  const next: HeartbeatState = { ...state, lastTickAt: now };
  if (state.probeSince !== null) {
    if (state.lastInboundAt < state.probeSince) return { action: "drop", state: next };
    next.probeSince = null; // answered: the connection is alive
  }
  if (now - state.lastTickAt > STALL_MS) return { action: "probe", state: { ...next, probeSince: now } };
  if (now - state.lastInboundAt > EXTENSION_SILENCE_TIMEOUT_MS) return { action: "drop", state: next };
  return { action: "ping", state: next };
}
