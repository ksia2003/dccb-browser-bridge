/**
 * 6.0.2 token lifecycle (server/auth.ts): refresh rotates the refresh token only for a client that says
 * it can store one (a 6.0.0/6.0.1 client keeps working, its token slid forward); a connection lives as
 * long as its login, not the 2 h access token; a re-enrollment retires older logins only when it is
 * ADMITTED, and tells their live connections at once; the id a bearer may use is the one it was enrolled
 * for; the store is written atomically, owner-only, before success is answered.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "bb-auth-"));
const tokensFile = join(temp, "tokens.json");
writeFileSync(tokensFile, "{}", { mode: 0o644 }); // a store left readable by an older relay
process.env.BB_V6_TOKENS_FILE = tokensFile;
const auth = await import("../server/auth.ts");
auth.loadTokensFromDisk();

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
const binding = (person = "alice") => ({ person, boxId: "box", relayBinding: "rb", homeWsEndpoint: "wss://x/ws" });
const issue = (clientId, b = binding()) => auth.issueEnrollmentTokens(clientId, b, clientId.slice(`v8-${b.person}-`.length));
const rotating = (refresh_token) => auth.handleRefresh({ refresh_token, accepts_rotation: true });

try {
  check("the store file readable by others was tightened to 0600", (statSync(tokensFile).mode & 0o777) === 0o600);

  // Rotation for a client that can store the new token.
  const first = issue("v8-alice-browser1", binding());
  check("a fresh store write is 0600 and leaves no temporary file", (statSync(tokensFile).mode & 0o777) === 0o600 && readdirSync(temp).every(name => !name.endsWith(".tmp")));
  advance(10 * D);
  const r1 = rotating(first.refresh_token);
  check("a rotation-capable client gets a new access token AND a new refresh token", r1.status === 200 && r1.body.refresh_token && r1.body.refresh_token !== first.refresh_token && r1.body.access_token);
  const tokenCount = () => { const f = JSON.parse(readFileSync(tokensFile, "utf8")); return Object.keys(f.accessTokens).length + Object.keys(f.refreshTokens).length; };
  const countBefore = tokenCount();
  advance(60_000); // a retry later gets the stored result, with the same expires_in
  const replay1 = rotating(first.refresh_token);
  advance(60_000);
  const replay2 = rotating(first.refresh_token);
  check("a retry inside the grace returns the SAME stored result (tokens and expires_in) and mints nothing",
    replay1.status === 200 && replay1.body.refresh_token === r1.body.refresh_token && replay1.body.access_token === r1.body.access_token
    && replay2.body.access_token === r1.body.access_token && replay1.body.expires_in === r1.body.expires_in && replay2.body.expires_in === r1.body.expires_in
    && tokenCount() === countBefore);
  check("a replay without accepts_rotation is refused (a legacy client never holds a rotated token)", auth.handleRefresh({ refresh_token: first.refresh_token }).status === 401);
  // The replay count is stored: a restarted relay does not start counting again.
  const restarted = await import("../server/auth.ts?restart=1");
  restarted.loadTokensFromDisk();
  check("the replay count survives a restart", restarted.handleRefresh({ refresh_token: first.refresh_token, accepts_rotation: true }).status === 200);
  for (let i = 0; i < 10; i++) rotating(first.refresh_token);
  check("grace retries are bounded", rotating(first.refresh_token).status === 401);
  advance(6 * 60_000);
  check("the old refresh token is revoked after the grace", rotating(first.refresh_token).status === 401);

  let token = r1.body.refresh_token;
  for (let day = 0; day < 40; day++) {
    advance(D);
    const r = rotating(token);
    if (r.status !== 200) { check(`daily refresh survives day ${day + 11}`, false, JSON.stringify(r)); break; }
    token = r.body.refresh_token;
  }
  check("a browser refreshing daily is still logged in 50 days after enrolment", rotating(token).status === 200);
  advance(31 * D);
  check("an unused login still ends after 30 days", rotating(token).status === 401);

  // A 6.0.0/6.0.1 client: sends no flag, stores only the access token, keeps its original refresh token.
  const legacy = issue("v8-alice-legacy", binding());
  let legacyOk = true;
  for (let day = 0; day < 100; day++) {
    advance(D);
    const r = auth.handleRefresh({ refresh_token: legacy.refresh_token });
    if (r.status !== 200 || "refresh_token" in r.body) { legacyOk = false; check(`a legacy client refreshes on day ${day}`, false, JSON.stringify(r)); break; }
  }
  check("a legacy client (no flag, original refresh token only) keeps refreshing for 100 days, long past enrolment, grace and 30 days", legacyOk);
  advance(31 * D);
  check("... and its login still ends when it is not used for 30 days", auth.handleRefresh({ refresh_token: legacy.refresh_token }).status === 401);

  // A connection follows its login, not the access token.
  const login = issue("v8-alice-browser2", binding());
  const opened = ws(login.access_token);
  const session = auth.sessionForAccessToken(login.access_token);
  advance(3 * H);
  check("the 2 h access token is expired", !auth.isAccessTokenValid(login.access_token));
  check("a live connection stays valid after its access token expired (login still alive)", opened.ok && session && auth.isSessionLive(session));
  check("and after a refresh", rotating(login.refresh_token).status === 200 && auth.isSessionLive(session));
  advance(31 * D);
  check("a connection ends when its login does", !auth.isSessionLive(session));

  // Re-enrolling retires older logins at admission, not at validation.
  const a = issue("v8-alice-browser3", binding());
  const sessionA = auth.sessionForAccessToken(a.access_token);
  let told = 0;
  auth.watchSession(sessionA, () => told++);
  const other = issue("v8-alice-otherbrowser", binding());
  const b = issue("v8-alice-browser3", binding());
  check("a newer login that refreshes before it ever connected does not retire the working one", rotating(b.refresh_token).status === 200 && ws(a.access_token).ok && auth.isSessionLive(sessionA));
  check("issuing a new login leaves the old one working", ws(a.access_token).ok && auth.isSessionLive(sessionA));
  check("validating the new login (an upgrade that may still be refused) retires nothing", ws(b.access_token).ok && ws(a.access_token).ok && told === 0);
  check("admission activates it: the older login is gone (access and refresh) and its live connection is told at once",
    auth.activateLogin(auth.sessionForAccessToken(b.access_token)) && told === 1 && !ws(a.access_token).ok && !auth.isSessionLive(sessionA) && rotating(a.refresh_token).status === 401);
  check("another browser's login is untouched", ws(other.access_token).ok && rotating(other.refresh_token).status === 200);

  // The id a bearer may use.
  check("a bearer carries the browser id it was enrolled for", ws(b.access_token).browserId === "browser3" && ws(other.access_token).browserId === "otherbrowser");
  const tricky = issue("v8-alice-x-victim", binding());
  check("the browser id is exact, never a suffix guess", ws(tricky.access_token).browserId === "x-victim");

  // Hyphens in a person name or browser id cannot make two pairs one login.
  const p1 = auth.issueEnrollmentTokens("v8-a-b-c", binding("a-b"), "c");
  const p2 = auth.issueEnrollmentTokens("v8-a-b-c", binding("a"), "b-c");
  auth.activateLogin(auth.sessionForAccessToken(p2.access_token));
  check("pairs whose joined clientId is identical stay separate logins", ws(p1.access_token).ok && ws(p1.access_token).browserId === "c" && ws(p2.access_token).browserId === "b-c");

  // Entries written before browserId existed get it derived at load.
  const oldFile = join(temp, "old-tokens.json");
  writeFileSync(oldFile, JSON.stringify({ accessTokens: { oldA: { clientId: "v8-alice-oldbrowser", createdAt: 1, expiresAt: Date.now() + 3600_000, enrollmentBinding: binding() } }, refreshTokens: {} }));
  process.env.BB_V6_TOKENS_FILE = oldFile;
  const migrated = await import("../server/auth.ts?migrate=1");
  migrated.loadTokensFromDisk();
  check("a stored entry without browserId is migrated at load", migrated.checkWsBearer({ subprotocols: ["bb-bearer.oldA"], trustLocal: false }).browserId === "oldbrowser");
  process.env.BB_V6_TOKENS_FILE = tokensFile;

  // A rotation the previous relay committed inside the grace (legacy field names) still answers a retry.
  const legacyFile = join(temp, "legacy-tokens.json");
  const soon = Date.now() + 2 * 60_000;
  const legacyBase = { clientId: "v8-alice-legacybrowser", browserId: "legacybrowser", createdAt: 1, family: 5, enrollmentBinding: binding() };
  writeFileSync(legacyFile, JSON.stringify({
    accessTokens: { legacyA1: { ...legacyBase, expiresAt: Date.now() + 3600_000 } },
    refreshTokens: {
      legacyR0: { ...legacyBase, expiresAt: soon, rotatedTo: "legacyR1", rotationAccess: "legacyA1" },
      legacyR1: { ...legacyBase, expiresAt: Date.now() + 30 * D },
    },
  }));
  process.env.BB_V6_TOKENS_FILE = legacyFile;
  const upgraded = await import("../server/auth.ts?legacy=1");
  upgraded.loadTokensFromDisk();
  const retry = upgraded.handleRefresh({ refresh_token: "legacyR0", accepts_rotation: true });
  check("a rotation record written by the previous relay (rotationAccess) still answers a retry after the upgrade",
    retry.status === 200 && retry.body.access_token === "legacyA1" && retry.body.refresh_token === "legacyR1", JSON.stringify(retry));
  process.env.BB_V6_TOKENS_FILE = tokensFile;

  // The store is written before success is answered.
  if (process.getuid?.() !== 0) {
    const victim = issue("v8-alice-browser5", binding());
    chmodSync(temp, 0o500);
    let threw = false;
    try { issue("v8-alice-browser6", binding()); } catch { threw = true; }
    const failedRefresh = rotating(victim.refresh_token);
    chmodSync(temp, 0o700);
    check("when the store cannot be written, enrolment fails instead of handing out a login", threw);
    check("... and a refresh answers 503, with the old refresh token still good afterwards", failedRefresh.status === 503 && rotating(victim.refresh_token).status === 200);
  }
  check("no leftover temporary files", readdirSync(temp).every(name => !name.endsWith(".tmp")) && existsSync(tokensFile));
} finally {
  Date.now = realNow;
  try { chmodSync(temp, 0o700); } catch {}
  rmSync(temp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
