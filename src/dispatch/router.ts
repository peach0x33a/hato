import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { resolveSkillsDir, type HatoConfig } from "../config/app.js";
import { resolveMcpServerEntries, type McpConfig } from "../config/mcp.js";
import { supportsCustomFetchOption, type ModelRegistry } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type { HatoRepository, RawMessageRecord } from "../db/repo.js";
import type { MemoryStore } from "../memory/store.js";
import { loadZoneSkills } from "../skills/loader.js";
import { computeTurnMetrics, formatLlmTelemetryLog } from "../stats/metrics.js";
import { formatLocalDateTime } from "../time/clock.js";
import { logWarn, summarizeError } from "../utils/logger.js";
import {
  InputClassifierDecisionSchema,
  RouterDecisionSchema,
  WORKER_BACKENDS,
  type InputClassifierDecision,
  type RouterDecision,
  type WorkerBackend,
} from "./schema.js";

const DEFAULT_ROUTER_PROMPT = `You are Hato's Neutral Router. Select either "schedule_op", "ticket", or "needs_input" and output strict JSON only. Never rewrite technical requirements; select the contiguous { from_msg_id, to_msg_id } interval and authorize only necessary worker skills/MCP servers.`;

const DEFAULT_INPUT_CLASSIFIER_PROMPT = `You are Hato's neutral input classifier. When active tickets are in "needs_input" state, decide whether the latest user message answers one of those tickets ("reply_ticket" with ticket_id and objective_reply) or is unrelated conversation / a new request for Persona ("persona_chat"). Output JSON only.`;

export interface NeutralRouterDeps {
  getHatoConfig: () => HatoConfig;
  getMcpConfig: () => McpConfig;
  modelRegistry: ModelRegistry;
  proxyRouter: ScopedProxyRouter;
  repo: HatoRepository;
  getMemoryStore?: () => MemoryStore | null;
}

/**
 * Neutral Router & Input Classifier (Wall 1 & Wall 2).
 * Completely isolated from `prompts/persona.md` and the `persona` memory bank.
 */
export class NeutralRouter {
  constructor(private readonly deps: NeutralRouterDeps) {}

  private loadRouterSystemPrompt(): string {
    const cfg = this.deps.getHatoConfig();
    const candidate = resolve(cfg.paths.prompts_dir, "router.md");
    if (existsSync(candidate)) {
      const text = readFileSync(candidate, "utf8").trim();
      if (text) return text;
    }
    return DEFAULT_ROUTER_PROMPT;
  }

  async routeDelegation(params: {
    canonicalUserId: string;
    hint: string;
    urgency?: "normal" | "high";
  }): Promise<RouterDecision> {
    const cfg = this.deps.getHatoConfig();
    const recentMsgs = this.deps.repo.listRecentMessages(params.canonicalUserId, 15);
    const recentIds = new Set(recentMsgs.map((m) => m.id));
    const lastUserMsg = [...recentMsgs].reverse().find((m) => m.role === "user") ?? recentMsgs[recentMsgs.length - 1];

    const workerSkills = loadZoneSkills(resolveSkillsDir(cfg), "worker");
    const workerMcpServers = resolveMcpServerEntries(this.deps.getMcpConfig(), "worker").filter(
      (s) => s.enabled,
    );
    const scripts = this.deps.repo.listScripts(20);
    const openLoops = this.deps.repo.listOpenLoops(params.canonicalUserId, 10);

    let techFactsText = "(无)";
    const memoryStore = this.deps.getMemoryStore?.();
    if (memoryStore && memoryStore.isConfigured()) {
      try {
        const recalled = await memoryStore.recall(params.canonicalUserId, {
          bank: "tech",
          query: params.hint,
          limit: 5,
        });
        if (recalled.items.length > 0) {
          techFactsText = recalled.items.map((r) => `- ${r.content}`).join("\n");
        }
      } catch {
        techFactsText = "(tech 记忆暂不可用)";
      }
    }

    const enabledBackends = getEnabledBackends(cfg);
    const formattedMsgs = formatNumberedMessages(recentMsgs, cfg.owner.timezone);
    const userPayload = [
      `[delegate hint (urgency=${params.urgency ?? "normal"})]: ${params.hint}`,
      `[default_backend]: ${cfg.worker.default_backend}`,
      `[enabled_backends]: ${enabledBackends.join(", ")}`,
      `[allowed_repos]: ${cfg.worker.external_cli.allowed_repos.length > 0 ? cfg.worker.external_cli.allowed_repos.join(", ") : "(none)"}`,
      `[worker_skills]: ${workerSkills.length > 0 ? workerSkills.map((s) => `${s.name} (${s.description})`).join("; ") : "(none)"}`,
      `[worker_mcp_servers]: ${workerMcpServers.length > 0 ? workerMcpServers.map((s) => `${s.name} (${s.description || s.transport})`).join("; ") : "(none)"}`,
      `[script_registry]: ${scripts.length > 0 ? scripts.map((s) => `${s.id}:${s.name} cron=${s.cronExpr} enabled=${s.enabled}`).join("; ") : "(none)"}`,
      `[open_loops]: ${openLoops.length > 0 ? openLoops.map((l) => `${l.id}:${l.content} status=${l.status}`).join("; ") : "(none)"}`,
      `[tech_bank_context]:\n${techFactsText}`,
      `[recent_messages (${recentMsgs.length})]:\n${formattedMsgs}`,
    ].join("\n\n");

    try {
      const rawText = await this.callRouterSlot(
        params.canonicalUserId,
        this.loadRouterSystemPrompt(),
        userPayload,
        "router",
      );
      const parsed = extractJsonObject(rawText);
      if (parsed && Value.Check(RouterDecisionSchema, parsed)) {
        if (parsed.decision === "ticket") {
          const validFrom = recentIds.has(parsed.context_range.from_msg_id)
            ? parsed.context_range.from_msg_id
            : (recentMsgs[0]?.id ?? lastUserMsg?.id ?? "");
          const validTo = recentIds.has(parsed.context_range.to_msg_id)
            ? parsed.context_range.to_msg_id
            : (lastUserMsg?.id ?? recentMsgs[recentMsgs.length - 1]?.id ?? validFrom);

          const backend = enabledBackends.includes(parsed.backend)
            ? parsed.backend
            : cfg.worker.default_backend;

          const validSkillSet = new Set(workerSkills.map((s) => s.name));
          const validMcpSet = new Set(workerMcpServers.map((m) => m.name));

          return {
            ...parsed,
            backend,
            context_range: {
              from_msg_id: validFrom,
              to_msg_id: validTo,
            },
            skills: (parsed.skills ?? []).filter((s) => validSkillSet.has(s)),
            allowed_mcp_servers: (parsed.allowed_mcp_servers ?? []).filter((m) => validMcpSet.has(m)),
          };
        }
        return parsed;
      }
    } catch (err) {
      logWarn("ROUTER", `Router LLM failed, falling back deterministically: ${summarizeError(err)}`);
    }

    return buildFallbackTicketDecision(cfg, recentMsgs, params.hint);
  }

  async classifyNeedsInputReply(params: {
    canonicalUserId: string;
    latestUserText: string;
    needsInputTickets: ReadonlyArray<{ id: string; briefTitle: string; question?: string }>;
  }): Promise<InputClassifierDecision> {
    if (params.needsInputTickets.length === 0) {
      return { route: "persona_chat" };
    }

    const cfg = this.deps.getHatoConfig();
    const recentMsgs = this.deps.repo.listRecentMessages(params.canonicalUserId, 8);
    const prompt = [
      `[needs_input_tickets]:\n${params.needsInputTickets
        .map((t) => `- ${t.id} (${t.briefTitle})${t.question ? ` | question: ${t.question}` : ""}`)
        .join("\n")}`,
      `[recent_messages]:\n${formatNumberedMessages(recentMsgs, cfg.owner.timezone)}`,
      `[latest_user_message]:\n${params.latestUserText}`,
      'Output JSON: { "route": "reply_ticket" | "persona_chat", "ticket_id"?: "...", "objective_reply"?: "..." }',
    ].join("\n\n");

    try {
      const rawText = await this.callRouterSlot(
        params.canonicalUserId,
        DEFAULT_INPUT_CLASSIFIER_PROMPT,
        prompt,
        "input-router",
      );
      const parsed = extractJsonObject(rawText);
      if (parsed && Value.Check(InputClassifierDecisionSchema, parsed)) {
        if (
          parsed.route === "reply_ticket" &&
          parsed.ticket_id &&
          params.needsInputTickets.some((t) => t.id === parsed.ticket_id)
        ) {
          return parsed;
        }
        return { route: "persona_chat" };
      }
    } catch (err) {
      logWarn("ROUTER", `Input classifier failed, routing to persona: ${summarizeError(err)}`);
    }

    return { route: "persona_chat" };
  }

  private async callRouterSlot(
    canonicalUserId: string,
    systemPrompt: string,
    userPrompt: string,
    label: string,
  ): Promise<string> {
    const cfg = this.deps.getHatoConfig();
    const resolved = this.deps.modelRegistry.resolveSlot("router");
    const callStart = performance.now();
    let firstDeltaPerf: number | null = null;

    const messages: Message[] = [
      {
        role: "user",
        content: userPrompt,
        timestamp: Date.now(),
      },
    ];

    const result: AssistantMessage = await this.deps.proxyRouter.runWithScope(
      `llm-calling.${resolved.model.provider}`,
      async () => {
        const scopedFetch: typeof globalThis.fetch = (input, init) =>
          this.deps.proxyRouter.scopedFetch(input, init, `llm-calling.${resolved.model.provider}`);
        const stream = this.deps.modelRegistry.models.streamSimple(
          resolved.model,
          { systemPrompt, messages },
          {
            apiKey: this.deps.modelRegistry.resolveApiKeyForProvider(resolved.model.provider),
            disableContinuation: true,
            ...(supportsCustomFetchOption(resolved.model.api) ? { fetch: scopedFetch } : {}),
            reasoning: resolved.model.reasoning ? "minimal" : undefined,
          },
        );
        for await (const ev of stream) {
          if (
            firstDeltaPerf === null &&
            (ev.type === "text_delta" || ev.type === "thinking_delta") &&
            ev.delta.length > 0
          ) {
            firstDeltaPerf = performance.now();
          }
        }
        return stream.result();
      },
    );

    const nowPerf = performance.now();
    const latencyMs = Math.max(1, Math.round(nowPerf - callStart));
    const ttftMs =
      firstDeltaPerf !== null ? Math.max(0, Math.round(firstDeltaPerf - callStart)) : latencyMs;
    const decodeMs =
      firstDeltaPerf !== null ? Math.max(1, nowPerf - firstDeltaPerf) : Math.max(1, latencyMs - ttftMs);

    console.log(
      formatLlmTelemetryLog({
        slot: "router",
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
        costTotal: result.usage.cost.total,
        ttftMs,
        decodeMs,
        latencyMs,
        timeZone: cfg.owner.timezone,
      }),
    );

    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage || "Router LLM failed");
    }

    const metrics = computeTurnMetrics({
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
      latencyMs,
      ttftMs,
      decodeMs,
    });

    this.deps.repo.insertTurnTrace({
      canonicalUserId,
      slot: "router",
      provider: resolved.providerSlug,
      modelId: resolved.model.id,
      api: String(resolved.model.api),
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
      cacheHitRate: metrics.cacheHitRate,
      ttftMs,
      tps: metrics.decodeTps,
      userPreview: `[${label}] ${userPrompt.slice(0, 48)}`,
      recalledIds: [],
      timeCardText: "",
      toolCalls: [],
      latencyMs,
    });

    return result.content
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
}

function getEnabledBackends(config: HatoConfig): WorkerBackend[] {
  const ext = config.worker.external_cli;
  const enabled: WorkerBackend[] = [];
  if (ext.codex?.enabled ?? true) enabled.push("codex");
  if (ext.agy?.enabled ?? true) enabled.push("agy");
  if (ext.opencode_v2?.enabled ?? true) enabled.push("opencode-v2");
  if (ext.external_pi?.enabled ?? false) enabled.push("external-pi");
  if (ext.claude_code?.enabled ?? false) enabled.push("claude-code");
  enabled.push("builtin-pi");
  if (!enabled.includes(config.worker.default_backend)) {
    enabled.unshift(config.worker.default_backend);
  }
  return enabled.filter((b) => WORKER_BACKENDS.includes(b));
}

function buildFallbackTicketDecision(
  config: HatoConfig,
  recentMsgs: readonly RawMessageRecord[],
  hint: string,
): RouterDecision {
  const firstId = recentMsgs[0]?.id ?? "msg_0";
  const lastId = recentMsgs[recentMsgs.length - 1]?.id ?? firstId;
  return {
    decision: "ticket",
    backend: config.worker.default_backend,
    brief_title: hint.trim().slice(0, 32) || "后台任务",
    context_range: {
      from_msg_id: firstId,
      to_msg_id: lastId,
    },
    workspace_mode: "isolated",
    network: "egress",
    skills: [],
    allowed_mcp_servers: [],
    confirm_before: [],
  };
}

function formatNumberedMessages(
  messages: readonly RawMessageRecord[],
  timezone: string,
): string {
  if (messages.length === 0) return "(无最近对话)";
  return messages
    .map((m) => {
      const speaker =
        m.role === "user" ? "USER" : m.role === "assistant" ? "CHAT_RELAY" : "EVENT";
      const stamp = formatLocalDateTime(m.createdAt, timezone).compactStamp;
      return `[${m.id} | ${stamp} | ${speaker}] ${m.content}`;
    })
    .join("\n");
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}
