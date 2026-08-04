import { Api } from "grammy";
import type { ChatMemberUpdated, Update } from "grammy/types";
import {
  claimUpdate,
  isBanned,
  markBlockedBot,
  recordCandidateChat,
  removeCandidateChat,
  touchUser,
} from "../lib/db";
import type { Env, Settings } from "../lib/types";
import {
  handleCallbackQuery,
  handleOwnerPrivateCommand,
  handleRelayGroupCommand,
} from "./commands";
import type { BotContext } from "./context";
import { logError } from "./context";
import { handleEditedMessage } from "./edits";
import { handleIncoming } from "./inbound";
import { handleOutgoing } from "./outbound";
import { handleMessageReaction } from "./reactions";
import { handleHumanVerification, maybeHandleVerificationCallback } from "./verify";

/**
 * Update types we ask Telegram to send. Anything else is wasted work.
 *
 * `message_reaction` is not in Telegram's default set and must be requested
 * explicitly. Keep this list in sync with scripts/webhook.mjs.
 */
export const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "my_chat_member",
  "message_reaction",
] as const;

export async function processUpdate(
  env: Env,
  settings: Settings,
  update: Update,
  origin: URL,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  // Telegram redelivers on any non-2xx response and may redeliver anyway, so
  // every update is claimed exactly once before doing observable work.
  if (!(await claimUpdate(env, update.update_id))) return;

  const ctx: BotContext = {
    env,
    settings,
    api: new Api(env.BOT_TOKEN),
    waitUntil,
  };

  try {
    if (update.callback_query) {
      if (await maybeHandleVerificationCallback(ctx, update.callback_query)) {
        return;
      }
      await handleCallbackQuery(ctx, update.callback_query);
      return;
    }

    if (update.my_chat_member) {
      await handleMyChatMember(ctx, update.my_chat_member);
      return;
    }

    if (update.message_reaction) {
      await handleMessageReaction(ctx, update.message_reaction);
      return;
    }

    if (update.edited_message) {
      await handleEditedMessage(ctx, update.edited_message);
      return;
    }

    const msg = update.message;
    if (!msg) return;

    // Service messages (topic created, members joined, ...) carry no content
    // worth relaying and cannot be forwarded.
    if (isServiceMessage(msg)) return;

    const chatType = msg.chat.type;

    if (chatType === "private") {
      await handlePrivate(ctx, msg, origin);
      return;
    }

    if (
      settings.relayChatId !== null &&
      msg.chat.id === settings.relayChatId &&
      (chatType === "supergroup" || chatType === "group")
    ) {
      // Ignore the bot's own messages to avoid an echo loop.
      if (msg.from?.is_bot) return;

      if (await handleRelayGroupCommand(ctx, msg)) return;
      await handleOutgoing(ctx, msg);
    }
    // Messages in any other group are ignored outright.
  } catch (err) {
    // Never rethrow: a non-2xx webhook response would make Telegram redeliver
    // an update we have already partially handled.
    logError("process-update", err);
  }
}

async function handlePrivate(
  ctx: BotContext,
  msg: NonNullable<Update["message"]>,
  origin: URL,
): Promise<void> {
  const { env, api, settings } = ctx;
  const fromId = msg.from?.id;
  if (!fromId) return;

  const isOwner = settings.ownerId !== null && settings.ownerId === fromId;

  // Owner-only commands, including /claim which bootstraps ownership.
  if (await handleOwnerPrivateCommand(ctx, msg, origin)) return;

  // The owner's own private chat is a console, not a conversation to relay.
  if (isOwner) return;

  if (await handleHumanVerification(ctx, msg)) return;

  // A visitor's /start gets the configured greeting and is not relayed.
  if (msg.text?.startsWith("/start")) {
    // Banned users get nothing at all, not even the greeting: any reply
    // confirms the bot is alive and invites evasion.
    if (await isBanned(env, fromId)) return;

    await touchUser(
      env,
      {
        userId: fromId,
        firstName: msg.from?.first_name ?? "",
        lastName: msg.from?.last_name ?? "",
        username: msg.from?.username ?? null,
        languageCode: msg.from?.language_code ?? null,
      },
      // Counted but not rate-limited: /start is a single tap in the Telegram UI
      // and blocking it would look like the bot is broken.
      { enabled: false, max: 0, windowSec: 60 },
    );
    await api
      .sendMessage(fromId, settings.welcomeText)
      .catch((e) => logError("welcome", e));
    return;
  }

  await handleIncoming(ctx, msg);
}

/**
 * Track block/unblock and group membership.
 *
 * For private chats this update arrives only on block or unblock, which is the
 * one signal Telegram gives us about deliverability.
 */
async function handleMyChatMember(
  ctx: BotContext,
  ev: ChatMemberUpdated,
): Promise<void> {
  const { env, settings } = ctx;
  const status = ev.new_chat_member.status;

  if (ev.chat.type === "private") {
    // "kicked" is the wire value for ChatMemberBanned; in a private chat it
    // means the user blocked the bot.
    const blocked = status === "kicked" || status === "left";
    await markBlockedBot(env, ev.chat.id, blocked);

    if (settings.relayChatId !== null && settings.ownerId !== null) {
      const label = blocked ? "blocked" : "unblocked";
      await ctx.api
        .sendMessage(
          settings.ownerId,
          `ℹ️ User ${ev.chat.id} ${label} the bot.`,
        )
        .catch(() => {});
    }
    return;
  }

  // Group membership: remember forums we could be bound to, so the operator
  // never has to look up a numeric chat id by hand.
  if (ev.chat.type === "supergroup" || ev.chat.type === "group") {
    if (status === "left" || status === "kicked") {
      await removeCandidateChat(env, ev.chat.id);
      return;
    }

    const member = ev.new_chat_member;
    // Only an administrator carries granular rights; a creator has them all.
    const canManageTopics =
      member.status === "creator" ||
      (member.status === "administrator" && member.can_manage_topics === true);

    // `is_forum` is only present on supergroups, and only when true.
    const isForum = "is_forum" in ev.chat && ev.chat.is_forum === true;
    const title = ev.chat.title || String(ev.chat.id);

    await recordCandidateChat(env, {
      chat_id: ev.chat.id,
      title,
      type: ev.chat.type,
      is_forum: isForum ? 1 : 0,
      can_manage_topics: canManageTopics ? 1 : 0,
    });

    if (settings.ownerId !== null && settings.relayChatId === null) {
      await ctx.api
        .sendMessage(
          settings.ownerId,
          `ℹ️ Added to "${title}". ` +
            (isForum
              ? canManageTopics
                ? "Ready to bind — open the console with /login."
                : 'Grant the bot the "Manage topics" admin permission, then bind it.'
              : "This group does not have Topics enabled; enable them first."),
        )
        .catch(() => {});
    }
  }
}

/**
 * Service messages cannot be forwarded and carry no relayable content.
 * Checking a representative set is enough; anything missed simply gets
 * forwarded and fails harmlessly.
 */
function isServiceMessage(msg: NonNullable<Update["message"]>): boolean {
  return Boolean(
    msg.new_chat_members ||
      msg.left_chat_member ||
      msg.new_chat_title ||
      msg.new_chat_photo ||
      msg.delete_chat_photo ||
      msg.group_chat_created ||
      msg.supergroup_chat_created ||
      msg.channel_chat_created ||
      msg.message_auto_delete_timer_changed ||
      msg.migrate_to_chat_id ||
      msg.migrate_from_chat_id ||
      msg.pinned_message ||
      msg.forum_topic_created ||
      msg.forum_topic_edited ||
      msg.forum_topic_closed ||
      msg.forum_topic_reopened ||
      msg.general_forum_topic_hidden ||
      msg.general_forum_topic_unhidden ||
      msg.video_chat_scheduled ||
      msg.video_chat_started ||
      msg.video_chat_ended ||
      msg.video_chat_participants_invited ||
      msg.web_app_data ||
      msg.successful_payment ||
      msg.users_shared ||
      msg.chat_shared,
  );
}
