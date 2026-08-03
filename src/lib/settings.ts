import type { Env, Settings } from "./types";

const DEFAULTS: Settings = {
  ownerId: null,
  relayChatId: null,
  welcomeText: "你好，请直接发送消息。",
  rateLimitMax: 20,
  rateLimitWindow: 60,
  rateLimitEnabled: true,
  forwardMode: "forward",
  syncEdits: true,
  mediaGroupEnabled: true,
};

/** Keys the web UI is allowed to write, with validation for each. */
export const EDITABLE_KEYS = {
  relay_chat_id: "int-or-empty",
  welcome_text: "text",
  rate_limit_max: "positive-int",
  rate_limit_window: "positive-int",
  rate_limit_enabled: "bool",
  forward_mode: "forward-mode",
  sync_edits: "bool",
  media_group_enabled: "bool",
} as const;

export type EditableKey = keyof typeof EDITABLE_KEYS;

/**
 * Telegram ids exceed 2^32 but stay within 2^53, so Number is safe.
 * Anything outside that range, or non-numeric, is treated as unset rather
 * than silently coerced to a wrong id.
 */
function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n === 0) return null;
  return n;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export async function loadSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM settings",
  ).all<{ key: string; value: string }>();

  const map = new Map(results.map((r) => [r.key, r.value]));

  return {
    ownerId: parseId(map.get("owner_id")),
    relayChatId: parseId(map.get("relay_chat_id")),
    welcomeText: map.get("welcome_text") ?? DEFAULTS.welcomeText,
    rateLimitMax: parsePositiveInt(
      map.get("rate_limit_max"),
      DEFAULTS.rateLimitMax,
    ),
    rateLimitWindow: parsePositiveInt(
      map.get("rate_limit_window"),
      DEFAULTS.rateLimitWindow,
    ),
    rateLimitEnabled: parseBool(
      map.get("rate_limit_enabled"),
      DEFAULTS.rateLimitEnabled,
    ),
    forwardMode: map.get("forward_mode") === "copy" ? "copy" : "forward",
    syncEdits: parseBool(map.get("sync_edits"), DEFAULTS.syncEdits),
    mediaGroupEnabled: parseBool(
      map.get("media_group_enabled"),
      DEFAULTS.mediaGroupEnabled,
    ),
  };
}

export async function setSetting(
  env: Env,
  key: string,
  value: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    updated_at = excluded.updated_at`,
  )
    .bind(key, value)
    .run();
}

export interface ValidationResult {
  ok: boolean;
  value?: string;
  error?: string;
}

/** Validate and normalise a single settings value coming from the web UI. */
export function validateSetting(key: string, raw: unknown): ValidationResult {
  if (!(key in EDITABLE_KEYS)) {
    return { ok: false, error: `unknown or read-only key: ${key}` };
  }

  const kind = EDITABLE_KEYS[key as EditableKey];
  const s = typeof raw === "string" ? raw : String(raw ?? "");

  switch (kind) {
    case "int-or-empty": {
      const trimmed = s.trim();
      if (trimmed === "") return { ok: true, value: "" };
      const n = Number(trimmed);
      if (!Number.isSafeInteger(n) || n === 0) {
        return { ok: false, error: `${key} must be a valid chat id` };
      }
      return { ok: true, value: String(n) };
    }
    case "positive-int": {
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n <= 0) {
        return { ok: false, error: `${key} must be a positive integer` };
      }
      if (n > 100_000) {
        return { ok: false, error: `${key} is unreasonably large` };
      }
      return { ok: true, value: String(n) };
    }
    case "bool":
      return { ok: true, value: s === "1" || s === "true" ? "1" : "0" };
    case "forward-mode":
      if (s !== "forward" && s !== "copy") {
        return { ok: false, error: "forward_mode must be 'forward' or 'copy'" };
      }
      return { ok: true, value: s };
    case "text": {
      // Telegram caps a text message at 4096 characters after entity parsing.
      if (s.length > 3000) {
        return { ok: false, error: `${key} must be at most 3000 characters` };
      }
      return { ok: true, value: s };
    }
  }
}
