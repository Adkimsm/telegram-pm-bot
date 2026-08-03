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
  mediaGroupEnabled: boolean;
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
