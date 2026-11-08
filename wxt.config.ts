import { defineConfig } from "wxt";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// DCCB Browser Bridge V8 — WXT / Manifest V3 config.
export default defineConfig({
  manifest: {
    name: "DCCB Browser Bridge",
    description:
      "내 DCCB 서버의 AI가 이 Chrome의 AI 탭 그룹에서 웹 작업을 하도록 잇는 통로입니다. 사람의 탭은 건드리지 않습니다.",
    version,
    // manifest_version is fixed to 3 by WXT's chrome-mv3 target (do not set here).

    // V8's common public identity. Its private signing key stays outside the
    // repository, while this public key keeps V8 profile storage through later
    // V8 extension updates. V6 storage is intentionally never read.
    // The Chrome Web Store assigns its own id and refuses a `key`: BB_STORE_BUILD=1 leaves it out.
    ...(process.env.BB_STORE_BUILD === "1" ? {} : { key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApdN0j8M3+bGbLTI2/b26wxt3sb9hBL46qF5fCy2L/cgQw1iFosx5BTt7UBLKM/snltGxNggrbIKMV+ZK/fuq6ftyB/Zbo91Pjj9FLgWmYRUD5L6uH1uKezx9q39CwqLXL51w8EQrZBm3QJqY2ILOhKsPke5qMFc7KXPhSiurJQMlYqI61mK5S0havqLUPl3zGqNB/mdtk6gz0p4UXMnZEsLIQ47E9oAYRTrxQ3m+BP9+df6l9UMAsj7O9HgqepGUb153DHDY62YDUlrIj7PRpsMEtk2mXpVdXW2yHCAZmzUvAludvqmmK6C46i9hB4GESWwGOpcfAs6G6aZazBMkJwIDAQAB" }),

    icons: {
      16: "/icon/16.png",
      48: "/icon/48.png",
      128: "/icon/128.png",
    },

    action: {
      default_title: "DCCB Browser Bridge",
      default_icon: {
        16: "/icon/16.png",
        48: "/icon/48.png",
        128: "/icon/128.png",
      },
    },

    permissions: [
      "tabs",
      "debugger",
      "tabGroups",
      "storage",
      "alarms",
      "webNavigation",
      "notifications",
    ],
    host_permissions: ["<all_urls>"],
  },
});
