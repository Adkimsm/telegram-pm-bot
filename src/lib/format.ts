import type { UserRow } from "./types";

/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function displayName(u: {
  first_name?: string;
  last_name?: string | null;
}): string {
  const name = [u.first_name ?? "", u.last_name ?? ""]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || "(no name)";
}

/**
 * Forum topic names are capped at 128 characters, and an empty name is
 * rejected, so fall back to the id when the display name is unusable.
 */
export function topicName(user: {
  user_id: number;
  first_name?: string;
  last_name?: string | null;
  username?: string | null;
}): string {
  const base = displayName(user);
  const suffix = user.username ? ` @${user.username}` : ` #${user.user_id}`;
  const name = (base + suffix).trim();
  return name.length > 128 ? name.slice(0, 128) : name || `#${user.user_id}`;
}

export function formatTimestamp(unix: number): string {
  if (!unix) return "-";
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** The info card sent once, when a correspondent's topic is first created. */
export function buildInfoCard(user: UserRow, banned: boolean): string {
  const lines = [
    `<b>${escapeHtml(displayName(user))}</b>`,
    `ID: <code>${user.user_id}</code>`,
  ];

  if (user.username) lines.push(`Username: @${escapeHtml(user.username)}`);
  if (user.language_code) {
    lines.push(`Language: ${escapeHtml(user.language_code)}`);
  }

  lines.push(`First seen: ${formatTimestamp(user.first_seen)}`);
  lines.push(`Messages: ${user.msg_count}`);

  if (banned) lines.push("Status: <b>BANNED</b>");
  if (user.blocked_bot) lines.push("Status: user has blocked the bot");

  // tg://user?id= only resolves reliably once the user has messaged the bot,
  // which is exactly our situation, and it still fails if they have Forwarded
  // Messages privacy enabled — hence the plain id above as the fallback.
  lines.push(
    `<a href="tg://user?id=${user.user_id}">Open profile</a>`,
  );

  return lines.join("\n");
}

/**
 * Extract a numeric Telegram id from a command argument.
 * Accepts a bare id; rejects anything else so `/ban @name` fails loudly
 * rather than banning some unrelated numeric interpretation.
 */
export function parseUserIdArg(arg: string | undefined): number | null {
  if (!arg) return null;
  const trimmed = arg.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}

/** Split a command message into its argument string. */
export function commandArgs(text: string): string {
  const space = text.indexOf(" ");
  return space < 0 ? "" : text.slice(space + 1).trim();
}
