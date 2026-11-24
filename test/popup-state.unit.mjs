/**
 * 6.0.2 pure popup/background rules: the toolbar badge precedence, the connecting-state wording
 * (first connection vs short gap vs long unreachable), the update check, and the heartbeat rule.
 */
import { badgeFor, updateAvailable } from "../entrypoints/lib/badge.ts";
import { describeConnecting, formatAgo, formatIn } from "../entrypoints/lib/connection-detail.ts";
import { heartbeatAction } from "../entrypoints/lib/heartbeat.ts";
import { EXTENSION_SILENCE_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, RELAY_SILENCE_TIMEOUT_MS } from "../shared/protocol.ts";

let passed = 0;
let failed = 0;
function check(name, value, detail = "") {
  if (value) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Badge: working > off > disconnected > update.
const base = { working: false, state: "connected", retryReason: null, updateAvailable: false };
check("connected and idle: no mark", badgeFor(base).text === "");
check("working: the dot", badgeFor({ ...base, working: true }).text === " ");
check("off: OFF", badgeFor({ ...base, state: "off" }).text === "OFF");
check("login ended / address error: !", badgeFor({ ...base, state: "login_ended" }).text === "!" && badgeFor({ ...base, state: "address_error" }).text === "!");
check("retrying after a failure: !", badgeFor({ ...base, state: "connecting", retryReason: "unreachable" }).text === "!");
check("first connection attempt, no failure yet: no mark", badgeFor({ ...base, state: "connecting" }).text === "");
check("never set up: no mark", badgeFor({ ...base, state: "setup" }).text === "");
check("update available: NEW", badgeFor({ ...base, updateAvailable: true }).text === "NEW");
check("working beats everything", badgeFor({ working: true, state: "off", retryReason: "dropped", updateAvailable: true }).text === " ");
check("off beats disconnected and update", badgeFor({ working: false, state: "off", retryReason: "dropped", updateAvailable: true }).text === "OFF");
check("disconnected beats update", badgeFor({ working: false, state: "login_ended", retryReason: null, updateAvailable: true }).text === "!");
const colors = new Set(["off", "login_ended"].map(state => badgeFor({ ...base, state }).color));
check("off and disconnected differ in colour", colors.size === 2);

check("update: unpacked copy behind the relay's ZIP", updateAvailable("6.0.1", "6.0.2", false));
check("update: not for a Web Store copy, same or newer version, or unknown", !updateAvailable("6.0.1", "6.0.2", true) && !updateAvailable("6.0.2", "6.0.2", false) && !updateAvailable("6.0.3", "6.0.2", false) && !updateAvailable("6.0.2", null, false));

// Connecting wording.
const now = 1_000_000_000_000;
let d = describeConnecting({ lastConnectedAt: null, nextRetryAt: null, retryReason: null, now });
check("first connection: plain 'connecting', no rows", d.title === "연결하는 중" && d.rows.length === 0, JSON.stringify(d));
d = describeConnecting({ lastConnectedAt: null, nextRetryAt: now + 8_000, retryReason: "unreachable", now });
check("first connection failing: says never connected, why, and when", /연결하지 못했습니다/.test(d.title)
  && d.rows[0].value === "아직 없음" && d.rows[1].value === "서버에 닿지 않음" && d.rows[2].value === "8초 뒤", JSON.stringify(d));
d = describeConnecting({ lastConnectedAt: now - 2 * 60_000, nextRetryAt: now + 4_000, retryReason: "dropped", now });
check("short gap: 'reconnecting' with the last time and reason", d.title === "다시 연결하는 중" && d.rows[0].value === "2분 전" && d.rows[1].value === "연결이 끊어짐", JSON.stringify(d));
d = describeConnecting({ lastConnectedAt: now - 3 * 24 * 3600_000, nextRetryAt: now + 30_000, retryReason: "unreachable", now });
check("long unreachable: 3 days ago, not reachable", d.title === "서버에 연결되지 않음" && d.rows[0].label === "마지막 연결" && d.rows[0].value === "3일 전" && d.rows[2].value === "30초 뒤", JSON.stringify(d));
check("rows are labelled, never a dotted chain", ![d.title, d.desc, ...d.rows.map(r => r.value)].some(t => t.includes("·")));
check("time wording", formatAgo(10_000) === "방금" && formatAgo(61_000 * 5) === "5분 전" && formatAgo(3 * 3600_000) === "3시간 전" && formatIn(0) === "지금 시도하는 중" && formatIn(90_000) === "2분 뒤");

// Heartbeat rule and its stated timeouts.
check("heartbeat: a recent frame pings, a long silence drops", heartbeatAction(now, now + HEARTBEAT_INTERVAL_MS) === "ping" && heartbeatAction(now, now + EXTENSION_SILENCE_TIMEOUT_MS + 1) === "drop");
check("both timeouts are over two missed beats", EXTENSION_SILENCE_TIMEOUT_MS > 2 * HEARTBEAT_INTERVAL_MS && RELAY_SILENCE_TIMEOUT_MS > 2 * HEARTBEAT_INTERVAL_MS);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
