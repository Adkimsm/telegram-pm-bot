import { D1 } from "./shims/d1.js";
import { DONamespace } from "./shims/do.js";
import { CALLS, resetApi, GrammyError } from "./shims/grammy.js";
import { processUpdate } from "./.build/src/bot/index.js";
import { MediaGroupBuffer } from "./.build/src/lib/media-group.js";
import { loadSettings, setSetting } from "./.build/src/lib/settings.js";
import { deriveClaimCode } from "./.build/src/lib/crypto.js";

const SCHEMA = new URL("../migrations/0001_init.sql", import.meta.url).pathname;
const TOKEN = "123456789:AAtesttesttesttesttesttesttesttest";
const OWNER = 111111, RELAY = -1001234567890, STRANGER = 555555, THREAD = 42;

let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const section = (s) => console.log(`\n### ${s}`);

async function makeEnv({ owner = OWNER, relay = RELAY, seed = true, extra = {} } = {}) {
  const db = new D1(SCHEMA);
  const env = { BOT_TOKEN: TOKEN, DB: db };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  if (owner !== null) await setSetting(env, "owner_id", String(owner));
  if (relay !== null) await setSetting(env, "relay_chat_id", String(relay));
  for (const [k, v] of Object.entries(extra)) await setSetting(env, k, String(v));
  if (seed) {
    await db.prepare("INSERT INTO users (user_id,first_name,last_name,username,language_code,first_seen,last_seen,msg_count,rl_window_start,rl_window_count,blocked_bot) VALUES (?,?,?,?,?,?,?,?,?,?,0)")
      .bind(STRANGER, "Stranger", "", "stranger", "en", 1, 1, 3, 0, 0).run();
    await db.prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)").bind(STRANGER, RELAY, THREAD, 1).run();
  }
  return env;
}
const ORIGIN = new URL("https://pmbot.example.workers.dev/tg/x");
let uid = 1;
const run = async (env, u) => {
  const s = await loadSettings(env);
  await processUpdate(env, s, { update_id: uid++, ...u }, ORIGIN, () => {});
};
const priv = (o = {}) => ({ message: { message_id: o.message_id ?? 100, date: 1, chat: { id: o.from_id ?? STRANGER, type: "private" }, from: { id: o.from_id ?? STRANGER, is_bot: false, first_name: o.first_name ?? "Stranger" }, ...o } });
const grp = (o = {}) => ({ message: { message_id: o.message_id ?? 200, date: 1, chat: { id: RELAY, type: "supergroup", title: "Relay", is_forum: true }, from: { id: o.from_id ?? OWNER, is_bot: false, first_name: "Owner" }, message_thread_id: o.message_thread_id === null ? undefined : (o.message_thread_id ?? THREAD), ...o } });
const called = (m) => CALLS.filter((c) => c.method === m);
const last = (m) => called(m).at(-1);
const setting = async (env, k) => (await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(k).first())?.value;

section("/claim establishes ownership");
{
  const env = await makeEnv({ owner: null, relay: null, seed: false });
  const code = await deriveClaimCode(TOKEN);
  resetApi();
  await run(env, priv({ from_id: 999, text: `/claim ${code}` }));
  t("owner_id written", (await setting(env, "owner_id")) === "999");
  t("claim message deleted", called("deleteMessage").length === 1);
  t("confirmation sent", String(last("sendMessage")?.args[1]).includes("owner"));
}

section("/claim with a wrong code");
{
  const env = await makeEnv({ owner: null, relay: null, seed: false });
  resetApi();
  await run(env, priv({ from_id: 999, text: "/claim deadbeef1234" }));
  t("owner not set", (await setting(env, "owner_id")) === "");
  t("message still deleted", called("deleteMessage").length === 1);
  t("told it was invalid (pre-claim only)", String(last("sendMessage")?.args[1]).includes("Invalid"));
}

section("/claim wrong code stays silent once an owner exists");
{
  const env = await makeEnv();
  resetApi();
  await run(env, priv({ from_id: 424242, text: "/claim deadbeef1234" }));
  t("owner unchanged", (await setting(env, "owner_id")) === String(OWNER));
  t("no reply to the prober", called("sendMessage").length === 0);
  t("probe message deleted", called("deleteMessage").length === 1);
}

section("/claim transfer revokes sessions and warns the old owner");
{
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO sessions (token_hash,created_at,expires_at,user_agent) VALUES (?,?,?,?)").bind("h1", 1, 9999999999, "ua").run();
  const code = await deriveClaimCode(TOKEN);
  resetApi();
  await run(env, priv({ from_id: 222222, text: `/claim ${code}` }));
  t("ownership transferred", (await setting(env, "owner_id")) === "222222");
  t("sessions revoked", (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n === 0);
  t("old owner notified", called("sendMessage").some((c) => c.args[0] === OWNER && String(c.args[1]).includes("transferred")));
}

section("/login issues a single-use nonce link");
{
  const env = await makeEnv();
  resetApi();
  await run(env, priv({ from_id: OWNER, text: "/login" }));
  const body = String(last("sendMessage")?.args[1]);
  t("link points at /auth/", /https:\/\/pmbot\.example\.workers\.dev\/auth\/[A-Za-z0-9_-]+/.test(body), body.slice(0, 90));
  t("nonce stored hashed", (await env.DB.prepare("SELECT COUNT(*) AS n FROM login_nonces").first()).n === 1);
  const row = await env.DB.prepare("SELECT nonce_hash FROM login_nonces").first();
  const nonce = body.match(/\/auth\/([A-Za-z0-9_-]+)/)?.[1];
  t("plaintext nonce is NOT stored", row.nonce_hash !== nonce);
  t("hash is sha256 hex", /^[0-9a-f]{64}$/.test(row.nonce_hash));
}

section("/login from a non-owner is treated as a normal message");
{
  const env = await makeEnv();
  resetApi();
  await run(env, priv({ from_id: STRANGER, text: "/login" }));
  t("no login link issued", (await env.DB.prepare("SELECT COUNT(*) AS n FROM login_nonces").first()).n === 0);
  t("relayed instead", called("forwardMessage").length === 1);
}

section("/ban and /unban inside a topic");
{
  const env = await makeEnv();
  resetApi();
  await run(env, grp({ text: "/ban being rude" }));
  const ban = await env.DB.prepare("SELECT * FROM bans WHERE user_id=?").bind(STRANGER).first();
  t("banned the topic's user", !!ban);
  t("reason captured", ban?.reason === "being rude");
  t("nothing delivered to the stranger", called("copyMessage").length === 0);

  resetApi();
  await run(env, grp({ text: "/unban", message_id: 201 }));
  t("unbanned", (await env.DB.prepare("SELECT COUNT(*) AS n FROM bans").first()).n === 0);
}

section("/ban with an explicit id from the General topic");
{
  const env = await makeEnv();
  resetApi();
  await run(env, grp({ text: "/ban 777888 evasion", message_thread_id: null }));
  const ban = await env.DB.prepare("SELECT * FROM bans WHERE user_id=?").bind(777888).first();
  t("banned by id", !!ban);
  t("reason parsed after the id", ban?.reason === "evasion", ban?.reason);
}

section("moderation commands from a non-owner are relayed, not executed");
{
  const env = await makeEnv();
  resetApi();
  await run(env, grp({ from_id: 333333, text: "/ban 555555" }));
  t("no ban applied", (await env.DB.prepare("SELECT COUNT(*) AS n FROM bans").first()).n === 0);
}

section("/del removes both copies");
{
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO msg_map (relay_chat_id,relay_msg_id,user_id,user_msg_id,direction,media_group_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(RELAY, 500, STRANGER, 77, "in", null, 1).run();
  resetApi();
  await run(env, grp({ text: "/del", message_id: 210, reply_to_message: { message_id: 500, date: 1, chat: { id: RELAY, type: "supergroup" } } }));
  const dels = called("deleteMessage");
  t("deleted on the stranger side", dels.some((c) => c.args[0] === STRANGER && c.args[1] === 77));
  t("deleted in the relay group", dels.some((c) => c.args[0] === RELAY && c.args[1] === 500));
  t("the /del command itself removed", dels.some((c) => c.args[0] === RELAY && c.args[1] === 210));
  t("mapping cleared", (await env.DB.prepare("SELECT COUNT(*) AS n FROM msg_map").first()).n === 0);
}

section("/del without a reply explains itself");
{
  const env = await makeEnv();
  resetApi();
  await run(env, grp({ text: "/del" }));
  t("guidance sent", String(last("sendMessage")?.args[1]).includes("Reply to the message"));
  t("nothing deleted", called("deleteMessage").length === 0);
}

section("/info reports identity");
{
  const env = await makeEnv();
  resetApi();
  await run(env, grp({ text: "/info" }));
  const body = String(last("sendMessage")?.args[1]);
  t("shows the id", body.includes(`<code>${STRANGER}</code>`));
  t("shows the username", body.includes("@stranger"));
}

section("/id reports chat and thread");
{
  const env = await makeEnv();
  resetApi();
  await run(env, grp({ text: "/id" }));
  const body = String(last("sendMessage")?.args[1]);
  t("shows chat id", body.includes(String(RELAY)));
  t("shows thread id", body.includes(String(THREAD)));
}

section("/revoke clears sessions");
{
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO sessions (token_hash,created_at,expires_at,user_agent) VALUES (?,?,?,?)").bind("h1", 1, 9999999999, "").run();
  await env.DB.prepare("INSERT INTO sessions (token_hash,created_at,expires_at,user_agent) VALUES (?,?,?,?)").bind("h2", 1, 9999999999, "").run();
  resetApi();
  await run(env, priv({ from_id: OWNER, text: "/revoke" }));
  t("all sessions gone", (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n === 0);
  t("count reported", String(last("sendMessage")?.args[1]).includes("2"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
