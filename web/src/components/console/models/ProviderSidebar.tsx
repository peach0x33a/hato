import { useMemo, useState } from "react";
import { Plus, Route, Search, X } from "lucide-react";
import type { ModelsFileConfig, SecretState } from "@/api";
import {
  resolveProviderKeyStatus,
  SLOT_DEFINITIONS,
  type UiProviderConfig,
} from "./types";

interface ProviderSidebarProps {
  providers: UiProviderConfig[];
  slots: ModelsFileConfig["slots"];
  hindsightEnabled?: boolean;
  secretStates: SecretState[];
  pendingSecrets: Record<string, string>;
  activePane: "slots" | string;
  onSelectPane: (pane: "slots" | string) => void;
  onAddProvider: () => void;
}

const BADGE_PALETTES = [
  "bg-sky-500/15 text-sky-600 border-sky-500/25 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-600 border-emerald-500/25 dark:text-emerald-300",
  "bg-violet-500/15 text-violet-600 border-violet-500/25 dark:text-violet-300",
  "bg-amber-500/15 text-amber-600 border-amber-500/25 dark:text-amber-300",
  "bg-rose-500/15 text-rose-600 border-rose-500/25 dark:text-rose-300",
  "bg-cyan-500/15 text-cyan-600 border-cyan-500/25 dark:text-cyan-300",
];

function getProviderBadgeClass(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return BADGE_PALETTES[hash % BADGE_PALETTES.length]!;
}

export function ProviderSidebar({
  providers,
  slots,
  hindsightEnabled = false,
  secretStates,
  pendingSecrets,
  activePane,
  onSelectPane,
  onAddProvider,
}: ProviderSidebarProps) {
  const [query, setQuery] = useState("");

  const slotHealth = useMemo(() => {
    const visibleSlots = hindsightEnabled
      ? SLOT_DEFINITIONS
      : SLOT_DEFINITIONS.filter((s) => s.key !== "hindsight_llm");

    const modelTargets = new Map<string, { provider: UiProviderConfig }>();
    for (const p of providers) {
      const slug = p.name.trim();
      if (!slug) continue;
      for (const m of p.models) {
        const mid = m.id.trim();
        if (!mid) continue;
        modelTargets.set(`${slug}/${mid}`, { provider: p });
      }
    }

    let boundCount = 0;
    let hasWarning = false;
    for (const def of visibleSlots) {
      const target = slots[def.key]?.trim() ?? "";
      if (!target) {
        hasWarning = true;
        continue;
      }
      const match = modelTargets.get(target);
      if (!match) {
        hasWarning = true;
        continue;
      }
      boundCount += 1;
      const keyStatus = resolveProviderKeyStatus(match.provider, secretStates, pendingSecrets);
      if (keyStatus.status === "missing") {
        hasWarning = true;
      }
    }

    return {
      total: visibleSlots.length,
      boundCount,
      hasWarning,
    };
  }, [providers, slots, hindsightEnabled, secretStates, pendingSecrets]);

  const filteredProviders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) => {
      const label = (p.displayName || p.name).toLowerCase();
      return (
        label.includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.protocol.toLowerCase().includes(q)
      );
    });
  }, [providers, query]);

  return (
    <aside className="flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-[#10161b]">
      {/* Pinned Top: Default Model / Routing Table (Option A) */}
      <div className="p-2">
        <button
          type="button"
          onClick={() => onSelectPane("slots")}
          className={`flex w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors ${
            activePane === "slots"
              ? "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
              : "text-zinc-700 hover:bg-zinc-100/80 dark:text-zinc-200 dark:hover:bg-zinc-800/60"
          }`}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-xs ${
                activePane === "slots"
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                  : "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
              }`}
            >
              <Route className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">默认模型</div>
              <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                功能槽位路由表
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
              {slotHealth.boundCount}/{slotHealth.total}
            </span>
            <span
              className={`h-2 w-2 rounded-full ${
                slotHealth.hasWarning ? "bg-amber-500" : "bg-emerald-500"
              }`}
            />
          </div>
        </button>
      </div>

      <div className="border-t border-zinc-200/80 px-2.5 py-2 dark:border-zinc-800/80">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型平台..."
            className="h-8 w-full rounded-lg border border-zinc-200 bg-zinc-50/80 pl-8 pr-7 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500/60 focus:bg-white focus:outline-none dark:border-zinc-800 dark:bg-[#0b1014] dark:text-zinc-100 dark:focus:bg-[#0d1216]"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Provider List */}
      <div className="max-h-[420px] flex-1 space-y-0.5 overflow-y-auto px-2 pb-2 lg:max-h-[calc(100vh-300px)]">
        {filteredProviders.length === 0 ? (
          <div className="py-6 text-center text-xs text-zinc-400">
            {providers.length === 0 ? "暂无服务商" : "无匹配服务商"}
          </div>
        ) : (
          filteredProviders.map((provider) => {
            const label = provider.displayName?.trim() || provider.name;
            const monogram = (label.trim().slice(0, 1) || "?").toUpperCase();
            const keyInfo = resolveProviderKeyStatus(provider, secretStates, pendingSecrets);
            const isSelected = activePane === provider.uid;

            return (
              <button
                key={provider.uid}
                type="button"
                onClick={() => onSelectPane(provider.uid)}
                className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition-colors ${
                  isSelected
                    ? "bg-zinc-900/5 text-zinc-950 dark:bg-white/10 dark:text-white"
                    : "text-zinc-700 hover:bg-zinc-100/70 dark:text-zinc-300 dark:hover:bg-zinc-800/50"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-[11px] font-semibold ${getProviderBadgeClass(
                      provider.name,
                    )}`}
                  >
                    {monogram}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{label}</div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="font-mono text-[10px] tabular-nums text-zinc-400">
                    {provider.models.length}
                  </span>
                  <span
                    title={
                      keyInfo.status === "configured" || keyInfo.status === "not-needed"
                        ? "密钥就绪"
                        : keyInfo.status === "pending"
                          ? "密钥待保存"
                          : "未配置密钥"
                    }
                    className={`h-2 w-2 rounded-full ${
                      keyInfo.status === "configured" || keyInfo.status === "not-needed"
                        ? "bg-emerald-500"
                        : "bg-amber-500"
                    }`}
                  />
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Footer: + 添加服务商 */}
      <div className="border-t border-zinc-200/80 p-2 dark:border-zinc-800/80">
        <button
          type="button"
          onClick={onAddProvider}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50/70 text-xs font-medium text-zinc-700 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5 hover:text-emerald-700 dark:border-zinc-800 dark:bg-[#0d1216] dark:text-zinc-200 dark:hover:text-emerald-300"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>添加服务商</span>
        </button>
      </div>
    </aside>
  );
}
