import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
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
import type { HatoConfig } from "../config/app.js";
import { supportsCustomFetchOption, type ModelRegistry } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type { HatoRepository, RawMessageRecord } from "../db/repo.js";
import type { InboundBatch } from "../gateway/types.js";
import { splitIntoBubbles } from "./bubbles.js";
import {
  buildEphemeralContextBlock,
  buildStaticSystemPrompt,
  convertHatoMessagesToLlm,
  hydrateTranscriptFromDb,
  rawRecordToAgentMessage,
} from "./context.js";
import { createPersonaReadOnlyTools } from "./tools.js";
import { computeTurnMetrics, formatLlmTelemetryLog } from "../stats/metrics.js";

export interface PersonaTurnOutput {
  rawText: string;
  bubbles: string[];
  earlyBubbles: string[];
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
  private lastTimeCardSnapshot = "";
  private activeCallStartPerf: number | null = null;
  private activeBeforeToolHook: ((toolName: string, input: unknown) => Promise<void>) | null = null;

  constructor(
    private hatoConfig: HatoConfig,
    private readonly modelRegistry: ModelRegistry,
    private readonly proxyRouter: ScopedProxyRouter,
    private readonly repo: HatoRepository,
    private readonly browserRuntime?: BrowserRuntime,
  ) {
    this.reloadPrompt();
    const resolved = this.modelRegistry.resolveSlot("persona");
    const canonicalUserId = this.hatoConfig.owner.canonical_user_id;
    const tools = createPersonaReadOnlyTools({
      repo: this.repo,
      canonicalUserId,
      getTimezone: () => this.getEffectiveTimezone(canonicalUserId),
      getHatoConfig: () => this.hatoConfig,
      proxyRouter: this.proxyRouter,
      browserRuntime: this.browserRuntime,
      onBeforeToolExecute: async (toolName, input) => {
        if (this.activeBeforeToolHook) {
          await this.activeBeforeToolHook(toolName, input);
        }
      },
    });

    this.agent = new Agent({
      initialState: {
        systemPrompt: buildStaticSystemPrompt(this.basePersonaPrompt, this.repo),
        model: resolved.model,
        thinkingLevel: clampThinkingLevel(resolved.model, resolved.model.reasoning ? "low" : "off"),
        tools,
        messages: hydrateTranscriptFromDb(this.repo, canonicalUserId),
      },
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

  updateConfig(nextConfig: HatoConfig): void {
    this.hatoConfig = nextConfig;
    this.browserRuntime?.updateConfig(nextConfig);
    this.reloadPrompt();
    this.refreshTranscriptFromDb();
  }

  reloadPrompt(): void {
    const promptPath = resolve(this.hatoConfig.paths.prompts_dir, "persona.md");
    this.basePersonaPrompt = readFileSync(promptPath, "utf8");
  }

  getBasePersonaPrompt(): string {
    return this.basePersonaPrompt;
  }

  refreshTranscriptFromDb(): void {
    const canonicalUserId = this.hatoConfig.owner.canonical_user_id;
    const systemPromptText = buildStaticSystemPrompt(this.basePersonaPrompt, this.repo);
    const leadingSystem = createInitialSystemMessage(
      systemPromptText,
      this.agent.state.tools.map(toToolDeclaration),
    );
    const history = hydrateTranscriptFromDb(this.repo, canonicalUserId);
    this.agent.state.messages = leadingSystem ? [leadingSystem, ...history] : history;
  }

  /**
   * Reset in-memory session transcript and cached turn snapshot after /new.
   */
  resetSession(): void {
    this.lastTimeCardSnapshot = "";
    this.refreshTranscriptFromDb();
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
    },
  ): Promise<PersonaTurnOutput> {
    const canonicalUserId = batch.canonicalUserId;
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

    const userAgentMsg = rawRecordToAgentMessage(savedUserMsg, this.repo);
    if (userAgentMsg.role === "hato_user_batch" && loadedImages.length > 0) {
      userAgentMsg.images = loadedImages;
    }

    const startIndex = this.agent.state.messages.length;
    const turnStartPerf = performance.now();
    let turnFirstDeltaPerf: number | null = null;
    let msgStartPerf = turnStartPerf;
    let msgFirstDeltaPerf: number | null = null;
    let totalDecodeMs = 0;

    const preReplyState: {
      latestToolUseMsg: AssistantMessage | null;
      flushedForCurrentMsg: boolean;
      sentMessageRefs: Set<AssistantMessage>;
      sentBubbles: string[];
    } = {
      latestToolUseMsg: null,
      flushedForCurrentMsg: false,
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

      if (ev.type === "message_end" && ev.message.role === "assistant") {
        const msg = ev.message;
        if (msg.stopReason === "toolUse") {
          preReplyState.latestToolUseMsg = msg;
          preReplyState.flushedForCurrentMsg = false;
        } else {
          preReplyState.latestToolUseMsg = null;
        }
        const nowPerf = performance.now();
        const callStart = this.activeCallStartPerf ?? msgStartPerf;
        const callTotalMs = Math.max(1, Math.round(nowPerf - callStart));
        if (turnFirstDeltaPerf === null) turnFirstDeltaPerf = nowPerf;
        const callTtftMs =
          msgFirstDeltaPerf !== null ? Math.max(0, Math.round(msgFirstDeltaPerf - callStart)) : callTotalMs;
        const callDecodeMs =
          msgFirstDeltaPerf !== null
            ? Math.max(1, nowPerf - msgFirstDeltaPerf)
            : Math.max(1, callTotalMs - callTtftMs);
        totalDecodeMs += callDecodeMs;
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
          if (preReplyState.flushedForCurrentMsg) return;
          preReplyState.flushedForCurrentMsg = true;

          const latestMsg = preReplyState.latestToolUseMsg;
          const modelPreText = latestMsg ? extractAssistantText(latestMsg).trim() : "";
          const replyText = modelPreText || buildDefaultPreToolAck(toolName, input);

          const preBubbles = splitIntoBubbles(replyText, {
            enabled: this.hatoConfig.gateway.bubbles.enabled,
            maxPerTurn: this.hatoConfig.gateway.bubbles.max_per_turn,
            delimiter: this.hatoConfig.gateway.bubbles.delimiter,
          });
          if (preBubbles.length === 0) return;

          if (latestMsg && modelPreText) {
            preReplyState.sentMessageRefs.add(latestMsg);
          }
          preReplyState.sentBubbles.push(...preBubbles);
          await sendBubblesToUser(preBubbles);
        }
      : null;

    this.browserRuntime?.setPhotoSender(options?.sendPhotoToUser ?? null);
    try {
      await this.agent.prompt(userAgentMsg);
    } finally {
      this.activeBeforeToolHook = null;
      this.browserRuntime?.setPhotoSender(null);
      unsubscribe();
      this.activeCallStartPerf = null;
    }

    const latencyMs = Math.max(1, Math.round(performance.now() - turnStartPerf));
    const ttftMs =
      turnFirstDeltaPerf !== null ? Math.max(0, Math.round(turnFirstDeltaPerf - turnStartPerf)) : latencyMs;

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
    const trailingReply =
      trimmedFinal ||
      (preReplyState.sentBubbles.length > 0 ? "" : "嗯……刚刚走神了一下，你再说一遍？");

    const bubbles = trailingReply
      ? splitIntoBubbles(trailingReply, {
          enabled: this.hatoConfig.gateway.bubbles.enabled,
          maxPerTurn: this.hatoConfig.gateway.bubbles.max_per_turn,
          delimiter: this.hatoConfig.gateway.bubbles.delimiter,
        })
      : [];
    const allBubbles = [...preReplyState.sentBubbles, ...bubbles];
    const persistedText = allBubbles.join("\n\n");

    this.repo.appendRawMessage({
      canonicalUserId,
      channel: batch.originChannel,
      role: "assistant",
      content: persistedText,
      createdAt: Math.max(Date.now(), savedUserMsg.createdAt + 1),
    });

    // Re-sync transcript with clean hato_* turn blocks so subsequent turns keep stable prefixes.
    this.refreshTranscriptFromDb();

    const userPreview = batch.combinedText.replace(/\s+/g, " ").trim().slice(0, 60) || null;

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
      recalledIds: [],
      timeCardText: this.lastTimeCardSnapshot,
      toolCalls,
      latencyMs,
    });

    return {
      rawText: persistedText,
      bubbles,
      earlyBubbles: preReplyState.sentBubbles,
      usage: totalUsage,
      toolCalls,
      latencyMs,
      ttftMs,
      cacheHitRate: turnMetrics.cacheHitRate,
      tps: turnMetrics.decodeTps,
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
    const systemPrompt = buildStaticSystemPrompt(this.basePersonaPrompt, this.repo);
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
      firstDeltaPerf !== null ? Math.max(1, nowPerf - firstDeltaPerf) : Math.max(1, latencyMs - ttftMs);

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

    return extractAssistantText(result).trim();
  }
}

function buildDefaultPreToolAck(toolName: string, input: unknown): string {
  switch (toolName) {
    case "browser_task": {
      const rec = input && typeof input === "object" ? (input as { resume?: unknown }) : undefined;
      return rec?.resume ? "好，那我接着去看" : "好，我去打开浏览器看看";
    }
    case "web_search":
      return "等我一下，我帮你查查看";
    case "web_fetch":
      return "我先打开这个链接看看";
    case "inspect_tickets":
      return "等我一下，我看一眼工单状态";
    case "list_schedules":
      return "我帮你看一下定时安排";
    case "calc":
    case "date_math":
      return "等我算一下";
    default:
      return "等我一下，我去处理看看";
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
