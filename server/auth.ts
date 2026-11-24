/**
 * DCCB Browser Bridge — bearer tokens for V8 enrollment (address + code), their refresh, and the
 * WS handshake gate. (The v6 device-code pairing was removed in 1.2.0.)
 *
 * Self-contained token store + the HTTP route handlers and the WS handshake gate. `server/index.ts` wires this in; this module owns no sockets
 * and no ports, so it stays testable and free of relay concerns.
 *
 * Design vs v5 (browser-bridge/server.ts):
 *   - Bearer is taken from the `Authorization` header or a WS subprotocol,
 *     NEVER a `?token=` query string (query strings leak into access logs).
 *   - Trusted-local bypass is an EXPLICIT opt-in (BRIDGE_TRUST_LOCAL), not an
 *     implicit "the internal port has no auth" assumption.
 *   - Tokens persist to `.bb-v6-tokens.json` and reload on boot.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  TokenResponse,
  AuthErrorResponse,
} from "../shared/protocol.js";

// --- Tunables ---------------------------------------------------------------

const ACCESS_TOKEN_TTL_S = 2 * 60 * 60; // 2 h
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60; // 30 d

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE =
  process.env.BB_V6_TOKENS_FILE || join(__dirname, "..", ".bb-v6-tokens.json");
const HTTP_CONTROL_SECRET_FILE = join(dirname(TOKENS_FILE), "http-control.secret");
/** The relay's state folder (token file, control secret, switched-off record live here). */
export const STATE_DIR = dirname(TOKENS_FILE);
/**
 * After a refresh rotates the refresh token, the old one still works this long and hands back the
 * same successor. A response lost in transit (service worker killed before it stored the new token)
 * would otherwise lock the browser out until a new code.
 */
const ROTATION_GRACE_S = 5 * 60;
const MAX_GRACE_REPLAYS = 5;

/**
 * Create the HOME-local HTTP control credential beside the existing token
 * store. The temporary file is linked into place atomically so concurrent
 * service starts never observe a partially-written credential.
 */
export function loadOrCreateHttpControlSecret(): string {
  const directory = dirname(HTTP_CONTROL_SECRET_FILE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    return readHttpControlSecret();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(directory, `.http-control.secret.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${randomBytes(32).toString("hex")}\n`, { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    linkSync(temporary, HTTP_CONTROL_SECRET_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
  return readHttpControlSecret();
}

function readHttpControlSecret(): string {
  const descriptor = openSync(HTTP_CONTROL_SECRET_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Browser Bridge HTTP control secret is not a regular file");
    fchmodSync(descriptor, 0o600);
    const secret = readFileSync(descriptor, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Browser Bridge HTTP control secret is malformed");
    return secret;
  } finally {
    closeSync(descriptor);
  }
}

// --- Stored shapes ----------------------------------------------------------

interface TokenEntry {
  clientId: string;
  createdAt: number;
  expiresAt: number;
  /**
   * V8 code-redemption tokens carry the approved route. This is token state,
   * not a URL/port choice supplied by the extension, and survives refresh.
   */
  enrollmentBinding?: EnrollmentTokenBinding;
  /**
   * The login this token belongs to: the time its enrollment was redeemed (ms). Refresh rotation keeps
   * it, so a login keeps one identity for its whole life, and a later enrollment of the same browser
   * has a larger value. Absent on tokens written before 6.0.2 (treated as 0, oldest).
   */
  family?: number;
  /**
   * Set on a refresh token that was rotated (see ROTATION_GRACE_S): the refresh token and the access
   * token its rotation produced. A retry inside the grace gets exactly these back, so a lost response
   * costs nothing and a retry loop mints nothing.
   */
  rotatedTo?: string;
  rotationAccess?: string;
  /** In-memory count of grace retries served (bounded by MAX_GRACE_REPLAYS). */
  replays?: number;
}

interface TokenFileData {
  accessTokens: Record<string, TokenEntry>;
  refreshTokens: Record<string, TokenEntry>;
}

/** Opaque route data attached by V8 code redemption at a HOME or public door. */
export interface EnrollmentTokenBinding {
  person: string;
  boxId: string;
  relayBinding: string;
  homeWsEndpoint: string;
}

// --- In-memory stores -------------------------------------------------------

const accessTokens = new Map<string, TokenEntry>(); // keyed by access_token
const refreshTokens = new Map<string, TokenEntry>(); // keyed by refresh_token

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), "[auth]", ...args);
}

// --- Persistence ------------------------------------------------------------

/**
 * Write the token store atomically and durably: a 0600 temporary file in the same folder, fsynced,
 * renamed over the store, then the folder fsynced. Returns false on failure; callers that answer
 * "success" to a client go through {@link transaction} so they never promise what is not on disk.
 */
function persist(): boolean {
  const directory = dirname(TOKENS_FILE);
  const temporary = `${TOKENS_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const data: TokenFileData = {
      accessTokens: Object.fromEntries(accessTokens),
      refreshTokens: Object.fromEntries(refreshTokens),
    };
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(data, null, 2));
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, TOKENS_FILE);
    try {
      const folder = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(folder); } finally { closeSync(folder); }
    } catch { /* the rename is done; a folder fsync is best-effort on filesystems that refuse it */ }
    return true;
  } catch (e) {
    log("failed to persist tokens:", (e as Error).message);
    try { unlinkSync(temporary); } catch { /* never created */ }
    return false;
  }
}

/** Run a change to the stores and commit it to disk; if the write fails the change is undone and false returned. */
function transaction(change: () => void): boolean {
  const before = {
    access: new Map([...accessTokens].map(([k, v]) => [k, { ...v }] as const)),
    refresh: new Map([...refreshTokens].map(([k, v]) => [k, { ...v }] as const)),
  };
  change();
  if (persist()) return true;
  accessTokens.clear(); refreshTokens.clear();
  for (const [k, v] of before.access) accessTokens.set(k, v);
  for (const [k, v] of before.refresh) refreshTokens.set(k, v);
  return false;
}

export function loadTokensFromDisk(): void {
  try {
    if (!existsSync(TOKENS_FILE)) return;
    const data = JSON.parse(readFileSync(TOKENS_FILE, "utf-8")) as TokenFileData;
    const now = Date.now();
    let access = 0;
    let refresh = 0;
    let skipped = 0;
    for (const [k, e] of Object.entries(data.accessTokens ?? {})) {
      if (now < e.expiresAt) {
        accessTokens.set(k, e);
        access++;
      } else skipped++;
    }
    for (const [k, e] of Object.entries(data.refreshTokens ?? {})) {
      if (now < e.expiresAt) {
        refreshTokens.set(k, e);
        refresh++;
      } else skipped++;
    }
    try { fchmodSync(openSync(TOKENS_FILE, constants.O_RDONLY | constants.O_NOFOLLOW), 0o600); } catch { /* best-effort tightening of a store written by an older relay */ }
    log(
      `loaded ${access} access, ${refresh} refresh tokens` +
        (skipped ? ` (skipped ${skipped} expired)` : ""),
    );
  } catch (e) {
    log("failed to load tokens:", (e as Error).message);
  }
}

// --- Token / code generation ------------------------------------------------

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Mint a bearer pair for a completed V8 enrollment, retaining its approved route on refresh.
 * Throws when the store cannot be written: a login the relay could not record must not be handed out.
 */
export function issueEnrollmentTokens(clientId: string, enrollmentBinding?: EnrollmentTokenBinding): TokenResponse {
  const now = Date.now();
  const accessToken = newToken();
  const refreshToken = newToken();
  // Larger than any earlier login of this browser even if two redeems land in the same millisecond.
  const family = Math.max(now, latestFamily(clientId) + 1);
  const committed = transaction(() => {
    accessTokens.set(accessToken, {
      clientId, createdAt: now, expiresAt: now + ACCESS_TOKEN_TTL_S * 1000, family,
      ...(enrollmentBinding ? { enrollmentBinding } : {}),
    });
    refreshTokens.set(refreshToken, {
      clientId, createdAt: now, expiresAt: now + REFRESH_TOKEN_TTL_S * 1000, family,
      ...(enrollmentBinding ? { enrollmentBinding } : {}),
    });
  });
  if (!committed) throw new Error("token store is not writable");
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
  };
}

function latestFamily(clientId: string): number {
  let latest = 0;
  for (const entry of [...accessTokens.values(), ...refreshTokens.values()]) {
    if (entry.clientId === clientId) latest = Math.max(latest, entry.family ?? 0);
  }
  return latest;
}

/**
 * Re-enrolling a browser (same clientId = person + stable browser id) leaves its earlier logins behind.
 * Removes them from the stores (the caller commits) and returns true when any went.
 */
function retireOlderLogins(clientId: string, family: number): boolean {
  let changed = false;
  for (const map of [accessTokens, refreshTokens]) {
    for (const [key, entry] of map) {
      if (entry.clientId === clientId && (entry.family ?? 0) < family) {
        map.delete(key);
        changed = true;
      }
    }
  }
  return changed;
}

interface SessionWatch { clientId: string; family: number; onEnd: () => void }
const sessionWatches = new Set<SessionWatch>();

/**
 * Call `onEnd` the moment a newer login of the same browser replaces this connection's login, so a
 * superseded connection stops forwarding at once instead of at the next poll. Returns the unsubscribe.
 */
export function watchSession(session: SessionHandle, onEnd: () => void): () => void {
  const watch: SessionWatch = { ...session, onEnd };
  sessionWatches.add(watch);
  return () => { sessionWatches.delete(watch); };
}

function announceRetired(clientId: string, family: number): void {
  for (const watch of [...sessionWatches]) {
    if (watch.clientId === clientId && watch.family < family) watch.onEnd();
  }
}

/**
 * A new login becomes the browser's login only once it was ADMITTED (socket accepted after route
 * validation). Then, and only then, its predecessors are deleted and their live connections told.
 * False means the removal could not be written to disk: the caller must not admit the connection.
 */
export function activateLogin(session: SessionHandle): boolean {
  let retired = false;
  const committed = transaction(() => { retired = retireOlderLogins(session.clientId, session.family); });
  if (!committed) return false;
  if (retired) announceRetired(session.clientId, session.family);
  return true;
}

/** Constant-time bearer lookup that resists timing-based token discovery. */
function findValidAccessToken(token: string): TokenEntry | null {
  const candidate = Buffer.from(token);
  const now = Date.now();
  let match: TokenEntry | null = null;
  for (const [key, entry] of accessTokens) {
    const keyBuf = Buffer.from(key);
    if (
      keyBuf.length === candidate.length &&
      timingSafeEqual(keyBuf, candidate) &&
      now < entry.expiresAt
    ) {
      match = entry;
    }
  }
  return match;
}

// --- TTL sweep --------------------------------------------------------------

export function startAuthSweep(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [k, e] of accessTokens)
      if (now > e.expiresAt) {
        accessTokens.delete(k);
        changed = true;
      }
    for (const [k, e] of refreshTokens)
      if (now > e.expiresAt) {
        refreshTokens.delete(k);
        changed = true;
      }
    if (changed) persist();
  }, 60_000);
}

// --- Pure handler results (transport-agnostic) ------------------------------

export interface AuthResult {
  status: number;
  body: TokenResponse | AuthErrorResponse | { ok: true };
}

function err(status: number, code: string): AuthResult {
  return { status, body: { error: code } };
}

/**
 * POST /api/auth/refresh — exchange a refresh token for a new access token.
 *
 * A client that sends `accepts_rotation: true` (the 6.0.2 extension, which stores a new refresh token)
 * gets a ROTATED refresh token: a fresh 30-day life, the old one revoked after a short grace. A client
 * that does not send it (6.0.0/6.0.1, which keep only the access token and would be locked out by a
 * rotation) keeps the old behaviour: only an access token comes back, and the refresh token it already
 * holds is extended to 30 days from now. That sliding extension is safe: the token is the same secret
 * bound to the same browser, and it lives no longer than "30 days since the owner last used it".
 */
export function handleRefresh(body: { refresh_token?: string; accepts_rotation?: boolean }): AuthResult {
  if (!body.refresh_token) return err(400, "invalid_request");
  const entry = refreshTokens.get(body.refresh_token);
  const now = Date.now();
  if (!entry || now > entry.expiresAt) {
    if (entry) transaction(() => { refreshTokens.delete(body.refresh_token!); });
    return err(401, "invalid_token");
  }
  if (entry.rotatedTo) {
    // A retry of a rotation whose response may have been lost: the same result, nothing new minted.
    const successor = refreshTokens.get(entry.rotatedTo);
    if (!successor || !entry.rotationAccess || !findValidAccessToken(entry.rotationAccess) || (entry.replays ?? 0) >= MAX_GRACE_REPLAYS) {
      return err(401, "invalid_token");
    }
    entry.replays = (entry.replays ?? 0) + 1;
    return {
      status: 200,
      body: { access_token: entry.rotationAccess, refresh_token: entry.rotatedTo, token_type: "bearer", expires_in: Math.max(1, Math.floor((accessTokens.get(entry.rotationAccess)!.expiresAt - now) / 1000)) },
    };
  }
  const rotate = body.accepts_rotation === true;
  const accessToken = newToken();
  const refreshToken = rotate ? newToken() : undefined;
  let retired = false;
  const committed = transaction(() => {
    accessTokens.set(accessToken, {
      clientId: entry.clientId, createdAt: now, expiresAt: now + ACCESS_TOKEN_TTL_S * 1000,
      ...(entry.family !== undefined ? { family: entry.family } : {}),
      ...(entry.enrollmentBinding ? { enrollmentBinding: entry.enrollmentBinding } : {}),
    });
    if (refreshToken) {
      refreshTokens.set(refreshToken, {
        clientId: entry.clientId, createdAt: now, expiresAt: now + REFRESH_TOKEN_TTL_S * 1000,
        ...(entry.family !== undefined ? { family: entry.family } : {}),
        ...(entry.enrollmentBinding ? { enrollmentBinding: entry.enrollmentBinding } : {}),
      });
      // The used token lives only for the grace window (never longer than it already had).
      entry.rotatedTo = refreshToken;
      entry.rotationAccess = accessToken;
      entry.expiresAt = Math.min(entry.expiresAt, now + ROTATION_GRACE_S * 1000);
    } else {
      entry.expiresAt = now + REFRESH_TOKEN_TTL_S * 1000;
    }
    retired = retireOlderLogins(entry.clientId, entry.family ?? 0);
  });
  if (!committed) return err(503, "server_error");
  if (retired) announceRetired(entry.clientId, entry.family ?? 0);
  return {
    status: 200,
    body: {
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
    },
  };
}

// --- WS handshake gate ------------------------------------------------------

export interface BearerCheck {
  ok: boolean;
  /** WS subprotocol to echo back in the 101 response (if any). */
  acceptProtocol?: string;
  clientId?: string;
  /** The stable browser id this login was enrolled for; the relay binds a connection's id to it. */
  browserId?: string;
}

/** The browser id inside a V8 clientId (`v8-<person>-<browserId>`), taken by the person the route recorded. */
function browserIdOf(entry: TokenEntry): string | undefined {
  const person = entry.enrollmentBinding?.person;
  const prefix = person === undefined ? null : `v8-${person}-`;
  return prefix && entry.clientId.startsWith(prefix) ? entry.clientId.slice(prefix.length) : undefined;
}

/**
 * Validate a WS upgrade. Bearer is read from the `Authorization: Bearer <t>`
 * header or a `bb-bearer.<token>` subprotocol — never the query string.
 *
 * `trustLocal` (BRIDGE_TRUST_LOCAL) is an explicit opt-in mirroring v5's
 * Tailscale path: loopback/trusted connections may skip the bearer entirely.
 */
export function checkWsBearer(opts: {
  authorization?: string;
  subprotocols: string[];
  trustLocal: boolean;
}): BearerCheck {
  let token: string | undefined;
  let acceptProtocol: string | undefined;

  if (opts.authorization?.startsWith("Bearer ")) {
    token = opts.authorization.slice("Bearer ".length).trim();
  }
  if (!token) {
    const proto = opts.subprotocols.find((p) => p.startsWith("bb-bearer."));
    if (proto) {
      token = proto.slice("bb-bearer.".length);
      acceptProtocol = proto; // must echo the chosen subprotocol back
    }
  }

  if (!token) {
    if (opts.trustLocal) return { ok: true, clientId: "trusted-local" };
    return { ok: false };
  }

  const entry = findValidAccessToken(token);
  if (!entry) return { ok: false };
  // Validation only: the login becomes the browser's login at admission (activateLogin), not here.
  return { ok: true, acceptProtocol, clientId: entry.clientId, browserId: browserIdOf(entry) };
}

/** Whether an access bearer is currently valid (a connection's mid-session check is {@link isSessionLive}). */
export function isAccessTokenValid(token: string): boolean {
  return findValidAccessToken(token) !== null;
}

/** The login a live connection was opened with; see {@link isSessionLive}. */
export interface SessionHandle { clientId: string; family: number }

export function sessionForAccessToken(token: string): SessionHandle | null {
  const entry = findValidAccessToken(token);
  return entry ? { clientId: entry.clientId, family: entry.family ?? 0 } : null;
}

/**
 * Whether the login behind a connection is still alive: it still holds a refresh token. A connection
 * is authenticated once, at its handshake; the 2-hour access token that opened it does not bound its
 * life (6.0.2: the extension refreshes that token without reopening the socket, and a relay that
 * closed on its expiry dropped the AI's running work every 2 hours). Ending the login (refresh token
 * expired, superseded by a re-enrollment) still ends the connection.
 */
export function isSessionLive(session: SessionHandle): boolean {
  const now = Date.now();
  for (const entry of refreshTokens.values()) {
    if (entry.clientId === session.clientId && (entry.family ?? 0) === session.family && now < entry.expiresAt) return true;
  }
  return false;
}

/**
 * Return the V8 route bound to a live access bearer. The public door uses it
 * for routing; a Tailnet-direct HOME uses it to reject legacy unbound grants.
 */
export function enrollmentBindingForAccessToken(token: string): EnrollmentTokenBinding | null {
  return findValidAccessToken(token)?.enrollmentBinding ?? null;
}

export { ACCESS_TOKEN_TTL_S, REFRESH_TOKEN_TTL_S };
