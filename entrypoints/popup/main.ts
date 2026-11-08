import { compareExtensionVersions, isExtensionVersion } from "../../shared/protocol";

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
}
type Request =
  | { type: "getState" | "reset" | "focusTarget" }
  | { type: "setup"; address: string; code: string }
  | { type: "setDeviceName"; name: string };

const STORE_URL = "https://chromewebstore.google.com/detail/gphieniaobkdapliaeihgmhhphcfbafp";
// A Web Store install carries update_url and Chrome updates it by itself; an unpacked copy does not.
const fromStore = Boolean((chrome.runtime.getManifest() as { update_url?: string }).update_url);

const address = byId<HTMLInputElement>("address");
const code = byId<HTMLInputElement>("code");
const deviceName = byId<HTMLInputElement>("device-name");
const menu = byId("menu");
const more = byId<HTMLButtonElement>("more");
let pending = false;

function host(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function render(s: PopupSnapshot): void {
  const setup = s.state === "setup" || s.state === "expired" || s.state === "address_error";
  byId("setup").hidden = !setup;
  byId("status").hidden = setup;
  more.hidden = setup;
  if (setup) closeMenu();
  byId("version").textContent = `v${s.version}`;
  byId("device").textContent = setup ? "연결 전" : s.deviceName;
  if (document.activeElement !== deviceName) deviceName.value = s.deviceName;

  const setupError = byId("setup-error");
  const error = s.state === "expired" ? "코드가 만료됐습니다. 대시보드에서 새 코드를 받아 주세요." : s.error;
  setupError.hidden = !error;
  setupError.textContent = error ?? "";
  byId<HTMLButtonElement>("connect").disabled = pending;

  const look = s.working ? { cls: "busy", icon: "#spark", title: "AI가 작업 중", desc: "내 탭은 그대로 둡니다." }
    : s.state === "connected" ? { cls: "ok", icon: "#check", title: "연결됨", desc: "AI가 필요할 때 뒤쪽 탭에서 일하고\n끝나면 닫습니다." }
    : { cls: "idle", icon: "#sync", title: "다시 연결하는 중", desc: "서버와 잠깐 끊겼습니다.\n알아서 다시 잇습니다." };
  byId("orb").className = `orb ${look.cls}`;
  byId("orb-icon").setAttribute("href", look.icon);
  byId("title").textContent = look.title;
  byId("desc").innerText = look.desc;
  byId("dev-dot").className = `dot ${setup ? "idle" : look.cls}`;

  const card = byId<HTMLButtonElement>("card");
  card.hidden = !(s.working && s.page);
  if (s.working && s.page) {
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
    const link = document.createElement("a");
    link.href = STORE_URL;
    link.target = "_blank";
    link.textContent = "Chrome 웹스토어에서 설치";
    update.append(strong, document.createElement("br"), link, "하면 이후로는 알아서 업데이트됩니다.");
  }
}

async function ask(request: Request): Promise<void> {
  const response = await chrome.runtime.sendMessage(request) as PopupSnapshot | undefined;
  if (response) render(response);
}

function closeMenu(): void {
  menu.hidden = true;
  more.setAttribute("aria-expanded", "false");
}

byId("setup-form").addEventListener("submit", event => {
  event.preventDefault();
  pending = true;
  byId<HTMLButtonElement>("connect").disabled = true;
  void ask({ type: "setup", address: address.value, code: code.value }).finally(() => { pending = false; byId<HTMLButtonElement>("connect").disabled = false; });
});
code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8); });
code.addEventListener("paste", event => {
  const text = event.clipboardData?.getData("text") ?? "";
  const match = text.toUpperCase().replace(/[^A-Z2-9]/g, "").match(/[A-Z2-9]{8}/);
  if (match) { event.preventDefault(); code.value = match[0]; }
});
byId("card").addEventListener("click", () => void ask({ type: "focusTarget" }).then(() => window.close()));
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
byId("reset").addEventListener("click", () => {
  if (!confirm("이 Chrome의 연결을 지우고 주소와 코드를 다시 넣을까요?")) return;
  closeMenu();
  void ask({ type: "reset" });
});
chrome.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as { type?: string; snapshot?: PopupSnapshot };
  if (message.type === "stateUpdate" && message.snapshot) render(message.snapshot);
});
void ask({ type: "getState" });

function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
