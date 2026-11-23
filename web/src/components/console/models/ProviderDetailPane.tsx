import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Loader2,
  Minus,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import type { SecretState } from "@/api";
import type { ModelTestOutcome } from "./ModelDetailPanel";
import {
  inferUiModelGroup,
  resolveProviderKeyStatus,
  SLOT_COLOR_MAP,
  type SlotKey,
  type UiModelEntry,
  type UiProviderConfig,
} from "./types";

interface SlotIndex {
  byTarget: Map<string, SlotKey[]>;
  byProvider: Map<string, SlotKey[]>;
}

interface ProviderDetailPaneProps {
  provider: UiProviderConfig;
  slotIndex: SlotIndex;
  secretStates: SecretState[];
  pendingSecrets: Record<string, string>;
  testingModelIds: Set<string>;
  testOutcomes: Record<string, ModelTestOutcome>;
  selectedModelUid: string | null;
  onInlineUpdateProvider: (patch: Partial<Pick<UiProviderConfig, "baseUrl">>) => void;
  onInlineSecretChange: (envName: string, value: string) => void;
  onConfigureProvider: () => void;
  onRequestDeleteProvider: () => void;
  onTestProviderAll: () => void;
  onTestModel: (modelUid: string) => void;
  onOpenAddModelModal: (initialTab: "upstream" | "manual") => void;
  onEditModel: (modelUid: string) => void;
  onRemoveModel: (modelUid: string, modelTitle: string) => void;
  onShowTestDetail: (modelUid: string) => void;
}

export function ProviderDetailPane({
  provider,
  slotIndex,
  secretStates,
  pendingSecrets,
  testingModelIds,
  testOutcomes,
  selectedModelUid,
  onInlineUpdateProvider,
  onInlineSecretChange,
  onConfigureProvider,
  onRequestDeleteProvider,
  onTestProviderAll,
  onTestModel,
  onOpenAddModelModal,
  onEditModel,
  onRemoveModel,
  onShowTestDetail,
}: ProviderDetailPaneProps) {
  const [showKey, setShowKey] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    setShowKey(false);
    setModelQuery("");
    setCollapsedGroups(new Set());
  }, [provider.uid]);

  const providerLabel = provider.displayName?.trim() || provider.name;
  const slug = provider.name.trim();
  const isFaux = provider.protocol === "hato-faux-api";
  const envName = provider.apiKeyEnv.trim();
  const keyInfo = resolveProviderKeyStatus(provider, secretStates, pendingSecrets);
  const pendingKeyVal = envName ? pendingSecrets[envName] ?? "" : "";

  const isAnyTesting = provider.models.some((m) => testingModelIds.has(m.uid));
  const firstModel = provider.models[0];

  const groupedModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const groups = new Map<string, UiModelEntry[]>();
    for (const m of provider.models) {
      if (
        q &&
        !m.id.toLowerCase().includes(q) &&
        !m.displayName.toLowerCase().includes(q)
      ) {
        continue;
      }
      const g = inferUiModelGroup(m.id);
      const list = groups.get(g) ?? [];
      list.push(m);
      groups.set(g, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [provider.models, modelQuery]);

  const allCollapsed =
    groupedModels.length > 0 && groupedModels.every(([g]) => collapsedGroups.has(g));

  const toggleAllGroups = () => {
    if (allCollapsed) {
      setCollapsedGroups(new Set());
    } else {
      setCollapsedGroups(new Set(groupedModels.map(([g]) => g)));
    }
  };

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-[#10161b]">
      {/* Provider Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 pb-4 dark:border-zinc-800/80">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {providerLabel}
          </h2>
          <button
            type="button"
            onClick={onConfigureProvider}
            title="配置供应商高级参数（协议、名称、请求头、Cache TTL）"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
          <span className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            {provider.protocol}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {provider.models.length > 0 ? (
            <button
              type="button"
              disabled={isAnyTesting}
              onClick={onTestProviderAll}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-800 dark:bg-[#151c22] dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {isAnyTesting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              <span>全测</span>
            </button>
          ) : null}

          <button
            type="button"
            onClick={onRequestDeleteProvider}
            title="删除服务商"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-400 transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-600 dark:border-zinc-800 dark:hover:text-rose-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Inline API Key & Base URL */}
      <div className="space-y-4">
        {!isFaux ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">API 密钥</span>
                {envName ? (
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    {envName}
                  </span>
                ) : null}
              </div>
              <span
                className={`text-[11px] font-medium ${
                  keyInfo.status === "configured"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : keyInfo.status === "pending"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-amber-600 dark:text-amber-400"
                }`}
              >
                {keyInfo.status === "configured"
                  ? "已配置"
                  : keyInfo.status === "pending"
                    ? "待保存生效"
                    : "未配置"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? "text" : "password"}
                  disabled={!envName}
                  value={pendingKeyVal}
                  onChange={(e) => {
                    if (envName) onInlineSecretChange(envName, e.target.value);
                  }}
                  placeholder={
                    !envName
                      ? "请先在齿轮设置中配置环境变量名"
                      : keyInfo.status === "configured"
                        ? "••••••••（已配置于 .env，输入新值可覆盖）"
                        : "输入 API Key..."
                  }
                  className="h-9 w-full rounded-xl border border-zinc-200 bg-zinc-50/70 pl-3 pr-9 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500/60 focus:bg-white focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-[#0b1014] dark:text-zinc-100 dark:focus:bg-[#0d1216]"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>

              <button
                type="button"
                disabled={!firstModel || testingModelIds.has(firstModel.uid)}
                onClick={() => {
                  if (firstModel) onTestModel(firstModel.uid);
                }}
                title={
                  firstModel
                    ? `使用 ${firstModel.id} 检测连通性`
                    : "请先添加至少一个模型后再检测"
                }
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-zinc-800 dark:bg-[#151c22] dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                {firstModel && testingModelIds.has(firstModel.uid) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                <span>检测</span>
              </button>
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-zinc-800 dark:text-zinc-200">API 地址</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={provider.baseUrl}
              onChange={(e) => onInlineUpdateProvider({ baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1"
              className="h-9 flex-1 rounded-xl border border-zinc-200 bg-zinc-50/70 px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500/60 focus:bg-white focus:outline-none dark:border-zinc-800 dark:bg-[#0b1014] dark:text-zinc-100 dark:focus:bg-[#0d1216]"
            />
            <button
              type="button"
              onClick={onConfigureProvider}
              title="配置协议与请求头"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-[#151c22] dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Models Section */}
      <div className="space-y-3 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">模型</h3>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[11px] tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {provider.models.length}
            </span>
            {groupedModels.length > 1 ? (
              <button
                type="button"
                onClick={toggleAllGroups}
                title={allCollapsed ? "展开全部分组" : "折叠全部分组"}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                {allCollapsed ? (
                  <ChevronsUpDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronsDownUp className="h-3.5 w-3.5" />
                )}
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {provider.models.length > 3 ? (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder="筛选模型..."
                  className="h-8 w-40 rounded-lg border border-zinc-200 bg-zinc-50/70 pl-7 pr-6 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500/60 focus:bg-white focus:outline-none dark:border-zinc-800 dark:bg-[#0b1014] dark:text-zinc-100"
                />
                {modelQuery ? (
                  <button
                    type="button"
                    onClick={() => setModelQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            ) : null}

            {!isFaux ? (
              <button
                type="button"
                onClick={() => onOpenAddModelModal("upstream")}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-700 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5 hover:text-emerald-700 dark:border-zinc-800 dark:bg-[#151c22] dark:text-zinc-200 dark:hover:text-emerald-300"
              >
                <RefreshCw className="h-3 w-3" />
                <span>同步模型</span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => onOpenAddModelModal("manual")}
              title="手动添加模型"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-700 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-700 dark:border-zinc-800 dark:bg-[#151c22] dark:text-zinc-200 dark:hover:text-emerald-300"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Grouped Model Cards */}
        {provider.models.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-200 py-10 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <span>当前服务商下暂无模型</span>
            <div className="flex items-center gap-2">
              {!isFaux ? (
                <button
                  type="button"
                  onClick={() => onOpenAddModelModal("upstream")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>从上游同步模型</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onOpenAddModelModal("manual")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-[#151c22] dark:text-zinc-200"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>手动添加</span>
              </button>
            </div>
          </div>
        ) : groupedModels.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 py-8 text-center text-xs text-zinc-400 dark:border-zinc-800">
            没有匹配「{modelQuery}」的模型
          </div>
        ) : (
          <div className="space-y-3">
            {groupedModels.map(([group, items]) => {
              const isCollapsed = !modelQuery.trim() && collapsedGroups.has(group);
              return (
                <div
                  key={group}
                  className="overflow-hidden rounded-xl border border-zinc-200/90 bg-zinc-50/40 dark:border-zinc-800 dark:bg-[#0d1216]"
                >
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
                    className="flex w-full items-center justify-between px-3.5 py-2 text-left hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40"
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                      {isCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                      )}
                      <span>{group}</span>
                      <span className="rounded-full bg-zinc-200/70 px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        {items.length}
                      </span>
                    </div>
                  </button>

                  {!isCollapsed ? (
                    <div className="divide-y divide-zinc-200/70 border-t border-zinc-200/70 bg-white dark:divide-zinc-800/70 dark:border-zinc-800/70 dark:bg-[#11171c]">
                      {items.map((model) => {
                        const mid = model.id.trim();
                        const title = model.displayName.trim() || mid || "未命名模型";
                        const boundSlots = mid
                          ? slotIndex.byTarget.get(`${slug}/${mid}`) ?? []
                          : [];
                        const outcome = testOutcomes[model.uid];
                        const isTesting = testingModelIds.has(model.uid);
                        const isEditing = selectedModelUid === model.uid;

                        return (
                          <div
                            key={model.uid}
                            onClick={() => onEditModel(model.uid)}
                            className={`group flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/50 ${
                              isEditing ? "bg-emerald-500/[0.06]" : ""
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                                  {title}
                                </span>
                                {mid && title !== mid ? (
                                  <span className="truncate font-mono text-[11px] text-zinc-400">
                                    {mid}
                                  </span>
                                ) : null}
                                {boundSlots.map((slotKey) => (
                                  <span
                                    key={slotKey}
                                    className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none ${
                                      SLOT_COLOR_MAP[slotKey]?.pillClass ?? ""
                                    }`}
                                  >
                                    {slotKey}
                                  </span>
                                ))}
                                {isTesting ? (
                                  <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />
                                ) : outcome ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onShowTestDetail(model.uid);
                                    }}
                                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                                      outcome.ok
                                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                        : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                    }`}
                                  >
                                    {outcome.ok ? `${outcome.latencyMs}ms` : "失败"}
                                  </button>
                                ) : null}
                              </div>
                            </div>

                            <div
                              className="flex shrink-0 items-center gap-1.5"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span
                                title={model.supportsVision ? "支持视觉" : "不支持视觉"}
                                className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] ${
                                  model.supportsVision
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                    : "border-transparent text-zinc-300 dark:text-zinc-700"
                                }`}
                              >
                                <Eye className="h-3 w-3" />
                              </span>
                              <span
                                title={model.supportsThinking ? "支持思考" : "不支持思考"}
                                className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] ${
                                  model.supportsThinking
                                    ? "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400"
                                    : "border-transparent text-zinc-300 dark:text-zinc-700"
                                }`}
                              >
                                <Brain className="h-3 w-3" />
                              </span>

                              <button
                                type="button"
                                onClick={() => onEditModel(model.uid)}
                                title="编辑模型"
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                              >
                                <Settings className="h-3.5 w-3.5" />
                              </button>

                              <button
                                type="button"
                                onClick={() => onRemoveModel(model.uid, title)}
                                title="移除模型"
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                              >
                                <Minus className="h-3.5 w-3.5" />
                              </button>
                            </div>
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
  );
}
