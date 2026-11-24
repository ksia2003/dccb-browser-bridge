/** V8 extension enrollment: one explicit address + setup code, then durable reconnect. */
import {
  WS_BEARER_SUBPROTOCOL_PREFIX,
  WS_CLOSE_UNAUTHORIZED,
  type EnrollRedeemResponse,
  type TokenResponse,
} from "../../shared/protocol";

const PROFILE_KEY = "v8BrowserBridgeProfile";
const BROWSER_ID_KEY = "v8BrowserBridgeId";
const ENABLED_KEY = "v8BrowserBridgeEnabled";
const NAME_KEY = "v8BrowserBridgeName";
const LAST_CONNECTED_KEY = "v8BrowserBridgeLastConnected";
const LAST_ADDRESS_KEY = "v8BrowserBridgeLastAddress";
/** The terminal state (login ended, address error) with its reason, so a worker restart still shows it. */
const TERMINAL_KEY = "v8BrowserBridgeTerminal";
/** When the current outage began (first failed attempt after being connected, or since the start). */
const OUTAGE_KEY = "v8BrowserBridgeOutageStart";
/** Deadline for a request to the relay's HTTP endpoints, headers AND body (mutable for tests only). */
export const timing = { requestDeadlineMs: 15_000 };
const REFRESH_LEAD_MS = 10 * 60 * 1_000;
/** A socket is not opened with an access token that expires within this long; it is refreshed first. */
const STALE_LEAD_MS = 2 * 60 * 1_000;
const REFRESH_RETRY_MS = 30_000;

/**
 * `expired`: the setup code was too old or already used. `login_ended`: the stored login itself ended
 * (the refresh token was refused), so the person needs a new code; the address is kept for the form.
 */
export type AuthState = "setup" | "connecting" | "connected" | "off" | "expired" | "login_ended" | "address_error";

/** Why the connection is being retried, as far as the extension can tell (shown in the popup). */
export type ConnectionIssue = "unreachable" | "dropped" | "silent";

export interface V8Profile {
  schemaVersion: 8;
  addressOrigin: string;
  wsEndpoint: string;
  relayBinding: string;
  browserId: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: number | null;
}

export interface AuthSnapshot {
  state: AuthState;
  address: string | null;
  browserId: string | null;
  error: string | null;
  enabled: boolean;
  deviceName: string;
  lastConnectedAt: number | null;
  nextRetryAt: number | null;
  retryReason: ConnectionIssue | null;
  outageStartedAt: number | null;
}

export interface AuthHooks {
  openSocket(): void;
  closeSocket(): void;
  /** Tell the relay the new device name over the open socket (no-op when none is open). */
  announceName?(name: string): void;
  onChange(snapshot: AuthSnapshot): void;
}

let profile: V8Profile | null = null;
let state: AuthState = "setup";
let error: string | null = null;
let enabled = true;
let deviceName = "이 컴퓨터의 Chrome";
let lastConnectedAt: number | null = null;
let nextRetryAt: number | null = null;
let retryReason: ConnectionIssue | null = null;
/** The last address a profile had, kept after the profile is wiped by a login that ended. */
let lastAddress: string | null = null;
let outageStartedAt: number | null = null;
/**
 * Bumped whenever the stored login is replaced or dropped (a new code redeemed, login ended, reset,
 * binding mismatch). A refresh remembers the generation it started in and discards its result if the
 * login changed meanwhile, so a slow refresh of an old login can never overwrite or wipe a newer one.
 */
let generation = 0;
let refreshing: { generation: number; promise: Promise<boolean> } | null = null;
/** Credential commits (profile writes and wipes) run one at a time, each re-checking its generation. */
let commitChain: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = commitChain.then(task, task);
  commitChain = run.catch(() => undefined);
  return run;
}
/** Re-connect attempt currently in flight; cancelling bumps `setupAttempt` and aborts its requests. */
let setupAttempt = 0;
let setupAbort: AbortController | null = null;
let setupCommitting = false;

/**
 * POST-style request with ONE deadline that covers the headers and the whole body, plus an optional
 * outer abort (a cancelled attempt). An outer signal that is already aborted aborts at once (a listener
 * added to an aborted signal never fires). Resolves to the status and the parsed JSON body (null when the
 * body is not JSON); a stalled body or an abort rejects.
 */
async function requestJson(url: URL, init: RequestInit, outer?: AbortSignal): Promise<{ status: number; ok: boolean; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timing.requestDeadlineMs);
  const relay = (): void => controller.abort();
  if (outer?.aborted) controller.abort(); else outer?.addEventListener("abort", relay);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, ok: response.ok, body };
  } finally { clearTimeout(timer); outer?.removeEventListener("abort", relay); }
}
let hooks: AuthHooks | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void { hooks?.onChange(snapshot()); }
function setState(next: AuthState): void { state = next; notify(); }

export function snapshot(): AuthSnapshot {
  return { state, address: profile?.addressOrigin ?? lastAddress, browserId: profile?.browserId ?? null, error, enabled, deviceName, lastConnectedAt, nextRetryAt, retryReason, outageStartedAt };
}

/** Public route identity, not a credential; distinguishes HOME bindings on one door. */
export function connectionKey(): string {
  return JSON.stringify([profile?.addressOrigin, profile?.relayBinding, profile?.browserId]);
}

/** The route a profile points at (address, socket endpoint, relay binding): what "this relay" means for remembered capabilities. */
export function routeIdentity(): string | null {
  return profile ? JSON.stringify([profile.addressOrigin, profile.wsEndpoint, profile.relayBinding]) : null;
}
export function hasProfile(): boolean { return profile !== null; }
export function isEnabled(): boolean { return enabled && profile !== null; }
/** True when the access token is expired or about to be: refresh before opening a socket with it. */
export function accessTokenStale(): boolean {
  return requiresBearer() && profile!.tokenExpiresAt !== null && profile!.tokenExpiresAt - Date.now() < STALE_LEAD_MS;
}
export function requiresBearer(): boolean { return profile?.accessToken !== null && profile?.accessToken !== undefined; }
export function bearerSubprotocol(): string | null {
  return profile?.accessToken ? `${WS_BEARER_SUBPROTOCOL_PREFIX}${profile.accessToken}` : null;
}

export function wsUrl(): string | null {
  if (!profile) return null;
  const url = new URL(profile.wsEndpoint);
  url.searchParams.set("id", profile.browserId);
  url.searchParams.set("name", deviceName);
  return url.toString();
}

function clearRefreshTimer(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
}

function validProfile(value: unknown): value is V8Profile {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 8 || typeof raw.addressOrigin !== "string" || typeof raw.wsEndpoint !== "string"
    || typeof raw.relayBinding !== "string" || typeof raw.browserId !== "string") return false;
  try {
    const address = new URL(raw.addressOrigin);
    const socket = new URL(raw.wsEndpoint);
    return /^https?:$/.test(address.protocol) && /^wss?:$/.test(socket.protocol);
  } catch {
    return false;
  }
}

async function stableBrowserId(): Promise<string> {
  const stored = await chrome.storage.local.get(BROWSER_ID_KEY) as { v8BrowserBridgeId?: string };
  if (typeof stored.v8BrowserBridgeId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(stored.v8BrowserBridgeId)) {
    return stored.v8BrowserBridgeId;
  }
  const generated = crypto.randomUUID().replace(/-/g, "");
  await chrome.storage.local.set({ [BROWSER_ID_KEY]: generated });
  return generated;
}

function addressOrigin(raw: string): string {
  const url = new URL(raw.trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("주소 형식이 올바르지 않습니다");
  }
  return url.origin;
}

function enrollmentError(status: number, body: unknown): string {
  const code = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  switch (code) {
    case "expired_code": return "코드가 만료됐습니다. 대시보드의 지금 코드를 넣어 주세요";
    case "used_code": return "이미 쓴 코드입니다. 대시보드의 지금 코드를 넣어 주세요";
    // A mistyped or replaced code: 6.0.0 relays say unknown_code; older ones said route_unavailable.
    case "unknown_code":
    case "route_unavailable": return "코드가 맞지 않거나 지난 코드입니다. 대시보드의 지금 코드를 넣어 주세요";
    case "route_mismatch": return "이 주소와 코드는 서로 다른 서버의 것입니다. 대시보드의 주소와 코드를 함께 넣어 주세요";
    case "invalid_request": return "주소 또는 코드 형식이 올바르지 않습니다";
    default: return `연결 정보를 확인할 수 없습니다 (${status})`;
  }
}

function validateRedeem(value: unknown, expectedBrowserId: string): EnrollRedeemResponse {
  if (!value || typeof value !== "object") throw new Error("relay 응답 형식이 올바르지 않습니다");
  const raw = value as Record<string, unknown>;
  if (typeof raw.ws_endpoint !== "string" || typeof raw.relay_binding !== "string" || raw.browser_id !== expectedBrowserId) {
    throw new Error("relay 응답의 연결 정보가 일치하지 않습니다");
  }
  const socket = new URL(raw.ws_endpoint);
  if (!/^wss?:$/.test(socket.protocol)) throw new Error("relay 응답의 WebSocket 주소가 올바르지 않습니다");
  if (raw.access_token !== undefined && (typeof raw.access_token !== "string" || typeof raw.refresh_token !== "string"
    || raw.token_type !== "bearer" || typeof raw.expires_in !== "number")) {
    throw new Error("relay 인증 응답이 올바르지 않습니다");
  }
  return raw as unknown as EnrollRedeemResponse;
}

/** Store a profile. `replacing` marks a different login (new code), which starts a new generation. */
async function saveProfile(next: V8Profile, replacing = false): Promise<void> {
  if (replacing) generation++;
  profile = next;
  lastAddress = next.addressOrigin;
  await chrome.storage.local.set({ [PROFILE_KEY]: next, [LAST_ADDRESS_KEY]: next.addressOrigin });
  await chrome.storage.local.remove(TERMINAL_KEY);
}

/**
 * Drop the profile (credentials) and close the socket. The last address stays in storage and in the
 * snapshot so the re-connect form comes back filled in; only `reset` forgets it. A terminal state
 * (login ended, address error) is stored with its reason, so it survives a worker restart.
 */
async function clearProfile(nextError: string | null, nextState: AuthState): Promise<void> {
  generation++;
  clearRefreshTimer();
  profile = null;
  error = nextError;
  retryReason = null;
  nextRetryAt = null;
  outageStartedAt = null;
  await chrome.storage.local.remove([PROFILE_KEY, OUTAGE_KEY]);
  if (nextState === "login_ended" || nextState === "address_error") {
    await chrome.storage.local.set({ [TERMINAL_KEY]: { state: nextState, error: nextError } });
  } else {
    await chrome.storage.local.remove(TERMINAL_KEY);
  }
  hooks?.closeSocket();
  setState(nextState);
}

function scheduleRefresh(): void {
  clearRefreshTimer();
  if (!profile?.refreshToken || !profile.tokenExpiresAt) return;
  const delay = Math.max(profile.tokenExpiresAt - Date.now() - REFRESH_LEAD_MS, 30_000);
  refreshTimer = setTimeout(() => void refreshAccessToken(), delay);
}

export async function init(nextHooks: AuthHooks): Promise<void> {
  hooks = nextHooks;
  const stored = await chrome.storage.local.get([PROFILE_KEY, ENABLED_KEY, NAME_KEY, LAST_CONNECTED_KEY, LAST_ADDRESS_KEY, TERMINAL_KEY, OUTAGE_KEY]) as Record<string, unknown>;
  // The popup's switch (back in 6.1.0, as in 1.2.x) is stored: a Chrome the person switched off stays
  // off across browser restarts, with its profile kept so switching on needs no code.
  enabled = stored[ENABLED_KEY] !== false;
  deviceName = typeof stored[NAME_KEY] === "string" && stored[NAME_KEY].trim() ? String(stored[NAME_KEY]).slice(0, 40) : defaultDeviceName();
  lastConnectedAt = typeof stored[LAST_CONNECTED_KEY] === "number" ? stored[LAST_CONNECTED_KEY] : null;
  lastAddress = typeof stored[LAST_ADDRESS_KEY] === "string" ? stored[LAST_ADDRESS_KEY] : null;
  outageStartedAt = typeof stored[OUTAGE_KEY] === "number" ? stored[OUTAGE_KEY] : null;
  if (!validProfile(stored.v8BrowserBridgeProfile)) {
    if (stored.v8BrowserBridgeProfile !== undefined) await chrome.storage.local.remove(PROFILE_KEY);
    profile = null;
    // A login that ended (or a changed address) before the worker restarted is still that, with its reason.
    const terminal = stored[TERMINAL_KEY] as { state?: unknown; error?: unknown } | undefined;
    if (terminal?.state === "login_ended" || terminal?.state === "address_error") {
      error = typeof terminal.error === "string" ? terminal.error : null;
      setState(terminal.state);
    } else {
      setState("setup");
    }
    return;
  }
  profile = stored.v8BrowserBridgeProfile;
  // A profile from 6.0.0/6.0.1 has no stored last address: take it from the profile, and keep it, so a
  // refused first refresh still brings the form back with the address filled in.
  if (lastAddress === null) {
    lastAddress = profile.addressOrigin;
    await chrome.storage.local.set({ [LAST_ADDRESS_KEY]: lastAddress });
  }
  error = null;
  if (!enabled) { setState("off"); return; }
  if (accessTokenStale()) {
    setState("connecting");
    await refreshAccessToken();
    return;
  }
  scheduleRefresh();
  setState("connecting");
  hooks.openSocket();
}

const SETUP_ATTEMPTS = 3;
const SETUP_RETRY_MS = 1_000;

/** Redeem the dashboard's short-lived code immediately; V8 never asks an AI to approve it. */
export async function setup(address: string, setupCode: string, replace = false): Promise<void> {
  // One submission at a time: a second one (a paste that also submits) is ignored while one is running.
  if (setupAbort) return;
  const attemptNo = ++setupAttempt;
  const abort = setupAbort = new AbortController();
  const cancelled = (): boolean => attemptNo !== setupAttempt;
  try { await runSetup(address, setupCode, replace, abort.signal, cancelled); }
  finally { if (!cancelled() || setupAbort === abort) setupAbort = null; }
}

/** The popup's "취소" on the re-connect form: an attempt in flight is dropped even if its code is accepted late. */
export function cancelSetup(): void {
  if (setupCommitting) return; // past the commit boundary the new connection is already being installed
  setupAttempt++;
  setupAbort?.abort();
  setupAbort = null;
}

async function runSetup(address: string, setupCode: string, replace: boolean, signal: AbortSignal, cancelled: () => boolean): Promise<void> {
  // Re-connecting (`replace`) must not touch the standing connection until the new code is redeemed:
  // a failure only reports its reason, and the state, profile and socket stay as they were.
  // Likewise after a login ended: the form stays "your login ended" with the reason of this attempt.
  const keepState = replace || state === "login_ended";
  const fail = (message: string, next: AuthState): void => {
    error = message;
    // An address that cannot be used is a terminal state that survives a worker restart; any other failure clears it.
    if (!keepState) {
      if (next === "address_error") void chrome.storage.local.set({ [TERMINAL_KEY]: { state: next, error: message } });
      else void chrome.storage.local.remove(TERMINAL_KEY);
    }
    if (keepState) notify(); else setState(next);
  };
  let origin: string;
  try { origin = addressOrigin(address); }
  catch (cause) { fail((cause as Error).message, "address_error"); return; }
  const code = setupCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z2-9]{8}$/.test(code)) {
    fail("8자리 코드를 입력하세요", "setup");
    return;
  }
  const browserId = await stableBrowserId();
  if (cancelled()) return;
  error = null;
  if (!keepState) setState("connecting");
  // A network hiccup (Wi-Fi, a VPN reconnecting) should not make the person paste again: try a few
  // times before saying the address cannot be reached, and keep the reason in the worker's log.
  let reply: { status: number; ok: boolean; body: unknown } | undefined;
  for (let attempt = 0; attempt < SETUP_ATTEMPTS && !reply; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, SETUP_RETRY_MS * attempt));
    if (cancelled()) return; // a cancelled attempt sends nothing more, not even a retry
    try {
      reply = await requestJson(new URL("/api/enroll/redeem", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setup_code: code, stable_browser_id: browserId }),
      }, signal);
    } catch (cause) {
      if (cancelled()) return;
      console.log("[bb auth] enrollment request failed", { origin, attempt: attempt + 1, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  if (cancelled()) return;
  if (!reply) {
    fail("주소에 연결할 수 없습니다. 주소가 맞는지, 이 PC가 서버에 접속할 수 있는지(예: Tailscale) 확인해 주세요", "address_error");
    return;
  }
  const body = reply.body;
  if (!reply.ok) {
    fail(enrollmentError(reply.status, body), /expired|used/.test(String((body as { error?: unknown } | null)?.error)) ? "expired" : "setup");
    return;
  }
  let redeemed: EnrollRedeemResponse;
  try { redeemed = validateRedeem(body, browserId); }
  catch (cause) { fail((cause as Error).message, "setup"); return; }
  // The commit boundary: until this block starts, a cancel stops the attempt and nothing changes. Once it
  // starts (`setupCommitting`), the replacement runs to the end and a cancel arriving then is ignored.
  const committed = await serialized(async () => {
    if (cancelled()) return false;
    setupCommitting = true;
    try {
    await saveProfile({
      schemaVersion: 8,
      addressOrigin: origin,
      wsEndpoint: redeemed.ws_endpoint,
      relayBinding: redeemed.relay_binding,
      browserId,
      accessToken: redeemed.access_token ?? null,
      refreshToken: redeemed.refresh_token ?? null,
      tokenExpiresAt: redeemed.expires_in ? Date.now() + redeemed.expires_in * 1_000 : null,
    }, true);
    // Redeemed: a new code also means the person wants it on, and the old socket (if any) goes.
    enabled = true;
    retryReason = null;
    nextRetryAt = null;
    outageStartedAt = null;
    await chrome.storage.local.set({ [ENABLED_KEY]: true });
    await chrome.storage.local.remove(OUTAGE_KEY);
    return true;
    } finally { setupCommitting = false; }
  });
  if (!committed) return;
  hooks?.closeSocket();
  scheduleRefresh();
  setState("connecting");
  hooks?.openSocket();
}

/**
 * The popup's switch. Off keeps the profile and closes the socket without reconnecting; on reconnects
 * with the stored profile, no code needed. The caller tells the relay and stops the AI's work first
 * (background.ts), because the socket must still be open for that.
 */
export async function setEnabled(next: boolean): Promise<void> {
  if (!profile || next === enabled) return;
  enabled = next;
  await chrome.storage.local.set({ [ENABLED_KEY]: next });
  error = null;
  if (!next) {
    clearRefreshTimer();
    // Deliberate downtime is not an outage: nothing of "unreachable for N days" carries over to switching on.
    retryReason = null;
    nextRetryAt = null;
    outageStartedAt = null;
    await chrome.storage.local.remove(OUTAGE_KEY);
    hooks?.closeSocket();
    setState("off");
    return;
  }
  if (accessTokenStale()) {
    setState("connecting");
    await refreshAccessToken();
    return;
  }
  scheduleRefresh();
  setState("connecting");
  hooks?.openSocket();
}

/** The popup's "연결 정보 지우기": forget the profile, the address and the last-connected time. */
export async function reset(): Promise<void> {
  await serialized(async () => {
    lastAddress = null;
    lastConnectedAt = null;
    await chrome.storage.local.remove([LAST_ADDRESS_KEY, LAST_CONNECTED_KEY]);
    await clearProfile(null, "setup");
  });
}

/**
 * Apply a new device name. It is stored, shown, and sent to the relay over the socket that is already
 * open (relay `extension_rename`); no reconnect, because closing the socket ends the AI's running work.
 * A relay without that frame keeps the old name until the next natural reconnect, which carries it in the URL.
 */
export async function setDeviceName(raw: string): Promise<void> {
  const name = raw.trim().slice(0, 40);
  if (!name || name === deviceName) return;
  deviceName = name;
  await chrome.storage.local.set({ [NAME_KEY]: name });
  notify();
  if (isEnabled()) hooks?.announceName?.(name);
}
export function markRetry(at: number | null, reason: ConnectionIssue | null = null): void {
  nextRetryAt = at;
  retryReason = reason;
  // The outage starts at the first failure after being connected (or since the start), not at the
  // last socket open: "unreachable for 3 days" is measured from here.
  if (outageStartedAt === null && reason !== null) {
    outageStartedAt = Date.now();
    void chrome.storage.local.set({ [OUTAGE_KEY]: outageStartedAt });
  }
  notify();
}
export function markConnecting(): void { if (isEnabled()) setState("connecting"); }
export function markConnected(): void {
  if (!isEnabled()) return;
  lastConnectedAt = Date.now();
  nextRetryAt = null;
  retryReason = null;
  outageStartedAt = null;
  void chrome.storage.local.set({ [LAST_CONNECTED_KEY]: lastConnectedAt });
  void chrome.storage.local.remove(OUTAGE_KEY);
  setState("connected");
}

function defaultDeviceName(): string {
  const agent = navigator.userAgent;
  const os = /Windows/.test(agent) ? "Windows" : /Mac/.test(agent) ? "Mac" : /Linux/.test(agent) ? "Linux" : "이 컴퓨터";
  const browser = /Edg\//.test(agent) ? "Edge" : "Chrome";
  return `${os}의 ${browser}`;
}

/** What a socket must be checked against, captured when it opens (the profile may be replaced while it connects). */
export interface ConnectionExpectation { relayBinding: string; generation: number }
export function connectionExpectation(): ConnectionExpectation | null {
  return profile ? { relayBinding: profile.relayBinding, generation } : null;
}

/**
 * Relay binding is checked on every socket, stopping a stale endpoint from becoming another person's relay.
 * The check is against the login the socket was opened with: a delayed binding from an old socket, arriving
 * after a new login replaced the profile, is ignored (it cannot wipe the new login). A real mismatch wipes
 * only if, inside the serialized commit, the login is still that generation and the socket is still current.
 */
export async function onRelayBinding(binding: string, expected: ConnectionExpectation, ownsSocket: () => boolean): Promise<boolean> {
  if (!profile || generation !== expected.generation) return false;
  if (binding === expected.relayBinding) return true;
  await serialized(async () => {
    if (!profile || generation !== expected.generation || !ownsSocket()) return;
    // The old address is the wrong one now, so it is not kept for the form.
    lastAddress = null;
    await chrome.storage.local.remove(LAST_ADDRESS_KEY);
    await clearProfile("연결 주소가 변경되었습니다. 대시보드의 새 주소와 코드로 다시 설정하세요", "address_error");
  });
  return false;
}

/** Retry later after a refresh the network or the server could not answer (30 s), and say so in the popup. */
function retryRefreshLater(forGeneration: number): void {
  if (forGeneration !== generation) return;
  clearRefreshTimer();
  refreshTimer = setTimeout(() => void refreshAccessToken(), REFRESH_RETRY_MS);
  markRetry(Date.now() + REFRESH_RETRY_MS, "unreachable");
}

/**
 * Exchange the refresh token for a new access token and a rotated refresh token (the request says it can
 * store one, which is what makes a 6.1.0 relay rotate; an older relay ignores the field and sends none).
 * Callers at once (timer, 4401, a socket about to open, the alarm) share one request per login generation:
 * with rotation a second request would present a token that was just replaced.
 */
export function refreshAccessToken(): Promise<boolean> {
  if (refreshing && refreshing.generation === generation) return refreshing.promise;
  const started = generation;
  const promise: Promise<boolean> = doRefresh(started).finally(() => { if (refreshing?.promise === promise) refreshing = null; });
  refreshing = { generation: started, promise };
  return promise;
}

async function doRefresh(started: number): Promise<boolean> {
  const used = profile;
  if (!used?.refreshToken) return false;
  let reply: { status: number; ok: boolean; body: unknown };
  try {
    reply = await requestJson(new URL("/api/auth/refresh", used.addressOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: used.refreshToken, accepts_rotation: true }),
    });
  } catch {
    retryRefreshLater(started);
    return false;
  }
  // Whatever came back concerns the login this request started with; if that login was replaced or
  // dropped meanwhile (a new code, reset), the outcome is discarded.
  if (started !== generation) return false;
  if (reply.status === 401) {
    await serialized(async () => { if (started === generation) await clearProfile(null, "login_ended"); });
    return false;
  }
  const token = reply.body as TokenResponse | null;
  if (!reply.ok) {
    retryRefreshLater(started);
    return false;
  }
  if (!token || typeof token.access_token !== "string" || !token.access_token || token.token_type !== "bearer" || typeof token.expires_in !== "number") {
    retryRefreshLater(started); // a garbled answer is retried; it is not a reason to forget the login
    return false;
  }
  const committed = await serialized(async () => {
    if (started !== generation || !profile) return false;
    // A rotating relay sends a new refresh token (its 30 days start now): keep it. An older one sends none.
    await saveProfile({
      ...profile,
      accessToken: token.access_token,
      refreshToken: typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : profile.refreshToken,
      tokenExpiresAt: Date.now() + token.expires_in * 1_000,
    });
    return true;
  });
  if (!committed) return false;
  scheduleRefresh();
  if (profile && enabled) hooks?.openSocket();
  return true;
}

export async function onWsClosed(code: number): Promise<"reconnect" | "stop"> {
  if (!isEnabled()) return "stop";
  if (code === WS_CLOSE_UNAUTHORIZED) return await refreshAccessToken() ? "stop" : "stop";
  return "reconnect";
}
