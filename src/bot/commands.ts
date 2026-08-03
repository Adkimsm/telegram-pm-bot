import type { CallbackQuery, Message } from "grammy/types";
import { createLoginNonce, revokeAllSessions } from "../lib/auth";
import { deriveClaimCode, timingSafeEqual } from "../lib/crypto";
import {
  banUser,
  deleteMapping,
  findByRelayMsg,
  getTopicByThread,
  getTopicByUser,
  getUser,
  isBanned,
  listBans,
  unbanUser,
} from "../lib/db";
import {
  buildInfoCard,
  commandArgs,
  displayName,
  escapeHtml,
  parseUserIdArg,
} from "../lib/format";
import { setSetting } from "../lib/settings";
import type { BotContext } from "./context";
import { logError } from "./context";

/** True when the command was fully handled and no relaying should occur. */
export type Handled = boolean;

/**
 * Commands the operator sends in their private chat with the bot.
 * Every one of these requires ownership, except `/claim` which establishes it.
 */
export async function handleOwnerPrivateCommand(
  ctx: BotContext,
  msg: Message,
  origin: URL,
): Promise<Handled> {
  const text = msg.text ?? "";
  if (!text.startsWith("/")) return false;

  const cmd = text.split(/[\s@]/)[0]!.toLowerCase();
  const args = commandArgs(text);
  const fromId = msg.from?.id;
  if (!fromId) return false;

  const { env, api, settings } = ctx;

  // /claim is the bootstrap: it is the only command available before an owner
  // exists, and the only one whose authorisation is not "are you the owner".
  if (cmd === "/claim") {
    await handleClaim(ctx, msg, args, fromId);
    return true;
  }

  const isOwner = settings.ownerId !== null && settings.ownerId === fromId;

  switch (cmd) {
    case "/start":
      if (!isOwner) return false; // Fall through to the visitor welcome text.
      await api.sendMessage(
        fromId,
        "PM bot is running. Use /login to open the web console, " +
          "/help for the full command list.",
      );
      return true;

    case "/help":
      if (!isOwner) return false;
      await api.sendMessage(fromId, HELP_TEXT, { parse_mode: "HTML" });
      return true;

    case "/login": {
      if (!isOwner) return false;
      const nonce = await createLoginNonce(env);
      const url = `${origin.origin}/auth/${nonce}`;
      await api.sendMessage(
        fromId,
        `<a href="${escapeHtml(url)}">Open web console</a>\n\n` +
          "Single use, valid for 2 minutes. Run /login again for another link " +
          "(for example to open it on your desktop).",
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
      return true;
    }

    case "/revoke": {
      if (!isOwner) return false;
      const n = await revokeAllSessions(env);
      await api.sendMessage(fromId, `Revoked ${n} web session(s).`);
      return true;
    }

    case "/status": {
      if (!isOwner) return false;
      await api.sendMessage(fromId, await buildStatus(ctx, origin), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return true;
    }

    default:
      return false;
  }
}

/**
 * Establish ownership.
 *
 * The claim code is derived from the bot token, so computing it proves
 * possession of the token — and anyone with the token could redeploy the
 * Worker anyway. That makes re-claiming safe to allow, which in turn provides
 * a recovery path if the operator loses access to their account.
 *
 * The code carries 48 bits of entropy, so guessing it is infeasible even
 * before Telegram's own inbound rate limits are considered.
 */
async function handleClaim(
  ctx: BotContext,
  msg: Message,
  args: string,
  fromId: number,
): Promise<void> {
  const { env, api, settings } = ctx;
  const expected = await deriveClaimCode(env.BOT_TOKEN);

  // The claim code is a long-lived credential (it only changes with the bot
  // token), so remove it from the chat history either way.
  await api.deleteMessage(fromId, msg.message_id).catch(() => {});

  if (!args || !timingSafeEqual(args.trim().toLowerCase(), expected)) {
    // Before an owner exists, reply so a typo during setup is diagnosable.
    // Afterwards stay silent: a reply would confirm to any stranger that this
    // command exists and is worth probing.
    if (settings.ownerId === null) {
      await api
        // Deliberately terse: no hint about length or matching prefix.
        .sendMessage(fromId, "Invalid claim code.")
        .catch((e) => logError("claim-reject", e));
    }
    return;
  }

  const previous = settings.ownerId;
  await setSetting(env, "owner_id", String(fromId));

  // A transfer of ownership invalidates existing sessions; the previous owner
  // must not retain console access.
  if (previous !== null && previous !== fromId) {
    await revokeAllSessions(env);
    await api
      .sendMessage(
        previous,
        "⚠️ Ownership of this bot was transferred to another account. " +
          "Your web sessions have been revoked.",
      )
      .catch(() => {});
  }

  await api.sendMessage(
    fromId,
    `✅ You are now the owner (id <code>${fromId}</code>).\n\n` +
      "Next: create a group, enable Topics, add this bot as an admin with " +
      'the "Manage topics" permission, then run /login to bind it.',
    { parse_mode: "HTML" },
  );
}

/**
 * Commands the operator sends inside a topic in the relay group.
 * These act on whichever correspondent the topic belongs to.
 */
export async function handleRelayGroupCommand(
  ctx: BotContext,
  msg: Message,
): Promise<Handled> {
  const text = msg.text ?? "";
  if (!text.startsWith("/")) return false;

  const cmd = text.split(/[\s@]/)[0]!.toLowerCase();
  const args = commandArgs(text);
  const { env, api, settings } = ctx;
  const relayChatId = settings.relayChatId;
  if (relayChatId === null) return false;

  // Only the owner may run moderation commands, even if others are in the group.
  if (msg.from?.id !== settings.ownerId) {
    // Not a command we own; let it be relayed like any other message.
    return false;
  }

  // Resolve the target: an explicit id argument wins, otherwise the topic.
  const explicit = parseUserIdArg(args.split(/\s+/)[0]);
  const threadId = msg.message_thread_id ?? null;
  const topic = threadId
    ? await getTopicByThread(env, relayChatId, threadId)
    : null;
  const targetId = explicit ?? topic?.user_id ?? null;

  const reply = (t: string) =>
    api
      .sendMessage(relayChatId, t, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(threadId ? { message_thread_id: threadId } : {}),
      })
      .catch((e) => logError("cmd-reply", e));

  switch (cmd) {
    case "/ban": {
      if (targetId === null) {
        await reply("Usage: /ban [user_id] — inside a topic the id is optional.");
        return true;
      }
      const reason = explicit
        ? commandArgs(args).trim()
        : args.trim();
      await banUser(env, targetId, reason);
      await reply(
        `🚫 Banned <code>${targetId}</code>. Their messages will be dropped silently.`,
      );
      return true;
    }

    case "/unban": {
      if (targetId === null) {
        await reply("Usage: /unban [user_id]");
        return true;
      }
      const removed = await unbanUser(env, targetId);
      await reply(
        removed
          ? `✅ Unbanned <code>${targetId}</code>.`
          : `<code>${targetId}</code> was not banned.`,
      );
      return true;
    }

    case "/bans": {
      const bans = await listBans(env);
      if (bans.length === 0) {
        await reply("No banned users.");
        return true;
      }
      const lines = bans
        .slice(0, 50)
        .map(
          (b) =>
            `<code>${b.user_id}</code> ${escapeHtml(b.first_name || "?")}` +
            (b.reason ? ` — ${escapeHtml(b.reason)}` : ""),
        );
      await reply(`<b>Banned (${bans.length})</b>\n${lines.join("\n")}`);
      return true;
    }

    case "/info": {
      if (targetId === null) {
        await reply("Usage: /info [user_id] — inside a topic the id is optional.");
        return true;
      }
      const user = await getUser(env, targetId);
      if (!user) {
        await reply(`No record for <code>${targetId}</code>.`);
        return true;
      }
      await reply(buildInfoCard(user, await isBanned(env, targetId)));
      return true;
    }

    case "/del": {
      await handleDelete(ctx, msg, relayChatId, threadId);
      return true;
    }

    case "/id": {
      await reply(
        `Chat id: <code>${msg.chat.id}</code>\n` +
          `Thread id: <code>${threadId ?? "(General)"}</code>` +
          (targetId ? `\nCorrespondent: <code>${targetId}</code>` : ""),
      );
      return true;
    }

    default:
      return false;
  }
}

/**
 * Delete a message on both sides.
 *
 * This exists because Telegram provides no deletion update, so a real
 * "unsend" cannot be detected — it has to be an explicit command. Telegram
 * also refuses to delete anything older than 48 hours.
 */
async function handleDelete(
  ctx: BotContext,
  msg: Message,
  relayChatId: number,
  threadId: number | null,
): Promise<void> {
  const { env, api } = ctx;

  const reply = (t: string) =>
    api
      .sendMessage(relayChatId, t, {
        ...(threadId ? { message_thread_id: threadId } : {}),
      })
      .catch((e) => logError("del-reply", e));

  const target = msg.reply_to_message;
  if (!target) {
    await reply("Reply to the message you want to delete, then send /del.");
    return;
  }

  const mapping = await findByRelayMsg(env, relayChatId, target.message_id);
  if (!mapping) {
    await reply("That message is not in the relay map; nothing to delete.");
    return;
  }

  const errors: string[] = [];

  await api
    .deleteMessage(mapping.user_id, mapping.user_msg_id)
    .catch((e) => errors.push(`correspondent side: ${describe(e)}`));

  await api
    .deleteMessage(relayChatId, mapping.relay_msg_id)
    .catch((e) => errors.push(`relay side: ${describe(e)}`));

  await deleteMapping(env, relayChatId, mapping.relay_msg_id);

  // Remove the /del command itself so the topic stays clean.
  await api.deleteMessage(relayChatId, msg.message_id).catch(() => {});

  if (errors.length > 0) {
    await reply(
      `⚠️ Partially deleted. Telegram only allows deletion within 48 hours.\n${errors.join("\n")}`,
    );
  }
}

/** Inline keyboard buttons on the info card. */
export async function handleCallbackQuery(
  ctx: BotContext,
  query: CallbackQuery,
): Promise<void> {
  const { env, api, settings } = ctx;

  const answer = (text: string, alert = false) =>
    api
      .answerCallbackQuery(query.id, { text, show_alert: alert })
      .catch((e) => logError("answer-callback", e));

  // Authorise on the presser, never on the payload.
  if (query.from.id !== settings.ownerId) {
    await answer("Not authorised.", true);
    return;
  }

  const data = query.data ?? "";
  const sep = data.indexOf(":");
  const action = sep < 0 ? data : data.slice(0, sep);
  const targetId = parseUserIdArg(sep < 0 ? "" : data.slice(sep + 1));

  if (targetId === null) {
    await answer("Malformed action.", true);
    return;
  }

  switch (action) {
    case "ban": {
      await banUser(env, targetId, "via info card");
      await answer(`Banned ${targetId}.`, true);
      // Reflect the new state so the card is not misleading.
      const user = await getUser(env, targetId);
      if (user && query.message) {
        await api
          .editMessageText(
            query.message.chat.id,
            query.message.message_id,
            buildInfoCard(user, true),
            {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ Unban", callback_data: `unban:${targetId}` },
                    { text: "ℹ️ Info", callback_data: `info:${targetId}` },
                  ],
                ],
              },
            },
          )
          .catch((e) => logError("edit-card", e));
      }
      return;
    }

    case "unban": {
      await unbanUser(env, targetId);
      await answer(`Unbanned ${targetId}.`, true);
      const user = await getUser(env, targetId);
      if (user && query.message) {
        await api
          .editMessageText(
            query.message.chat.id,
            query.message.message_id,
            buildInfoCard(user, false),
            {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "🚫 Ban", callback_data: `ban:${targetId}` },
                    { text: "ℹ️ Info", callback_data: `info:${targetId}` },
                  ],
                ],
              },
            },
          )
          .catch((e) => logError("edit-card", e));
      }
      return;
    }

    case "info": {
      const user = await getUser(env, targetId);
      if (!user) {
        await answer("No record for this user.", true);
        return;
      }
      const banned = await isBanned(env, targetId);
      const topic = await getTopicByUser(env, targetId);
      await answer(
        [
          displayName(user),
          `id ${user.user_id}`,
          user.username ? `@${user.username}` : null,
          `${user.msg_count} messages`,
          topic ? `topic ${topic.thread_id}` : "no topic",
          banned ? "BANNED" : null,
          user.blocked_bot ? "blocked the bot" : null,
        ]
          .filter(Boolean)
          .join("\n"),
        true,
      );
      return;
    }

    default:
      await answer("Unknown action.", true);
  }
}

async function buildStatus(ctx: BotContext, origin: URL): Promise<string> {
  const { settings } = ctx;
  const lines = [
    "<b>Status</b>",
    `Owner: <code>${settings.ownerId ?? "unset"}</code>`,
    `Relay group: <code>${settings.relayChatId ?? "not bound"}</code>`,
    `Forward mode: ${settings.forwardMode}`,
    `Rate limit: ${
      settings.rateLimitEnabled
        ? `${settings.rateLimitMax} / ${settings.rateLimitWindow}s`
        : "off"
    }`,
    `Edit sync: ${settings.syncEdits ? "on" : "off"}`,
    `Media groups: ${settings.mediaGroupEnabled ? "on" : "off"}`,
    `Console: ${escapeHtml(origin.origin)}`,
  ];
  return lines.join("\n");
}

const HELP_TEXT = `<b>Owner commands (this chat)</b>
/login — one-time link to the web console
/status — current configuration
/revoke — invalidate every web session
/claim &lt;code&gt; — (re)establish ownership

<b>Inside a topic in the relay group</b>
/ban [id] [reason] — block a correspondent
/unban [id]
/bans — list blocked correspondents
/info [id] — identity and counters
/del — delete a message on both sides (reply to it first; 48h limit)
/id — show chat and thread ids

Deleting a message normally is <i>not</i> mirrored: Telegram sends no deletion
update to bots, so /del is the only way.`;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
