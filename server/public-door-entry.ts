/** Starts one declaration-derived V8 public door.  Used only by the box service unit. */
import { publicDoorConfigFromEnvironment, startPublicDoor } from "./public-door.js";
import { loadTokensFromDisk, startAuthSweep } from "./auth.js";

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a user port`);
  return value;
}

const config = publicDoorConfigFromEnvironment();
if (!config) throw new Error("V8 public door requires BB_V8_DOOR_ROUTES_FILE and BB_V8_DOOR_ADDRESS");
loadTokensFromDisk();
const authSweep = startAuthSweep();
const door = startPublicDoor({
  config,
  publicPort: port("BB_V8_DOOR_PUBLIC_PORT", 8080),
  issuerPort: port("BB_V8_DOOR_ISSUER_PORT", 8081),
});

console.log(`[public-door] ${config.boxId} Funnel target on loopback:${process.env.BB_V8_DOOR_PUBLIC_PORT ?? "8080"}`);

function shutdown(): void {
  clearInterval(authSweep);
  void door.close().then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
