import { AlertTriangle, Brain, Eye, KeyRound } from "lucide-react";
import { useMemo } from "react";
import type { ModelsFileConfig, SecretState } from "@/api";
import { ConsoleSelect } from "@/components/console/ConsolePrimitives";
import {
  resolveProviderKeyStatus,
  SLOT_DEFINITIONS,
  type SlotKey,
  type UiModelEntry,
  type UiProviderConfig,
} from "./types";

interface FunctionSlotsPanelProps {
  slots: ModelsFileConfig["slots"];
  providers: UiProviderConfig[];
  secretStates: SecretState[];
  pendingSecrets: Record<string, string>;
  onChangeSlot: (slotKey: SlotKey, value: string) => void;
  onConfigureProvider?: (providerUid: string) => void;
}

interface TargetMeta {
  value: string;
  label: string;
  provider: UiProviderConfig;
  model: UiModelEntry;
  keyMissing: boolean;
}

export function FunctionSlotsPanel({
  slots,
  providers,
  secretStates,
  pendingSecrets,
  onChangeSlot,
  onConfigureProvider,
}: FunctionSlotsPanelProps) {
  const { options, targetMap } = useMemo(() => {
    const map = new Map<string, TargetMeta>();
    const list: TargetMeta[] = [];

    for (const provider of providers) {
      const slug = provider.name.trim();
      if (!slug) continue;
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
          label: hasDisplayName ? customDisplayName : target,
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
      className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800/90 dark:bg-[#0f1418]"
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2
          id="function-slots-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
        >
          功能槽位
        </h2>
        <span className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
          {SLOT_DEFINITIONS.length} 个运行时路由槽位
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {SLOT_DEFINITIONS.map((slot) => {
          const currentValue = slots[slot.key] ?? (slot.key === "vision" ? slots.persona : "");
          const matched = targetMap.get(currentValue);
          const isMissing = currentValue.length > 0 && !matched;

          return (
            <div key={slot.key} className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-xs whitespace-nowrap">
                <span className={`font-mono font-medium ${slot.accentClass}`}>
                  {slot.key}
                </span>
                <span className="text-zinc-400 dark:text-zinc-600" aria-hidden="true">
                  ·
                </span>
                <span className="truncate text-zinc-600 dark:text-zinc-400">
                  {slot.label}
                </span>
              </div>

              <ConsoleSelect
                value={currentValue}
                disabled={options.length === 0 && !isMissing}
                placeholder="暂无可用模型"
                onValueChange={(next) => onChangeSlot(slot.key, next)}
                options={[
                  ...(isMissing
                    ? [{ value: currentValue, label: `${currentValue}（未找到）` }]
                    : []),
                  ...options.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                  })),
                ]}
                triggerClassName={`h-10 font-mono bg-zinc-50 dark:bg-[#0b1014] ${
                  isMissing
                    ? "border-rose-500/70 dark:border-rose-500/60"
                    : matched?.keyMissing
                      ? "border-amber-500/60 dark:border-amber-500/50"
                      : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                }`}
              />

              {isMissing ? (
                <p className="flex items-center gap-1 text-[11px] text-rose-600 dark:text-rose-400">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  <span>所选模型已移除，请重新指定</span>
                </p>
              ) : matched?.keyMissing ? (
                <button
                  type="button"
                  onClick={() => onConfigureProvider?.(matched.provider.uid)}
                  className="inline-flex items-center gap-1 text-left text-[11px] text-amber-600 transition-colors hover:text-amber-500 dark:text-amber-400 dark:hover:text-amber-300"
                >
                  <KeyRound className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    缺少 {matched.provider.apiKeyEnv || "API Key"}，点击配置
                  </span>
                </button>
              ) : matched ? (
                <div className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-500">
                  <span className="truncate font-mono">
                    {matched.provider.displayName?.trim() || matched.provider.name}
                  </span>
                  {(matched.model.supportsVision || matched.model.supportsThinking) && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-zinc-400 dark:text-zinc-500">
                      {matched.model.supportsVision ? (
                        <Eye className="h-3 w-3 text-emerald-500/80" aria-label="支持识图" />
                      ) : null}
                      {matched.model.supportsThinking ? (
                        <Brain className="h-3 w-3 text-violet-500/80" aria-label="支持思考" />
                      ) : null}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
