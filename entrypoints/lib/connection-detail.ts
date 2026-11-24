/**
 * What the popup says while the connection is being (re)made: the first connection reads differently
 * from a retry after a short gap, and both differ from a server that has not been reachable for a long
 * time. Pure, so tests can run it without Chrome. Facts go in labelled rows, not one dotted line.
 */
import type { ConnectionIssue } from "./v8-auth";

export interface ConnectionDetail {
  title: string;
  desc: string;
  rows: { label: string; value: string }[];
}

/** A gap longer than this is "not reachable", not "briefly dropped". */
export const LONG_GAP_MS = 10 * 60 * 1_000;

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return "방금";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export function formatIn(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  if (seconds <= 0) return "지금 시도하는 중";
  if (seconds < 60) return `${seconds}초 뒤`;
  return `${Math.ceil(seconds / 60)}분 뒤`;
}

const REASONS: Record<ConnectionIssue, string> = {
  unreachable: "서버에 닿지 않음",
  dropped: "연결이 끊어짐",
  silent: "서버 응답이 없음",
};

/**
 * `outageStartedAt` is when the current outage began (the first failure after being connected); the
 * "how long" and the "last connected" row count from it. `lastConnectedAt` is when a socket was last
 * bound, which can be days before the outage started for a connection that held for a long time, so it
 * only stands in when no outage start is known (and says "never" when it is null).
 */
export function describeConnecting(input: { lastConnectedAt: number | null; outageStartedAt?: number | null; nextRetryAt: number | null; retryReason: ConnectionIssue | null; now: number }): ConnectionDetail {
  const { lastConnectedAt, nextRetryAt, retryReason, now } = input;
  const since = input.outageStartedAt ?? lastConnectedAt;
  const rows: { label: string; value: string }[] = [];
  const next = nextRetryAt !== null ? { label: "다음 시도", value: formatIn(nextRetryAt - now) } : null;
  if (lastConnectedAt === null) {
    // Never connected: first attempt, or the first attempts failed.
    if (retryReason === null) return { title: "연결하는 중", desc: "서버에 연결하고 있습니다.", rows };
    rows.push({ label: "마지막 연결", value: "아직 없음" }, { label: "원인", value: REASONS[retryReason] });
    if (next) rows.push(next);
    return { title: "서버에 연결하지 못했습니다", desc: "주소가 맞는지, 이 PC가 서버에 닿는지 확인해 주세요.\n알아서 다시 시도합니다.", rows };
  }
  rows.push({ label: "마지막 연결", value: formatAgo(now - since!) });
  if (retryReason !== null) rows.push({ label: "원인", value: REASONS[retryReason] });
  if (next) rows.push(next);
  if (now - since! >= LONG_GAP_MS) {
    return { title: "서버에 연결되지 않음", desc: "서버가 켜져 있는지, 이 PC가 서버에 닿는지 확인해 주세요.\n알아서 계속 시도합니다.", rows };
  }
  return { title: "다시 연결하는 중", desc: "서버와 잠깐 끊겼습니다.\n알아서 다시 잇습니다.", rows };
}
