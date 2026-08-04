import type {
  BanRow,
  CandidateChatRow,
  Env,
  MsgMapRow,
  TopicRow,
  UserRow,
} from "./types";

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Update de-duplication
// ---------------------------------------------------------------------------

/**
 * Returns true if this update_id has not been processed before.
 *
 * Telegram retries any webhook response that is not 2xx and may redeliver
 * regardless, so every handler must be idempotent. `INSERT OR IGNORE` plus
 * `meta.changes` gives us an atomic claim in one round trip.
 */
export async function claimUpdate(
  env: Env,
  updateId: number,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO seen_updates (update_id, ts) VALUES (?, ?)",
  )
    .bind(updateId, now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Users and rate limiting
// ---------------------------------------------------------------------------

export interface TouchUserInput {
  userId: number;
  firstName: string;
  lastName: string;
  username: string | null;
  languageCode: string | null;
}

export interface TouchUserResult {
  user: UserRow;
  isNew: boolean;
  /** True when this message pushed the user past the rate limit. */
  rateLimited: boolean;
  /** True only on the first message that trips the limit, to notify once. */
  justTripped: boolean;
}

/**
 * Upsert profile data, bump counters and evaluate the rate limit in a single
 * write. Folding the rate-limit counter into the row we must update anyway
 * keeps us to one write per message, which matters against D1's free-tier
 * budget of 100k row writes per day.
 */
export async function touchUser(
  env: Env,
  input: TouchUserInput,
  limit: { enabled: boolean; max: number; windowSec: number },
): Promise<TouchUserResult> {
  const ts = now();
  const existing = await env.DB.prepare(
    "SELECT * FROM users WHERE user_id = ?",
  )
    .bind(input.userId)
    .first<UserRow>();

  let windowStart = existing?.rl_window_start ?? 0;
  let windowCount = existing?.rl_window_count ?? 0;

  if (ts - windowStart >= limit.windowSec) {
    windowStart = ts;
    windowCount = 1;
  } else {
    windowCount += 1;
  }

  const overLimit = limit.enabled && windowCount > limit.max;
  const justTripped = overLimit && windowCount === limit.max + 1;

  await env.DB.prepare(
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
  )
    .bind(
      input.userId,
      input.firstName,
      input.lastName,
      input.username,
      input.languageCode,
      ts,
      ts,
      windowStart,
      windowCount,
      windowStart,
      windowCount,
    )
    .run();

  const user: UserRow = {
    user_id: input.userId,
    first_name: input.firstName,
    last_name: input.lastName,
    username: input.username,
    language_code: input.languageCode,
    first_seen: existing?.first_seen ?? ts,
    last_seen: ts,
    msg_count: (existing?.msg_count ?? 0) + 1,
    rl_window_start: windowStart,
    rl_window_count: windowCount,
    blocked_bot: 0,
    verified_at: existing?.verified_at ?? 0,
    verify_state: existing?.verify_state ?? "",
    verify_nonce: existing?.verify_nonce ?? "",
    verify_answer: existing?.verify_answer ?? "",
    verify_expires_at: existing?.verify_expires_at ?? 0,
    verify_attempts: existing?.verify_attempts ?? 0,
    temp_banned_until: existing?.temp_banned_until ?? 0,
  };

  return { user, isNew: !existing, rateLimited: overLimit, justTripped };
}

export async function getUser(
  env: Env,
  userId: number,
): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE user_id = ?")
    .bind(userId)
    .first<UserRow>();
}

export async function markBlockedBot(
  env: Env,
  userId: number,
  blocked: boolean,
): Promise<void> {
  await env.DB.prepare("UPDATE users SET blocked_bot = ? WHERE user_id = ?")
    .bind(blocked ? 1 : 0, userId)
    .run();
}

export interface VerificationChallenge {
  nonce: string;
  answer: string;
  expiresAt: number;
}

export async function getVerificationState(
  env: Env,
  userId: number,
): Promise<Pick<
  UserRow,
  | "verified_at"
  | "verify_state"
  | "verify_nonce"
  | "verify_answer"
  | "verify_expires_at"
  | "verify_attempts"
  | "temp_banned_until"
> | null> {
  return env.DB.prepare(
    `SELECT verified_at, verify_state, verify_nonce, verify_answer,
            verify_expires_at, verify_attempts, temp_banned_until
       FROM users WHERE user_id = ?`,
  )
    .bind(userId)
    .first();
}

export async function setVerified(env: Env, userId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE users
        SET verified_at = ?,
            verify_state = '',
            verify_nonce = '',
            verify_answer = '',
            verify_expires_at = 0,
            verify_attempts = 0,
            temp_banned_until = 0
      WHERE user_id = ?`,
  )
    .bind(now(), userId)
    .run();
}

export async function clearVerification(env: Env, userId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE users
        SET verified_at = 0,
            verify_state = '',
            verify_nonce = '',
            verify_answer = '',
            verify_expires_at = 0,
            verify_attempts = 0,
            temp_banned_until = 0
      WHERE user_id = ?`,
  )
    .bind(userId)
    .run();
}

export async function setTemporaryVerificationBan(
  env: Env,
  userId: number,
  until: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users
        SET verified_at = 0,
            verify_state = '',
            verify_nonce = '',
            verify_answer = '',
            verify_expires_at = 0,
            verify_attempts = 0,
            temp_banned_until = ?
      WHERE user_id = ?`,
  )
    .bind(until, userId)
    .run();
}

export async function saveVerificationChallenge(
  env: Env,
  userId: number,
  challenge: VerificationChallenge,
  attempts = 0,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users
        SET verify_state = 'pending',
            verify_nonce = ?,
            verify_answer = ?,
            verify_expires_at = ?,
            verify_attempts = ?
      WHERE user_id = ?`,
  )
    .bind(challenge.nonce, challenge.answer, challenge.expiresAt, attempts, userId)
    .run();
}

export async function bumpVerificationFailure(
  env: Env,
  userId: number,
  until: number | null,
): Promise<number> {
  await env.DB.prepare(
    `UPDATE users
        SET verify_attempts = verify_attempts + 1,
            temp_banned_until = COALESCE(?, temp_banned_until)
      WHERE user_id = ?`,
  )
    .bind(until, userId)
    .run();

  const row = await env.DB.prepare(
    "SELECT verify_attempts FROM users WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ verify_attempts: number }>();
  return row?.verify_attempts ?? 0;
}

export async function resetExpiredChallenge(
  env: Env,
  userId: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users
        SET verify_state = '',
            verify_nonce = '',
            verify_answer = '',
            verify_expires_at = 0,
            verify_attempts = 0
      WHERE user_id = ?`,
  )
    .bind(userId)
    .run();
}

export interface ListUsersOptions {
  search?: string;
  limit: number;
  offset: number;
}

export async function listUsers(
  env: Env,
  opts: ListUsersOptions,
): Promise<{ users: (UserRow & { banned: number; thread_id: number | null })[]; total: number }> {
  const search = opts.search?.trim();
  const like = search ? `%${search}%` : null;

  // Numeric input is matched as an exact id too, so pasting a user id finds
  // that user directly rather than relying on a substring hit.
  const idMatch = search && /^-?\d+$/.test(search) ? Number(search) : 0;

  // Only anonymous `?` placeholders are used. D1 binds positionally, so mixing
  // `?NNN` with `?` is unreliable even though plain SQLite tolerates it —
  // hence the LIKE value is passed three times rather than reused as `?1`.
  const where = search
    ? `WHERE u.first_name LIKE ? OR u.last_name LIKE ?
              OR u.username LIKE ? OR u.user_id = ?`
    : "";

  const countSql = `SELECT COUNT(*) AS n FROM users u ${where}`;
  const countStmt = search
    ? env.DB.prepare(countSql).bind(like, like, like, idMatch)
    : env.DB.prepare(countSql);
  const countRow = await countStmt.first<{ n: number }>();

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

  const listStmt = search
    ? env.DB.prepare(listSql).bind(
        like,
        like,
        like,
        idMatch,
        opts.limit,
        opts.offset,
      )
    : env.DB.prepare(listSql).bind(opts.limit, opts.offset);

  const { results } = await listStmt.all<
    UserRow & { banned: number; thread_id: number | null }
  >();

  return { users: results, total: countRow?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export async function getTopicByUser(
  env: Env,
  userId: number,
): Promise<TopicRow | null> {
  return env.DB.prepare("SELECT * FROM topics WHERE user_id = ?")
    .bind(userId)
    .first<TopicRow>();
}

export async function getTopicByThread(
  env: Env,
  chatId: number,
  threadId: number,
): Promise<TopicRow | null> {
  return env.DB.prepare(
    "SELECT * FROM topics WHERE chat_id = ? AND thread_id = ?",
  )
    .bind(chatId, threadId)
    .first<TopicRow>();
}

export async function saveTopic(
  env: Env,
  userId: number,
  chatId: number,
  threadId: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO topics (user_id, chat_id, thread_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET chat_id    = excluded.chat_id,
                                        thread_id  = excluded.thread_id,
                                        created_at = excluded.created_at`,
  )
    .bind(userId, chatId, threadId, now())
    .run();
}

export async function deleteTopic(env: Env, userId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM topics WHERE user_id = ?")
    .bind(userId)
    .run();
}

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

export async function saveMapping(
  env: Env,
  row: Omit<MsgMapRow, "created_at">,
): Promise<void> {
  // message_id can legitimately be 0 for scheduled or ephemeral messages,
  // in which case the mapping is meaningless — skip rather than poison the
  // table with an unusable key.
  if (!row.relay_msg_id || !row.user_msg_id) return;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO msg_map
       (relay_chat_id, relay_msg_id, user_id, user_msg_id, direction,
        media_group_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.relay_chat_id,
      row.relay_msg_id,
      row.user_id,
      row.user_msg_id,
      row.direction,
      row.media_group_id,
      now(),
    )
    .run();
}

export async function saveMappings(
  env: Env,
  rows: Omit<MsgMapRow, "created_at">[],
): Promise<void> {
  const valid = rows.filter((r) => r.relay_msg_id && r.user_msg_id);
  if (valid.length === 0) return;

  const ts = now();
  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO msg_map
       (relay_chat_id, relay_msg_id, user_id, user_msg_id, direction,
        media_group_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  await env.DB.batch(
    valid.map((r) =>
      stmt.bind(
        r.relay_chat_id,
        r.relay_msg_id,
        r.user_id,
        r.user_msg_id,
        r.direction,
        r.media_group_id,
        ts,
      ),
    ),
  );
}

/** Look up by the message id as it exists in the relay group. */
export async function findByRelayMsg(
  env: Env,
  relayChatId: number,
  relayMsgId: number,
): Promise<MsgMapRow | null> {
  return env.DB.prepare(
    "SELECT * FROM msg_map WHERE relay_chat_id = ? AND relay_msg_id = ?",
  )
    .bind(relayChatId, relayMsgId)
    .first<MsgMapRow>();
}

/** Look up by the message id as it exists in the correspondent's chat. */
export async function findByUserMsg(
  env: Env,
  userId: number,
  userMsgId: number,
): Promise<MsgMapRow | null> {
  return env.DB.prepare(
    "SELECT * FROM msg_map WHERE user_id = ? AND user_msg_id = ?",
  )
    .bind(userId, userMsgId)
    .first<MsgMapRow>();
}

export async function deleteMapping(
  env: Env,
  relayChatId: number,
  relayMsgId: number,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM msg_map WHERE relay_chat_id = ? AND relay_msg_id = ?",
  )
    .bind(relayChatId, relayMsgId)
    .run();
}

// ---------------------------------------------------------------------------
// Bans
// ---------------------------------------------------------------------------

export async function isBanned(env: Env, userId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM bans WHERE user_id = ?")
    .bind(userId)
    .first<{ x: number }>();
  return row !== null;
}

export async function banUser(
  env: Env,
  userId: number,
  reason: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bans (user_id, reason, banned_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET reason    = excluded.reason,
                                        banned_at = excluded.banned_at`,
  )
    .bind(userId, reason, now())
    .run();
}

export async function unbanUser(env: Env, userId: number): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM bans WHERE user_id = ?")
    .bind(userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listBans(env: Env): Promise<
  (BanRow & { first_name: string; username: string | null })[]
> {
  const { results } = await env.DB.prepare(
    `SELECT b.*, COALESCE(u.first_name, '') AS first_name, u.username
     FROM bans b LEFT JOIN users u ON u.user_id = b.user_id
     ORDER BY b.banned_at DESC LIMIT 500`,
  ).all<BanRow & { first_name: string; username: string | null }>();
  return results;
}

// ---------------------------------------------------------------------------
// Candidate relay groups
// ---------------------------------------------------------------------------

export async function recordCandidateChat(
  env: Env,
  row: Omit<CandidateChatRow, "seen_at">,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO candidate_chats
       (chat_id, title, type, is_forum, can_manage_topics, seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       title             = excluded.title,
       type              = excluded.type,
       is_forum          = excluded.is_forum,
       can_manage_topics = excluded.can_manage_topics,
       seen_at           = excluded.seen_at`,
  )
    .bind(
      row.chat_id,
      row.title,
      row.type,
      row.is_forum,
      row.can_manage_topics,
      now(),
    )
    .run();
}

export async function removeCandidateChat(
  env: Env,
  chatId: number,
): Promise<void> {
  await env.DB.prepare("DELETE FROM candidate_chats WHERE chat_id = ?")
    .bind(chatId)
    .run();
}

export async function listCandidateChats(
  env: Env,
): Promise<CandidateChatRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM candidate_chats ORDER BY seen_at DESC LIMIT 50",
  ).all<CandidateChatRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Stats and housekeeping
// ---------------------------------------------------------------------------

export interface Stats {
  users: number;
  banned: number;
  topics: number;
  mappings: number;
  messagesTotal: number;
  activeToday: number;
}

export async function getStats(env: Env): Promise<Stats> {
  const dayAgo = now() - 86400;
  const batch = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM users"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM bans"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM topics"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM msg_map"),
    env.DB.prepare("SELECT COALESCE(SUM(msg_count), 0) AS n FROM users"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE last_seen > ?").bind(
      dayAgo,
    ),
  ]);

  const at = (i: number): number => batch[i]?.results?.[0]?.n ?? 0;

  return {
    users: at(0),
    banned: at(1),
    topics: at(2),
    mappings: at(3),
    messagesTotal: at(4),
    activeToday: at(5),
  };
}

/**
 * Daily housekeeping, driven by the cron trigger.
 *
 * `msg_map` rows older than 60 days are dropped: Telegram refuses to edit or
 * delete anything past 48 hours, so older mappings only serve reply lookups,
 * and 60 days is generous for that.
 */
export async function cleanup(env: Env): Promise<Record<string, number>> {
  const ts = now();
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM seen_updates WHERE ts < ?").bind(ts - 86400),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(ts),
    env.DB.prepare("DELETE FROM login_nonces WHERE expires_at < ?").bind(ts),
    env.DB.prepare("DELETE FROM msg_map WHERE created_at < ?").bind(
      ts - 60 * 86400,
    ),
  ]);

  return {
    seen_updates: results[0]?.meta.changes ?? 0,
    sessions: results[1]?.meta.changes ?? 0,
    login_nonces: results[2]?.meta.changes ?? 0,
    msg_map: results[3]?.meta.changes ?? 0,
  };
}
