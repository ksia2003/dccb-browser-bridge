## 6.0.0 — 2026-11-08

1.2.2와 코드가 같고 번호만 올렸습니다. Chrome 웹스토어의 기존 항목이 옛 판 5.1.0이라, 업데이트로 올리려면 그보다 큰 번호가 필요합니다. 통로 방식으로 다시 만든 판이라 앞자리를 올렸습니다. 1.2.x 확장도 6.0.0을 새 판으로 알아봅니다.

## 1.2.2 — 2026-11-08

사람에게 보이는 실패를 줄였습니다(owner 11-08 F04b: 실패는 원인을 고치거나 스스로 복구하고 개발 기록에만 남기며, 사람에게는 사람만 풀 수 있는 일만 보입니다).
- 팝업 "작업 탭으로 이동"이 마지막 작업 공간에 탭이 없으면 크롬 오류 문장을 그대로 띄웠습니다. 이제 AI 그룹의 다른 탭(없으면 대기 탭)으로 갑니다. 그룹이 아예 없을 때만 "아직 AI 작업 탭이 없습니다"라고 답합니다.
- 스크린샷 한 장을 못 받았을 때 팝업에 빨간 "AI 작업 문제" 줄을 띄우던 것을 없앴습니다. 오류는 AI에게 가고 AI가 다시 찍습니다. 팝업에는 사람이 디버깅 표시줄에서 취소를 눌러 멈춘 경우만 "AI 작업 멈춤"으로 남습니다.
- relay 묶음에 relay가 쓰는 패키지(`ws`, `tsx`와 그 `esbuild`)만 넣습니다. 확장 빌드 도구(wxt 등)가 빠져 33MB → 4.5MB입니다.

## 1.2.1 — 2026-11-08

- AI 탭 그룹이 크롬마다 하나("AI · 기기 이름")입니다. 전에는 작업 공간마다 그룹이 따로 생겼고, 크롬이 그룹마다 북마크줄 "저장된 탭 그룹"에 이름표를 달아 작업 공간 수만큼 쌓였습니다(owner 11-08: "이렇게 4개가 남는 일은 안 돼"). 작업 공간은 같은 그룹 안에서 어느 탭이 자기 것인지만 따로 기억합니다(브라우저 세션 저장소, 크롬을 다시 켜면 남은 탭은 기본 작업 공간 것).
- 1.2.0이 만든 작업 공간 그룹은 새 판이 처음 돌 때 하나로 합칩니다. 기본 그룹이 없으면 옛 그룹 하나의 이름을 바꿔 쓰므로, 닫히거나 비워진 그룹이 생기지 않습니다(owner PC: 그룹 둘 → 하나, 북마크줄에 남은 것 없음).
- 그룹의 마지막 탭만 대기 탭이 되고, 다른 작업 공간 탭이 남아 있으면 그냥 닫습니다. 대기 탭은 하나만 둡니다.
- 1.2.0에 남아 있던 code-mode 문서를 relay에서 뺐습니다.

## 1.2.0 — 2026-11-07

옛 도구를 지우고 확장을 통로로 줄였습니다(재설계 5단계). 페이지 작업은 모두 HOME의 agent-browser(`pc-browser`)가 합니다.
- 지운 것: 페이지 도구 15개(`page`·`click`·`form`·`computer`·`screenshot`·`navigate`·`evaluate`·`tabs`·`waitFor`·`console`·`network`·`storage`·`dialog`·`window`·`perf`)와 ref 엔진, `shortcuts`·사람 조작 녹화, relay `/trace`(도구 호출 녹화), content script, 탐색 차단 목록(기본값이 비어 있었음), relay `/code`(isolated-vm 의존성 포함), v6 device-code 페어링. 확장 코드는 약 9,600줄에서 2,600줄로 줄었습니다.
- 남긴 것: 확장이 직접 하는 도구 `fetch`(탭 없이 사람 쿠키로 요청, `bb-fetch`)·`handoff`·`notify`·`extension`. `/send`로 부르며, 지운 도구 이름에는 "pc-browser로 하라"는 오류로 답합니다.
- 확인한 것(owner PC 11-07): 확장을 다시 불러오면 크롬이 대기 탭을 닫아 대기 탭만 있던 그룹이 사라지지만 "저장된 탭 그룹"에는 남지 않습니다. 확장이나 디버거가 연 `about:blank`도 같이 닫혀 대기 탭은 그대로 둡니다. 저장된 그룹은 AI 그룹이 든 창을 닫을 때 생기는 것으로 보입니다.
- 권한에서 `scripting`과 (없는 권한인) `windows`를 뺐습니다. `BB_STORE_BUILD=1`이면 웹스토어용으로 `key` 없이 빌드합니다.

## 1.1.2 — 2026-11-07

owner PC에서 1.0.8 측정표를 `pc-browser`로 다시 잰 결과(3단계)로 고친 것입니다.
- `pc-browser network route`(가짜 응답)가 사람 크롬에서 되지 않던 문제를 고쳤습니다. 옛 `network` 도구가 자기 규칙이 없어도 멈춘 요청을 모두 흘려보내, 엔진이 답할 때 이미 처리된 요청이 되었습니다. 이제 옛 도구는 자기 규칙이 없거나 통로가 쓰는 탭이면 손대지 않습니다.
- 입력 전에 탭을 그릴 때 화면 캡처 대신 화면 영상 한 장을 받습니다. 가려진 창은 캡처에 답하지 않아 클릭 한 번이 5.5초(그리기 시도 2초 × 3) 걸렸습니다. 엔진이 직접 화면 영상을 켰을 때는 건드리지 않습니다.
- 창이 최소화돼 있으면 스크린샷이 캡처를 1.5초 기다리지 않고 바로 화면 영상으로 찍습니다(1.8초 → 0.25~1.4초).
- "AI 전용 창"을 켠 사람에게 확장을 다시 불러올 때마다 AI 창이 하나씩 늘던 문제를 고쳤습니다. 탭 그룹이 사라져도 AI 창이 열려 있으면 그 창을 다시 씁니다.

## 1.1.1 — 2026-11-07

- HOME relay에서 `pc-browser`가 401로 막히던 문제를 고쳤습니다. HOME relay는 127.0.0.1을 공개 주소와 따로 된 제어 서버로 여는데, 통로 연결(`/cdp/<작업 공간>`)이 그 서버에 붙어 있지 않았습니다. 실 시험도 HOME과 같은 배치(공개 주소와 127.0.0.1 분리)로 돕니다.
- 확장은 1.1.0과 같습니다. 1.1.0 확장은 그대로 통로를 씁니다.

## 1.1.0 — 2026-11-06

- 통로(pipe): HOME의 agent-browser(`pc-browser`)가 사람 크롬을 서버 브라우저와 같은 명령으로 다룹니다. 확장은 Microsoft Playwright 확장과 같은 얇은 chrome.debugger 통로(protocol v2)이고, relay가 그 위에 CDP 끝점 `ws://127.0.0.1:<HTTP 포트>/cdp/<작업 공간>`을 엽니다. 이 HOME 계정만 붙을 수 있습니다. Playwright 코드를 옮긴 파일과 고지는 `NOTICE`에 있습니다.
- AI 탭은 뒤에서 열리고 앞으로 오지 않습니다. 작업 공간마다 탭 그룹 하나를 다시 쓰고, 다시 연결해도 새 탭을 열지 않습니다(그룹이 비었을 때만 하나).
- 크롬이 최소화되거나 가려져 화면을 못 찍으면 화면 영상의 첫 장면으로 대신 찍습니다(owner PC 실측 0.5~2초). 입력이 5초 안에 확인되지 않으면 "완료"가 아니라 오류로 답합니다.
- 확장이 오래되어 통로를 못 쓰면 HOME 사고 알림으로, 통로가 계속 실패하면 팝업의 상태 줄로 사람에게 보입니다.
- 지금의 도구(`/send`·`/code`)는 그대로 둡니다.

## 1.0.9 — 2026-11-06

- 보안: relay가 서버 안(loopback) 접속을 계정으로 가립니다. AI 조종 명령(HTTP)은 relay와 같은 계정만, 인증 없는 브라우저 접속은 같은 계정과 공개 문 계정만, 공개 문의 설정 코드는 그 경로의 HOME 계정만 받습니다. 같은 서버의 다른 계정이 비밀값을 알아도 남의 크롬을 조종하거나 브라우저 자리를 차지할 수 없습니다(11-06 검토 차단 3건).
- relay 자격 파일(`.bb-v6-tokens*.json`, `http-control.secret`)을 git에서 무시합니다.

## 1.0.8 — 2026-11-06

- 사람 창 안의 뒤 AI 탭에서 클릭·키·스크린샷이 됩니다(PC 실측: 뒤 탭 클릭 0/20 → 5/5). 원인은 뒤 탭이 그리지 않아 이동 직후 입력을 버리는 것(paint holding)이라, Claude in Chrome처럼 입력 전에 탭을 한 번 그리게 하고 스크린샷도 그린 뒤 찍습니다. 소리 나는 탭은 그리는 동안 음소거합니다.
- 클릭 전에 대상을 화면 안으로 스크롤합니다(Playwright 순서). 화면 밖 버튼 0/5 → 5/5.
- AI 탭 그룹의 마지막 작업 탭을 닫으면 빈 대기 탭을 남겨, 다음 탭이 같은 그룹을 다시 씁니다(같은 이름 그룹이 쌓이던 문제). 그룹 id가 바뀌어도 이름으로 같은 그룹을 찾습니다.
- `extension` 도구(`version`·`reload`)로 압축 해제 설치본을 원격 새로고침합니다.
- 단위 시험을 지금 코드에 맞췄습니다(가짜 크롬의 빠진 API, 없어진 화면 관찰 장치).

## 1.0.5

- 연결별 AI 탭 그룹, 명시적 tabs.focus, 선택형 비포커스 전용 창, 작업 탭 상태와 복구 결과를 추가했습니다. 동일 픽셀 캡처는 보이는 페이지에서 unchanged로 반환합니다.

# Changelog

## 1.0.4 — 2026-10-07

- Keep hidden-tab text entry reliable by focusing the exact input control and confirming the resulting value.

## 1.0.2 — 2026-10-05

- Show installed extensions when a newer Browser Bridge ZIP is available, and include each connected Chrome's version in the issuer and dashboard device list.

## 1.0.1 — 2026-10-05

- No built-in navigation blocklist: the illustrative bank/payment domains had become real policy (cd0bc21 cherry-picked onto 1.0.0). Extension, relay and release manifest move to 1.0.1 together so installed copies show the update.

## 1.0.0 — 2026-09-29

- Align extension, Node relay, ZIP and release manifest versions from `package.json`.
- Add a native-feeling Korean popup with retained enrollment on/off, connection diagnostics, editable device name, recent activity, and a manual human handoff.
- Keep AI tabs in the DCCB group, recover connections after Chrome wakes, and show connection/work/off badges.
- Enrich unnamed visible accessibility controls using bounded DOM layout information and stop form batches after page changes.
- Revise the Discord setup card to explain server-browser default usage, ZIP installation, auto-selected route, and connected devices.
- Include the tailnet self-approval security fix in the release base.

The v8 enrollment/profile wire schema remains version 8; `1.0.0` is the product release version, not a storage migration.
