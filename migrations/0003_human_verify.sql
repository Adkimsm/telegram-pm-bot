-- Add Telegram-native human verification.
--
-- The challenge is solved entirely inside the private chat via inline
-- keyboard callbacks, so it needs no custom domain and no third-party CAPTCHA.

ALTER TABLE users ADD COLUMN verified_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verify_state TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN verify_nonce TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN verify_answer TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN verify_expires_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verify_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN temp_banned_until INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('human_verify_enabled',      '0'),
  ('human_verify_timeout',      '300'),
  ('human_verify_max_attempts', '2'),
  ('human_verify_ban_minutes',  '10'),
  ('human_verify_prompt',       '请先完成验证，再继续发送消息。');

UPDATE settings SET value = '3', updated_at = unixepoch()
WHERE key = 'schema_version';
