import type { HatoRepository } from "../db/repo.js";
import type { ChannelName } from "./types.js";

export interface ReplyTextResolution {
  text: string | null;
  source: "platform" | "db" | "none";
}

export interface TelegramReplyMessageLike {
  text?: string;
  caption?: string;
}

/**
 * Extract plain/markdown text from a Telegram `reply_to_message` payload.
 */
export function extractTelegramReplyText(
  replyMsg: TelegramReplyMessageLike | null | undefined,
): string | undefined {
  if (!replyMsg) return undefined;
  const raw = replyMsg.text ?? replyMsg.caption;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the text content of a replied-to message.
 * Prefers the platform-supplied quoted text, then falls back to `raw_messages` by `platform_msg_id`.
 */
export function resolveReplyMessageText(params: {
  channel?: ChannelName;
  replyToPlatformMsgId?: string;
  replyToText?: string;
  repo?: Pick<HatoRepository, "findMessageByPlatformId">;
}): ReplyTextResolution {
  const direct = params.replyToText?.trim();
  if (direct) {
    return { text: direct, source: "platform" };
  }

  if (params.channel && params.replyToPlatformMsgId && params.repo) {
    const record = params.repo.findMessageByPlatformId(
      params.channel,
      params.replyToPlatformMsgId,
    );
    const stored = record?.content?.trim();
    if (stored) {
      return { text: stored, source: "db" };
    }
  }

  return { text: null, source: "none" };
}
