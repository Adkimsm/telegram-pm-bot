-- Harden human verification.
--
-- The original challenge was a four-button multiple choice question: one tap
-- had a 25% chance of being right by luck, and /start reset the failure
-- counter outright. This migration adds the state needed to make the gate
-- meaningful: a round counter (several correct answers in a row), the moment
-- the current challenge was issued (so an instant reply is treated as
-- automation), and a strike counter that makes repeated offenders wait
-- progressively longer.

ALTER TABLE users ADD COLUMN verify_step      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verify_issued_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verify_strikes   INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('human_verify_rounds',      '2'),
  ('human_verify_min_seconds', '2'),
  ('human_verify_escalate',    '1');

UPDATE settings SET value = '4', updated_at = unixepoch()
WHERE key = 'schema_version';
