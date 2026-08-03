// The scripts in scripts/ derive the same secrets with node:crypto that the
// Worker derives with WebCrypto. If those two implementations ever disagree,
// the webhook stops authenticating and /claim stops working — so the equality
// is asserted against the real modules, not a copy of them.

import { createHmac, webcrypto } from "node:crypto";
import {
  deriveWebhookSecret,
  deriveClaimCode,
  deriveSessionKey,
  timingSafeEqual,
  toHex,
  randomToken,
  base64UrlEncode,
  sha256Hex,
} from "./.build/src/lib/crypto.js";

const crypto = webcrypto;
const enc = new TextEncoder();
const TOKEN = "123456789:AAtesttesttesttesttesttesttesttest";

let fails = 0;
let passN = 0;
const t = (name, cond, detail = "") => {
  if (cond) {
    passN++;
    console.log(`  ✓ ${name}`);
  } else {
    fails++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
};
const section = (s) => console.log(`\n### ${s}`);

const nodeHmacHex = (label) =>
  createHmac("sha256", TOKEN).update(label).digest("hex");

section("derived secrets match the Node scripts byte for byte");
{
  const webhook = await deriveWebhookSecret(TOKEN);
  t(
    "webhook secret matches scripts/webhook.mjs",
    webhook === nodeHmacHex("pmbot:webhook:v1"),
    webhook.slice(0, 16) + "…",
  );

  const claim = await deriveClaimCode(TOKEN);
  t(
    "claim code matches scripts/claim-code.mjs",
    claim === nodeHmacHex("pmbot:claim:v1").slice(0, 12),
    claim,
  );
  t("claim code is 12 hex chars (48 bits)", /^[0-9a-f]{12}$/.test(claim), claim);
}

section("webhook secret satisfies Telegram's constraints");
{
  const webhook = await deriveWebhookSecret(TOKEN);
  // Telegram: 1-256 characters, only A-Z a-z 0-9 _ and - are allowed.
  t("charset and length valid", /^[A-Za-z0-9_-]{1,256}$/.test(webhook));
  t("length 64", webhook.length === 64);
}

section("domain separation between labels");
{
  const webhook = await deriveWebhookSecret(TOKEN);
  const claimFull = nodeHmacHex("pmbot:claim:v1");
  const session = toHex(
    await crypto.subtle.exportKey?.("raw", await deriveSessionKey(TOKEN)).catch?.(() => null) ??
      new Uint8Array(0),
  );
  // The session key is non-extractable by design, so compare the raw HMAC.
  const sessionHex = nodeHmacHex("pmbot:session:v1");
  t(
    "three labels yield three distinct secrets",
    new Set([webhook, claimFull, sessionHex]).size === 3,
  );
  t("session key is non-extractable", session === "");
}

section("rotating the bot token rotates every secret");
{
  const other = "987654321:BBotherotherotherotherotherotherx";
  t(
    "webhook secret changes",
    (await deriveWebhookSecret(TOKEN)) !== (await deriveWebhookSecret(other)),
  );
  t(
    "claim code changes",
    (await deriveClaimCode(TOKEN)) !== (await deriveClaimCode(other)),
  );
}

section("timingSafeEqual");
{
  const cases = [
    ["equal", "abc", "abc", true],
    ["differing last byte", "abc", "abd", false],
    ["prefix", "abc", "ab", false],
    ["suffix", "abc", "abcd", false],
    ["both empty", "", "", true],
    ["one empty", "a", "", false],
    ["other empty", "", "a", false],
    ["multibyte equal", "日本", "日本", true],
    ["multibyte differing", "日本", "日más", false],
    ["case sensitive", "ABC", "abc", false],
  ];
  let ok = true;
  for (const [name, a, b, want] of cases) {
    if (timingSafeEqual(a, b) !== want) {
      ok = false;
      console.log(`    (${name} failed)`);
    }
  }
  t("all comparison cases correct", ok);
}

section("session token format");
{
  const raw = randomToken(32);
  const key = await deriveSessionKey(TOKEN);
  const sig = base64UrlEncode(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw))),
  );
  const token = `${raw}.${sig}`;

  t("exactly one dot separator", (token.match(/\./g) ?? []).length === 1);
  const dot = token.lastIndexOf(".");
  t("splits back cleanly", token.slice(0, dot) === raw && token.slice(dot + 1) === sig);
  t("url-safe throughout", /^[A-Za-z0-9_.-]+$/.test(token), token.slice(0, 20));

  // A tampered signature must be rejected before any database lookup.
  const tampered = `${raw}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
  t("tampered signature differs", !timingSafeEqual(tampered.slice(tampered.lastIndexOf(".") + 1), sig));

  // A signature made with a different bot token must not verify.
  const otherKey = await deriveSessionKey("987654321:BBotherotherotherotherother");
  const otherSig = base64UrlEncode(
    new Uint8Array(await crypto.subtle.sign("HMAC", otherKey, enc.encode(raw))),
  );
  t("signature is token-bound", otherSig !== sig);
}

section("randomToken and hashing");
{
  const a = randomToken(32);
  const b = randomToken(32);
  t("tokens are unique", a !== b);
  t("url-safe, unpadded", /^[A-Za-z0-9_-]+$/.test(a), a);
  t("32 bytes -> 43 chars", a.length === 43, String(a.length));

  const h = await sha256Hex("hello");
  t("sha256Hex returns 64 hex chars", /^[0-9a-f]{64}$/.test(h));
  t(
    "sha256 of a known value",
    h === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    h,
  );
}

console.log(`\n${passN} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
