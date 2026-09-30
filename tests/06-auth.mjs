import { D1 } from "./shims/d1.js";
import { DONamespace } from "./shims/do.js";
import { CALLS, resetApi, GrammyError } from "./shims/grammy.js";
import { MediaGroupBuffer } from "./.build/src/lib/media-group.js";
import { setSetting, loadSettings } from "./.build/src/lib/settings.js";
import { deriveWebhookSecret } from "./.build/src/lib/crypto.js";
import { createLoginNonce, redeemLoginNonce, createSession, verifySession, revokeAllSessions, sessionCookie, readSessionCookie, clearedSessionCookie } from "./.build/src/lib/auth.js";
import worker from "./.build/src/index.js";

const SCHEMA = new URL("../migrations/0001_init.sql", import.meta.url).pathname;
const TOKEN = "123456789:AAtesttesttesttesttesttesttesttest";
const OWNER = 111111, RELAY = -1001234567890, STRANGER = 555555, THREAD = 42;
const BASE = "https://pmbot.example.workers.dev";

let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const section = (s) => console.log(`\n### ${s}`);

async function makeEnv({ relay = RELAY } = {}) {
  const db = new D1(SCHEMA);
  const env = { BOT_TOKEN: TOKEN, DB: db,
    ASSETS: { fetch: async () => new Response("<html>console</html>", { headers: { "Content-Type": "text/html" } }) } };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  await setSetting(env, "owner_id", String(OWNER));
  if (relay !== null) await setSetting(env, "relay_chat_id", String(relay));
  await db.prepare("INSERT INTO users (user_id,first_name,last_name,username,language_code,first_seen,last_seen,msg_count,rl_window_start,rl_window_count,blocked_bot) VALUES (?,?,?,?,?,?,?,?,?,?,0)")
    .bind(STRANGER, "Stranger", "", "stranger", "en", 1, 1, 3, 0, 0).run();
  await db.prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)").bind(STRANGER, RELAY, THREAD, 1).run();
  return env;
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const call = (env, req) => worker.fetch(req, env, ctx);

section("webhook: correct path + header is accepted");
{
  const env = await makeEnv();
  const secret = await deriveWebhookSecret(TOKEN);
  resetApi();
  const res = await call(env, new Request(`${BASE}/tg/${secret}`, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: STRANGER, type: "private" }, from: { id: STRANGER, is_bot: false, first_name: "S" }, text: "hi" } }),
  }));
  t("200 OK", res.status === 200);
  t("message relayed", CALLS.some((c) => c.method === "forwardMessage"));
}

section("webhook: wrong header is rejected even with the right path");
{
  const env = await makeEnv();
  const secret = await deriveWebhookSecret(TOKEN);
  resetApi();
  const res = await call(env, new Request(`${BASE}/tg/${secret}`, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong", "Content-Type": "application/json" },
    body: JSON.stringify({ update_id: 2, message: { message_id: 1, date: 1, chat: { id: STRANGER, type: "private" }, from: { id: STRANGER, is_bot: false, first_name: "S" }, text: "hi" } }),
  }));
  t("401", res.status === 401);
  t("no side effects", CALLS.length === 0);
}

section("webhook: wrong path is rejected even with the right header");
{
  const env = await makeEnv();
  const secret = await deriveWebhookSecret(TOKEN);
  resetApi();
  const res = await call(env, new Request(`${BASE}/tg/deadbeef`, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
    body: JSON.stringify({ update_id: 3 }),
  }));
  t("401", res.status === 401);
  t("no side effects", CALLS.length === 0);
}

section("webhook: missing header rejected; GET rejected");
{
  const env = await makeEnv();
  const secret = await deriveWebhookSecret(TOKEN);
  t("no header -> 401", (await call(env, new Request(`${BASE}/tg/${secret}`, { method: "POST", body: "{}" }))).status === 401);
  t("GET -> 405", (await call(env, new Request(`${BASE}/tg/${secret}`))).status === 405);
}

section("webhook: malformed JSON is acknowledged, not retried forever");
{
  const env = await makeEnv();
  const secret = await deriveWebhookSecret(TOKEN);
  const res = await call(env, new Request(`${BASE}/tg/${secret}`, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: "not json",
  }));
  t("200 so Telegram stops retrying", res.status === 200);
}

section("webhook: a handler failure still returns 200");
{
  const env = await makeEnv();
  const secret = await deriveWebhookSecret(TOKEN);
  // A non-2xx would make Telegram redeliver an update we partly handled.
  resetApi({ forwardMessage: () => { throw new GrammyError("Bad Request: chat not found", 400); } });
  const res = await call(env, new Request(`${BASE}/tg/${secret}`, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
    body: JSON.stringify({ update_id: 10, message: { message_id: 1, date: 1, chat: { id: STRANGER, type: "private" }, from: { id: STRANGER, is_bot: false, first_name: "S" }, text: "boom" } }),
  }));
  t("200 despite the API error", res.status === 200);
}

section("auth: a fresh nonce redeems once and sets a session cookie");
{
  const env = await makeEnv();
  const nonce = await createLoginNonce(env);
  const res = await call(env, new Request(`${BASE}/auth/${nonce}`, { headers: { "User-Agent": "test-agent" } }));
  t("302 redirect", res.status === 302);
  t("redirects to the console root", res.headers.get("Location") === `${BASE}/`);
  const cookie = res.headers.get("Set-Cookie") ?? "";
  t("cookie set", cookie.includes("pmbot_session="));
  t("HttpOnly", cookie.includes("HttpOnly"));
  t("Secure", cookie.includes("Secure"));
  t("SameSite=Lax", cookie.includes("SameSite=Lax"));
  // workers.dev is on the Public Suffix List; a Domain attribute would share
  // the cookie with every other Worker on the same subdomain.
  t("no Domain attribute (host-only)", !/;\s*Domain=/i.test(cookie), cookie);
  t("session row created", (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n === 1);
  t("nonce consumed", (await env.DB.prepare("SELECT COUNT(*) AS n FROM login_nonces").first()).n === 0);

  const res2 = await call(env, new Request(`${BASE}/auth/${nonce}`));
  t("replay rejected", res2.status === 401);
  t("no second session", (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n === 1);
}

section("auth: expired nonce is rejected");
{
  const env = await makeEnv();
  const nonce = await createLoginNonce(env);
  await env.DB.prepare("UPDATE login_nonces SET expires_at = 1").run();
  t("401", (await call(env, new Request(`${BASE}/auth/${nonce}`))).status === 401);
}

section("auth: unknown and oversized nonces are rejected");
{
  const env = await makeEnv();
  t("unknown -> 401", (await call(env, new Request(`${BASE}/auth/whatever`))).status === 401);
  t("oversized -> 401", (await call(env, new Request(`${BASE}/auth/${"x".repeat(200)}`))).status === 401);
}

section("session: verification, forgery and revocation");
{
  const env = await makeEnv();
  const { token } = await createSession(env, "ua");
  t("valid token accepted", (await verifySession(env, token)) === true);
  t("null rejected", (await verifySession(env, null)) === false);
  t("garbage rejected", (await verifySession(env, "garbage")) === false);
  t("no-dot rejected", (await verifySession(env, "abcdef")) === false);
  // Tampering the signature must fail before any database lookup.
  // The replacement character depends on the last one: appending a fixed "A"
  // is a no-op whenever the signature already ends in "A", which made this
  // assertion fail about once in sixty-four runs.
  const [raw, sig] = [token.slice(0, token.lastIndexOf(".")), token.slice(token.lastIndexOf(".") + 1)];
  const flipped = sig.at(-1) === "A" ? "B" : "A";
  t("tampered signature rejected", (await verifySession(env, `${raw}.${sig.slice(0, -1)}${flipped}`)) === false);
  t("swapped random part rejected", (await verifySession(env, `AAAA${raw.slice(4)}.${sig}`)) === false);
  // A signature valid under a different token must not verify.
  const other = { ...env, BOT_TOKEN: "999:BBotherotherotherotherotherother" };
  const { token: otherToken } = await createSession(other, "ua");
  t("token from another bot rejected", (await verifySession(env, otherToken)) === false);

  await env.DB.prepare("UPDATE sessions SET expires_at = 1").run();
  t("expired session rejected", (await verifySession(env, token)) === false);

  const { token: t2 } = await createSession(env, "ua");
  await revokeAllSessions(env);
  t("revoked session rejected", (await verifySession(env, t2)) === false);
}

section("cookie parsing");
{
  const mk = (h) => new Request(BASE, { headers: h ? { Cookie: h } : {} });
  t("no header", readSessionCookie(mk(null)) === null);
  t("single", readSessionCookie(mk("pmbot_session=abc")) === "abc");
  t("among others", readSessionCookie(mk("a=1; pmbot_session=xyz; b=2")) === "xyz");
  t("with spaces", readSessionCookie(mk("  pmbot_session = spaced  ")) === "spaced");
  t("absent", readSessionCookie(mk("other=1")) === null);
  t("empty value", readSessionCookie(mk("pmbot_session=")) === null);
  // A prefix match must not be mistaken for the real cookie.
  t("similar name ignored", readSessionCookie(mk("pmbot_session_x=nope")) === null);
  t("cleared cookie has Max-Age=0", clearedSessionCookie().includes("Max-Age=0"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
