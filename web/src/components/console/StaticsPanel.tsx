import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type StaticsSummary, type TurnTraceRecord } from "@/api";
import { ApiBadge, ConsoleSelect, SlotBadge } from "@/components/console/ConsolePrimitives";
import {
  Alert,
  AlertAction,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@/components/motion/alert";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";

const DEFAULT_SLOT_OPTIONS = [
  { value: "__all__", label: "全部调用" },
  { value: "persona", label: "persona · 主对话" },
  { value: "worker", label: "worker · 浏览器" },
  { value: "curator", label: "curator · 记忆压缩" },
  { value: "router", label: "router · 路由" },
  { value: "hindsight_llm", label: "hindsight_llm · 反思" },
];

const SINCE_FILTER_OPTIONS = [
  { value: "1h", label: "最近 1 小时" },
  { value: "24h", label: "最近 24 小时" },
  { value: "7d", label: "最近 7 天" },
  { value: "all", label: "全部时间" },
];

const LIMIT_FILTER_OPTIONS = [
  { value: "30", label: "30 条" },
  { value: "60", label: "60 条" },
  { value: "120", label: "120 条" },
];

export interface StaticsPanelProps {
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
  embedded?: boolean;
  sessionEpoch?: number;
  sessionId?: string | null;
}

function parseToolsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function StaticsPanel({ onToast, sessionEpoch = 0, sessionId = null }: StaticsPanelProps) {
  const [slot, setSlot] = useState("__all__");
  const [since, setSince] = useState("24h");
  const [limit, setLimit] = useState("60");
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [viewState, setViewState] = useState<"loading" | "error" | "ready">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [summary, setSummary] = useState<StaticsSummary | null>(null);
  const [traces, setTraces] = useState<TurnTraceRecord[]>([]);

  const loadStatics = async () => {
    setViewState("loading");
    setErrorMessage("");
    try {
      const res = await api.getStatics({
        limit: Number(limit) || 60,
        slot: slot === "__all__" ? undefined : slot,
        since: sessionId || since === "all" ? undefined : since,
        sessionId,
      });
      setSummary(res.summary);
      setTraces(res.traces);
      setViewState("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      setViewState("error");
      onToast({ title: "统计读取失败", description: msg, status: "error" });
    }
  };

  useEffect(() => {
    void loadStatics();
  }, [slot, since, limit, sessionEpoch, sessionId]);

  const slotOptions = useMemo(() => {
    const known = new Set(DEFAULT_SLOT_OPTIONS.map((o) => o.value));
    const extras: Array<{ value: string; label: string }> = [];
    for (const tr of traces) {
      if (!known.has(tr.slot)) {
        known.add(tr.slot);
        extras.push({ value: tr.slot, label: tr.slot });
      }
    }
    return [...DEFAULT_SLOT_OPTIONS, ...extras];
  }, [traces]);

  const modelBreakdown = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        slot: string;
        target: string;
        api: string;
        count: number;
        totalLatency: number;
        cacheRead: number;
        promptTotal: number;
        outputTokens: number;
      }
    >();
    for (const tr of traces) {
      const target = `${tr.provider}/${tr.modelId}`;
      const key = `${tr.slot}|${target}|${tr.api}`;
      const existing = map.get(key) ?? {
        key,
        slot: tr.slot,
        target,
        api: tr.api,
        count: 0,
        totalLatency: 0,
        cacheRead: 0,
        promptTotal: 0,
        outputTokens: 0,
      };
      existing.count += 1;
      existing.totalLatency += tr.latencyMs;
      existing.cacheRead += tr.cacheReadTokens;
      existing.promptTotal += tr.inputTokens + tr.cacheReadTokens + tr.cacheWriteTokens;
      existing.outputTokens += tr.outputTokens;
      map.set(key, existing);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [traces]);

  const toolBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tr of traces) {
      for (const tool of parseToolsJson(tr.toolCallsJson)) {
        counts.set(tool, (counts.get(tool) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [traces]);

  const kpiValue = (val: string) => {
    if (viewState === "loading") return "…";
    if (viewState === "error" || !summary) return "--";
    return val;
  };

  const tokenBreakdown = useMemo(() => {
    if (!summary) return null;
    const total =
      summary.totalCacheReadTokens +
      summary.totalCacheWriteTokens +
      summary.totalInputTokens +
      summary.totalOutputTokens;
    if (total <= 0) return null;
    return {
      total,
      cacheReadPct: (summary.totalCacheReadTokens / total) * 100,
      cacheWritePct: (summary.totalCacheWriteTokens / total) * 100,
      uncachedPct: (summary.totalInputTokens / total) * 100,
      outputPct: (summary.totalOutputTokens / total) * 100,
    };
  }, [summary]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Dense DSH Filter Strip */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card/30 px-2.5 py-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <ConsoleSelect
            size="sm"
            className="w-40"
            value={slot}
            options={slotOptions}
            onValueChange={setSlot}
          />
          <ConsoleSelect
            size="sm"
            className="w-32"
            value={since}
            options={SINCE_FILTER_OPTIONS}
            onValueChange={setSince}
          />
          <ConsoleSelect
            size="sm"
            className="w-24"
            value={limit}
            options={LIMIT_FILTER_OPTIONS}
            onValueChange={setLimit}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={viewState === "loading"}
          onClick={() => void loadStatics()}
        >
          <RefreshCw className={`size-3 ${viewState === "loading" ? "animate-spin" : ""}`} />
          刷新统计
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border">
        {viewState === "error" && (
          <div className="p-3">
            <Alert variant="destructive" open>
              <AlertIcon />
              <AlertContent>
                <AlertTitle>统计数据加载失败</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
                <AlertAction>
                  <Button type="button" size="sm" variant="outline" onClick={() => void loadStatics()}>
                    重试
                  </Button>
                </AlertAction>
              </AlertContent>
            </Alert>
          </div>
        )}

        {/* Row 1: Compact 6-Cell KPI Strip */}
        <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
          {(
            [
              ["调用次数", kpiValue(String(summary?.turns ?? 0)), summary ? `热缓存 ${summary.warmTurns} 次` : ""],
              [
                "提示词总计",
                kpiValue((summary?.totalPromptTokens ?? 0).toLocaleString()),
                summary ? `命中 ${summary.totalCacheReadTokens.toLocaleString()}` : "",
              ],
              [
                "缓存命中率",
                kpiValue(summary ? `${(summary.weightedCacheHitRate * 100).toFixed(1)}%` : "--"),
                summary?.warmCacheHitRate !== null && summary
                  ? `连续 ${(summary.warmCacheHitRate * 100).toFixed(1)}%`
                  : "冷启动中",
              ],
              [
                "输出 Token",
                kpiValue((summary?.totalOutputTokens ?? 0).toLocaleString()),
                summary?.avgDecodeTps !== null && summary
                  ? `均值 ${summary.avgDecodeTps.toFixed(1)} tok/s`
                  : "",
              ],
              [
                "首字延迟 (TTFT)",
                kpiValue(summary?.avgTtftMs !== null && summary ? `${summary.avgTtftMs}ms` : "--"),
                summary?.p95TtftMs !== null && summary ? `P95 ${summary.p95TtftMs}ms` : "",
              ],
              [
                "平均耗时",
                kpiValue(summary ? `${summary.avgLatencyMs}ms` : "--"),
                summary ? `P95 ${summary.p95LatencyMs}ms` : "",
              ],
            ] as const
          ).map(([label, val, sub]) => (
            <div key={label} className="px-3 py-2">
              <div className="text-[11px] text-muted-foreground">{label}</div>
              <div className="mt-0.5 text-lg font-semibold leading-tight tabular-nums text-foreground">
                {val}
              </div>
              {sub && <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">{sub}</div>}
            </div>
          ))}
        </div>

        {/* Row 2: Token Composition Bar */}
        {tokenBreakdown && summary && (
          <div className="flex flex-col gap-1.5 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className="font-medium text-foreground">Token 构成分布</span>
              <div className="flex flex-wrap items-center gap-3 text-muted-foreground tabular-nums">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-emerald-500" />
                  缓存读 {summary.totalCacheReadTokens.toLocaleString()}
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-amber-500" />
                  缓存写 {summary.totalCacheWriteTokens.toLocaleString()}
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-sky-500" />
                  未命中 {summary.totalInputTokens.toLocaleString()}
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-sm bg-violet-500" />
                  生成 {summary.totalOutputTokens.toLocaleString()}
                </span>
              </div>
            </div>
            <div className="flex h-2 w-full overflow-hidden rounded bg-muted">
              <div className="bg-emerald-500" style={{ width: `${tokenBreakdown.cacheReadPct}%` }} />
              <div className="bg-amber-500" style={{ width: `${tokenBreakdown.cacheWritePct}%` }} />
              <div className="bg-sky-500" style={{ width: `${tokenBreakdown.uncachedPct}%` }} />
              <div className="bg-violet-500" style={{ width: `${tokenBreakdown.outputPct}%` }} />
            </div>
          </div>
        )}

        {/* Row 3: Two-Column Slot/Model & Tool Breakdown */}
        {(modelBreakdown.length > 0 || toolBreakdown.length > 0) && (
          <div className="grid grid-cols-1 divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            <div className="px-3 py-2">
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                槽位与模型分布
              </div>
              <div className="divide-y divide-border/50">
                {modelBreakdown.map((item) => {
                  const hit = item.promptTotal > 0 ? (item.cacheRead / item.promptTotal) * 100 : 0;
                  const avgLat = Math.round(item.totalLatency / item.count);
                  return (
                    <div
                      key={item.key}
                      className="flex flex-wrap items-center justify-between gap-2 py-1 text-xs"
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <SlotBadge slot={item.slot} className="h-4 px-1 text-[10px]" />
                        <span className="truncate font-mono text-[11px] font-medium text-foreground">
                          {item.target}
                        </span>
                        <ApiBadge api={item.api} className="h-4 px-1 text-[10px]" />
                      </div>
                      <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
                        <span>{item.count} 次</span>
                        <span>命中 {hit.toFixed(1)}%</span>
                        <span>出 {item.outputTokens.toLocaleString()}</span>
                        <span>均 {avgLat}ms</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="px-3 py-2">
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                工具调用频次
              </div>
              {toolBreakdown.length === 0 ? (
                <div className="py-1 text-xs text-muted-foreground">筛选范围内无工具调用记录</div>
              ) : (
                <div className="divide-y divide-border/50">
                  {toolBreakdown.map(([toolName, count]) => {
                    const max = toolBreakdown[0]?.[1] || 1;
                    return (
                      <div key={toolName} className="flex items-center justify-between gap-2 py-1 text-xs">
                        <span className="truncate font-mono text-[11px] text-foreground">{toolName}</span>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full bg-primary"
                              style={{ width: `${(count / max) * 100}%` }}
                            />
                          </div>
                          <span className="w-9 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                            {count} 次
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Row 4: Dense Collapsible Calls Ledger */}
        <div>
          <div className="flex items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5">
            <span className="text-[11px] font-medium text-foreground">
              最近调用明细（共 {traces.length} 条）
            </span>
            <span className="text-[10px] text-muted-foreground">
              点击行可展开上下文快照
            </span>
          </div>

          {viewState === "ready" && traces.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              筛选条件下暂无调用记录。
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-muted/35 text-[11px] text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="w-6 py-1.5 pl-2.5" />
                    <th className="py-1.5 pr-2 font-medium">时间</th>
                    <th className="py-1.5 pr-2 font-medium">槽位与模型</th>
                    <th className="py-1.5 pr-2 font-medium">输入 / 摘要</th>
                    <th className="py-1.5 pr-2 font-medium">提示词</th>
                    <th className="py-1.5 pr-2 font-medium">缓存读</th>
                    <th className="py-1.5 pr-2 font-medium">命中率</th>
                    <th className="py-1.5 pr-2 font-medium">输出</th>
                    <th className="py-1.5 pr-2 font-medium">首字 / 耗时</th>
                    <th className="py-1.5 pr-2.5 font-medium">工具</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {traces.map((tr) => {
                    const tools = parseToolsJson(tr.toolCallsJson);
                    const promptTotal = tr.inputTokens + tr.cacheReadTokens + tr.cacheWriteTokens;
                    const expanded = expandedRowId === tr.id;
                    return (
                      <Fragment key={tr.id}>
                        <tr
                          onClick={() => setExpandedRowId((prev) => (prev === tr.id ? null : tr.id))}
                          className={`cursor-pointer align-middle transition-colors ${
                            expanded ? "bg-primary/8" : "hover:bg-muted/35"
                          }`}
                        >
                          <td className="py-1.5 pl-2.5 text-muted-foreground">
                            {expanded ? (
                              <ChevronDown className="size-3.5" />
                            ) : (
                              <ChevronRight className="size-3.5" />
                            )}
                          </td>
                          <td className="whitespace-nowrap py-1.5 pr-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                            {new Date(tr.createdAt).toLocaleTimeString("zh-CN", {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </td>
                          <td className="py-1.5 pr-2">
                            <div className="flex flex-wrap items-center gap-1">
                              <SlotBadge slot={tr.slot} className="h-4 px-1 text-[10px]" />
                              <span className="font-mono text-[11px] text-foreground">
                                {tr.provider}/{tr.modelId}
                              </span>
                              <ApiBadge api={tr.api} className="h-4 px-1 text-[10px]" />
                            </div>
                          </td>
                          <td className="max-w-[200px] truncate py-1.5 pr-2 text-[11px] text-muted-foreground">
                            {tr.userPreview || "—"}
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-[11px] tabular-nums">
                            {promptTotal.toLocaleString()}
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-[11px] tabular-nums text-emerald-600 dark:text-emerald-400">
                            {tr.cacheReadTokens.toLocaleString()}
                          </td>
                          <td className="py-1.5 pr-2">
                            <AnimatedBadge
                              status={tr.cacheHitRate >= 0.6 ? "success" : "neutral"}
                              size="sm"
                            >
                              {(tr.cacheHitRate * 100).toFixed(1)}%
                            </AnimatedBadge>
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-[11px] tabular-nums">
                            {tr.outputTokens.toLocaleString()}
                          </td>
                          <td className="whitespace-nowrap py-1.5 pr-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                            {tr.ttftMs !== null ? `${tr.ttftMs}ms` : "--"} / {tr.latencyMs}ms
                            {tr.tps !== null ? ` · ${tr.tps.toFixed(0)}/s` : ""}
                          </td>
                          <td className="py-1.5 pr-2.5">
                            {tools.length === 0 ? (
                              <span className="text-[11px] text-muted-foreground/60">—</span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {tools.slice(0, 3).map((tool, i) => (
                                  <span
                                    key={`${tool}-${i}`}
                                    className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 font-mono text-[10px] leading-none text-amber-700 dark:text-amber-300"
                                  >
                                    {tool}
                                  </span>
                                ))}
                                {tools.length > 3 && (
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    +{tools.length - 3}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="bg-muted/20">
                            <td colSpan={10} className="px-4 py-2">
                              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                                {tr.timeCardText || "（无额外上下文快照）"}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
