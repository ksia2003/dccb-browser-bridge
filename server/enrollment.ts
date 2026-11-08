/**
 * V8 setup-code enrollment.  A setup code is issued for one already-declared
 * HOME route and is redeemed once by one stable extension browser id.  It is
 * deliberately in-memory, just like v6 device codes: a restart invalidates an
 * outstanding five-minute code instead of reviving a stale route.
 */
import { randomBytes, randomInt } from "node:crypto";

export type BrowserBridgeAccessPath = "tailnet-direct" | "public-entrance";

export interface BrowserBridgeRouteBinding {
  person: string;
  boxId: string;
  accessPath: BrowserBridgeAccessPath;
  relayBinding: string;
  address: string;
  wsEndpoint: string;
}

export interface SetupCodeRecord extends BrowserBridgeRouteBinding {
  setupCode: string;
  expiresAt: number;
  redeemedAt: number | null;
}

export type EnrollmentError =
  | "invalid_request"
  | "route_mismatch"
  | "expired_code"
  | "used_code"
  | "unknown_code"
  | "route_unavailable";

export interface EnrollmentResult<T> {
  ok: boolean;
  value?: T;
  error?: EnrollmentError;
}

export interface IssuedSetupCode {
  address: string;
  setupCode: string;
  expiresAt: number;
  relayBinding: string;
}

export interface RedeemedSetupCode extends BrowserBridgeRouteBinding {
  browserId: string;
}

const CODE_TTL_MS = 5 * 60 * 1_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newCode(): string {
  let value = "";
  for (let index = 0; index < 8; index++) value += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return value;
}

function sameRoute(left: BrowserBridgeRouteBinding, right: BrowserBridgeRouteBinding): boolean {
  return left.person === right.person
    && left.boxId === right.boxId
    && left.accessPath === right.accessPath
    && left.relayBinding === right.relayBinding
    && left.address === right.address
    && left.wsEndpoint === right.wsEndpoint;
}

function validBrowserId(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

/** Pure, deterministic-testable owner for one route's short-lived setup codes. */
export class BrowserBridgeEnrollmentStore {
  private readonly codes = new Map<string, SetupCodeRecord>();

  constructor(
    private readonly currentRoute: () => BrowserBridgeRouteBinding | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  issue(request: Pick<BrowserBridgeRouteBinding, "person" | "boxId" | "accessPath">): EnrollmentResult<IssuedSetupCode> {
    const route = this.currentRoute();
    if (!route) return { ok: false, error: "route_unavailable" };
    if (route.person !== request.person || route.boxId !== request.boxId || route.accessPath !== request.accessPath) {
      return { ok: false, error: "route_mismatch" };
    }
    const now = this.now();
    for (const [code, record] of this.codes) if (record.expiresAt <= now || record.redeemedAt !== null) this.codes.delete(code);
    // Ordinary dashboard refreshes ask the same issuer again. Reuse this route's
    // live code so the visible value remains stable for its full five-minute TTL.
    for (const record of this.codes.values()) {
      if (record.redeemedAt === null && record.expiresAt > now && sameRoute(record, route)) {
        return {
          ok: true,
          value: { address: record.address, setupCode: record.setupCode, expiresAt: record.expiresAt, relayBinding: record.relayBinding },
        };
      }
    }
    const setupCode = newCode();
    const record: SetupCodeRecord = { ...route, setupCode, expiresAt: now + CODE_TTL_MS, redeemedAt: null };
    this.codes.set(normalizeCode(setupCode), record);
    return {
      ok: true,
      value: { address: route.address, setupCode, expiresAt: record.expiresAt, relayBinding: route.relayBinding },
    };
  }

  redeem(setupCode: string, browserId: string): EnrollmentResult<RedeemedSetupCode> {
    if (!validBrowserId(browserId)) return { ok: false, error: "invalid_request" };
    const record = this.codes.get(normalizeCode(setupCode));
    if (!record) return { ok: false, error: "unknown_code" };
    const now = this.now();
    if (record.expiresAt <= now) {
      this.codes.delete(normalizeCode(setupCode));
      return { ok: false, error: "expired_code" };
    }
    if (record.redeemedAt !== null) return { ok: false, error: "used_code" };
    const route = this.currentRoute();
    if (!route || !sameRoute(record, route)) return { ok: false, error: "route_mismatch" };
    record.redeemedAt = now;
    return { ok: true, value: { ...route, browserId } };
  }
}

/** Environment adapter.  Deployment derives these values from the V8 declaration; no extension input supplies them. */
export function routeFromEnvironment(env: NodeJS.ProcessEnv = process.env): BrowserBridgeRouteBinding | null {
  const person = env.BB_V8_PERSON;
  const boxId = env.BB_V8_BOX_ID;
  const accessPath = env.BB_V8_ACCESS_PATH;
  const relayBinding = env.BB_V8_RELAY_BINDING;
  const address = env.BB_V8_ENROLL_ADDRESS;
  const wsEndpoint = env.BB_V8_WS_ENDPOINT;
  if (!person || !boxId || !relayBinding || !address || !wsEndpoint) return null;
  if (accessPath !== "tailnet-direct" && accessPath !== "public-entrance") return null;
  try {
    const enrollment = new URL(address);
    const socket = new URL(wsEndpoint);
    if (!/^https?:$/.test(enrollment.protocol) || !/^wss?:$/.test(socket.protocol)) return null;
  } catch {
    return null;
  }
  return { person, boxId, accessPath, relayBinding, address, wsEndpoint };
}
