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
  type Usage,
} from "@earendil-works/pi-ai";
import type { BrowserRuntime, SendPhotoToUserFn } from "../browser/runtime.js";
import {
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
import { computeTurnMetrics, extractTraceSteps, formatLlmTelemetryLog } from "../stats/metrics.js";
import { logWarn } from "../utils/logger.js";
import { joinPersistedBubbles, splitIntoBubbles } from "./bubbles.js";
import {
  buildEphemeralContextBlock,
  buildStaticSystemPrompt,
  convertHatoMessagesToLlm,
  hydrateTranscriptFromDb,
  rawRecordToAgentMessage,
} from "./context.js";
import { loadLayeredPrompts, type LoadedLayeredPrompts } from "./prompts.js";
import { createPersonaReadOnlyTools } from "./tools.js";

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
  private lastTimeCardSnapshot = "";
  private activeCallStartPerf: number | null = null;
  private activeBeforeToolHook: ((toolName: string, input: unknown) => Promise<void>) | null = null;
  private activeTurnRecalledMemories: MemoryRecallItem[] = [];
  private activeTurnRecalledIds = new Set<string>();
  private activeTurn: ActivePersonaTurnState | null = null;
  private readonly pendingSupersededImages = new Map<string, ImageContent[]>();
  private reloadHandler: (() => Promise<void>) | null = null;
  private delegateHandler:
    | ((input: {
        canonicalUserId: string;
        originChannel: InboundBatch["originChannel"];
        hint: string;
        urgency?: "normal" | "high";
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
    const tools = this.buildPersonaTools();

    this.agent = new Agent({
      initialState: {
        systemPrompt: buildStaticSystemPrompt(
          this.basePersonaPrompt,
          this.repo,
          this.personalSkillsIndexText,
        ),
        model: resolved.model,
        thinkingLevel: clampThinkingLevel(resolved.model, resolved.model.reasoning ? "low" : "off"),
        tools,
        messages: hydrateTranscriptFromDb(this.repo, canonicalUserId),
      },
      steeringMode: "all",
      sessionId: canonicalUserId,
      getApiKey: (provider) => this.modelRegistry.resolveApiKeyForProvider(provider),
      streamFn: (model, context, options) => {
        this.activeCallStartPerf = performance.now();
        const scopedFetch: typeof globalThis.fetch = (input, init) =>
          this.proxyRouter.scopedFetch(input, init, `llm-calling.${model.provider}`);
        return this.proxyRouter.runWithScope(`llm-calling.${model.provider}`, () =>
          Promise.resolve(
            this.modelRegistry.models.streamSimple(model, context, {
              ...options,
              ...(supportsCustomFetchOption(model.api) ? { fetch: scopedFetch } : {}),
            }),
          ),
        );
      },
      transformContext: async (messages) => {
        const { tailText, timeCardText } = buildEphemeralContextBlock({
          nowMs: Date.now(),
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
            timestamp: Date.now(),
          },
        ];
      },
      convertToLlm: (messages) => {
        return convertHatoMessagesToLlm(messages, {
          getTimezone: () => this.getEffectiveTimezone(canonicalUserId),
          gapMarkerThresholdMinutes: this.hatoConfig.context.gap_marker_threshold_minutes,
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
    this.agent.state.tools = this.buildPersonaTools();
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
    );
    const leadingSystem = createInitialSystemMessage(
      systemPromptText,
      this.agent.state.tools.map(toToolDeclaration),
    );
    const history = hydrateTranscriptFromDb(this.repo, canonicalUserId);
    this.agent.state.messages = leadingSystem ? [leadingSystem, ...history] : history;
  }

  private buildPersonaTools(): AgentTool<any>[] {
    const canonicalUserId = this.hatoConfig.owner.canonical_user_id;
    return createPersonaReadOnlyTools({
      repo: this.repo,
      canonicalUserId,
      getTimezone: () => this.getEffectiveTimezone(canonicalUserId),
      getHatoConfig: () => this.hatoConfig,
      proxyRouter: this.proxyRouter,
      browserRuntime: this.browserRuntime,
      getMemoryStore: () => this.memoryStore,
      enableReadSkillTool: this.personalSkills.length > 0,
      extraTools: this.mcpPool?.getToolsForZone("personal") ?? [],
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
      ...(this.botProfileHandler ? { onBotProfile: this.botProfileHandler } : {}),
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
        onReloadRuntime: async () => {
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
    this.agent.clearAllQueues();
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
      shouldSuppressSend?: () => boolean;
    },
  ): Promise<PersonaTurnOutput> {
    const canonicalUserId = batch.canonicalUserId;
    this.activeTurnOriginChannel = batch.originChannel;
    const resolved = this.modelRegistry.resolveSlot("persona");
    this.agent.state.model = resolved.model;
    this.agent.state.thinkingLevel = clampThinkingLevel(
      resolved.model,
      resolved.model.reasoning ? "low" : "off",
    );

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
    let turnFirstDeltaPerf: number | null = null;
    let msgStartPerf = turnStartPerf;
    let msgFirstDeltaPerf: number | null = null;
    let totalDecodeMs = 0;

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
        turnState.hasToolActivity = true;
        return;
      }

      if (ev.type === "message_end" && ev.message.role === "assistant") {
        const msg = ev.message;
        if (msg.stopReason === "toolUse") {
          turnState.hasToolActivity = true;
          preReplyState.latestToolUseMsg = msg;
        } else {
          preReplyState.latestToolUseMsg = null;
          if (msg.stopReason === "stop" && extractAssistantText(msg).trim().length > 0) {
            turnState.unsentStopMsgExists = true;
          }
        }
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
      }
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

    this.browserRuntime?.setPhotoSender(options?.sendPhotoToUser ?? null);
    try {
      if (!turnState.abortedForSupersede && !options?.shouldSuppressSend?.()) {
        await this.agent.prompt(userAgentMsg);
        while (!turnState.abortedForSupersede && this.agent.hasQueuedMessages()) {
          await this.agent.continue();
        }
      } else {
        turnState.abortedForSupersede = true;
      }
    } finally {
      turnState.promptSettled = true;
      this.activeBeforeToolHook = null;
      this.browserRuntime?.setPhotoSender(null);
      unsubscribe();
      this.activeCallStartPerf = null;
      this.activeTurnRecalledMemories = [];
      if (this.activeTurn === turnState) {
        this.activeTurn = null;
      }
    }

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

    if (this.agent.state.errorMessage) {
      throw new Error(this.agent.state.errorMessage);
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

    // Re-sync transcript with clean hato_* turn blocks so subsequent turns keep stable prefixes.
    this.refreshTranscriptFromDb();

    const userPreview = batch.combinedText.replace(/\s+/g, " ").trim().slice(0, 60) || null;

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
  async narrateBackgroundEvent(params: {
    canonicalUserId: string;
    channel: InboundBatch["originChannel"];
    eventSummary: string;
    promptInstruction: string;
  }): Promise<string[]> {
    this.repo.appendRawMessage({
      canonicalUserId: params.canonicalUserId,
      channel: params.channel,
      role: "executed_event",
      content: params.eventSummary,
      createdAt: Date.now(),
    });
    this.refreshTranscriptFromDb();

    const resolved = this.modelRegistry.resolveSlot("persona");
    this.agent.state.model = resolved.model;
    this.agent.state.thinkingLevel = clampThinkingLevel(
      resolved.model,
      resolved.model.reasoning ? "low" : "off",
    );

    const startIndex = this.agent.state.messages.length;
    const startPerf = performance.now();
    try {
      await this.agent.prompt(params.promptInstruction);
    } catch {
      this.refreshTranscriptFromDb();
      return [params.eventSummary];
    }

    const latencyMs = Math.max(1, Math.round(performance.now() - startPerf));
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
      ttftMs: latencyMs,
      decodeMs: latencyMs,
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
      ttftMs: null,
      tps: null,
      userPreview: params.eventSummary.replace(/\s+/g, " ").trim().slice(0, 100),
      recalledIds: [],
      timeCardText: params.promptInstruction,
      toolCalls,
      steps: extractTraceSteps(newMessages),
      latencyMs,
    });

    this.refreshTranscriptFromDb();
    return bubbles.length > 0 ? bubbles : [reply];
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
      agentMessages.push(rawRecordToAgentMessage(row, this.repo));
    }

    const llmMessages: Message[] = convertHatoMessagesToLlm(agentMessages, {
      getTimezone: () => tz,
      gapMarkerThresholdMinutes: this.hatoConfig.context.gap_marker_threshold_minutes,
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
    const scopedFetch: typeof globalThis.fetch = (input, init) =>
      this.proxyRouter.scopedFetch(input, init, `llm-calling.${resolved.providerSlug}`);

    const callStartPerf = performance.now();
    let firstDeltaPerf: number | null = null;
    const result = await this.proxyRouter.runWithScope(`llm-calling.${resolved.providerSlug}`, async () => {
      const stream = this.modelRegistry.models.streamSimple(
        resolved.model,
        { systemPrompt, messages: llmMessages },
        {
          apiKey,
          sessionId: params.canonicalUserId,
          disableContinuation: true,
          ...(supportsCustomFetchOption(resolved.model.api) ? { fetch: scopedFetch } : {}),
          reasoning: resolved.model.reasoning ? "minimal" : undefined,
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
