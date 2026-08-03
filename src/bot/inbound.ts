import { GrammyError } from "grammy";
import type { Message } from "grammy/types";
import {
  getTopicByUser,
  isBanned,
  saveMapping,
  saveTopic,
  touchUser,
} from "../lib/db";
import { buildInfoCard, topicName } from "../lib/format";
import type { BotContext } from "./context";
import { isConfigured, logError } from "./context";

/**
 * Relay a message from a correspondent into their topic in the relay group.
 *
 * Ordering matters here: de-duplication and the ban check run before any
 * network call, and the user row is upserted before topic creation so the
 * info card can include accurate counters.
 */
export async function handleIncoming(
  ctx: BotContext,
  msg: Message,
): Promise<void> {
  const from = msg.from;
  if (!from || from.is_bot) return;

  const { env, api, settings } = ctx;

  // Banned users are dropped silently. Telling them would only invite evasion.
  if (await isBanned(env, from.id)) return;

  const touched = await touchUser(
    env,
    {
      userId: from.id,
      firstName: from.first_name ?? "",
      lastName: from.last_name ?? "",
      username: from.username ?? null,
      languageCode: from.language_code ?? null,
    },
    {
      enabled: settings.rateLimitEnabled,
      max: settings.rateLimitMax,
      windowSec: settings.rateLimitWindow,
    },
  );

  if (!isConfigured(settings)) {
    // Nowhere to relay to yet. Tell the operator once so this is not silent.
    if (settings.ownerId !== null && touched.isNew) {
      await api
        .sendMessage(
          settings.ownerId,
          "⚠️ A message arrived but no relay group is bound yet. " +
            "Open the web UI (/login) to bind one.",
        )
        .catch((e) => logError("notify-unconfigured", e));
    }
    return;
  }

  const relayChatId = settings.relayChatId;

  if (touched.rateLimited) {
    // Drop the message, but surface the situation to the operator exactly once
    // per window so a flood does not become its own flood.
    if (touched.justTripped) {
      const topic = await getTopicByUser(env, from.id);
      await api
        .sendMessage(
          relayChatId,
          `⚠️ Rate limit hit (${settings.rateLimitMax}/${settings.rateLimitWindow}s). ` +
            "Further messages in this window are dropped.",
          topic ? { message_thread_id: topic.thread_id } : {},
        )
        .catch((e) => logError("notify-ratelimit", e));
    }
    return;
  }

  const threadId = await ensureTopic(ctx, relayChatId, touched, from.id);

  // Media groups are buffered and re-emitted as one album by the Durable
  // Object; a stateless Worker cannot see the sibling items.
  if (msg.media_group_id && settings.mediaGroupEnabled) {
    const key = `${msg.chat.id}:${msg.media_group_id}`;
    const stub = env.MEDIA_GROUP.get(env.MEDIA_GROUP.idFromName(key));
    await stub.add(
      {
        fromChatId: msg.chat.id,
        toChatId: relayChatId,
        threadId,
        direction: "in",
        userId: from.id,
        mediaGroupId: msg.media_group_id,
        mode: settings.forwardMode,
      },
      msg.message_id,
    );
    return;
  }

  await relaySingle(ctx, relayChatId, threadId, msg, from.id);
}

/**
 * Send one message into the relay group, recreating the topic if it vanished.
 *
 * The operator can delete a topic at any time, and there is no update for it,
 * so a stale thread id is discovered only when a send fails.
 */
async function relaySingle(
  ctx: BotContext,
  relayChatId: number,
  threadId: number | null,
  msg: Message,
  userId: number,
  isRetry = false,
): Promise<void> {
  const { env, api, settings } = ctx;
  const opts = threadId ? { message_thread_id: threadId } : {};

  try {
    let relayMsgId: number;

    if (settings.forwardMode === "copy") {
      const res = await api.copyMessage(
        relayChatId,
        msg.chat.id,
        msg.message_id,
        opts,
      );
      relayMsgId = res.message_id;
    } else {
      const res = await api.forwardMessage(
        relayChatId,
        msg.chat.id,
        msg.message_id,
        opts,
      );
      relayMsgId = res.message_id;
    }

    await saveMapping(env, {
      relay_chat_id: relayChatId,
      relay_msg_id: relayMsgId,
      user_id: userId,
      user_msg_id: msg.message_id,
      direction: "in",
      media_group_id: msg.media_group_id ?? null,
    });
  } catch (err) {
    if (!isRetry && isMissingThread(err)) {
      const fresh = await recreateTopic(ctx, relayChatId, userId);
      await relaySingle(ctx, relayChatId, fresh, msg, userId, true);
      return;
    }
    logError("relay-in", err);
  }
}

/** Return the user's topic id, creating the topic and info card if needed. */
async function ensureTopic(
  ctx: BotContext,
  relayChatId: number,
  touched: Awaited<ReturnType<typeof touchUser>>,
  userId: number,
): Promise<number | null> {
  const { env } = ctx;

  const existing = await getTopicByUser(env, userId);
  if (existing && existing.chat_id === relayChatId) return existing.thread_id;

  return createTopicWithCard(ctx, relayChatId, touched.user, userId);
}

async function createTopicWithCard(
  ctx: BotContext,
  relayChatId: number,
  user: Awaited<ReturnType<typeof touchUser>>["user"],
  userId: number,
): Promise<number | null> {
  const { env, api } = ctx;

  try {
    const topic = await api.createForumTopic(relayChatId, topicName(user));
    await saveTopic(env, userId, relayChatId, topic.message_thread_id);

    // Sent once per conversation: full identity plus moderation shortcuts,
    // so subsequent messages stay clean.
    await api
      .sendMessage(relayChatId, buildInfoCard(user, false), {
        message_thread_id: topic.message_thread_id,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🚫 Ban", callback_data: `ban:${userId}` },
              { text: "ℹ️ Info", callback_data: `info:${userId}` },
            ],
          ],
        },
      })
      .catch((e) => logError("info-card", e));

    return topic.message_thread_id;
  } catch (err) {
    // Most likely cause: the bot is not an admin, or lacks can_manage_topics,
    // or the group is not a forum. Fall back to the General topic so messages
    // are never lost, and make the reason visible.
    logError("create-topic", err);
    await api
      .sendMessage(
        relayChatId,
        "⚠️ Could not create a topic. Check that this group has Topics " +
          "enabled and that the bot is an admin with the " +
          '"Manage topics" permission. Messages will land here meanwhile.',
      )
      .catch(() => {});
    return null;
  }
}

async function recreateTopic(
  ctx: BotContext,
  relayChatId: number,
  userId: number,
): Promise<number | null> {
  const user = await ctx.env.DB.prepare("SELECT * FROM users WHERE user_id = ?")
    .bind(userId)
    .first<Awaited<ReturnType<typeof touchUser>>["user"]>();
  if (!user) return null;
  return createTopicWithCard(ctx, relayChatId, user, userId);
}

/** Detect the "thread no longer exists" family of errors. */
function isMissingThread(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = err.description.toLowerCase();
  return (
    d.includes("message thread not found") ||
    d.includes("topic_deleted") ||
    d.includes("topic was deleted") ||
    d.includes("thread not found")
  );
}
