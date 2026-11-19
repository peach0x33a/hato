import type { ImageContent } from "@earendil-works/pi-ai";

export type ChannelName = "tg" | "qq" | "web";

export interface ChannelCapabilities {
  channel: ChannelName;
  maxBubblesPerTurn: number;
  supportsInlineConfirm: boolean;
  supportsDirectFileUpload: boolean;
  proactiveSupported: boolean;
}

export interface InboundAttachment {
  kind: "image" | "file" | "audio" | "sticker";
  filename?: string;
  mimeType?: string;
  localPath?: string;
  summary?: string;
  tgFileId?: string;
  tgFileUniqueId?: string;
  setName?: string;
  emoji?: string;
  isAnimated?: boolean;
}

export interface InboundMessage {
  channel: ChannelName;
  platformUserId: string;
  platformMsgId: string;
  canonicalUserId: string;
  replyToPlatformMsgId?: string;
  replyToText?: string;
  text: string;
  attachments: InboundAttachment[];
  images?: ImageContent[];
  timestampMs: number;
}

export interface InboundBatch {
  canonicalUserId: string;
  originChannel: ChannelName;
  originPlatformUserId: string;
  platformMsgIds: string[];
  latestPlatformMsgId: string;
  replyToPlatformMsgId?: string;
  combinedText: string;
  attachments: InboundAttachment[];
  images?: ImageContent[];
  firstTimestampMs: number;
  lastTimestampMs: number;
}

export interface OutboundConfirmAction {
  ticketId: string;
  promptText: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ChannelAdapter {
  readonly capabilities: ChannelCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendTyping?(platformUserId: string): Promise<void>;
  sendText(platformUserId: string, text: string, replyToPlatformMsgId?: string): Promise<string | undefined>;
  sendBubbles(
    platformUserId: string,
    bubbles: string[],
    delayRangeMs: [number, number],
    replyToPlatformMsgId?: string,
  ): Promise<void>;
  sendPhoto?(platformUserId: string, photo: Buffer | string, caption?: string): Promise<void>;
  sendSticker?(
    platformUserId: string,
    opts: { fileId?: string; localPath?: string; caption?: string },
  ): Promise<void>;
  sendFile?(platformUserId: string, localPath: string, filename: string, caption?: string): Promise<void>;
  sendConfirm?(platformUserId: string, confirm: OutboundConfirmAction): Promise<void>;
}
