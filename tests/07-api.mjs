import { D1 } from "./shims/d1.js";
import { DONamespace } from "./shims/do.js";
import { resetApi, CALLS } from "./shims/grammy.js";
import { MediaGroupBuffer } from "./.build/src/lib/media-group.js";
import { setSetting } from "./.build/src/lib/settings.js";
import { createSession, sessionCookie } from "./.build/src/lib/auth.js";
import { cleanup } from "./.build/src/lib/db.js";
import worker from "./.build/src/index.js";

const SCHEMA = new URL("../migrations/0001_init.sql", import.meta.url).pathname;
const MIGRATION2 = new URL("../migrations/0002_reactions.sql", import.meta.url).pathname;
const MIGRATION3 = new URL("../migrations/0003_human_verify.sql", import.meta.url).pathname;
const MIGRATION4 = new URL("../migrations/0004_human_verify_hardening.sql", import.meta.url).pathname;
const TOKEN = "123456789:AAtesttesttesttesttesttesttesttest";
const OWNER = 111111, RELAY = -1001234567890, STRANGER = 555555, THREAD = 42;
const BASE = "https://pmbot.example.workers.dev";

let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const section = (s) => console.log(`\n### ${s}`);

async function makeEnv({ relay = RELAY } = {}) {
  const db = new D1(SCHEMA);
  const { readFileSync } = await import("node:fs");
  db.exec(readFileSync(MIGRATION2, "utf8"));
  db.exec(readFileSync(MIGRATION3, "utf8"));
  db.exec(readFileSync(MIGRATION4, "utf8"));
  const env = { BOT_TOKEN: TOKEN, DB: db,
    ASSETS: { fetch: async () => new Response("<html>console</html>") } };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  await setSetting(env, "owner_id", String(OWNER));
  if (relay !== null) await setSetting(env, "relay_chat_id", String(relay));
  for (const [id, name] of [[STRANGER, "Stranger"], [666666, "Bob"], [777777, "Carol"]]) {
    await db.prepare("INSERT INTO users (user_id,first_name,last_name,username,language_code,first_seen,last_seen,msg_count,rl_window_start,rl_window_count,blocked_bot) VALUES (?,?,?,?,?,?,?,?,?,?,0)")
      .bind(id, name, "", name.toLowerCase(), "en", 1, id, 3, 0, 0).run();
  }
  await db.prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)").bind(STRANGER, RELAY, THREAD, 1).run();
  await db.prepare("INSERT INTO bans (user_id,reason,banned_at) VALUES (?,?,?)").bind(666666, "spam", 1).run();
  await db.prepare("INSERT INTO candidate_chats (chat_id,title,type,is_forum,can_manage_topics,seen_at) VALUES (?,?,?,?,?,?)")
    .bind(RELAY, "Relay", "supergroup", 1, 1, 1).run();
  return env;
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

async function authed(env) {
  const { token } = await createSession(env, "test");
  return (path, init = {}) => worker.fetch(new Request(`${BASE}/api/${path}`, {
    ...init,
    headers: { Cookie: `pmbot_session=${token}`, "Content-Type": "application/json", Origin: BASE, ...(init.headers ?? {}) },
  }), env, ctx);
}
const anon = (env) => (path, init = {}) => worker.fetch(new Request(`${BASE}/api/${path}`, init), env, ctx);

section("api: every route requires a session, including read-only ones");
{
  const env = await makeEnv();
  const a = anon(env);
  for (const p of ["overview", "settings", "users", "bans", "chats", "webhook"]) {
    const res = await a(p);
    t(`GET ${p} -> 401`, res.status === 401);
  }
  const res = await a("settings", { method: "PUT", body: "{}" });
  t("PUT settings -> 401", res.status === 401);
  t("401 clears the cookie", (res.headers.get("Set-Cookie") ?? "").includes("Max-Age=0"));
}

section("api: a forged cookie is rejected");
{
  const env = await makeEnv();
  const res = await worker.fetch(new Request(`${BASE}/api/overview`, { headers: { Cookie: "pmbot_session=forged.signature" } }), env, ctx);
  t("401", res.status === 401);
}

section("api: overview");
{
  const env = await makeEnv();
  const api = await authed(env);
  resetApi({
    getChat: () => ({ id: RELAY, type: "supergroup", title: "Relay", is_forum: true }),
    getChatMember: () => ({ status: "administrator", user: { id: 777, is_bot: true, first_name: "b" }, can_manage_topics: true }),
  });
  const res = await api("overview");
  t("200", res.status === 200);
  const d = await res.json();
  t("owner exposed", d.settings.ownerId === OWNER);
  t("relay exposed", d.settings.relayChatId === RELAY);
  t("stats present", d.stats.users === 3 && d.stats.banned === 1 && d.stats.topics === 1);
  t("relay check ok", d.relayCheck.ok === true);
  t("ready", d.ready === true);
  t("console url", d.consoleUrl === BASE);
}

section("api: overview reports a non-forum relay group as broken");
{
  const env = await makeEnv();
  const api = await authed(env);
  resetApi({
    getChat: () => ({ id: RELAY, type: "supergroup", title: "Relay" }),
    getChatMember: () => ({ status: "administrator", user: { id: 777, is_bot: true, first_name: "b" }, can_manage_topics: true }),
  });
  const d = await (await api("overview")).json();
  t("not ready", d.ready === false);
  t("explains Topics are off", /Topics are not enabled/.test(d.relayCheck.detail), d.relayCheck.detail);
}

section("api: overview reports a missing permission");
{
  const env = await makeEnv();
  const api = await authed(env);
  resetApi({
    getChat: () => ({ id: RELAY, type: "supergroup", title: "Relay", is_forum: true }),
    getChatMember: () => ({ status: "member", user: { id: 777, is_bot: true, first_name: "b" } }),
  });
  const d = await (await api("overview")).json();
  t("not ready", d.ready === false);
  t("explains the permission", /Manage topics/.test(d.relayCheck.detail), d.relayCheck.detail);
}

section("api: settings validation");
{
  const env = await makeEnv();
  const api = await authed(env);

  let res = await api("settings", { method: "PUT", body: JSON.stringify({ welcome_text: "Hello!", rate_limit_max: "30" }) });
  t("valid update accepted", res.status === 200);
  const after = await (await api("settings")).json();
  const map = Object.fromEntries(after.settings.map((s) => [s.key, s.value]));
  t("welcome persisted", map.welcome_text === "Hello!");
  t("rate limit persisted", map.rate_limit_max === "30");

  // owner_id is the trust root: it must not be writable through the UI it gates.
  res = await api("settings", { method: "PUT", body: JSON.stringify({ owner_id: "999" }) });
  t("owner_id rejected", res.status === 400);
  t("owner unchanged", (await env.DB.prepare("SELECT value FROM settings WHERE key='owner_id'").first()).value === String(OWNER));

  res = await api("settings", { method: "PUT", body: JSON.stringify({ rate_limit_max: "-1" }) });
  t("negative limit rejected", res.status === 400);

  // A partial apply would leave an inconsistent configuration.
  res = await api("settings", { method: "PUT", body: JSON.stringify({ welcome_text: "ok", rate_limit_max: "abc" }) });
  t("mixed valid/invalid rejected wholesale", res.status === 400);
  const m2 = Object.fromEntries((await (await api("settings")).json()).settings.map((s) => [s.key, s.value]));
  t("nothing applied from the rejected batch", m2.welcome_text === "Hello!", m2.welcome_text);
}

section("api: cross-origin writes are refused");
{
  const env = await makeEnv();
  const { token } = await createSession(env, "t");
  const res = await worker.fetch(new Request(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { Cookie: `pmbot_session=${token}`, "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ welcome_text: "pwned" }),
  }), env, ctx);
  t("403", res.status === 403);
}

section("api: users list, search and paging");
{
  const env = await makeEnv();
  const api = await authed(env);
  let d = await (await api("users")).json();
  t("all users returned", d.total === 3 && d.users.length === 3);
  t("banned flag joined", d.users.find((u) => u.user_id === 666666)?.banned === 1);
  t("thread id joined", d.users.find((u) => u.user_id === STRANGER)?.thread_id === THREAD);
  t("display name computed", d.users.every((u) => typeof u.display_name === "string"));

  d = await (await api("users?q=carol")).json();
  t("search by username", d.total === 1 && d.users[0].user_id === 777777);
  d = await (await api("users?q=666666")).json();
  t("search by id", d.total === 1 && d.users[0].user_id === 666666);
  d = await (await api("users?q=nobody")).json();
  t("no match", d.total === 0);

  d = await (await api("users?limit=2&offset=0")).json();
  t("limit honoured", d.users.length === 2 && d.total === 3);
  d = await (await api("users?limit=2&offset=2")).json();
  t("offset honoured", d.users.length === 1);
  d = await (await api("users?limit=9999")).json();
  t("limit clamped", d.limit === 200);
}

section("api: bans");
{
  const env = await makeEnv();
  const api = await authed(env);
  let d = await (await api("bans")).json();
  t("existing ban listed", d.bans.length === 1 && d.bans[0].user_id === 666666);
  t("name joined", d.bans[0].first_name === "Bob");

  let res = await api("bans", { method: "POST", body: JSON.stringify({ user_id: STRANGER, reason: "rude" }) });
  t("ban created", res.status === 200);
  t("stored", (await env.DB.prepare("SELECT reason FROM bans WHERE user_id=?").bind(STRANGER).first()).reason === "rude");

  res = await api("bans", { method: "DELETE", body: JSON.stringify({ user_id: STRANGER }) });
  t("ban removed", (await res.json()).removed === true);

  res = await api("bans", { method: "POST", body: JSON.stringify({ user_id: "@alice" }) });
  t("username rejected", res.status === 400);
  res = await api("bans", { method: "POST", body: JSON.stringify({}) });
  t("missing id rejected", res.status === 400);
}

section("api: manual verification");
{
  const env = await makeEnv();
  const api = await authed(env);

  let res = await api("verify", { method: "POST", body: JSON.stringify({ user_id: STRANGER }) });
  t("verify endpoint accepts a known user", res.status === 200);
  t(
    "verified_at set",
    (await env.DB.prepare("SELECT verified_at FROM users WHERE user_id=?").bind(STRANGER).first()).verified_at > 0,
  );

  res = await api("verify", { method: "DELETE", body: JSON.stringify({ user_id: STRANGER }) });
  t("unverify endpoint accepts a known user", res.status === 200);
  const row = await env.DB.prepare(
    "SELECT verified_at, verify_state, verify_step, verify_strikes, temp_banned_until FROM users WHERE user_id=?",
  ).bind(STRANGER).first();
  t(
    "verification state cleared",
    row.verified_at === 0 &&
      row.verify_state === "" &&
      row.verify_step === 0 &&
      row.verify_strikes === 0 &&
      row.temp_banned_until === 0,
    JSON.stringify(row),
  );

  res = await api("verify", { method: "POST", body: JSON.stringify({ user_id: "abc" }) });
  t("verify rejects junk ids", res.status === 400);
  res = await api("verify", { method: "DELETE", body: JSON.stringify({ user_id: 424242 }) });
  t("unverify returns 404 for unknown users", res.status === 404);
}

section("api: bind probes before accepting");
{
  const env = await makeEnv({ relay: null });
  const api = await authed(env);

  resetApi({
    getChat: () => ({ id: -100777, type: "supergroup", title: "Good", is_forum: true }),
    getChatMember: () => ({ status: "administrator", user: { id: 777, is_bot: true, first_name: "b" }, can_manage_topics: true }),
  });
  let res = await api("bind", { method: "POST", body: JSON.stringify({ chat_id: -100777 }) });
  t("eligible group bound", res.status === 200);
  t("persisted", (await env.DB.prepare("SELECT value FROM settings WHERE key='relay_chat_id'").first()).value === "-100777");

  // Binding a non-forum group would silently break relaying, so it is refused.
  resetApi({
    getChat: () => ({ id: -100888, type: "supergroup", title: "NoTopics" }),
    getChatMember: () => ({ status: "administrator", user: { id: 777, is_bot: true, first_name: "b" }, can_manage_topics: true }),
  });
  res = await api("bind", { method: "POST", body: JSON.stringify({ chat_id: -100888 }) });
  t("non-forum refused", res.status === 400);
  t("binding unchanged", (await env.DB.prepare("SELECT value FROM settings WHERE key='relay_chat_id'").first()).value === "-100777");

  res = await api("bind", { method: "POST", body: JSON.stringify({ chat_id: "abc" }) });
  t("junk id refused", res.status === 400);
}

section("api: webhook status and reset");
{
  const env = await makeEnv();
  const api = await authed(env);
  const { deriveWebhookSecret } = await import("./.build/src/lib/crypto.js");
  const secret = await deriveWebhookSecret(TOKEN);

  resetApi({ getWebhookInfo: () => ({ url: `${BASE}/tg/${secret}`, pending_update_count: 0, has_custom_certificate: false }) });
  let d = await (await api("webhook")).json();
  t("matching webhook detected", d.matches === true);
  t("expected url derived", d.expected === `${BASE}/tg/${secret}`);

  resetApi({ getWebhookInfo: () => ({ url: "https://old.example/tg/x", pending_update_count: 5, has_custom_certificate: false }) });
  d = await (await api("webhook")).json();
  t("mismatch detected", d.matches === false);

  resetApi({ getWebhookInfo: () => ({ url: `${BASE}/tg/${secret}`, pending_update_count: 0, has_custom_certificate: false }) });
  const res = await api("webhook", { method: "POST" });
  t("reset ok", res.status === 200);
  const setCall = CALLS.find((c) => c.method === "setWebhook");
  t("setWebhook called with the derived url", setCall?.args[0] === `${BASE}/tg/${secret}`);
  t("secret_token sent", setCall?.args[1]?.secret_token === secret);
  // "If not specified, the previous setting will be used" — must always be explicit.
  t("allowed_updates sent explicitly", Array.isArray(setCall?.args[1]?.allowed_updates) && setCall.args[1].allowed_updates.includes("my_chat_member"));
}

section("api: candidate chats, cleanup, logout, topic reset");
{
  const env = await makeEnv();
  const api = await authed(env);
  t("candidates listed", (await (await api("chats")).json()).chats.length === 1);

  await env.DB.prepare("INSERT INTO seen_updates (update_id,ts) VALUES (?,?)").bind(1, 1).run();
  await env.DB.prepare("INSERT INTO login_nonces (nonce_hash,created_at,expires_at) VALUES (?,?,?)").bind("old", 1, 1).run();
  const c = await (await api("cleanup", { method: "POST" })).json();
  t("cleanup removed stale rows", c.deleted.seen_updates >= 1 && c.deleted.login_nonces >= 1);

  let res = await api("topic", { method: "DELETE", body: JSON.stringify({ user_id: STRANGER }) });
  t("topic mapping cleared", res.status === 200 && (await env.DB.prepare("SELECT COUNT(*) AS n FROM topics").first()).n === 0);
  res = await api("topic", { method: "DELETE", body: JSON.stringify({ user_id: 424242 }) });
  t("unknown user -> 404", res.status === 404);

  res = await api("logout", { method: "POST" });
  t("logout clears the cookie", (res.headers.get("Set-Cookie") ?? "").includes("Max-Age=0"));
  t("session row deleted", (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n === 0);
}

section("api: unknown route");
{
  const env = await makeEnv();
  const api = await authed(env);
  t("404", (await api("nope")).status === 404);
}

section("static assets are served for other paths");
{
  const env = await makeEnv();
  const res = await worker.fetch(new Request(`${BASE}/`), env, ctx);
  t("200 from ASSETS", res.status === 200);
  t("html body", (await res.text()).includes("console"));
}

section("missing BOT_TOKEN fails loudly");
{
  const env = await makeEnv();
  const res = await worker.fetch(new Request(`${BASE}/api/overview`), { ...env, BOT_TOKEN: "" }, ctx);
  t("500 with guidance", res.status === 500 && (await res.text()).includes("wrangler secret put"));
}

section("scheduled handler runs cleanup");
{
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO seen_updates (update_id,ts) VALUES (?,?)").bind(42, 1).run();
  await worker.scheduled({}, env);
  t("stale dedup rows pruned", (await env.DB.prepare("SELECT COUNT(*) AS n FROM seen_updates").first()).n === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
