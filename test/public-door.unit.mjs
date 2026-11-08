/** V8 public-door declaration checks; no Funnel, listener, or Chrome is started. */
import { parsePublicDoorConfig } from "../server/public-door.ts";

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

function rejects(value) {
  try { parsePublicDoorConfig(value); return false; }
  catch { return true; }
}

const origin = "https://home-box.example.ts.net";
const route = {
  person: "bob",
  boxId: "home-box",
  accessPath: "public-entrance",
  relayBinding: "home:bob:home-box",
  address: origin,
  wsEndpoint: "wss://home-box.example.ts.net/ws",
  homeWsEndpoint: "ws://127.0.0.1:9195/ws",
};
const config = { schemaVersion: 8, boxId: "home-box", address: origin, routes: [route] };

const parsed = parsePublicDoorConfig(config);
check("keeps one Funnel origin and one loopback HOME target for a declared external resident",
  parsed.address === origin && parsed.routes[0].homeWsEndpoint === route.homeWsEndpoint, JSON.stringify(parsed));

check("rejects a route that crosses into another box",
  rejects({ ...config, routes: [{ ...route, boxId: "carol-box" }] }));
check("rejects a remote HOME endpoint instead of turning the door into a cross-box proxy",
  rejects({ ...config, routes: [{ ...route, homeWsEndpoint: "ws://100.64.0.2:9195/ws" }] }));
check("rejects a route whose public WebSocket endpoint is not the Funnel /ws path",
  rejects({ ...config, routes: [{ ...route, wsEndpoint: "wss://home-box.example.ts.net/other" }] }));
check("rejects a non-HTTPS public origin before it can be published through Funnel",
  rejects({ ...config, address: "http://home-box.example.ts.net", routes: [{ ...route, address: "http://home-box.example.ts.net", wsEndpoint: "ws://home-box.example.ts.net/ws" }] }));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
