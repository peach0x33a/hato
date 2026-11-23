import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type MemoryOverviewResponse,
  type MemoryRecallResult,
  type MemorySyncBank,
  type MemorySyncRecord,
  type MemorySyncStatus,
} from "@/api";

interface MemoryPanelProps {
  onToast: (input: {
    title: string;
    description?: string;
    status?: "info" | "success" | "error";
  }) => void;
}

type MemorySubTab = "records" | "recall" | "working";
type StatusFilter = "active" | "all" | MemorySyncStatus;

const BANK_LABELS: Record<MemorySyncBank, { label: string; cls: string }> = {
  persona: {
    label: "persona",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  tech: {
    label: "tech",
    cls: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  notebook: {
    label: "notebook",
    cls: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
};

const STATUS_LABELS: Record<MemorySyncStatus, { label: string; cls: string }> = {
  synced: {
    label: "已同步",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  degraded: {
    label: "降级待重试",
    cls: "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
  },
  denied: {
    label: "配额受限",
    cls: "border-orange-500/35 bg-orange-500/12 text-orange-700 dark:text-orange-300",
  },
  error: {
    label: "同步失败",
    cls: "border-rose-500/35 bg-rose-500/12 text-rose-700 dark:text-rose-300",
  },
  erased: {
    label: "已遗忘",
    cls: "border-zinc-400/30 bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  },
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(tsMs: number): string {
  if (!tsMs) return "--";
  const d = new Date(tsMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

export function MemoryPanel({ onToast }: MemoryPanelProps) {
  const [subTab, setSubTab] = useState<MemorySubTab>("records");
  const [overview, setOverview] = useState<MemoryOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  // Records state
  const [records, setRecords] = useState<MemorySyncRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [bankFilter, setBankFilter] = useState<"all" | MemorySyncBank>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmForgetId, setConfirmForgetId] = useState<string | null>(null);
  const [forgettingId, setForgettingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Recall test state
  const [recallQuery, setRecallQuery] = useState("");
  const [recallBank, setRecallBank] = useState<MemorySyncBank>("persona");
  const [recallLimit, setRecallLimit] = useState(8);
  const [recalling, setRecalling] = useState(false);
  const [recallResult, setRecallResult] = useState<MemoryRecallResult | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      const data = await api.getMemoryOverview();
      setOverview(data);
    } catch (err) {
      onToast({
        title: "加载记忆库概览失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setOverviewLoading(false);
    }
  }, [onToast]);

  const loadRecords = useCallback(async () => {
    setRecordsLoading(true);
    try {
      const data = await api.listMemoryRecords({
        bank: bankFilter === "all" ? undefined : bankFilter,
        status:
          statusFilter !== "active" && statusFilter !== "all" ? statusFilter : undefined,
        includeErased: statusFilter === "all" || statusFilter === "erased",
        q: searchQuery.trim() || undefined,
        limit: 120,
      });
      setRecords(data.records);
    } catch (err) {
      onToast({
        title: "加载记忆条目失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setRecordsLoading(false);
    }
  }, [bankFilter, statusFilter, searchQuery, onToast]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRecords();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [loadRecords]);

  const handleRefreshAll = () => {
    void loadOverview();
    void loadRecords();
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const res = await api.syncMemory({ includeDenied: true });
      const s = res.summary;
      onToast({
        title: "记忆提炼与同步完成",
        description: `处理消息 ${s.processedMessages} 条 · 提炼 ${s.extractedCount} 条 · 成功同步 ${s.syncedCount} 条${s.retriedCount > 0 ? ` · 重试 ${s.retriedCount} 条` : ""}`,
        status: s.errorCount > 0 ? "info" : "success",
      });
      await Promise.all([loadOverview(), loadRecords()]);
    } catch (err) {
      onToast({
        title: "同步失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleForgetRecord = async (record: MemorySyncRecord) => {
    setForgettingId(record.id);
    try {
      const res = await api.forgetMemory({ recordIds: [record.id] });
      const s = res.summary;
      if (s.failedCount > 0) {
        onToast({
          title: "部分遗忘失败",
          description: s.errors[0] || "远程擦除失败",
          status: "error",
        });
      } else {
        onToast({
          title: "已遗忘记忆条目",
          description:
            s.erasedRemoteCount > 0
              ? "已同步从远程 Memory 库与本地记录中移除"
              : "已从本地记录中移除",
          status: "success",
        });
      }
      setConfirmForgetId(null);
      await Promise.all([loadOverview(), loadRecords()]);
    } catch (err) {
      onToast({
        title: "遗忘失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setForgettingId(null);
    }
  };

  const handleRecallSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = recallQuery.trim();
    if (!q) return;
    setRecalling(true);
    setRecallError(null);
    try {
      const res = await api.recallMemory({
        query: q,
        bank: recallBank,
        limit: recallLimit,
      });
      setRecallResult(res.result);
      if (!res.result.ok && res.result.errorMessage) {
        setRecallError(res.result.errorMessage);
      }
    } catch (err) {
      setRecallError(err instanceof Error ? err.message : String(err));
      setRecallResult(null);
    } finally {
      setRecalling(false);
    }
  };

  const providerLabel =
    overview?.provider === "memoryecho"
      ? "MemoryEcho"
      : overview?.provider === "hindsight"
        ? "Hindsight"
        : "未启用";

  const stats = overview?.stats;
  const issueCount = (stats?.degraded ?? 0) + (stats?.denied ?? 0) + (stats?.error ?? 0);

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <Brain className="h-4.5 w-4.5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                记忆库
              </h2>
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  overview?.configured
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                }`}
              >
                {providerLabel}
                {overview && !overview.configured && overview.provider !== "none"
                  ? "（未配密钥）"
                  : ""}
              </span>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              查看长期记忆条目、测试语义召回命中效果、管理工作记忆与远程 Vault 状态
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={syncing || !overview?.configured}
            onClick={() => void handleSyncNow()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            <span>立即提炼同步</span>
          </button>

          <button
            type="button"
            onClick={handleRefreshAll}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${overviewLoading ? "animate-spin" : ""}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {/* Stats + Vault Strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-[#11171c]">
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">已同步条目</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {stats?.synced ?? 0}
            </span>
            <span className="text-[11px] text-zinc-400">
              共 {stats?.total ?? 0} 条记录
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-[#11171c]">
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">待提炼对话消息</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
              {stats?.pendingRawMessages ?? 0}
            </span>
            <span className="text-[11px] text-zinc-400">等待后台提炼</span>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-[#11171c]">
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">降级 / 异常</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={`text-xl font-semibold tabular-nums ${
                issueCount > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-zinc-900 dark:text-zinc-100"
              }`}
            >
              {issueCount}
            </span>
            <span className="text-[11px] text-zinc-400">
              降级 {stats?.degraded ?? 0} · 失败 {stats?.error ?? 0}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-[#11171c]">
          <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>远程 Vault</span>
            <Database className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          {overview?.vaults && overview.vaults.length > 0 ? (
            <div className="mt-1 space-y-0.5">
              {overview.vaults.slice(0, 2).map((v) => (
                <div key={v.id} className="flex items-center justify-between text-xs">
                  <span className="truncate font-mono text-zinc-700 dark:text-zinc-200">
                    {v.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
                    {v.memoryCount} 条 · {formatBytes(v.storageBytes)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-1.5 text-xs text-zinc-400">
              {overview?.configured ? "暂无远程 Vault 数据" : "未连接远程记忆库"}
            </div>
          )}
        </div>
      </div>

      {/* Usage bar when MemoryEcho usage is available */}
      {overview?.usage ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-zinc-200 bg-zinc-50/80 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-[#0d1216] dark:text-zinc-300">
          <span>
            计费周期：<span className="font-mono">{overview.usage.periodKind}</span>
          </span>
          <span className="tabular-nums">
            写入：{overview.usage.createCount} 次（{overview.usage.createCredits} credits）
          </span>
          <span className="tabular-nums">
            查询：{overview.usage.queryCount} 次（{overview.usage.queryCredits} credits）
          </span>
          <span className="tabular-nums">
            已付额度：{overview.usage.userPaidCredits} credits
          </span>
        </div>
      ) : null}

      {/* Sub-tabs */}
      <div className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {(
          [
            ["records", "记忆条目"],
            ["recall", "语义召回测试"],
            ["working", "工作记忆"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSubTab(key)}
            className={`border-b-2 px-3.5 py-2 text-xs font-medium transition-colors ${
              subTab === key
                ? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Sub-tab 1: Records */}
      {subTab === "records" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索记忆内容、ID 或外部记忆 ID..."
                className="h-8 w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-7 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500/60 focus:outline-none dark:border-zinc-800 dark:bg-[#11171c] dark:text-zinc-100"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>

            <select
              value={bankFilter}
              onChange={(e) => setBankFilter(e.target.value as "all" | MemorySyncBank)}
              className="h-8 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-700 focus:border-emerald-500/60 focus:outline-none dark:border-zinc-800 dark:bg-[#11171c] dark:text-zinc-200"
            >
              <option value="all">全部库</option>
              <option value="persona">persona</option>
              <option value="tech">tech</option>
              <option value="notebook">notebook</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="h-8 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-700 focus:border-emerald-500/60 focus:outline-none dark:border-zinc-800 dark:bg-[#11171c] dark:text-zinc-200"
            >
              <option value="active">有效记忆（不含已遗忘）</option>
              <option value="synced">已同步</option>
              <option value="degraded">降级待重试</option>
              <option value="denied">配额受限</option>
              <option value="error">同步失败</option>
              <option value="erased">已遗忘</option>
              <option value="all">全部状态</option>
            </select>
          </div>

          {/* Records list */}
          {recordsLoading ? (
            <div className="flex h-48 items-center justify-center gap-2 text-xs text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
              <span>加载记忆条目中…</span>
            </div>
          ) : records.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <span>暂无符合条件的记忆条目</span>
            </div>
          ) : (
            <div className="space-y-2 pb-4">
              {records.map((rec) => {
                const bankInfo = BANK_LABELS[rec.bank] ?? BANK_LABELS.persona;
                const statusInfo = STATUS_LABELS[rec.status] ?? STATUS_LABELS.synced;
                const isConfirming = confirmForgetId === rec.id;
                const isForgetting = forgettingId === rec.id;

                return (
                  <div
                    key={rec.id}
                    className="rounded-xl border border-zinc-200 bg-white p-3.5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-[#11171c] dark:hover:border-zinc-700"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium ${bankInfo.cls}`}
                          >
                            {bankInfo.label}
                          </span>
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusInfo.cls}`}
                          >
                            {statusInfo.label}
                          </span>
                          <span className="font-mono text-[11px] text-zinc-400">
                            {formatDateTime(rec.createdAt)}
                          </span>
                          {rec.externalMemoryId ? (
                            <span className="truncate font-mono text-[10px] text-zinc-400">
                              ext:{rec.externalMemoryId}
                            </span>
                          ) : null}
                        </div>

                        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-800 dark:text-zinc-100">
                          {rec.content}
                        </p>

                        {rec.errorMessage ? (
                          <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            <span>
                              {rec.errorCode ? `[${rec.errorCode}] ` : ""}
                              {rec.errorMessage}
                            </span>
                          </div>
                        ) : null}
                      </div>

                      {rec.status !== "erased" ? (
                        <div className="shrink-0">
                          {isConfirming ? (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                disabled={isForgetting}
                                onClick={() => void handleForgetRecord(rec)}
                                className="inline-flex h-7 items-center gap-1 rounded-md bg-rose-600 px-2 text-[11px] font-medium text-white hover:bg-rose-500 disabled:opacity-50"
                              >
                                {isForgetting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : null}
                                <span>确认遗忘</span>
                              </button>
                              <button
                                type="button"
                                disabled={isForgetting}
                                onClick={() => setConfirmForgetId(null)}
                                className="inline-flex h-7 items-center rounded-md border border-zinc-200 px-2 text-[11px] text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmForgetId(rec.id)}
                              title="级联遗忘此条记忆"
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 px-2 text-[11px] text-zinc-500 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-600 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-rose-400"
                            >
                              <Trash2 className="h-3 w-3" />
                              <span>遗忘</span>
                            </button>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : subTab === "recall" ? (
        /* Sub-tab 2: Recall Test */
        <div className="flex flex-col gap-3">
          <form onSubmit={(e) => void handleRecallSubmit(e)} className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                value={recallQuery}
                onChange={(e) => setRecallQuery(e.target.value)}
                placeholder="输入问题或关键词，测试 MemoryEcho / Hindsight 实际召回结果..."
                className="h-9 w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-3 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500/60 focus:outline-none dark:border-zinc-800 dark:bg-[#11171c] dark:text-zinc-100"
              />
            </div>

            <select
              value={recallBank}
              onChange={(e) => setRecallBank(e.target.value as MemorySyncBank)}
              className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-700 focus:border-emerald-500/60 focus:outline-none dark:border-zinc-800 dark:bg-[#11171c] dark:text-zinc-200"
            >
              <option value="persona">persona</option>
              <option value="tech">tech</option>
              <option value="notebook">notebook</option>
            </select>

            <select
              value={recallLimit}
              onChange={(e) => setRecallLimit(Number(e.target.value))}
              className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-700 focus:border-emerald-500/60 focus:outline-none dark:border-zinc-800 dark:bg-[#11171c] dark:text-zinc-200"
            >
              <option value={5}>最多 5 条</option>
              <option value={8}>最多 8 条</option>
              <option value={15}>最多 15 条</option>
            </select>

            <button
              type="submit"
              disabled={recalling || !recallQuery.trim()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {recalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              <span>召回查询</span>
            </button>
          </form>

          {recallError ? (
            <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
              {recallError}
            </div>
          ) : null}

          {recallResult ? (
            <div className="space-y-2.5">
              {recallResult.degraded ? (
                <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  本次查询处于降级模式（degraded）
                </div>
              ) : null}

              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                命中 {recallResult.items.length} 条记忆（bank: {recallResult.bank}）
              </div>

              {recallResult.items.length === 0 ? (
                <div className="flex h-36 items-center justify-center rounded-xl border border-dashed border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  未召回到匹配记忆
                </div>
              ) : (
                recallResult.items.map((item, idx) => (
                  <div
                    key={`${item.id}-${idx}`}
                    className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3.5"
                  >
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:text-emerald-300">
                        {item.bank}:{item.id}
                      </span>
                      {typeof item.score === "number" ? (
                        <span className="font-mono text-[11px] text-zinc-500">
                          score: {item.score.toFixed(3)}
                        </span>
                      ) : null}
                      {item.createdAt ? (
                        <span className="font-mono text-[11px] text-zinc-400">
                          {item.createdAt.slice(0, 19).replace("T", " ")}
                        </span>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-800 dark:text-zinc-100">
                      {item.content}
                    </p>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              输入查询内容后点击「召回查询」，可实时验证线上语义召回条目
            </div>
          )}
        </div>
      ) : (
        /* Sub-tab 3: Working Memory */
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-[#11171c]">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">
                用户画像 (userProfile)
              </h3>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
              {overview?.workingMemory.userProfile?.trim() || "（暂无用户画像记录）"}
            </pre>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-[#11171c]">
            <h3 className="mb-2 text-xs font-semibold text-zinc-800 dark:text-zinc-100">
              近期摘要 (summary)
            </h3>
            <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
              {overview?.workingMemory.summary?.trim() || "（暂无摘要）"}
            </pre>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-[#11171c] lg:col-span-2">
            <h3 className="mb-2 text-xs font-semibold text-zinc-800 dark:text-zinc-100">
              未闭环事项 (openLoops)
            </h3>
            {overview?.workingMemory.openLoops && overview.workingMemory.openLoops.length > 0 ? (
              <ul className="list-disc space-y-1 pl-4 text-xs text-zinc-700 dark:text-zinc-300">
                {overview.workingMemory.openLoops.map((loop, idx) => (
                  <li key={idx}>{loop}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-zinc-400">（暂无未闭环事项）</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
