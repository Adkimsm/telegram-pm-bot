import { D1 } from "./shims/d1.js";
import { DONamespace } from "./shims/do.js";
import { CALLS, resetApi, GrammyError } from "./shims/grammy.js";
import { processUpdate } from "./.build/src/bot/index.js";
import { MediaGroupBuffer } from "./.build/src/lib/media-group.js";
import { loadSettings, setSetting } from "./.build/src/lib/settings.js";

const SCHEMA = new URL("../migrations/0001_init.sql", import.meta.url).pathname;
const OWNER = 111111;
const RELAY = -1001234567890;
const STRANGER = 555555;

let pass = 0, fail = 0;
const t = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const section = (s) => console.log(`\n### ${s}`);

async function makeEnv({ owner = OWNER, relay = RELAY, extra = {} } = {}) {
  const db = new D1(SCHEMA);
  const env = { BOT_TOKEN: "123456789:AAtesttesttesttesttesttesttesttest", DB: db };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  if (owner !== null) await setSetting(env, "owner_id", String(owner));
  if (relay !== null) await setSetting(env, "relay_chat_id", String(relay));
  for (const [k, v] of Object.entries(extra)) await setSetting(env, k, String(v));
  return env;
}

const ORIGIN = new URL("https://pmbot.example.workers.dev/tg/x");
let uid = 1;
const run = async (env, update) => {
  const settings = await loadSettings(env);
  await processUpdate(env, settings, { update_id: uid++, ...update }, ORIGIN, () => {});
};

const privMsg = (over = {}) => ({
  message: {
    message_id: over.message_id ?? 100,
    date: 1700000000,
    chat: { id: over.from_id ?? STRANGER, type: "private" },
    from: { id: over.from_id ?? STRANGER, is_bot: false, first_name: "Stranger", ...over.from },
    ...over,
  },
});
const groupMsg = (over = {}) => ({
  message: {
    message_id: over.message_id ?? 200,
    date: 1700000000,
    chat: { id: RELAY, type: "supergroup", title: "Relay", is_forum: true },
    from: { id: over.from_id ?? OWNER, is_bot: false, first_name: "Owner" },
    ...over,
  },
});
const called = (m) => CALLS.filter((c) => c.method === m);
const lastCall = (m) => called(m).at(-1);

// ---------------------------------------------------------------------------
section("inbound: first contact creates topic + info card, then forwards");
{
  const env = await makeEnv();
  resetApi();
  await run(env, privMsg({ text: "hello there" }));

  t("createForumTopic called", called("createForumTopic").length === 1);
  const topicName = called("createForumTopic")[0]?.args[1];
  t("topic named after user", /Stranger/.test(topicName ?? ""), topicName);

  const card = called("sendMessage").find((c) => String(c.args[1]).includes("<code>"));
  t("info card sent", !!card);
  t("card in the new topic", card?.args[2]?.message_thread_id !== undefined);
  t("card has inline keyboard", !!card?.args[2]?.reply_markup?.inline_keyboard);

  const fwd = lastCall("forwardMessage");
  t("forwardMessage used (default mode)", !!fwd);
  t("forwarded to relay chat", fwd?.args[0] === RELAY);
  t("forwarded into the topic", typeof fwd?.args[3]?.message_thread_id === "number");

  const map = await env.DB.prepare("SELECT * FROM msg_map").all();
  t("mapping stored", map.results.length === 1);
  t("mapping direction=in", map.results[0]?.direction === "in");
  t("mapping links user msg", map.results[0]?.user_msg_id === 100);

  const topics = await env.DB.prepare("SELECT * FROM topics").all();
  t("topic persisted", topics.results.length === 1 && topics.results[0].user_id === STRANGER);
}

section("inbound: second message reuses the topic, no second card");
{
  const env = await makeEnv();
  resetApi();
  await run(env, privMsg({ text: "one", message_id: 100 }));
  const topicsAfterFirst = called("createForumTopic").length;
  resetApi();
  await run(env, privMsg({ text: "two", message_id: 101 }));
  t("no new topic", called("createForumTopic").length === 0, `first pass made ${topicsAfterFirst}`);
  t("no second info card", called("sendMessage").length === 0);
  t("forwarded again", called("forwardMessage").length === 1);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM msg_map").first();
  t("two mappings", n.n === 2);
}

section("inbound: /start replies with welcome text and is NOT relayed");
{
  const env = await makeEnv({ extra: { welcome_text: "Hi, send me a message." } });
  resetApi();
  await run(env, privMsg({ text: "/start" }));
  t("welcome sent", lastCall("sendMessage")?.args[1] === "Hi, send me a message.");
  t("not forwarded", called("forwardMessage").length === 0);
  t("no topic created", called("createForumTopic").length === 0);
  const u = await env.DB.prepare("SELECT * FROM users WHERE user_id=?").bind(STRANGER).first();
  t("user recorded anyway", u?.user_id === STRANGER);
}

section("inbound: banned users are dropped silently");
{
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO bans (user_id,reason,banned_at) VALUES (?,?,?)").bind(STRANGER, "spam", 1).run();
  resetApi();
  await run(env, privMsg({ text: "let me in" }));
  t("nothing forwarded", called("forwardMessage").length === 0);
  t("nothing sent to the user", called("sendMessage").length === 0);
  resetApi();
  await run(env, privMsg({ text: "/start" }));
  t("/start also silent for banned", CALLS.length === 0, JSON.stringify(CALLS.map(c=>c.method)));
}

section("dedup: the same update_id is processed once");
{
  const env = await makeEnv();
  resetApi();
  const settings = await loadSettings(env);
  const upd = { update_id: 9999, ...privMsg({ text: "dup" }) };
  await processUpdate(env, settings, upd, ORIGIN, () => {});
  await processUpdate(env, settings, upd, ORIGIN, () => {});
  t("forwarded exactly once", called("forwardMessage").length === 1);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM msg_map").first();
  t("one mapping only", n.n === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
