import { DurableObject } from "cloudflare:workers";
import { Api } from "grammy";
import { saveMappings } from "./db";
import type { Env } from "./types";

/**
 * Debounce window for album aggregation.
 *
 * Telegram delivers each item of a media group as a separate update. There is
 * no "album complete" signal, so we wait for a short quiet period after the
 * last item. 1200 ms comfortably covers normal delivery jitter while staying
 * imperceptible.
 */
const DEBOUNCE_MS = 1200;

/** forwardMessages / copyMessages accept at most 100 ids per call. */
const MAX_BATCH = 100;

interface BufferMeta {
  /** Where the album currently lives. */
  fromChatId: number;
  /** Where it should be delivered. */
  toChatId: number;
  /** Forum topic in the relay group, if any. */
  threadId: number | null;
  direction: "in" | "out";
  /** The correspondent this album belongs to. */
  userId: number;
  mediaGroupId: string;
  /**
   * 'in'  uses the configured forward mode.
   * 'out' must always copy: forwarding would reveal the relay group's name
   *       to the correspondent.
   */
  mode: "forward" | "copy";
}

/**
 * Buffers one media group and re-emits it as a single album.
 *
 * A stateless Worker cannot do this: the items arrive in separate invocations
 * with no shared memory. One Durable Object per `${chatId}:${mediaGroupId}`
 * gives us the required coordination point, and its alarm gives us the timer.
 */
export class MediaGroupBuffer extends DurableObject<Env> {
  /**
   * Add one item and (re)arm the flush alarm.
   *
   * Each new item pushes the alarm further out, so the flush fires only after
   * the group has gone quiet.
   */
  async add(meta: BufferMeta, messageId: number): Promise<void> {
    if (!messageId) return;

    const ids = ((await this.ctx.storage.get<number[]>("ids")) ?? []).slice();
    if (ids.includes(messageId)) return;
    ids.push(messageId);

    await this.ctx.storage.put("ids", ids);
    await this.ctx.storage.put("meta", meta);

    // A full album cannot grow further; flush at once instead of waiting.
    if (ids.length >= MAX_BATCH) {
      await this.ctx.storage.deleteAlarm();
      await this.flush();
      return;
    }

    await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
  }

  override async alarm(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    const meta = await this.ctx.storage.get<BufferMeta>("meta");
    const ids = await this.ctx.storage.get<number[]>("ids");

    // Clear state before the network call. A failed send is preferable to a
    // duplicated album if the alarm were retried.
    await this.ctx.storage.deleteAll();

    if (!meta || !ids || ids.length === 0) return;

    // Both methods require strictly increasing ids.
    const ordered = [...new Set(ids)].sort((a, b) => a - b);

    const api = new Api(this.env.BOT_TOKEN);

    try {
      const opts = {
        ...(meta.threadId ? { message_thread_id: meta.threadId } : {}),
      };

      const sent =
        meta.mode === "copy"
          ? await api.copyMessages(
              meta.toChatId,
              meta.fromChatId,
              ordered,
              opts,
            )
          : await api.forwardMessages(
              meta.toChatId,
              meta.fromChatId,
              ordered,
              opts,
            );

      // Both return an Array of MessageId, positionally matching the input.
      // If some were skipped the arrays diverge, so bail out of mapping rather
      // than record wrong pairs.
      if (sent.length !== ordered.length) return;

      await saveMappings(
        this.env,
        sent.map((m, i) => {
          const sourceId = ordered[i]!;
          return meta.direction === "in"
            ? {
                relay_chat_id: meta.toChatId,
                relay_msg_id: m.message_id,
                user_id: meta.userId,
                user_msg_id: sourceId,
                direction: "in" as const,
                media_group_id: meta.mediaGroupId,
              }
            : {
                relay_chat_id: meta.fromChatId,
                relay_msg_id: sourceId,
                user_id: meta.userId,
                user_msg_id: m.message_id,
                direction: "out" as const,
                media_group_id: meta.mediaGroupId,
              };
        }),
      );
    } catch (err) {
      console.error("media group flush failed", {
        mediaGroupId: meta.mediaGroupId,
        direction: meta.direction,
        count: ordered.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export type { BufferMeta };
