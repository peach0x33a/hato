import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronRight,
  Eye,
  ListPlus,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type ModelsDevMappedMetadata,
  type ModelsDevSearchItem,
  type UpstreamModelEntry,
} from "@/api";
import {
  formatTokenCount,
  inferUiModelGroup,
  parseHeadersJson,
  type SlotDefinition,
  type UiProviderConfig,
} from "./types";

export interface AddModelDraftInput {
  id: string;
  displayName: string;
  supportsVision: boolean;
  supportsThinking: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelsDev?: ModelsDevMappedMetadata;
}

export interface UpstreamCacheEntry {
  models: UpstreamModelEntry[];
  fetchedFrom: string;
  latencyMs: number;
}

interface AddModelModalProps {
  open: boolean;
  provider: UiProviderConfig | null;
  initialTab: "upstream" | "manual";
  pendingSecrets: Record<string, string>;
  boundSlotsByModelId: Map<string, SlotDefinition[]>;
  cachedUpstream: UpstreamCacheEntry | null;
  onCacheUpstream: (entry: UpstreamCacheEntry) => void;
  onClose: () => void;
  onAddModels: (entries: AddModelDraftInput[], options?: { selectLast?: boolean }) => void;
  onRemoveModelById: (modelId: string) => void;
  onConfigureProvider: () => void;
}

interface DrawerRowItem {
  id: string;
  name?: string;
  group: string;
  modelsDev?: ModelsDevMappedMetadata;
  isStale: boolean;
  isAdded: boolean;
}

export function AddModelModal({
  open,
  provider,
  initialTab,
  pendingSecrets,
  boundSlotsByModelId,
  cachedUpstream,
  onCacheUpstream,
  onClose,
  onAddModels,
  onRemoveModelById,
  onConfigureProvider,
}: AddModelModalProps) {
  const isFaux = provider?.protocol === "hato-faux-api";
  const [activeTab, setActiveTab] = useState<"upstream" | "manual">(
    isFaux ? "manual" : initialTab,
  );

  // Upstream tab state
  const [upstreamLoading, setUpstreamLoading] = useState(false);
  const [upstreamError, setUpstreamError] = useState<string | null>(null);
  const [upstreamQuery, setUpstreamQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "stale" | "unadded" | "added">("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Manual tab state
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualVision, setManualVision] = useState(false);
  const [manualThinking, setManualThinking] = useState(false);
  const [manualContextWindow, setManualContextWindow] = useState("128000");
  const [manualMaxTokens, setManualMaxTokens] = useState("8192");
  const [manualModelsDev, setManualModelsDev] = useState<ModelsDevMappedMetadata | undefined>(
    undefined,
  );

  // models.dev quick search in manual tab
  const [mdQuery, setMdQuery] = useState("");
  const [mdResults, setMdResults] = useState<ModelsDevSearchItem[]>([]);
  const [mdSearching, setMdSearching] = useState(false);
  const [mdResolving, setMdResolving] = useState(false);

  // Reset modal state when opened or provider changes
  useEffect(() => {
    if (!open || !provider) return;
    setActiveTab(provider.protocol === "hato-faux-api" ? "manual" : initialTab);
    setUpstreamError(null);
    setUpstreamQuery("");
    setStatusFilter("all");
    setCollapsedGroups(new Set());
    setManualId("");
    setManualName("");
    setManualVision(false);
    setManualThinking(false);
    setManualContextWindow("128000");
    setManualMaxTokens("8192");
    setManualModelsDev(undefined);
    setMdQuery("");
    setMdResults([]);
  }, [open, provider?.uid, initialTab]);

  const loadUpstream = async () => {
    if (!provider || provider.protocol === "hato-faux-api") return;
    const slug = provider.name.trim();
    const baseUrl = provider.baseUrl.trim();
    if (!slug || !baseUrl) {
      setUpstreamError("请先完善供应商名称与 Base URL");
      return;
    }

    const headersRes = parseHeadersJson(provider.customHeaders, `供应商 "${slug}" 请求头`);
    if (!headersRes.ok) {
      setUpstreamError(headersRes.error);
      return;
    }

    setUpstreamLoading(true);
    setUpstreamError(null);
    try {
      const envName = provider.apiKeyEnv.trim();
      const res = await api.fetchUpstreamModels({
        providerSlug: slug,
        api: provider.protocol,
        baseUrl,
        apiKeyEnv: envName || undefined,
        apiKeyOverride: envName ? pendingSecrets[envName] : undefined,
        providerHeaders: headersRes.headers,
      });
      onCacheUpstream({
        models: res.models,
        fetchedFrom: res.fetchedFrom,
        latencyMs: res.latencyMs,
      });
    } catch (err) {
      setUpstreamError(err instanceof Error ? err.message : "拉取上游模型失败");
    } finally {
      setUpstreamLoading(false);
    }
  };

  // Auto-fetch upstream models when opening on upstream tab without cache
  useEffect(() => {
    if (!open || !provider || activeTab !== "upstream") return;
    if (provider.protocol === "hato-faux-api") return;
    if (cachedUpstream || upstreamLoading || upstreamError) return;
    void loadUpstream();
  }, [open, provider?.uid, activeTab, cachedUpstream]);

  // Debounced models.dev search on manual tab
  useEffect(() => {
    if (!open || activeTab !== "manual") return;
    const q = mdQuery.trim();
    if (!q) {
      setMdResults([]);
      setMdSearching(false);
      return;
    }
    let cancelled = false;
    setMdSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.searchModelsDev(q, 10);
        if (!cancelled) {
          setMdResults(res.items);
          setMdSearching(false);
        }
      } catch {
        if (!cancelled) {
          setMdResults([]);
          setMdSearching(false);
        }
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, activeTab, mdQuery]);

  const existingModelIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of provider?.models ?? []) {
      const id = m.id.trim();
      if (id) set.add(id);
    }
    return set;
  }, [provider?.models]);

  const upstreamModels = cachedUpstream?.models ?? [];
  const upstreamIdSet = useMemo(
    () => new Set(upstreamModels.map((m) => m.id)),
    [upstreamModels],
  );

  const staleLocalModels = useMemo(() => {
    if (!cachedUpstream) return [];
    return (provider?.models ?? []).filter((m) => {
      const id = m.id.trim();
      return Boolean(id && !upstreamIdSet.has(id));
    });
  }, [cachedUpstream, provider?.models, upstreamIdSet]);

  const unaddedUpstreamModels = useMemo(
    () => upstreamModels.filter((m) => !existingModelIds.has(m.id)),
    [upstreamModels, existingModelIds],
  );

  const allMergedRows = useMemo<DrawerRowItem[]>(() => {
    const rows: DrawerRowItem[] = upstreamModels.map((m) => ({
      id: m.id,
      name: m.name,
      group: m.group,
      modelsDev: m.modelsDev,
      isStale: false,
      isAdded: existingModelIds.has(m.id),
    }));
    for (const local of staleLocalModels) {
      const id = local.id.trim();
      rows.push({
        id,
        name: local.displayName.trim() || id,
        group: inferUiModelGroup(id),
        isStale: true,
        isAdded: true,
      });
    }
    return rows;
  }, [upstreamModels, staleLocalModels, existingModelIds]);

  const groupedModels = useMemo(() => {
    const q = upstreamQuery.trim().toLowerCase();
    const groups = new Map<string, DrawerRowItem[]>();
    for (const item of allMergedRows) {
      if (statusFilter === "stale" && !item.isStale) continue;
      if (statusFilter === "added" && !item.isAdded) continue;
      if (statusFilter === "unadded" && item.isAdded) continue;
      if (
        q &&
        !item.id.toLowerCase().includes(q) &&
        !(item.name?.toLowerCase().includes(q) ?? false) &&
        !item.group.toLowerCase().includes(q)
      ) {
        continue;
      }
      const list = groups.get(item.group) ?? [];
      list.push(item);
      groups.set(item.group, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [allMergedRows, upstreamQuery, statusFilter]);

  useEffect(() => {
    if (groupedModels.length > 8 && !upstreamQuery.trim()) {
      setCollapsedGroups(new Set(groupedModels.slice(4).map(([g]) => g)));
    } else {
      setCollapsedGroups(new Set());
    }
  }, [cachedUpstream]);

  if (!open || !provider) return null;

  const providerLabel = provider.displayName?.trim() || provider.name;
  const trimmedManualId = manualId.trim();
  const isManualDuplicate = Boolean(trimmedManualId && existingModelIds.has(trimmedManualId));
  const canSubmitManual = Boolean(trimmedManualId && !isManualDuplicate && !/\s/.test(trimmedManualId));

  const toDraftFromRow = (item: Pick<DrawerRowItem, "id" | "name" | "modelsDev">): AddModelDraftInput => {
    const md = item.modelsDev;
    return {
      id: item.id,
      displayName: item.name || md?.name || item.id,
      supportsVision: md ? md.input.includes("image") : false,
      supportsThinking: md ? md.reasoning : false,
      contextWindow: md?.context_window,
      maxOutputTokens: md?.max_tokens,
      modelsDev: md,
    };
  };

  const handleCleanStaleModels = () => {
    for (const m of staleLocalModels) {
      const id = m.id.trim();
      if (!id) continue;
      if ((boundSlotsByModelId.get(id)?.length ?? 0) > 0) continue;
      onRemoveModelById(id);
    }
  };

  const handleSelectModelsDevItem = async (item: ModelsDevSearchItem) => {
    setMdResolving(true);
    try {
      const res = await api.lookupModelsDev(item.ref);
      const md = res.metadata;
      setManualModelsDev(md);
      if (!manualId.trim()) {
        setManualId(md.modelId);
      }
      if (!manualName.trim()) {
        setManualName(md.name);
      }
      setManualVision(md.input.includes("image"));
      setManualThinking(md.reasoning);
      if (md.context_window) setManualContextWindow(String(md.context_window));
      if (md.max_tokens) setManualMaxTokens(String(md.max_tokens));
      setMdQuery("");
      setMdResults([]);
    } catch {
      if (!manualId.trim()) {
        const slashIdx = item.ref.indexOf("/");
        setManualId(slashIdx >= 0 ? item.ref.slice(slashIdx + 1) : item.ref);
      }
      if (!manualName.trim()) {
        setManualName(item.name);
      }
      setManualVision(item.supportsVision);
      setManualThinking(item.reasoning);
      if (item.contextWindow) setManualContextWindow(String(item.contextWindow));
      if (item.maxTokens) setManualMaxTokens(String(item.maxTokens));
      setMdQuery("");
      setMdResults([]);
    } finally {
      setMdResolving(false);
    }
  };

  const handleSubmitManual = (closeAfter: boolean) => {
    if (!canSubmitManual) return;
    const ctxNum = Number(manualContextWindow);
    const maxNum = Number(manualMaxTokens);
    onAddModels(
      [
        {
          id: trimmedManualId,
          displayName: manualName.trim() || trimmedManualId,
          supportsVision: manualVision,
          supportsThinking: manualThinking,
          contextWindow: Number.isFinite(ctxNum) && ctxNum >= 1 ? Math.floor(ctxNum) : 128000,
          maxOutputTokens: Number.isFinite(maxNum) && maxNum >= 1 ? Math.floor(maxNum) : 8192,
          modelsDev: manualModelsDev,
        },
      ],
      { selectLast: true },
    );
    if (closeAfter) {
      onClose();
    } else {
      setManualId("");
      setManualName("");
      setManualVision(false);
      setManualThinking(false);
      setManualModelsDev(undefined);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${providerLabel} 模型`}
        onMouseDown={(e) => e.stopPropagation()}
        className="relative z-10 flex h-full w-full max-w-[560px] flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-[#10161b]"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {providerLabel} 模型
            </h3>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[11px] tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {activeTab === "upstream" && cachedUpstream
                ? allMergedRows.length
                : provider.models.length}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {activeTab === "upstream" && staleLocalModels.length > 0 ? (
              <button
                type="button"
                onClick={handleCleanStaleModels}
                title="移除所有未在槽位使用中的失效模型"
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 text-[11px] font-medium text-rose-600 transition-colors hover:bg-rose-500/20 dark:text-rose-300"
              >
                <Trash2 className="h-3 w-3" />
                <span>清理失效模型 ({staleLocalModels.length})</span>
              </button>
            ) : null}

            {activeTab === "upstream" && unaddedUpstreamModels.length > 0 ? (
              <button
                type="button"
                onClick={() => onAddModels(unaddedUpstreamModels.map(toDraftFromRow))}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
              >
                <ListPlus className="h-3.5 w-3.5" />
                <span>添加全部模型</span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mode Switcher */}
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/70 px-5 py-2 dark:border-zinc-800 dark:bg-[#0d1216]">
          <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-[#131a1f]">
            <button
              type="button"
              disabled={isFaux}
              onClick={() => setActiveTab("upstream")}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                activeTab === "upstream"
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
              }`}
            >
              从上游拉取
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("manual")}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                activeTab === "manual"
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
              }`}
            >
              手动添加
            </button>
          </div>

          {activeTab === "upstream" ? (
            <button
              type="button"
              disabled={upstreamLoading}
              onClick={() => void loadUpstream()}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              <RefreshCw className={`h-3 w-3 ${upstreamLoading ? "animate-spin" : ""}`} />
              <span>刷新</span>
            </button>
          ) : null}
        </div>

        {/* Body */}
        {activeTab === "upstream" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Search + Filter pills */}
            <div className="space-y-2.5 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={upstreamQuery}
                  onChange={(e) => setUpstreamQuery(e.target.value)}
                  placeholder="搜索模型..."
                  className="h-8 w-full rounded-lg border border-zinc-200 bg-zinc-50 pl-8 pr-7 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500/60 focus:bg-white focus:outline-none dark:border-zinc-800 dark:bg-[#0b1014] dark:text-zinc-100 dark:focus:bg-[#0d1216]"
                />
                {upstreamQuery ? (
                  <button
                    type="button"
                    onClick={() => setUpstreamQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {(
                  [
                    ["all", `全部 ${allMergedRows.length}`],
                    ...(staleLocalModels.length > 0
                      ? ([["stale", `失效 ${staleLocalModels.length}`]] as const)
                      : []),
                    ["unadded", `未添加 ${unaddedUpstreamModels.length}`],
                    ["added", `已添加 ${provider.models.length}`],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={`rounded-md border px-2 py-0.5 font-medium transition-colors ${
                      statusFilter === key
                        ? key === "stale"
                          ? "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-300"
                          : "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                        : "border-zinc-200 bg-zinc-50/70 text-zinc-600 hover:text-zinc-900 dark:border-zinc-800 dark:bg-[#0d1216] dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* List */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              {upstreamLoading && !cachedUpstream ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <Loader2 className="h-5 w-5 animate-spin text-emerald-500" />
                  <span>正在从上游拉取可用模型名单…</span>
                </div>
              ) : upstreamError ? (
                <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-200">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="font-medium">拉取上游模型失败</p>
                      <p className="break-words text-amber-700/90 dark:text-amber-200/80">
                        {upstreamError}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => void loadUpstream()}
                          className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-white/80 px-2.5 py-1 font-medium text-amber-900 hover:bg-white dark:bg-zinc-900 dark:text-amber-200"
                        >
                          <RefreshCw className="h-3 w-3" />
                          <span>重试</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onConfigureProvider();
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                        >
                          <Settings2 className="h-3 w-3" />
                          <span>配置供应商</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTab("manual")}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white hover:bg-emerald-500"
                        >
                          <span>切换到手动添加</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : groupedModels.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>
                    {allMergedRows.length === 0
                      ? "上游未返回任何模型"
                      : "没有匹配当前筛选条件的模型"}
                  </span>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {groupedModels.map(([group, items]) => {
                    const isCollapsed = !upstreamQuery.trim() && collapsedGroups.has(group);
                    const unaddedInGroup = items.filter((m) => !m.isAdded && !m.isStale);
                    const removableInGroup = items.filter(
                      (m) => m.isAdded && (boundSlotsByModelId.get(m.id)?.length ?? 0) === 0,
                    );

                    return (
                      <div
                        key={group}
                        className="overflow-hidden rounded-xl border border-zinc-200/90 dark:border-zinc-800"
                      >
                        <div className="flex items-center justify-between bg-zinc-50/90 px-3 py-2 dark:bg-[#151d24]">
                          <button
                            type="button"
                            onClick={() =>
                              setCollapsedGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(group)) next.delete(group);
                                else next.add(group);
                                return next;
                              })
                            }
                            className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200"
                          >
                            {isCollapsed ? (
                              <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                            )}
                            <span>{group}</span>
                            <span className="rounded-full bg-zinc-200/70 px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                              {items.length}
                            </span>
                          </button>

                          {unaddedInGroup.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => onAddModels(unaddedInGroup.map(toDraftFromRow))}
                              title={`添加本组全部 (${unaddedInGroup.length})`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-emerald-500/15 hover:text-emerald-600 dark:text-zinc-400 dark:hover:text-emerald-300"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          ) : removableInGroup.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => {
                                for (const r of removableInGroup) onRemoveModelById(r.id);
                              }}
                              title="移除本组未绑定槽位的模型"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-rose-500/15 hover:text-rose-500"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                        </div>

                        {!isCollapsed ? (
                          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                            {items.map((item) => {
                              const boundSlots = boundSlotsByModelId.get(item.id) ?? [];
                              const isBound = boundSlots.length > 0;
                              const md = item.modelsDev;
                              const ctxText = md?.context_window
                                ? formatTokenCount(String(md.context_window))
                                : null;

                              return (
                                <div
                                  key={`${item.isStale ? "stale" : "up"}-${item.id}`}
                                  className={`flex items-center justify-between gap-2.5 px-3 py-2 transition-colors ${
                                    item.isAdded
                                      ? "bg-emerald-500/[0.08] hover:bg-emerald-500/[0.12]"
                                      : "hover:bg-zinc-50/70 dark:hover:bg-zinc-900/40"
                                  }`}
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="truncate font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100">
                                        {item.id}
                                      </span>
                                      {item.name && item.name !== item.id ? (
                                        <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                                          {item.name}
                                        </span>
                                      ) : null}
                                      {item.isStale ? (
                                        <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400">
                                          失效
                                        </span>
                                      ) : null}
                                    </div>
                                    {md ? (
                                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                                        {md.reasoning ? (
                                          <span className="inline-flex items-center gap-0.5 text-sky-600 dark:text-sky-400">
                                            <Brain className="h-3 w-3" />
                                            <span>思考</span>
                                          </span>
                                        ) : null}
                                        {md.input.includes("image") ? (
                                          <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                                            <Eye className="h-3 w-3" />
                                            <span>视觉</span>
                                          </span>
                                        ) : null}
                                        {ctxText ? (
                                          <span className="tabular-nums">{ctxText}</span>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>

                                  {item.isAdded ? (
                                    <button
                                      type="button"
                                      disabled={isBound}
                                      onClick={() => onRemoveModelById(item.id)}
                                      title={
                                        isBound
                                          ? `已被槽位引用（${boundSlots.map((s) => s.label).join("、")}），不可移除`
                                          : "移除模型"
                                      }
                                      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
                                        isBound
                                          ? "cursor-not-allowed text-zinc-400/50"
                                          : "text-zinc-500 hover:bg-rose-500/15 hover:text-rose-600 dark:text-zinc-300 dark:hover:text-rose-400"
                                      }`}
                                    >
                                      <Minus className="h-3.5 w-3.5" />
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => onAddModels([toDraftFromRow(item)])}
                                      title="添加模型"
                                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-emerald-500/15 hover:text-emerald-600 dark:text-zinc-300 dark:hover:text-emerald-300"
                                    >
                                      <Plus className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Manual tab */
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-[#0d1216]">
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-zinc-700 dark:text-zinc-200">
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
                  <span>从 models.dev 快速填充元数据（可选）</span>
                </span>
                {mdResolving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" /> : null}
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={mdQuery}
                  onChange={(e) => setMdQuery(e.target.value)}
                  placeholder="搜索 models.dev，如 gpt-4.1、claude-sonnet、gemini-2.5..."
                  className="h-8 w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-3 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500/60 focus:outline-none dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-100"
                />
              </div>
              {mdSearching ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>搜索中…</span>
                </div>
              ) : mdResults.length > 0 ? (
                <div className="mt-2 max-h-40 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-[#131a1f]">
                  {mdResults.map((item) => (
                    <button
                      key={item.ref}
                      type="button"
                      onClick={() => void handleSelectModelsDevItem(item)}
                      className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800/70"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-mono font-medium text-zinc-900 dark:text-zinc-100">
                          {item.ref}
                        </div>
                        <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                          {item.name}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400">
                        {item.reasoning ? <Brain className="h-3 w-3 text-sky-500" /> : null}
                        {item.supportsVision ? <Eye className="h-3 w-3 text-emerald-500" /> : null}
                      </div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">
                  模型 ID <span className="text-rose-500">*</span>
                </span>
                <input
                  type="text"
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                  placeholder="例如 gpt-4.1-mini"
                  className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 font-mono text-xs text-zinc-900 focus:border-emerald-500/60 focus:outline-none dark:border-zinc-800 dark:bg-[#0d1216] dark:text-zinc-100"
                />
                {isManualDuplicate ? (
                  <p className="text-[11px] text-rose-500">该供应商下已存在相同模型 ID</p>
                ) : /\s/.test(trimmedManualId) ? (
                  <p className="text-[11px] text-rose-500">模型 ID 不能包含空白字符</p>
                ) : null}
              </label>

              <label className="block space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">显示名称</span>
                <input
                  type="text"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="留空则默认使用模型 ID"
                  className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-xs text-zinc-900 focus:border-emerald-500/60 focus:outline-none dark:border-zinc-800 dark:bg-[#0d1216] dark:text-zinc-100"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="inline-flex cursor-pointer items-center gap-2 text-zinc-700 dark:text-zinc-200">
                <input
                  type="checkbox"
                  checked={manualVision}
                  onChange={(e) => setManualVision(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                />
                <Eye className="h-3.5 w-3.5 text-emerald-500" />
                <span>支持视觉（图像输入）</span>
              </label>

              <label className="inline-flex cursor-pointer items-center gap-2 text-zinc-700 dark:text-zinc-200">
                <input
                  type="checkbox"
                  checked={manualThinking}
                  onChange={(e) => setManualThinking(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                />
                <Brain className="h-3.5 w-3.5 text-sky-500" />
                <span>支持思考 / 推理</span>
              </label>
            </div>

            {manualModelsDev ? (
              <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                <span>已关联 models.dev：{manualModelsDev.ref}</span>
                <button
                  type="button"
                  onClick={() => setManualModelsDev(undefined)}
                  className="text-[11px] underline hover:opacity-80"
                >
                  取消关联
                </button>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={!canSubmitManual}
                onClick={() => handleSubmitManual(false)}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-zinc-700 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                添加并继续
              </button>
              <button
                type="button"
                disabled={!canSubmitManual}
                onClick={() => handleSubmitManual(true)}
                className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-45"
              >
                添加并关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
