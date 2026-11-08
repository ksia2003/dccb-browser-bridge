# 개인정보 처리방침 · Privacy Policy

DCCB Browser Bridge (Chrome 확장) · 시행일 2026-11-08 · Effective 2026-11-08 (6.0.0)

[English below](#english)

## 한국어

DCCB Browser Bridge는 **사용자가 직접 운영하는 DCCB 서버(HOME)** 의 AI가 사용자의 Chrome에서 웹 작업을 하도록 잇는 확장입니다. 확장은 사용자가 팝업에 넣은 주소의 서버(relay)에만 연결합니다. 이 확장의 개발자나 다른 누구의 서버로도 데이터를 보내지 않습니다.

### 다루는 정보와 쓰임
- **AI가 연 탭의 웹페이지 내용**: AI가 요청할 때, AI가 직접 연 탭의 페이지 구조, 텍스트, 스크린샷, 네트워크 요청을 `chrome.debugger`로 읽어 사용자의 서버로 보냅니다. 사람이 쓰는 탭은 읽지 않습니다.
- **로그인 쿠키를 쓰는 요청(fetch)**: AI가 요청하면 확장이 Chrome의 네트워크로 주소를 가져와 응답을 사용자의 서버로 보냅니다. 이때 그 사이트의 쿠키가 함께 갈 수 있습니다. 쿠키 값 자체를 읽거나 따로 보내지는 않습니다.
- **연결 정보**: 서버 주소, 등록 토큰, 브라우저 식별자(무작위), 기기 이름, 마지막 연결 시각, 켜짐/꺼짐 같은 설정을 이 Chrome의 확장 저장소(`chrome.storage`)에 둡니다.
- **AI 탭 표시**: 어느 탭이 AI가 연 것인지, 사람이 그 탭을 봤는지를 이 Chrome 세션 동안만 기억합니다(크롬을 다시 켜면 사라짐).

### 하지 않는 것
- 광고, 분석, 추적 도구를 쓰지 않습니다.
- 정보를 팔거나 제3자에게 넘기지 않습니다.
- 확장 개발자에게 어떤 데이터도 보내지 않습니다.
- 위에 적은 목적, 곧 사용자가 시킨 AI 웹 작업 말고는 쓰지 않습니다.

### 보관과 삭제
- 확장 저장소의 정보는 확장을 지우면 함께 지워집니다. 팝업의 초기화로 서버 주소와 등록 토큰만 지울 수도 있습니다.
- 사용자의 서버로 간 정보는 그 서버를 운영하는 사용자(또는 그 서버 관리자)가 관리합니다. 이 확장의 개발자는 그 서버에 접근하지 않습니다.

### 사용자가 할 수 있는 것
- 크롬의 디버깅 표시줄에서 "취소"를 누르면 AI 작업이 바로 멈춥니다.
- 크롬 확장 관리 화면(chrome://extensions)에서 언제든 확장을 끄거나 지울 수 있습니다.

### 문의
https://github.com/ksia2003/dccb-browser-bridge/issues

이 방침이 바뀌면 이 문서와 시행일을 고칩니다.

## English

DCCB Browser Bridge lets the AI on **a DCCB server (HOME) that you run yourself** do web tasks in your Chrome. The extension connects only to the server (relay) whose address you enter in its popup. It sends no data to the extension's developer or to anyone else's server.

### What it handles and why
- **Web page content of tabs the AI opened**: when the AI asks, the extension reads the page structure, text, screenshots and network requests of the tabs the AI itself opened, through `chrome.debugger`, and sends them to your server. It does not read the tabs you use.
- **Requests with your login cookies (fetch)**: when the AI asks, the extension fetches a URL through Chrome's network and sends the response to your server. The site's cookies may be sent with that request. The extension does not read or forward cookie values themselves.
- **Connection data**: the server address, enrollment tokens, a random browser identifier, the device name, the last connection time and on/off settings are kept in this Chrome's extension storage (`chrome.storage`).
- **Which tabs are the AI's**, and whether you have looked at them: remembered only for the current Chrome session (gone when Chrome restarts).

### What it does not do
- It uses no advertising, analytics or tracking.
- It does not sell or transfer data to third parties.
- It sends no data to the extension's developer.
- It uses data only for the purpose above: web tasks you ask your AI to do.

### Retention and deletion
- Data in extension storage is removed when you remove the extension. The popup's reset removes only the server address and enrollment tokens.
- Data sent to your server is managed by you (or whoever runs that server). The extension's developer has no access to it.

### Your controls
- Press "Cancel" on Chrome's debugging bar to stop AI work immediately.
- Turn the extension off or remove it at any time in Chrome's extensions page (chrome://extensions).

### Contact
https://github.com/ksia2003/dccb-browser-bridge/issues

If this policy changes, this document and its effective date are updated.
