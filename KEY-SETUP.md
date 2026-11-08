# 고정 `key` 설정 (안정적인 확장 ID)

확장의 `manifest.key`를 박으면 **설치 ID가 고정**된다. 그러면
`압축해제 로드(개발)`로 띄운 ID와 스토어 게시본 ID가 같아져서,
`chrome.storage`에 저장한 토큰·설정이 **v5→v6 스왑 후에도 보존**된다.
키를 안 박으면 Chrome이 로드 경로 기반으로 ID를 매번 다르게 뽑아 storage가 끊긴다.

> ⚠️ **PRIVATE 키(`.pem`)는 레포에 절대 커밋하지 않는다.** 매니페스트에 들어가는 건
> base64 DER **공개키**(`key`)뿐이다. 이 작업에서는 실제 키를 만들지 않으며, 도구와
> 문서만 제공한다 — 키 생성은 PC에서 한 번만 직접 실행한다.

## 1. 키 생성

```bash
# 저장소 최상위에서
npm run genkey
```

`scripts/genkey.mjs`가:

1. 2048-bit RSA 키쌍을 생성하고
2. **PRIVATE 키(PKCS#8 PEM)** 를 레포 **밖**에 기록 — 기본 `~/.dccb/bb-v6-key.pem`
   (권한 `0600`). 경로는 `BB_V6_KEY_PEM` 환경변수로 override.
3. 매니페스트 `key`(공개키 DER의 base64)와 결과 **확장 ID**를 출력한다.

이미 `.pem`이 있으면 덮어쓰지 않고 거부한다(ID 회전은 의도적으로만).

### openssl 대안 (node 없이)

```bash
# private key (레포 밖에 보관)
openssl genrsa 2048 > ~/.dccb/bb-v6-key.pem && chmod 600 ~/.dccb/bb-v6-key.pem
# manifest key (base64 DER 공개키)
openssl rsa -in ~/.dccb/bb-v6-key.pem -pubout -outform DER 2>/dev/null | base64 -w0
```

(`npm run genkey`는 위에 더해 확장 ID까지 계산해 주므로 그쪽을 권장.)

## 2. `wxt.config.ts`에 공개키 박기

출력된 `key: "..."` 줄을 `wxt.config.ts`의 `manifest` 안 주석 처리된 placeholder
자리에 붙여넣고 주석을 해제한다:

```ts
manifest: {
  name: "DCCB Browser Bridge",
  // ...
  key: "<genkey가 출력한 base64 DER 공개키>",
  // ...
}
```

이후 `npm run build` 하면 `.output/chrome-mv3/manifest.json`에 `key`가 들어가고,
개발 로드/스토어 게시 모두 같은 ID를 갖는다.

## 3. 스토어 업로드용 zip

```bash
npm run package   # = wxt zip → .output/*.zip (스토어 업로드본)
```

## 보안 메모

- `.pem`은 백업해 둘 것 — 잃으면 같은 ID를 다시 만들 수 없다(=storage 연속성 상실).
- `.pem`을 `.gitignore` 밖(레포 밖) 경로에 두는 게 1차 방어. 레포 안에 두지 말 것.
- 공개키(`key`)는 비밀이 아니다 — 매니페스트에 박혀 배포되는 값이다.
