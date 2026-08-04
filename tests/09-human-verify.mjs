import { D1 } from "./shims/d1.js";
import { DONamespace } from "./shims/do.js";
import { CALLS, resetApi } from "./shims/grammy.js";
import { processUpdate } from "./.build/src/bot/index.js";
import { MediaGroupBuffer } from "./.build/src/lib/media-group.js";
import { loadSettings, setSetting } from "./.build/src/lib/settings.js";

const SCHEMA = new URL("../migrations/0001_init.sql", import.meta.url).pathname;
const MIGRATION2 = new URL("../migrations/0002_reactions.sql", import.meta.url).pathname;
const MIGRATION3 = new URL("../migrations/0003_human_verify.sql", import.meta.url).pathname;
const TOKEN = "123456789:AAtesttesttesttesttesttesttesttest";
const OWNER = 111111;
const RELAY = -1001234567890;
const STRANGER = 555555;

let pass = 0;
let fail = 0;
const t = (n, c, e = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n}${e ? " — " + e : ""}`);
  }
};
const section = (s) => console.log(`\n### ${s}`);

async function makeEnv() {
  const { readFileSync } = await import("node:fs");
  const db = new D1(SCHEMA);
  db.exec(readFileSync(MIGRATION2, "utf8"));
  db.exec(readFileSync(MIGRATION3, "utf8"));
  const env = { BOT_TOKEN: TOKEN, DB: db };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  await setSetting(env, "owner_id", String(OWNER));
  await setSetting(env, "relay_chat_id", String(RELAY));
  await setSetting(env, "human_verify_enabled", "1");
  await setSetting(env, "human_verify_timeout", "300");
  await setSetting(env, "human_verify_max_attempts", "2");
  await setSetting(env, "human_verify_ban_minutes", "10");
  await setSetting(env, "human_verify_prompt", "请先验证。 ");
  return env;
}

const ORIGIN = new URL("https://pmbot.example.workers.dev/tg/x");
let uid = 1;
async function feed(env, update) {
  const settings = await loadSettings(env);
  await processUpdate(env, settings, { update_id: uid++, ...update }, ORIGIN, () => {});
}

const priv = (over = {}) => ({
  message: {
    message_id: over.message_id ?? 100,
    date: 1700000000,
    chat: { id: STRANGER, type: "private" },
    from: { id: STRANGER, is_bot: false, first_name: "Stranger" },
    ...over,
  },
});

const callback = (data) => ({
  callback_query: {
    id: `cb-${uid}`,
    from: { id: STRANGER, is_bot: false, first_name: "Stranger" },
    data,
    chat_instance: "ci",
    message: {
      message_id: 999,
      date: 1700000000,
      chat: { id: STRANGER, type: "private" },
    },
  },
});

const methods = (m) => CALLS.filter((c) => c.method === m);
const last = (m) => methods(m).at(-1);

section("/start sends a challenge instead of relaying");
{
  const env = await makeEnv();
  resetApi();
  await feed(env, priv({ text: "/start" }));
  t("one message sent", methods("sendMessage").length === 1);
  t("nothing forwarded", methods("forwardMessage").length === 0);
  const sent = last("sendMessage");
  t("prompt includes the verify text", String(sent?.args[1]).includes("请先验证"));
  t("inline keyboard attached", !!sent?.args[2]?.reply_markup?.inline_keyboard);
  const row = await env.DB.prepare(
    "SELECT verify_state, verify_nonce, verify_answer, verify_attempts, verified_at FROM users WHERE user_id=?",
  ).bind(STRANGER).first();
  t("pending state stored", row.verify_state === "pending");
  t("nonce stored", row.verify_nonce.length > 0);
  t("answer stored", row.verify_answer.length > 0);
  t("attempts start at 0", row.verify_attempts === 0);
  t("not yet verified", row.verified_at === 0);
}

section("ordinary message before solving the challenge is stopped");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  resetApi();
  await feed(env, priv({ text: "hello" }));
  t("nothing forwarded", methods("forwardMessage").length === 0);
  t("a reminder is sent", String(last("sendMessage")?.args[1]).includes("上一道验证题"));
}

section("correct callback marks the user verified");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  const row = await env.DB.prepare(
    "SELECT verify_nonce, verify_answer FROM users WHERE user_id=?",
  ).bind(STRANGER).first();
  resetApi();
  await feed(env, callback(`hv:${row.verify_nonce}:${row.verify_answer}`));
  const done = await env.DB.prepare(
    "SELECT verified_at, verify_state FROM users WHERE user_id=?",
  ).bind(STRANGER).first();
  t("verified_at set", done.verified_at > 0);
  t("pending state cleared", done.verify_state === "");
  t("callback answered", methods("answerCallbackQuery").length === 1);
  t("success message sent", String(last("sendMessage")?.args[1]).includes("验证通过"));
}

section("verified users fall back to the normal relay path");
{
  const env = await makeEnv();
  await env.DB.prepare(
    `INSERT INTO users (user_id,first_name,last_name,username,language_code,
                        first_seen,last_seen,msg_count,rl_window_start,
                        rl_window_count,blocked_bot,verified_at,verify_state,
                        verify_nonce,verify_answer,verify_expires_at,
                        verify_attempts,temp_banned_until)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(STRANGER, "Stranger", "", null, null, 1, 1, 0, 0, 0, 0, 1, "", "", "", 0, 0, 0).run();
  resetApi();
  await feed(env, priv({ text: "hello after verify" }));
  t("message forwarded", methods("forwardMessage").length === 1);
}

section("wrong answers get two tries, then a temporary ban");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  let row = await env.DB.prepare(
    "SELECT verify_nonce, verify_answer FROM users WHERE user_id=?",
  ).bind(STRANGER).first();

  resetApi();
  await feed(env, callback(`hv:${row.verify_nonce}:wrong`));
  let state = await env.DB.prepare(
    "SELECT verify_attempts, verify_state, temp_banned_until, verify_nonce FROM users WHERE user_id=?",
  ).bind(STRANGER).first();
  t("first failure counted", state.verify_attempts === 1, JSON.stringify(state));
  t("still pending", state.verify_state === "pending");
  t("challenge refreshed", state.verify_nonce !== row.verify_nonce);

  row = state;
  resetApi();
  await feed(env, callback(`hv:${row.verify_nonce}:wrong`));
  state = await env.DB.prepare(
    "SELECT verify_attempts, verify_state, temp_banned_until FROM users WHERE user_id=?",
  ).bind(STRANGER).first();
  t("pending state cleared after second failure", state.verify_state === "");
  t("temp ban set", state.temp_banned_until > 0);
  t("ban alert shown", String(last("answerCallbackQuery")?.args[1]?.text).includes("临时限制"));
}

section("temp-banned users are told to wait");
{
  const env = await makeEnv();
  const future = Math.floor(Date.now() / 1000) + 300;
  await env.DB.prepare(
    `INSERT INTO users (user_id,first_name,last_name,username,language_code,
                        first_seen,last_seen,msg_count,rl_window_start,
                        rl_window_count,blocked_bot,verified_at,verify_state,
                        verify_nonce,verify_answer,verify_expires_at,
                        verify_attempts,temp_banned_until)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(STRANGER, "Stranger", "", null, null, 1, 1, 0, 0, 0, 0, 0, "", "", "", 0, 0, future).run();
  resetApi();
  await feed(env, priv({ text: "/start" }));
  t("cooldown notice sent", String(last("sendMessage")?.args[1]).includes("秒后再试"));
  t("still nothing forwarded", methods("forwardMessage").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
