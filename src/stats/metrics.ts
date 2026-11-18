import { colorize, formatLogLine, shouldUseColor } from "../utils/logger.js";

export interface RawTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  ttftMs?: number | null;
  decodeMs?: number | null;
}

export interface ComputedTurnMetrics {
  totalPromptTokens: number;
  cacheHitRate: number;
  decodeTps: number | null;
  e2eTps: number | null;
}

export type TraceStepRecord =
  | {
      kind: "assistant";
      step: number;
      text: string;
      thinking?: string;
      toolCalls: Array<{ id: string; name: string; args: unknown }>;
      stopReason?: string;
      tokens?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      };
    }
  | {
      kind: "tool";
      step: number;
      toolCallId?: string;
      name: string;
      args?: unknown;
      output: string;
      isError?: boolean;
    };

function clipTraceText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(已截断，共 ${text.length} 字符)`;
}

function formatToolContent(content: unknown): string {
  if (typeof content === "string") return clipTraceText(content.trim(), 4000);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string" && rec.text.trim()) {
      parts.push(rec.text.trim());
    } else if (rec.type === "image") {
      parts.push("[截图/图片内容]");
    }
  }
  return clipTraceText(parts.join("\n"), 4000);
}

/**
 * Extracts chronological assistant outputs (thinking + text + requested tools) and tool results
 * from an Agent message sequence for DSH-style trajectory inspection.
 */
export function extractTraceSteps(messages: readonly unknown[]): TraceStepRecord[] {
  const steps: TraceStepRecord[] = [];
  const pendingArgsById = new Map<string, unknown>();
  let stepNo = 0;

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as {
      role?: unknown;
      content?: unknown;
      stopReason?: unknown;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];

      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (b.type === "text" && typeof b.text === "string" && b.text) {
          textParts.push(b.text);
        } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
          thinkingParts.push(b.thinking);
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          const id = typeof b.id === "string" ? b.id : "";
          const args = b.arguments ?? {};
          if (id) pendingArgsById.set(id, args);
          toolCalls.push({ id, name: b.name, args });
        }
      }

      stepNo += 1;
      steps.push({
        kind: "assistant",
        step: stepNo,
        text: clipTraceText(textParts.join("").trim(), 12000),
        ...(thinkingParts.length > 0
          ? { thinking: clipTraceText(thinkingParts.join("\n").trim(), 8000) }
          : {}),
        toolCalls,
        ...(typeof msg.stopReason === "string" ? { stopReason: msg.stopReason } : {}),
        ...(msg.usage
          ? {
              tokens: {
                input: Number(msg.usage.input ?? 0),
                output: Number(msg.usage.output ?? 0),
                cacheRead: Number(msg.usage.cacheRead ?? 0),
                cacheWrite: Number(msg.usage.cacheWrite ?? 0),
              },
            }
          : {}),
      });
    } else if (msg.role === "toolResult") {
      const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
      const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
      const output = formatToolContent(msg.content);
      const args = toolCallId ? pendingArgsById.get(toolCallId) : undefined;
      stepNo += 1;
      steps.push({
        kind: "tool",
        step: stepNo,
        ...(toolCallId ? { toolCallId } : {}),
        name,
        ...(args !== undefined ? { args } : {}),
        output,
        ...(msg.isError ? { isError: true } : {}),
      });
    }
  }

  return steps;
}

export interface TurnTraceStatRow {
  id: string;
  canonicalUserId: string;
  slot: string;
  provider: string;
  modelId: string;
  api: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  ttftMs: number | null;
  tps: number | null;
  latencyMs: number;
  userPreview: string | null;
  toolCallsJson: string;
  createdAt: number;
}

export interface ModelCostRates {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface TurnStatsSummary {
  turns: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalPromptTokens: number;
  totalOutputTokens: number;
  weightedCacheHitRate: number;
  warmCacheHitRate: number | null;
  warmTurns: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  measuredTtftCount: number;
  avgDecodeTps: number | null;
  avgE2eTps: number | null;
  measuredTpsCount: number;
  totalCostUsd: number;
  totalSavedUsd: number;
  pricedTurns: number;
}

/**
 * Compute USD cost and cache savings for a single turn using USD-per-1M-token rates.
 */
export function computeTurnCostUsd(
  row: Pick<TurnTraceStatRow, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  rates: ModelCostRates,
): { costUsd: number; savedUsd: number } {
  const inputRate = rates.input ?? 0;
  const outputRate = rates.output ?? 0;
  const cacheReadRate = rates.cache_read ?? 0;
  const cacheWriteRate = rates.cache_write ?? 0;

  const costUsd =
    (Math.max(0, row.inputTokens) * inputRate +
      Math.max(0, row.outputTokens) * outputRate +
      Math.max(0, row.cacheReadTokens) * cacheReadRate +
      Math.max(0, row.cacheWriteTokens) * cacheWriteRate) /
    1_000_000;

  const savedUsd =
    inputRate > cacheReadRate
      ? (Math.max(0, row.cacheReadTokens) * (inputRate - cacheReadRate)) / 1_000_000
      : 0;

  return { costUsd, savedUsd };
}

/**
 * Compute normalized cache hit rate and generation TPS from turn usage and timing.
 * Across pi-ai providers, usage.input represents uncached prompt tokens, so
 * total prompt tokens = inputTokens + cacheReadTokens + cacheWriteTokens.
 */
export function computeTurnMetrics(input: RawTurnUsage): ComputedTurnMetrics {
  const uncached = Math.max(0, input.inputTokens);
  const cacheRead = Math.max(0, input.cacheReadTokens);
  const cacheWrite = Math.max(0, input.cacheWriteTokens);
  const output = Math.max(0, input.outputTokens);
  const totalPromptTokens = uncached + cacheRead + cacheWrite;

  const cacheHitRate =
    totalPromptTokens > 0 ? Number((cacheRead / totalPromptTokens).toFixed(4)) : 0;

  const e2eTps =
    input.latencyMs > 0 && output > 0
      ? Number((output / (input.latencyMs / 1000)).toFixed(2))
      : null;

  let decodeTps: number | null = null;
  if (output > 0) {
    // Guard against <50ms decode windows caused by buffered/coalesced SSE chunks or
    // non-streaming responses where firstDeltaPerf == endPerf.
    const MIN_STREAMING_DECODE_MS = 50;
    const rawDecodeWindowMs =
      typeof input.decodeMs === "number" && input.decodeMs > 0
        ? input.decodeMs
        : typeof input.ttftMs === "number" && input.latencyMs > input.ttftMs
          ? input.latencyMs - input.ttftMs
          : null;
    const decodeWindowMs =
      output >= 2 && rawDecodeWindowMs !== null && rawDecodeWindowMs >= MIN_STREAMING_DECODE_MS
        ? rawDecodeWindowMs
        : input.latencyMs;
    if (decodeWindowMs > 0) {
      decodeTps = Number((output / (decodeWindowMs / 1000)).toFixed(2));
    }
  }

  return {
    totalPromptTokens,
    cacheHitRate,
    decodeTps,
    e2eTps,
  };
}

/**
 * Aggregate overall cache hit rate, latency percentiles, TTFT, and TPS across trace rows.
 */
export function summarizeTurnTraces(
  rows: readonly TurnTraceStatRow[],
  resolveCostRates?: (provider: string, modelId: string) => ModelCostRates | undefined,
): TurnStatsSummary {
  const turns = rows.length;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalSavedUsd = 0;
  let pricedTurns = 0;

  let warmCacheRead = 0;
  let warmPromptTokens = 0;
  let warmTurns = 0;

  const latencies: number[] = [];
  const ttfts: number[] = [];
  const decodeTpsList: number[] = [];
  const e2eTpsList: number[] = [];

  for (const row of rows) {
    const promptTokens = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    totalInputTokens += row.inputTokens;
    totalCacheReadTokens += row.cacheReadTokens;
    totalCacheWriteTokens += row.cacheWriteTokens;
    totalOutputTokens += row.outputTokens;

    if (row.cacheReadTokens > 0 && promptTokens > 0) {
      warmTurns += 1;
      warmCacheRead += row.cacheReadTokens;
      warmPromptTokens += promptTokens;
    }

    if (row.latencyMs > 0) {
      latencies.push(row.latencyMs);
    }
    if (typeof row.ttftMs === "number" && row.ttftMs >= 0) {
      ttfts.push(row.ttftMs);
    }
    const rowE2eTps =
      row.latencyMs > 0 && row.outputTokens > 0
        ? row.outputTokens / (row.latencyMs / 1000)
        : null;
    if (rowE2eTps !== null) {
      e2eTpsList.push(rowE2eTps);
    }
    const hasBogusDecodeWindow =
      typeof row.ttftMs === "number" && row.latencyMs > 0 && row.latencyMs - row.ttftMs < 50;
    if (typeof row.tps === "number" && row.tps > 0 && !hasBogusDecodeWindow) {
      decodeTpsList.push(row.tps);
    } else if (rowE2eTps !== null && hasBogusDecodeWindow) {
      decodeTpsList.push(rowE2eTps);
    }

    if (resolveCostRates) {
      const rates = resolveCostRates(row.provider, row.modelId);
      if (rates) {
        pricedTurns += 1;
        const { costUsd, savedUsd } = computeTurnCostUsd(row, rates);
        totalCostUsd += costUsd;
        totalSavedUsd += savedUsd;
      }
    }
  }

  const totalPromptTokens = totalInputTokens + totalCacheReadTokens + totalCacheWriteTokens;
  const weightedCacheHitRate =
    totalPromptTokens > 0 ? Number((totalCacheReadTokens / totalPromptTokens).toFixed(4)) : 0;
  const warmCacheHitRate =
    warmPromptTokens > 0 ? Number((warmCacheRead / warmPromptTokens).toFixed(4)) : null;

  return {
    turns,
    totalInputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalPromptTokens,
    totalOutputTokens,
    weightedCacheHitRate,
    warmCacheHitRate,
    warmTurns,
    avgLatencyMs: Math.round(average(latencies) ?? 0),
    p50LatencyMs: Math.round(percentile(latencies, 0.5) ?? 0),
    p95LatencyMs: Math.round(percentile(latencies, 0.95) ?? 0),
    avgTtftMs: ttfts.length > 0 ? Math.round(average(ttfts)!) : null,
    p50TtftMs: ttfts.length > 0 ? Math.round(percentile(ttfts, 0.5)!) : null,
    p95TtftMs: ttfts.length > 0 ? Math.round(percentile(ttfts, 0.95)!) : null,
    measuredTtftCount: ttfts.length,
    avgDecodeTps:
      decodeTpsList.length > 0 ? Number((average(decodeTpsList)!).toFixed(2)) : null,
    avgE2eTps: e2eTpsList.length > 0 ? Number((average(e2eTpsList)!).toFixed(2)) : null,
    measuredTpsCount: decodeTpsList.length,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    totalSavedUsd: Number(totalSavedUsd.toFixed(6)),
    pricedTurns,
  };
}

export function formatCacheHitRate(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Parse a relative lookback span like "1h", "24h", "7d", "30m" or ISO date string into epoch ms.
 */
export function parseSinceSpec(spec: string, nowMs = Date.now()): number {
  const trimmed = spec.trim();
  const rel = /^(\d+)\s*([mhdw])$/i.exec(trimmed);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const mult =
      unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : unit === "d"
            ? 86_400_000
            : 7 * 86_400_000;
    return nowMs - amount * mult;
  }

  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) {
    throw new Error(`Invalid --since value "${spec}". Examples: 30m, 2h, 7d, 2026-11-16`);
  }
  return ts;
}

/**
 * Render human-readable CLI report for `npm run statics`.
 */
export function renderStaticsReport(
  rows: readonly TurnTraceStatRow[],
  options?: { dbPath?: string; filtersLabel?: string },
): string {
  const summary = summarizeTurnTraces(rows);
  const lines: string[] = [];

  lines.push("=== Hato 模型调用与缓存统计 (statics) ===");
  if (options?.dbPath) {
    lines.push(`数据库: ${options.dbPath}${options.filtersLabel ? `  |  筛选: ${options.filtersLabel}` : ""}`);
  }

  if (rows.length === 0) {
    lines.push("暂无匹配的调用记录。");
    return lines.join("\n");
  }

  const warmPart =
    summary.warmCacheHitRate !== null
      ? `（非零命中 ${summary.warmTurns}/${summary.turns} 轮均值 ${formatCacheHitRate(summary.warmCacheHitRate)}）`
      : "（尚无缓存命中轮次）";

  lines.push("");
  lines.push("【汇总概览】");
  lines.push(`- 统计轮数: ${summary.turns} 轮`);
  lines.push(
    `- 缓存命中率: ${formatCacheHitRate(summary.weightedCacheHitRate)} (cache_read=${summary.totalCacheReadTokens} / prompt=${summary.totalPromptTokens}, cache_write=${summary.totalCacheWriteTokens}) ${warmPart}`,
  );
  lines.push(
    `- 首字时间 (TTFT): ${
      summary.avgTtftMs !== null
        ? `avg ${summary.avgTtftMs}ms · P50 ${summary.p50TtftMs}ms · P95 ${summary.p95TtftMs}ms（已记录 ${summary.measuredTtftCount} 轮）`
        : "暂无记录（历史旧记录未采集首字时间）"
    }`,
  );
  lines.push(
    `- 每轮耗时: avg ${summary.avgLatencyMs}ms · P50 ${summary.p50LatencyMs}ms · P95 ${summary.p95LatencyMs}ms`,
  );
  lines.push(
    `- 生成速度 (TPS): ${
      summary.avgDecodeTps !== null
        ? `decode avg ${summary.avgDecodeTps} tok/s（已记录 ${summary.measuredTpsCount} 轮）`
        : "decode 暂无记录"
    }${summary.avgE2eTps !== null ? ` · 端到端 avg ${summary.avgE2eTps} tok/s` : ""} · total out=${summary.totalOutputTokens}`,
  );

  lines.push("");
  lines.push("【逐轮明细（按时间倒序）】");

  const headers = ["时间", "模型", "缓存命中", "Tokens(命中/总入/出)", "首字(TTFT)", "总耗时", "TPS", "消息"];
  const tableRows = rows.map((row) => {
    const promptTokens = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    const hitPct =
      row.cacheHitRate > 0 || promptTokens === 0
        ? formatCacheHitRate(row.cacheHitRate)
        : formatCacheHitRate(row.cacheReadTokens / promptTokens);
    const e2eTps =
      row.latencyMs > 0 && row.outputTokens > 0
        ? `${(row.outputTokens / (row.latencyMs / 1000)).toFixed(1)}*`
        : "-";
    const tpsText = row.tps !== null && row.tps > 0 ? `${row.tps.toFixed(1)} tok/s` : e2eTps;
    const preview = (row.userPreview ?? "").replace(/\s+/g, " ").trim();
    return [
      formatShortTime(row.createdAt),
      `${row.provider}/${row.modelId}`,
      hitPct,
      `${row.cacheReadTokens}/${promptTokens}/${row.outputTokens}`,
      row.ttftMs !== null ? `${row.ttftMs}ms` : "-",
      `${row.latencyMs}ms`,
      tpsText,
      preview ? truncateDisplay(preview, 28) : "-",
    ];
  });

  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...tableRows.map((r) => displayWidth(r[i]!))),
  );
  lines.push(formatAlignedRow(headers, widths));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of tableRows) {
    lines.push(formatAlignedRow(r, widths));
  }
  lines.push("");
  lines.push("注: TPS 带 `*` 表示历史旧记录未记录首字/流式分段，按 output_tokens / total_latency_ms 估算端到端吞吐。");

  return lines.join("\n");
}

function formatShortTime(epochMs: number): string {
  const d = new Date(epochMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function average(nums: readonly number[]): number | null {
  if (nums.length === 0) return null;
  let sum = 0;
  for (const n of nums) sum += n;
  return sum / nums.length;
}

function percentile(nums: readonly number[], p: number): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx]!;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0x1f300 && code <= 0x1faff);
    width += isWide ? 2 : 1;
  }
  return width;
}

function truncateDisplay(text: string, maxWidth: number): string {
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > maxWidth - 1) {
      return `${out}…`;
    }
    out += ch;
    width += w;
  }
  return out;
}

function formatAlignedRow(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, i) => {
      const pad = Math.max(0, widths[i]! - displayWidth(cell));
      return `${cell}${" ".repeat(pad)}`;
    })
    .join("  ");
}

export interface LlmTelemetryLogInput {
  slot: string;
  provider: string;
  modelId: string;
  responseModel?: string;
  responseId?: string;
  api: string;
  stopReason: string;
  rawStopReason?: string;
  thinkingLevel?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  costTotal?: number;
  ttftMs: number;
  decodeMs?: number;
  latencyMs: number;
  toolCalls?: readonly string[];
  timeZone?: string;
  timestampMs?: number;
  color?: boolean;
}

/**
 * Format a compact single-line terminal log containing response metadata, cache hit ratio, TTFT, and TPS.
 */
export function formatLlmTelemetryLog(input: LlmTelemetryLogInput): string {
  const useColor = input.color ?? shouldUseColor(process.stdout);
  const metrics = computeTurnMetrics({
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    latencyMs: input.latencyMs,
    ttftMs: input.ttftMs,
    decodeMs: input.decodeMs,
  });

  const modelTag =
    input.responseModel && input.responseModel !== input.modelId
      ? `${input.provider}/${input.modelId}->${input.responseModel}`
      : `${input.provider}/${input.modelId}`;

  const stopTag =
    input.rawStopReason && input.rawStopReason !== input.stopReason
      ? `${input.stopReason}(${input.rawStopReason})`
      : input.stopReason;

  const metaParts = [
    colorize(`model=${modelTag}`, "36", useColor),
    `api=${input.api}`,
    `stop=${stopTag}`,
  ];
  if (input.responseId) metaParts.push(`resp=${input.responseId}`);
  if (input.thinkingLevel) metaParts.push(`thinking=${input.thinkingLevel}`);

  const hitColor =
    metrics.cacheHitRate >= 0.7 ? "1;32" : metrics.cacheHitRate >= 0.3 ? "1;33" : "31";
  const cacheParts = [
    colorize(`hit=${formatCacheHitRate(metrics.cacheHitRate)}`, hitColor, useColor),
    `cache_read=${input.cacheReadTokens}`,
    `cache_write=${input.cacheWriteTokens}${
      input.cacheWrite1hTokens ? `(1h:${input.cacheWrite1hTokens})` : ""
    }`,
    `uncached=${input.inputTokens}`,
    `prompt=${metrics.totalPromptTokens}`,
  ];

  const outPart =
    typeof input.reasoningTokens === "number"
      ? `out=${input.outputTokens}(reasoning=${input.reasoningTokens})`
      : `out=${input.outputTokens}`;

  const speedParts = [
    `ttft=${input.ttftMs}ms`,
    `total=${input.latencyMs}ms`,
    `tps=${metrics.decodeTps !== null ? `${metrics.decodeTps}/s` : "-"}`,
    `e2e_tps=${metrics.e2eTps !== null ? `${metrics.e2eTps}/s` : "-"}`,
  ];

  const tailParts: string[] = [];
  if (typeof input.costTotal === "number" && input.costTotal > 0) {
    tailParts.push(`cost=$${input.costTotal.toFixed(6)}`);
  }
  if (input.toolCalls && input.toolCalls.length > 0) {
    tailParts.push(colorize(`tools=[${input.toolCalls.join(",")}]`, "33", useColor));
  }

  const sep = colorize(" | ", "2", useColor);
  const body = [
    metaParts.join(" "),
    cacheParts.join(" "),
    `${outPart} ${speedParts.join(" ")}`,
    ...tailParts,
  ].join(sep);

  return formatLogLine("LLM", input.slot, body, {
    timeZone: input.timeZone,
    timestampMs: input.timestampMs,
    color: useColor,
  });
}
