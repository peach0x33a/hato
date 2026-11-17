import {
  Bookmark,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Search,
  ServerOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ModelsFileConfig, type SecretState } from "@/api";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { FunctionSlotsPanel } from "./models/FunctionSlotsPanel";
import type { ModelTestOutcome } from "./models/ModelRow";
import { ProviderCard } from "./models/ProviderCard";
import { ProviderDrawer } from "./models/ProviderDrawer";
import {
  buildApiModelsConfig,
  createUid,
  generateUniqueModelId,
  parseHeadersJson,
  serializeComparableState,
  SLOT_DEFINITIONS,
  toUiProviders,
  type ProviderDraft,
  type SlotKey,
  type UiModelEntry,
  type UiProviderConfig,
} from "./models/types";

const PROVIDER_DRAFT_STORAGE_KEY = "hato-provider-draft-v1";

type DrawerState =
  | { open: false }
  | { open: true; mode: "create" }
  | { open: true; mode: "edit"; providerUid: string };

export interface ModelsConfigPanelProps {
  initialConfig: ModelsFileConfig;
  secretStates?: SecretState[];
  onSaved: (next: ModelsFileConfig, changes?: string[]) => void;
  onSecretsUpdated?: (nextStates: SecretState[]) => void;
  onToast: (input: {
    title: string;
    description?: string;
    status?: "info" | "success" | "error";
  }) => void;
}

function readStoredProviderDraft(): ProviderDraft | null {
  try {
    const raw = window.localStorage.getItem(PROVIDER_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProviderDraft;
    if (parsed && typeof parsed.name === "string") {
      return parsed;
    }
  } catch {
    // Ignore malformed storage
  }
  return null;
}

export function ModelsConfigPanel({
  initialConfig,
  secretStates = [],
  onSaved,
  onSecretsUpdated,
  onToast,
}: ModelsConfigPanelProps) {
  const [slots, setSlots] = useState<ModelsFileConfig["slots"]>(() => ({
    ...initialConfig.slots,
  }));
  const [providers, setProviders] = useState<UiProviderConfig[]>(() =>
    toUiProviders(initialConfig),
  );
  const [savedComparable, setSavedComparable] = useState<string>(() =>
    serializeComparableState(initialConfig.slots, toUiProviders(initialConfig)),
  );
  const [pendingSecrets, setPendingSecrets] = useState<Record<string, string>>({});
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(() =>
    readStoredProviderDraft(),
  );
  const [drawerState, setDrawerState] = useState<DrawerState>({ open: false });
  const [collapsedProviderIds, setCollapsedProviderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedModelIds, setExpandedModelIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [newlyAddedModelUid, setNewlyAddedModelUid] = useState<string | null>(null);
  const [testingModelIds, setTestingModelIds] = useState<Set<string>>(() => new Set());
  const [testOutcomes, setTestOutcomes] = useState<Record<string, ModelTestOutcome>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [savePhase, setSavePhase] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    const nextSlots = { ...initialConfig.slots };
    const nextProviders = toUiProviders(initialConfig);
    setSlots(nextSlots);
    setProviders(nextProviders);
    setSavedComparable(serializeComparableState(nextSlots, nextProviders));
    setNewlyAddedModelUid(null);
  }, [initialConfig]);

  const isDirty = useMemo(() => {
    if (Object.keys(pendingSecrets).length > 0) return true;
    return serializeComparableState(slots, providers) !== savedComparable;
  }, [slots, providers, savedComparable, pendingSecrets]);

  const slotIndex = useMemo(() => {
    const byTarget = new Map<string, SlotKey[]>();
    const byProvider = new Map<string, SlotKey[]>();

    for (const def of SLOT_DEFINITIONS) {
      const target = slots[def.key]?.trim();
      if (!target) continue;
      const existing = byTarget.get(target) ?? [];
      existing.push(def.key);
      byTarget.set(target, existing);

      const slashIdx = target.indexOf("/");
      if (slashIdx > 0) {
        const slug = target.slice(0, slashIdx);
        const provList = byProvider.get(slug) ?? [];
        provList.push(def.key);
        byProvider.set(slug, provList);
      }
    }

    return { byTarget, byProvider };
  }, [slots]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const isSearchActive = normalizedSearch.length > 0;

  const filteredProviderEntries = useMemo(() => {
    if (!isSearchActive) {
      return providers.map((provider) => ({
        provider,
        visibleModels: provider.models,
      }));
    }

    return providers
      .map((provider) => {
        const providerMatches =
          provider.name.toLowerCase().includes(normalizedSearch) ||
          (provider.displayName ?? "").toLowerCase().includes(normalizedSearch) ||
          provider.protocol.toLowerCase().includes(normalizedSearch);
        if (providerMatches) {
          return { provider, visibleModels: provider.models };
        }
        const matchedModels = provider.models.filter(
          (m) =>
            m.id.toLowerCase().includes(normalizedSearch) ||
            m.displayName.toLowerCase().includes(normalizedSearch),
        );
        if (matchedModels.length === 0) return null;
        return { provider, visibleModels: matchedModels };
      })
      .filter((entry): entry is { provider: UiProviderConfig; visibleModels: UiModelEntry[] } =>
        Boolean(entry),
      );
  }, [providers, isSearchActive, normalizedSearch]);

  const allCollapsed =
    providers.length > 0 &&
    providers.every((p) => collapsedProviderIds.has(p.uid));

  const editingProvider =
    drawerState.open && drawerState.mode === "edit"
      ? providers.find((p) => p.uid === drawerState.providerUid) ?? null
      : null;

  const handleResetChanges = () => {
    const nextSlots = { ...initialConfig.slots };
    const nextProviders = toUiProviders(initialConfig);
    setSlots(nextSlots);
    setProviders(nextProviders);
    setPendingSecrets({});
    setSavedComparable(serializeComparableState(nextSlots, nextProviders));
    setNewlyAddedModelUid(null);
    onToast({ title: "已还原未保存更改", status: "info" });
  };

  const handleToggleAllProviders = () => {
    if (allCollapsed) {
      setCollapsedProviderIds(new Set());
    } else {
      setCollapsedProviderIds(new Set(providers.map((p) => p.uid)));
    }
  };

  const handleToggleProviderCollapse = (uid: string) => {
    setCollapsedProviderIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  };

  const handleToggleModelExpand = (modelUid: string) => {
    setExpandedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelUid)) {
        next.delete(modelUid);
      } else {
        next.add(modelUid);
      }
      return next;
    });
  };

  const handleChangeSlot = (slotKey: SlotKey, value: string) => {
    setSlots((prev) => ({ ...prev, [slotKey]: value }));
  };

  const handleSaveProviderDraft = (draft: ProviderDraft) => {
    try {
      window.localStorage.setItem(PROVIDER_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Safe fallback in restricted environments
    }
    setProviderDraft(draft);
    setDrawerState({ open: false });
    onToast({ title: "供应商草稿已保存", status: "info" });
  };

  const handleDiscardProviderDraft = () => {
    try {
      window.localStorage.removeItem(PROVIDER_DRAFT_STORAGE_KEY);
    } catch {
      // Safe fallback
    }
    setProviderDraft(null);
    onToast({ title: "已清空供应商草稿", status: "info" });
  };

  const handleCreateProviderFromDrawer = (draft: ProviderDraft) => {
    const providerUid = createUid("prov");
    const models: UiModelEntry[] = draft.includeInitialModel
      ? [
          {
            uid: createUid("mod"),
            id: draft.initialModelId,
            displayName: draft.initialModelName || draft.initialModelId,
            supportsVision: draft.initialModelVision,
            supportsThinking: draft.initialModelThinking,
            modelsDev: {
              enabled: false,
              modelRef: "",
            },
            advanced: {
              contextWindow: "128000",
              maxOutputTokens: "8192",
              apiOverride: "__inherit__",
              baseUrlOverride: "",
              customHeaders: "",
            },
          },
        ]
      : [];

    const newProvider: UiProviderConfig = {
      uid: providerUid,
      name: draft.name,
      displayName: draft.displayName,
      protocol: draft.protocol,
      baseUrl: draft.baseUrl,
      apiKeyEnv: draft.apiKeyEnv,
      cacheTtlMinutes: draft.cacheTtlMinutes,
      customHeaders: draft.customHeaders,
      models,
    };

    setProviders((prev) => [...prev, newProvider]);

    if (draft.apiKeyValue && draft.apiKeyEnv) {
      setPendingSecrets((prev) => ({
        ...prev,
        [draft.apiKeyEnv]: draft.apiKeyValue,
      }));
    }

    try {
      window.localStorage.removeItem(PROVIDER_DRAFT_STORAGE_KEY);
    } catch {
      // Safe fallback
    }
    setProviderDraft(null);
    setDrawerState({ open: false });
    onToast({
      title: `已添加供应商 ${draft.name}`,
      description: "请点击右上角「保存模型配置」使配置生效",
      status: "info",
    });
  };

  const handleUpdateProviderSettings = (
    uid: string,
    patch: {
      name: string;
      displayName: string;
      protocol: string;
      baseUrl: string;
      apiKeyEnv: string;
      apiKeyValue: string;
      cacheTtlMinutes: string;
      customHeaders: string;
    },
  ) => {
    const existing = providers.find((p) => p.uid === uid);
    const oldName = existing?.name;

    setProviders((prev) =>
      prev.map((p) =>
        p.uid === uid
          ? {
              ...p,
              name: patch.name,
              displayName: patch.displayName,
              protocol: patch.protocol,
              baseUrl: patch.baseUrl,
              apiKeyEnv: patch.apiKeyEnv,
              cacheTtlMinutes: patch.cacheTtlMinutes,
              customHeaders: patch.customHeaders,
            }
          : p,
      ),
    );

    if (oldName && oldName !== patch.name) {
      const prefix = `${oldName}/`;
      setSlots((prev) => {
        const nextSlots = { ...prev };
        (Object.keys(nextSlots) as SlotKey[]).forEach((key) => {
          if (nextSlots[key].startsWith(prefix)) {
            nextSlots[key] = `${patch.name}/${nextSlots[key].slice(prefix.length)}`;
          }
        });
        return nextSlots;
      });
    }

    if (patch.apiKeyValue && patch.apiKeyEnv) {
      setPendingSecrets((prev) => ({
        ...prev,
        [patch.apiKeyEnv]: patch.apiKeyValue,
      }));
    }

    setDrawerState({ open: false });
    onToast({
      title: `已更新供应商 ${patch.name}`,
      description: "请点击右上角「保存模型配置」保存并应用更改",
      status: "info",
    });
  };

  const handleDeleteProvider = (uid: string) => {
    const target = providers.find((p) => p.uid === uid);
    setProviders((prev) => prev.filter((p) => p.uid !== uid));
    if (target) {
      onToast({ title: `已移除供应商 ${target.name}`, status: "info" });
    }
  };

  const handleAddModel = (providerUid: string) => {
    const modUid = createUid("mod");
    const targetProv = providers.find((p) => p.uid === providerUid);
    const uniqueId = generateUniqueModelId(targetProv?.models ?? []);
    const newModel: UiModelEntry = {
      uid: modUid,
      id: uniqueId,
      displayName: uniqueId === "new-model" ? "New Model" : uniqueId,
      supportsVision: false,
      supportsThinking: false,
      modelsDev: {
        enabled: false,
        modelRef: "",
      },
      advanced: {
        contextWindow: "128000",
        maxOutputTokens: "8192",
        apiOverride: "__inherit__",
        baseUrlOverride: "",
        customHeaders: "",
      },
    };

    setProviders((prev) =>
      prev.map((p) =>
        p.uid === providerUid ? { ...p, models: [...p.models, newModel] } : p,
      ),
    );
    setCollapsedProviderIds((prev) => {
      if (!prev.has(providerUid)) return prev;
      const next = new Set(prev);
      next.delete(providerUid);
      return next;
    });
    setExpandedModelIds((prev) => {
      const next = new Set(prev);
      next.add(modUid);
      return next;
    });
    setNewlyAddedModelUid(modUid);
  };

  const handleUpdateModel = (
    providerUid: string,
    modelUid: string,
    patch: Partial<UiModelEntry>,
  ) => {
    setProviders((prev) =>
      prev.map((p) =>
        p.uid === providerUid
          ? {
              ...p,
              models: p.models.map((m) =>
                m.uid === modelUid ? { ...m, ...patch } : m,
              ),
            }
          : p,
      ),
    );
  };

  const handleUpdateModelAdvanced = (
    providerUid: string,
    modelUid: string,
    patch: Partial<UiModelEntry["advanced"]>,
  ) => {
    setProviders((prev) =>
      prev.map((p) =>
        p.uid === providerUid
          ? {
              ...p,
              models: p.models.map((m) =>
                m.uid === modelUid
                  ? { ...m, advanced: { ...m.advanced, ...patch } }
                  : m,
              ),
            }
          : p,
      ),
    );
  };

  const handleRemoveModel = (providerUid: string, modelUid: string) => {
    setProviders((prev) =>
      prev.map((p) =>
        p.uid === providerUid
          ? { ...p, models: p.models.filter((m) => m.uid !== modelUid) }
          : p,
      ),
    );
  };

  const handleTestModel = async (providerUid: string, modelUid: string) => {
    const prov = providers.find((p) => p.uid === providerUid);
    const model = prov?.models.find((m) => m.uid === modelUid);
    if (!prov || !model) return;

    const slug = prov.name.trim();
    const modelId = model.id.trim();
    if (!slug || !prov.baseUrl.trim() || !modelId) {
      onToast({
        title: "无法发起模型测试",
        description: "请先完善供应商名称、Base URL 与模型 ID",
        status: "error",
      });
      return;
    }

    const provHeadersRes = parseHeadersJson(prov.customHeaders, `供应商 "${slug}" 请求头`);
    if (!provHeadersRes.ok) {
      onToast({ title: "无法发起模型测试", description: provHeadersRes.error, status: "error" });
      return;
    }

    const modHeadersRes = parseHeadersJson(
      model.advanced.customHeaders,
      `模型 "${slug}/${modelId}" 自定义请求头`,
    );
    if (!modHeadersRes.ok) {
      onToast({ title: "无法发起模型测试", description: modHeadersRes.error, status: "error" });
      return;
    }

    setTestingModelIds((prev) => new Set(prev).add(modelUid));
    try {
      const res = await api.testModel({
        providerSlug: slug,
        api: prov.protocol,
        baseUrl: prov.baseUrl.trim(),
        apiKeyEnv: prov.apiKeyEnv.trim() || undefined,
        apiKeyOverride: prov.apiKeyEnv.trim() ? pendingSecrets[prov.apiKeyEnv.trim()] : undefined,
        providerHeaders: provHeadersRes.headers,
        model: {
          id: modelId,
          name: model.displayName.trim() || modelId,
          api:
            model.advanced.apiOverride && model.advanced.apiOverride !== "__inherit__"
              ? model.advanced.apiOverride
              : undefined,
          base_url: model.advanced.baseUrlOverride.trim() || undefined,
          headers: modHeadersRes.headers,
          reasoning: model.supportsThinking,
          input: model.supportsVision ? ["text", "image"] : ["text"],
        },
      });

      const outcome = res.result;
      setTestOutcomes((prev) => ({
        ...prev,
        [modelUid]: {
          ok: outcome.ok,
          latencyMs: outcome.latencyMs,
          replyPreview: outcome.replyPreview,
          error: outcome.error,
        },
      }));

      if (outcome.ok) {
        onToast({
          title: `测试成功 · ${outcome.target}`,
          description: `问好回复: "${outcome.replyPreview ?? "hello"}" · 耗时 ${outcome.latencyMs}ms`,
          status: "success",
        });
      } else {
        onToast({
          title: `测试失败 · ${outcome.target}`,
          description: outcome.error || "未知错误",
          status: "error",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestOutcomes((prev) => ({
        ...prev,
        [modelUid]: {
          ok: false,
          latencyMs: 0,
          error: msg,
        },
      }));
      onToast({
        title: `测试失败 · ${slug}/${modelId}`,
        description: msg,
        status: "error",
      });
    } finally {
      setTestingModelIds((prev) => {
        const next = new Set(prev);
        next.delete(modelUid);
        return next;
      });
    }
  };

  const handleSaveConfig = useCallback(async () => {
    if (savePhase === "saving") return;

    const built = buildApiModelsConfig(slots, providers);
    if (!built.ok) {
      if (built.providerUid) {
        setCollapsedProviderIds((prev) => {
          if (!prev.has(built.providerUid!)) return prev;
          const next = new Set(prev);
          next.delete(built.providerUid!);
          return next;
        });
      }
      if (built.modelUid) {
        setExpandedModelIds((prev) => {
          if (prev.has(built.modelUid!)) return prev;
          const next = new Set(prev);
          next.add(built.modelUid!);
          return next;
        });
      }
      onToast({
        title: "无法保存模型配置",
        description: built.error,
        status: "error",
      });
      return;
    }

    setSavePhase("saving");
    try {
      const res = await api.saveModelsConfig(built.config);
      const changeList = [...(res.changes ?? [])];

      const secretEntries = Object.entries(pendingSecrets).filter(
        ([k, v]) => k.trim().length > 0 && v.trim().length > 0,
      );
      if (secretEntries.length > 0) {
        const secRes = await api.saveSecrets(Object.fromEntries(secretEntries));
        setPendingSecrets({});
        onSecretsUpdated?.(secRes.secretStates);
        if (secRes.writtenKeys.length > 0) {
          changeList.push(`已更新密钥: ${secRes.writtenKeys.join(", ")}`);
        }
      }

      setSavedComparable(serializeComparableState(slots, providers));
      setSavePhase("saved");
      onSaved(built.config, changeList);
      onToast({
        title: "模型配置已保存",
        description: changeList.length > 0 ? changeList.join("；") : "配置已生效",
        status: "success",
      });
      window.setTimeout(() => setSavePhase("idle"), 1600);
    } catch (err) {
      setSavePhase("idle");
      onToast({
        title: "保存模型配置失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    }
  }, [savePhase, slots, providers, pendingSecrets, onSecretsUpdated, onSaved, onToast]);

  // Cmd/Ctrl + S shortcut when drawer is closed
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (drawerState.open) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveConfig();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerState.open, handleSaveConfig]);

  const pendingSecretCount = Object.keys(pendingSecrets).length;

  return (
    <div className="flex flex-col">
      {/* Sticky Page Header */}
      <div className="sticky top-0 z-20 border-b border-border bg-background/95 px-6 py-3.5 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="text-base font-semibold tracking-tight text-balance text-foreground">
              模型与供应商
            </h1>
            {isDirty ? (
              <AnimatedBadge status="warning" size="sm">
                {pendingSecretCount > 0
                  ? `有未保存更改 · 含 ${pendingSecretCount} 项待写入密钥`
                  : "有未保存更改"}
              </AnimatedBadge>
            ) : (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                配置与运行时路由映射 · ⌘/Ctrl+S 快速保存
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isDirty ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={savePhase === "saving"}
                onClick={handleResetChanges}
              >
                <RotateCcw className="size-3.5" />
                <span>还原</span>
              </Button>
            ) : null}

            <Button
              type="button"
              size="sm"
              disabled={savePhase === "saving"}
              onClick={() => void handleSaveConfig()}
            >
              {savePhase === "saving" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>保存中…</span>
                </>
              ) : savePhase === "saved" ? (
                <>
                  <Check className="size-3.5" />
                  <span>已保存</span>
                </>
              ) : (
                <>
                  <Save className="size-3.5" />
                  <span>保存模型配置</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content Container */}
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-6 py-6">
        {/* Section 1: Function Slots */}
        <FunctionSlotsPanel
          slots={slots}
          providers={providers}
          secretStates={secretStates}
          pendingSecrets={pendingSecrets}
          onChangeSlot={handleChangeSlot}
          onConfigureProvider={(providerUid) =>
            setDrawerState({ open: true, mode: "edit", providerUid })
          }
        />

        {/* Section 2: Providers & Models */}
        <div className="flex flex-col gap-5 border-t border-border pt-6">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-sm font-semibold text-foreground">
                供应商与模型{" "}
                <span className="font-mono text-muted-foreground tabular-nums">
                  ({isSearchActive ? `${filteredProviderEntries.length}/${providers.length}` : providers.length})
                </span>
              </h2>

              {providers.length > 0 ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleToggleAllProviders}
                  >
                    {allCollapsed ? (
                      <>
                        <ChevronsUpDown className="size-3.5" />
                        <span>全部展开</span>
                      </>
                    ) : (
                      <>
                        <ChevronsDownUp className="size-3.5" />
                        <span>全部折叠</span>
                      </>
                    )}
                  </Button>

                  <div className="relative w-52 sm:w-64">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && searchQuery) {
                          e.preventDefault();
                          setSearchQuery("");
                        }
                      }}
                      placeholder="筛选供应商或模型…"
                      aria-label="筛选供应商或模型"
                      className="h-8 w-full rounded-lg border border-border bg-background pr-7 pl-8 text-xs text-foreground transition-colors placeholder:text-muted-foreground focus:border-ring focus:outline-none"
                    />
                    {isSearchActive ? (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        aria-label="清空筛选"
                        className="absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>

            <div className="flex items-center gap-3">
              {providerDraft ? (
                <span className="hidden items-center gap-1 text-xs font-medium text-amber-600 sm:inline-flex dark:text-amber-400">
                  <Bookmark className="size-3.5" />
                  <span>有未完成供应商草稿</span>
                </span>
              ) : null}

              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDrawerState({ open: true, mode: "create" })}
              >
                <Plus className="size-3.5" />
                <span>
                  {providerDraft ? "继续编辑草稿 / 添加供应商" : "添加供应商"}
                </span>
              </Button>
            </div>
          </div>

          {/* Providers List */}
          {providers.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 border-t border-border/70 py-14 text-center">
              <ServerOff className="size-8 text-muted-foreground/60" />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground">
                  暂无供应商配置
                </p>
                <p className="text-xs text-muted-foreground">
                  点击右上角「添加供应商」在侧边抽屉中完成接口与 API Key 配置
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => setDrawerState({ open: true, mode: "create" })}
              >
                <Plus className="size-3.5" />
                <span>添加供应商</span>
              </Button>
            </div>
          ) : filteredProviderEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2.5 border-t border-border/70 py-12 text-center">
              <p className="text-xs text-muted-foreground">
                未找到匹配 “{searchQuery.trim()}” 的供应商或模型
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setSearchQuery("")}
              >
                清空筛选条件
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {filteredProviderEntries.map(({ provider, visibleModels }) => {
                const slug = provider.name.trim();
                const idCounts = new Map<string, number>();
                const boundSlotsByModelId = new Map<string, SlotKey[]>();
                for (const m of provider.models) {
                  const mid = m.id.trim();
                  if (!mid) continue;
                  idCounts.set(mid, (idCounts.get(mid) ?? 0) + 1);
                  const bound = slotIndex.byTarget.get(`${slug}/${mid}`);
                  if (bound && bound.length > 0) {
                    boundSlotsByModelId.set(mid, bound);
                  }
                }
                const duplicateModelIds = new Set(
                  [...idCounts.entries()]
                    .filter(([, count]) => count > 1)
                    .map(([id]) => id),
                );

                return (
                  <ProviderCard
                    key={provider.uid}
                    provider={provider}
                    visibleModels={visibleModels}
                    isSearchActive={isSearchActive}
                    boundSlotsByModelId={boundSlotsByModelId}
                    providerBoundSlots={slotIndex.byProvider.get(slug) ?? []}
                    duplicateModelIds={duplicateModelIds}
                    newlyAddedModelUid={newlyAddedModelUid}
                    secretStates={secretStates}
                    pendingSecrets={pendingSecrets}
                    isCollapsed={
                      !isSearchActive && collapsedProviderIds.has(provider.uid)
                    }
                    onToggleCollapse={() =>
                      handleToggleProviderCollapse(provider.uid)
                    }
                    expandedModelIds={expandedModelIds}
                    testingModelIds={testingModelIds}
                    testOutcomes={testOutcomes}
                    onToggleModelExpand={handleToggleModelExpand}
                    onTestModel={(modelUid) => void handleTestModel(provider.uid, modelUid)}
                    onConfigureProvider={() =>
                      setDrawerState({
                        open: true,
                        mode: "edit",
                        providerUid: provider.uid,
                      })
                    }
                    onDeleteProvider={() => handleDeleteProvider(provider.uid)}
                    onAddModel={() => handleAddModel(provider.uid)}
                    onUpdateModel={(modelUid, patch) =>
                      handleUpdateModel(provider.uid, modelUid, patch)
                    }
                    onUpdateModelAdvanced={(modelUid, patch) =>
                      handleUpdateModelAdvanced(provider.uid, modelUid, patch)
                    }
                    onRemoveModel={(modelUid) =>
                      handleRemoveModel(provider.uid, modelUid)
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Add / Configure Provider Slide-Over Drawer */}
      <ProviderDrawer
        open={drawerState.open}
        mode={drawerState.open ? drawerState.mode : "create"}
        editingProvider={editingProvider}
        savedDraft={providerDraft}
        existingNames={providers.map((p) => p.name)}
        secretStates={secretStates}
        pendingSecrets={pendingSecrets}
        onClose={() => setDrawerState({ open: false })}
        onSaveDraft={handleSaveProviderDraft}
        onDiscardDraft={handleDiscardProviderDraft}
        onCreateProvider={handleCreateProviderFromDrawer}
        onUpdateProviderSettings={handleUpdateProviderSettings}
      />
    </div>
  );
}
