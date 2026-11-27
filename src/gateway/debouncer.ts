import type { ImageContent } from "@earendil-works/pi-ai";
import type { InboundAttachment, InboundBatch, InboundMessage } from "./types.js";

const MAX_BATCH_IMAGES = 4;

interface PendingBucket {
  messages: InboundMessage[];
  timer: NodeJS.Timeout;
}

export type BatchFlushHandler = (batch: InboundBatch) => void | Promise<void>;

/**
 * Coalesce consecutive fragmented messages from the same canonical user inside a
 * configurable debounce window into a single logical InboundBatch.
 */
export class MessageDebouncer {
  private readonly buckets = new Map<string, PendingBucket>();
  private debounceMs: number;
  private readonly onFlush: BatchFlushHandler;

  constructor(debounceMs: number, onFlush: BatchFlushHandler) {
    this.debounceMs = Math.max(0, debounceMs);
    this.onFlush = onFlush;
  }

  updateDelay(debounceMs: number): void {
    this.debounceMs = Math.max(0, debounceMs);
  }

  hasPending(canonicalUserId: string): boolean {
    return this.buckets.has(canonicalUserId);
  }

  /**
   * Discard any queued, un-flushed messages for a user (used by /new session reset).
   */
  discardUser(canonicalUserId: string): boolean {
    const bucket = this.buckets.get(canonicalUserId);
    if (!bucket) return false;
    clearTimeout(bucket.timer);
    this.buckets.delete(canonicalUserId);
    return true;
  }

  enqueue(message: InboundMessage): void {
    const key = message.canonicalUserId;
    const existing = this.buckets.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.timer = this.scheduleFlush(key);
      return;
    }

    if (this.debounceMs === 0) {
      void this.onFlush(mergeMessages([message]));
      return;
    }

    this.buckets.set(key, {
      messages: [message],
      timer: this.scheduleFlush(key),
    });
  }

  /**
   * Immediately flush a pending bucket for one user, or all pending buckets if omitted.
   */
  async flushNow(canonicalUserId?: string): Promise<void> {
    const keys = canonicalUserId ? [canonicalUserId] : [...this.buckets.keys()];
    for (const key of keys) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      clearTimeout(bucket.timer);
      this.buckets.delete(key);
      await this.onFlush(mergeMessages(bucket.messages));
    }
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      clearTimeout(bucket.timer);
    }
    this.buckets.clear();
  }

  private scheduleFlush(canonicalUserId: string): NodeJS.Timeout {
    return setTimeout(() => {
      const bucket = this.buckets.get(canonicalUserId);
      if (!bucket) return;
      this.buckets.delete(canonicalUserId);
      void this.onFlush(mergeMessages(bucket.messages));
    }, this.debounceMs);
  }
}

function mergeMessages(messages: InboundMessage[]): InboundBatch {
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const texts: string[] = [];
  const attachments: InboundAttachment[] = [];
  const images: ImageContent[] = [];
  const platformMsgIds: string[] = [];
  let replyToPlatformMsgId: string | undefined;
  let replyToText: string | undefined;

  for (const msg of messages) {
    platformMsgIds.push(msg.platformMsgId);
    if (msg.replyToPlatformMsgId) {
      replyToPlatformMsgId = msg.replyToPlatformMsgId;
      replyToText = msg.replyToText;
    } else if (msg.replyToText && !replyToText) {
      replyToText = msg.replyToText;
    }
    if (msg.text.trim()) {
      texts.push(msg.text.trim());
    }
    attachments.push(...msg.attachments);
    if (msg.images && images.length < MAX_BATCH_IMAGES) {
      for (const img of msg.images) {
        if (images.length >= MAX_BATCH_IMAGES) break;
        images.push(img);
      }
    }
  }

  return {
    canonicalUserId: first.canonicalUserId,
    originChannel: last.channel,
    originPlatformUserId: last.platformUserId,
    platformMsgIds,
    latestPlatformMsgId: last.platformMsgId,
    replyToPlatformMsgId,
    ...(replyToText ? { replyToText } : {}),
    combinedText: texts.join("\n"),
    attachments,
    images: images.length > 0 ? images : undefined,
    firstTimestampMs: first.timestampMs,
    lastTimestampMs: last.timestampMs,
  };
}

/**
 * Coalesce multiple InboundBatches queued for the same user into a single turn batch.
 */
export function mergeInboundBatches(batches: readonly InboundBatch[]): InboundBatch {
  if (batches.length === 0) {
    throw new Error("mergeInboundBatches requires at least one batch");
  }
  if (batches.length === 1) {
    return batches[0]!;
  }
  const first = batches[0]!;
  const last = batches[batches.length - 1]!;
  const texts: string[] = [];
  const attachments: InboundAttachment[] = [];
  const images: ImageContent[] = [];
  const platformMsgIds: string[] = [];
  let replyToPlatformMsgId: string | undefined;
  let replyToText: string | undefined;

  for (const batch of batches) {
    platformMsgIds.push(...batch.platformMsgIds);
    if (batch.replyToPlatformMsgId) {
      replyToPlatformMsgId = batch.replyToPlatformMsgId;
      replyToText = batch.replyToText;
    } else if (batch.replyToText && !replyToText) {
      replyToText = batch.replyToText;
    }
    if (batch.combinedText.trim()) {
      texts.push(batch.combinedText.trim());
    }
    attachments.push(...batch.attachments);
    if (batch.images && images.length < MAX_BATCH_IMAGES) {
      for (const img of batch.images) {
        if (images.length >= MAX_BATCH_IMAGES) break;
        images.push(img);
      }
    }
  }

  return {
    canonicalUserId: first.canonicalUserId,
    originChannel: last.originChannel,
    originPlatformUserId: last.originPlatformUserId,
    platformMsgIds,
    latestPlatformMsgId: last.latestPlatformMsgId,
    replyToPlatformMsgId,
    ...(replyToText ? { replyToText } : {}),
    combinedText: texts.join("\n"),
    attachments,
    images: images.length > 0 ? images : undefined,
    firstTimestampMs: first.firstTimestampMs,
    lastTimestampMs: last.lastTimestampMs,
  };
}
