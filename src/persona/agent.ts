import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  createInitialSystemMessage,
  toToolDeclaration,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type ModelThinkingLevel,
  type Usage,
} from "@earendil-works/pi-ai";
import type { BrowserRuntime, SendPhotoToUserFn } from "../browser/runtime.js";
import {
  resolveLlmRetryConfig,
  resolveMemoryRecallConfig,
  resolvePromptDisabled,
  resolvePromptOrder,
  resolveSkillsDir,
  type HatoConfig,
} from "../config/app.js";
import { supportsCustomFetchOption, type ModelRegistry } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type { HatoRepository, RawMessageRecord } from "../db/repo.js";
import type { InboundBatch, InboundMessage } from "../gateway/types.js";
import type { McpClientPool } from "../mcp/pool.js";
import { shouldAutoRecall, type MemoryRecallItem, type MemoryStore } from "../memory/store.js";
import {
  formatSkillsIndexBlock,
  loadZoneSkills,
  type SkillEntry,
} from "../skills/loader.js";
import {
  aggregateAssistantTraceMetrics,
  computeTurnMetrics,
  extractTraceSteps,
  formatLlmTelemetryLog,
} from "../stats/metrics.js";
import type { LiveTraceTracker } from "../stats/live-trace.js";
import {
  formatLlmRetryNotice,
  streamSimpleWithRetry,
  type LlmRetryNotice,
} from "../utils/llm-retry.js";
import { logWarn, summarizeError } from "../utils/logger.js";
import { joinPersistedBubbles, splitIntoBubbles } from "./bubbles.js";
import {
  buildEphemeralContextBlock,
  buildStaticSystemPrompt,
  convertHatoMessagesToLlm,
  hydrateTranscriptFromDb,
  rawRecordToAgentMessage,
} from "./context.js";
import {
  buildInterruptedAssistantText,
  parsePureErrorInterruptionNotice,
  stripErrorInterruptionNotices,
  summarizeErrorForContext,
} from "./interruption.js";
import { loadLayeredPrompts, type LoadedLayeredPrompts } from "./prompts.js";
import { createPersonaReadOnlyTools } from "./tools.js";
import {
  buildToolIndexBlock,
  createActivateToolsTool,
  selectToolsForTurn,
} from "./tool-disclosure.js";

export const NO_REPLY_SENTINEL = "[NO_REPLY]";

export type ActiveTurnInterruptOutcome =
  | { action: "none" }
  | { action: "aborted" }
  | { action: "steered"; shouldSendAck: boolean };

interface ActivePersonaTurnState {
  canonicalUserId: string;
  hasToolActivity: boolean;
  abortedForSupersede: boolean;
  sentAnyBubble: boolean;
  sentSteerAck: boolean;
  promptSettled: boolean;
  unsentStopMsgExists: boolean;
  lastUserCreatedAt: number;
}

export interface PersonaTurnOutput {
  rawText: string;
  bubbles: string[];
  earlyBubbles: string[];
  silent: boolean;
  superseded: boolean;
  usage: Usage;
  toolCalls: string[];
  latencyMs: number;
  ttftMs: number;
  cacheHitRate: number;
  tps: number | null;
}

/**
 * Manages the stateful Persona pi-agent-core runtime, prefix-layered context,
 * multi-protocol scoped streaming, and cache-warm compaction summarization.
 */
export class PersonaRuntime {
  private readonly agent: Agent;
  private basePersonaPrompt = "";
  private layeredPrompts: LoadedLayeredPrompts | null = null;
  private personalSkills: SkillEntry[] = [];
  private personalSkillsIndexText = "";
  private allTools: AgentTool<any>[] = [];
  private toolIndexText = "";
  private readonly sessionTools = new Set<string>();
  private lastTimeCardSnapshot = "";
  private activeCallStartPerf: number | null = null;
  private activeBeforeToolHook: ((toolName: string, input: unknown) => Promise<void>) | null = null;
  private activeRetryNoticeHook: ((notice: LlmRetryNotice) => Promise<void>) | null = null;
  private activeTurnRecalledMemories: MemoryRecallItem[] = [];
  private activeTurnRecalledIds = new Set<string>();
  private activeTurn: ActivePersonaTurnState | null = null;
  private activeTurnEphemeralTail: {
    tailText: string;
    timeCardText: string;
    timestamp: number;
    anchorMessageId?: string;
    anchorAgentIndex?: number;
  } | null = null;
  private liveTraceTracker: LiveTraceTracker | null = null;
  private readonly pendingSupersededImages = new Map<string, ImageContent[]>();
  private reloadHandler: (() => Promise<void>) | null = null;
  private syncedCompactedUntilTs = 0;
  private pendingTranscriptRefresh = false;
  private delegateHandler:
    | ((input: {
        canonicalUserId: string;
        originChannel: InboundBatch["originChannel"];
        hint: string;
        urgency?: "normal" | "high";
        deliverFiles?: boolean;
      }) => { ticketId: string; status: string })
    | null = null;
  private imageGenHandler:
    | ((input: {
        canonicalUserId: string;
        originChannel: InboundBatch["originChannel"];
        prompt: string;
        model?: string;
        size?: string;
        quality?: string;
        n?: number;
        filename?: string;
        referenceImagePaths?: string[];
        deliverFiles?: boolean;
      }) => { ticketId: string; status: string })
    | null = null;
  private sendFileHandler:
    | ((input: {
        channel: InboundBatch["originChannel"];
        strictChannel?: boolean;
        path: string;
        caption?: string;
      }) => Promise<{ ok: boolean; message: string }>)
    | null = null;
  private sendMessageHandler:
    | ((input: {
        canonicalUserId: string;
        channel: InboundBatch["originChannel"];
        text?: string;
        filePath?: string;
        caption?: string;
      }) => Promise<{ ok: boolean; message: string }>)
    | null = null;
  private sensitiveFileConfirmHandler:
    | ((input: {
        canonicalUserId: string;
        channel: InboundBatch["originChannel"];
        strictChannel?: boolean;
        path: string;
        caption?: string;
        text?: string;
      }) => Promise<{ ok: boolean; ticketId?: string; message: string }>)
    | null = null;
  private activePhotoSender: SendPhotoToUserFn | null = null;
  private renderMarkdownImageHandler:
    | ((markdown: string, options?: { theme?: "light" | "dark" }) => Promise<Buffer>)
    | null = null;
  private botProfileHandler:
    | ((input: {
        platform: "tg" | "qq";
        action: "inspect" | "update" | "remove_avatar";
        name?: string;
        description?: string;
        shortDescription?: string;
        avatarPath?: string;
      }) => Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }>)
    | null = null;
  private stickerHandlers: {
    onSearch: (input: { canonicalUserId: string; query: string; emotion?: string; limit?: number }) => Promise<string>;
    onSend: (input: { canonicalUserId: string; stickerId: string; channel: InboundBatch["originChannel"]; strictChannel: boolean }) => Promise<{ ok: boolean; message: string }>;
    onSave: (input: { canonicalUserId: string; path?: string; packUrl?: string; note?: string; source?: "user_send" | "auto_save" }) => Promise<{ ok: boolean; message: string }>;
    onCollect: (input: { canonicalUserId: string; action: "start" | "stop" | "status" }) => Promise<{ ok: boolean; message: string }>;
  } | null = null;
  private activeTurnOriginChannel: InboundBatch["originChannel"] = "tg";

  constructor(
    private hatoConfig: HatoConfig,
    private readonly modelRegistry: ModelRegistry,
    private readonly proxyRouter: ScopedProxyRouter,
    private readonly repo: HatoRepository,
    private readonly browserRuntime?: BrowserRuntime,
    private memoryStore: MemoryStore | null = null,
    private readonly hatoConfigPath = "config/hato.toml",
    private readonly mcpPool: McpClientPool | null = null,
  ) {
    this.reloadPrompt();
    const resolved = this.modelRegistry.resolveSlot("persona");
    const canonicalUserId = this.hatoConfig.owner.canonical_user_id;
    this.allTools = this.buildPersonaTools();
    this.toolIndexText = buildToolIndexBlock(this.allTools);
    const tools = selectToolsForTurn({
      allTools: this.allTools,
      userText: "",
      hasPersonalSkills: this.personalSkills.length > 0,
    });

    const initialHistory = hydrateTranscriptFromDb(this.repo, canonicalUserId);
    this.syncedCompactedUntilTs = this.repo.getWorkingMemory(canonicalUserId).compactedUntilTs;

    this.agent = new Agent({
      initialState: {
        systemPrompt: buildStaticSystemPrompt(
          this.basePersonaPrompt,
          this.repo,
          this.personalSkillsIndexText,
          this.toolIndexText,
        ),
        model: resolved.model,
        thinkingLevel: this.modelRegistry.resolveSlotThinkingLevel("persona"),
        tools,
        messages: initialHistory,
      },
      steeringMode: "all",
      sessionId: canonicalUserId,
      getApiKey: (provider) => this.modelRegistry.resolveApiKeyForProvider(provider),
      streamFn: (model, context, options) => {
        const scopedFetch = this.proxyRouter.createScopedFetch(`llm-calling.${model.provider}`);
        return streamSimpleWithRetry(
          () => {
            this.activeCallStartPerf = performance.now();
            return this.proxyRouter.runWithScope(`llm-calling.${model.provider}`, () =>
              Promise.resolve(
                this.modelRegistry.models.streamSimple(model, context, {
                  ...options,
                  ...(supportsCustomFetchOption(model.api) ? { fetch: scopedFetch } : {}),
                }),
              ),
            );
          },
          {
            policy: resolveLlmRetryConfig(this.hatoConfig),
            signal: options?.signal,
            model,
            slot: "PERSONA",
            onRetryNotice: async (notice) => {
              await this.activeRetryNoticeHook?.(notice);
            },
          },
        );
      },
      transformContext: async (messages) => {
        const frozen = this.activeTurnEphemeralTail;
        if (frozen) {
          return [
            ...messages,
            {
              role: "hato_ephemeral_tail",
              text: frozen.tailText,
              timestamp: frozen.timestamp,
              anchorMessageId: frozen.anchorMessageId,
              anchorAgentIndex: frozen.anchorAgentIndex,
            },
          ];
        }
        const nowMs = Date.now();
        const { tailText, timeCardText } = buildEphemeralContextBlock({
          nowMs,
          repo: this.repo,
          canonicalUserId,
          baseTimezone: this.hatoConfig.owner.timezone,
          quietHours: this.hatoConfig.owner.quiet_hours,
          recalledMemories: this.activeTurnRecalledMemories,
        });
        this.lastTimeCardSnapshot = timeCardText;
        return [
          ...messages,
          {
            role: "hato_ephemeral_tail",
            text: tailText,
            timestamp: nowMs,
          },
        ];
      },
      prepareNextTurnWithContext: (lastTurn) => ({
        context: {
          ...lastTurn.context,
          tools: this.agent.state.tools.slice(),
        },
        thinkingLevel: this.agent.state.thinkingLevel,
      }),
      convertToLlm: (messages) => {
        return convertHatoMessagesToLlm(messages, {
          getTimezone: () => this.getEffectiveTimezone(canonicalUserId),
          gapMarkerThresholdMinutes: this.hatoConfig.context.gap_marker_threshold_minutes,
          modelApi: this.agent.state.model?.api,
        });
      },
    });
  }

  updateConfig(nextConfig: HatoConfig, nextMemoryStore?: MemoryStore | null): void {
    this.hatoConfig = nextConfig;
    if (nextMemoryStore !== undefined) {
      this.memoryStore = nextMemoryStore;
    }
    this.browserRuntime?.updateConfig(nextConfig);
    this.reloadPrompt();
    // Avoid clobbering in-flight agent.state.messages if triggered by self_config mid-turn.
    if (!this.activeTurn) {
      this.syncTools();
      this.refreshTranscriptFromDb();
    } else {
      this.pendingTranscriptRefresh = true;
    }
  }

  setReloadHandler(handler: (() => Promise<void>) | null): void {
    this.reloadHandler = handler;
  }

  setDelegateHandler(
    handler:
      | ((input: {
          canonicalUserId: string;
          originChannel: InboundBatch["originChannel"];
          hint: string;
          urgency?: "normal" | "high";
          deliverFiles?: boolean;
        }) => { ticketId: string; status: string })
      | null,
  ): void {
    this.delegateHandler = handler;
    if (!this.activeTurn) {
      this.syncTools();
      this.refreshTranscriptFromDb();
    }
  }

  setImageGenHandler(
    handler:
      | ((input: {
          canonicalUserId: string;
          originChannel: InboundBatch["originChannel"];
          prompt: string;
          model?: string;
          size?: string;
          quality?: string;
          n?: number;
          filename?: string;
          referenceImagePaths?: string[];
          deliverFiles?: boolean;
        }) => { ticketId: string; status: string })
      | null,
  ): void {
    this.imageGenHandler = handler;
    if (!this.activeTurn) {
      this.syncTools();
      this.refreshTranscriptFromDb();
    }
  }

  setSendFileHandler(
    handler:
      | ((input: {
          channel: InboundBatch["originChannel"];
          strictChannel?: boolean;
          path: string;
          caption?: string;
        }) => Promise<{ ok: boolean; message: string }>)
      | null,
  ): void {
    this.sendFileHandler = handler;
    if (!this.activeTurn) {
      this.syncTools();
    }
  }

  setRenderMarkdownImageHandler(
    handler:
      | ((markdown: string, options?: { theme?: "light" | "dark" }) => Promise<Buffer>)
      | null,
  ): void {
    this.renderMarkdownImageHandler = handler;
    if (!this.activeTurn) {
      this.syncTools();
    }
  }

  setSendMessageHandler(
    handler:
      | ((input: {
          canonicalUserId: string;
          channel: InboundBatch["originChannel"];
          text?: string;
          filePath?: string;
          caption?: string;
        }) => Promise<{ ok: boolean; message: string }>)
      | null,
  ): void {
    this.sendMessageHandler = handler;
    if (!this.activeTurn) {
      this.syncTools();
    }
  }

  setSensitiveFileConfirmHandler(
    handler:
      | ((input: {
          canonicalUserId: string;
          channel: InboundBatch["originChannel"];
          strictChannel?: boolean;
          path: string;
          caption?: string;
          text?: string;
        }) => Promise<{ ok: boolean; ticketId?: string; message: string }>)
      | null,
  ): void {
    this.sensitiveFileConfirmHandler = handler;
    if (!this.activeTurn) {
      this.syncTools();
    }
  }

  setStickerHandlers(
    handlers: {
      onSearch: (input: { canonicalUserId: string; query: string; emotion?: string; limit?: number }) => Promise<string>;
      onSend: (input: { canonicalUserId: string; stickerId: string; channel: InboundBatch["originChannel"]; strictChannel: boolean }) => Promise<{ ok: boolean; message: string }>;
      onSave: (input: { canonicalUserId: string; path?: string; packUrl?: string; note?: string; source?: "user_send" | "auto_save" }) => Promise<{ ok: boolean; message: string }>;
      onCollect: (input: { canonicalUserId: string; action: "start" | "stop" | "status" }) => Promise<{ ok: boolean; message: string }>;
    } | null,
  ): void {
    this.stickerHandlers = handlers;
    if (!this.activeTurn) {
      this.syncTools();
    }
  }

  setBotProfileHandler(
    handler:
      | ((input: {
          platform: "tg" | "qq";
          action: "inspect" | "update" | "remove_avatar";
          name?: string;
          description?: string;
          shortDescription?: string;
          avatarPath?: string;
        }) => Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }>)
      | null,
  ): void {
    this.botProfileHandler = handler;
    if (!this.activeTurn) {
      this.syncTools();
    }
  }

  setMemoryStore(nextMemoryStore: MemoryStore | null): void {
    this.memoryStore = nextMemoryStore;
  }

  setLiveTraceTracker(tracker: LiveTraceTracker | null): void {
    this.liveTraceTracker = tracker;
  }

  reloadPrompt(): void {
    this.layeredPrompts = loadLayeredPrompts(
      this.hatoConfig.paths.prompts_dir,
      resolvePromptOrder(this.hatoConfig),
      resolvePromptDisabled(this.hatoConfig),
    );
    this.basePersonaPrompt = this.layeredPrompts.combinedText;
    this.personalSkills = loadZoneSkills(resolveSkillsDir(this.hatoConfig), "personal");
    this.personalSkillsIndexText = formatSkillsIndexBlock(this.personalSkills);
  }

  syncTools(): void {
    this.allTools = this.buildPersonaTools();
    this.toolIndexText = buildToolIndexBlock(this.allTools);
    this.agent.state.tools = selectToolsForTurn({
      allTools: this.allTools,
      userText: "",
      hasPersonalSkills: this.personalSkills.length > 0,
      previouslyActivated: this.sessionTools,
    });
  }

  getToolIndexText(): string {
    return this.toolIndexText;
  }

  getPersonalSkills(): readonly SkillEntry[] {
    return this.personalSkills;
  }

  getLayeredPrompts(): LoadedLayeredPrompts | null {
    return this.layeredPrompts;
  }

  getBasePersonaPrompt(): string {
    return this.basePersonaPrompt;
  }

  refreshTranscriptFromDb(): void {
    const canonicalUserId = this.hatoConfig.owner.canonical_user_id;
    const systemPromptText = buildStaticSystemPrompt(
      this.basePersonaPrompt,
      this.repo,
      this.personalSkillsIndexText,
      this.toolIndexText,
    );
    const leadingSystem = createInitialSystemMessage(
      systemPromptText,
      this.agent.state.tools.map(toToolDeclaration),
    );
    const history = hydrateTranscriptFromDb(this.repo, canonicalUserId);
    this.agent.state.messages = leadingSystem ? [leadingSystem, ...history] : history;
    this.syncedCompactedUntilTs = this.repo.getWorkingMemory(canonicalUserId).compactedUntilTs;
    this.pendingTranscriptRefresh = false;
  }

  private syncTranscriptIfDrifted(canonicalUserId: string): void {
    const wm = this.repo.getWorkingMemory(canonicalUserId);
    if (wm.compactedUntilTs !== this.syncedCompactedUntilTs) {
      this.refreshTranscriptFromDb();
    }
  }

  private pruneTurnPayloadBloat(): void {
    const messages = this.agent.state.messages;
    if (messages.length === 0) return;

    let changed = false;
    const pruned = messages.map((msg): AgentMessage => {
      if (msg.role === "hato_user_batch") {
        if (msg.images.length > 0) {
          changed = true;
          return { ...msg, images: [] };
        }
        return msg;
      }

      if (msg.role === "user" && Array.isArray(msg.content)) {
        const hasImage = msg.content.some((part) => part.type === "image");
        if (!hasImage) return msg;
        changed = true;
        const filtered = msg.content.filter((part) => part.type !== "image");
        return {
          ...msg,
          content:
            filtered.length > 0
              ? filtered
              : [{ type: "text", text: "[历史图片内容已省略]" }],
        };
      }

      if (msg.role === "toolResult" && Array.isArray(msg.content)) {
        const hasImage = msg.content.some((part) => part.type === "image");
        if (!hasImage) return msg;
        changed = true;
        const filtered = msg.content.filter((part) => part.type !== "image");
        return {
          ...msg,
          content:
            filtered.length > 0
              ? filtered
              : [{ type: "text", text: "[工具返回的历史图片已省略]" }],
        };
      }

      return msg;
    });

    if (changed) {
      this.agent.state.messages = pruned;
    }
  }

  private buildPersonaTools(): AgentTool<any>[] {
    const canonicalUserId = this.hatoConfig.owner.canonical_user_id;
    const activateToolsTool = createActivateToolsTool({
      getAllTools: () => this.allTools,
      getActiveTools: () => this.agent.state.tools,
      setActiveTools: (nextTools) => {
        this.agent.state.tools = nextTools;
      },
      onActivated: (names) => {
        for (const n of names) this.sessionTools.add(n);
      },
    });
    return createPersonaReadOnlyTools({
      repo: this.repo,
      canonicalUserId,
      getTimezone: () => this.getEffectiveTimezone(canonicalUserId),
      getHatoConfig: () => this.hatoConfig,
      proxyRouter: this.proxyRouter,
      browserRuntime: this.browserRuntime,
      getMemoryStore: () => this.memoryStore,
      enableReadSkillTool: this.personalSkills.length > 0,
      extraTools: [
        activateToolsTool,
        ...(this.mcpPool?.getToolsForZone("personal") ?? []),
      ],
      ...(this.delegateHandler
        ? {
            onDelegate: (input: { hint: string; urgency?: "normal" | "high"; deliverFiles?: boolean }) =>
              this.delegateHandler!({
                canonicalUserId,
                originChannel: this.activeTurnOriginChannel,
                hint: input.hint,
                urgency: input.urgency,
                deliverFiles: input.deliverFiles,
              }),
          }
        : {}),
      ...(this.imageGenHandler
        ? {
            onImageGen: (input: {
              prompt: string;
              model?: string;
              size?: string;
              quality?: string;
              n?: number;
              filename?: string;
              referenceImagePaths?: string[];
              deliverFiles?: boolean;
            }) =>
              this.imageGenHandler!({
                canonicalUserId,
                originChannel: this.activeTurnOriginChannel,
                prompt: input.prompt,
                model: input.model,
                size: input.size,
                quality: input.quality,
                n: input.n,
                filename: input.filename,
                referenceImagePaths: input.referenceImagePaths,
                deliverFiles: input.deliverFiles,
              }),
          }
        : {}),
      ...(this.sendFileHandler
        ? {
            onSendFile: (input: {
              path: string;
              caption?: string;
              channel?: "current" | "tg" | "qq";
            }) => {
              const explicit = input.channel && input.channel !== "current" ? input.channel : undefined;
              return this.sendFileHandler!({
                channel: explicit ?? this.activeTurnOriginChannel,
                strictChannel: Boolean(explicit),
                path: input.path,
                caption: input.caption,
              });
            },
          }
        : {}),
      ...(this.sendMessageHandler
        ? {
            onSendMessage: (input: {
              channel: InboundBatch["originChannel"];
              text?: string;
              filePath?: string;
              caption?: string;
            }) =>
              this.sendMessageHandler!({
                canonicalUserId,
                channel: input.channel,
                text: input.text,
                filePath: input.filePath,
                caption: input.caption,
              }),
          }
        : {}),
      ...(this.sensitiveFileConfirmHandler
        ? {
            onRequestSensitiveFileConfirm: (input: {
              channel: "current" | "tg" | "qq" | "web";
              path: string;
              caption?: string;
              text?: string;
            }) => {
              const explicit = input.channel !== "current" ? input.channel : undefined;
              return this.sensitiveFileConfirmHandler!({
                canonicalUserId,
                channel: explicit ?? this.activeTurnOriginChannel,
                strictChannel: Boolean(explicit),
                path: input.path,
                caption: input.caption,
                text: input.text,
              });
            },
          }
        : {}),
      ...(this.botProfileHandler ? { onBotProfile: this.botProfileHandler } : {}),
      ...(this.renderMarkdownImageHandler
        ? {
            onRenderMarkdownImage: async (input: {
              markdown: string;
              theme?: "light" | "dark";
              caption?: string;
            }) => {
              if (!this.activePhotoSender) {
                return { ok: false, message: "当前对话渠道暂不支持直接发送图片。" };
              }
              try {
                const buffer = await this.renderMarkdownImageHandler!(input.markdown, {
                  theme: input.theme ?? "light",
                });
                await this.activePhotoSender(buffer, input.caption);
                return {
                  ok: true,
                  message: "已将 Markdown 渲染为图片并发送给用户。",
                  bytes: buffer.byteLength,
                };
              } catch (err) {
                return {
                  ok: false,
                  message: `渲染或发送图片失败：${err instanceof Error ? err.message : String(err)}`,
                };
              }
            },
          }
        : {}),
      ...(this.stickerHandlers
        ? {
            onStickerSearch: (input: { query: string; emotion?: string; limit?: number }) =>
              this.stickerHandlers!.onSearch({
                canonicalUserId,
                query: input.query,
                emotion: input.emotion,
                limit: input.limit,
              }),
            onSendSticker: (input: { stickerId: string; channel?: "current" | "tg" | "qq" }) => {
              const explicit = input.channel && input.channel !== "current" ? input.channel : undefined;
              return this.stickerHandlers!.onSend({
                canonicalUserId,
                stickerId: input.stickerId,
                channel: explicit ?? this.activeTurnOriginChannel,
                strictChannel: Boolean(explicit),
              });
            },
            onStickerSave: (input: {
              path?: string;
              packUrl?: string;
              note?: string;
              source?: "user_send" | "auto_save";
            }) =>
              this.stickerHandlers!.onSave({
                canonicalUserId,
                path: input.path,
                packUrl: input.packUrl,
                note: input.note,
                source: input.source,
              }),
            onStickerCollect: (input: { action: "start" | "stop" | "status" }) =>
              this.stickerHandlers!.onCollect({
                canonicalUserId,
                action: input.action,
              }),
          }
        : {}),
      selfConfigDeps: {
        hatoConfigPath: this.hatoConfigPath,
        getHatoConfig: () => this.hatoConfig,
        getModelRegistry: () => this.modelRegistry,
        repo: this.repo,
        onThinkingUpdated: (slot, effectiveLevel) => {
          if (slot === "persona") {
            this.agent.state.thinkingLevel = effectiveLevel as ModelThinkingLevel;
          }
        },
        onReloadRuntime: async () => {
          if (this.activeTurn) {
            this.pendingTranscriptRefresh = true;
          }
          if (this.reloadHandler) {
            await this.reloadHandler();
          } else {
            this.reloadPrompt();
            if (!this.activeTurn) {
              this.syncTools();
              this.refreshTranscriptFromDb();
            }
          }
        },
      },
      onSetThinkingLevel: (input) => {
        const targetSlot = input.slot ?? "persona";
        const scope: "persist" | "turn" =
          input.scope === "turn" && targetSlot === "persona" ? "turn" : "persist";
        if (scope === "turn") {
          const resolved = this.modelRegistry.resolveSlot("persona");
          const effective = this.modelRegistry.resolveSlotThinkingLevel(
            "persona",
            input.level === "auto" ? undefined : (input.level as ModelThinkingLevel),
          );
          this.agent.state.thinkingLevel = effective;
          return {
            ok: true,
            slot: "persona",
            requested: input.level,
            effective,
            scope: "turn",
            reasoningSupported: Boolean(resolved.model.reasoning),
          };
        }
        const updated = this.modelRegistry.setSlotThinkingOverride(
          targetSlot,
          input.level === "auto" ? null : input.level,
        );
        if (updated.slot === "persona") {
          this.agent.state.thinkingLevel = updated.effective;
        }
        return {
          ok: true,
          slot: updated.slot,
          requested: input.level,
          effective: updated.effective,
          scope: "persist",
          reasoningSupported: updated.reasoningSupported,
        };
      },
      onMemoryRecalled: (ids) => {
        for (const id of ids) this.activeTurnRecalledIds.add(id);
      },
      onBeforeToolExecute: async (toolName, input) => {
        if (this.activeBeforeToolHook) {
          await this.activeBeforeToolHook(toolName, input);
        }
      },
    });
  }

  /**
   * Reset in-memory session transcript and cached turn snapshot after /new.
   */
  resetSession(): void {
    this.lastTimeCardSnapshot = "";
    this.pendingSupersededImages.clear();
    this.sessionTools.clear();
    this.agent.clearAllQueues();
    this.agent.state.tools = selectToolsForTurn({
      allTools: this.allTools,
      userText: "",
      hasPersonalSkills: this.personalSkills.length > 0,
    });
    this.refreshTranscriptFromDb();
  }

  /**
   * Handle a new user message arriving while a Persona turn is active:
   * - Before any tool call or sent bubble: abort stale generation so messages merge & re-think.
   * - During an active tool / long-task turn: preserve progress and steer the new message into
   *   the live agent loop (sending "知道了" at most once per turn).
   */
  handleIncomingDuringActiveTurn(msg: InboundMessage): ActiveTurnInterruptOutcome {
    const turn = this.activeTurn;
    if (!turn || turn.canonicalUserId !== msg.canonicalUserId || turn.promptSettled) {
      return { action: "none" };
    }

    if (!turn.hasToolActivity && !turn.sentAnyBubble) {
      turn.abortedForSupersede = true;
      this.agent.abort();
      return { action: "aborted" };
    }

    const createdAt = Math.max(msg.timestampMs, Date.now(), turn.lastUserCreatedAt + 1);
    turn.lastUserCreatedAt = createdAt;

    const savedSteerMsg = this.repo.appendRawMessage({
      canonicalUserId: msg.canonicalUserId,
      channel: msg.channel,
      platformMsgId: msg.platformMsgId,
      replyToId: msg.replyToPlatformMsgId ?? null,
      role: "user",
      content: msg.text,
      attachments: msg.attachments,
      createdAt,
    });

    const steerAgentMsg = rawRecordToAgentMessage(savedSteerMsg, this.repo);
    if (steerAgentMsg.role === "hato_user_batch") {
      if (msg.images && msg.images.length > 0) {
        steerAgentMsg.images = msg.images.slice(0, 4);
      }
      if (turn.unsentStopMsgExists) {
        steerAgentMsg.text = `[补充消息（上一条草稿尚未发给用户，请结合已完成的结果与本次补充合并后一次性回复）]\n${steerAgentMsg.text}`;
      }
    }

    this.agent.steer(steerAgentMsg);
    const shouldSendAck = !turn.sentSteerAck;
    turn.sentSteerAck = true;
    return { action: "steered", shouldSendAck };
  }

  /**
   * Abort the currently running Persona turn if no tool or reply bubble has started yet.
   */
  abortIfUnsent(canonicalUserId?: string): boolean {
    if (!this.activeTurn) return false;
    if (canonicalUserId && this.activeTurn.canonicalUserId !== canonicalUserId) return false;
    if (this.activeTurn.hasToolActivity || this.activeTurn.sentAnyBubble) return false;
    this.activeTurn.abortedForSupersede = true;
    this.agent.abort();
    return true;
  }

  getEffectiveTimezone(canonicalUserId: string): string {
    const override = this.repo.getActiveScheduleOverride(canonicalUserId, Date.now());
    return override?.tempTimezone || this.hatoConfig.owner.timezone;
  }

  async handleUserBatch(
    batch: InboundBatch,
    loadedImages: ImageContent[] = [],
    options?: {
      sendPhotoToUser?: SendPhotoToUserFn;
      sendBubblesToUser?: (bubbles: string[]) => Promise<void>;
      onRetryNotice?: (message: string, notice: LlmRetryNotice) => Promise<void>;
      shouldSuppressSend?: () => boolean;
    },
  ): Promise<PersonaTurnOutput> {
    const canonicalUserId = batch.canonicalUserId;
    this.activeTurnOriginChannel = batch.originChannel;
    const resolved = this.modelRegistry.resolveSlot("persona");
    this.agent.state.model = resolved.model;
    this.agent.state.thinkingLevel = this.modelRegistry.resolveSlotThinkingLevel("persona");
    this.syncTranscriptIfDrifted(canonicalUserId);

    const wmState = this.repo.getWorkingMemory(canonicalUserId);
    const userCreatedAt = Math.max(
      batch.lastTimestampMs,
      Date.now(),
      wmState.compactedUntilTs + 1,
    );

    const savedUserMsg = this.repo.appendRawMessage({
      canonicalUserId,
      channel: batch.originChannel,
      platformMsgId: batch.latestPlatformMsgId,
      replyToId: batch.replyToPlatformMsgId ?? null,
      role: "user",
      content: batch.combinedText,
      attachments: batch.attachments,
      createdAt: userCreatedAt,
    });
    this.repo.resolveFiredOpenLoopsOnUserReply(canonicalUserId);

    const priorImages = this.pendingSupersededImages.get(canonicalUserId) ?? [];
    const effectiveImages = [...priorImages, ...loadedImages].slice(0, 4);

    const userAgentMsg = rawRecordToAgentMessage(savedUserMsg, this.repo);
    if (userAgentMsg.role === "hato_user_batch" && effectiveImages.length > 0) {
      userAgentMsg.images = effectiveImages;
    }

    const turnState: ActivePersonaTurnState = {
      canonicalUserId,
      hasToolActivity: false,
      abortedForSupersede: false,
      sentAnyBubble: false,
      sentSteerAck: false,
      promptSettled: false,
      unsentStopMsgExists: false,
      lastUserCreatedAt: savedUserMsg.createdAt,
    };
    this.activeTurn = turnState;
    this.agent.clearAllQueues();

    const startIndex = this.agent.state.messages.length;
    const turnStartPerf = performance.now();
    const userPreview = batch.combinedText.replace(/\s+/g, " ").trim().slice(0, 60) || null;
    const liveTraceId = `live_persona_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const preReplyState: {
      latestToolUseMsg: AssistantMessage | null;
      flushedInTurn: boolean;
      sentMessageRefs: Set<AssistantMessage>;
      sentBubbles: string[];
    } = {
      latestToolUseMsg: null,
      flushedInTurn: false,
      sentMessageRefs: new Set(),
      sentBubbles: [],
    };
    const sentMediaNotes: string[] = [];

    const trackedSendPhoto: SendPhotoToUserFn | undefined = options?.sendPhotoToUser
      ? async (photo, caption) => {
          await options.sendPhotoToUser!(photo, caption);
          const cap = caption?.trim();
          sentMediaNotes.push(cap ? `[已发送图片：${cap.slice(0, 40)}]` : "[已发送图片]");
        }
      : undefined;

    this.liveTraceTracker?.start({
      id: liveTraceId,
      canonicalUserId,
      slot: "persona",
      provider: resolved.providerSlug,
      modelId: resolved.model.id,
      api: String(resolved.model.api),
      userPreview,
      startedAt: Date.now(),
      progressNote: "思考与生成回复中",
    });

    const telemetry = this.subscribeTurnTelemetry({
      startIndex,
      turnStartPerf,
      liveTraceId,
      onToolStart: () => {
        turnState.hasToolActivity = true;
      },
      onToolEnd: (toolName, isError, result) => {
        if (toolName === "send_sticker" && !isError) {
          const resObj =
            result && typeof result === "object"
              ? (result as {
                  details?: { ok?: boolean; stickerId?: string };
                  content?: Array<{ type?: string; text?: string }>;
                })
              : undefined;
          if (resObj?.details?.ok) {
            const textBlock = Array.isArray(resObj.content)
              ? (resObj.content.find((c) => c.type === "text")?.text ?? "")
              : "";
            const note = textBlock.trim() || `已发送表情包 ${resObj.details.stickerId ?? ""}`.trim();
            sentMediaNotes.push(`[${note}]`);
          }
        }
      },
      onAssistantMessageEnd: (msg) => {
        if (msg.stopReason === "toolUse") {
          turnState.hasToolActivity = true;
          preReplyState.latestToolUseMsg = msg;
        } else {
          preReplyState.latestToolUseMsg = null;
          if (msg.stopReason === "stop" && extractAssistantText(msg).trim().length > 0) {
            turnState.unsentStopMsgExists = true;
          }
        }
      },
    });

    const sendBubblesToUser = options?.sendBubblesToUser;
    this.activeBeforeToolHook = sendBubblesToUser
      ? async (toolName, input) => {
          if (preReplyState.flushedInTurn) return;
          if (turnState.abortedForSupersede || (!turnState.hasToolActivity && options?.shouldSuppressSend?.())) {
            turnState.abortedForSupersede = true;
            this.agent.abort();
            return;
          }

          const latestMsg = preReplyState.latestToolUseMsg;
          const rawModelPreText = latestMsg ? extractAssistantText(latestMsg).trim() : "";
          const modelPreText = isNoReplyOutput(rawModelPreText) ? "" : rawModelPreText;
          const replyText = modelPreText || buildSlowToolPreAck(toolName, input);
          if (!replyText) return;

          const preBubbles = splitIntoBubbles(replyText, {
            enabled: this.hatoConfig.gateway.bubbles.enabled,
            maxPerTurn: this.hatoConfig.gateway.bubbles.max_per_turn,
            delimiter: this.hatoConfig.gateway.bubbles.delimiter,
          });
          if (preBubbles.length === 0) return;

          preReplyState.flushedInTurn = true;
          turnState.sentAnyBubble = true;
          if (latestMsg && modelPreText) {
            preReplyState.sentMessageRefs.add(latestMsg);
          }
          preReplyState.sentBubbles.push(...preBubbles);
          await sendBubblesToUser(preBubbles);
        }
      : null;

    this.activeTurnRecalledMemories = [];
    this.activeTurnRecalledIds.clear();

    let retryNoticeSent = false;
    this.activeRetryNoticeHook = options?.onRetryNotice
      ? async (notice) => {
          if (retryNoticeSent || turnState.abortedForSupersede || options?.shouldSuppressSend?.()) {
            return;
          }
          retryNoticeSent = true;
          await options.onRetryNotice!(formatLlmRetryNotice(notice), notice);
        }
      : null;

    const recallCfg = resolveMemoryRecallConfig(this.hatoConfig);
    if (
      (recallCfg.mode === "auto" || recallCfg.mode === "hybrid") &&
      this.memoryStore?.isConfigured() &&
      shouldAutoRecall(batch.combinedText, recallCfg.minQueryChars)
    ) {
      try {
        const recallRes = await this.memoryStore.recall(canonicalUserId, {
          bank: "persona",
          query: batch.combinedText,
          limit: recallCfg.maxResults,
        });
        if (!recallRes.ok && recallRes.errorCode) {
          logWarn("MEMORY", `auto recall denied (${recallRes.errorCode}): ${recallRes.errorMessage ?? ""}`);
        } else if (recallRes.items.length > 0) {
          this.activeTurnRecalledMemories = recallRes.items;
          for (const item of recallRes.items) {
            this.activeTurnRecalledIds.add(`${item.bank}:${item.id}`);
          }
        }
      } catch (err) {
        logWarn(
          "MEMORY",
          `auto recall exception: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.activePhotoSender = trackedSendPhoto ?? null;
    this.browserRuntime?.setPhotoSender(trackedSendPhoto ?? null);
    const turnTools = selectToolsForTurn({
      allTools: this.allTools,
      userText: batch.combinedText,
      hasImages: effectiveImages.length > 0,
      hasAttachments: batch.attachments.length > 0,
      hasPersonalSkills: this.personalSkills.length > 0,
      previouslyActivated: this.sessionTools,
    });
    for (const t of turnTools) {
      this.sessionTools.add(t.name);
    }
    this.agent.state.tools = turnTools;
    if (
      this.agent.state.messages.length === 1 &&
      this.agent.state.messages[0]?.role === "system"
    ) {
      const systemPromptText = buildStaticSystemPrompt(
        this.basePersonaPrompt,
        this.repo,
        this.personalSkillsIndexText,
        this.toolIndexText,
      );
      const refreshedLeading = createInitialSystemMessage(
        systemPromptText,
        turnTools.map(toToolDeclaration),
      );
      if (refreshedLeading) {
        this.agent.state.messages = [refreshedLeading];
      }
    }
    const frozenNowMs = Date.now();
    const frozenEphemeral = buildEphemeralContextBlock({
      nowMs: frozenNowMs,
      repo: this.repo,
      canonicalUserId,
      baseTimezone: this.hatoConfig.owner.timezone,
      quietHours: this.hatoConfig.owner.quiet_hours,
      recalledMemories: this.activeTurnRecalledMemories,
    });
    this.lastTimeCardSnapshot = frozenEphemeral.timeCardText;
    this.activeTurnEphemeralTail = {
      tailText: frozenEphemeral.tailText,
      timeCardText: frozenEphemeral.timeCardText,
      timestamp: frozenNowMs,
      anchorMessageId: userAgentMsg.role === "hato_user_batch" ? userAgentMsg.id : undefined,
    };

    let promptErr: unknown = null;
    try {
      if (!turnState.abortedForSupersede && !options?.shouldSuppressSend?.()) {
        await this.agent.prompt(userAgentMsg);
        while (!turnState.abortedForSupersede && this.agent.hasQueuedMessages()) {
          await this.agent.continue();
        }
      } else {
        turnState.abortedForSupersede = true;
      }
    } catch (err) {
      promptErr = err;
    } finally {
      turnState.promptSettled = true;
      this.activeBeforeToolHook = null;
      this.activeRetryNoticeHook = null;
      this.activePhotoSender = null;
      this.browserRuntime?.setPhotoSender(null);
      telemetry.unsubscribe();
      this.activeCallStartPerf = null;
      this.activeTurnRecalledMemories = [];
      this.activeTurnEphemeralTail = null;
      this.liveTraceTracker?.finish(liveTraceId);
      if (this.activeTurn === turnState) {
        this.activeTurn = null;
      }
    }

    const { turnFirstDeltaPerf, totalDecodeMs } = telemetry.getTiming();
    const latencyMs = Math.max(1, Math.round(performance.now() - turnStartPerf));
    const ttftMs =
      turnFirstDeltaPerf !== null ? Math.max(0, Math.round(turnFirstDeltaPerf - turnStartPerf)) : latencyMs;

    const superseded =
      !turnState.hasToolActivity &&
      !turnState.sentAnyBubble &&
      (turnState.abortedForSupersede || Boolean(options?.shouldSuppressSend?.()));

    if (superseded) {
      if (effectiveImages.length > 0) {
        this.pendingSupersededImages.set(canonicalUserId, effectiveImages);
      }
      this.activeTurnRecalledIds.clear();
      this.refreshTranscriptFromDb();
      return {
        rawText: "",
        bubbles: [],
        earlyBubbles: [],
        silent: true,
        superseded: true,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        toolCalls: [],
        latencyMs,
        ttftMs,
        cacheHitRate: 0,
        tps: null,
      };
    }

    this.pendingSupersededImages.delete(canonicalUserId);

    const turnFailure =
      promptErr ?? (this.agent.state.errorMessage ? new Error(this.agent.state.errorMessage) : null);
    if (turnFailure) {
      this.persistInterruptedTurn({
        canonicalUserId,
        channel: batch.originChannel,
        minCreatedAt: savedUserMsg.createdAt + 1,
        compactedUntilTs: wmState.compactedUntilTs,
        sentParts: [...preReplyState.sentBubbles, ...sentMediaNotes],
        err: turnFailure,
      });
      this.activeTurnRecalledIds.clear();
      this.refreshTranscriptFromDb();
      throw turnFailure;
    }

    const newMessages = this.agent.state.messages.slice(startIndex);
    const { finalText, totalUsage, toolCalls } = extractTurnMetrics(
      newMessages,
      preReplyState.sentMessageRefs,
    );
    const turnMetrics = computeTurnMetrics({
      inputTokens: totalUsage.input,
      outputTokens: totalUsage.output,
      cacheReadTokens: totalUsage.cacheRead,
      cacheWriteTokens: totalUsage.cacheWrite,
      latencyMs,
      ttftMs,
      decodeMs: totalDecodeMs > 0 ? totalDecodeMs : undefined,
    });

    const trimmedFinal = finalText.trim();
    const isSilentNoReply = isNoReplyOutput(trimmedFinal) && preReplyState.sentBubbles.length === 0;
    const trailingReply = isSilentNoReply
      ? ""
      : trimmedFinal ||
        (preReplyState.sentBubbles.length > 0 ? "" : "嗯……刚刚走神了一下，你再说一遍？");

    const bubbles = trailingReply
      ? splitIntoBubbles(trailingReply, {
          enabled: this.hatoConfig.gateway.bubbles.enabled,
          maxPerTurn: this.hatoConfig.gateway.bubbles.max_per_turn,
          delimiter: this.hatoConfig.gateway.bubbles.delimiter,
        })
      : [];
    const allBubbles = [...preReplyState.sentBubbles, ...bubbles];
    const persistedText = joinPersistedBubbles(allBubbles, {
      enabled: this.hatoConfig.gateway.bubbles.enabled,
      delimiter: this.hatoConfig.gateway.bubbles.delimiter,
    });

    if (!isSilentNoReply && persistedText.length > 0) {
      this.repo.appendRawMessage({
        canonicalUserId,
        channel: batch.originChannel,
        role: "assistant",
        content: persistedText,
        createdAt: Math.max(Date.now(), savedUserMsg.createdAt + 1),
      });
    }

    if (this.pendingTranscriptRefresh) {
      this.refreshTranscriptFromDb();
    } else {
      this.pruneTurnPayloadBloat();
    }

    const recalledIds = [...this.activeTurnRecalledIds];
    this.activeTurnRecalledIds.clear();

    this.repo.insertTurnTrace({
      canonicalUserId,
      slot: "persona",
      provider: resolved.providerSlug,
      modelId: resolved.model.id,
      api: String(resolved.model.api),
      inputTokens: totalUsage.input,
      outputTokens: totalUsage.output,
      cacheReadTokens: totalUsage.cacheRead,
      cacheWriteTokens: totalUsage.cacheWrite,
      cacheHitRate: turnMetrics.cacheHitRate,
      ttftMs,
      tps: turnMetrics.decodeTps,
      userPreview,
      recalledIds,
      timeCardText: isSilentNoReply
        ? `${this.lastTimeCardSnapshot}\n[silent: NO_REPLY]`
        : this.lastTimeCardSnapshot,
      toolCalls,
      steps: extractTraceSteps(newMessages),
      latencyMs,
    });

    return {
      rawText: persistedText,
      bubbles,
      earlyBubbles: preReplyState.sentBubbles,
      silent: isSilentNoReply,
      superseded: false,
      usage: totalUsage,
      toolCalls,
      latencyMs,
      ttftMs,
      cacheHitRate: turnMetrics.cacheHitRate,
      tps: turnMetrics.decodeTps,
    };
  }

  /**
   * Narrate a background ticket result, question, or schedule event in Persona's voice
   * without touching verbatim blocks or artifacts.
   */
  private persistInterruptedTurn(params: {
    canonicalUserId: string;
    channel: InboundBatch["originChannel"];
    minCreatedAt: number;
    compactedUntilTs: number;
    sentParts: string[];
    err: unknown;
  }): void {
    const errorSummary = summarizeErrorForContext(params.err);
    const createdAt = Math.max(Date.now(), params.minCreatedAt);
    const sentParts = params.sentParts.map((p) => p.trim()).filter(Boolean);
    const delimiter = this.hatoConfig.gateway.bubbles.enabled
      ? this.hatoConfig.gateway.bubbles.delimiter
      : "\n";

    if (sentParts.length === 0) {
      const recent = this.repo.listRecentMessages(params.canonicalUserId, 8);
      for (let i = recent.length - 1; i >= 0; i--) {
        const msg = recent[i]!;
        if (msg.role === "user") {
          continue;
        }
        if (msg.role === "assistant" && msg.createdAt > params.compactedUntilTs) {
          const parsed = parsePureErrorInterruptionNotice(msg.content);
          if (parsed) {
            this.repo.updateRawMessage(msg.id, {
              content: buildInterruptedAssistantText({
                sentParts: [],
                errorSummary,
                consecutiveCount: parsed.count + 1,
                delimiter,
              }),
              createdAt,
            });
            return;
          }
        }
        break;
      }
    }

    this.repo.appendRawMessage({
      canonicalUserId: params.canonicalUserId,
      channel: params.channel,
      role: "assistant",
      content: buildInterruptedAssistantText({
        sentParts,
        errorSummary,
        consecutiveCount: 1,
        delimiter,
      }),
      createdAt,
    });
  }

  async narrateBackgroundEvent(params: {
    canonicalUserId: string;
    channel: InboundBatch["originChannel"];
    eventSummary: string;
    promptInstruction: string;
    images?: ImageContent[];
  }): Promise<string[]> {
    this.activeTurnOriginChannel = params.channel;
    const resolved = this.modelRegistry.resolveSlot("persona");
    this.agent.state.model = resolved.model;
    this.agent.state.thinkingLevel = this.modelRegistry.resolveSlotThinkingLevel("persona");
    this.syncTranscriptIfDrifted(params.canonicalUserId);

    const turnTools = selectToolsForTurn({
      allTools: this.allTools,
      userText: `${params.eventSummary}\n${params.promptInstruction}`,
      hasImages: (params.images?.length ?? 0) > 0,
      hasAttachments: true,
      hasPersonalSkills: this.personalSkills.length > 0,
      previouslyActivated: this.sessionTools,
    });
    for (const t of turnTools) {
      this.sessionTools.add(t.name);
    }
    this.agent.state.tools = turnTools;

    const savedEvent = this.repo.appendRawMessage({
      canonicalUserId: params.canonicalUserId,
      channel: params.channel,
      role: "executed_event",
      content: params.eventSummary,
      createdAt: Date.now(),
    });
    this.agent.state.messages = [
      ...this.agent.state.messages,
      rawRecordToAgentMessage(savedEvent, this.repo),
    ];

    const startIndex = this.agent.state.messages.length;
    const startPerf = performance.now();
    const userPreview = params.eventSummary.replace(/\s+/g, " ").trim().slice(0, 100);
    const liveTraceId = `live_persona_bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    this.liveTraceTracker?.start({
      id: liveTraceId,
      canonicalUserId: params.canonicalUserId,
      slot: "persona",
      provider: resolved.providerSlug,
      modelId: resolved.model.id,
      api: String(resolved.model.api),
      userPreview,
      startedAt: Date.now(),
      progressNote: "处理后台事件回复",
    });

    const telemetry = this.subscribeTurnTelemetry({
      startIndex,
      turnStartPerf: startPerf,
      liveTraceId,
    });

    const frozenNowMs = Date.now();
    const frozenEphemeral = buildEphemeralContextBlock({
      nowMs: frozenNowMs,
      repo: this.repo,
      canonicalUserId: params.canonicalUserId,
      baseTimezone: this.hatoConfig.owner.timezone,
      quietHours: this.hatoConfig.owner.quiet_hours,
    });
    this.lastTimeCardSnapshot = frozenEphemeral.timeCardText;
    this.activeTurnEphemeralTail = {
      tailText: frozenEphemeral.tailText,
      timeCardText: frozenEphemeral.timeCardText,
      timestamp: frozenNowMs,
      anchorAgentIndex: startIndex,
    };

    let promptErr: unknown = null;
    try {
      const attachedImages = params.images?.slice(0, 4) ?? [];
      if (attachedImages.length > 0) {
        await this.agent.prompt(params.promptInstruction, attachedImages);
      } else {
        await this.agent.prompt(params.promptInstruction);
      }
    } catch (err) {
      promptErr = err;
    } finally {
      telemetry.unsubscribe();
      this.activeCallStartPerf = null;
      this.activeTurnEphemeralTail = null;
      this.liveTraceTracker?.finish(liveTraceId);
    }

    const turnFailure =
      promptErr ?? (this.agent.state.errorMessage ? new Error(this.agent.state.errorMessage) : null);
    if (turnFailure) {
      logWarn("PERSONA", `narrateBackgroundEvent failed: ${summarizeError(turnFailure)}`);
      this.refreshTranscriptFromDb();
      return [params.eventSummary];
    }

    const { turnFirstDeltaPerf, totalDecodeMs } = telemetry.getTiming();
    const latencyMs = Math.max(1, Math.round(performance.now() - startPerf));
    const ttftMs =
      turnFirstDeltaPerf !== null ? Math.max(0, Math.round(turnFirstDeltaPerf - startPerf)) : latencyMs;

    const newMessages = this.agent.state.messages.slice(startIndex);
    const { finalText, totalUsage, toolCalls } = extractTurnMetrics(newMessages);
    const reply = finalText.trim() || params.eventSummary;
    const bubbles = splitIntoBubbles(reply, {
      enabled: this.hatoConfig.gateway.bubbles.enabled,
      maxPerTurn: this.hatoConfig.gateway.bubbles.max_per_turn,
      delimiter: this.hatoConfig.gateway.bubbles.delimiter,
    });

    const persisted = joinPersistedBubbles(bubbles, {
      enabled: this.hatoConfig.gateway.bubbles.enabled,
      delimiter: this.hatoConfig.gateway.bubbles.delimiter,
    });
    if (persisted) {
      this.repo.appendRawMessage({
        canonicalUserId: params.canonicalUserId,
        channel: params.channel,
        role: "assistant",
        content: persisted,
        createdAt: Date.now(),
      });
    }

    const metrics = computeTurnMetrics({
      inputTokens: totalUsage.input,
      outputTokens: totalUsage.output,
      cacheReadTokens: totalUsage.cacheRead,
      cacheWriteTokens: totalUsage.cacheWrite,
      latencyMs,
      ttftMs,
      decodeMs: totalDecodeMs > 0 ? totalDecodeMs : undefined,
    });
    this.repo.insertTurnTrace({
      canonicalUserId: params.canonicalUserId,
      slot: "persona",
      provider: resolved.providerSlug,
      modelId: resolved.model.id,
      api: String(resolved.model.api),
      inputTokens: totalUsage.input,
      outputTokens: totalUsage.output,
      cacheReadTokens: totalUsage.cacheRead,
      cacheWriteTokens: totalUsage.cacheWrite,
      cacheHitRate: metrics.cacheHitRate,
      ttftMs,
      tps: metrics.decodeTps,
      userPreview,
      recalledIds: [],
      timeCardText: params.promptInstruction,
      toolCalls,
      steps: extractTraceSteps(newMessages),
      latencyMs,
    });

    if (this.pendingTranscriptRefresh) {
      this.refreshTranscriptFromDb();
    } else {
      this.pruneTurnPayloadBloat();
    }
    return bubbles.length > 0 ? bubbles : [reply];
  }

  private subscribeTurnTelemetry(params: {
    startIndex: number;
    turnStartPerf: number;
    liveTraceId?: string;
    onToolStart?: (toolName: string) => void;
    onToolEnd?: (toolName: string, isError: boolean, result: unknown) => void;
    onAssistantMessageEnd?: (msg: AssistantMessage) => void;
  }): {
    unsubscribe: () => void;
    getTiming: () => { turnFirstDeltaPerf: number | null; totalDecodeMs: number };
  } {
    let turnFirstDeltaPerf: number | null = null;
    let msgStartPerf = params.turnStartPerf;
    let msgFirstDeltaPerf: number | null = null;
    let totalDecodeMs = 0;

    const syncLiveTrace = (progressNote?: string) => {
      if (!this.liveTraceTracker || !params.liveTraceId) return;
      const agg = aggregateAssistantTraceMetrics(this.agent.state.messages.slice(params.startIndex));
      this.liveTraceTracker.update(params.liveTraceId, {
        ...(progressNote !== undefined ? { progressNote } : {}),
        steps: agg.steps,
        toolCalls: agg.toolCalls,
      });
    };

    const unsubscribe = this.agent.subscribe((ev) => {
      if (ev.type === "message_start" && ev.message.role === "assistant") {
        msgStartPerf = this.activeCallStartPerf ?? performance.now();
        msgFirstDeltaPerf = null;
        return;
      }

      if (ev.type === "message_update") {
        const sub = ev.assistantMessageEvent;
        const hasDelta =
          (sub.type === "text_delta" || sub.type === "thinking_delta" || sub.type === "toolcall_delta") &&
          sub.delta.length > 0;
        if (hasDelta) {
          const nowPerf = performance.now();
          if (turnFirstDeltaPerf === null) turnFirstDeltaPerf = nowPerf;
          if (msgFirstDeltaPerf === null) msgFirstDeltaPerf = nowPerf;
        }
        return;
      }

      if (ev.type === "tool_execution_start") {
        params.onToolStart?.(ev.toolName);
        syncLiveTrace(`正在调用: ${ev.toolName}`);
        return;
      }

      if (ev.type === "tool_execution_end") {
        params.onToolEnd?.(ev.toolName, ev.isError, ev.result);
        syncLiveTrace();
        return;
      }

      if (ev.type === "message_end" && ev.message.role === "assistant") {
        const msg = ev.message;
        params.onAssistantMessageEnd?.(msg);

        const nowPerf = performance.now();
        const callStart = this.activeCallStartPerf ?? msgStartPerf;
        const callTotalMs = Math.max(1, Math.round(nowPerf - callStart));
        if (turnFirstDeltaPerf === null) turnFirstDeltaPerf = nowPerf;
        const callTtftMs =
          msgFirstDeltaPerf !== null ? Math.max(0, Math.round(msgFirstDeltaPerf - callStart)) : callTotalMs;
        const callDecodeMs =
          msgFirstDeltaPerf !== null ? Math.max(1, nowPerf - msgFirstDeltaPerf) : undefined;
        if (callDecodeMs !== undefined) {
          totalDecodeMs += callDecodeMs;
        }
        this.activeCallStartPerf = null;
        msgFirstDeltaPerf = null;

        const msgTools = msg.content
          .filter((b): b is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => b.type === "toolCall")
          .map((b) => b.name);

        console.log(
          formatLlmTelemetryLog({
            slot: "persona",
            provider: msg.provider,
            modelId: msg.model,
            responseModel: msg.responseModel,
            responseId: msg.responseId,
            api: String(msg.api),
            stopReason: msg.stopReason,
            rawStopReason: msg.rawStopReason,
            thinkingLevel: msg.providerThinkingLevel ?? msg.thinkingLevel,
            inputTokens: msg.usage.input,
            outputTokens: msg.usage.output,
            reasoningTokens: msg.usage.reasoning,
            cacheReadTokens: msg.usage.cacheRead,
            cacheWriteTokens: msg.usage.cacheWrite,
            cacheWrite1hTokens: msg.usage.cacheWrite1h,
            costTotal: msg.usage.cost.total,
            ttftMs: callTtftMs,
            decodeMs: callDecodeMs,
            latencyMs: callTotalMs,
            toolCalls: msgTools,
            timeZone: this.hatoConfig.owner.timezone,
          }),
        );
        syncLiveTrace();
      }
    });

    return {
      unsubscribe,
      getTiming: () => ({ turnFirstDeltaPerf, totalDecodeMs }),
    };
  }

  /**
   * Reuse the exact Persona model and static+hot prefix for cache-warm compaction summary.
   */
  async summarizeBlockWithWarmPrefix(params: {
    canonicalUserId: string;
    previousSummary: string;
    messagesToSummarize: RawMessageRecord[];
  }): Promise<string> {
    const resolved = this.modelRegistry.resolveSlot("persona");
    const systemPrompt = buildStaticSystemPrompt(
      this.basePersonaPrompt,
      this.repo,
      this.personalSkillsIndexText,
      this.toolIndexText,
    );
    const tz = this.getEffectiveTimezone(params.canonicalUserId);

    const agentMessages: AgentMessage[] = [];
    if (params.previousSummary.trim()) {
      agentMessages.push({
        role: "hato_compaction_summary",
        text: params.previousSummary,
        compactedUntilTs: params.messagesToSummarize[0]?.createdAt ?? Date.now(),
        timestamp: params.messagesToSummarize[0]?.createdAt ?? Date.now(),
      });
    }
    for (const row of params.messagesToSummarize) {
      if (row.role === "assistant") {
        const cleaned = stripErrorInterruptionNotices(row.content);
        if (!cleaned && row.attachments.length === 0) {
          continue;
        }
        agentMessages.push(rawRecordToAgentMessage({ ...row, content: cleaned }, this.repo));
      } else {
        agentMessages.push(rawRecordToAgentMessage(row, this.repo));
      }
    }

    const llmMessages: Message[] = convertHatoMessagesToLlm(agentMessages, {
      getTimezone: () => tz,
      gapMarkerThresholdMinutes: this.hatoConfig.context.gap_marker_threshold_minutes,
      modelApi: resolved.model.api,
    });

    llmMessages.push({
      role: "user",
      content: [
        "【系统内部指令：请客观整理以上历史对话为滚动过渡摘要】",
        "- 用第三人称（“用户”“助手”）简洁记录：主要讨论的话题、用户明确提到的事实与时间点、尚未解决的事项。",
        "- 不要延续角色扮演腔调，不要编造未发生的事情，控制在 350 字以内。",
      ].join("\n"),
      timestamp: Date.now(),
    });

    const apiKey = this.modelRegistry.resolveApiKeyForProvider(resolved.providerSlug);
    const scopedFetch = this.proxyRouter.createScopedFetch(`llm-calling.${resolved.providerSlug}`);

    const compactionThinking = clampThinkingLevel(
      resolved.model,
      this.modelRegistry.resolveSlotThinkingLevel("curator"),
    );

    const callStartPerf = performance.now();
    let firstDeltaPerf: number | null = null;
    const result = await this.proxyRouter.runWithScope(`llm-calling.${resolved.providerSlug}`, async () => {
      const stream = streamSimpleWithRetry(
        () =>
          this.modelRegistry.models.streamSimple(
            resolved.model,
            { systemPrompt, messages: llmMessages },
            {
              apiKey,
              sessionId: params.canonicalUserId,
              disableContinuation: true,
              ...(supportsCustomFetchOption(resolved.model.api) ? { fetch: scopedFetch } : {}),
              reasoning: compactionThinking === "off" ? undefined : compactionThinking,
            },
          ),
        {
          policy: resolveLlmRetryConfig(this.hatoConfig),
          model: resolved.model,
          slot: "COMPACTION",
        },
      );
      for await (const ev of stream) {
        if (
          firstDeltaPerf === null &&
          (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") &&
          ev.delta.length > 0
        ) {
          firstDeltaPerf = performance.now();
        }
      }
      return stream.result();
    });

    const nowPerf = performance.now();
    const latencyMs = Math.max(1, Math.round(nowPerf - callStartPerf));
    const ttftMs =
      firstDeltaPerf !== null ? Math.max(0, Math.round(firstDeltaPerf - callStartPerf)) : latencyMs;
    const decodeMs =
      firstDeltaPerf !== null ? Math.max(1, nowPerf - firstDeltaPerf) : undefined;

    console.log(
      formatLlmTelemetryLog({
        slot: "compaction-warm",
        provider: result.provider,
        modelId: result.model,
        responseModel: result.responseModel,
        responseId: result.responseId,
        api: String(result.api),
        stopReason: result.stopReason,
        rawStopReason: result.rawStopReason,
        thinkingLevel: result.providerThinkingLevel ?? result.thinkingLevel,
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        reasoningTokens: result.usage.reasoning,
        cacheReadTokens: result.usage.cacheRead,
        cacheWriteTokens: result.usage.cacheWrite,
        cacheWrite1hTokens: result.usage.cacheWrite1h,
        costTotal: result.usage.cost.total,
        ttftMs,
        decodeMs,
        latencyMs,
        timeZone: this.hatoConfig.owner.timezone,
      }),
    );

    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage || "Compaction summary generation failed");
    }

    const curatorMetrics = computeTurnMetrics({
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
      latencyMs,
      ttftMs,
      decodeMs,
    });
    this.repo.insertTurnTrace({
      canonicalUserId: params.canonicalUserId,
      slot: "curator",
      provider: resolved.providerSlug,
      modelId: result.model,
      api: String(result.api),
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
      cacheHitRate: curatorMetrics.cacheHitRate,
      ttftMs,
      tps: curatorMetrics.decodeTps,
      userPreview: `[记忆整理] 压缩 ${params.messagesToSummarize.length} 条历史对话`,
      recalledIds: [],
      timeCardText: `compacted_messages: ${params.messagesToSummarize.length}\nwarm_prefix_slot: persona`,
      toolCalls: [],
      steps: extractTraceSteps([result]),
      latencyMs,
    });

    return extractAssistantText(result).trim();
  }
}

function buildSlowToolPreAck(toolName: string, input: unknown): string {
  switch (toolName) {
    case "browser_task": {
      const rec = input && typeof input === "object" ? (input as { resume?: unknown }) : undefined;
      return rec?.resume ? "好，那我接着去看" : "好，我去打开浏览器看看";
    }
    case "web_search":
      return "等我一下，我帮你查查看";
    case "web_fetch":
      return "我先打开这个链接看看";
    default:
      // Fast local/internal lookups (calc, date_math, recall_memory, search_past_sessions,
      // inspect_tickets, list_schedules) should run silently without spamming a pre-tool ack.
      return "";
  }
}

function extractTurnMetrics(
  messages: AgentMessage[],
  skipTextMessages: ReadonlySet<AssistantMessage> = new Set(),
): {
  finalText: string;
  totalUsage: Usage;
  toolCalls: string[];
} {
  const totalUsage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const toolCalls: string[] = [];
  let finalText = "";

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    totalUsage.input += msg.usage.input;
    totalUsage.output += msg.usage.output;
    totalUsage.cacheRead += msg.usage.cacheRead;
    totalUsage.cacheWrite += msg.usage.cacheWrite;
    totalUsage.totalTokens += msg.usage.totalTokens;
    totalUsage.cost.input += msg.usage.cost.input;
    totalUsage.cost.output += msg.usage.cost.output;
    totalUsage.cost.cacheRead += msg.usage.cost.cacheRead;
    totalUsage.cost.cacheWrite += msg.usage.cost.cacheWrite;
    totalUsage.cost.total += msg.usage.cost.total;

    for (const block of msg.content) {
      if (block.type === "toolCall") {
        toolCalls.push(block.name);
      }
    }
    if (!skipTextMessages.has(msg)) {
      const text = extractAssistantText(msg);
      if (text) finalText = text;
    }
  }

  return { finalText, totalUsage, toolCalls };
}

function extractAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isNoReplyOutput(text: string): boolean {
  if (!text) return false;
  const normalized = text.replace(/[`\s]/g, "").toUpperCase();
  return normalized === "[NO_REPLY]" || normalized === "NO_REPLY";
}
