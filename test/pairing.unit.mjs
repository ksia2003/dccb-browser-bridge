/** lib/pairing.ts: the address and the code from one paste of the dashboard card. */
import assert from "node:assert/strict";
const { parsePairing } = await import("../entrypoints/lib/pairing.ts");

const cases = [
  ["```\nhttps://home.example.net\n```\n**코드** · 5분 뒤 바뀜\n```\nQ7M2 K9TX\n```", { address: "https://home.example.net", code: "Q7M2K9TX" }],
  ["https://home.example.net Q7M2-K9TX", { address: "https://home.example.net", code: "Q7M2K9TX" }],
  ["q7m2k9tx  https://box.tail1234.ts.net/", { address: "https://box.tail1234.ts.net/", code: "Q7M2K9TX" }],
  ["https://home.example.net", { address: "https://home.example.net", code: null }],
  ["Q7M2 K9TX", { address: null, code: "Q7M2K9TX" }],
  // Letters of the address never count as the code.
  ["https://ABCDEFGH.example.net", { address: "https://ABCDEFGH.example.net", code: null }],
];
for (const [text, expected] of cases) assert.deepEqual(parsePairing(text), expected, text);
console.log("  PASS  the address and the code come from one paste in any shape the dashboard shows");
