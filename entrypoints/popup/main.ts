import type { AuthSnapshot } from "../lib/v8-auth";
import { compareExtensionVersions, isExtensionVersion } from "../../shared/protocol";

type PopupSnapshot = AuthSnapshot & {
  latestExtensionVersion: string | null;
  working: boolean;
  dedicatedWindow: boolean;
  targetInfo: { title: string; url: string } | null;
  popupError: string | null;
  pipeProblem: { message: string; at: number } | null;
  humanHandoff: boolean;
  handoffMessage: string | null;
  activity: { label: string; at: number }[];
};
type Request =
  | { type: "getState" | "reset" }
  | { type: "setup"; address: string; code: string }
  | { type: "setEnabled"; enabled: boolean }
  | { type: "setDeviceName"; name: string }
  | { type: "setHandoff"; handoff: boolean }
  | { type: "stopHandoff" }
  | { type: "setDedicatedWindow"; enabled: boolean }
  | { type: "focusTarget" };

let current: PopupSnapshot | null = null;
const address = byId<HTMLInputElement>("address");
const code = byId<HTMLInputElement>("code");
const deviceName = byId<HTMLInputElement>("device-name");
const currentVersion = chrome.runtime.getManifest().version;
byId("version").textContent = `v${currentVersion}`;

function clock(at: number | null): string {
  return at ? new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(at) : "—";
}
function render(s: PopupSnapshot): void {
  current = s;
  byId<HTMLInputElement>("dedicated-window").checked = s.dedicatedWindow;
  byId("target-info").textContent = s.targetInfo ? s.targetInfo.title + "\n" + s.targetInfo.url : "제어 탭 없음";
  byId("last-action").textContent = "마지막 동작: " + clock(s.activity[0]?.at ?? null);
  byId("focus-error").textContent = s.popupError ?? "";
  byId("pipe-problem").textContent = s.pipeProblem ? `AI 작업 멈춤 (${clock(s.pipeProblem.at)}): ${s.pipeProblem.message}` : "";
  const latest = s.latestExtensionVersion;
  const hasUpdate = isExtensionVersion(currentVersion) && isExtensionVersion(latest)
    && compareExtensionVersions(currentVersion, latest) < 0;
  byId("update-banner").hidden = !hasUpdate;
  byId("update-title").textContent = hasUpdate ? `새 버전 ${latest}이 나왔어요 (지금 ${currentVersion})` : "";
  byId("update-instructions").textContent = hasUpdate
    ? "개발 대시보드 › Browser Bridge 연결 스레드에서 ZIP을 받아 지금 확장 폴더에 덮어쓰고, chrome://extensions에서 ↻를 누르세요."
    : "";
  const labels: Record<AuthSnapshot["state"], string> = {
    setup: "연결 전", connecting: "재연결 중", connected: "연결됨", off: "꺼짐",
    expired: "등록 만료", address_error: "주소 오류",
  };
  const setup = s.state === "setup" || s.state === "expired" || s.state === "address_error";
  byId("setup-panel").hidden = !setup;
  byId("connected-panel").hidden = setup;
  byId("status-label").textContent = s.working && s.enabled && !s.humanHandoff ? "AI 작업 중" : labels[s.state];
  byId("status-dot").className = `dot ${s.state}`;
  byId("summary").textContent = s.humanHandoff ? "사람이 처리하는 동안 AI 작업을 보류합니다." :
    s.state === "off" ? "AI가 이 Chrome에 접근할 수 없습니다." :
    s.state === "connecting" ? "연결을 자동으로 다시 시도합니다." :
    s.state === "connected" ? "필요할 때만 DCCB 전용 탭에서 작업합니다." : "대시보드의 주소와 코드를 입력하세요.";
  byId("setup-error").textContent = s.error ?? "";
  byId("setup-error").hidden = !s.error;
  byId("diagnosis").textContent = s.state === "connected" ? "진단: 서버 연결 정상" :
    s.state === "off" ? "진단: 사용자가 브릿지를 껐습니다." :
    s.state === "expired" ? "진단: 등록이 만료되었습니다. 새 코드가 필요합니다." :
    s.state === "address_error" ? `진단: ${s.error ?? "주소를 확인하세요."}` :
    s.state === "connecting" ? "진단: Chrome 인터넷 연결과 서버 상태를 확인하세요." : "진단: 등록이 필요합니다.";
  byId("connected-address").textContent = s.address ?? "—";
  byId("last-connected").textContent = clock(s.lastConnectedAt);
  byId("next-retry").textContent = clock(s.nextRetryAt);
  const toggle = byId<HTMLButtonElement>("toggle");
  toggle.classList.toggle("on", s.enabled);
  toggle.setAttribute("aria-checked", String(s.enabled));
  if (document.activeElement !== deviceName) deviceName.value = s.deviceName;
  byId("handoff").textContent = s.humanHandoff ? "계속" : "넘기기";
  const handoffMessage = byId("handoff-message");
  handoffMessage.hidden = !s.humanHandoff || s.handoffMessage === null;
  handoffMessage.textContent = s.handoffMessage ?? "";
  byId<HTMLButtonElement>("stop-handoff").hidden = !s.humanHandoff || s.handoffMessage === null;
  const activity = byId("activity");
  activity.replaceChildren();
  if (s.activity.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "아직 동작이 없습니다.";
    activity.append(empty);
  }
  for (const item of s.activity) {
    const li = document.createElement("li");
    li.append(document.createTextNode(item.label));
    const time = document.createElement("time");
    time.textContent = clock(item.at);
    li.append(time);
    activity.append(li);
  }
}
async function ask(request: Request): Promise<void> {
  const response = await chrome.runtime.sendMessage(request) as PopupSnapshot | undefined;
  if (response) render(response);
}
byId("connect").addEventListener("click", () => void ask({ type: "setup", address: address.value, code: code.value }));
byId("reset").addEventListener("click", () => void ask({ type: "reset" }));
byId("toggle").addEventListener("click", () => void ask({ type: "setEnabled", enabled: !current?.enabled }));
byId<HTMLInputElement>("dedicated-window").addEventListener("change", e => void ask({ type: "setDedicatedWindow", enabled: (e.target as HTMLInputElement).checked }));
byId("show-ai-tab").addEventListener("click", () => void ask({ type: "focusTarget" }));
byId("handoff").addEventListener("click", () => void ask({ type: "setHandoff", handoff: !current?.humanHandoff }));
byId("stop-handoff").addEventListener("click", () => void ask({ type: "stopHandoff" }));
deviceName.addEventListener("change", () => void ask({ type: "setDeviceName", name: deviceName.value }));
code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8); });
code.addEventListener("paste", event => {
  const text = event.clipboardData?.getData("text") ?? "";
  const match = text.toUpperCase().replace(/[^A-Z2-9]/g, "").match(/[A-Z2-9]{8}/);
  if (match) { event.preventDefault(); code.value = match[0]; }
});
code.addEventListener("keydown", event => { if (event.key === "Enter") void ask({ type: "setup", address: address.value, code: code.value }); });
chrome.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as { type?: string; snapshot?: PopupSnapshot };
  if (message.type === "stateUpdate" && message.snapshot) render(message.snapshot);
});
void ask({ type: "getState" });
function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
