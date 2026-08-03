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

async function makeEnv(extra = {}) {
  const db = new D1(SCHEMA);
  const env = { BOT_TOKEN: TOKEN, DB: db };
  env.MEDIA_GROUP = new DONamespace(MediaGroupBuffer, env);
  await setSetting(env, "owner_id", String(OWNER));
  await setSetting(env, "relay_chat_id", String(RELAY));
  for (const [k, v] of Object.entries(extra)) await setSetting(env, k, String(v));
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
const priv = (o = {}) => ({ message: { message_id: o.message_id ?? 100, date: 1, chat: { id: STRANGER, type: "private" }, from: { id: STRANGER, is_bot: false, first_name: "Stranger" }, ...o } });
const grp = (o = {}) => ({ message: { message_id: o.message_id ?? 200, date: 1, chat: { id: RELAY, type: "supergroup", title: "Relay", is_forum: true }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, message_thread_id: o.message_thread_id === null ? undefined : (o.message_thread_id ?? THREAD), ...o } });
const called = (m) => CALLS.filter((c) => c.method === m);
const last = (m) => called(m).at(-1);

section("media group inbound: buffered, then flushed as one album");
{
  const env = await makeEnv();
  resetApi();
  // Telegram delivers each album item as its own update.
  for (let i = 0; i < 3; i++) {
    await run(env, priv({ message_id: 700 + i, media_group_id: "MG1", photo: [{ file_id: `f${i}` }] }));
  }
  t("nothing sent before the debounce fires", called("forwardMessages").length === 0 && called("forwardMessage").length === 0);
  const fired = await env.MEDIA_GROUP.fireAllAlarms();
  t("alarm fired", fired === 1, `fired=${fired}`);

  const fm = last("forwardMessages");
  t("forwardMessages used (album grouping preserved)", !!fm);
  t("all three ids in one call", JSON.stringify(fm?.args[2]) === "[700,701,702]", JSON.stringify(fm?.args[2]));
  t("strictly increasing ids", (fm?.args[2] ?? []).every((v, i, a) => i === 0 || v > a[i - 1]));
  t("sent into the topic", fm?.args[3]?.message_thread_id === THREAD);

  const maps = await env.DB.prepare("SELECT * FROM msg_map ORDER BY user_msg_id").all();
  t("one mapping per item", maps.results.length === 3);
  t("media_group_id recorded", maps.results.every((r) => r.media_group_id === "MG1"));
  t("all direction=in", maps.results.every((r) => r.direction === "in"));
}

section("media group: duplicate item ids are not double-counted");
{
  const env = await makeEnv();
  resetApi();
  await run(env, priv({ message_id: 700, media_group_id: "MG2", photo: [{ file_id: "a" }] }));
  // Same update_id dedup is separate; here the same message arrives under a new
  // update_id, which the DO must also tolerate.
  await run(env, priv({ message_id: 700, media_group_id: "MG2", photo: [{ file_id: "a" }] }));
  await run(env, priv({ message_id: 701, media_group_id: "MG2", photo: [{ file_id: "b" }] }));
  await env.MEDIA_GROUP.fireAllAlarms();
  t("deduplicated to two ids", JSON.stringify(last("forwardMessages")?.args[2]) === "[700,701]", JSON.stringify(last("forwardMessages")?.args[2]));
}

section("media group outbound: always copyMessages, never forwardMessages");
{
  const env = await makeEnv();
  resetApi();
  for (let i = 0; i < 2; i++) {
    await run(env, grp({ message_id: 800 + i, media_group_id: "MGOUT", photo: [{ file_id: `x${i}` }] }));
  }
  await env.MEDIA_GROUP.fireAllAlarms();
  const cm = last("copyMessages");
  t("copyMessages used", !!cm);
  t("forwardMessages NOT used outbound", called("forwardMessages").length === 0);
  t("delivered to the stranger", cm?.args[0] === STRANGER);
  t("no thread id leaked", cm?.args[3]?.message_thread_id === undefined);
  const maps = await env.DB.prepare("SELECT * FROM msg_map WHERE direction='out'").all();
  t("outbound mappings stored", maps.results.length === 2);
}

section("media group disabled: items relay individually");
{
  const env = await makeEnv({ media_group_enabled: "0" });
  resetApi();
  await run(env, priv({ message_id: 900, media_group_id: "MG3", photo: [{ file_id: "a" }] }));
  await run(env, priv({ message_id: 901, media_group_id: "MG3", photo: [{ file_id: "b" }] }));
  t("two individual forwards", called("forwardMessage").length === 2);
  t("no batch call", called("forwardMessages").length === 0);
}

section("media group: a partial send does not record wrong mappings");
{
  const env = await makeEnv();
  // Telegram skips messages it cannot forward, so the arrays can diverge.
  resetApi({ forwardMessages: (chat, from, ids) => ids.slice(1).map((_, i) => ({ message_id: 9000 + i })) });
  await run(env, priv({ message_id: 700, media_group_id: "MG4", photo: [{ file_id: "a" }] }));
  await run(env, priv({ message_id: 701, media_group_id: "MG4", photo: [{ file_id: "b" }] }));
  await env.MEDIA_GROUP.fireAllAlarms();
  t("no mappings written on length mismatch", (await env.DB.prepare("SELECT COUNT(*) AS n FROM msg_map").first()).n === 0);
}

section("rate limit: drops past the threshold and warns once");
{
  const env = await makeEnv({ rate_limit_max: "3", rate_limit_window: "60" });
  resetApi();
  for (let i = 0; i < 6; i++) await run(env, priv({ message_id: 1000 + i, text: `m${i}` }));
  t("only 3 relayed", called("forwardMessage").length === 3, `got ${called("forwardMessage").length}`);
  const warns = called("sendMessage").filter((c) => String(c.args[1]).includes("Rate limit"));
  t("warned exactly once", warns.length === 1, `got ${warns.length}`);
  t("warning went into the topic", warns[0]?.args[2]?.message_thread_id === THREAD);
}

section("rate limit: a new window resets the count");
{
  const env = await makeEnv({ rate_limit_max: "2", rate_limit_window: "60" });
  resetApi();
  await run(env, priv({ message_id: 1100, text: "a" }));
  await run(env, priv({ message_id: 1101, text: "b" }));
  await run(env, priv({ message_id: 1102, text: "c" }));
  t("third dropped", called("forwardMessage").length === 2);
  // Age the window past its end.
  await env.DB.prepare("UPDATE users SET rl_window_start = rl_window_start - 120 WHERE user_id=?").bind(STRANGER).run();
  resetApi();
  await run(env, priv({ message_id: 1103, text: "d" }));
  t("relayed again in the new window", called("forwardMessage").length === 1);
}

section("rate limit disabled: everything relays");
{
  const env = await makeEnv({ rate_limit_enabled: "0", rate_limit_max: "1" });
  resetApi();
  for (let i = 0; i < 5; i++) await run(env, priv({ message_id: 1200 + i, text: `m${i}` }));
  t("all five relayed", called("forwardMessage").length === 5);
}

section("copy mode hides the origin inbound too");
{
  const env = await makeEnv({ forward_mode: "copy" });
  resetApi();
  await run(env, priv({ message_id: 1300, text: "anon" }));
  t("copyMessage used", called("copyMessage").length === 1);
  t("forwardMessage not used", called("forwardMessage").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
