/** V8 one-time setup-code contract; no listener, Chrome, or token file required. */
import { BrowserBridgeEnrollmentStore } from "../server/enrollment.ts";

let passed = 0;
let failed = 0;

function check(name, value, detail = "") {
  if (value) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let now = 1_000;
let route = {
  person: "alice",
  boxId: "home-box",
  accessPath: "tailnet-direct",
  relayBinding: "home:alice:1",
  address: "http://home-box.tailnet.example",
  wsEndpoint: "ws://home-box.tailnet.example/ws",
};
const store = new BrowserBridgeEnrollmentStore(() => route, () => now);

const issued = store.issue({ person: "alice", boxId: "home-box", accessPath: "tailnet-direct" });
check("issues address and an eight-character setup code for exactly the declared route", issued.ok
  && issued.value.address === route.address
  && /^[A-Z2-9]{8}$/.test(issued.value.setupCode)
  && issued.value.expiresAt === now + 300_000, JSON.stringify(issued));

const wrongIssue = store.issue({ person: "carol", boxId: "home-box", accessPath: "tailnet-direct" });
check("refuses an issuer request for another person instead of selecting a route", !wrongIssue.ok && wrongIssue.error === "route_mismatch", JSON.stringify(wrongIssue));

const repeated = store.issue({ person: "alice", boxId: "home-box", accessPath: "tailnet-direct" });
check("keeps the same code visible through ordinary refreshes until it is redeemed or expires", repeated.ok
  && repeated.value.setupCode === issued.value.setupCode && repeated.value.expiresAt === issued.value.expiresAt, JSON.stringify(repeated));

const redeemed = store.redeem(issued.value.setupCode, "stable_browser_identifier_123");
check("redeems exactly once into the same relay binding", redeemed.ok
  && redeemed.value.browserId === "stable_browser_identifier_123"
  && redeemed.value.relayBinding === route.relayBinding, JSON.stringify(redeemed));

const used = store.redeem(issued.value.setupCode, "stable_browser_identifier_123");
check("does not silently reuse a consumed setup code", !used.ok && used.error === "used_code", JSON.stringify(used));

const expiring = store.issue({ person: "alice", boxId: "home-box", accessPath: "tailnet-direct" });
now = expiring.value.expiresAt;
const expired = store.redeem(expiring.value.setupCode, "another_stable_browser_id_123");
check("reports expiry explicitly", !expired.ok && expired.error === "expired_code", JSON.stringify(expired));

now++;
const routeChanged = store.issue({ person: "alice", boxId: "home-box", accessPath: "tailnet-direct" });
route = { ...route, relayBinding: "home:alice:2" };
const mismatch = store.redeem(routeChanged.value.setupCode, "changed_route_browser_id_123");
check("rejects a changed relay route rather than falling through to another relay", !mismatch.ok && mismatch.error === "route_mismatch", JSON.stringify(mismatch));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
