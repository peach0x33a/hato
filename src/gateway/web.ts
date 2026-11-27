import type { IncomingMessage, ServerResponse } from "node:http";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { HatoRepository } from "../db/repo.js";
import { logError, summarizeError } from "../utils/logger.js";
import { formatGatewayMessageLog } from "./msg-log.js";
import type { ChannelCapabilities, InboundBatch } from "./types.js";

export const WEB_CHANNEL_CAPABILITIES: ChannelCapabilities = {
  channel: "web",
  maxBubblesPerTurn: 3,
  supportsInlineConfirm: true,
  supportsDirectFileUpload: false,
  proactiveSupported: false,
};

export interface WebChatGatewayDeps {
  getOwnerUserId: () => string;
  getTimezone: () => string;
  getBubbleConfig: () => { enabled: boolean; maxPerTurn: number; delimiter: string };
  splitBubbles: (
    text: string,
    opts: { enabled: boolean; maxPerTurn: number; delimiter: string },
  ) => string[];
  getRepo: () => HatoRepository;
  isPendingTakeover: () => boolean;
  getSlotViews: () => unknown[];
  getAvailableModels: () => string[];
  trySlashCommand: (params: {
    canonicalUserId: string;
    text: string;
  }) => Promise<{ text?: string; photo?: { buffer: Buffer; caption?: string } } | null>;
  handleChatTurn: (params: {
    batch: InboundBatch;
    images: ImageContent[];
    emit: (payload: Record<string, unknown>) => void;
  }) => Promise<void>;
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void;
}

/**
 * Web Console chat channel gateway (`FR_1`), decoupled from `WebConsoleServer` (`DP_7`)
 * and upper-layer orchestration modules via injected callbacks.
 */
export class WebChatGateway {
  readonly capabilities = WEB_CHANNEL_CAPABILITIES;

  constructor(private readonly deps: WebChatGatewayDeps) {}

  async handleHistory(url: URL, res: ServerResponse): Promise<void> {
    const repo = this.deps.getRepo();
    const uid = this.deps.getOwnerUserId();
    const bubbleCfg = this.deps.getBubbleConfig();
    const sessionId = url.searchParams.get("sessionId")?.trim() || "";

    let readonly = false;
    let session = null;
    let summaryText = "";
    let compactedUntilTs = 0;
    let rawMessages;

    if (sessionId) {
      const archived = repo.getSessionMessages(uid, sessionId);
      if (!archived) {
        this.deps.sendJson(res, 404, { ok: false, error: `未找到历史会话 ${sessionId}` });
        return;
      }
      readonly = true;
      session = archived.session;
      summaryText = archived.session.summaryText;
      compactedUntilTs = archived.session.endedAt;
      rawMessages = archived.messages;
    } else {
      const wm = repo.getWorkingMemory(uid);
      summaryText = wm.summaryText;
      compactedUntilTs = wm.compactedUntilTs;
      rawMessages = repo.getHotMessages(uid, wm.compactedUntilTs);
    }

    const visibleMessages = rawMessages.filter(
      (m) =>
        !(
          m.role === "executed_event" &&
          /^\[?工单\s/.test(m.content) &&
          !m.content.includes("等待确认执行")
        ),
    );

    const messages = visibleMessages.map((m) => ({
      ...m,
      bubbles:
        m.role === "assistant"
          ? this.deps.splitBubbles(m.content, {
              enabled: bubbleCfg.enabled,
              maxPerTurn: bubbleCfg.maxPerTurn,
              delimiter: bubbleCfg.delimiter,
            })
          : m.content
            ? [m.content]
            : [],
    }));

    this.deps.sendJson(res, 200, {
      ok: true,
      canonicalUserId: uid,
      readonly,
      session,
      summaryText,
      compactedUntilTs,
      pendingTakeover: this.deps.isPendingTakeover(),
      messages,
      slots: this.deps.getSlotViews(),
      availableModels: this.deps.getAvailableModels(),
    });
  }

  async handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.deps.readJsonBody(req)) as {
      text?: unknown;
      images?: Array<{ data?: unknown; mimeType?: unknown }>;
      replyToPlatformMsgId?: unknown;
      replyToText?: unknown;
    };

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const replyToPlatformMsgId =
      typeof body.replyToPlatformMsgId === "string" && body.replyToPlatformMsgId.trim()
        ? body.replyToPlatformMsgId.trim()
        : undefined;
    const replyToText =
      typeof body.replyToText === "string" && body.replyToText.trim()
        ? body.replyToText.trim()
        : undefined;
    const rawImages = Array.isArray(body.images) ? body.images : [];
    const loadedImages: ImageContent[] = rawImages
      .filter(
        (img): img is { data: string; mimeType: string } =>
          typeof img?.data === "string" &&
          img.data.length > 0 &&
          typeof img?.mimeType === "string" &&
          img.mimeType.startsWith("image/"),
      )
      .slice(0, 4)
      .map((img) => ({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
      }));

    if (!text && loadedImages.length === 0) {
      this.deps.sendJson(res, 400, { ok: false, error: "消息内容与图片不能同时为空" });
      return;
    }

    const uid = this.deps.getOwnerUserId();
    const timeZone = this.deps.getTimezone();
    const attachments = loadedImages.map((img, i) => ({
      kind: "image" as const,
      filename: `web-image-${i + 1}`,
      mimeType: img.mimeType,
    }));

    console.log(
      formatGatewayMessageLog({
        direction: "inbound",
        channel: "web",
        timeZone,
        userSlug: uid,
        text,
        attachments,
      }),
    );

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const emit = (payload: Record<string, unknown>) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    try {
      if (text.startsWith("/")) {
        const slashOut = await this.deps.trySlashCommand({
          canonicalUserId: uid,
          text,
        });
        if (slashOut !== null) {
          if (slashOut.photo) {
            const dataUrl = `data:image/png;base64,${slashOut.photo.buffer.toString("base64")}`;
            emit({ type: "photo", dataUrl, caption: slashOut.photo.caption });
          }
          if (slashOut.text !== undefined) {
            console.log(
              formatGatewayMessageLog({
                direction: "outbound",
                channel: "web",
                timeZone,
                userSlug: uid,
                text: slashOut.text,
              }),
            );
            emit({ type: "slash_reply", text: slashOut.text });
          }
          emit({ type: "done", pendingTakeover: this.deps.isPendingTakeover() });
          res.end();
          return;
        }
      }

      const now = Date.now();
      const msgId = `web_${now}`;
      const batch: InboundBatch = {
        canonicalUserId: uid,
        originChannel: "web",
        originPlatformUserId: uid,
        platformMsgIds: [msgId],
        latestPlatformMsgId: msgId,
        ...(replyToPlatformMsgId ? { replyToPlatformMsgId } : {}),
        ...(replyToText ? { replyToText } : {}),
        combinedText: text,
        attachments,
        images: loadedImages.length > 0 ? loadedImages : undefined,
        firstTimestampMs: now,
        lastTimestampMs: now,
      };

      await this.deps.handleChatTurn({
        batch,
        images: loadedImages,
        emit,
      });

      emit({ type: "done", pendingTakeover: this.deps.isPendingTakeover() });
    } catch (err) {
      logError("WEB", "chat turn failed", err);
      emit({ type: "error", message: summarizeError(err) });
    } finally {
      if (!res.writableEnded) res.end();
    }
  }
}
