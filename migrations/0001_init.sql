-- pmbot initial schema
--
-- Design notes:
--  * Telegram user/chat ids need up to 52 significant bits, so INTEGER
--    (SQLite: 64-bit signed) is correct. Never store them as REAL.
--  * All timestamps are Unix seconds (INTEGER), UTC.
--  * `settings` is the only source of runtime configuration; nothing
--    behavioural lives in wrangler.jsonc or environment variables.

-- ---------------------------------------------------------------------------
-- Runtime configuration, edited via the web UI.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Defaults. `owner_id` and `relay_chat_id` stay empty until claimed/bound;
-- an empty string means "not configured yet".
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('owner_id',            ''),
  ('relay_chat_id',       ''),
  ('welcome_text',        '你好，请直接发送消息。'),
  ('rate_limit_max',      '20'),
  ('rate_limit_window',   '60'),
  ('rate_limit_enabled',  '1'),
  ('forward_mode',        'forward'),
  ('sync_edits',          '1'),
  ('media_group_enabled', '1'),
  ('schema_version',      '1');

-- ---------------------------------------------------------------------------
-- Known correspondents. Rate-limit counters live here so that the per-message
-- upsert we already perform doubles as the rate-limit write (D1 free tier
-- allows 100k row writes/day, so avoiding a second write matters).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id         INTEGER PRIMARY KEY,
  first_name      TEXT    NOT NULL DEFAULT '',
  last_name       TEXT    NOT NULL DEFAULT '',
  username        TEXT,
  language_code   TEXT,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  msg_count       INTEGER NOT NULL DEFAULT 0,
  rl_window_start INTEGER NOT NULL DEFAULT 0,
  rl_window_count INTEGER NOT NULL DEFAULT 0,
  -- Set when Telegram tells us the user blocked the bot (my_chat_member).
  blocked_bot     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen DESC);

-- ---------------------------------------------------------------------------
-- One forum topic per correspondent, inside the relay supergroup.
-- The Bot API offers no way to list topics, so this table is the only source
-- of truth. Losing it means the topics cannot be re-discovered.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topics (
  user_id    INTEGER PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  thread_id  INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (chat_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_topics_thread ON topics (chat_id, thread_id);

-- ---------------------------------------------------------------------------
-- Message id mapping, used for two things:
--   1. resolving which correspondent an owner reply belongs to;
--   2. mirroring edits and /del in both directions.
--
-- direction: 'in'  = correspondent -> relay group
--            'out' = relay group   -> correspondent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS msg_map (
  relay_chat_id  INTEGER NOT NULL,
  relay_msg_id   INTEGER NOT NULL,
  user_id        INTEGER NOT NULL,
  user_msg_id    INTEGER NOT NULL,
  direction      TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
  media_group_id TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (relay_chat_id, relay_msg_id)
);

-- Reverse lookup: given a correspondent's message, find the relayed copy.
CREATE INDEX IF NOT EXISTS idx_msg_map_user
  ON msg_map (user_id, user_msg_id);

CREATE INDEX IF NOT EXISTS idx_msg_map_created
  ON msg_map (created_at);

-- ---------------------------------------------------------------------------
-- Blocklist. Messages from banned users are dropped silently: telling them
-- they are banned only invites evasion.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bans (
  user_id   INTEGER PRIMARY KEY,
  reason    TEXT    NOT NULL DEFAULT '',
  banned_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Webhook de-duplication. Telegram retries any non-2xx response, and may
-- redeliver on its own; update_id is the documented de-dup key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seen_updates_ts ON seen_updates (ts);

-- ---------------------------------------------------------------------------
-- Web UI sessions. Only the SHA-256 of the token is stored, so a database
-- leak does not hand over live sessions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Single-use login nonces issued by /login. Short TTL, deleted on redemption.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_nonces (
  nonce_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_nonces_expires ON login_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- Groups the bot has been added to, offered in the UI for one-click binding
-- so the operator never has to look up a numeric chat id by hand.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS candidate_chats (
  chat_id   INTEGER PRIMARY KEY,
  title     TEXT    NOT NULL DEFAULT '',
  type      TEXT    NOT NULL DEFAULT '',
  is_forum  INTEGER NOT NULL DEFAULT 0,
  can_manage_topics INTEGER NOT NULL DEFAULT 0,
  seen_at   INTEGER NOT NULL
);
