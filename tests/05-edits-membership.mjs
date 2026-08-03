import { D1 } from "./shims/d1.js";
import { DONamespace } from "./shims/do.js";
import { CALLS, resetApi, GrammyError } from "./shims/grammy.js";
import { processUpdate } from "./.build/src/bot/index.js";
import { MediaGroupBuffer } from "./.build/src/lib/media-group.js";
import { loadSettings, setSetting } from "./.build/src/lib/settings.js";

const SCHEMA = new URL("../migrations/0001_init.sql", import.meta.url).pathname;
const TOKEN = "123456789:AAtesttesttesttesttesttesttesttest";
const OWNER = 111111, RELAY = -1001234567890, STRANGER = 555555, THREAD = 42;

let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const section = (s) => console.log(`\n### ${s}`);

async function makeEnv({ relay = RELAY, extra = {} } = {}) {
  const db = new D1(SCHEMA);
  const env = { BOT_TOKEN: TOKEN, DB: db };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  await setSetting(env, "owner_id", String(OWNER));
  if (relay !== null) await setSetting(env, "relay_chat_id", String(relay));
  for (const [k, v] of Object.entries(extra)) await setSetting(env, k, String(v));
  await db.prepare("INSERT INTO users (user_id,first_name,last_name,username,language_code,first_seen,last_seen,msg_count,rl_window_start,rl_window_count,blocked_bot) VALUES (?,?,?,?,?,?,?,?,?,?,0)")
    .bind(STRANGER, "Stranger", "", "stranger", "en", 1, 1, 3, 0, 0).run();
  await db.prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)").bind(STRANGER, RELAY, THREAD, 1).run();
  await db.prepare("INSERT INTO msg_map (relay_chat_id,relay_msg_id,user_id,user_msg_id,direction,media_group_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(RELAY, 500, STRANGER, 77, "in", null, 1).run();
  await db.prepare("INSERT INTO msg_map (relay_chat_id,relay_msg_id,user_id,user_msg_id,direction,media_group_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(RELAY, 501, STRANGER, 88, "out", null, 1).run();
  return env;
}
const ORIGIN = new URL("https://pmbot.example.workers.dev/tg/x");
let uid = 1;
const run = async (env, u) => {
  const s = await loadSettings(env);
  await processUpdate(env, s, { update_id: uid++, ...u }, ORIGIN, () => {});
};
const called = (m) => CALLS.filter((c) => c.method === m);
const last = (m) => called(m).at(-1);

section("edit sync: stranger edits -> relay copy is edited");
{
  const env = await makeEnv();
  resetApi();
  await run(env, { edited_message: { message_id: 77, date: 1, edit_date: 2,
    chat: { id: STRANGER, type: "private" }, from: { id: STRANGER, is_bot: false, first_name: "S" },
    text: "corrected text" } });
  const e = last("editMessageText");
  t("editMessageText called", !!e);
  t("edited in the relay group", e?.args[0] === RELAY);
  t("edited the mapped relay message", e?.args[1] === 500);
  t("new text passed through", e?.args[2] === "corrected text");
}

section("edit sync: owner edits -> stranger's copy is edited");
{
  const env = await makeEnv();
  resetApi();
  await run(env, { edited_message: { message_id: 501, date: 1, edit_date: 2,
    chat: { id: RELAY, type: "supergroup" }, from: { id: OWNER, is_bot: false, first_name: "O" },
    text: "revised answer" } });
  const e = last("editMessageText");
  t("edited on the stranger side", e?.args[0] === STRANGER);
  t("edited the mapped user message", e?.args[1] === 88);
}

section("edit sync: caption edits use editMessageCaption");
{
  const env = await makeEnv();
  resetApi();
  await run(env, { edited_message: { message_id: 77, date: 1, edit_date: 2,
    chat: { id: STRANGER, type: "private" }, from: { id: STRANGER, is_bot: false, first_name: "S" },
    photo: [{ file_id: "p" }], caption: "new caption" } });
  t("editMessageCaption called", called("editMessageCaption").length === 1);
  t("editMessageText not called", called("editMessageText").length === 0);
  t("caption passed", last("editMessageCaption")?.args[2]?.caption === "new caption");
}

section("edit sync: unmapped edits are ignored");
{
  const env = await makeEnv();
  resetApi();
  await run(env, { edited_message: { message_id: 4242, date: 1, edit_date: 2,
    chat: { id: STRANGER, type: "private" }, from: { id: STRANGER, is_bot: false, first_name: "S" },
    text: "who am I" } });
  t("nothing edited", called("editMessageText").length === 0);
}

section("edit sync disabled");
{
  const env = await makeEnv({ extra: { sync_edits: "0" } });
  resetApi();
  await run(env, { edited_message: { message_id: 77, date: 1, edit_date: 2,
    chat: { id: STRANGER, type: "private" }, from: { id: STRANGER, is_bot: false, first_name: "S" },
    text: "x" } });
  t("no edit propagated", called("editMessageText").length === 0);
}

section("my_chat_member: user blocks the bot");
{
  const env = await makeEnv();
  resetApi();
  await run(env, { my_chat_member: { chat: { id: STRANGER, type: "private" },
    from: { id: STRANGER, is_bot: false, first_name: "S" }, date: 1,
    old_chat_member: { status: "member", user: { id: 777, is_bot: true, first_name: "bot" } },
    new_chat_member: { status: "kicked", user: { id: 777, is_bot: true, first_name: "bot" }, until_date: 0 } } });
  const u = await env.DB.prepare("SELECT blocked_bot FROM users WHERE user_id=?").bind(STRANGER).first();
  t("blocked_bot set", u?.blocked_bot === 1);
  t("owner notified", called("sendMessage").some((c) => c.args[0] === OWNER && String(c.args[1]).includes("blocked")));
}

section("my_chat_member: user unblocks");
{
  const env = await makeEnv();
  await env.DB.prepare("UPDATE users SET blocked_bot=1 WHERE user_id=?").bind(STRANGER).run();
  resetApi();
  await run(env, { my_chat_member: { chat: { id: STRANGER, type: "private" },
    from: { id: STRANGER, is_bot: false, first_name: "S" }, date: 1,
    old_chat_member: { status: "kicked", user: { id: 777, is_bot: true, first_name: "bot" } },
    new_chat_member: { status: "member", user: { id: 777, is_bot: true, first_name: "bot" } } } });
  const u = await env.DB.prepare("SELECT blocked_bot FROM users WHERE user_id=?").bind(STRANGER).first();
  t("blocked_bot cleared", u?.blocked_bot === 0);
}

section("my_chat_member: added to a forum group as admin -> bindable candidate");
{
  const env = await makeEnv({ relay: null });
  resetApi();
  await run(env, { my_chat_member: { chat: { id: -100777, type: "supergroup", title: "Support", is_forum: true },
    from: { id: OWNER, is_bot: false, first_name: "O" }, date: 1,
    old_chat_member: { status: "left", user: { id: 777, is_bot: true, first_name: "bot" } },
    new_chat_member: { status: "administrator", user: { id: 777, is_bot: true, first_name: "bot" },
      can_manage_topics: true, can_be_edited: false, is_anonymous: false, can_manage_chat: true,
      can_delete_messages: true, can_manage_video_chats: true, can_restrict_members: true,
      can_promote_members: false, can_change_info: true, can_invite_users: true } } });
  const c = await env.DB.prepare("SELECT * FROM candidate_chats WHERE chat_id=?").bind(-100777).first();
  t("candidate recorded", !!c);
  t("title captured", c?.title === "Support");
  t("is_forum captured", c?.is_forum === 1);
  t("can_manage_topics captured", c?.can_manage_topics === 1);
  t("owner told it is ready", called("sendMessage").some((x) => String(x.args[1]).includes("Ready to bind")));
}

section("my_chat_member: forum group but no topic permission");
{
  const env = await makeEnv({ relay: null });
  resetApi();
  await run(env, { my_chat_member: { chat: { id: -100778, type: "supergroup", title: "NoPerm", is_forum: true },
    from: { id: OWNER, is_bot: false, first_name: "O" }, date: 1,
    old_chat_member: { status: "left", user: { id: 777, is_bot: true, first_name: "bot" } },
    new_chat_member: { status: "member", user: { id: 777, is_bot: true, first_name: "bot" } } } });
  const c = await env.DB.prepare("SELECT * FROM candidate_chats WHERE chat_id=?").bind(-100778).first();
  t("recorded but not eligible", c?.can_manage_topics === 0);
  t("owner told to grant the permission", called("sendMessage").some((x) => String(x.args[1]).includes("Manage topics")));
}

section("my_chat_member: non-forum group");
{
  const env = await makeEnv({ relay: null });
  resetApi();
  await run(env, { my_chat_member: { chat: { id: -100779, type: "group", title: "Plain" },
    from: { id: OWNER, is_bot: false, first_name: "O" }, date: 1,
    old_chat_member: { status: "left", user: { id: 777, is_bot: true, first_name: "bot" } },
    new_chat_member: { status: "administrator", user: { id: 777, is_bot: true, first_name: "bot" },
      can_manage_topics: false, can_be_edited: false, is_anonymous: false, can_manage_chat: true,
      can_delete_messages: true, can_manage_video_chats: true, can_restrict_members: true,
      can_promote_members: false, can_change_info: true, can_invite_users: true } } });
  const c = await env.DB.prepare("SELECT * FROM candidate_chats WHERE chat_id=?").bind(-100779).first();
  t("is_forum=0", c?.is_forum === 0);
  t("owner told to enable Topics", called("sendMessage").some((x) => String(x.args[1]).includes("Topics enabled")));
}

section("my_chat_member: removed from a group clears the candidate");
{
  const env = await makeEnv({ relay: null });
  await env.DB.prepare("INSERT INTO candidate_chats (chat_id,title,type,is_forum,can_manage_topics,seen_at) VALUES (?,?,?,?,?,?)")
    .bind(-100780, "Gone", "supergroup", 1, 1, 1).run();
  resetApi();
  await run(env, { my_chat_member: { chat: { id: -100780, type: "supergroup", title: "Gone", is_forum: true },
    from: { id: OWNER, is_bot: false, first_name: "O" }, date: 1,
    old_chat_member: { status: "administrator", user: { id: 777, is_bot: true, first_name: "bot" }, can_manage_topics: true, can_be_edited: false, is_anonymous: false, can_manage_chat: true, can_delete_messages: true, can_manage_video_chats: true, can_restrict_members: true, can_promote_members: false, can_change_info: true, can_invite_users: true },
    new_chat_member: { status: "left", user: { id: 777, is_bot: true, first_name: "bot" } } } });
  t("candidate removed", (await env.DB.prepare("SELECT COUNT(*) AS n FROM candidate_chats WHERE chat_id=?").bind(-100780).first()).n === 0);
}

section("topic vanished: relay recreates it and retries");
{
  const env = await makeEnv();
  let attempts = 0;
  resetApi({
    forwardMessage: (chat, from, id, opts) => {
      attempts++;
      if (attempts === 1) throw new GrammyError("Bad Request: message thread not found", 400);
      return { message_id: 7777 };
    },
  });
  await run(env, { message: { message_id: 1400, date: 1, chat: { id: STRANGER, type: "private" },
    from: { id: STRANGER, is_bot: false, first_name: "Stranger" }, text: "after topic deletion" } });
  t("retried once", attempts === 2, `attempts=${attempts}`);
  t("new topic created", called("createForumTopic").length === 1);
  const topic = await env.DB.prepare("SELECT thread_id FROM topics WHERE user_id=?").bind(STRANGER).first();
  t("topic row updated", topic?.thread_id !== THREAD, `thread=${topic?.thread_id}`);
  t("message eventually delivered and mapped", (await env.DB.prepare("SELECT * FROM msg_map WHERE relay_msg_id=7777").first()) !== null);
}

section("topic creation fails: falls back to General, warns the operator");
{
  const env = await makeEnv();
  await env.DB.prepare("DELETE FROM topics").run();
  resetApi({ createForumTopic: () => { throw new GrammyError("Bad Request: not enough rights to manage topics", 400); } });
  await run(env, { message: { message_id: 1500, date: 1, chat: { id: STRANGER, type: "private" },
    from: { id: STRANGER, is_bot: false, first_name: "Stranger" }, text: "still needs to arrive" } });
  t("operator warned", called("sendMessage").some((c) => String(c.args[1]).includes("Could not create a topic")));
  const fwd = last("forwardMessage");
  t("still forwarded", !!fwd);
  t("no thread id (General topic)", fwd?.args[3]?.message_thread_id === undefined);
}

section("unconfigured relay: owner is told once");
{
  const env = await makeEnv({ relay: null });
  await env.DB.prepare("DELETE FROM users").run();
  resetApi();
  await run(env, { message: { message_id: 1600, date: 1, chat: { id: 424242, type: "private" },
    from: { id: 424242, is_bot: false, first_name: "New" }, text: "hello" } });
  t("nothing forwarded", called("forwardMessage").length === 0);
  t("owner warned", called("sendMessage").some((c) => c.args[0] === OWNER && String(c.args[1]).includes("no relay group")));
}

section("service messages are not relayed");
{
  const env = await makeEnv();
  resetApi();
  await run(env, { message: { message_id: 1700, date: 1, chat: { id: RELAY, type: "supergroup", is_forum: true },
    from: { id: OWNER, is_bot: false, first_name: "O" }, message_thread_id: 55,
    forum_topic_created: { name: "New topic", icon_color: 7322096 } } });
  t("topic-created service message ignored", called("copyMessage").length === 0);
  resetApi();
  await run(env, { message: { message_id: 1701, date: 1, chat: { id: RELAY, type: "supergroup", is_forum: true },
    from: { id: OWNER, is_bot: false, first_name: "O" }, message_thread_id: THREAD,
    pinned_message: { message_id: 1, date: 1, chat: { id: RELAY, type: "supergroup" } } } });
  t("pinned service message ignored", called("copyMessage").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
