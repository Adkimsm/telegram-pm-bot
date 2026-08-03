import { GrammyError } from "grammy";
import type { Message } from "grammy/types";
import {
  findByRelayMsg,
  getTopicByThread,
  markBlockedBot,
  saveMapping,
} from "../lib/db";
import type { BotContext } from "./context";
import { logError } from "./context";

/**
 * Relay the operator's message from a topic back to the correspondent.
 *
 * Always uses copyMessage, never forwardMessage: a forward would show
 * "Forwarded from <relay group>" to the correspondent, leaking the group's
 * name and the whole architecture.
 */
export async function handleOutgoing(
  ctx: BotContext,
  msg: Message,
): Promise<void> {
  const { env, settings } = ctx;
  const relayChatId = settings.relayChatId;
  if (relayChatId === null || msg.chat.id !== relayChatId) return;

  const threadId = msg.message_thread_id;
  // No thread id means the General topic, which is not bound to any
  // correspondent. Ignore it so notes there are never delivered by accident.
  if (!threadId) return;

  const topic = await getTopicByThread(env, relayChatId, threadId);
  if (!topic) return;

  const targetUserId = topic.user_id;

  if (msg.media_group_id && settings.mediaGroupEnabled) {
    const key = `out:${relayChatId}:${msg.media_group_id}`;
    const stub = env.MEDIA_GROUP.get(env.MEDIA_GROUP.idFromName(key));
    await stub.add(
      {
        fromChatId: relayChatId,
        toChatId: targetUserId,
        threadId: null,
        direction: "out",
        userId: targetUserId,
        mediaGroupId: msg.media_group_id,
        // Outbound must copy; see the note above.
        mode: "copy",
      },
      msg.message_id,
    );
    return;
  }

  // If the operator replied to a relayed message, mirror that as a real reply
  // in the correspondent's chat.
  let replyToUserMsgId: number | null = null;
  if (msg.reply_to_message) {
    const mapping = await findByRelayMsg(
      env,
      relayChatId,
      msg.reply_to_message.message_id,
    );
    if (mapping && mapping.user_id === targetUserId) {
      replyToUserMsgId = mapping.user_msg_id;
    }
  }

  await deliver(ctx, {
    relayChatId,
    relayMsgId: msg.message_id,
    targetUserId,
    replyToUserMsgId,
    mediaGroupId: msg.media_group_id ?? null,
  });
}

interface DeliverInput {
  relayChatId: number;
  relayMsgId: number;
  targetUserId: number;
  replyToUserMsgId: number | null;
  mediaGroupId: string | null;
}

async function deliver(
  ctx: BotContext,
  input: DeliverInput,
  withoutReply = false,
): Promise<void> {
  const { env, api } = ctx;

  const replyParams =
    input.replyToUserMsgId && !withoutReply
      ? { reply_parameters: { message_id: input.replyToUserMsgId } }
      : {};

  try {
    const res = await api.copyMessage(
      input.targetUserId,
      input.relayChatId,
      input.relayMsgId,
      replyParams,
    );

    await saveMapping(env, {
      relay_chat_id: input.relayChatId,
      relay_msg_id: input.relayMsgId,
      user_id: input.targetUserId,
      user_msg_id: res.message_id,
      direction: "out",
      media_group_id: input.mediaGroupId,
    });
  } catch (err) {
    // allow_sending_without_reply is always False for cross-chat replies, so a
    // stale target hard-fails instead of degrading. Retry without the reply
    // rather than dropping the operator's message.
    if (!withoutReply && input.replyToUserMsgId && isBadReply(err)) {
      await deliver(ctx, input, true);
      return;
    }

    if (isBlockedByUser(err)) {
      await markBlockedBot(env, input.targetUserId, true);
      await notifyFailure(
        ctx,
        input.relayChatId,
        input.relayMsgId,
        "❌ Not delivered: the user has blocked the bot.",
      );
      return;
    }

    logError("relay-out", err);
    await notifyFailure(
      ctx,
      input.relayChatId,
      input.relayMsgId,
      `❌ Not delivered: ${describeError(err)}`,
    );
  }
}

/**
 * Report a delivery failure as a reply to the offending message.
 *
 * Silent failure is the worst outcome here: the operator would believe they
 * had answered someone when they had not.
 */
async function notifyFailure(
  ctx: BotContext,
  relayChatId: number,
  relayMsgId: number,
  text: string,
): Promise<void> {
  await ctx.api
    .sendMessage(relayChatId, text, {
      reply_parameters: { message_id: relayMsgId, allow_sending_without_reply: true },
    })
    .catch((e) => logError("notify-failure", e));
}

function isBadReply(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = err.description.toLowerCase();
  return (
    d.includes("message to be replied not found") ||
    d.includes("reply message not found") ||
    d.includes("message_id_invalid")
  );
}

function isBlockedByUser(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = err.description.toLowerCase();
  return (
    d.includes("bot was blocked by the user") ||
    d.includes("user is deactivated") ||
    d.includes("chat not found")
  );
}

function describeError(err: unknown): string {
  if (err instanceof GrammyError) return err.description;
  return err instanceof Error ? err.message : String(err);
}
