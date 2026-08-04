-- Add the emoji reaction sync toggle.
--
-- Off by default so that upgrading an existing deployment does not silently
-- change its behaviour. Enabling it also requires re-registering the webhook,
-- because message_reaction is not in Telegram's default allowed_updates set
-- and omitting the field preserves the previous registration.

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('sync_reactions', '0');

UPDATE settings SET value = '2', updated_at = unixepoch()
WHERE key = 'schema_version';
