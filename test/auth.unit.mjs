/**
 * 6.0.2 token lifecycle (server/auth.ts): refresh rotates the refresh token (new 30-day life, old one
 * revoked after a short grace that returns the same successor); a connection lives as long as its login,
 * not the 2 h access token; re-enrolling a browser retires its older logins once the new one is used.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "bb-auth-"));
process.env.BB_V6_TOKENS_FILE = join(temp, "tokens.json");
const auth = await import("../server/auth.ts");

let passed = 0;
let failed = 0;
function check(name, value, detail = "") {
  if (value) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (ms) => { offset += ms; };
const H = 3600_000;
const D = 24 * H;
const ws = (token) => auth.checkWsBearer({ subprotocols: [`bb-bearer.${token}`], trustLocal: false });

try {
  // Rotation.
  const first = auth.issueEnrollmentTokens("v8-alice-browser1");
  advance(10 * D);
  const r1 = auth.handleRefresh({ refresh_token: first.refresh_token });
  check("refresh returns a new access token and a NEW refresh token", r1.status === 200 && r1.body.refresh_token && r1.body.refresh_token !== first.refresh_token && r1.body.access_token);
  const replay = auth.handleRefresh({ refresh_token: first.refresh_token });
  check("the old refresh token inside the grace returns the same successor (lost response is recoverable)",
    replay.status === 200 && replay.body.refresh_token === r1.body.refresh_token);
  advance(6 * 60_000);
  check("the old refresh token is revoked after the grace", auth.handleRefresh({ refresh_token: first.refresh_token }).status === 401);

  // Daily use outlives the enrolment's 30 days.
  let token = r1.body.refresh_token;
  for (let day = 0; day < 40; day++) {
    advance(D);
    const r = auth.handleRefresh({ refresh_token: token });
    if (r.status !== 200) { check(`daily refresh survives day ${day + 11}`, false, JSON.stringify(r)); break; }
    token = r.body.refresh_token;
  }
  check("a browser refreshing daily is still logged in 50 days after enrolment", auth.handleRefresh({ refresh_token: token }).status === 200);
  advance(31 * D);
  check("an unused login still ends after 30 days", auth.handleRefresh({ refresh_token: token }).status === 401);

  // A connection follows its login, not the access token.
  const login = auth.issueEnrollmentTokens("v8-alice-browser2");
  const opened = ws(login.access_token);
  const session = auth.sessionForAccessToken(login.access_token);
  advance(3 * H);
  check("the 2 h access token is expired", !auth.isAccessTokenValid(login.access_token));
  check("a live connection stays valid after its access token expired (login still alive)", opened.ok && session && auth.isSessionLive(session));
  const refreshed = auth.handleRefresh({ refresh_token: login.refresh_token });
  check("and after a refresh (rotation keeps the login)", auth.isSessionLive(session) && refreshed.status === 200);
  advance(31 * D);
  check("a connection ends when its login does", !auth.isSessionLive(session));

  // Re-enrolling retires the older logins, but only once the new one is used.
  const a = auth.issueEnrollmentTokens("v8-alice-browser3");
  const other = auth.issueEnrollmentTokens("v8-alice-otherbrowser");
  const b = auth.issueEnrollmentTokens("v8-alice-browser3");
  check("issuing a new login alone leaves the old one working", ws(a.access_token).ok && auth.handleRefresh({ refresh_token: a.refresh_token }).status === 200);
  check("the new login connects", ws(b.access_token).ok);
  check("... and the older login is gone (access and refresh)", !ws(a.access_token).ok && auth.handleRefresh({ refresh_token: a.refresh_token }).status === 401);
  check("another browser's login is untouched", ws(other.access_token).ok && auth.handleRefresh({ refresh_token: other.refresh_token }).status === 200);
  const c = auth.issueEnrollmentTokens("v8-alice-browser3");
  const viaRefresh = auth.handleRefresh({ refresh_token: c.refresh_token });
  check("the first refresh of a newer login also retires the older ones", viaRefresh.status === 200 && auth.handleRefresh({ refresh_token: b.refresh_token }).status === 401);
} finally {
  Date.now = realNow;
  rmSync(temp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
