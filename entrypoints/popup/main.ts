import { compareExtensionVersions, isExtensionVersion } from "../../shared/protocol";
import { parsePairing } from "../lib/pairing";

/** What the service worker sends (background.ts popupSnapshot). */
interface PopupSnapshot {
  state: "setup" | "connecting" | "connected" | "off" | "expired" | "address_error";
  error: string | null;
  address: string | null;
  deviceName: string;
  version: string;
  latestExtensionVersion: string | null;
  working: boolean;
  page: { title: string; url: string; favIconUrl: string | null } | null;
  siteAccess: boolean;
}
type Request =
  | { type: "getState" | "focusTarget" }
  | { type: "setup" | "reconnect"; address: string; code: string }
  | { type: "setEnabled"; enabled: boolean }
  | { type: "setDeviceName"; name: string };

// A Web Store install carries update_url and Chrome updates it by itself; an unpacked copy does not.
const fromStore = Boolean((chrome.runtime.getManifest() as { update_url?: string }).update_url);

const address = byId<HTMLInputElement>("address");
const code = byId<HTMLInputElement>("code");
// The setup page a fresh install opens: the same card, centred, with the pin hint.
const welcome = new URLSearchParams(location.search).has("welcome");
if (welcome) document.documentElement.classList.add("page");
const deviceName = byId<HTMLInputElement>("device-name");
const menu = byId("menu");
const more = byId<HTMLButtonElement>("more");
let pending = false;
// Re-connecting: the setup form shown over a standing connection, which stays until a new code is redeemed.
let reconnecting = false;
let reconnectTried = false;
let last: PopupSnapshot | null = null;

function host(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function render(s: PopupSnapshot): void {
  last = s;
  const setup = s.state === "setup" || s.state === "expired" || s.state === "address_error";
  // Without a connection there is nothing to keep: the form is the plain first-time setup.
  if (setup) reconnecting = false;
  const form = setup || reconnecting;
  byId("setup").hidden = !form;
  byId("status").hidden = form;
  more.hidden = form;
  if (form) closeMenu();
  byId("setup-title").textContent = reconnecting ? "다시 연결하기" : "내 서버와 연결하기";
  byId("setup-desc").innerText = reconnecting ? "대시보드에서 새 코드를 받아 넣으세요.\n연결될 때까지 지금 연결은 그대로 둡니다." : "DCCB 대시보드의 주소와 코드를 넣으면\n이후로는 알아서 연결됩니다.";
  byId("cancel").hidden = !reconnecting;
  byId("version").textContent = `v${s.version}`;
  byId("device").textContent = setup ? "연결 전" : s.deviceName;
  if (document.activeElement !== deviceName) deviceName.value = s.deviceName;

  const setupError = byId("setup-error");
  // A failed re-connect keeps the old connection, so only a reason from this form's own attempt is shown.
  const error = reconnecting ? (reconnectTried ? s.error : null)
    : s.state === "expired" ? "코드가 만료됐습니다. 대시보드에서 새 코드를 받아 주세요." : s.error;
  setupError.hidden = !error;
  setupError.textContent = error ?? "";
  byId<HTMLButtonElement>("connect").disabled = pending;
  byId("pin-hint").hidden = !welcome;
  byId("site-access").hidden = setup || s.siteAccess;
  byId("welcome-done").hidden = !(welcome && s.state === "connected");

  const off = s.state === "off";
  const look = off ? { cls: "off", icon: "#pause", title: "꺼 둠", desc: "AI가 이 Chrome을 쓰지 않습니다.\n켜면 바로 다시 연결됩니다." }
    : s.working ? { cls: "busy", icon: "#spark", title: "AI가 작업 중", desc: "내 탭은 그대로 둡니다." }
    : s.state === "connected" ? { cls: "ok", icon: "#check", title: "연결됨", desc: "AI가 필요할 때 뒤쪽 탭에서 일합니다.\n내 탭은 건드리지 않습니다." }
    : { cls: "idle", icon: "#sync", title: "다시 연결하는 중", desc: "서버와 잠깐 끊겼습니다.\n알아서 다시 잇습니다." };
  byId("orb").className = `orb ${look.cls}`;
  byId("orb-icon").setAttribute("href", look.icon);
  byId("title").textContent = look.title;
  byId("desc").innerText = look.desc;
  byId("dev-dot").className = `dot ${setup ? "idle" : look.cls}`;

  // The settings box: the person's switch (its small text says what turning it off does right now).
  const toggle = byId<HTMLButtonElement>("switch");
  toggle.setAttribute("aria-checked", String(!off));
  toggle.disabled = pending;
  byId("switch-hint").textContent = off ? "켜면 바로 다시 연결됩니다"
    : s.working ? "끄면 하던 일이 멈추고 AI 탭이 닫힙니다" : "끄면 연결 정보는 남고 AI는 쉽니다";

  // The AI's page: the one it is on while it works, or the one it left open for the person.
  const card = byId<HTMLButtonElement>("card");
  card.hidden = setup || off || !s.page;
  if (!setup && !off && s.page) {
    byId("page-label").textContent = s.working ? "지금 보는 페이지 · 누르면 이동" : "AI가 열어 둔 페이지 · 누르면 이동";
    byId("page-title").textContent = s.page.title || host(s.page.url);
    byId("page-host").textContent = host(s.page.url);
    const fav = byId("fav");
    fav.replaceChildren();
    if (s.page.favIconUrl && /^https?:/.test(s.page.favIconUrl)) {
      const img = document.createElement("img");
      img.src = s.page.favIconUrl;
      img.alt = "";
      img.addEventListener("error", () => { fav.textContent = host(s.page!.url).slice(0, 1).toUpperCase(); });
      fav.append(img);
    } else {
      fav.textContent = host(s.page.url).slice(0, 1).toUpperCase();
    }
  }

  // Only an unpacked copy needs the person to update it; the Web Store copy updates itself.
  const latest = s.latestExtensionVersion;
  const outdated = !fromStore && isExtensionVersion(s.version) && isExtensionVersion(latest) && compareExtensionVersions(s.version, latest) < 0;
  const update = byId("update");
  update.hidden = !outdated;
  if (outdated) {
    update.replaceChildren();
    const strong = document.createElement("b");
    strong.textContent = `새 버전 ${latest}이 나왔어요.`;
    // Until the Web Store copy is published, an unpacked copy updates from the dashboard ZIP.
    update.append(strong, document.createElement("br"), "DCCB 대시보드 Browser Bridge 카드의 ZIP을 지금 확장 폴더에 덮어쓰고 chrome://extensions에서 ↻를 누르세요.");
  }
}

async function ask(request: Request): Promise<PopupSnapshot | undefined> {
  const response = await chrome.runtime.sendMessage(request) as PopupSnapshot | undefined;
  if (response) render(response);
  return response;
}

function closeMenu(): void {
  menu.hidden = true;
  more.setAttribute("aria-expanded", "false");
}

function connect(): void {
  const setupError = byId("setup-error");
  if (!address.value.trim() || !code.value.trim()) {
    setupError.hidden = false;
    setupError.textContent = !address.value.trim() ? "대시보드의 주소를 넣어 주세요." : "대시보드의 8자리 코드를 넣어 주세요.";
    return;
  }
  pending = true;
  byId<HTMLButtonElement>("connect").disabled = true;
  if (reconnecting) reconnectTried = true;
  void ask({ type: reconnecting ? "reconnect" : "setup", address: address.value.trim(), code: code.value })
    .then(response => {
      // Redeemed: the new connection took over, so the form's job is done. A failure leaves it open with its reason.
      if (reconnecting && response && !response.error) { reconnecting = false; render(response); }
    })
    .finally(() => { pending = false; byId<HTMLButtonElement>("connect").disabled = false; });
}
byId("reconnect").addEventListener("click", () => {
  reconnecting = true;
  reconnectTried = false;
  address.value = last?.address ?? "";
  code.value = "";
  if (last) render(last);
  code.focus();
});
byId("cancel").addEventListener("click", () => {
  reconnecting = false;
  if (last) render(last);
});
byId("switch").addEventListener("click", () => {
  if (!last || pending) return;
  pending = true;
  byId<HTMLButtonElement>("switch").disabled = true;
  void ask({ type: "setEnabled", enabled: last.state === "off" }).finally(() => { pending = false; byId<HTMLButtonElement>("switch").disabled = false; });
});
byId("setup-form").addEventListener("submit", event => { event.preventDefault(); connect(); });
code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8); });
// Pasting the dashboard's address and code together into either field fills both.
for (const field of [address, code]) {
  field.addEventListener("paste", event => {
    const { address: pastedAddress, code: pastedCode } = parsePairing(event.clipboardData?.getData("text") ?? "");
    if (!pastedAddress && !pastedCode) return;
    if (field === address && !pastedAddress) return;
    event.preventDefault();
    if (pastedAddress) address.value = pastedAddress;
    if (pastedCode) code.value = pastedCode;
    if (address.value && code.value.length === 8) connect();
  });
}
byId("card").addEventListener("click", () => void ask({ type: "focusTarget" }).then(() => { if (!welcome) window.close(); }));
more.addEventListener("click", () => {
  const open = menu.hidden;
  menu.hidden = !open;
  more.setAttribute("aria-expanded", String(open));
  if (open) deviceName.focus();
});
document.addEventListener("click", event => {
  if (!menu.hidden && !menu.contains(event.target as Node) && !more.contains(event.target as Node)) closeMenu();
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
byId("name-form").addEventListener("submit", event => {
  event.preventDefault();
  void ask({ type: "setDeviceName", name: deviceName.value }).then(closeMenu);
});
deviceName.addEventListener("change", () => void ask({ type: "setDeviceName", name: deviceName.value }));
chrome.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as { type?: string; snapshot?: PopupSnapshot };
  if (message.type === "stateUpdate" && message.snapshot) render(message.snapshot);
});
void ask({ type: "getState" });

function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
