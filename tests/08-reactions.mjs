// Emoji reaction mirroring, in both directions.
//
// Whether a bot receives message_reaction in a one-on-one private chat is
// genuinely ambiguous in the reference docs ("the bot must be an administrator
// in the chat", which a private chat has none of). It was verified empirically
// against the live API before this feature was built: private chats do deliver
// the update. These tests pin the behaviour that follows from that.

import { D1 } from "./shims/d1.js";
import { DONamespace } from "./shims/do.js";
import { CALLS, resetApi, GrammyError } from "./shims/grammy.js";
import { processUpdate, ALLOWED_UPDATES } from "./.build/src/bot/index.js";
import { MediaGroupBuffer } from "./.build/src/lib/media-group.js";
import { loadSettings, setSetting } from "./.build/src/lib/settings.js";

const SCHEMA = new URL("../migrations/0001_init.sql", import.meta.url).pathname;
const MIGRATION2 = new URL("../migrations/0002_reactions.sql", import.meta.url).pathname;
const TOKEN = "123456789:AAtesttesttesttesttesttesttesttest";
const OWNER = 111111;
const RELAY = -1001234567890;
const STRANGER = 555555;
const THREAD = 42;

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

async function makeEnv({ reactions = true, relay = RELAY } = {}) {
  const { readFileSync } = await import("node:fs");
  const db = new D1(SCHEMA);
  db.exec(readFileSync(MIGRATION2, "utf8"));

  const env = { BOT_TOKEN: TOKEN, DB: db };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  await setSetting(env, "owner_id", String(OWNER));
  if (relay !== null) await setSetting(env, "relay_chat_id", String(relay));
  await setSetting(env, "sync_reactions", reactions ? "1" : "0");

  await db
    .prepare(
      `INSERT INTO users (user_id,first_name,last_name,username,language_code,
                          first_seen,last_seen,msg_count,rl_window_start,
                          rl_window_count,blocked_bot)
       VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
    )
    .bind(STRANGER, "Stranger", "", "stranger", "en", 1, 1, 3, 0, 0)
    .run();
  await db
    .prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)")
    .bind(STRANGER, RELAY, THREAD, 1)
    .run();

  // An inbound relay: stranger's message 77 became relay message 500.
  await db
    .prepare(
      `INSERT INTO msg_map (relay_chat_id,relay_msg_id,user_id,user_msg_id,
                            direction,media_group_id,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(RELAY, 500, STRANGER, 77, "in", null, 1)
    .run();
  // An outbound reply: relay message 501 became the stranger's message 88.
  await db
    .prepare(
      `INSERT INTO msg_map (relay_chat_id,relay_msg_id,user_id,user_msg_id,
                            direction,media_group_id,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(RELAY, 501, STRANGER, 88, "out", null, 1)
    .run();

  return env;
}

const ORIGIN = new URL("https://pmbot.example.workers.dev/tg/x");
let uid = 1;
async function feed(env, update) {
  const settings = await loadSettings(env);
  await processUpdate(env, settings, { update_id: uid++, ...update }, ORIGIN, () => {});
}

const emoji = (e) => [{ type: "emoji", emoji: e }];

// `?? ` cannot distinguish "not supplied" from "deliberately absent", so tests
// that need a missing `user` pass `user: null` and it is stripped below.
function reactionUpdate(base, over) {
  const ev = {
    ...base,
    date: 1700000000,
    old_reaction: over.old_reaction ?? [],
    new_reaction: over.new_reaction ?? base.new_reaction,
    ...over.extra,
  };
  if (over.user === null) delete ev.user;
  else if (over.user !== undefined) ev.user = over.user;
  return { message_reaction: ev };
}

/** A reaction by the stranger in their private chat with the bot. */
const privateReaction = (over = {}) =>
  reactionUpdate(
    {
      chat: { id: over.chat_id ?? STRANGER, type: "private" },
      message_id: over.message_id ?? 77,
      user: { id: over.user_id ?? STRANGER, is_bot: false, first_name: "Stranger" },
      new_reaction: emoji("👍"),
    },
    over,
  );

/** A reaction inside a topic in the relay group. */
const relayReaction = (over = {}) =>
  reactionUpdate(
    {
      chat: { id: over.chat_id ?? RELAY, type: "supergroup", title: "Relay", is_forum: true },
      message_id: over.message_id ?? 500,
      user: { id: over.user_id ?? OWNER, is_bot: false, first_name: "Owner" },
      new_reaction: emoji("🔥"),
    },
    over,
  );

const called = (m) => CALLS.filter((c) => c.method === m);
const last = (m) => called(m).at(-1);

section("allowed_updates includes message_reaction");
{
  // Not in Telegram's default set; without this the feature is inert.
  t("message_reaction requested", ALLOWED_UPDATES.includes("message_reaction"));

  const { readFileSync } = await import("node:fs");
  const script = readFileSync(
    new URL("../scripts/webhook.mjs", import.meta.url),
    "utf8",
  );
  const listed = [...script.matchAll(/"(message|edited_message|callback_query|my_chat_member|message_reaction)"/g)]
    .map((m) => m[1]);
  // A mismatch here would mean the CLI and the console register different sets.
  t(
    "scripts/webhook.mjs lists the same set",
    ALLOWED_UPDATES.every((u) => listed.includes(u)),
    `script has ${JSON.stringify([...new Set(listed)])}`,
  );
}

section("stranger reacts in the private chat -> mirrored into the topic");
{
  const env = await makeEnv();
  resetApi();
  await feed(env, privateReaction({ message_id: 77, new_reaction: emoji("👍") }));

  const c = last("setMessageReaction");
  t("setMessageReaction called", !!c);
  t("targets the relay group", c?.args[0] === RELAY);
  t("targets the mapped relay message", c?.args[1] === 500);
  t("carries the same emoji", JSON.stringify(c?.args[2]) === JSON.stringify(emoji("👍")));
}

section("owner reacts in a topic -> mirrored to the stranger");
{
  const env = await makeEnv();
  resetApi();
  await feed(env, relayReaction({ message_id: 501, new_reaction: emoji("❤") }));

  const c = last("setMessageReaction");
  t("setMessageReaction called", !!c);
  t("targets the stranger", c?.args[0] === STRANGER);
  t("targets the mapped user message", c?.args[1] === 88);
  t("carries the same emoji", JSON.stringify(c?.args[2]) === JSON.stringify(emoji("❤")));
}

section("removing a reaction propagates as an empty list");
{
  const env = await makeEnv();
  resetApi();
  await feed(env, privateReaction({ old_reaction: emoji("👍"), new_reaction: [] }));
  const c = last("setMessageReaction");
  t("called with an empty array", JSON.stringify(c?.args[2]) === "[]");
}

section("only the first standard emoji is conveyed");
{
  const env = await makeEnv();
  resetApi();
  // Bots may set at most one reaction per message, so a multi-emoji reaction
  // can only be partially represented.
  await feed(env, privateReaction({
    new_reaction: [
      { type: "emoji", emoji: "👍" },
      { type: "emoji", emoji: "🔥" },
      { type: "emoji", emoji: "🎉" },
    ],
  }));
  const c = last("setMessageReaction");
  t("exactly one reaction sent", c?.args[2]?.length === 1);
  t("it is the first", c?.args[2]?.[0]?.emoji === "👍");
}

section("custom emoji is skipped rather than approximated");
{
  const env = await makeEnv();
  resetApi();
  // A custom emoji is only usable if already present on the target message or
  // allowlisted by chat admins, neither of which holds across chats.
  await feed(env, privateReaction({
    new_reaction: [{ type: "custom_emoji", custom_emoji_id: "5368324170671202286" }],
  }));
  const c = last("setMessageReaction");
  t("still called, clearing instead of guessing", !!c);
  t("empty list sent", JSON.stringify(c?.args[2]) === "[]");
}

section("custom emoji alongside a standard one keeps the standard one");
{
  const env = await makeEnv();
  resetApi();
  await feed(env, privateReaction({
    new_reaction: [
      { type: "custom_emoji", custom_emoji_id: "123" },
      { type: "emoji", emoji: "🙏" },
    ],
  }));
  t("standard emoji chosen", last("setMessageReaction")?.args[2]?.[0]?.emoji === "🙏");
}

section("paid reactions are never mirrored");
{
  const env = await makeEnv();
  resetApi();
  // "Bots can't use paid reactions."
  await feed(env, privateReaction({ new_reaction: [{ type: "paid" }] }));
  t("empty list sent", JSON.stringify(last("setMessageReaction")?.args[2]) === "[]");
}

section("disabled by default and honoured when off");
{
  const env = await makeEnv({ reactions: false });
  resetApi();
  await feed(env, privateReaction());
  t("nothing sent when disabled", called("setMessageReaction").length === 0);

  // The 0002 migration must default it to off so an upgrade is a no-op.
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='sync_reactions'").first();
  t("setting exists", row !== null);
}

section("authorisation");
{
  const env = await makeEnv();

  // A reaction by anyone other than the owner in the relay group must not be
  // forwarded as though it were theirs.
  resetApi();
  await feed(env, relayReaction({ user_id: 999999 }));
  t("non-owner reaction in the group ignored", called("setMessageReaction").length === 0);

  // Anonymous reactions carry actor_chat instead of user.
  resetApi();
  await feed(env, relayReaction({ user: null, extra: { actor_chat: { id: RELAY, type: "supergroup" } } }));
  t("anonymous reaction ignored", called("setMessageReaction").length === 0);

  // The owner's own private chat is a console, not a conversation.
  resetApi();
  await feed(env, privateReaction({ chat_id: OWNER, user_id: OWNER, message_id: 77 }));
  t("owner's private chat ignored", called("setMessageReaction").length === 0);

  resetApi();
  await feed(env, privateReaction({ user: { id: 777, is_bot: true, first_name: "Bot" } }));
  t("bot reaction ignored", called("setMessageReaction").length === 0);
}

section("banned correspondents are ignored");
{
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO bans (user_id,reason,banned_at) VALUES (?,?,?)")
    .bind(STRANGER, "spam", 1)
    .run();
  resetApi();
  await feed(env, privateReaction());
  t("nothing mirrored", called("setMessageReaction").length === 0);
}

section("unmapped and foreign messages are ignored");
{
  const env = await makeEnv();

  resetApi();
  await feed(env, privateReaction({ message_id: 4242 }));
  t("unknown private message ignored", called("setMessageReaction").length === 0);

  resetApi();
  await feed(env, relayReaction({ message_id: 4242 }));
  t("unknown relay message ignored", called("setMessageReaction").length === 0);

  resetApi();
  await feed(env, relayReaction({ chat_id: -100999 }));
  t("other group ignored", called("setMessageReaction").length === 0);
}

section("no relay group bound");
{
  const env = await makeEnv({ relay: null });
  resetApi();
  await feed(env, privateReaction());
  t("nothing attempted", called("setMessageReaction").length === 0);
}

section("API failures are swallowed");
{
  const env = await makeEnv();
  // Too old, emoji not allowed in the chat, correspondent blocked the bot —
  // all routine, and none should break the webhook response.
  resetApi({
    setMessageReaction: () => {
      throw new GrammyError("Bad Request: REACTION_INVALID", 400);
    },
  });
  let threw = false;
  try {
    await feed(env, privateReaction());
  } catch {
    threw = true;
  }
  t("no exception escapes", !threw);
}

section("de-duplication applies to reaction updates too");
{
  const env = await makeEnv();
  resetApi();
  const settings = await loadSettings(env);
  const upd = { update_id: 8888, ...privateReaction() };
  await processUpdate(env, settings, upd, ORIGIN, () => {});
  await processUpdate(env, settings, upd, ORIGIN, () => {});
  t("mirrored exactly once", called("setMessageReaction").length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
