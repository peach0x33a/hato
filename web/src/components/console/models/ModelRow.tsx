import { type ComponentType, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Link2,
  Loader2,
  Lock,
  Send,
  Trash2,
} from "lucide-react";
import { ConsoleSelect } from "@/components/console/ConsolePrimitives";
import {
  API_OVERRIDE_OPTIONS,
  formatTokenCount,
  parseHeadersJson,
  SLOT_DEFINITIONS,
  type SlotKey,
  type UiModelEntry,
  validatePositiveIntInput,
} from "./types";

export interface ModelTestOutcome {
  ok: boolean;
  latencyMs: number;
  replyPreview?: string;
  error?: string;
}

interface ModelRowProps {
  model: UiModelEntry;
  providerBaseUrl: string;
  boundSlots: SlotKey[];
  isDuplicateId: boolean;
  autoFocusId?: boolean;
  isExpanded: boolean;
  isTesting?: boolean;
  testOutcome?: ModelTestOutcome;
  onToggleExpand: () => void;
  onTest: () => void;
  onUpdate: (patch: Partial<UiModelEntry>) => void;
  onUpdateAdvanced: (patch: Partial<UiModelEntry["advanced"]>) => void;
  onRemove: () => void;
}

interface ToggleSwitchProps {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

function ToggleSwitch({
  id,
  label,
  checked,
  disabled = false,
  onChange,
}: ToggleSwitchProps) {
  return (
    <div
      className={`flex shrink-0 items-center gap-2 whitespace-nowrap ${
        disabled ? "opacity-55" : ""
      }`}
    >
      <label
        htmlFor={id}
        className={`text-xs font-medium text-zinc-600 dark:text-zinc-400 ${
          disabled ? "cursor-not-allowed" : "cursor-pointer"
        }`}
      >
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
          disabled ? "cursor-not-allowed" : "cursor-pointer"
        } ${
          checked
            ? "border-emerald-500 bg-emerald-500"
            : "border-zinc-300 bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800"
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${
            checked ? "translate-x-[22px]" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

interface CapabilityButtonProps {
  label: string;
  icon: ComponentType<{ className?: string }>;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

function CapabilityButton({
  label,
  icon: Icon,
  selected,
  disabled = false,
  onToggle,
}: CapabilityButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onToggle();
      }}
      className={`inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"
      } ${
        selected
          ? "border-emerald-500/60 bg-emerald-500/12 text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300"
          : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
    </button>
  );
}

const SLOT_PILL_MAP = new Map(SLOT_DEFINITIONS.map((s) => [s.key, s.pillClass]));

export function ModelRow({
  model,
  providerBaseUrl,
  boundSlots,
  isDuplicateId,
  autoFocusId = false,
  isExpanded,
  isTesting = false,
  testOutcome,
  onToggleExpand,
  onTest,
  onUpdate,
  onUpdateAdvanced,
  onRemove,
}: ModelRowProps) {
  const prefersReducedMotion = useReducedMotion();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    if (!confirmingRemove) return;
    const timer = window.setTimeout(() => setConfirmingRemove(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmingRemove]);

  const titleText = model.displayName.trim() || model.id.trim() || "未命名模型";
  const modelsDev = model.modelsDev ?? { enabled: false, modelRef: "" };
  const isMetadataLocked = modelsDev.enabled;

  const trimmedId = model.id.trim();
  const idError = !trimmedId
    ? "请填写模型 ID"
    : /\s/.test(trimmedId)
      ? "模型 ID 不能包含空白字符"
      : isDuplicateId
        ? "当前供应商下模型 ID 重复"
        : null;

  const ctxCheck = validatePositiveIntInput(model.advanced.contextWindow, "上下文窗口");
  const maxOutCheck = validatePositiveIntInput(model.advanced.maxOutputTokens, "最大输出");
  const headersCheck = parseHeadersJson(model.advanced.customHeaders, "自定义请求头");
  const hasRowError = Boolean(
    idError || !ctxCheck.ok || !maxOutCheck.ok || !headersCheck.ok,
  );

  const hasOverrides =
    (model.advanced.apiOverride && model.advanced.apiOverride !== "__inherit__") ||
    model.advanced.baseUrlOverride.trim().length > 0 ||
    model.advanced.customHeaders.trim().length > 0;
  const ctxCompact = formatTokenCount(model.advanced.contextWindow);

  const handleUpdateModelsDev = (patch: Partial<UiModelEntry["modelsDev"]>) => {
    onUpdate({
      modelsDev: {
        ...modelsDev,
        ...patch,
      },
    });
  };

  const handleRemoveClick = () => {
    if (boundSlots.length > 0 && !confirmingRemove) {
      setConfirmingRemove(true);
      return;
    }
    setConfirmingRemove(false);
    onRemove();
  };

  return (
    <div className="py-2 first:pt-1 last:pb-1">
      {/* Compact Collapsed Summary Header */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 text-left transition-colors hover:text-emerald-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:hover:text-emerald-400"
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          )}

          <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {titleText}
          </span>

          {hasRowError ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400"
              title="该模型存在未修复的配置校验错误"
            >
              <AlertCircle className="h-2.5 w-2.5" />
              <span>待修正</span>
            </span>
          ) : null}

          {/* Bound runtime slot pills */}
          {boundSlots.length > 0 ? (
            <span className="hidden items-center gap-1 md:inline-flex">
              {boundSlots.map((slotKey) => (
                <span
                  key={slotKey}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none ${
                    SLOT_PILL_MAP.get(slotKey) ?? ""
                  }`}
                >
                  {slotKey}
                </span>
              ))}
            </span>
          ) : null}

          {/* Subtle metadata badges */}
          <span className="hidden items-center gap-1.5 text-[11px] text-zinc-400 lg:inline-flex dark:text-zinc-500">
            {ctxCompact ? (
              <span className="font-mono tabular-nums">{ctxCompact}</span>
            ) : null}
            {model.supportsVision ? (
              <Eye className="h-3 w-3 text-emerald-500/80" aria-label="支持识图" />
            ) : null}
            {model.supportsThinking ? (
              <Brain className="h-3 w-3 text-violet-500/80" aria-label="支持思考" />
            ) : null}
            {hasOverrides ? (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400">
                已覆盖参数
              </span>
            ) : null}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {testOutcome && !isTesting ? (
            <span
              title={
                testOutcome.ok
                  ? `回复: ${testOutcome.replyPreview ?? "hello"} (${testOutcome.latencyMs}ms)`
                  : testOutcome.error
              }
              className={`hidden max-w-[200px] items-center gap-1 truncate rounded-md border px-2 py-0.5 font-mono text-[11px] sm:inline-flex ${
                testOutcome.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300"
              }`}
            >
              {testOutcome.ok ? (
                <>
                  <Check className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {testOutcome.replyPreview || "ok"} · {testOutcome.latencyMs}ms
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  <span className="truncate">{testOutcome.error || "失败"}</span>
                </>
              )}
            </span>
          ) : null}

          <button
            type="button"
            disabled={isTesting}
            onClick={onTest}
            title="发送问好测试（让 AI 回复 hello）"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-600 whitespace-nowrap transition-colors hover:bg-zinc-100 hover:text-emerald-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-emerald-400"
          >
            {isTesting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>测试中…</span>
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                <span>测试</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleRemoveClick}
            className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 ${
              confirmingRemove
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-300"
                : "text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>
              {confirmingRemove ? `已绑 ${boundSlots.length} 槽位 · 确认移除?` : "移除"}
            </span>
          </button>
        </div>
      </div>

      {/* Expanded Editable Details */}
      <AnimatePresence initial={false}>
        {isExpanded ? (
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0, height: 0, overflow: "hidden" }}
            animate={{ opacity: 1, height: "auto", transitionEnd: { overflow: "visible" } }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, height: 0, overflow: "hidden" }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            style={prefersReducedMotion ? undefined : { overflow: "hidden" }}
          >
            <div className="mt-2.5 mb-2 flex flex-col gap-4 rounded-lg border border-zinc-200/80 bg-zinc-50/50 p-4 dark:border-zinc-800/80 dark:bg-[#0b1014]/50">
              {/* Section 1: Model ID & Display Name */}
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`model-id-${model.uid}`}
                    className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  >
                    模型 ID <span className="text-rose-500">*</span>
                  </label>
                  <input
                    id={`model-id-${model.uid}`}
                    type="text"
                    autoFocus={autoFocusId}
                    aria-invalid={Boolean(idError)}
                    value={model.id}
                    onChange={(e) => onUpdate({ id: e.target.value })}
                    placeholder="例如 deepseek-flash"
                    className={`h-9 w-full rounded-lg border bg-white px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600 ${
                      idError
                        ? "border-rose-500/70 focus:border-rose-500 dark:border-rose-500/60"
                        : "border-zinc-200 focus:border-emerald-500 dark:border-zinc-800"
                    }`}
                  />
                  {idError ? (
                    <p className="text-[11px] text-rose-600 dark:text-rose-400">
                      {idError}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`model-name-${model.uid}`}
                    className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  >
                    显示名称
                  </label>
                  <input
                    id={`model-name-${model.uid}`}
                    type="text"
                    value={model.displayName}
                    onChange={(e) => onUpdate({ displayName: e.target.value })}
                    placeholder="例如 Deepseek 4 Flash（留空默认同模型 ID）"
                    className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                  />
                </div>
              </div>

              {/* Section 2: Metadata (models.dev mapping + merged Capabilities, Context Window & Max Output) */}
              <div className="flex flex-col gap-3.5 border-t border-zinc-200/80 pt-3.5 dark:border-zinc-800/80">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor={`modelsdev-ref-${model.uid}`}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300"
                      >
                        <Link2 className="h-3.5 w-3.5 text-emerald-500" />
                        <span>models.dev 元数据映射</span>
                        <span className="rounded bg-zinc-200/70 px-1.5 py-0.5 text-[10px] font-normal text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          预留
                        </span>
                      </label>
                      {isMetadataLocked ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                          <Lock className="h-3 w-3 shrink-0" />
                          <span>已启用映射，以下规格只读</span>
                        </span>
                      ) : null}
                    </div>

                    <input
                      id={`modelsdev-ref-${model.uid}`}
                      type="text"
                      value={modelsDev.modelRef}
                      onChange={(e) =>
                        handleUpdateModelsDev({ modelRef: e.target.value })
                      }
                      placeholder="预留映射 ID（如 deepseek/deepseek-chat）"
                      className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                    />
                  </div>

                  <div className="flex h-9 shrink-0 items-center">
                    <ToggleSwitch
                      id={`modelsdev-enable-${model.uid}`}
                      label="启用 models.dev 映射"
                      checked={modelsDev.enabled}
                      onChange={(next) => handleUpdateModelsDev({ enabled: next })}
                    />
                  </div>
                </div>

                {/* Merged Capabilities + Context Window + Max Output */}
                <div className="grid grid-cols-1 items-start gap-3.5 md:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      模型能力
                    </span>
                    <div className="flex items-center gap-2">
                      <CapabilityButton
                        label="识图"
                        icon={Eye}
                        selected={model.supportsVision}
                        disabled={isMetadataLocked}
                        onToggle={() =>
                          onUpdate({ supportsVision: !model.supportsVision })
                        }
                      />
                      <CapabilityButton
                        label="思考"
                        icon={Brain}
                        selected={model.supportsThinking}
                        disabled={isMetadataLocked}
                        onToggle={() =>
                          onUpdate({ supportsThinking: !model.supportsThinking })
                        }
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor={`ctx-${model.uid}`}
                      className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                    >
                      上下文窗口（Tokens）
                    </label>
                    <input
                      id={`ctx-${model.uid}`}
                      type="text"
                      inputMode="numeric"
                      disabled={isMetadataLocked}
                      aria-invalid={!ctxCheck.ok}
                      value={model.advanced.contextWindow}
                      onChange={(e) =>
                        onUpdateAdvanced({ contextWindow: e.target.value })
                      }
                      placeholder="128000"
                      className={`h-9 w-full rounded-lg border px-3 font-mono text-xs tabular-nums focus:outline-none ${
                        isMetadataLocked
                          ? "cursor-not-allowed border-zinc-200/70 bg-zinc-100 text-zinc-500 dark:border-zinc-800/60 dark:bg-zinc-900/70 dark:text-zinc-500"
                          : !ctxCheck.ok
                            ? "border-rose-500/70 bg-white text-zinc-900 focus:border-rose-500 dark:border-rose-500/60 dark:bg-[#090d10] dark:text-zinc-100"
                            : "border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100"
                      }`}
                    />
                    {!isMetadataLocked && !ctxCheck.ok ? (
                      <p className="text-[11px] text-rose-600 dark:text-rose-400">
                        {ctxCheck.error}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor={`max-out-${model.uid}`}
                      className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                    >
                      最大输出（Tokens）
                    </label>
                    <input
                      id={`max-out-${model.uid}`}
                      type="text"
                      inputMode="numeric"
                      disabled={isMetadataLocked}
                      aria-invalid={!maxOutCheck.ok}
                      value={model.advanced.maxOutputTokens}
                      onChange={(e) =>
                        onUpdateAdvanced({ maxOutputTokens: e.target.value })
                      }
                      placeholder="8192"
                      className={`h-9 w-full rounded-lg border px-3 font-mono text-xs tabular-nums focus:outline-none ${
                        isMetadataLocked
                          ? "cursor-not-allowed border-zinc-200/70 bg-zinc-100 text-zinc-500 dark:border-zinc-800/60 dark:bg-zinc-900/70 dark:text-zinc-500"
                          : !maxOutCheck.ok
                            ? "border-rose-500/70 bg-white text-zinc-900 focus:border-rose-500 dark:border-rose-500/60 dark:bg-[#090d10] dark:text-zinc-100"
                            : "border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100"
                      }`}
                    />
                    {!isMetadataLocked && !maxOutCheck.ok ? (
                      <p className="text-[11px] text-rose-600 dark:text-rose-400">
                        {maxOutCheck.error}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Section 3: Protocol Override, Base URL Override & Custom Headers */}
              <div className="grid grid-cols-1 gap-3.5 border-t border-zinc-200/80 pt-3.5 md:grid-cols-3 dark:border-zinc-800/80">
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
                    htmlFor={`endpoint-${model.uid}`}
                    className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  >
                    覆盖 Base URL
                  </label>
                  <input
                    id={`endpoint-${model.uid}`}
                    type="text"
                    value={model.advanced.baseUrlOverride}
                    onChange={(e) =>
                      onUpdateAdvanced({ baseUrlOverride: e.target.value })
                    }
                    placeholder={providerBaseUrl || "留空继承供应商 Base URL"}
                    className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`headers-${model.uid}`}
                    className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  >
                    自定义请求头（JSON）
                  </label>
                  <input
                    id={`headers-${model.uid}`}
                    type="text"
                    aria-invalid={!headersCheck.ok}
                    value={model.advanced.customHeaders}
                    onChange={(e) =>
                      onUpdateAdvanced({ customHeaders: e.target.value })
                    }
                    placeholder='{"X-Custom": "1"}'
                    className={`h-9 w-full rounded-lg border bg-white px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600 ${
                      !headersCheck.ok
                        ? "border-rose-500/70 focus:border-rose-500 dark:border-rose-500/60"
                        : "border-zinc-200 focus:border-emerald-500 dark:border-zinc-800"
                    }`}
                  />
                  {!headersCheck.ok ? (
                    <p className="text-[11px] text-rose-600 dark:text-rose-400">
                      {headersCheck.error}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
