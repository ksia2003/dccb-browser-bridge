# Browser Bridge tests

- `npm run test:unit` — no Chrome needed:
  - `peer-uid`, `enrollment`, `public-door` (unit + integration), `http-handler`, `http-control`,
    `ws-origin`, `v8-profile`, `relay-release`: enrollment, the public door, loopback account checks
  - `target.unit.test.mjs`: the AI tab group — ownership, the idle tab, the dedicated AI window,
    adopting tabs a controlled page opens
  - `cdp-lifecycle.unit.mjs`: attach with focus emulation, detach clean-up
  - `fetch-tool.unit.mjs`: the extension's `fetch`
  - `pipe.unit.mjs`: the relay's CDP endpoint and session with a fake extension and engine

## Pipe live check (`pipe.live.mjs`)

`pipe.live.mjs` starts an isolated relay and a real Chromium with the built extension, enrolls it
through the popup, and drives it with agent-browser over `/cdp/<workspace>` (open, click, fill,
off-screen click, background screenshot, network route, tab reuse across reconnects, the extension's own fetch/notify/handoff/extension tools, one engine per work space).
Temporary state only. Run it before raising DCCB's pinned agent-browser version:

```bash
npx wxt build && DISPLAY=:77 AGENT_BROWSER=~/.local/share/dccb/agent-browser/0.41.2/agent-browser node test/pipe.live.mjs
```
