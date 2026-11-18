import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronRight,
  Eye,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  ServerOff,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import type { SecretState } from "@/api";
import { isTestOutcomeEmptyWarning, type ModelTestOutcome } from "./ModelDetailPanel";
import {
  formatTokenCount,
  resolveProviderKeyStatus,
  SLOT_COLOR_MAP,
  type SlotKey,
  type UiModelEntry,
  type UiProviderConfig,
  validateModelEntry,
} from "./types";

export type ListFilterMode = "all" | "unused" | "issues";

function middleTruncateUrl(url: string, maxLen = 36): string {
  const trimmed = url.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const head = Math.ceil((maxLen - 1) * 0.6);
  const tail = maxLen - 1 - head;
  return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-amber-400/30 px-0.5 text-inherit dark:bg-amber-400/25">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

interface ProviderModelListProps {
  providers: UiProviderConfig[];
  selectedModelUid: string | null;
  modifiedModelUids: Set<string>;
  slotIndex: {
    byTarget: Map<string, SlotKey[]>;
    byProvider: Map<string, SlotKey[]>;
  };
  secretStates: SecretState[];
  pendingSecrets: Record<string, string>;
  collapsedProviderIds: Set<string>;
  testingModelIds: Set<string>;
  testOutcomes: Record<string, ModelTestOutcome>;
  searchQuery: string;
  filterMode: ListFilterMode;
  onSearchChange: (q: string) => void;
  onFilterModeChange: (mode: ListFilterMode) => void;
  onSelectModel: (providerUid: string, modelUid: string) => void;
  onToggleProviderCollapse: (providerUid: string) => void;
  onAddProvider: () => void;
  onConfigureProvider: (providerUid: string) => void;
  onRequestDeleteProvider: (providerUid: string) => void;
  onAddModel: (providerUid: string) => void;
  onTestProviderAll: (providerUid: string) => void;
}

export function ProviderModelList({
  providers,
  selectedModelUid,
  modifiedModelUids,
  slotIndex,
  secretStates,
  pendingSecrets,
  collapsedProviderIds,
  testingModelIds,
  testOutcomes,
  searchQuery,
  filterMode,
  onSearchChange,
  onFilterModeChange,
  onSelectModel,
  onToggleProviderCollapse,
  onAddProvider,
  onConfigureProvider,
  onRequestDeleteProvider,
  onAddModel,
  onTestProviderAll,
}: ProviderModelListProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [openMenuProviderUid, setOpenMenuProviderUid] = useState<string | null>(null);

  // `/` or `Cmd/Ctrl + K` to focus search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "/" && !isTyping) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!openMenuProviderUid) return;
    const onOutside = () => setOpenMenuProviderUid(null);
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [openMenuProviderUid]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearchActive = normalizedQuery.length > 0;

  const entries = providers
    .map((provider) => {
      const slug = provider.name.trim();
      const idCounts = new Map<string, number>();
      for (const m of provider.models) {
        const mid = m.id.trim();
        if (mid) idCounts.set(mid, (idCounts.get(mid) ?? 0) + 1);
      }

      const providerMatches =
        !isSearchActive ||
        provider.name.toLowerCase().includes(normalizedQuery) ||
        (provider.displayName ?? "").toLowerCase().includes(normalizedQuery) ||
        provider.protocol.toLowerCase().includes(normalizedQuery);

      const visibleModels = provider.models.filter((m) => {
        const mid = m.id.trim();
        const bound = mid ? slotIndex.byTarget.get(`${slug}/${mid}`) ?? [] : [];
        const isDuplicate = Boolean(mid && (idCounts.get(mid) ?? 0) > 1);
        const validation = validateModelEntry(m, isDuplicate);
        const outcome = testOutcomes[m.uid];
        const hasIssue =
          validation.hasError ||
          Boolean(outcome && !outcome.ok) ||
          isTestOutcomeEmptyWarning(outcome);

        if (filterMode === "unused" && bound.length > 0) return false;
        if (filterMode === "issues" && !hasIssue) return false;

        if (!isSearchActive || providerMatches) return true;
        return (
          m.id.toLowerCase().includes(normalizedQuery) ||
          m.displayName.toLowerCase().includes(normalizedQuery)
        );
      });

      const showProvider =
        filterMode === "all"
          ? providerMatches || visibleModels.length > 0
          : visibleModels.length > 0;

      return { provider, idCounts, visibleModels, showProvider };
    })
    .filter((entry) => entry.showProvider);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800/90 dark:bg-[#0f1418]">
      {/* Search + Add Provider + Quick Filters */}
      <div className="flex flex-col gap-2.5 border-b border-zinc-200/80 p-3 dark:border-zinc-800/80">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && searchQuery) {
                  e.preventDefault();
                  onSearchChange("");
                }
              }}
              placeholder="筛选供应商或模型… ( / )"
              aria-label="筛选供应商或模型"
              className="h-8 w-full rounded-lg border border-zinc-200 bg-zinc-50 pr-7 pl-8 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-500"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                aria-label="清空筛选"
                className="absolute top-1/2 right-1.5 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onAddProvider}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>供应商</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {(
            [
              { id: "all", label: "全部" },
              { id: "unused", label: "未使用" },
              { id: "issues", label: "有异常" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onFilterModeChange(item.id)}
              className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                filterMode === item.id
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Provider Groups & Model Rows */}
      <div className="flex flex-col divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
        {providers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <ServerOff className="h-7 w-7 text-zinc-400" />
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
                暂无供应商配置
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                点击右上角「+ 供应商」添加第一个上游接口
              </p>
            </div>
            <button
              type="button"
              onClick={onAddProvider}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-500"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>添加第一个供应商</span>
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              没有符合当前筛选条件的模型
            </p>
            <button
              type="button"
              onClick={() => {
                onSearchChange("");
                onFilterModeChange("all");
              }}
              className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              重置筛选
            </button>
          </div>
        ) : (
          entries.map(({ provider, idCounts, visibleModels }) => {
            const slug = provider.name.trim();
            const providerLabel = provider.displayName?.trim() || provider.name;
            const keyInfo = resolveProviderKeyStatus(provider, secretStates, pendingSecrets);
            const isCollapsed =
              !isSearchActive && filterMode === "all" && collapsedProviderIds.has(provider.uid);
            const isAnyTesting = provider.models.some((m) => testingModelIds.has(m.uid));
            const menuOpen = openMenuProviderUid === provider.uid;

            return (
              <div key={provider.uid} className="flex flex-col">
                {/* 2-line Provider Header */}
                <div className="flex flex-col gap-1 bg-zinc-50/70 px-3.5 py-2.5 dark:bg-white/[0.02]">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onToggleProviderCollapse(provider.uid)}
                      aria-expanded={!isCollapsed}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      )}
                      <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        <HighlightMatch text={providerLabel} query={searchQuery} />
                      </span>
                    </button>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {keyInfo.status !== "not-needed" ? (
                        <button
                          type="button"
                          onClick={() => onConfigureProvider(provider.uid)}
                          title={`环境变量: ${provider.apiKeyEnv || "未设置"}`}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
                            keyInfo.status === "configured"
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                              : keyInfo.status === "pending"
                                ? "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300"
                                : "border-amber-500/45 bg-amber-500/12 text-amber-700 dark:text-amber-300"
                          }`}
                        >
                          <KeyRound className="h-2.5 w-2.5 shrink-0" />
                          <span>
                            {keyInfo.status === "configured"
                              ? "密钥就绪"
                              : keyInfo.status === "pending"
                                ? "密钥待保存"
                                : "未配密钥"}
                          </span>
                        </button>
                      ) : null}

                      {provider.models.length > 0 ? (
                        <button
                          type="button"
                          disabled={isAnyTesting}
                          onClick={() => onTestProviderAll(provider.uid)}
                          title="测试该供应商下全部模型"
                          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        >
                          {isAnyTesting ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Play className="h-3 w-3" />
                          )}
                          <span>全测</span>
                        </button>
                      ) : null}

                      <div
                        className="relative"
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setOpenMenuProviderUid(menuOpen ? null : provider.uid)
                          }
                          aria-label={`供应商 ${providerLabel} 更多操作`}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>

                        {menuOpen ? (
                          <div className="absolute right-0 z-30 mt-1 w-40 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-[#131a1f]">
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuProviderUid(null);
                                onAddModel(provider.uid);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              <span>添加模型</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuProviderUid(null);
                                onConfigureProvider(provider.uid);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                              <Settings2 className="h-3.5 w-3.5" />
                              <span>配置供应商</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuProviderUid(null);
                                onRequestDeleteProvider(provider.uid);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              <span>删除供应商</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {/* Line 2: protocol · count · URL */}
                  <div className="flex min-w-0 items-center gap-1.5 pl-5 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                      {provider.protocol}
                    </span>
                    <span className="shrink-0" aria-hidden="true">·</span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums">
                      {provider.models.length} 个模型
                    </span>
                    {provider.baseUrl ? (
                      <>
                        <span className="shrink-0" aria-hidden="true">·</span>
                        <span
                          title={provider.baseUrl}
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500"
                        >
                          {middleTruncateUrl(provider.baseUrl, 24)}
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>

                {/* Models */}
                {!isCollapsed ? (
                  <div className="flex flex-col gap-1 p-2">
                    {visibleModels.length === 0 ? (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-zinc-200 px-3 py-2.5 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                        <span>暂无模型</span>
                        <button
                          type="button"
                          onClick={() => onAddModel(provider.uid)}
                          className="inline-flex items-center gap-1 font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                        >
                          <Plus className="h-3 w-3" />
                          <span>添加模型</span>
                        </button>
                      </div>
                    ) : (
                      visibleModels.map((model) => {
                        const mid = model.id.trim();
                        const isSelected = selectedModelUid === model.uid;
                        const boundSlots = mid
                          ? slotIndex.byTarget.get(`${slug}/${mid}`) ?? []
                          : [];
                        const isDuplicate = Boolean(mid && (idCounts.get(mid) ?? 0) > 1);
                        const validation = validateModelEntry(model, isDuplicate);
                        const isModified = modifiedModelUids.has(model.uid);
                        const ctxText = formatTokenCount(model.advanced.contextWindow);
                        const overrideLabels: string[] = [];
                        if (
                          model.advanced.apiOverride &&
                          model.advanced.apiOverride !== "__inherit__"
                        ) {
                          overrideLabels.push("协议");
                        }
                        if (model.advanced.baseUrlOverride.trim()) {
                          overrideLabels.push("URL");
                        }
                        if (model.advanced.customHeaders.trim()) {
                          overrideLabels.push("请求头");
                        }
                        const outcome = testOutcomes[model.uid];
                        const isTesting = testingModelIds.has(model.uid);

                        return (
                          <div
                            key={model.uid}
                            role="button"
                            tabIndex={0}
                            onClick={() => onSelectModel(provider.uid, model.uid)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onSelectModel(provider.uid, model.uid);
                              }
                            }}
                            className={`flex cursor-pointer items-start justify-between gap-2.5 rounded-lg px-3 py-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
                              isSelected
                                ? "bg-emerald-500/10 ring-1 ring-emerald-500/45 dark:bg-emerald-500/12"
                                : "hover:bg-zinc-100/80 dark:hover:bg-white/[0.03]"
                            }`}
                          >
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                              <div className="flex items-center gap-1.5">
                                {isModified ? (
                                  <span
                                    title="有未保存更改"
                                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                                  />
                                ) : null}
                                <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                  <HighlightMatch
                                    text={model.displayName.trim() || mid || "未命名模型"}
                                    query={searchQuery}
                                  />
                                </span>
                                {validation.hasError ? (
                                  <span
                                    title="该模型存在配置错误"
                                    className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-rose-500/35 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-300"
                                  >
                                    <AlertCircle className="h-2.5 w-2.5" />
                                    <span>有误</span>
                                  </span>
                                ) : null}
                              </div>

                              <div className="flex items-center gap-1.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                                <span className="truncate">
                                  <HighlightMatch
                                    text={mid || "未设 ID"}
                                    query={searchQuery}
                                  />
                                </span>
                                {ctxText ? (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="shrink-0 tabular-nums">{ctxText}</span>
                                  </>
                                ) : null}
                                {isTesting ? (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-emerald-500" />
                                  </>
                                ) : outcome ? (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span
                                      className={`shrink-0 ${
                                        !outcome.ok
                                          ? "text-rose-500"
                                          : isTestOutcomeEmptyWarning(outcome)
                                            ? "text-amber-500"
                                            : "text-emerald-500"
                                      }`}
                                    >
                                      {outcome.ok ? `${outcome.latencyMs}ms` : "失败"}
                                    </span>
                                  </>
                                ) : null}
                              </div>

                              <div className="flex flex-wrap items-center gap-1 pt-0.5">
                                {boundSlots.length > 0 ? (
                                  boundSlots.map((slotKey) => (
                                    <span
                                      key={slotKey}
                                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none ${
                                        SLOT_COLOR_MAP[slotKey]?.pillClass ?? ""
                                      }`}
                                    >
                                      {slotKey}
                                    </span>
                                  ))
                                ) : (
                                  <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                                    未使用
                                  </span>
                                )}

                                {overrideLabels.length > 0 ? (
                                  <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                                    已覆盖：{overrideLabels.join("、")}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            {/* Always show BOTH capability icons; dim unsupported */}
                            <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                              <span
                                tabIndex={0}
                                title={model.supportsVision ? "支持识图" : "不支持识图"}
                                aria-label={model.supportsVision ? "支持识图" : "不支持识图"}
                                onClick={(e) => e.stopPropagation()}
                                className={`inline-flex rounded p-0.5 focus-visible:outline-2 focus-visible:outline-emerald-500 ${
                                  model.supportsVision
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : "text-zinc-400 opacity-35 dark:text-zinc-500"
                                }`}
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </span>
                              <span
                                tabIndex={0}
                                title={model.supportsThinking ? "支持思考" : "不支持思考"}
                                aria-label={model.supportsThinking ? "支持思考" : "不支持思考"}
                                onClick={(e) => e.stopPropagation()}
                                className={`inline-flex rounded p-0.5 focus-visible:outline-2 focus-visible:outline-emerald-500 ${
                                  model.supportsThinking
                                    ? "text-sky-600 dark:text-sky-400"
                                    : "text-zinc-400 opacity-35 dark:text-zinc-500"
                                }`}
                              >
                                <Brain className="h-3.5 w-3.5" />
                              </span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
