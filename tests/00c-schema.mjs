// Schema-level guarantees: constraints, indexes, idempotent migration, and the
// exact SQL shapes used by src/lib/db.ts. These run against node:sqlite, the
// same engine D1 is built on, so a broken constraint fails here rather than in
// production.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(
  new URL("../migrations/0001_init.sql", import.meta.url),
  "utf8",
);

let fails = 0;
let passN = 0;
const t = (name, cond, detail = "") => {
  if (cond) {
    passN++;
    console.log(`  ✓ ${name}`);
  } else {
    fails++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
};
const section = (s) => console.log(`\n### ${s}`);

const fresh = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
};
const rejects = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const now = Math.floor(Date.now() / 1000);

section("migration applies and is idempotent");
{
  const db = fresh();
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  t(
    "all nine tables created",
    tables.join(",") ===
      "bans,candidate_chats,login_nonces,msg_map,seen_updates,sessions,settings,topics,users",
    tables.join(","),
  );

  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  t("reverse msg_map index exists", indexes.includes("idx_msg_map_user"));
  t("topic lookup index exists", indexes.includes("idx_topics_thread"));
  t("cleanup indexes exist",
    indexes.includes("idx_seen_updates_ts") &&
    indexes.includes("idx_sessions_expires") &&
    indexes.includes("idx_login_nonces_expires"));

  // `wrangler d1 migrations apply` is safe to re-run; the SQL must be too.
  const before = db.prepare("SELECT COUNT(*) AS n FROM settings").get().n;
  db.exec(SCHEMA);
  const after = db.prepare("SELECT COUNT(*) AS n FROM settings").get().n;
  t("re-applying does not duplicate defaults", before === after, `${before} -> ${after}`);
}

section("settings defaults");
{
  const db = fresh();
  const map = Object.fromEntries(
    db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]),
  );
  // Empty string means "not configured yet" for both trust-root values.
  t("owner_id starts unset", map.owner_id === "");
  t("relay_chat_id starts unset", map.relay_chat_id === "");
  t("welcome text present", typeof map.welcome_text === "string" && map.welcome_text.length > 0);
  t("rate limit defaults to 20/60s", map.rate_limit_max === "20" && map.rate_limit_window === "60");
  t("forward mode defaults to forward", map.forward_mode === "forward");
  t("edits and media groups on by default", map.sync_edits === "1" && map.media_group_enabled === "1");
}

section("constraints");
{
  const db = fresh();
  db.prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)")
    .run(1001, -100, 7, now);

  // Two correspondents must never share one topic, or replies would cross over.
  t(
    "UNIQUE(chat_id, thread_id) enforced",
    rejects(() =>
      db.prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)")
        .run(1002, -100, 7, now),
    ),
  );

  t(
    "direction CHECK enforced",
    rejects(() =>
      db.prepare(
        "INSERT INTO msg_map (relay_chat_id,relay_msg_id,user_id,user_msg_id,direction,media_group_id,created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(-100, 1, 1001, 1, "sideways", null, now),
    ),
  );

  db.prepare("INSERT INTO seen_updates (update_id, ts) VALUES (?, ?)").run(5, now);
  const dup = db
    .prepare("INSERT OR IGNORE INTO seen_updates (update_id, ts) VALUES (?, ?)")
    .run(5, now);
  t("update dedup relies on PK + OR IGNORE", Number(dup.changes) === 0);
}

section("large Telegram ids survive round-trip");
{
  const db = fresh();
  // Ids can use up to 52 significant bits; SQLite INTEGER is 64-bit signed.
  const bigUser = 7_999_999_999_999;
  const bigChat = -1_002_147_483_647;
  db.prepare(
    `INSERT INTO users (user_id,first_name,last_name,username,language_code,
                        first_seen,last_seen,msg_count,rl_window_start,
                        rl_window_count,blocked_bot)
     VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
  ).run(bigUser, "Big", "", null, null, now, now, 1, 0, 0);
  db.prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)")
    .run(bigUser, bigChat, 3, now);

  t("user id preserved", db.prepare("SELECT user_id FROM users").get().user_id === bigUser);
  t("negative chat id preserved", db.prepare("SELECT chat_id FROM topics").get().chat_id === bigChat);
}

section("db.ts query shapes");
{
  const db = fresh();
  for (const [id, name, user] of [
    [1001, "Alice", "alicewu"],
    [1002, "Bob", null],
    [1003, "Carol", "carol"],
  ]) {
    db.prepare(
      `INSERT INTO users (user_id,first_name,last_name,username,language_code,
                          first_seen,last_seen,msg_count,rl_window_start,
                          rl_window_count,blocked_bot)
       VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
    ).run(id, name, "", user, "en", now - 100, now - (1005 - id), 5, now, 1);
  }
  db.prepare("INSERT INTO bans (user_id,reason,banned_at) VALUES (?,?,?)").run(1002, "spam", now);
  db.prepare("INSERT INTO topics (user_id,chat_id,thread_id,created_at) VALUES (?,?,?,?)").run(1001, -100123, 7, now);

  // Exactly the statement listUsers builds, using anonymous placeholders only.
  const where = `WHERE u.first_name LIKE ? OR u.last_name LIKE ?
              OR u.username LIKE ? OR u.user_id = ?`;
  const listSql = `
    SELECT u.*,
           CASE WHEN b.user_id IS NULL THEN 0 ELSE 1 END AS banned,
           t.thread_id AS thread_id
    FROM users u
    LEFT JOIN bans   b ON b.user_id = u.user_id
    LEFT JOIN topics t ON t.user_id = u.user_id
    ${where}
    ORDER BY u.last_seen DESC
    LIMIT ? OFFSET ?`;

  const byName = db.prepare(listSql).all("%ali%", "%ali%", "%ali%", 0, 50, 0);
  t("search by name", byName.length === 1 && byName[0].user_id === 1001);
  t("topic joined in", byName[0].thread_id === 7);

  const byId = db.prepare(listSql).all("%1002%", "%1002%", "%1002%", 1002, 50, 0);
  t("search by id", byId.length === 1 && byId[0].user_id === 1002);
  t("ban flag joined in", byId[0].banned === 1);

  const counted = db.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).get("%bo%", "%bo%", "%bo%", 0).n;
  t("count uses the same WHERE", counted === 1);

  // touchUser folds the rate-limit counter into the profile upsert so that one
  // message costs one row write.
  const upsert = db.prepare(
    `INSERT INTO users (user_id, first_name, last_name, username, language_code,
                        first_seen, last_seen, msg_count,
                        rl_window_start, rl_window_count, blocked_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)
     ON CONFLICT(user_id) DO UPDATE SET
       first_name      = excluded.first_name,
       last_name       = excluded.last_name,
       username        = excluded.username,
       language_code   = excluded.language_code,
       last_seen       = excluded.last_seen,
       msg_count       = users.msg_count + 1,
       rl_window_start = ?,
       rl_window_count = ?,
       blocked_bot     = 0`,
  );
  upsert.run(1001, "Alice", "Wu", "alicewu", "en", now, now, now, 3, now, 3);
  const after = db.prepare("SELECT msg_count, rl_window_count, last_name FROM users WHERE user_id=1001").get();
  t("upsert increments the count", after.msg_count === 6);
  t("upsert sets the window", after.rl_window_count === 3);
  t("upsert refreshes the profile", after.last_name === "Wu");

  db.prepare(
    "INSERT OR REPLACE INTO msg_map (relay_chat_id,relay_msg_id,user_id,user_msg_id,direction,media_group_id,created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(-100123, 55, 1001, 900, "in", null, now);
  t(
    "forward lookup by relay id",
    db.prepare("SELECT * FROM msg_map WHERE relay_chat_id=? AND relay_msg_id=?").get(-100123, 55) !== undefined,
  );
  t(
    "reverse lookup by user id",
    db.prepare("SELECT * FROM msg_map WHERE user_id=? AND user_msg_id=?").get(1001, 900) !== undefined,
  );

  const bans = db.prepare(
    `SELECT b.*, COALESCE(u.first_name, '') AS first_name, u.username
     FROM bans b LEFT JOIN users u ON u.user_id = b.user_id
     ORDER BY b.banned_at DESC LIMIT 500`,
  ).all();
  t("ban list joins the profile", bans.length === 1 && bans[0].first_name === "Bob");

  // A ban for a user we have never seen must still list, hence the LEFT JOIN.
  db.prepare("INSERT INTO bans (user_id,reason,banned_at) VALUES (?,?,?)").run(9999, "preemptive", now);
  const orphan = db.prepare(
    `SELECT b.*, COALESCE(u.first_name, '') AS first_name
     FROM bans b LEFT JOIN users u ON u.user_id = b.user_id WHERE b.user_id = 9999`,
  ).get();
  t("ban for an unknown user still lists", orphan?.first_name === "");
}

section("cleanup statements are valid");
{
  const db = fresh();
  const stmts = [
    ["DELETE FROM seen_updates WHERE ts < ?", now - 86400],
    ["DELETE FROM sessions WHERE expires_at < ?", now],
    ["DELETE FROM login_nonces WHERE expires_at < ?", now],
    ["DELETE FROM msg_map WHERE created_at < ?", now - 60 * 86400],
  ];
  let ok = true;
  for (const [sql, arg] of stmts) {
    try {
      db.prepare(sql).run(arg);
    } catch (e) {
      ok = false;
      console.log(`    (${sql} failed: ${e.message})`);
    }
  }
  t("all four prune statements run", ok);
}

console.log(`\n${passN} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
