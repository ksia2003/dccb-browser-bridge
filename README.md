# DCCB Browser Bridge

사람의 Chrome을 HOME의 AI가 다루게 잇는 MV3 확장과 relay. 1.2.0부터 확장은 **얇은 chrome.debugger
통로(pipe)** 이고, 페이지 작업은 HOME의 agent-browser가 한다(DCCB `pc-browser`). Playwright에서 옮긴
코드와 고지는 `NOTICE`. 바뀐 내용은 `CHANGELOG.md`, 개인정보 처리방침은 [`PRIVACY.md`](PRIVACY.md).

## 구조
- `entrypoints/` — 확장(WXT MV3)
  - `background.ts`: relay WS, 등록(v8), keepalive, 팝업 상태, 알람(재연결·남은 AI 탭 닫기)
  - `lib/pipe.ts`: 통로. Playwright 확장 protocol v2 + DCCB 몫(작업 공간이 연 탭만, 뒤 탭 입력 전 그리기, 가려진·최소화 창 스크린샷, 끝난 작업의 탭 닫기)
  - `lib/target.ts`: AI 탭(그룹 없는 뒤쪽 탭, 음소거, 작업 공간별 주인과 사람이 본 탭 기록), AI 탭이 연 새 탭 편입, 1.2.x 그룹 정리
  - `lib/pairing.ts`: 대시보드의 주소와 코드를 함께 붙여 넣으면 두 칸으로 나누기
  - `lib/cdp.ts`: attach(초점 에뮬레이션·음소거 가드), 입력·그리기
  - `lib/tools/`: 확장이 직접 하는 도구 셋 — `fetch`(탭 없이 사람 쿠키로 요청), `close`(작업 공간의 탭 닫기), `extension`(version·reload)
  - `lib/v8-auth.ts`: 주소+코드 등록, 토큰 갱신(갱신 토큰도 갱신할 때마다 새로 받음), 끄기 스위치, 연결 상태와 재시도 이유
  - `lib/badge.ts`·`lib/connection-detail.ts`·`lib/heartbeat.ts`: 툴바 배지 규칙, 팝업의 연결 중 문구, 소켓 무응답 판정(Chrome 없이 시험하려고 분리)
  - `popup/`: 팝업(라이트/다크). 연결 상태(연결 전·연결됨·AI 작업 중·재연결 중·꺼 둠)와 AI가 보고 있는 페이지 카드(누르면 그 탭으로), "AI가 이 Chrome 쓰기" 스위치, "다시 연결"(새 주소·코드), ⋮ 메뉴의 기기 이름과 "연결 정보 지우기". `?welcome=1`은 새로 설치했을 때 열리는 연결 페이지
- `server/` — Node relay(tsx)
  - `index.ts`: 확장 WS, HOME 제어 HTTP(`/send`·`/browsers`·`/api/enroll/*`·`/api/auth/refresh`), `/cdp/<작업 공간>` CDP 끝점
  - `pipe/`: Playwright cdpRelay·browserModel 이식 + agent-browser 탭 찾기 흉내, 한 작업 공간에 엔진 하나
  - `auth.ts`·`enrollment.ts`·`public-door.ts`·`peer-uid.ts`: v8 등록과 1.0.9 계정 확인
- `shared/protocol.ts` — 와이어 타입.

## 빌드 & 실행
```bash
npm install
npm run build          # → .output/chrome-mv3/
npm run typecheck
npm run package        # 소스 커밋 도장 + ZIP → .output/*.zip (BB 대시보드 배포본, 고정 key 포함)
BB_STORE_BUILD=1 npm run package   # Chrome 웹스토어용(key 없음, 스토어가 id를 정함)
npm run package:relay  # relay tgz + json
npm run test:unit      # 단위·통합(크롬 없이)
DISPLAY=:77 node test/pipe.live.mjs   # 실 Chromium + relay + agent-browser
```
relay는 시작할 때 토큰 파일 옆에 `http-control.secret`(0600)을 만든다. HOME 제어 HTTP와 `/cdp`는
127.0.0.1에서 relay와 같은 Linux 계정만 받는다.

## 사람 크롬의 AI 탭

AI 탭은 기본으로 그룹 없이 사람 창의 뒤쪽 탭으로 열리고 앞으로 오지 않는다(HOME의 settings.yaml에 `browserBridge: {tabGroup: true}`를 켠 경우에만 창마다 `AI · <기기 이름>` 그룹으로 묶는다. `Page.bringToFront`·`Target.activateTarget`은 relay가 삼킨다). 크롬은 탭 그룹을 모두 북마크줄 "저장된 탭 그룹"에 올리고 창을 닫아도 남겨 두기 때문에 기본값은 그룹을 쓰지 않는다(owner 11-08). AI 탭은 사람이 볼 때까지 음소거다. 탭은 저절로 사라지지 않는다: AI가 끝났다고 하면(`pc-browser close` = agent-browser close + 확장의 `close` 도구) 사람이 한 번도 보지 않은 탭만 닫히고, 사람이 본 탭(1.5초 이상 앞에 있었던 탭)은 사람 것이 된다. 엔진이 떠나도 탭은 남아 다음 엔진이 다시 쓰고, 디버거는 떼어 크롬의 디버깅 표시줄이 사라진다. 사람이 작업 공간의 마지막 AI 탭을 닫으면 AI가 `close`로 끝내기 전까지 새 탭을 열 수 없다(AI가 먼저 물어보게). `target=_blank`·`window.open` 자식은 `webNavigation.onCreatedNavigationTarget`의 `sourceTabId`가 AI 탭으로 확인된 뒤에만 그 작업 공간에 들어온다. 사람은 팝업의 페이지 카드를 눌러 AI 탭으로 간다. 팝업의 "AI가 이 Chrome 쓰기" 스위치를 끄면 AI가 일하는 중이든 아니든 AI 탭이 모두 닫히고 연결이 끊긴다. 로그인·캡차처럼 사람이 할 일은 AI가 채팅으로 부탁한다.

## 연결과 로그인

- 로그인: 대시보드의 주소와 코드(5분 안, 한 번)로 등록하면 접근 토큰(2시간)과 갱신 토큰(30일)을 받는다. 확장은 접근 토큰이 끝나기 10분 전에 갱신하고, 갱신할 때마다 갱신 토큰도 새로 받는다(옛 토큰은 5분 뒤 무효). 그래서 쓰는 Chrome은 30일 벽에 걸리지 않고, 30일 동안 안 쓴 로그인만 끝난다. 같은 Chrome이 다시 등록하면(같은 `v8-<사람>-<브라우저 id>`) 새 로그인이 쓰이기 시작할 때 옛 로그인은 지워진다.
- 연결은 소켓을 열 때 한 번 인증하고, 로그인이 살아 있는 동안 유지한다. 접근 토큰이 끝나도 소켓은 끊지 않는다(끊으면 AI의 작업이 끝난다). 로그인이 끝나면 4401로 닫고, 팝업은 "로그인이 끝났습니다"와 채워진 주소를 보여 준다. 소켓을 열기 전에 접근 토큰이 끝났거나 2분 안에 끝나면 먼저 갱신한다.
- 하트비트: 확장이 20초마다 `ping`을 보내고 relay가 `pong`으로 답한다. relay는 60초 동안 아무 프레임도 없는 소켓을, 확장은 50초 동안 relay에게서 아무것도 못 받은 소켓을 죽은 것으로 보고 닫으며 확장은 다시 연결한다.
- 기기 이름을 바꾸면 열린 소켓으로 `extension_rename`을 보낸다(재연결 없음). 끈 상태는 확장이 연결을 끊은 채라 relay에 알릴 수 없으므로 relay가 상태 폴더의 `switched-off.json`에 적어 두고(30일 지나면 버림) 그 Chrome이 다시 연결하면 지운다.
- 툴바 배지는 한 번에 하나: AI 작업 중(점) > 꺼 둠(`OFF`) > 연결 안 됨(`!`: 로그인 끝남, 주소 오류, 연결 시도 실패) > 새 버전(`NEW`, 압축을 풀어 설치한 사본만).

## PC 네트워크 fetch

`fetch` 도구와 DCCB의 `shared/browser-use/bb-fetch` 명령은 새 탭을 만들지 않고 Chrome 확장 service worker에서 URL을 가져옵니다. 요청은 Chrome의 네트워크와 `credentials: include`를 쓰며 리다이렉트는 따라갑니다. 사이트의 쿠키·개인정보 보호 정책에 따라 로그인 쿠키가 포함되지 않을 수 있습니다. 도구/CLI/relay가 두는 본문 크기나 fetch 시간 상한은 없으며(다른 도구의 relay 10초 대기는 fetch에 적용되지 않음), 요청은 확장 응답이나 브라우저 연결 종료로 끝나고 기존 JSON relay 안에서 base64로 전달됩니다.

```bash
"$DCCB_REPO_DIR/shared/browser-use/bb-fetch" 'https://example.com' -H 'Accept: application/json' -o response.json
```

요청 본문은 `-d '문자열'` 또는 `-d @/path/to/file`로 전달하고, `-X POST`와 반복 `-H`를 쓸 수 있습니다. 응답 status/headers는 stderr, 본문은 stdout 또는 `-o` 파일로 나옵니다. `/send`의 기존 1,000,000자 제한은 입력 요청 JSON에만 적용되며 fetch 응답 제한이 아닙니다. 이 기능은 의도적으로 도메인/사설 주소 목록이나 추가 허락 UI를 두지 않으며, 확장 전체 끄기/사람 인계 상태에서는 기존처럼 도구 요청이 실행되지 않습니다.

## Release version

`package.json` is the sole product-version source. `wxt.config.ts` reads it for
Chrome's manifest; `package:relay` writes the same version to the relay archive
and release manifest, and `package` names the Chrome ZIP with that version.
For a release, bump the exact SemVer in `package.json` (and the root entry in
`package-lock.json` via `npm install --package-lock-only`), add a CHANGELOG entry,
run `npm run typecheck && npm run build && npm run package && npm run package:relay`,
commit, then tag the Browser Bridge commit `vX.Y.Z`. The DCCB release consumer
validates the same versioned relay filenames. Do not tag or deploy an unverified
build. The v8 enrollment/profile schema number is independent of the product
version and must not be reset.
