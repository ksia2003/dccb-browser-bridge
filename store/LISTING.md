# Chrome 웹스토어 등록 자료

Chrome 웹스토어 개발자 대시보드(https://chrome.google.com/webstore/devconsole)에 그대로 옮겨 적는 값입니다.

## 패키지
- 업로드 파일: GitHub 릴리스의 `dccb-browser-bridge-<판>-store.zip`. `BB_STORE_BUILD=1 npm run package`로 만든 것이며 manifest에 `key`가 없습니다(스토어가 확장 ID를 정함).
- 스크린샷(1280x800): `store/screenshot-1-working.png`, `store/screenshot-2-states.png`, `store/screenshot-3-dark.png`. `scripts/store-screenshots.mjs`로 다시 만듭니다.
- 작은 프로모션 타일(440x280): `store/promo-small-440x280.png`.

## 스토어 등록정보
- **이름**: DCCB Browser Bridge
- **요약(132자 이내)**: 내가 운영하는 DCCB 서버의 AI가 이 Chrome의 뒤쪽 탭에서 웹 작업을 하도록 잇습니다. 내 탭은 건드리지 않습니다.
- **카테고리**: 생산성(Productivity) > 도구
- **언어**: 한국어
- **설명**:

```
DCCB Browser Bridge는 내가 직접 운영하는 DCCB 서버(HOME)의 AI가 내 Chrome에서 웹 작업을 하도록 잇는 확장입니다. DCCB 서버가 있어야 쓸 수 있습니다.

• 연결: DCCB 대시보드의 주소와 8자리 코드를 팝업에 넣으면 끝입니다. 이후에는 알아서 다시 연결됩니다.
• 분리: AI는 자기가 연 뒤쪽 탭에서만 일하고, 일이 끝나면 그 탭을 닫습니다. 사람이 쓰는 탭은 읽거나 움직이지 않고, AI 탭이 앞으로 튀어나오지도 않습니다.
• 내 로그인 그대로: 로그인이 필요한 사이트도 이 Chrome의 로그인 상태로 작업합니다.
• 손댈 것 없음: 팝업은 상태만 보여 줍니다. AI가 보고 있는 페이지를 누르면 그 탭으로 갑니다. 멈추려면 크롬 디버깅 표시줄의 "취소"를 누르거나 확장을 끄면 됩니다.
• 내 서버로만: 데이터는 내가 넣은 주소의 서버로만 갑니다. 개발자에게 가는 데이터, 광고, 분석 도구는 없습니다.

소스 코드: https://github.com/ksia2003/dccb-browser-bridge
```

## 개인정보 보호 관행
- **단일 목적(Single purpose)**: 사용자가 운영하는 DCCB 서버의 AI가, 사용자가 시킨 웹 작업을 이 Chrome에서 AI가 직접 연 탭에서 하도록 연결합니다.
- **권한 사유**
  - `debugger`: AI가 직접 연 탭만 Chrome DevTools Protocol로 조작합니다(페이지 읽기, 클릭·입력, 스크린샷). 확장의 핵심 기능입니다.
  - `tabs`: AI 탭을 뒤쪽에 열고 닫으며, 사람 탭과 구별하고, 팝업에서 AI가 보고 있는 페이지 제목을 보여 주고 그 탭으로 가는 데 씁니다.
  - `webNavigation`: AI 탭에서 열린 새 탭(`target=_blank`, `window.open`)만 AI의 탭으로 받기 위해, 그 탭을 연 탭이 AI 탭인지 확인합니다. 사람이 연 탭은 받지 않습니다.
  - `storage`: 서버 주소, 등록 토큰, 기기 이름과 어느 탭이 AI의 것인지를 이 Chrome에만 저장합니다.
  - `alarms`: 서비스 워커가 잠든 뒤에도 서버에 다시 연결하고, AI가 떠난 뒤 남은 AI 탭을 닫습니다.
  - 호스트 권한 `<all_urls>`: AI가 사용자가 시킨 사이트에서 일할 수 있게 하고, 탭 없이 이 Chrome의 로그인 상태로 요청(fetch)을 보냅니다. 어느 사이트일지는 사용자의 작업에 따라 정해집니다.
- **원격 코드**: 사용하지 않음. 확장 코드는 모두 패키지 안에 있습니다. AI가 보내는 명령은 Chrome DevTools Protocol 명령이며, AI 탭의 웹페이지 안에서만 실행되고 확장 자체의 코드로 실행되지 않습니다.
- **수집하는 데이터**(체크): 웹사이트 콘텐츠, 웹 기록(AI 탭의 주소), 인증 정보(이 서버 연결용 등록 토큰). 모두 사용자 자신의 서버로만 갑니다.
- **확인 항목**: 승인된 용도 외 판매·전송 안 함 / 단일 목적과 무관한 용도로 쓰지 않음 / 신용도 판단·대출 목적으로 쓰지 않음 — 모두 체크.
- **개인정보 처리방침 URL**: https://github.com/ksia2003/dccb-browser-bridge/blob/main/PRIVACY.md

## 배포
- **공개 범위**: 링크가 있는 사용자만(Unlisted) 권장. DCCB 서버가 없으면 쓸 수 없는 확장이라, 검색에 노출하지 않고 DCCB 대시보드의 링크로만 설치하게 합니다.
- **지역**: 모든 지역.
