import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Lock,
  MoreHorizontal,
  RefreshCw,
  Send,
  Settings2,
  Trash2,
} from "lucide-react";
import { api, type ModelsDevSearchItem, type ModelsFileConfig } from "@/api";
import { ConsoleSelect } from "@/components/console/ConsolePrimitives";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@/lib/ease";
import {
  API_OVERRIDE_OPTIONS,
  formatTokenCount,
  SLOT_DEFINITIONS,
  type SlotKey,
  type UiModelEntry,
  type UiProviderConfig,
  validateModelEntry,
} from "./types";

export interface ModelTestOutcome {
  ok: boolean;
  latencyMs: number;
  replyPreview?: string;
  error?: string;
  testedAt?: number;
}

export function isTestOutcomeEmptyWarning(outcome?: ModelTestOutcome): boolean {
  if (!outcome || !outcome.ok) return false;
  const preview = outcome.replyPreview?.trim() ?? "";
  return preview.length === 0 || preview === "(empty text response)";
}

function formatTestTime(ts?: number): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "";
  }
}

interface ModelDetailPanelProps {
  provider: UiProviderConfig;
  model: UiModelEntry;
  slots: ModelsFileConfig["slots"];
  hindsightEnabled: boolean;
  isDuplicateId: boolean;
  isTesting: boolean;
  testOutcome?: ModelTestOutcome;
  slotTargetLabels: Map<string, string>;
  onBackMobile?: () => void;
  onUpdate: (patch: Partial<UiModelEntry>) => void;
  onUpdateAdvanced: (patch: Partial<UiModelEntry["advanced"]>) => void;
  onChangeSlot: (slotKey: SlotKey, value: string) => void;
  onTest: () => void;
  onShowTestDetail: () => void;
  onDuplicate: () => void;
  onRequestRemove: () => void;
  onConfigureProvider: () => void;
}

export function ModelDetailPanel({
  provider,
  model,
  slots,
  hindsightEnabled,
  isDuplicateId,
  isTesting,
  testOutcome,
  slotTargetLabels,
  onBackMobile,
  onUpdate,
  onUpdateAdvanced,
  onChangeSlot,
  onTest,
  onShowTestDetail,
  onDuplicate,
  onRequestRemove,
  onConfigureProvider,
}: ModelDetailPanelProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [maskHeaders, setMaskHeaders] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      Boolean(model.modelsDev?.enabled) ||
      (model.advanced.apiOverride !== "__inherit__" && Boolean(model.advanced.apiOverride)) ||
      model.advanced.baseUrlOverride.trim().length > 0 ||
      model.advanced.customHeaders.trim().length > 0,
  );
  const [syncingModelsDev, setSyncingModelsDev] = useState(false);
  const [modelsDevStatus, setModelsDevStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [suggestions, setSuggestions] = useState<ModelsDevSearchItem[]>([]);
  const [searchingModelsDev, setSearchingModelsDev] = useState(false);
  const [modelsDevSearchError, setModelsDevSearchError] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [modelRefDirty, setModelRefDirty] = useState(false);
  const suggestionsBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMoreOpen(false);
    setModelsDevStatus(null);
    setShowSuggestions(false);
    setSearchingModelsDev(false);
    setModelsDevSearchError(null);
    setModelRefDirty(false);
    const hasAdv =
      Boolean(model.modelsDev?.enabled) ||
      (model.advanced.apiOverride !== "__inherit__" && Boolean(model.advanced.apiOverride)) ||
      model.advanced.baseUrlOverride.trim().length > 0 ||
      model.advanced.customHeaders.trim().length > 0;
    setAdvancedOpen(hasAdv);
  }, [model.uid]);

  useEffect(() => {
    if (!moreOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [moreOpen]);

  useEffect(() => {
    if (!showSuggestions) return;
    const onOutside = (e: MouseEvent) => {
      if (
        suggestionsBoxRef.current &&
        !suggestionsBoxRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [showSuggestions]);

  const modelsDev = model.modelsDev ?? { enabled: false, modelRef: "" };
  const isMetadataLocked = modelsDev.enabled;

  useEffect(() => {
    if (!showSuggestions) return;
    const q = modelsDev.modelRef.trim();
    if (!q) {
      setSuggestions([]);
      setSearchingModelsDev(false);
      setModelsDevSearchError(null);
      return;
    }
    let cancelled = false;
    setSearchingModelsDev(true);
    setModelsDevSearchError(null);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.searchModelsDev(q, 12);
        if (!cancelled) {
          setSuggestions(res.items);
          setSearchingModelsDev(false);
        }
      } catch (err) {
        if (!cancelled) {
          setSuggestions([]);
          setSearchingModelsDev(false);
          setModelsDevSearchError(
            err instanceof Error ? err.message : "搜索 models.dev 失败",
          );
        }
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [modelsDev.modelRef, showSuggestions]);

  const validation = validateModelEntry(model, isDuplicateId);
  const titleText = model.displayName.trim() || model.id.trim() || "未命名模型";
  const providerLabel = provider.displayName?.trim() || provider.name;
  const slug = provider.name.trim();
  const currentTarget = slug && model.id.trim() ? `${slug}/${model.id.trim()}` : "";

  const visibleSlots = hindsightEnabled
    ? SLOT_DEFINITIONS
    : SLOT_DEFINITIONS.filter((s) => s.key !== "hindsight_llm");

  const overrideSummaryParts: string[] = [];
  if (model.advanced.apiOverride && model.advanced.apiOverride !== "__inherit__") {
    overrideSummaryParts.push("协议");
  }
  if (model.advanced.baseUrlOverride.trim()) {
    overrideSummaryParts.push("Base URL");
  }
  if (model.advanced.customHeaders.trim()) {
    overrideSummaryParts.push("请求头");
  }
  if (modelsDev.enabled) {
    overrideSummaryParts.push("models.dev");
  }

  const handleUpdateModelsDev = (patch: Partial<UiModelEntry["modelsDev"]>) => {
    onUpdate({
      modelsDev: {
        ...modelsDev,
        ...patch,
      },
    });
  };

  const syncFromModelsDev = async (
    rawRef: string,
    options?: { enableOnSuccess?: boolean; refresh?: boolean },
  ) => {
    const trimmedRef = rawRef.trim();
    if (!trimmedRef) {
      setModelsDevStatus({
        ok: false,
        message: "请先输入 models.dev 映射 ID（如 openai/gpt-4o）",
      });
      return;
    }
    setSyncingModelsDev(true);
    setModelsDevStatus(null);
    setShowSuggestions(false);
    try {
      const res = await api.lookupModelsDev(trimmedRef, options?.refresh ?? false);
      const meta = res.metadata;
      onUpdate({
        supportsVision: meta.input.includes("image"),
        supportsThinking: meta.reasoning,
        modelsDev: {
          enabled: options?.enableOnSuccess ?? modelsDev.enabled,
          modelRef: meta.ref,
        },
        advanced: {
          ...model.advanced,
          ...(meta.context_window !== undefined
            ? { contextWindow: String(meta.context_window) }
            : {}),
          ...(meta.max_tokens !== undefined
            ? { maxOutputTokens: String(meta.max_tokens) }
            : {}),
        },
        preserved: {
          ...model.preserved,
          ...(meta.cost ? { cost: meta.cost } : {}),
        },
      });
      setModelRefDirty(false);
      setModelsDevStatus({
        ok: true,
        message: `已同步: ${meta.name}`,
      });
    } catch (err) {
      setModelsDevStatus({
        ok: false,
        message: err instanceof Error ? err.message : "models.dev 同步失败",
      });
    } finally {
      setSyncingModelsDev(false);
    }
  };

  const handleToggleModelsDev = (next: boolean) => {
    if (!next) {
      handleUpdateModelsDev({ enabled: false });
      setModelsDevStatus(null);
      setModelRefDirty(false);
      return;
    }
    const candidateRef = modelsDev.modelRef.trim();
    handleUpdateModelsDev({ enabled: true });
    if (candidateRef) {
      void syncFromModelsDev(candidateRef, { enableOnSuccess: true });
    } else {
      setModelsDevStatus({
        ok: false,
        message: "请输入映射 ID 并点击同步（如 openai/gpt-4o）",
      });
    }
  };

  const isEmptyWarn = isTestOutcomeEmptyWarning(testOutcome);
  const testedTimeStr = formatTestTime(testOutcome?.testedAt);

  return (
    <motion.div
      key={model.uid}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : SPRING_SWAP}
      className="flex flex-col gap-5 rounded-xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800/90 dark:bg-[#0f1418]"
    >
      {/* Mobile Back Button */}
      {onBackMobile ? (
        <div className="lg:hidden">
          <button
            type="button"
            onClick={onBackMobile}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>返回模型列表</span>
          </button>
        </div>
      ) : null}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 pb-4 dark:border-zinc-800/80">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {titleText}
          </h2>
          <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 font-mono text-xs text-zinc-600 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-300">
            {providerLabel}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {testOutcome && !isTesting ? (
            <button
              type="button"
              onClick={onShowTestDetail}
              title="点击查看完整测试结果"
              className={`inline-flex h-8 max-w-[260px] items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors ${
                !testOutcome.ok
                  ? "border-rose-500/35 bg-rose-500/10 text-rose-600 hover:bg-rose-500/15 dark:text-rose-300"
                  : isEmptyWarn
                    ? "border-amber-500/40 bg-amber-500/12 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                    : "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
              }`}
            >
              {!testOutcome.ok ? (
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              ) : isEmptyWarn ? (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Check className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate font-mono text-[11px]">
                {!testOutcome.ok
                  ? testOutcome.error || "失败"
                  : isEmptyWarn
                    ? `空响应 · ${testOutcome.latencyMs}ms${testedTimeStr ? ` · ${testedTimeStr}` : ""}`
                    : `${testOutcome.replyPreview} · ${testOutcome.latencyMs}ms${testedTimeStr ? ` · ${testedTimeStr}` : ""}`}
              </span>
            </button>
          ) : null}

          <button
            type="button"
            disabled={isTesting}
            onClick={onTest}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {isTesting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            <span>{isTesting ? "测试中…" : "测试"}</span>
          </button>

          <button
            type="button"
            onClick={onDuplicate}
            title="在当前供应商下复制此模型"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <Copy className="h-3.5 w-3.5" />
            <span>复制</span>
          </button>

          <div ref={moreRef} className="relative">
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-label="更多模型操作"
              aria-expanded={moreOpen}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-[#131a1f] dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>

            {moreOpen ? (
              <div className="absolute right-0 z-30 mt-1.5 w-44 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-[#131a1f]">
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    onConfigureProvider();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  <span>配置所属供应商</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    onRequestRemove();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>移除此模型</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* 2x2 Basic Info */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`detail-id-${model.uid}`}
            className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            模型 ID <span className="text-rose-500">*</span>
          </label>
          <input
            id={`detail-id-${model.uid}`}
            type="text"
            aria-invalid={Boolean(validation.idError)}
            value={model.id}
            onChange={(e) => onUpdate({ id: e.target.value })}
            placeholder="例如 deepseek-chat"
            className={`h-9 w-full rounded-lg border bg-zinc-50 px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600 ${
              validation.idError
                ? "border-rose-500/70 focus:border-rose-500 dark:border-rose-500/60"
                : "border-zinc-200 focus:border-emerald-500 dark:border-zinc-800"
            }`}
          />
          {validation.idError ? (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              {validation.idError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`detail-name-${model.uid}`}
            className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            显示名称
          </label>
          <input
            id={`detail-name-${model.uid}`}
            type="text"
            value={model.displayName}
            onChange={(e) => onUpdate({ displayName: e.target.value })}
            placeholder="留空默认同模型 ID"
            className="h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`detail-ctx-${model.uid}`}
            className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            上下文窗口（支持 128K / 1M）
          </label>
          <input
            id={`detail-ctx-${model.uid}`}
            type="text"
            disabled={isMetadataLocked}
            aria-invalid={!validation.ctxCheck.ok}
            value={model.advanced.contextWindow}
            onChange={(e) => onUpdateAdvanced({ contextWindow: e.target.value })}
            placeholder="128000 或 128K"
            className={`h-9 w-full rounded-lg border px-3 font-mono text-xs tabular-nums focus:outline-none ${
              isMetadataLocked
                ? "cursor-not-allowed border-zinc-200/70 bg-zinc-100 text-zinc-500 dark:border-zinc-800/60 dark:bg-zinc-900/70 dark:text-zinc-500"
                : !validation.ctxCheck.ok
                  ? "border-rose-500/70 bg-zinc-50 text-zinc-900 focus:border-rose-500 dark:border-rose-500/60 dark:bg-[#090d10] dark:text-zinc-100"
                  : "border-zinc-200 bg-zinc-50 text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100"
            }`}
          />
          {!isMetadataLocked && !validation.ctxCheck.ok ? (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              {validation.ctxCheck.error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`detail-maxout-${model.uid}`}
            className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            最大输出
          </label>
          <input
            id={`detail-maxout-${model.uid}`}
            type="text"
            disabled={isMetadataLocked}
            aria-invalid={!validation.maxOutCheck.ok}
            value={model.advanced.maxOutputTokens}
            onChange={(e) => onUpdateAdvanced({ maxOutputTokens: e.target.value })}
            placeholder="8192 或 8K"
            className={`h-9 w-full rounded-lg border px-3 font-mono text-xs tabular-nums focus:outline-none ${
              isMetadataLocked
                ? "cursor-not-allowed border-zinc-200/70 bg-zinc-100 text-zinc-500 dark:border-zinc-800/60 dark:bg-zinc-900/70 dark:text-zinc-500"
                : !validation.maxOutCheck.ok
                  ? "border-rose-500/70 bg-zinc-50 text-zinc-900 focus:border-rose-500 dark:border-rose-500/60 dark:bg-[#090d10] dark:text-zinc-100"
                  : "border-zinc-200 bg-zinc-50 text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100"
            }`}
          />
          {!isMetadataLocked && !validation.maxOutCheck.ok ? (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              {validation.maxOutCheck.error}
            </p>
          ) : null}
        </div>
      </div>

      {/* Capabilities (unchecked keeps icon, dimmed dashed gray) */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          模型能力
        </span>
        <div className="flex flex-wrap gap-2.5">
          <label
            className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
              isMetadataLocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            } ${
              model.supportsVision
                ? "border-emerald-500/45 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                : "border-dashed border-zinc-300 bg-transparent text-zinc-400 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-zinc-600"
            }`}
          >
            <input
              type="checkbox"
              checked={model.supportsVision}
              disabled={isMetadataLocked}
              onChange={(e) => onUpdate({ supportsVision: e.target.checked })}
              className="accent-emerald-500"
            />
            <Eye className="h-3.5 w-3.5 shrink-0" />
            <span>识图{model.supportsVision ? "" : " · 未支持"}</span>
          </label>

          <label
            className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
              isMetadataLocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            } ${
              model.supportsThinking
                ? "border-sky-500/45 bg-sky-500/12 text-sky-700 dark:text-sky-300"
                : "border-dashed border-zinc-300 bg-transparent text-zinc-400 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-zinc-600"
            }`}
          >
            <input
              type="checkbox"
              checked={model.supportsThinking}
              disabled={isMetadataLocked}
              onChange={(e) => onUpdate({ supportsThinking: e.target.checked })}
              className="accent-sky-500"
            />
            <Brain className="h-3.5 w-3.5 shrink-0" />
            <span>思考{model.supportsThinking ? "" : " · 未支持"}</span>
          </label>
        </div>
      </div>

      {/* Slot Assignment (bidirectional sync with routing table) */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          用于哪些槽位
        </span>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {visibleSlots.map((slot) => {
            const rawTarget = slots[slot.key]?.trim() ?? "";
            const isAssignedHere = Boolean(currentTarget && rawTarget === currentTarget);
            const isOptionalSlot = slot.key === "vision";
            const cannotUncheck = isAssignedHere && !isOptionalSlot;
            const otherHolderLabel =
              rawTarget && !isAssignedHere
                ? slotTargetLabels.get(rawTarget) ?? rawTarget
                : null;

            return (
              <label
                key={slot.key}
                title={
                  cannotUncheck
                    ? "该槽位不能为空，请在其他模型或上方路由表中改绑"
                    : otherHolderLabel
                      ? `勾选后将从 ${otherHolderLabel} 移走`
                      : undefined
                }
                className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                  !currentTarget
                    ? "cursor-not-allowed border-zinc-200/70 opacity-50 dark:border-zinc-800/70"
                    : cannotUncheck
                      ? "cursor-not-allowed border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-[#0b1014]"
                      : isAssignedHere
                        ? "cursor-pointer border-emerald-500/40 bg-emerald-500/8 dark:border-emerald-500/35"
                        : "cursor-pointer border-zinc-200 bg-zinc-50/40 hover:border-zinc-300 dark:border-zinc-800 dark:bg-[#0b1014]/60 dark:hover:border-zinc-700"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isAssignedHere}
                    disabled={!currentTarget || cannotUncheck}
                    onChange={(e) => {
                      if (!currentTarget) return;
                      if (e.target.checked) {
                        onChangeSlot(slot.key, currentTarget);
                      } else if (isOptionalSlot) {
                        onChangeSlot(slot.key, "");
                      }
                    }}
                    className="accent-emerald-500"
                  />
                  <span className={`font-mono font-medium ${slot.accentClass}`}>
                    {slot.key}
                  </span>
                </span>
                <span className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                  {isAssignedHere
                    ? isOptionalSlot
                      ? "取消将回退"
                      : "当前绑定"
                    : otherHolderLabel
                      ? `从 ${otherHolderLabel} 移走`
                      : slot.label}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Collapsible Advanced Settings */}
      <div className="border-t border-zinc-200/80 pt-3.5 dark:border-zinc-800/80">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center justify-between gap-3 rounded-lg py-1 text-left transition-colors hover:text-emerald-600 dark:hover:text-emerald-400"
        >
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
            {advancedOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            <span>高级设置与元数据</span>
          </span>
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {overrideSummaryParts.length > 0
              ? `已启用：${overrideSummaryParts.join(" · ")}`
              : "无覆盖"}
          </span>
        </button>

        <AnimatePresence initial={false}>
          {advancedOpen ? (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, height: 0, overflow: "hidden" }}
              animate={{ opacity: 1, height: "auto", transitionEnd: { overflow: "visible" } }}
              exit={reduceMotion ? undefined : { opacity: 0, height: 0, overflow: "hidden", transition: { duration: 0.14, ease: EASE_OUT } }}
              transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
              className="mt-3.5 flex flex-col gap-4 rounded-lg border border-zinc-200/80 bg-zinc-50/50 p-4 dark:border-zinc-800/80 dark:bg-[#0b1014]/60"
            >
            {/* Protocol / Base URL / Headers */}
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  覆盖协议
                </span>
                <ConsoleSelect
                  value={model.advanced.apiOverride}
                  onValueChange={(next) => onUpdateAdvanced({ apiOverride: next })}
                  options={API_OVERRIDE_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                  }))}
                  triggerClassName="bg-white border-zinc-200 dark:border-zinc-800 dark:bg-[#090d10]"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={`detail-endpoint-${model.uid}`}
                  className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                >
                  覆盖 Base URL
                </label>
                <input
                  id={`detail-endpoint-${model.uid}`}
                  type="text"
                  value={model.advanced.baseUrlOverride}
                  onChange={(e) =>
                    onUpdateAdvanced({ baseUrlOverride: e.target.value })
                  }
                  placeholder={provider.baseUrl || "留空继承供应商 Base URL"}
                  className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor={`detail-headers-${model.uid}`}
                    className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  >
                    自定义请求头（JSON）
                  </label>
                  {model.advanced.customHeaders.trim() ? (
                    <button
                      type="button"
                      onClick={() => setMaskHeaders((v) => !v)}
                      className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                    >
                      {maskHeaders ? (
                        <>
                          <Eye className="h-3 w-3" />
                          <span>显示</span>
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-3 w-3" />
                          <span>掩码</span>
                        </>
                      )}
                    </button>
                  ) : null}
                </div>
                <input
                  id={`detail-headers-${model.uid}`}
                  type={maskHeaders && model.advanced.customHeaders.trim() ? "password" : "text"}
                  aria-invalid={!validation.headersCheck.ok}
                  value={model.advanced.customHeaders}
                  onChange={(e) =>
                    onUpdateAdvanced({ customHeaders: e.target.value })
                  }
                  placeholder='{"X-Custom": "1"}'
                  className={`h-9 w-full rounded-lg border bg-white px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600 ${
                    !validation.headersCheck.ok
                      ? "border-rose-500/70 focus:border-rose-500 dark:border-rose-500/60"
                      : "border-zinc-200 focus:border-emerald-500 dark:border-zinc-800"
                  }`}
                />
                {!validation.headersCheck.ok ? (
                  <p className="text-xs text-rose-600 dark:text-rose-400">
                    {validation.headersCheck.error}
                  </p>
                ) : null}
              </div>
            </div>

            {/* models.dev Mapping */}
            <div className="flex flex-col gap-2 border-t border-zinc-200/70 pt-3.5 sm:flex-row sm:items-end sm:justify-between sm:gap-4 dark:border-zinc-800/70">
              <div ref={suggestionsBoxRef} className="relative flex flex-1 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor={`detail-modelsdev-${model.uid}`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300"
                  >
                    <Link2 className="h-3.5 w-3.5 text-emerald-500" />
                    <span>models.dev 元数据映射</span>
                  </label>
                  {isMetadataLocked ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                      <Lock className="h-3 w-3 shrink-0" />
                      <span>已启用映射，规格只读</span>
                    </span>
                  ) : null}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    id={`detail-modelsdev-${model.uid}`}
                    type="text"
                    value={modelsDev.modelRef}
                    onFocus={() => setShowSuggestions(true)}
                    onChange={(e) => {
                      handleUpdateModelsDev({ modelRef: e.target.value });
                      setModelsDevStatus(null);
                      if (modelsDev.enabled) {
                        setModelRefDirty(true);
                      }
                      setShowSuggestions(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void syncFromModelsDev(modelsDev.modelRef, {
                          enableOnSuccess: true,
                        });
                      } else if (e.key === "Escape") {
                        setShowSuggestions(false);
                      }
                    }}
                    placeholder="输入映射 ID 或关键词搜索（如 openai/gpt-4o）"
                    className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                  />
                  <button
                    type="button"
                    disabled={syncingModelsDev || !modelsDev.modelRef.trim()}
                    onClick={() =>
                      void syncFromModelsDev(modelsDev.modelRef, {
                        enableOnSuccess: true,
                        refresh: true,
                      })
                    }
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 transition hover:border-emerald-500/60 hover:text-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-300 dark:hover:text-emerald-400"
                  >
                    {syncingModelsDev ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    <span>同步</span>
                  </button>
                </div>

                {showSuggestions && modelsDev.modelRef.trim().length > 0 ? (
                  <div className="absolute top-full right-0 left-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-[#0d1216]">
                    {searchingModelsDev ? (
                      <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>搜索 models.dev 中…</span>
                      </div>
                    ) : modelsDevSearchError ? (
                      <div className="px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                        {modelsDevSearchError}
                      </div>
                    ) : suggestions.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                        未找到匹配的 models.dev 模型
                      </div>
                    ) : (
                      suggestions.map((item) => (
                        <button
                          key={item.ref}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            void syncFromModelsDev(item.ref, {
                              enableOnSuccess: true,
                            });
                          }}
                          className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-zinc-100 dark:hover:bg-zinc-800/70"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-[11px] text-zinc-900 dark:text-zinc-100">
                              {item.ref}
                            </div>
                            <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                              {item.name} · {item.providerName}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                            {item.contextWindow ? (
                              <span className="font-mono">
                                {formatTokenCount(String(item.contextWindow))}
                              </span>
                            ) : null}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}

                {modelsDevStatus ? (
                  <p
                    className={`text-xs ${
                      modelsDevStatus.ok
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    {modelsDevStatus.message}
                  </p>
                ) : modelsDev.enabled && modelRefDirty ? (
                  <p className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>映射 ID 已修改，点击「同步」以更新只读规格</span>
                  </p>
                ) : null}
              </div>

              <label className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={modelsDev.enabled}
                  onChange={(e) => handleToggleModelsDev(e.target.checked)}
                  className="accent-emerald-500"
                />
                <span>启用自动同步</span>
              </label>
            </div>
          </motion.div>
        ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
