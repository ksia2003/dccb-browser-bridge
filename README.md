# DCCB Browser Bridge

사람의 Chrome을 HOME의 AI가 다루게 잇는 MV3 확장과 relay. 1.2.0부터 확장은 **얇은 chrome.debugger
통로(pipe)** 이고, 페이지 작업은 HOME의 agent-browser가 한다(DCCB `pc-browser`). Playwright에서 옮긴
코드와 고지는 `NOTICE`. 바뀐 내용은 `CHANGELOG.md`, 개인정보 처리방침은 [`PRIVACY.md`](PRIVACY.md).

## 구조
- `entrypoints/` — 확장(WXT MV3)
  - `background.ts`: relay WS, 등록(v8), keepalive, 팝업 상태, 알람(재연결·남은 AI 탭 닫기)
  - `lib/pipe.ts`: 통로. Playwright 확장 protocol v2 + DCCB 몫(작업 공간이 연 탭만, 뒤 탭 입력 전 그리기, 가려진·최소화 창 스크린샷, 남은 AI 탭 닫기)
  - `lib/target.ts`: AI 탭(그룹 없는 뒤쪽 탭, 작업 공간별 주인 기록), AI 탭이 연 새 탭 편입, 1.2.x 그룹 정리
  - `lib/cdp.ts`: attach(초점 에뮬레이션·음소거 가드), 입력·그리기
  - `lib/tools/`: 확장이 직접 하는 도구 셋 — `fetch`(탭 없이 사람 쿠키로 요청), `close`(작업 공간의 탭 닫기), `extension`(version·reload)
  - `popup/`: 상태만 보여 주는 팝업(연결 전·연결됨·AI 작업 중·재연결 중, 라이트/다크). 작업 중 카드를 누르면 그 탭으로
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

AI 탭은 그룹 없이 사람 창의 뒤쪽 탭으로 열리고 앞으로 오지 않는다(`Page.bringToFront`·`Target.activateTarget`은 relay가 삼킨다). 크롬은 탭 그룹을 모두 북마크줄 "저장된 탭 그룹"에 올리고 창을 닫아도 남겨 두기 때문에 그룹을 쓰지 않는다(owner 11-08). AI가 끝났다고 하면(`pc-browser close` = agent-browser close + 확장의 `close` 도구) 그 작업 공간의 탭이 닫히고, 엔진이 저절로 끝나(3분 쉼, 죽음, relay 끊김) 돌아오지 않으면 10분 뒤에 닫힌다. 사람이 앞에 띄워 보고 있는 AI 탭은 닫지 않고 사람 것이 된다. `target=_blank`·`window.open` 자식은 `webNavigation.onCreatedNavigationTarget`의 `sourceTabId`가 AI 탭으로 확인된 뒤에만 그 작업 공간에 들어온다. 사람은 팝업의 작업 중 카드를 눌러 AI 탭으로 간다. 로그인·캡차처럼 사람이 할 일은 AI가 채팅으로 부탁한다.

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
