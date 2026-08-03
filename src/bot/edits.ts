import type { Message } from "grammy/types";
import { findByRelayMsg, findByUserMsg } from "../lib/db";
import type { BotContext } from "./context";
import { logError } from "./context";

/**
 * Mirror an edit onto the relayed copy.
 *
 * Deletion cannot be mirrored: the Bot API has no "message deleted" update for
 * private chats or groups (only `deleted_business_messages`, which requires a
 * Business account connection). The `/del` command exists for that instead.
 */
export async function handleEditedMessage(
  ctx: BotContext,
  msg: Message,
): Promise<void> {
  const { env, api, settings } = ctx;
  if (!settings.syncEdits) return;

  const relayChatId = settings.relayChatId;
  if (relayChatId === null) return;

  const isFromRelayGroup = msg.chat.id === relayChatId;

  // An edited_message is identified by (chat.id, message_id) — identical to the
  // original — so the mapping lookup is a straight key read.
  const mapping = isFromRelayGroup
    ? await findByRelayMsg(env, relayChatId, msg.message_id)
    : msg.from
      ? await findByUserMsg(env, msg.from.id, msg.message_id)
      : null;

  if (!mapping) return;

  // Edit the counterpart, not the message that changed.
  const targetChatId = isFromRelayGroup ? mapping.user_id : relayChatId;
  const targetMsgId = isFromRelayGroup
    ? mapping.user_msg_id
    : mapping.relay_msg_id;

  try {
    if (msg.text !== undefined) {
      await api.editMessageText(targetChatId, targetMsgId, msg.text, {
        entities: msg.entities,
        link_preview_options: { is_disabled: true },
      });
    } else if (msg.caption !== undefined) {
      await api.editMessageCaption(targetChatId, targetMsgId, {
        caption: msg.caption,
        caption_entities: msg.caption_entities,
      });
    }
    // Media edits are intentionally not mirrored: editMessageMedia would need
    // the file to be re-specified and the album type rules make it unreliable.
  } catch (err) {
    // Routinely fails for benign reasons — the 48h edit window elapsed, or the
    // edit touched a field we do not mirror, so Telegram reports "not modified".
    logError("sync-edit", err);
  }
}
