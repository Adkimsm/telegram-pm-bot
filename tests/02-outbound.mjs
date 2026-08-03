import { D1 } from "./shims/d1.js";
import { DONamespace } from "./shims/do.js";
import { CALLS, resetApi, GrammyError } from "./shims/grammy.js";
import { processUpdate } from "./.build/src/bot/index.js";
import { MediaGroupBuffer } from "./.build/src/lib/media-group.js";
import { loadSettings, setSetting } from "./.build/src/lib/settings.js";

const SCHEMA = new URL("../migrations/0001_init.sql", import.meta.url).pathname;
const OWNER = 111111, RELAY = -1001234567890, STRANGER = 555555, THREAD = 42;

let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const section = (s) => console.log(`\n### ${s}`);

async function makeEnv(extra = {}) {
  const db = new D1(SCHEMA);
  const env = { BOT_TOKEN: "123456789:AAtesttesttesttesttesttesttesttest", DB: db };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  await setSetting(env, "owner_id", String(OWNER));
  await setSetting(env, "relay_chat_id", String(RELAY));
  for (const [k, v] of Object.entries(extra)) await setSetting(env, k, String(v));
  // Pre-existing conversation.
  await db.prepare("INSERT INTO users (user_id,first_name,last_name,username,language_code,first_seen,last_seen,msg_count,rl_window_start,rl_window_count,blocked_bot) VALUES (?,?,?,?,?,?,?,?,?,?,0)")
    .bind(STRANGER, "Stranger", "", "stranger", "en", 1, 1, 3, 0, 0).run();
  await db.prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)").bind(STRANGER, RELAY, THREAD, 1).run();
  return env;
}
const ORIGIN = new URL("https://pmbot.example.workers.dev/tg/x");
let uid = 1;
const run = async (env, u) => {
  const s = await loadSettings(env);
  await processUpdate(env, s, { update_id: uid++, ...u }, ORIGIN, () => {});
};
const groupMsg = (o = {}) => ({
  message: {
    message_id: o.message_id ?? 200, date: 1700000000,
    chat: { id: o.chat_id ?? RELAY, type: "supergroup", title: "Relay", is_forum: true },
    from: { id: o.from_id ?? OWNER, is_bot: false, first_name: "Owner" },
    message_thread_id: o.message_thread_id === null ? undefined : (o.message_thread_id ?? THREAD),
    ...o,
  },
});
const called = (m) => CALLS.filter((c) => c.method === m);
const last = (m) => called(m).at(-1);

section("outbound: owner reply reaches the stranger via copyMessage");
{
  const env = await makeEnv();
  resetApi();
  await run(env, groupMsg({ text: "sure, happy to help" }));
  const cp = last("copyMessage");
  t("copyMessage used", !!cp);
  // The critical property: forwarding would show "Forwarded from <relay group>"
  // to the stranger, leaking the group name and the whole architecture.
  t("forwardMessage NOT used", called("forwardMessage").length === 0);
  t("delivered to the stranger", cp?.args[0] === STRANGER);
  t("copied from the relay group", cp?.args[1] === RELAY);
  t("no message_thread_id leaked outbound", cp?.args[3]?.message_thread_id === undefined);
  const m = await env.DB.prepare("SELECT * FROM msg_map WHERE direction='out'").first();
  t("outbound mapping stored", m?.user_id === STRANGER);
}

section("outbound: replying to a relayed message mirrors the quote");
{
  const env = await makeEnv();
  // A prior inbound relay: stranger msg 77 -> relay msg 500.
  await env.DB.prepare("INSERT INTO msg_map (relay_chat_id,relay_msg_id,user_id,user_msg_id,direction,media_group_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(RELAY, 500, STRANGER, 77, "in", null, 1).run();
  resetApi();
  await run(env, groupMsg({
    text: "answering that",
    reply_to_message: { message_id: 500, date: 1, chat: { id: RELAY, type: "supergroup" } },
  }));
  const cp = last("copyMessage");
  t("reply_parameters set", cp?.args[3]?.reply_parameters?.message_id === 77,
    JSON.stringify(cp?.args[3]));
}

section("outbound: stale reply target falls back to a plain send");
{
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO msg_map (relay_chat_id,relay_msg_id,user_id,user_msg_id,direction,media_group_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(RELAY, 500, STRANGER, 77, "in", null, 1).run();
  let attempt = 0;
  resetApi({
    copyMessage: (chat, from, id, opts) => {
      attempt++;
      // allow_sending_without_reply is always False for cross-chat replies, so
      // Telegram hard-fails instead of degrading. First call must fail.
      if (opts?.reply_parameters) throw new GrammyError("Bad Request: message to be replied not found", 400);
      return { message_id: 6001 };
    },
  });
  await run(env, groupMsg({
    text: "still send this",
    reply_to_message: { message_id: 500, date: 1, chat: { id: RELAY, type: "supergroup" } },
  }));
  t("retried without the reply", attempt === 2, `attempts=${attempt}`);
  t("second attempt had no reply_parameters", called("copyMessage")[1]?.args[3]?.reply_parameters === undefined);
  const m = await env.DB.prepare("SELECT * FROM msg_map WHERE direction='out'").first();
  t("message still delivered and mapped", m?.user_msg_id === 6001);
}

section("outbound: blocked user is recorded and the owner is told");
{
  const env = await makeEnv();
  resetApi({ copyMessage: () => { throw new GrammyError("Forbidden: bot was blocked by the user", 403); } });
  await run(env, groupMsg({ text: "hello?" }));
  const u = await env.DB.prepare("SELECT blocked_bot FROM users WHERE user_id=?").bind(STRANGER).first();
  t("blocked_bot flag set", u?.blocked_bot === 1);
  const notice = called("sendMessage").find((c) => String(c.args[1]).includes("blocked"));
  t("failure reported in the topic", !!notice);
  t("notice replies to the failed message", notice?.args[2]?.reply_parameters?.message_id === 200);
  // Silent failure would be the worst outcome: the operator would believe they
  // had answered someone when they had not.
  t("no outbound mapping recorded", (await env.DB.prepare("SELECT COUNT(*) AS n FROM msg_map WHERE direction='out'").first()).n === 0);
}

section("outbound: General topic (no thread id) is never delivered");
{
  const env = await makeEnv();
  resetApi();
  await run(env, groupMsg({ text: "a note to self", message_thread_id: null }));
  t("nothing copied", called("copyMessage").length === 0);
}

section("outbound: unknown thread id is ignored");
{
  const env = await makeEnv();
  resetApi();
  await run(env, groupMsg({ text: "orphan topic", message_thread_id: 999 }));
  t("nothing copied", called("copyMessage").length === 0);
}

section("outbound: messages in other groups are ignored");
{
  const env = await makeEnv();
  resetApi();
  await run(env, groupMsg({ chat_id: -100999, text: "unrelated group" }));
  t("nothing copied", called("copyMessage").length === 0);
}

section("outbound: the bot's own messages do not echo");
{
  const env = await makeEnv();
  resetApi();
  await run(env, { message: { message_id: 300, date: 1, chat: { id: RELAY, type: "supergroup" },
    from: { id: 777, is_bot: true, first_name: "Test" }, message_thread_id: THREAD, text: "bot output" } });
  t("nothing copied", called("copyMessage").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
