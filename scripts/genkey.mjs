#!/usr/bin/env node
/**
 * genkey.mjs — generate a stable extension key for DCCB Browser Bridge V8.
 *
 * Produces a 2048-bit RSA keypair and derives:
 *   - the manifest `key` value (base64 of the DER SubjectPublicKeyInfo), and
 *   - the resulting Chrome extension ID (mpdecimal of the SHA-256 of that DER,
 *     first 16 bytes mapped a–p).
 *
 * The PRIVATE key is written OUTSIDE the repo (default ~/.dccb/bb-v6-key.pem,
 * override with BB_V6_KEY_PEM) and is NEVER committed. Paste the printed `key:`
 * line into wxt.config.ts. See KEY-SETUP.md for the full workflow.
 *
 * Usage:  npm run genkey
 * Idempotent-ish: refuses to overwrite an existing .pem (delete it yourself if
 * you really mean to rotate the ID).
 */
import { generateKeyPairSync, createHash } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PEM_PATH =
  process.env.BB_V6_KEY_PEM || join(homedir(), ".dccb", "browser-bridge-v8-key.pem");

if (existsSync(PEM_PATH)) {
  console.error(
    `Refusing to overwrite existing private key: ${PEM_PATH}\n` +
      `Delete it first if you intend to rotate the extension ID.`,
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

// Private key PEM (PKCS#8) → outside the repo, owner-only perms.
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
mkdirSync(dirname(PEM_PATH), { recursive: true });
writeFileSync(PEM_PATH, privatePem, { mode: 0o600 });
try {
  chmodSync(PEM_PATH, 0o600);
} catch {
  /* best effort on platforms without POSIX perms */
}

// Public key as DER SubjectPublicKeyInfo (the same bytes Chrome hashes).
const spkiDer = publicKey.export({ type: "spki", format: "der" });
const manifestKey = spkiDer.toString("base64");

// Chrome extension ID: sha256(spkiDer), first 16 bytes, each nibble → a..p.
const digest = createHash("sha256").update(spkiDer).digest();
let extId = "";
for (let i = 0; i < 16; i++) {
  extId += String.fromCharCode(97 + ((digest[i] >> 4) & 0xf));
  extId += String.fromCharCode(97 + (digest[i] & 0xf));
}

console.log("\n=== DCCB Browser Bridge V8 — extension key ===\n");
console.log(`Private key written to: ${PEM_PATH}`);
console.log("  (keep this file OUTSIDE the repo — NEVER commit it)\n");
console.log("Paste this line into wxt.config.ts > manifest:");
console.log(`  key: "${manifestKey}",\n`);
console.log(`Resulting extension ID: ${extId}`);
console.log(
  "  (unpacked-dev ID == store ID once the key is pinned, so\n" +
    "   chrome.storage/settings persist across the v5→v6 swap)\n",
);
