/**
 * Key derivation and constant-time comparison.
 *
 * Everything secret in this project is derived from BOT_TOKEN, which is the
 * one credential we cannot avoid holding. This keeps the deployment free of
 * bespoke environment variables and has a useful side effect: rotating the
 * bot token automatically invalidates every session, the webhook secret and
 * the claim code.
 *
 * Each derived value uses a distinct, versioned domain-separation label so
 * that no two purposes ever share key material.
 */

const enc = new TextEncoder();

const LABEL_WEBHOOK = "pmbot:webhook:v1";
const LABEL_SESSION = "pmbot:session:v1";
const LABEL_CLAIM = "pmbot:claim:v1";

/** Length of the printable claim code, in hex characters (48 bits of entropy). */
const CLAIM_CODE_LENGTH = 12;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmac(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await hmacKey(secret);
  return crypto.subtle.sign("HMAC", key, enc.encode(message));
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Secret path segment and `X-Telegram-Bot-Api-Secret-Token` value.
 *
 * Telegram restricts the secret_token to `A-Z a-z 0-9 _ -` and 1..256
 * characters, so hex is safe. The same value is used as the URL path segment,
 * which keeps the webhook endpoint unguessable even if the header check were
 * somehow bypassed.
 */
export async function deriveWebhookSecret(botToken: string): Promise<string> {
  return toHex(await hmac(botToken, LABEL_WEBHOOK));
}

/** HMAC key used to sign session tokens. */
export async function deriveSessionKey(botToken: string): Promise<CryptoKey> {
  const raw = await hmac(botToken, LABEL_SESSION);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * The claim code proves possession of the bot token.
 *
 * Anyone who can compute it could equally redeploy the Worker, so gating
 * ownership on it adds no attack surface — unlike a first-come `/start`,
 * which is trivially squattable.
 */
export async function deriveClaimCode(botToken: string): Promise<string> {
  const full = toHex(await hmac(botToken, LABEL_CLAIM));
  return full.slice(0, CLAIM_CODE_LENGTH);
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

/**
 * Constant-time string comparison.
 *
 * A plain `===` on a secret leaks its prefix length through timing. Length is
 * compared first and then folded into the accumulator, so an early return on
 * mismatched lengths cannot be used to probe the secret's length either.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare over a fixed span so the loop count does not depend on the secret.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** URL-safe base64 without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cryptographically random URL-safe token. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
