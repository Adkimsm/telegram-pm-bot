import type { MediaGroupBuffer } from "./media-group";

/** Bindings declared in wrangler.jsonc, plus the single secret. */
export interface Env {
  /** The only secret. `wrangler secret put BOT_TOKEN`. */
  BOT_TOKEN: string;
  DB: D1Database;
  ASSETS: Fetcher;
  MEDIA_GROUP: DurableObjectNamespace<MediaGroupBuffer>;
}

/** Runtime configuration, all of it stored in D1 and edited from the web UI. */
export interface Settings {
  /** Telegram user id of the operator. Empty until `/claim` succeeds. */
  ownerId: number | null;
  /** Forum supergroup that holds one topic per correspondent. */
  relayChatId: number | null;
  welcomeText: string;
  rateLimitMax: number;
  rateLimitWindow: number;
  rateLimitEnabled: boolean;
  /**
   * How incoming messages are rendered in the relay group.
   *  - `forward`: forwardMessage, preserving the sender's name card.
   *  - `copy`:    copyMessage, hiding the origin.
   */
  forwardMode: "forward" | "copy";
  syncEdits: boolean;
  /**
   * Mirror emoji reactions in both directions.
   *
   * Bots may set only one reaction per message, and cannot use custom or paid
   * reactions, so this conveys the first standard emoji and nothing else.
   */
  syncReactions: boolean;
  mediaGroupEnabled: boolean;
  /** Gate first contact behind a challenge in the private chat. */
  humanVerifyEnabled: boolean;
  /** How long a pending challenge stays valid, in seconds. */
  humanVerifyTimeout: number;
  /** Wrong attempts allowed before a temporary ban kicks in. */
  humanVerifyMaxAttempts: number;
  /** Length of the temporary ban after too many failures, in minutes. */
  humanVerifyBanMinutes: number;
  /** How many challenges in a row must be answered correctly to pass. */
  humanVerifyRounds: number;
  /**
   * Minimum seconds between issuing a challenge and accepting an answer.
   * Anything faster than a human could read and type is treated as
   * automation. 0 disables the check.
   */
  humanVerifyMinSeconds: number;
  /** Double the cooldown for each previous failure cycle (capped at 24h). */
  humanVerifyEscalate: boolean;
  /** Text shown above the challenge itself. */
  humanVerifyPrompt: string;
}

export interface UserRow {
  user_id: number;
  first_name: string;
  last_name: string;
  username: string | null;
  language_code: string | null;
  first_seen: number;
  last_seen: number;
  msg_count: number;
  rl_window_start: number;
  rl_window_count: number;
  blocked_bot: number;
  verified_at: number;
  verify_state: string;
  verify_nonce: string;
  verify_answer: string;
  verify_expires_at: number;
  verify_attempts: number;
  /** How many challenges of the current cycle have been answered correctly. */
  verify_step: number;
  /** When the current challenge was issued, for the too-fast-answer check. */
  verify_issued_at: number;
  /** Completed failure cycles; drives the escalating cooldown. */
  verify_strikes: number;
  temp_banned_until: number;
}

export interface TopicRow {
  user_id: number;
  chat_id: number;
  thread_id: number;
  created_at: number;
}

export interface MsgMapRow {
  relay_chat_id: number;
  relay_msg_id: number;
  user_id: number;
  user_msg_id: number;
  direction: "in" | "out";
  media_group_id: string | null;
  created_at: number;
}

export interface BanRow {
  user_id: number;
  reason: string;
  banned_at: number;
}

export interface CandidateChatRow {
  chat_id: number;
  title: string;
  type: string;
  is_forum: number;
  can_manage_topics: number;
  seen_at: number;
}

/** One buffered message awaiting media-group aggregation. */
export interface PendingMediaItem {
  messageId: number;
  userId: number;
  /** 'in' = correspondent -> relay group, 'out' = relay group -> correspondent. */
  direction: "in" | "out";
}
