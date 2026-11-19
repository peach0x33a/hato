import { dirname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Bot, GrammyError, HttpError, InputFile, InlineKeyboard, type Context } from "grammy";
import { buildTelegramBotCommands } from "../commands/slash.js";
import {
  resolveGatewayRetryConfig,
  resolveMemoryEchoConfig,
  resolveMemoryProvider,
  type HatoConfig,
} from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { logError, logInfo, logWarn, summarizeError } from "../utils/logger.js";
import { retryWithBackoff } from "../utils/retry.js";
import {
  convertBufferToModelImage,
  formatTelegramStickerSummary,
  saveInboundMediaBuffer,
  selectTelegramStickerDownloadCandidates,
} from "./media.js";
import { formatGatewayMessageLog } from "./msg-log.js";
import { extractTelegramReplyText } from "./reply-context.js";
import { markdownToTelegramHtml } from "./tg-markdown.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundAttachment,
  InboundMessage,
  OutboundConfirmAction,
} from "./types.js";

export interface ClaimHomeParams {
  channel: "tg";
  platformUserId: string;
  code: string;
  username?: string;
}

export interface TelegramAdapterDeps {
  config: HatoConfig;
  botToken: string;
  proxyRouter: ScopedProxyRouter;
  onInboundMessage: (msg: InboundMessage) => void | Promise<void>;
  onConfirmAction?: (ticketId: string, approved: boolean, platformUserId: string) => Promise<string>;
  onClaimHome?: (params: ClaimHomeParams) => Promise<{ ok: boolean; reply: string }>;
}

/**
 * Parse `/sethome [pairing_code]` in a Telegram private message (supports optional @bot suffix).
 */
export function parseSethomeCommand(text: string): { isSethome: boolean; code: string | null } {
  const trimmed = text.trim();
  const match = /^\/sethome(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/i.exec(trimmed);
  if (!match) return { isSethome: false, code: null };
  return {
    isSethome: true,
    code: match[1] ? match[1].trim() : null,
  };
}

const TG_MAX_MESSAGE_LENGTH = 4000;

/**
 * Telegram Bot API gateway adapter backed by grammY.
 * Enforces owner private-chat whitelist, custom apiRoot, and gateway.telegram proxy scope.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly capabilities: ChannelCapabilities = {
    channel: "tg",
    maxBubblesPerTurn: 4,
    supportsInlineConfirm: true,
    supportsDirectFileUpload: true,
    proactiveSupported: true,
  };

  private readonly bot: Bot;
  private config: HatoConfig;
  private running = false;
  private connectedUsername: string | null = null;
  private lastCommandSyncSignature: string | null = null;

  constructor(private readonly deps: TelegramAdapterDeps) {
    this.config = deps.config;
    this.bot = new Bot(deps.botToken, {
      client: {
        apiRoot: deps.config.gateway.telegram.base_url,
        baseFetchConfig: {
          agent: (parsedUrl: URL) =>
            deps.proxyRouter.getNodeAgent(
              "gateway.telegram",
              parsedUrl.protocol === "http:" ? "http:" : "https:",
            ),
        } as NonNullable<ConstructorParameters<typeof Bot>[1]>["client"] extends infer C
          ? C extends { baseFetchConfig?: infer F }
            ? F
            : never
          : never,
      },
    });

    this.registerHandlers();
  }

  updateConfig(next: HatoConfig): void {
    this.config = next;
    if (this.running) {
      void this.syncBotCommands().catch((err) => {
        logWarn("TG", `dynamic command sync failed on config update: ${summarizeError(err)}`);
      });
    }
  }

  /**
   * Dynamically register Telegram Bot slash commands via setMyCommands/deleteMyCommands
   * based on whether owner is bound and which capabilities (e.g. long-term memory) are active.
   */
  async syncBotCommands(options?: { force?: boolean }): Promise<boolean> {
    const provider = resolveMemoryProvider(this.config);
    const memoryEnabled =
      provider === "memoryecho" ? resolveMemoryEchoConfig(this.config).enabled : provider !== "none";

    const ownerChatIds = [
      ...new Set(
        this.config.owner.channels.tg.user_ids
          .map((id) => Number(id))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
    ].sort((a, b) => a - b);

    const commands = buildTelegramBotCommands({
      memoryEnabled,
      unboundOnly: ownerChatIds.length === 0,
    });

    const signature = JSON.stringify({ ownerChatIds, commands });
    if (!options?.force && signature === this.lastCommandSyncSignature) {
      return false;
    }

    if (ownerChatIds.length === 0) {
      await this.runWithTelegramRetry(() =>
        this.bot.api.setMyCommands(commands, { scope: { type: "all_private_chats" } }),
      );
      await this.runWithTelegramRetry(() =>
        this.bot.api.deleteMyCommands({ scope: { type: "all_group_chats" } }),
      );
      this.lastCommandSyncSignature = signature;
      logInfo("TG", `synced ${commands.length} unbound pairing commands (all_private_chats)`);
      return true;
    }

    await this.runWithTelegramRetry(() =>
      this.bot.api.deleteMyCommands({ scope: { type: "default" } }),
    );
    await this.runWithTelegramRetry(() =>
      this.bot.api.deleteMyCommands({ scope: { type: "all_private_chats" } }),
    );
    await this.runWithTelegramRetry(() =>
      this.bot.api.deleteMyCommands({ scope: { type: "all_group_chats" } }),
    );

    for (const chatId of ownerChatIds) {
      await this.runWithTelegramRetry(() =>
        this.bot.api.setMyCommands(commands, { scope: { type: "chat", chat_id: chatId } }),
      );
    }

    this.lastCommandSyncSignature = signature;
    logInfo(
      "TG",
      `synced ${commands.length} bot commands for ${ownerChatIds.length} owner chat(s): /${commands.map((c) => c.command).join(", /")}`,
    );
    return true;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.config.gateway.telegram.mode === "webhook") {
      throw new Error("Telegram webhook mode is not wired yet; set gateway.telegram.mode = 'polling'");
    }
    this.running = true;
    // bot.start() runs long-polling until bot.stop() is invoked.
    void this.bot
      .start({
        drop_pending_updates: false,
        onStart: (info) => {
          this.connectedUsername = info.username ?? null;
          logInfo("TG", `connected as @${info.username} via ${this.config.gateway.telegram.base_url}`, {
            timeZone: this.config.owner.timezone,
          });
          void this.syncBotCommands().catch((err) => {
            logWarn("TG", `failed to register Telegram bot commands: ${summarizeError(err)}`);
          });
        },
      })
      .catch((err) => {
        if (this.running) {
          logError("TG", "polling error", err, {
            timeZone: this.config.owner.timezone,
          });
        }
      });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.connectedUsername = null;
    await this.bot.stop();
  }

  getStatus(): { running: boolean; online: boolean; username?: string } {
    return {
      running: this.running,
      online: this.running && this.connectedUsername !== null,
      username: this.connectedUsername ?? undefined,
    };
  }

  async sendTyping(platformUserId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(platformUserId), "typing");
  }

  async sendText(
    platformUserId: string,
    text: string,
    replyToPlatformMsgId?: string,
  ): Promise<string | undefined> {
    const chunks = splitTelegramText(text, TG_MAX_MESSAGE_LENGTH);
    let lastMsgId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const replyParameters =
        i === 0 && replyToPlatformMsgId ? { message_id: Number(replyToPlatformMsgId) } : undefined;
      const htmlChunk = markdownToTelegramHtml(chunk);
      let sent;
      if (htmlChunk.length <= TG_MAX_MESSAGE_LENGTH) {
        try {
          sent = await this.runWithTelegramRetry(() =>
            this.bot.api.sendMessage(Number(platformUserId), htmlChunk, {
              parse_mode: "HTML",
              reply_parameters: replyParameters,
            }),
          );
        } catch (err) {
          if (err instanceof GrammyError && err.error_code === 400) {
            logWarn("TG", `HTML parse fallback to plain text: ${err.description}`);
            sent = await this.runWithTelegramRetry(() =>
              this.bot.api.sendMessage(Number(platformUserId), chunk, {
                reply_parameters: replyParameters,
              }),
            );
          } else {
            throw err;
          }
        }
      } else {
        sent = await this.runWithTelegramRetry(() =>
          this.bot.api.sendMessage(Number(platformUserId), chunk, {
            reply_parameters: replyParameters,
          }),
        );
      }
      lastMsgId = String(sent.message_id);
    }
    console.log(
      formatGatewayMessageLog({
        direction: "outbound",
        channel: "tg",
        timeZone: this.config.owner.timezone,
        userSlug: this.config.owner.canonical_user_id,
        text,
      }),
    );
    return lastMsgId;
  }

  async sendBubbles(
    platformUserId: string,
    bubbles: string[],
    delayRangeMs: [number, number],
    replyToPlatformMsgId?: string,
  ): Promise<void> {
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i]!;
      if (i > 0) {
        await this.sendTyping(platformUserId).catch(() => undefined);
        await sleep(randomInt(delayRangeMs[0], delayRangeMs[1]));
      }
      await this.sendText(platformUserId, bubble, i === 0 ? replyToPlatformMsgId : undefined);
    }
  }

  async sendFile(platformUserId: string, localPath: string, filename: string, caption?: string): Promise<void> {
    await this.runWithTelegramRetry(() =>
      this.bot.api.sendDocument(Number(platformUserId), new InputFile(localPath, filename), {
        caption,
      }),
    );
    console.log(
      formatGatewayMessageLog({
        direction: "outbound",
        channel: "tg",
        timeZone: this.config.owner.timezone,
        userSlug: this.config.owner.canonical_user_id,
        text: caption ?? "",
        attachments: [{ kind: "file", filename }],
      }),
    );
  }

  async sendPhoto(platformUserId: string, photo: Buffer | string, caption?: string): Promise<void> {
    await this.runWithTelegramRetry(() =>
      this.bot.api.sendPhoto(Number(platformUserId), new InputFile(photo, "screenshot.png"), {
        caption: caption ? caption.slice(0, 1024) : undefined,
      }),
    );
    console.log(
      formatGatewayMessageLog({
        direction: "outbound",
        channel: "tg",
        timeZone: this.config.owner.timezone,
        userSlug: this.config.owner.canonical_user_id,
        text: caption ?? "",
        attachments: [{ kind: "image", filename: "screenshot.png" }],
      }),
    );
  }

  async sendSticker(
    platformUserId: string,
    opts: { fileId?: string; localPath?: string; caption?: string },
  ): Promise<void> {
    if (opts.fileId) {
      await this.runWithTelegramRetry(() =>
        this.bot.api.sendSticker(Number(platformUserId), opts.fileId!),
      );
      return;
    }
    if (opts.localPath) {
      if (opts.localPath.toLowerCase().endsWith(".webp")) {
        await this.runWithTelegramRetry(() =>
          this.bot.api.sendSticker(Number(platformUserId), new InputFile(opts.localPath!)),
        );
      } else {
        await this.sendPhoto(platformUserId, opts.localPath, opts.caption);
      }
    }
  }

  async getStickerSet(name: string) {
    return this.runWithTelegramRetry(() => this.bot.api.getStickerSet(name));
  }

  async downloadFileById(fileId: string): Promise<{ buffer: Buffer; filePath: string } | null> {
    return this.downloadTelegramFileBuffer(fileId);
  }

  async sendConfirm(platformUserId: string, confirm: OutboundConfirmAction): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text(confirm.confirmLabel ?? "✅ 确认执行", `hato_confirm:yes:${confirm.ticketId}`)
      .text(confirm.cancelLabel ?? "❌ 取消", `hato_confirm:no:${confirm.ticketId}`);
    await this.runWithTelegramRetry(() =>
      this.bot.api.sendMessage(Number(platformUserId), confirm.promptText, {
        reply_markup: keyboard,
      }),
    );
    console.log(
      formatGatewayMessageLog({
        direction: "outbound",
        channel: "tg",
        timeZone: this.config.owner.timezone,
        userSlug: this.config.owner.canonical_user_id,
        text: `[confirm:${confirm.ticketId}] ${confirm.promptText}`,
      }),
    );
  }

  private isAllowedPrivateOwner(ctx: Context): string | null {
    if (ctx.chat?.type !== "private" || !ctx.from) return null;
    const uid = String(ctx.from.id);
    const allowed = this.config.owner.channels.tg.user_ids.map((id) => String(id));
    return allowed.includes(uid) ? uid : null;
  }

  private registerHandlers(): void {
    this.bot.catch((err) => {
      logError("TG", "handler error", err.error, {
        timeZone: this.config.owner.timezone,
      });
    });

    this.bot.on("callback_query:data", async (ctx) => {
      const uid = this.isAllowedPrivateOwner(ctx);
      if (!uid) {
        await ctx.answerCallbackQuery({ text: "无权限", show_alert: true });
        return;
      }
      const match = /^hato_confirm:(yes|no):([a-zA-Z0-9_-]+)$/.exec(ctx.callbackQuery.data);
      if (!match || !this.deps.onConfirmAction) {
        await ctx.answerCallbackQuery();
        return;
      }
      const feedback = await this.deps.onConfirmAction(match[2]!, match[1] === "yes", uid);
      await ctx.answerCallbackQuery({ text: feedback });
    });

    this.bot.on("message", async (ctx) => {
      const msg = ctx.message;
      const text = (msg.text ?? msg.caption ?? "").trim();
      const uid = this.isAllowedPrivateOwner(ctx);
      if (!uid) {
        await this.tryHandleUnboundClaim(ctx, text);
        return;
      }

      const attachments = extractTelegramAttachments(ctx);
      if (!text && attachments.length === 0) return;

      console.log(
        formatGatewayMessageLog({
          direction: "inbound",
          channel: "tg",
          timeZone: this.config.owner.timezone,
          userSlug: this.config.owner.canonical_user_id,
          text,
          attachments,
        }),
      );

      const images = await this.loadInboundImages(ctx, attachments);

      await this.deps.onInboundMessage({
        channel: "tg",
        platformUserId: uid,
        platformMsgId: String(msg.message_id),
        canonicalUserId: this.config.owner.canonical_user_id,
        replyToPlatformMsgId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
        replyToText: extractTelegramReplyText(msg.reply_to_message),
        text,
        attachments,
        images: images.length > 0 ? images : undefined,
        timestampMs: msg.date * 1000,
      });
    });
  }

  /**
   * Handle `/sethome <code>` from a private chat only when tg.user_ids is still empty.
   * Never executes when at least one owner user_id is already configured.
   */
  async handlePrivateTextForClaim(params: {
    chatType: string;
    fromUserId: string;
    messageId: string;
    username?: string;
    text: string;
    replyFn: (replyText: string) => Promise<void>;
  }): Promise<boolean> {
    if (params.chatType !== "private") return false;
    if (this.config.owner.channels.tg.user_ids.length > 0 || !this.deps.onClaimHome) return false;

    const parsed = parseSethomeCommand(params.text);
    if (!parsed.isSethome) return false;

    const claimUserSlug = params.username ? `@${params.username}` : `tg:${params.fromUserId}`;
    console.log(
      formatGatewayMessageLog({
        direction: "inbound",
        channel: "tg",
        timeZone: this.config.owner.timezone,
        userSlug: claimUserSlug,
        text: parsed.code ? "/sethome ***" : "/sethome",
      }),
    );

    if (!parsed.code) {
      await params.replyFn(
        "当前 Bot 尚未绑定主人账号，请带上启动终端中显示的配对码发送：`/sethome <配对码>`",
      );
      return true;
    }

    const claimed = await this.deps.onClaimHome({
      channel: "tg",
      platformUserId: params.fromUserId,
      code: parsed.code,
      username: params.username,
    });
    await params.replyFn(claimed.reply);
    return true;
  }

  private async loadInboundImages(
    ctx: Context,
    attachments?: InboundAttachment[],
  ): Promise<ImageContent[]> {
    const msg = ctx.message;
    if (!msg) return [];

    const images: ImageContent[] = [];
    const dataDir = dirname(this.config.paths.sqlite);

    if (msg.sticker) {
      const candidates = selectTelegramStickerDownloadCandidates(msg.sticker);
      for (const candidate of candidates) {
        const downloaded = await this.downloadTelegramFileBuffer(candidate.fileId);
        if (!downloaded) continue;
        const img = await convertBufferToModelImage({
          buffer: downloaded.buffer,
          filePath: downloaded.filePath || candidate.fallbackExt,
        });
        if (img) {
          images.push(img);
          const stickerAtt = attachments?.find((a) => a.kind === "sticker" && !a.localPath);
          if (stickerAtt) {
            stickerAtt.localPath = saveInboundMediaBuffer(
              dataDir,
              downloaded.buffer,
              downloaded.filePath || candidate.fallbackExt,
            );
            stickerAtt.tgFileId = msg.sticker.file_id;
            stickerAtt.tgFileUniqueId = msg.sticker.file_unique_id;
            stickerAtt.setName = msg.sticker.set_name;
            stickerAtt.emoji = msg.sticker.emoji;
            stickerAtt.isAnimated = Boolean(msg.sticker.is_animated || msg.sticker.is_video);
          }
          break;
        }
      }
    }

    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1]!;
      const downloaded = await this.downloadTelegramFileBuffer(largest.file_id);
      if (downloaded) {
        const img = await convertBufferToModelImage({
          buffer: downloaded.buffer,
          filePath: downloaded.filePath || ".jpg",
        });
        if (img) {
          images.push(img);
          const photoAtt = attachments?.find((a) => a.kind === "image" && !a.localPath);
          if (photoAtt) {
            photoAtt.localPath = saveInboundMediaBuffer(
              dataDir,
              downloaded.buffer,
              downloaded.filePath || ".jpg",
            );
          }
        }
      }
    }

    return images;
  }

  private runWithTelegramRetry<T>(fn: () => Promise<T>): Promise<T> {
    return retryWithBackoff(fn, {
      policy: resolveGatewayRetryConfig(this.config),
      shouldRetry: isRetryableTelegramError,
      getRetryAfterMs: getTelegramRetryAfterMs,
    });
  }

  private async downloadTelegramFileBuffer(
    fileId: string,
  ): Promise<{ buffer: Buffer; filePath: string } | null> {
    try {
      const file = await this.runWithTelegramRetry(() => this.bot.api.getFile(fileId));
      if (!file.file_path) return null;
      if (typeof file.file_size === "number" && file.file_size > 10 * 1024 * 1024) {
        logWarn("TG", `skipped oversized Telegram file (${file.file_size} bytes): ${file.file_path}`, {
          timeZone: this.config.owner.timezone,
        });
        return null;
      }

      const apiRoot = this.config.gateway.telegram.base_url.replace(/\/+$/, "");
      const fileUrl = `${apiRoot}/file/bot${this.deps.botToken}/${file.file_path}`;
      const res = await this.runWithTelegramRetry(async () => {
        const response = await this.deps.proxyRouter.runWithScope("gateway.telegram", () =>
          fetch(fileUrl, { signal: AbortSignal.timeout(10_000) }),
        );
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`Telegram media HTTP ${response.status}`);
        }
        return response;
      });
      if (!res.ok) {
        logWarn("TG", `failed to download Telegram media HTTP ${res.status}: ${file.file_path}`, {
          timeZone: this.config.owner.timezone,
        });
        return null;
      }

      const arr = await res.arrayBuffer();
      return {
        buffer: Buffer.from(arr),
        filePath: file.file_path,
      };
    } catch (err) {
      logWarn("TG", `failed to load Telegram media (${fileId}): ${summarizeError(err)}`, {
        timeZone: this.config.owner.timezone,
      });
      return null;
    }
  }

  private async tryHandleUnboundClaim(ctx: Context, text: string): Promise<void> {
    if (!ctx.chat || !ctx.from || !ctx.message) return;
    await this.handlePrivateTextForClaim({
      chatType: ctx.chat.type,
      fromUserId: String(ctx.from.id),
      messageId: String(ctx.message.message_id),
      username: ctx.from.username,
      text,
      replyFn: async (replyText) => {
        await this.sendText(String(ctx.from!.id), replyText, String(ctx.message!.message_id));
      },
    });
  }
}

function extractTelegramAttachments(ctx: Context): InboundAttachment[] {
  const msg = ctx.message;
  if (!msg) return [];
  const list: InboundAttachment[] = [];

  if (msg.photo && msg.photo.length > 0) {
    list.push({ kind: "image", mimeType: "image/jpeg" });
  }
  if (msg.document) {
    list.push({
      kind: "file",
      filename: msg.document.file_name,
      mimeType: msg.document.mime_type,
    });
  }
  if (msg.voice) {
    list.push({ kind: "audio", mimeType: msg.voice.mime_type });
  }
  if (msg.sticker) {
    list.push({
      kind: "sticker",
      summary: formatTelegramStickerSummary(msg.sticker),
    });
  }
  return list;
}

function splitTelegramText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + limit));
    cursor += limit;
  }
  return chunks;
}

function randomInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/**
 * Determines whether a Telegram API or network error is transient and safe to retry silently.
 */
export function isRetryableTelegramError(err: unknown): boolean {
  if (err instanceof HttpError) {
    return true;
  }
  if (err instanceof GrammyError) {
    return err.error_code === 429 || err.error_code >= 500;
  }

  let cursor: unknown = err;
  for (let depth = 0; depth < 3 && cursor && typeof cursor === "object"; depth++) {
    const rec = cursor as {
      code?: unknown;
      errno?: unknown;
      error_code?: unknown;
      name?: unknown;
      message?: unknown;
      error?: unknown;
      cause?: unknown;
    };
    if (typeof rec.code === "string" && RETRYABLE_NETWORK_CODES.has(rec.code)) {
      return true;
    }
    if (typeof rec.errno === "string" && RETRYABLE_NETWORK_CODES.has(rec.errno)) {
      return true;
    }
    if (typeof rec.error_code === "number" && (rec.error_code === 429 || rec.error_code >= 500)) {
      return true;
    }
    if (typeof rec.name === "string" && (rec.name === "AbortError" || rec.name === "FetchError")) {
      return true;
    }
    if (
      typeof rec.message === "string" &&
      /ECONNRESET|ETIMEDOUT|socket disconnected|socket hang up|network request .* failed|Telegram media HTTP (?:429|5\d\d)|fetch failed/i.test(
        rec.message,
      )
    ) {
      return true;
    }
    cursor = rec.error ?? rec.cause;
  }

  return false;
}

/**
 * Extracts Telegram's server-requested `retry_after` delay (in ms) for HTTP 429 responses.
 */
export function getTelegramRetryAfterMs(err: unknown): number | undefined {
  if (err instanceof GrammyError && err.error_code === 429) {
    const sec = err.parameters?.retry_after;
    if (typeof sec === "number" && Number.isFinite(sec) && sec > 0) {
      return sec * 1000;
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
