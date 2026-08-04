import type { MessageReactionUpdated, ReactionType } from "grammy/types";
import { findByRelayMsg, findByUserMsg, isBanned } from "../lib/db";
import type { BotContext } from "./context";
import { logError } from "./context";

/**
 * Mirror emoji reactions between a correspondent's private chat and their
 * topic in the relay group.
 *
 * Verified empirically before building this: a bot does receive
 * `message_reaction` for one-on-one private chats, despite the reference
 * documentation saying "the bot must be an administrator in the chat" — that
 * clause only bites where the concept of an administrator exists.
 *
 * Note that `MessageReactionUpdated` carries no `message_thread_id`, so the
 * topic a reaction belongs to can only be recovered from our own mapping.
 */
export async function handleMessageReaction(
  ctx: BotContext,
  ev: MessageReactionUpdated,
): Promise<void> {
  const { settings } = ctx;
  if (!settings.syncReactions) return;

  const relayChatId = settings.relayChatId;
  if (relayChatId === null) return;

  // Anonymous reactions carry `actor_chat` instead of `user`. Mirroring one
  // would misattribute somebody else's reaction, so they are skipped.
  const actor = ev.user;
  if (!actor || actor.is_bot) return;

  const mirrorable = pickMirrorable(ev.new_reaction);

  if (ev.chat.type === "private") {
    await mirrorInbound(ctx, ev, actor.id, relayChatId, mirrorable);
    return;
  }

  if (ev.chat.id === relayChatId) {
    await mirrorOutbound(ctx, ev, actor.id, relayChatId, mirrorable);
  }
  // Reactions in any other chat are none of our business.
}

/** Correspondent reacted in their private chat -> reflect it in their topic. */
async function mirrorInbound(
  ctx: BotContext,
  ev: MessageReactionUpdated,
  actorId: number,
  relayChatId: number,
  mirrorable: ReactionType[],
): Promise<void> {
  const { env, settings } = ctx;

  // The owner's private chat is a console, not a conversation to relay.
  if (actorId === settings.ownerId) return;

  // The reaction has to come from the chat's own participant; a reaction by
  // anyone else in a private chat is not something we can attribute.
  if (ev.chat.id !== actorId) return;

  if (await isBanned(env, actorId)) return;

  const mapping = await findByUserMsg(env, actorId, ev.message_id);
  if (!mapping || mapping.relay_chat_id !== relayChatId) return;

  await apply(ctx, relayChatId, mapping.relay_msg_id, mirrorable, "reaction-in");
}

/** Owner reacted inside a topic -> reflect it in the correspondent's chat. */
async function mirrorOutbound(
  ctx: BotContext,
  ev: MessageReactionUpdated,
  actorId: number,
  relayChatId: number,
  mirrorable: ReactionType[],
): Promise<void> {
  const { env, settings } = ctx;

  // Only the owner's reactions are relayed. Without this check, a reaction by
  // any other group member would be sent onwards as though it were the
  // operator's.
  if (actorId !== settings.ownerId) return;

  const mapping = await findByRelayMsg(env, relayChatId, ev.message_id);
  if (!mapping) return;

  await apply(
    ctx,
    mapping.user_id,
    mapping.user_msg_id,
    mirrorable,
    "reaction-out",
  );
}

async function apply(
  ctx: BotContext,
  chatId: number,
  messageId: number,
  reaction: ReactionType[],
  scope: string,
): Promise<void> {
  try {
    // An empty list clears whatever the bot had set, which is how a removed
    // reaction propagates.
    await ctx.api.setMessageReaction(chatId, messageId, reaction);
  } catch (err) {
    // Routine failures: the message is too old, the chat forbids the emoji, or
    // the correspondent blocked the bot. None of these warrant surfacing.
    logError(scope, err);
  }
}

/**
 * Reduce a reaction list to what a bot can actually set.
 *
 * Three constraints, all from the Bot API:
 *  - "as non-premium users, bots can set up to one reaction per message", so a
 *    correspondent reacting with several emoji can only be partially conveyed;
 *  - a custom emoji is only usable if it is already on the target message or
 *    explicitly allowed by the chat's administrators, neither of which holds
 *    when mirroring across chats;
 *  - "Bots can't use paid reactions".
 *
 * Substituting a stand-in emoji for an unsupported one would convey the wrong
 * sentiment, so unsupported reactions are dropped rather than approximated.
 */
function pickMirrorable(reactions: ReactionType[]): ReactionType[] {
  const emoji = reactions.find((r) => r.type === "emoji");
  return emoji ? [emoji] : [];
}
