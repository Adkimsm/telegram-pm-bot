import {
  deriveSessionKey,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from "./crypto";
import { now } from "./db";
import type { Env } from "./types";

/** Login links are meant to be clicked immediately. */
const NONCE_TTL_SEC = 120;
/** Web UI session lifetime. */
const SESSION_TTL_SEC = 7 * 86400;

export const SESSION_COOKIE = "pmbot_session";

// ---------------------------------------------------------------------------
// Single-use login nonces
// ---------------------------------------------------------------------------

/**
 * Issue a login nonce. Only its SHA-256 is stored, so a database leak cannot
 * be replayed into a session.
 */
export async function createLoginNonce(env: Env): Promise<string> {
  const nonce = randomToken(32);
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO login_nonces (nonce_hash, created_at, expires_at)
     VALUES (?, ?, ?)`,
  )
    .bind(await sha256Hex(nonce), ts, ts + NONCE_TTL_SEC)
    .run();
  return nonce;
}

/**
 * Redeem a nonce. The DELETE is the atomic claim: if it changed a row we were
 * the first and only redeemer, which closes the race between two concurrent
 * requests presenting the same link.
 */
export async function redeemLoginNonce(
  env: Env,
  nonce: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM login_nonces WHERE nonce_hash = ? AND expires_at > ?",
  )
    .bind(await sha256Hex(nonce), now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Session tokens are `<random>.<hmac>`.
 *
 * The HMAC lets us reject forged tokens without touching D1, and the database
 * row is what makes revocation possible. Both checks are required.
 */
export async function createSession(
  env: Env,
  userAgent: string,
): Promise<{ token: string; expiresAt: number }> {
  const raw = randomToken(32);
  const key = await deriveSessionKey(env.BOT_TOKEN);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(raw),
  );
  const token = `${raw}.${bytesToBase64Url(new Uint8Array(sig))}`;

  const ts = now();
  const expiresAt = ts + SESSION_TTL_SEC;

  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(token), ts, expiresAt, userAgent.slice(0, 200))
    .run();

  return { token, expiresAt };
}

export async function verifySession(
  env: Env,
  token: string | null,
): Promise<boolean> {
  if (!token) return false;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;

  const raw = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  // Cheap cryptographic check first: a forged token never reaches the database.
  const key = await deriveSessionKey(env.BOT_TOKEN);
  const expectedSig = bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)),
    ),
  );
  if (!timingSafeEqual(providedSig, expectedSig)) return false;

  const row = await env.DB.prepare(
    "SELECT expires_at FROM sessions WHERE token_hash = ?",
  )
    .bind(await sha256Hex(token))
    .first<{ expires_at: number }>();

  return row !== null && row.expires_at > now();
}

export async function revokeAllSessions(env: Env): Promise<number> {
  const res = await env.DB.prepare("DELETE FROM sessions").run();
  return res.meta.changes ?? 0;
}

export async function revokeSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .run();
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Build the session cookie.
 *
 * The `Domain` attribute is deliberately omitted, making the cookie host-only.
 * `workers.dev` is on the Public Suffix List, so `<sub>.workers.dev` is a
 * registrable domain — setting `Domain` would share the cookie with every
 * other Worker on the same subdomain.
 */
export function sessionCookie(token: string, maxAgeSec: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
