import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  resolveMemoryCuratorConfig,
  type HatoConfig,
  type ResolvedMemoryCuratorConfig,
} from "../config/app.js";
import { supportsCustomFetchOption, type ModelRegistry } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import type {
  HatoRepository,
  MemorySyncBank,
  MemorySyncRecordView,
  RawMessageRecord,
} from "../db/repo.js";
import { computeTurnMetrics, extractTraceSteps, formatLlmTelemetryLog } from "../stats/metrics.js";
import { formatLocalDateTime } from "../time/clock.js";
import { logInfo, logWarn } from "../utils/logger.js";
import type { MemoryStore } from "./store.js";

const DEFAULT_CURATOR_PROMPT = `You are Hato's neutral, asynchronous Memory Curator. Objectively extract facts worth retaining long-term from timestamped conversation logs and route them strictly into two isolated banks: persona (personal life, preferences, events) and tech (tech stack, environment, engineering habits).
Rules:
1. [CHAT_RELAY] lines are ONLY for coreference disambiguation; never record the assistant's own banter, suggestions, or unconfirmed claims as user facts.
2. Resolve relative time expressions (tomorrow, next week, etc.) into explicit YYYY-MM-DD dates using each message's timestamp.
3. Ignore low-value greetings/filler; write concise standalone third-person objective statements in the user's primary language.
4. Output JSON only: { "persona": [{ "fact": "...", "occurred_at": "YYYY-MM-DD HH:mm" }], "tech": [...] }.`;

export interface CuratorFactItem {
  fact: string;
  occurredAt?: string;
}

export interface CuratorExtractionOutput {
  persona: CuratorFactItem[];
  tech: CuratorFactItem[];
}

export interface RetainRunSummary {
  processedMessages: number;
  extractedCount: number;
  syncedCount: number;
  degradedCount: number;
  deniedCount: number;
  errorCount: number;
  retriedCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface ForgetRunSummary {
  matchedCount: number;
  erasedLocalCount: number;
  erasedRemoteCount: number;
  alreadyErasedCount: number;
  missingRemoteCount: number;
  unmappedCount: number;
  failedCount: number;
  errors: string[];
  matchedContents: string[];
}

/**
 * Coordinates asynchronous neutral memory extraction (Curator slot), bank routing
 * (`persona` vs `tech`), pre-compaction retention, degraded retries, and `/forget`.
 */
export class MemoryCurator {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly userLocks = new Map<string, Promise<unknown>>();
  private curatorPrompt = DEFAULT_CURATOR_PROMPT;

  constructor(
    private hatoConfig: HatoConfig,
    private readonly modelRegistry: ModelRegistry,
    private readonly proxyRouter: ScopedProxyRouter,
    private readonly repo: HatoRepository,
    private memoryStore: MemoryStore | null,
  ) {
    this.reloadPrompt();
  }

  updateConfig(nextConfig: HatoConfig, nextStore?: MemoryStore | null): void {
    this.hatoConfig = nextConfig;
    if (nextStore !== undefined) {
      this.memoryStore = nextStore;
    }
    this.reloadPrompt();
  }

  reloadPrompt(): void {
    const promptPath = resolve(this.hatoConfig.paths.prompts_dir, "curator.md");
    if (existsSync(promptPath)) {
      this.curatorPrompt = readFileSync(promptPath, "utf8").trim() || DEFAULT_CURATOR_PROMPT;
    } else {
      this.curatorPrompt = DEFAULT_CURATOR_PROMPT;
    }
  }

  getCuratorConfig(): ResolvedMemoryCuratorConfig {
    return resolveMemoryCuratorConfig(this.hatoConfig);
  }

  isActive(): boolean {
    return (
      this.getCuratorConfig().enabled &&
      Boolean(this.memoryStore && this.memoryStore.isConfigured())
    );
  }

  /**
   * Schedule idle extraction or trigger immediate batch extraction once pending messages
   * exceed `batch_message_threshold`.
   */
  recordInteraction(canonicalUserId: string): void {
    this.clearUserTimer(canonicalUserId);
    if (!this.isActive()) return;

    const cfg = this.getCuratorConfig();
    const pending = this.repo.listMessagesPendingRetain(canonicalUserId, cfg.batchMessageThreshold + 1);
    if (pending.length >= cfg.batchMessageThreshold) {
      void this.retainPending(canonicalUserId).catch((err) => {
        logWarn(
          "CURATOR",
          `batch retain failed for ${canonicalUserId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return;
    }

    const idleMs = Math.max(1, cfg.idleRetainAfterMinutes) * 60_000;
    const timer = setTimeout(() => {
      this.timers.delete(canonicalUserId);
      void this.retainPending(canonicalUserId).catch((err) => {
        logWarn(
          "CURATOR",
          `idle retain failed for ${canonicalUserId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, idleMs);
    timer.unref();
    this.timers.set(canonicalUserId, timer);
  }

  /**
   * Pre-compaction hook: guarantee messages leaving the hot zone have been distilled
   * and queued/synced before CompactionManager truncates them.
   */
  async retainBeforeCompaction(
    canonicalUserId: string,
    messagesToCompact: readonly RawMessageRecord[],
  ): Promise<RetainRunSummary> {
    if (messagesToCompact.length === 0 || !this.isActive()) {
      return emptySummary();
    }
    const cutoffMsg = messagesToCompact[messagesToCompact.length - 1]!;
    return this.runWithUserLock(canonicalUserId, () =>
      this.retainUpTo(canonicalUserId, {
        maxCreatedAt: cutoffMsg.createdAt,
        maxMsgId: cutoffMsg.id,
        includeDeniedRetries: false,
      }),
    );
  }

  /**
   * Flush all pending messages (and optionally retry previously failed/denied syncs).
   */
  async retainPending(
    canonicalUserId: string,
    opts?: { includeDeniedRetries?: boolean },
  ): Promise<RetainRunSummary> {
    if (!this.isActive()) {
      return emptySummary();
    }
    return this.runWithUserLock(canonicalUserId, () =>
      this.retainUpTo(canonicalUserId, {
        includeDeniedRetries: opts?.includeDeniedRetries ?? false,
      }),
    );
  }

  /**
   * Retry degraded/error (and optionally denied) memory sync records without re-running LLM extraction.
   */
  async retryPendingSyncs(
    canonicalUserId: string,
    opts?: { includeDenied?: boolean },
  ): Promise<Pick<RetainRunSummary, "retriedCount" | "syncedCount" | "degradedCount" | "deniedCount" | "errorCount" | "lastErrorCode" | "lastErrorMessage">> {
    if (!this.memoryStore || !this.memoryStore.isConfigured()) {
      return {
        retriedCount: 0,
        syncedCount: 0,
        degradedCount: 0,
        deniedCount: 0,
        errorCount: 0,
      };
    }
    return this.runWithUserLock(canonicalUserId, () =>
      this.retrySyncRecordsInternal(canonicalUserId, opts?.includeDenied ?? false),
    );
  }

  /**
   * Cascade forget matching memory records remotely (MemoryEcho `/messages/erase`) and locally in SQLite.
   */
  async forgetByQuery(canonicalUserId: string, query: string): Promise<ForgetRunSummary> {
    const trimmed = query.trim();
    if (!trimmed) {
      return {
        matchedCount: 0,
        erasedLocalCount: 0,
        erasedRemoteCount: 0,
        alreadyErasedCount: 0,
        missingRemoteCount: 0,
        unmappedCount: 0,
        failedCount: 0,
        errors: [],
        matchedContents: [],
      };
    }

    return this.runWithUserLock(canonicalUserId, async () => {
      const matches = this.repo.searchMemorySyncRecords(canonicalUserId, trimmed, 50);
      if (matches.length === 0) {
        return {
          matchedCount: 0,
          erasedLocalCount: 0,
          erasedRemoteCount: 0,
          alreadyErasedCount: 0,
          missingRemoteCount: 0,
          unmappedCount: 0,
          failedCount: 0,
          errors: [],
          matchedContents: [],
        };
      }

      const byBank: Record<MemorySyncBank, MemorySyncRecordView[]> = {
        persona: [],
        tech: [],
      };
      for (const rec of matches) {
        byBank[rec.bank].push(rec);
      }

      const summary: ForgetRunSummary = {
        matchedCount: matches.length,
        erasedLocalCount: 0,
        erasedRemoteCount: 0,
        alreadyErasedCount: 0,
        missingRemoteCount: 0,
        unmappedCount: 0,
        failedCount: 0,
        errors: [],
        matchedContents: matches.map((m) => m.content),
      };

      const localIdsToErase: string[] = [];

      for (const bank of ["persona", "tech"] as const) {
        const records = byBank[bank];
        if (records.length === 0) continue;

        const withoutRemoteId = records.filter((r) => !r.externalMemoryId);
        for (const r of withoutRemoteId) {
          localIdsToErase.push(r.id);
        }

        const withRemote = records.filter((r) => Boolean(r.externalMemoryId));
        if (withRemote.length === 0) continue;

        if (!this.memoryStore || !this.memoryStore.isConfigured()) {
          summary.failedCount += withRemote.length;
          summary.errors.push(`记忆提供商当前未启用，无法从远程 ${bank} 库删除 ${withRemote.length} 条记录`);
          continue;
        }

        const remoteIds = withRemote.map((r) => r.externalMemoryId!);
        const eraseRes = await this.memoryStore.erase(canonicalUserId, {
          bank,
          memoryIds: remoteIds,
        });

        if (!eraseRes.ok) {
          summary.failedCount += withRemote.length;
          summary.errors.push(eraseRes.errorMessage ?? `远程 ${bank} 库删除失败`);
          continue;
        }

        summary.erasedRemoteCount += eraseRes.erased.length;
        summary.alreadyErasedCount += eraseRes.alreadyErased.length;
        summary.missingRemoteCount += eraseRes.missing.length;
        summary.unmappedCount += eraseRes.unmapped.length;

        const unmappedSet = new Set(eraseRes.unmapped);
        for (const rec of withRemote) {
          if (!unmappedSet.has(rec.externalMemoryId!)) {
            localIdsToErase.push(rec.id);
          }
        }
      }

      if (localIdsToErase.length > 0) {
        this.repo.markMemoryRecordsErased(localIdsToErase);
        summary.erasedLocalCount = localIdsToErase.length;
      }

      return summary;
    });
  }

  dispose(): void {
    for (const key of [...this.timers.keys()]) {
      this.clearUserTimer(key);
    }
  }

  private clearUserTimer(canonicalUserId: string): void {
    const timer = this.timers.get(canonicalUserId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(canonicalUserId);
  }

  private runWithUserLock<T>(canonicalUserId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.userLocks.get(canonicalUserId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.userLocks.set(canonicalUserId, tail);
    void tail.finally(() => {
      if (this.userLocks.get(canonicalUserId) === tail) {
        this.userLocks.delete(canonicalUserId);
      }
    });
    return next;
  }

  private async retainUpTo(
    canonicalUserId: string,
    opts: { maxCreatedAt?: number; maxMsgId?: string; includeDeniedRetries: boolean },
  ): Promise<RetainRunSummary> {
    const summary = emptySummary();
    if (!this.memoryStore || !this.memoryStore.isConfigured()) {
      return summary;
    }

    const retried = await this.retrySyncRecordsInternal(canonicalUserId, opts.includeDeniedRetries);
    summary.retriedCount = retried.retriedCount;
    summary.syncedCount += retried.syncedCount;
    summary.degradedCount += retried.degradedCount;
    summary.deniedCount += retried.deniedCount;
    summary.errorCount += retried.errorCount;
    summary.lastErrorCode = retried.lastErrorCode;
    summary.lastErrorMessage = retried.lastErrorMessage;

    const cfg = this.getCuratorConfig();
    let pending = this.repo.listMessagesPendingRetain(canonicalUserId, 200);
    if (opts.maxCreatedAt !== undefined && opts.maxMsgId !== undefined) {
      pending = pending.filter(
        (m) =>
          m.createdAt < opts.maxCreatedAt! ||
          (m.createdAt === opts.maxCreatedAt! && m.id <= opts.maxMsgId!),
      );
    }
    if (pending.length === 0) return summary;

    const chunkSize = Math.max(2, cfg.maxBatchMessages);
    for (let i = 0; i < pending.length; i += chunkSize) {
      const chunk = pending.slice(i, i + chunkSize);
      const lastMsg = chunk[chunk.length - 1]!;
      const hasUserOrEvent = chunk.some(
        (m) => (m.role === "user" || m.role === "executed_event") && m.content.trim().length > 0,
      );

      if (!hasUserOrEvent) {
        this.repo.markRetainedUntil(canonicalUserId, lastMsg.id);
        summary.processedMessages += chunk.length;
        continue;
      }

      let extracted: CuratorExtractionOutput;
      try {
        extracted = await this.extractMemoriesWithCuratorLlm(canonicalUserId, chunk);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarn("CURATOR", `extraction LLM call failed for ${canonicalUserId}: ${msg}`);
        summary.errorCount++;
        summary.lastErrorMessage = msg;
        break;
      }

      const sourceMsgIds = chunk.map((m) => m.id);
      const fallbackStamp = formatFullDateTime(lastMsg.createdAt, this.getEffectiveTimezone(canonicalUserId));

      const persistBankItems = async (bank: MemorySyncBank, items: CuratorFactItem[]) => {
        for (const item of items) {
          const formatted = formatDistilledMemory(item, fallbackStamp);
          summary.extractedCount++;

          const res = await this.memoryStore!.retain(canonicalUserId, {
            bank,
            role: "user",
            content: formatted,
          });

          this.repo.insertMemorySyncRecord({
            canonicalUserId,
            provider: this.memoryStore!.providerName,
            bank,
            vaultId: res.vaultId ?? null,
            sourceMsgIds,
            content: formatted,
            externalMemoryId: res.externalMemoryId ?? null,
            status: res.status,
            errorCode: res.errorCode ?? null,
            errorMessage: res.errorMessage ?? null,
          });

          if (res.status === "synced") summary.syncedCount++;
          else if (res.status === "degraded") summary.degradedCount++;
          else if (res.status === "denied") summary.deniedCount++;
          else summary.errorCount++;

          if (res.errorCode) summary.lastErrorCode = res.errorCode;
          if (res.errorMessage) summary.lastErrorMessage = res.errorMessage;
        }
      };

      await persistBankItems("persona", extracted.persona);
      await persistBankItems("tech", extracted.tech);

      this.repo.markRetainedUntil(canonicalUserId, lastMsg.id);
      summary.processedMessages += chunk.length;
    }

    if (summary.processedMessages > 0 || summary.extractedCount > 0) {
      logInfo(
        "CURATOR",
        `retained ${summary.processedMessages} msgs -> extracted=${summary.extractedCount}, synced=${summary.syncedCount}, degraded=${summary.degradedCount}, denied=${summary.deniedCount}`,
      );
    }

    return summary;
  }

  private async retrySyncRecordsInternal(
    canonicalUserId: string,
    includeDenied: boolean,
  ): Promise<Pick<RetainRunSummary, "retriedCount" | "syncedCount" | "degradedCount" | "deniedCount" | "errorCount" | "lastErrorCode" | "lastErrorMessage">> {
    const out = {
      retriedCount: 0,
      syncedCount: 0,
      degradedCount: 0,
      deniedCount: 0,
      errorCount: 0,
      lastErrorCode: undefined as string | undefined,
      lastErrorMessage: undefined as string | undefined,
    };

    if (!this.memoryStore || !this.memoryStore.isConfigured()) return out;

    const retryables = this.repo.listRetryableMemorySyncRecords(canonicalUserId, {
      includeDenied,
      limit: 40,
    });
    for (const rec of retryables) {
      out.retriedCount++;
      const res = await this.memoryStore.retain(canonicalUserId, {
        bank: rec.bank,
        role: "user",
        content: rec.content,
      });

      this.repo.updateMemorySyncRecord(rec.id, {
        vaultId: res.vaultId ?? rec.vaultId,
        externalMemoryId: res.externalMemoryId ?? rec.externalMemoryId,
        status: res.status,
        errorCode: res.errorCode ?? null,
        errorMessage: res.errorMessage ?? null,
      });

      if (res.status === "synced") out.syncedCount++;
      else if (res.status === "degraded") out.degradedCount++;
      else if (res.status === "denied") out.deniedCount++;
      else out.errorCount++;

      if (res.errorCode) out.lastErrorCode = res.errorCode;
      if (res.errorMessage) out.lastErrorMessage = res.errorMessage;
    }

    return out;
  }

  private async extractMemoriesWithCuratorLlm(
    canonicalUserId: string,
    messages: readonly RawMessageRecord[],
  ): Promise<CuratorExtractionOutput> {
    const resolved = this.modelRegistry.resolveSlot("curator");
    const tz = this.getEffectiveTimezone(canonicalUserId);

    const transcriptLines = messages.map((msg) => {
      const stamp = formatFullDateTime(msg.createdAt, tz);
      const roleTag =
        msg.role === "user"
          ? "USER"
          : msg.role === "assistant"
            ? "CHAT_RELAY"
            : "EVENT";

      let replyPrefix = "";
      if (msg.replyToId) {
        const ref = this.repo.findMessageByPlatformId(msg.channel, msg.replyToId);
        if (ref) {
          const preview = ref.content.replace(/\s+/g, " ").trim().slice(0, 100);
          replyPrefix = `[引用 ${ref.role === "assistant" ? "CHAT_RELAY" : "USER"}: "${preview}"] `;
        }
      }

      const attachmentNotes = msg.attachments
        .map((att) =>
          att.summary
            ? `[附件 ${att.kind}: ${att.summary}]`
            : `[附件 ${att.kind}${att.filename ? `: ${att.filename}` : ""}]`,
        )
        .join(" ");

      const body = [replyPrefix, msg.content.trim(), attachmentNotes]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      return `[${stamp}] [${roleTag}] ${body}`;
    });

    const llmMessages: Message[] = [
      {
        role: "user",
        content: `请根据以下对话日志提取长期记忆并分流：\n\n${transcriptLines.join("\n")}`,
        timestamp: Date.now(),
      },
    ];

    const apiKey = this.modelRegistry.resolveApiKeyForProvider(resolved.providerSlug);
    const scopedFetch: typeof globalThis.fetch = (input, init) =>
      this.proxyRouter.scopedFetch(input, init, `llm-calling.${resolved.providerSlug}`);

    const callStartPerf = performance.now();
    let firstDeltaPerf: number | null = null;
    const result = await this.proxyRouter.runWithScope(`llm-calling.${resolved.providerSlug}`, async () => {
      const stream = this.modelRegistry.models.streamSimple(
        resolved.model,
        { systemPrompt: this.curatorPrompt, messages: llmMessages },
        {
          apiKey,
          sessionId: `${canonicalUserId}:curator`,
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
        slot: "curator",
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
      throw new Error(result.errorMessage || "Curator extraction LLM failed");
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

    this.repo.insertTurnTrace({
      canonicalUserId,
      slot: "curator",
      provider: resolved.providerSlug,
      modelId: result.model,
      api: String(result.api),
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
      cacheHitRate: metrics.cacheHitRate,
      ttftMs,
      tps: metrics.decodeTps,
      userPreview: `[记忆提炼] 分析 ${messages.length} 条日志`,
      recalledIds: [],
      timeCardText: `curator_messages: ${messages.length}`,
      toolCalls: [],
      steps: extractTraceSteps([result]),
      latencyMs,
    });

    const rawText = result.content
      .filter((b): b is Extract<(typeof result.content)[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    return parseCuratorExtractionJson(rawText);
  }

  private getEffectiveTimezone(canonicalUserId: string): string {
    const override = this.repo.getActiveScheduleOverride(canonicalUserId, Date.now());
    return override?.tempTimezone || this.hatoConfig.owner.timezone;
  }
}

export function parseCuratorExtractionJson(rawText: string): CuratorExtractionOutput {
  const cleaned = stripCodeFence(rawText.trim());
  const jsonText = extractFirstJsonObject(cleaned);
  if (!jsonText) {
    throw new Error("Curator 输出未包含合法 JSON 对象");
  }

  const parsed = JSON.parse(jsonText) as {
    persona?: unknown;
    tech?: unknown;
  };

  return {
    persona: normalizeFactList(parsed.persona),
    tech: normalizeFactList(parsed.tech),
  };
}

function normalizeFactList(raw: unknown): CuratorFactItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CuratorFactItem[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    let fact = "";
    let occurredAt: string | undefined;

    if (typeof item === "string") {
      fact = item.trim();
    } else if (item && typeof item === "object") {
      const rec = item as { fact?: unknown; content?: unknown; occurred_at?: unknown };
      if (typeof rec.fact === "string") fact = rec.fact.trim();
      else if (typeof rec.content === "string") fact = rec.content.trim();
      if (typeof rec.occurred_at === "string" && rec.occurred_at.trim()) {
        occurredAt = rec.occurred_at.trim();
      }
    }

    if (!fact) continue;
    const dedupeKey = fact.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ fact, occurredAt });
  }

  return out;
}

function formatDistilledMemory(item: CuratorFactItem, fallbackStamp: string): string {
  const stamp = item.occurredAt || fallbackStamp;
  if (/^\[\d{4}-\d{2}-\d{2}/.test(item.fact)) {
    return item.fact;
  }
  return `[${stamp}] ${item.fact}`;
}

function formatFullDateTime(tsMs: number, timeZone: string): string {
  const local = formatLocalDateTime(tsMs, timeZone);
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
}

function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : text;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function emptySummary(): RetainRunSummary {
  return {
    processedMessages: 0,
    extractedCount: 0,
    syncedCount: 0,
    degradedCount: 0,
    deniedCount: 0,
    errorCount: 0,
    retriedCount: 0,
  };
}
