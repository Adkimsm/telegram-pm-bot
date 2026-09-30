import { readFileSync } from "node:fs";
import { D1 } from "./shims/d1.js";
import { DONamespace } from "./shims/do.js";
import { CALLS, resetApi } from "./shims/grammy.js";
import { processUpdate } from "./.build/src/bot/index.js";
import { MediaGroupBuffer } from "./.build/src/lib/media-group.js";
import { loadSettings, setSetting } from "./.build/src/lib/settings.js";

const SCHEMA = new URL("../migrations/0001_init.sql", import.meta.url).pathname;
const MIGRATION2 = new URL("../migrations/0002_reactions.sql", import.meta.url).pathname;
const MIGRATION3 = new URL("../migrations/0003_human_verify.sql", import.meta.url).pathname;
const MIGRATION4 = new URL("../migrations/0004_human_verify_hardening.sql", import.meta.url).pathname;
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

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * `min_seconds` defaults to 0 here: the tests must not depend on how fast the
 * machine runs. The one case that exercises the check raises it explicitly.
 */
async function makeEnv({ minSeconds = "0", escalate = "1", rounds = "2" } = {}) {
  const db = new D1(SCHEMA);
  db.exec(readFileSync(MIGRATION2, "utf8"));
  db.exec(readFileSync(MIGRATION3, "utf8"));
  db.exec(readFileSync(MIGRATION4, "utf8"));
  const env = { BOT_TOKEN: TOKEN, DB: db };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  await setSetting(env, "owner_id", String(OWNER));
  await setSetting(env, "relay_chat_id", String(RELAY));
  await setSetting(env, "human_verify_enabled", "1");
  await setSetting(env, "human_verify_timeout", "300");
  await setSetting(env, "human_verify_max_attempts", "2");
  await setSetting(env, "human_verify_ban_minutes", "10");
  await setSetting(env, "human_verify_rounds", rounds);
  await setSetting(env, "human_verify_min_seconds", minSeconds);
  await setSetting(env, "human_verify_escalate", escalate);
  await setSetting(env, "human_verify_prompt", "请先验证。 ");
  return env;
}

const VERIFY_COLS = `verified_at, verify_state, verify_nonce, verify_answer,
                     verify_expires_at, verify_attempts, verify_step,
                     verify_issued_at, verify_strikes, temp_banned_until`;

const stateOf = (env, id = STRANGER) =>
  env.DB.prepare(`SELECT ${VERIFY_COLS} FROM users WHERE user_id=?`)
    .bind(id)
    .first();

/** Any answer other than the right one, in a form the bot reads as an answer. */
const wrongAnswer = (answer) => String(Number(answer) + 1);

const toFullWidth = (s) =>
  s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));

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
const methods = (m) => CALLS.filter((c) => c.method === m);
const last = (m) => methods(m).at(-1);
/** Every message body sent so far, in order. */
const bodies = (m = "sendMessage") => methods(m).map((c) => String(c.args[1]));
const said = (fragment) => bodies().some((b) => b.includes(fragment));

section("/start sends a challenge that must be answered by typing");
{
  const env = await makeEnv();
  resetApi();
  await feed(env, priv({ text: "/start" }));
  t("one message sent", methods("sendMessage").length === 1);
  t("nothing forwarded", methods("forwardMessage").length === 0);
  const sent = last("sendMessage");
  const body = String(sent?.args[1]);
  t("prompt includes the verify text", body.includes("请先验证"));
  t("prompt asks a question", body.includes("= ?"));
  t("prompt says how to answer", body.includes("直接回复答案数字"));
  t("prompt counts the rounds", body.includes("第 1/2 题"));
  // The whole point of the hardening: nothing to tap, so nothing to guess.
  t("no inline keyboard attached", !sent?.args[2]?.reply_markup);

  const row = await stateOf(env);
  t("pending state stored", row.verify_state === "pending");
  t("nonce stored", row.verify_nonce.length > 0);
  t("answer stored as digits", /^\d+$/.test(row.verify_answer), row.verify_answer);
  t("round counter starts at 0", row.verify_step === 0);
  t("issue time recorded", row.verify_issued_at > 0);
  t("attempts start at 0", row.verify_attempts === 0);
  t("not yet verified", row.verified_at === 0);
}

section("each correct answer advances one round");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  const first = await stateOf(env);

  resetApi();
  await feed(env, priv({ text: first.verify_answer }));
  const second = await stateOf(env);
  t("first round counted", second.verify_step === 1, JSON.stringify(second));
  t("still pending", second.verify_state === "pending");
  t("not verified yet", second.verified_at === 0);
  t("new challenge issued", second.verify_nonce !== first.verify_nonce);
  t("the next question is sent", String(last("sendMessage")?.args[1]).includes("第 2/2 题"));
}

section("answering every question marks the user verified");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  for (let i = 0; i < 2; i++) {
    const row = await stateOf(env);
    await feed(env, priv({ text: row.verify_answer }));
  }
  const done = await stateOf(env);
  t("verified_at set", done.verified_at > 0, JSON.stringify(done));
  t("pending state cleared", done.verify_state === "");
  t("answer forgotten", done.verify_answer === "");
  t("round counter cleared", done.verify_step === 0);
  t("success message sent", String(last("sendMessage")?.args[1]).includes("验证通过"));
}

section("a single round is enough when configured that way");
{
  const env = await makeEnv({ rounds: "1" });
  await feed(env, priv({ text: "/start" }));
  t("no round counter shown", !String(last("sendMessage")?.args[1]).includes("第 "));
  const row = await stateOf(env);
  await feed(env, priv({ text: row.verify_answer }));
  t("verified after one answer", (await stateOf(env)).verified_at > 0);
}

section("full-width digits from a mobile keyboard are accepted");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  const row = await stateOf(env);
  await feed(env, priv({ text: toFullWidth(row.verify_answer) }));
  t("counted as correct", (await stateOf(env)).verify_step === 1);
}

section("ordinary chat is reminded, not charged an attempt");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  const before = await stateOf(env);

  resetApi();
  await feed(env, priv({ text: "你好，我想咨询一下价格" }));
  const after = await stateOf(env);
  t("no attempt spent", after.verify_attempts === 0, JSON.stringify(after));
  t("same challenge kept", after.verify_answer === before.verify_answer);
  t("reminder sent", String(last("sendMessage")?.args[1]).includes("只发数字"));
  t("nothing forwarded", methods("forwardMessage").length === 0);
}

section("a wrong number costs an attempt and reissues the challenge");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  const first = await stateOf(env);

  resetApi();
  await feed(env, priv({ text: wrongAnswer(first.verify_answer) }));
  const after = await stateOf(env);
  t("attempt counted", after.verify_attempts === 1, JSON.stringify(after));
  t("still pending", after.verify_state === "pending");
  t("round not advanced", after.verify_step === 0);
  t("challenge refreshed", after.verify_nonce !== first.verify_nonce);
  // The notice is followed by the fresh question, so scan every message.
  t("remaining chances reported", said("还剩 1 次"));
  t("a fresh question is sent", said("= ?"));
}

section("answering faster than a human can is treated as automation");
{
  const env = await makeEnv({ minSeconds: "60" });
  await feed(env, priv({ text: "/start" }));
  const row = await stateOf(env);

  resetApi();
  await feed(env, priv({ text: row.verify_answer }));
  const after = await stateOf(env);
  t("not verified", after.verified_at === 0);
  t("attempt counted", after.verify_attempts === 1);
  t("reason explained", said("过快"));
}

section("/start refreshes the question without resetting progress or attempts");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  const first = await stateOf(env);
  await feed(env, priv({ text: wrongAnswer(first.verify_answer) }));

  await feed(env, priv({ text: "/start" }));
  const after = await stateOf(env);
  t("attempts preserved", after.verify_attempts === 1, JSON.stringify(after));
  t("still pending", after.verify_state === "pending");
  t("challenge replaced", after.verify_nonce !== first.verify_nonce);
}

section("an expired challenge restarts the cycle but keeps the strikes");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  const first = await stateOf(env);
  await feed(env, priv({ text: first.verify_answer }));
  await env.DB.prepare("UPDATE users SET verify_expires_at = 0 WHERE user_id = ?")
    .bind(STRANGER)
    .run();

  await feed(env, priv({ text: "/start" }));
  const after = await stateOf(env);
  t("round progress reset", after.verify_step === 0, JSON.stringify(after));
  t("attempts reset", after.verify_attempts === 0);
  t("fresh challenge pending", after.verify_state === "pending");
}

section("two failures trigger a cooldown");
{
  const env = await makeEnv();
  await feed(env, priv({ text: "/start" }));
  await feed(env, priv({ text: wrongAnswer((await stateOf(env)).verify_answer) }));
  resetApi();
  await feed(env, priv({ text: wrongAnswer((await stateOf(env)).verify_answer) }));

  const after = await stateOf(env);
  t("pending state cleared", after.verify_state === "");
  t("temp ban set", after.temp_banned_until > nowSec(), JSON.stringify(after));
  t("first cooldown is the base length", after.temp_banned_until - nowSec() <= 605);
  t("failure cycle counted", after.verify_strikes === 1);
  t("cooldown announced", String(last("sendMessage")?.args[1]).includes("临时限制"));

  resetApi();
  await feed(env, priv({ text: "/start" }));
  t("told to wait", String(last("sendMessage")?.args[1]).includes("秒后再试"));
  t("still nothing forwarded", methods("forwardMessage").length === 0);
}

section("a repeat offender waits longer");
{
  const env = await makeEnv();
  const burnCooldown = async () => {
    await feed(env, priv({ text: "/start" }));
    await feed(env, priv({ text: wrongAnswer((await stateOf(env)).verify_answer) }));
    await feed(env, priv({ text: wrongAnswer((await stateOf(env)).verify_answer) }));
    return stateOf(env);
  };

  const first = await burnCooldown();
  const firstSpan = first.temp_banned_until - nowSec();

  // Let the cooldown lapse without waiting for it.
  await env.DB.prepare("UPDATE users SET temp_banned_until = 0 WHERE user_id = ?")
    .bind(STRANGER)
    .run();

  const second = await burnCooldown();
  const secondSpan = second.temp_banned_until - nowSec();

  t("strike recorded", second.verify_strikes === 2, JSON.stringify(second));
  t("cooldown doubled", secondSpan > firstSpan * 1.8, `${firstSpan}s -> ${secondSpan}s`);
  t("doubling is capped at 24h", secondSpan <= 24 * 3600);
}

section("escalation can be switched off");
{
  const env = await makeEnv({ escalate: "0" });
  const burnCooldown = async () => {
    await feed(env, priv({ text: "/start" }));
    await feed(env, priv({ text: wrongAnswer((await stateOf(env)).verify_answer) }));
    await feed(env, priv({ text: wrongAnswer((await stateOf(env)).verify_answer) }));
    return stateOf(env);
  };

  const first = await burnCooldown();
  await env.DB.prepare("UPDATE users SET temp_banned_until = 0 WHERE user_id = ?")
    .bind(STRANGER)
    .run();
  const second = await burnCooldown();

  t("strikes still counted", second.verify_strikes === 2);
  t(
    "cooldown stays flat",
    Math.abs(second.temp_banned_until - first.temp_banned_until) < 10,
    `${first.temp_banned_until} vs ${second.temp_banned_until}`,
  );
}

section("a stranger sending a message with no challenge pending is asked to verify");
{
  const env = await makeEnv();
  resetApi();
  await feed(env, priv({ text: "买点东西吗" }));
  t("nothing forwarded", methods("forwardMessage").length === 0);
  t("challenge sent", String(last("sendMessage")?.args[1]).includes("= ?"));
  t("pending state stored", (await stateOf(env)).verify_state === "pending");
}

section("verified users fall back to the normal relay path");
{
  const env = await makeEnv();
  await env.DB.prepare(
    `INSERT INTO users (user_id,first_name,last_name,username,language_code,
                        first_seen,last_seen,msg_count,rl_window_start,
                        rl_window_count,blocked_bot,verified_at,verify_state,
                        verify_nonce,verify_answer,verify_expires_at,
                        verify_attempts,verify_step,verify_issued_at,
                        verify_strikes,temp_banned_until)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(STRANGER, "Stranger", "", null, null, 1, 1, 0, 0, 0, 0, 1, "", "", "", 0, 0, 0, 0, 0, 0).run();
  resetApi();
  await feed(env, priv({ text: "hello after verify" }));
  t("message forwarded", methods("forwardMessage").length === 1);
}

section("the feature can be turned off entirely");
{
  const env = await makeEnv();
  await setSetting(env, "human_verify_enabled", "0");
  resetApi();
  await feed(env, priv({ text: "hello" }));
  t("message forwarded", methods("forwardMessage").length === 1);
  t("no challenge sent", !String(last("sendMessage")?.args[1] ?? "").includes("= ?"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);