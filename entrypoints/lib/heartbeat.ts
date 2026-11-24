import { EXTENSION_SILENCE_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS } from "../../shared/protocol";

/** A keepalive tick later than this since the previous one means the worker (or the PC) was paused. */
export const STALL_MS = HEARTBEAT_INTERVAL_MS * 1.5;
/** Wall clock and monotonic clock disagreeing by more than this since the last tick: the PC slept or the clock jumped. */
export const CLOCK_SKEW_MS = 5_000;

export interface HeartbeatState {
  /** `performance.now()` when the relay last sent anything on this socket. */
  lastInboundMono: number;
  /** Date.now() and performance.now() at the previous tick. */
  lastTickWall: number;
  lastTickMono: number;
  /** Set while a probe is out: `performance.now()` of the ping sent right after a stall. */
  probeSince: number | null;
}

/**
 * What one keepalive tick does. Silence beyond EXTENSION_SILENCE_TIMEOUT_MS (monotonic time, so a clock
 * change never counts) means a dead socket. A late tick is judged FIRST: after a pause (a sleeping PC, a
 * suspended worker, a clock jump either way) the silence is the pause's, so the tick only pings and opens
 * a one-beat probe window, even if an earlier probe was still open; the socket is dropped only when a
 * normal tick finds a probe unanswered, or the silence runs past the timeout while ticks are on time.
 * (performance.now() restarts with the worker, but so does the socket: both belong to one worker life.)
 */
export function heartbeatTick(state: HeartbeatState, wall: number, mono: number): { action: "ping" | "probe" | "drop"; state: HeartbeatState } {
  const wallGap = wall - state.lastTickWall;
  const monoGap = mono - state.lastTickMono;
  const next: HeartbeatState = { ...state, lastTickWall: wall, lastTickMono: mono };
  const stalled = wallGap < 0 || wallGap > STALL_MS || monoGap > STALL_MS || Math.abs(wallGap - monoGap) > CLOCK_SKEW_MS;
  if (stalled) return { action: "probe", state: { ...next, probeSince: mono } };
  if (state.probeSince !== null) {
    if (state.lastInboundMono < state.probeSince) return { action: "drop", state: next };
    next.probeSince = null; // answered: the connection is alive
  }
  if (mono - state.lastInboundMono > EXTENSION_SILENCE_TIMEOUT_MS) return { action: "drop", state: next };
  return { action: "ping", state: next };
}
