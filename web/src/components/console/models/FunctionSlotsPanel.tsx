import { AlertTriangle, Brain, ChevronDown, Eye, KeyRound } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import type { ModelsFileConfig, SecretState, SlotThinkingMap, ThinkingLevel } from "@/api";
import { ConsoleSelect } from "@/components/console/ConsolePrimitives";
import { EASE_OUT } from "@/lib/ease";
import {
  filterThinkingLevelOptions,
  getSupportedThinkingLevelsForModel,
  resolveProviderKeyStatus,
  SLOT_DEFINITIONS,
  THINKING_LEVEL_SELECT_OPTIONS,
  type SlotKey,
  type UiModelEntry,
  type UiProviderConfig,
} from "./types";

interface FunctionSlotsPanelProps {
  slots: ModelsFileConfig["slots"];
  slotThinking: SlotThinkingMap;
  providers: UiProviderConfig[];
  secretStates: SecretState[];
  pendingSecrets: Record<string, string>;
  hindsightEnabled?: boolean;
  onChangeSlot: (slotKey: SlotKey, value: string) => void;
  onChangeSlotThinking: (slotKey: SlotKey, value: ThinkingLevel | undefined) => void;
  onConfigureProvider?: (providerUid: string) => void;
}

interface TargetMeta {
  value: string;
  label: string;
  providerLabel: string;
  provider: UiProviderConfig;
  model: UiModelEntry;
  keyMissing: boolean;
}

function SlotStatusBadge({
  isMissing,
  matched,
  visionUnsupported,
  onConfigureProvider,
}: {
  isMissing: boolean;
  matched?: TargetMeta;
  visionUnsupported: boolean;
  onConfigureProvider?: (providerUid: string) => void;
}) {
  if (isMissing) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/35 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-300">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        <span>模型已移除</span>
      </span>
    );
  }
  if (matched?.keyMissing) {
    return (
      <button
        type="button"
        onClick={() => onConfigureProvider?.(matched.provider.uid)}
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
      >
        <KeyRound className="h-3 w-3 shrink-0" />
        <span>缺少密钥</span>
      </button>
    );
  }
  if (visionUnsupported) {
    return (
      <span
        title="当前所选模型未开启「识图」能力"
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        <span>未标识图</span>
      </span>
    );
  }
  if (matched) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span>正常</span>
      </span>
    );
  }
  return <span className="text-zinc-400 dark:text-zinc-500">未指定</span>;
}

export function FunctionSlotsPanel({
  slots,
  slotThinking,
  providers,
  secretStates,
  pendingSecrets,
  hindsightEnabled = false,
  onChangeSlot,
  onChangeSlotThinking,
  onConfigureProvider,
}: FunctionSlotsPanelProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("hato.modelsRoutingCollapsed") === "1";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("hato.modelsRoutingCollapsed", next ? "1" : "0");
      } catch {
        // ignore storage restrictions
      }
      return next;
    });
  };

  const visibleSlots = useMemo(
    () =>
      hindsightEnabled
        ? SLOT_DEFINITIONS
        : SLOT_DEFINITIONS.filter((slot) => slot.key !== "hindsight_llm"),
    [hindsightEnabled],
  );

  const { options, targetMap } = useMemo(() => {
    const map = new Map<string, TargetMeta>();
    const list: TargetMeta[] = [];

    for (const provider of providers) {
      const slug = provider.name.trim();
      if (!slug) continue;
      const providerLabel = provider.displayName?.trim() || slug;
      const keyState = resolveProviderKeyStatus(provider, secretStates, pendingSecrets);
      const keyMissing = keyState.status === "missing";

      for (const model of provider.models) {
        const modelId = model.id.trim();
        if (!modelId) continue;
        const target = `${slug}/${modelId}`;
        const customDisplayName = model.displayName.trim();
        const hasDisplayName = Boolean(customDisplayName && customDisplayName !== modelId);
        const item: TargetMeta = {
          value: target,
          label: hasDisplayName ? customDisplayName : modelId,
          providerLabel,
          provider,
          model,
          keyMissing,
        };
        list.push(item);
        map.set(target, item);
      }
    }

    return { options: list, targetMap: map };
  }, [providers, secretStates, pendingSecrets]);

  return (
    <section
      aria-labelledby="function-slots-heading"
      className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800/90 dark:bg-[#0f1418]"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        className={`flex w-full cursor-pointer items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-zinc-50/70 dark:hover:bg-white/[0.02] ${
          collapsed
            ? "rounded-xl"
            : "rounded-t-xl border-b border-zinc-200/80 dark:border-zinc-800/80"
        }`}
      >
        <h2
          id="function-slots-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
        >
          模型路由表
        </h2>
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 dark:text-zinc-400 ${
            collapsed ? "-rotate-90" : "rotate-0"
          }`}
        />
      </button>

      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            key="routing-table-body"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            {/* Desktop Routing Table */}
            <div className="hidden md:block">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-zinc-200/80 text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-400">
              <th className="px-5 py-2.5 font-medium">槽位</th>
              <th className="px-3 py-2.5 font-medium">用途</th>
              <th className="px-3 py-2.5 font-medium">当前模型</th>
              <th className="px-3 py-2.5 font-medium">思考强度</th>
              <th className="px-3 py-2.5 font-medium">供应商</th>
              <th className="px-3 py-2.5 font-medium">能力</th>
              <th className="px-5 py-2.5 text-right font-medium">状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
            {visibleSlots.map((slot) => {
              const rawValue = slots[slot.key] ?? "";
              const effectiveValue =
                rawValue || (slot.key === "vision" ? slots.persona : "");
              const selectValue =
                slot.key === "vision" && !rawValue ? "__inherit_persona__" : effectiveValue;
              const matched = targetMap.get(effectiveValue);
              const isMissing = effectiveValue.length > 0 && !matched;
              const visionUnsupported =
                slot.key === "vision" && Boolean(matched && !matched.model.supportsVision);
              const personaLabel = targetMap.get(slots.persona ?? "")?.label;

              return (
                <tr
                  key={slot.key}
                  className="transition-colors hover:bg-zinc-50/70 dark:hover:bg-white/[0.02]"
                >
                  <td className="px-5 py-2.5 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${slot.pillClass}`}
                    >
                      {slot.key}
                    </span>
                  </td>

                  <td className="px-3 py-2.5 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {slot.label}
                  </td>

                  <td className="px-3 py-2.5">
                    <div className="w-60">
                      <ConsoleSelect
                        value={selectValue}
                        disabled={options.length === 0 && !isMissing}
                        placeholder="暂无可用模型"
                        onValueChange={(next) =>
                          onChangeSlot(slot.key, next === "__inherit_persona__" ? "" : next)
                        }
                        options={[
                          ...(slot.key === "vision"
                            ? [
                                {
                                  value: "__inherit_persona__",
                                  label: "跟随主对话 (persona)",
                                  hint: personaLabel,
                                },
                              ]
                            : []),
                          ...(isMissing
                            ? [{ value: effectiveValue, label: `${effectiveValue}（未找到）` }]
                            : []),
                          ...options.map((opt) => ({
                            value: opt.value,
                            label: opt.label,
                            hint: opt.providerLabel,
                          })),
                        ]}
                        size="sm"
                        triggerClassName={`bg-zinc-50 dark:bg-[#0b1014] ${
                          isMissing
                            ? "border-rose-500/70 dark:border-rose-500/60"
                            : matched?.keyMissing || visionUnsupported
                              ? "border-amber-500/60 dark:border-amber-500/50"
                              : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                        }`}
                      />
                    </div>
                  </td>

                  <td className="px-3 py-2.5">
                    <div className="w-36">
                      <ConsoleSelect
                        value={matched?.model.supportsThinking ? (slotThinking[slot.key] ?? "__auto__") : "off"}
                        disabled={!matched?.model.supportsThinking}
                        onValueChange={(next) =>
                          onChangeSlotThinking(
                            slot.key,
                            next === "__auto__" ? undefined : (next as ThinkingLevel),
                          )
                        }
                        options={filterThinkingLevelOptions(
                          THINKING_LEVEL_SELECT_OPTIONS,
                          matched
                            ? getSupportedThinkingLevelsForModel(
                                matched.model.supportsThinking,
                                matched.model.preserved?.thinking_level_map,
                              )
                            : undefined,
                        )}
                        size="sm"
                        triggerClassName="bg-zinc-50 dark:bg-[#0b1014]"
                      />
                    </div>
                  </td>

                  <td className="px-3 py-2.5 font-mono whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                    {matched ? matched.providerLabel : "—"}
                  </td>

                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {matched ? (
                      <div className="inline-flex items-center gap-2.5">
                        <span
                          tabIndex={0}
                          title={matched.model.supportsVision ? "支持识图" : "不支持识图"}
                          aria-label={matched.model.supportsVision ? "支持识图" : "不支持识图"}
                          className={`inline-flex items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
                            matched.model.supportsVision
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-zinc-400 opacity-45 dark:text-zinc-500"
                          }`}
                        >
                          <Eye className="h-3.5 w-3.5 shrink-0" />
                          <span>识图</span>
                        </span>
                        <span
                          tabIndex={0}
                          title={matched.model.supportsThinking ? "支持思考" : "不支持思考"}
                          aria-label={matched.model.supportsThinking ? "支持思考" : "不支持思考"}
                          className={`inline-flex items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
                            matched.model.supportsThinking
                              ? "text-sky-600 dark:text-sky-400"
                              : "text-zinc-400 opacity-45 dark:text-zinc-500"
                          }`}
                        >
                          <Brain className="h-3.5 w-3.5 shrink-0" />
                          <span>思考</span>
                        </span>
                      </div>
                    ) : (
                      <span className="text-zinc-400 dark:text-zinc-600">—</span>
                    )}
                  </td>

                  <td className="px-5 py-2.5 text-right whitespace-nowrap">
                    <SlotStatusBadge
                      isMissing={isMissing}
                      matched={matched}
                      visionUnsupported={visionUnsupported}
                      onConfigureProvider={onConfigureProvider}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile Compact Cards */}
      <div className="divide-y divide-zinc-200/70 md:hidden dark:divide-zinc-800/70">
        {visibleSlots.map((slot) => {
          const rawValue = slots[slot.key] ?? "";
          const effectiveValue = rawValue || (slot.key === "vision" ? slots.persona : "");
          const selectValue =
            slot.key === "vision" && !rawValue ? "__inherit_persona__" : effectiveValue;
          const matched = targetMap.get(effectiveValue);
          const isMissing = effectiveValue.length > 0 && !matched;
          const visionUnsupported =
            slot.key === "vision" && Boolean(matched && !matched.model.supportsVision);
          const personaLabel = targetMap.get(slots.persona ?? "")?.label;

          return (
            <div key={slot.key} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${slot.pillClass}`}
                  >
                    {slot.key}
                  </span>
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">
                    {slot.label}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {matched ? (
                    <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      {matched.providerLabel}
                    </span>
                  ) : null}
                  <SlotStatusBadge
                    isMissing={isMissing}
                    matched={matched}
                    visionUnsupported={visionUnsupported}
                    onConfigureProvider={onConfigureProvider}
                  />
                </div>
              </div>

              <ConsoleSelect
                value={selectValue}
                disabled={options.length === 0 && !isMissing}
                placeholder="暂无可用模型"
                onValueChange={(next) =>
                  onChangeSlot(slot.key, next === "__inherit_persona__" ? "" : next)
                }
                options={[
                  ...(slot.key === "vision"
                    ? [
                        {
                          value: "__inherit_persona__",
                          label: "跟随主对话 (persona)",
                          hint: personaLabel,
                        },
                      ]
                    : []),
                  ...(isMissing
                    ? [{ value: effectiveValue, label: `${effectiveValue}（未找到）` }]
                    : []),
                  ...options.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                    hint: opt.providerLabel,
                  })),
                ]}
                size="sm"
              />

              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">思考强度</span>
                <div className="w-36">
                  <ConsoleSelect
                    value={matched?.model.supportsThinking ? (slotThinking[slot.key] ?? "__auto__") : "off"}
                    disabled={!matched?.model.supportsThinking}
                    onValueChange={(next) =>
                      onChangeSlotThinking(
                        slot.key,
                        next === "__auto__" ? undefined : (next as ThinkingLevel),
                      )
                    }
                    options={filterThinkingLevelOptions(
                      THINKING_LEVEL_SELECT_OPTIONS,
                      matched
                        ? getSupportedThinkingLevelsForModel(
                            matched.model.supportsThinking,
                            matched.model.preserved?.thinking_level_map,
                          )
                        : undefined,
                    )}
                    size="sm"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
