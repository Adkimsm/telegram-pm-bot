import type { Api } from "grammy";
import type { Env, Settings } from "../lib/types";

/** Everything a handler needs, assembled once per update. */
export interface BotContext {
  env: Env;
  api: Api;
  settings: Settings;
  /** Deferred work that must not block the webhook response. */
  waitUntil: (p: Promise<unknown>) => void;
}

/**
 * True when the relay group is configured and reachable.
 * Until then, incoming messages have nowhere to go.
 */
export function isConfigured(s: Settings): s is Settings & {
  ownerId: number;
  relayChatId: number;
} {
  return s.ownerId !== null && s.relayChatId !== null;
}

/**
 * Log and swallow an API error.
 *
 * A webhook handler must return 2xx even when a downstream Telegram call
 * fails: a non-2xx response makes Telegram redeliver the update, which would
 * duplicate whatever did succeed.
 */
export function logError(scope: string, err: unknown): void {
  console.error(`[${scope}]`, err instanceof Error ? err.message : String(err));
}
