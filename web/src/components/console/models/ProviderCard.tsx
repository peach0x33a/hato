import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import type { SecretState } from "@/api";
import { ModelRow, type ModelTestOutcome } from "./ModelRow";
import {
  resolveProviderKeyStatus,
  type SlotKey,
  type UiModelEntry,
  type UiProviderConfig,
} from "./types";

interface ProviderCardProps {
  provider: UiProviderConfig;
  visibleModels: UiModelEntry[];
  isSearchActive: boolean;
  boundSlotsByModelId: Map<string, SlotKey[]>;
  providerBoundSlots: SlotKey[];
  duplicateModelIds: Set<string>;
  newlyAddedModelUid: string | null;
  secretStates: SecretState[];
  pendingSecrets: Record<string, string>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  expandedModelIds: Set<string>;
  testingModelIds: Set<string>;
  testOutcomes: Record<string, ModelTestOutcome>;
  onToggleModelExpand: (modelUid: string) => void;
  onTestModel: (modelUid: string) => void;
  onShowTestDetail?: (modelUid: string) => void;
  onConfigureProvider: () => void;
  onDeleteProvider: () => void;
  onAddModel: () => void;
  onUpdateModel: (modelUid: string, patch: Partial<UiModelEntry>) => void;
  onUpdateModelAdvanced: (
    modelUid: string,
    patch: Partial<UiModelEntry["advanced"]>,
  ) => void;
  onRemoveModel: (modelUid: string) => void;
}

export function ProviderCard({
  provider,
  visibleModels,
  isSearchActive,
  boundSlotsByModelId,
  providerBoundSlots,
  duplicateModelIds,
  newlyAddedModelUid,
  secretStates,
  pendingSecrets,
  isCollapsed,
  onToggleCollapse,
  expandedModelIds,
  testingModelIds,
  testOutcomes,
  onToggleModelExpand,
  onTestModel,
  onShowTestDetail,
  onConfigureProvider,
  onDeleteProvider,
  onAddModel,
  onUpdateModel,
  onUpdateModelAdvanced,
  onRemoveModel,
}: ProviderCardProps) {
  const prefersReducedMotion = useReducedMotion();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = window.setTimeout(() => setConfirmingDelete(false), 3200);
    return () => window.clearTimeout(timer);
  }, [confirmingDelete]);

  const keyInfo = resolveProviderKeyStatus(provider, secretStates, pendingSecrets);
  const needsDeleteConfirm =
    provider.models.length > 0 || providerBoundSlots.length > 0;

  const handleDeleteClick = () => {
    if (needsDeleteConfirm && !confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setConfirmingDelete(false);
    onDeleteProvider();
  };

  return (
    <section
      aria-label={`供应商 ${provider.name}`}
      className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800/90 dark:bg-[#0f1418]"
    >
      {/* Provider Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!isCollapsed}
            className="flex min-w-0 items-center gap-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          >
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />
            )}

            <h3 className="truncate font-mono text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {provider.displayName?.trim() || provider.name}
            </h3>
          </button>

          <span className="hidden items-center gap-2 text-xs text-zinc-500 sm:inline-flex dark:text-zinc-400">
            <span className="font-mono text-emerald-700 dark:text-emerald-400">
              {provider.protocol}
            </span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {isSearchActive
                ? `匹配 ${visibleModels.length} / ${provider.models.length} 个模型`
                : `${provider.models.length} 个模型`}
            </span>
            {provider.baseUrl ? (
              <>
                <span aria-hidden="true" className="hidden md:inline">
                  ·
                </span>
                <span
                  title={provider.baseUrl}
                  className="hidden max-w-[240px] truncate font-mono text-[11px] text-zinc-400 md:inline dark:text-zinc-500"
                >
                  {provider.baseUrl}
                </span>
              </>
            ) : null}
          </span>

          {/* API Key quick status pill */}
          {keyInfo.status !== "not-needed" ? (
            <button
              type="button"
              onClick={onConfigureProvider}
              title={`环境变量: ${provider.apiKeyEnv || "未设置"}`}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap transition-colors ${
                keyInfo.status === "configured"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
                  : keyInfo.status === "pending"
                    ? "border-amber-500/35 bg-amber-500/12 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                    : "border-rose-500/35 bg-rose-500/10 text-rose-600 hover:bg-rose-500/15 dark:text-rose-300"
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
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onConfigureProvider}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-700 whitespace-nowrap transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span>配置供应商</span>
          </button>

          <button
            type="button"
            onClick={onAddModel}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-700 whitespace-nowrap transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>添加模型</span>
          </button>

          <button
            type="button"
            onClick={handleDeleteClick}
            title={
              providerBoundSlots.length > 0
                ? `当前正被槽位使用: ${providerBoundSlots.join(", ")}`
                : undefined
            }
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 ${
              confirmingDelete
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-300"
                : "text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>
              {confirmingDelete
                ? providerBoundSlots.length > 0
                  ? `含 ${providerBoundSlots.length} 个绑定槽位 · 确认删除?`
                  : "确认删除?"
                : "删除供应商"}
            </span>
          </button>
        </div>
      </div>

      {/* Collapsible Body: Models List */}
      <AnimatePresence initial={false}>
        {!isCollapsed ? (
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0, height: 0, overflow: "hidden" }}
            animate={{ opacity: 1, height: "auto", transitionEnd: { overflow: "visible" } }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, height: 0, overflow: "hidden" }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            style={prefersReducedMotion ? undefined : { overflow: "hidden" }}
            className="border-t border-zinc-200/80 dark:border-zinc-800/80"
          >
            <div className="px-5 py-3">
              {visibleModels.length === 0 ? (
                <div className="my-2 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-200 py-6 text-center dark:border-zinc-800">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {isSearchActive
                      ? "没有匹配当前搜索条件的模型"
                      : "该供应商下暂未配置任何模型"}
                  </p>
                  {!isSearchActive ? (
                    <button
                      type="button"
                      onClick={onAddModel}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>添加第一个模型</span>
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="divide-y divide-zinc-200/80 dark:divide-zinc-800/80">
                  {visibleModels.map((model) => {
                    const normalizedId = model.id.trim();
                    return (
                      <ModelRow
                        key={model.uid}
                        model={model}
                        providerLabel={provider.displayName?.trim() || provider.name}
                        providerBaseUrl={provider.baseUrl}
                        boundSlots={boundSlotsByModelId.get(normalizedId) ?? []}
                        isDuplicateId={duplicateModelIds.has(normalizedId)}
                        autoFocusId={model.uid === newlyAddedModelUid}
                        isExpanded={expandedModelIds.has(model.uid)}
                        isTesting={testingModelIds.has(model.uid)}
                        testOutcome={testOutcomes[model.uid]}
                        onToggleExpand={() => onToggleModelExpand(model.uid)}
                        onTest={() => onTestModel(model.uid)}
                        onShowTestDetail={
                          onShowTestDetail ? () => onShowTestDetail(model.uid) : undefined
                        }
                        onUpdate={(patch) => onUpdateModel(model.uid, patch)}
                        onUpdateAdvanced={(patch) =>
                          onUpdateModelAdvanced(model.uid, patch)
                        }
                        onRemove={() => onRemoveModel(model.uid)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
