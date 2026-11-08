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
const REFRESH_LEAD_MS = 10 * 60 * 1_000;
const REFRESH_RETRY_MS = 30_000;

export type AuthState = "setup" | "connecting" | "connected" | "off" | "expired" | "address_error";

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
}

export interface AuthHooks {
  openSocket(): void;
  closeSocket(): void;
  onChange(snapshot: AuthSnapshot): void;
}

let profile: V8Profile | null = null;
let state: AuthState = "setup";
let error: string | null = null;
let enabled = true;
let deviceName = "이 컴퓨터의 Chrome";
let lastConnectedAt: number | null = null;
let nextRetryAt: number | null = null;
let hooks: AuthHooks | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void { hooks?.onChange(snapshot()); }
function setState(next: AuthState): void { state = next; notify(); }

export function snapshot(): AuthSnapshot {
  return { state, address: profile?.addressOrigin ?? null, browserId: profile?.browserId ?? null, error, enabled, deviceName, lastConnectedAt, nextRetryAt };
}

/** Public route identity, not a credential; distinguishes HOME bindings on one door. */
export function connectionKey(): string {
  return JSON.stringify([profile?.addressOrigin, profile?.relayBinding, profile?.browserId]);
}

export function isEnabled(): boolean { return enabled && profile !== null; }
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
    case "expired_code": return "코드가 만료되었습니다. 대시보드의 새 코드를 사용하세요";
    case "used_code": return "이미 사용한 코드입니다. 대시보드의 새 코드를 사용하세요";
    case "route_mismatch": return "연결 주소가 현재 계정의 relay와 맞지 않습니다";
    case "route_unavailable": return "브라우저 relay가 아직 준비되지 않았습니다";
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

async function saveProfile(next: V8Profile): Promise<void> {
  profile = next;
  await chrome.storage.local.set({ [PROFILE_KEY]: next });
}

async function clearProfile(nextError: string | null, nextState: AuthState = "setup"): Promise<void> {
  clearRefreshTimer();
  profile = null;
  error = nextError;
  await chrome.storage.local.remove(PROFILE_KEY);
  hooks?.closeSocket();
  setState(nextError ? nextState : "setup");
}

function scheduleRefresh(): void {
  clearRefreshTimer();
  if (!profile?.refreshToken || !profile.tokenExpiresAt) return;
  const delay = Math.max(profile.tokenExpiresAt - Date.now() - REFRESH_LEAD_MS, 30_000);
  refreshTimer = setTimeout(() => void refreshAccessToken(), delay);
}

export async function init(nextHooks: AuthHooks): Promise<void> {
  hooks = nextHooks;
  const stored = await chrome.storage.local.get([PROFILE_KEY, ENABLED_KEY, NAME_KEY, LAST_CONNECTED_KEY]) as Record<string, unknown>;
  // 6.0.0 has no on/off switch (a person turns the extension off in chrome://extensions); a Chrome
  // switched off in an older version comes back on.
  enabled = true;
  if (stored[ENABLED_KEY] === false) await chrome.storage.local.remove(ENABLED_KEY);
  deviceName = typeof stored[NAME_KEY] === "string" && stored[NAME_KEY].trim() ? String(stored[NAME_KEY]).slice(0, 40) : defaultDeviceName();
  lastConnectedAt = typeof stored[LAST_CONNECTED_KEY] === "number" ? stored[LAST_CONNECTED_KEY] : null;
  if (!validProfile(stored.v8BrowserBridgeProfile)) {
    if (stored.v8BrowserBridgeProfile !== undefined) await chrome.storage.local.remove(PROFILE_KEY);
    profile = null;
    setState("setup");
    return;
  }
  profile = stored.v8BrowserBridgeProfile;
  error = null;
  if (!enabled) { setState("off"); return; }
  if (requiresBearer() && profile.tokenExpiresAt !== null && profile.tokenExpiresAt <= Date.now()) {
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
export async function setup(address: string, setupCode: string): Promise<void> {
  let origin: string;
  try { origin = addressOrigin(address); }
  catch (cause) { error = (cause as Error).message; setState("address_error"); return; }
  const code = setupCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z2-9]{8}$/.test(code)) {
    error = "8자리 코드를 입력하세요";
    setState("setup");
    return;
  }
  enabled = true;
  await chrome.storage.local.set({ [ENABLED_KEY]: true });
  const browserId = await stableBrowserId();
  error = null;
  setState("connecting");
  // A network hiccup (Wi-Fi, a VPN reconnecting) should not make the person paste again: try a few
  // times before saying the address cannot be reached, and keep the reason in the worker's log.
  let response: Response | undefined;
  for (let attempt = 0; attempt < SETUP_ATTEMPTS && !response; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, SETUP_RETRY_MS * attempt));
    try {
      response = await fetch(new URL("/api/enroll/redeem", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setup_code: code, stable_browser_id: browserId }),
      });
    } catch (cause) {
      console.log("[bb auth] enrollment request failed", { origin, attempt: attempt + 1, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  if (!response) {
    error = "주소에 연결할 수 없습니다. 주소가 맞는지, 이 PC가 서버에 접속할 수 있는지(예: Tailscale) 확인해 주세요";
    setState("address_error");
    return;
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    error = enrollmentError(response.status, body);
    setState(/expired|used/.test(String((body as { error?: unknown } | null)?.error)) ? "expired" : "setup");
    return;
  }
  try {
    const redeemed = validateRedeem(body, browserId);
    await saveProfile({
      schemaVersion: 8,
      addressOrigin: origin,
      wsEndpoint: redeemed.ws_endpoint,
      relayBinding: redeemed.relay_binding,
      browserId,
      accessToken: redeemed.access_token ?? null,
      refreshToken: redeemed.refresh_token ?? null,
      tokenExpiresAt: redeemed.expires_in ? Date.now() + redeemed.expires_in * 1_000 : null,
    });
  } catch (cause) {
    error = (cause as Error).message;
    setState("setup");
    return;
  }
  scheduleRefresh();
  setState("connecting");
  hooks?.openSocket();
}

export async function reset(): Promise<void> { await clearProfile(null); }
export async function setDeviceName(raw: string): Promise<void> {
  const name = raw.trim().slice(0, 40);
  if (!name) return;
  deviceName = name;
  await chrome.storage.local.set({ [NAME_KEY]: name });
  notify();
  if (isEnabled()) { hooks?.closeSocket(); hooks?.openSocket(); }
}
export function markRetry(at: number | null): void { nextRetryAt = at; notify(); }
export function markConnecting(): void { if (isEnabled()) setState("connecting"); }
export function markConnected(): void {
  if (!isEnabled()) return;
  lastConnectedAt = Date.now();
  nextRetryAt = null;
  void chrome.storage.local.set({ [LAST_CONNECTED_KEY]: lastConnectedAt });
  setState("connected");
}

function defaultDeviceName(): string {
  const agent = navigator.userAgent;
  const os = /Windows/.test(agent) ? "Windows" : /Mac/.test(agent) ? "Mac" : /Linux/.test(agent) ? "Linux" : "이 컴퓨터";
  const browser = /Edg\//.test(agent) ? "Edge" : "Chrome";
  return `${os}의 ${browser}`;
}

/** Relay binding is checked on every socket, stopping a stale endpoint from becoming another person's relay. */
export async function onRelayBinding(binding: string): Promise<boolean> {
  if (profile && binding !== profile.relayBinding) {
    await clearProfile("연결 주소가 변경되었습니다. 대시보드의 새 주소와 코드로 다시 설정하세요", "address_error");
    return false;
  }
  return profile !== null;
}

export async function refreshAccessToken(): Promise<boolean> {
  if (!profile?.refreshToken) return false;
  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/refresh", profile.addressOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: profile.refreshToken }),
    });
  } catch {
    clearRefreshTimer();
    refreshTimer = setTimeout(() => void refreshAccessToken(), REFRESH_RETRY_MS);
    return false;
  }
  if (response.status === 401) {
    await clearProfile("인증이 만료되었습니다. 대시보드의 새 주소와 코드로 다시 설정하세요", "expired");
    return false;
  }
  if (!response.ok) {
    clearRefreshTimer();
    refreshTimer = setTimeout(() => void refreshAccessToken(), REFRESH_RETRY_MS);
    return false;
  }
  const token = await response.json() as TokenResponse;
  if (!token.access_token || token.token_type !== "bearer" || typeof token.expires_in !== "number") {
    await clearProfile("relay 인증 응답이 올바르지 않습니다", "address_error");
    return false;
  }
  await saveProfile({ ...profile, accessToken: token.access_token, tokenExpiresAt: Date.now() + token.expires_in * 1_000 });
  scheduleRefresh();
  if (profile) hooks?.openSocket();
  return true;
}

export async function onWsClosed(code: number): Promise<"reconnect" | "stop"> {
  if (!isEnabled()) return "stop";
  if (code === WS_CLOSE_UNAUTHORIZED) return await refreshAccessToken() ? "stop" : "stop";
  return "reconnect";
}
