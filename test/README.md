# Browser Bridge tests

- `npm run test:unit` — no Chrome needed:
  - `peer-uid`, `enrollment`, `public-door` (unit + integration), `http-handler`, `http-control`,
    `ws-origin`, `v8-profile`, `relay-release`: enrollment, the public door, loopback account checks
  - `target.unit.test.mjs`: the AI's tabs — ownership, background tabs with no group, adopting tabs
    a controlled page opens, the popup card's tab, leaving 1.2.x's tab group behind
  - `tab-lifecycle.unit.mjs`: nothing closes on its own; `close` closes only tabs the person never
    looked at; AI tabs are muted until looked at; the debugger lets go when the engine leaves
  - `pairing.unit.mjs`: the address and the code from one paste
  - `duplicate-browsers.integration.mjs`: an old unpacked copy next to the Web Store copy
  - `cdp-lifecycle.unit.mjs`: attach with focus emulation, detach clean-up
  - `fetch-tool.unit.mjs`: the extension's `fetch`
  - `pipe.unit.mjs`: the relay's CDP endpoint and session with a fake extension and engine

## Pipe live check (`pipe.live.mjs`)

`pipe.live.mjs` starts an isolated relay and a real Chromium with the built extension, enrolls it
through the popup, and drives it with agent-browser over `/cdp/<workspace>` (open, click, fill,
off-screen click, background screenshot, network route, close closing the AI tab, no tab group and the person's tab staying in front, the extension's own fetch/extension tools, one engine per work space).
Temporary state only. Run it before raising DCCB's pinned agent-browser version:

```bash
npx wxt build && DISPLAY=:77 AGENT_BROWSER=~/.local/share/dccb/agent-browser/0.41.2/agent-browser node test/pipe.live.mjs
```
