import {
  AlertCircle,
  AlertTriangle,
  Bookmark,
  Check,
  ChevronUp,
  Copy,
  Loader2,
  RotateCcw,
  Save,
  ShieldAlert,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type ModelsFileConfig,
  type SecretState,
  type SlotThinkingMap,
  type ThinkingLevel,
} from "@/api";
import { Button } from "@/components/motion/button";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@/lib/ease";
import { FunctionSlotsPanel } from "./models/FunctionSlotsPanel";
import {
  isTestOutcomeEmptyWarning,
  ModelDetailPanel,
  type ModelTestOutcome,
} from "./models/ModelDetailPanel";
import { ProviderDrawer } from "./models/ProviderDrawer";
import {
  type ListFilterMode,
  ProviderModelList,
} from "./models/ProviderModelList";
import {
  buildApiModelsConfig,
  createUid,
  generateUniqueModelId,
  normalizeSlotThinkingMap,
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
const SELECTED_MODEL_STORAGE_KEY = "hato-selected-model-v1";

type DrawerState =
  | { open: false }
  | { open: true; mode: "create" }
  | { open: true; mode: "edit"; providerUid: string };

type DeleteConfirmState =
  | null
  | {
      kind: "provider";
      providerUid: string;
      title: string;
      boundSlots: SlotKey[];
      modelCount: number;
    }
  | {
      kind: "model";
      providerUid: string;
      modelUid: string;
      title: string;
      boundSlots: SlotKey[];
    };

export interface ModelsConfigPanelProps {
  initialConfig: ModelsFileConfig;
  secretStates?: SecretState[];
  hindsightEnabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved: (next: ModelsFileConfig, changes?: string[]) => void;
  onSecretsUpdated?: (nextStates: SecretState[]) => void;
  onToast: (input: {
    title: string;
    description?: string;
    status?: "info" | "success" | "error";
    action?: { label: string; onClick: () => void };
    duration?: number;
  }) => void;
}

interface TestDetailState {
  target: string;
  providerLabel: string;
  modelLabel: string;
  ok: boolean;
  isEmptyWarn?: boolean;
  latencyMs: number;
  replyPreview?: string;
  error?: string;
}

function buildTestDetailState(
  prov: UiProviderConfig,
  model: UiModelEntry,
  outcome: Pick<ModelTestOutcome, "ok" | "latencyMs" | "replyPreview" | "error"> & {
    target?: string;
  },
): TestDetailState {
  const slug = prov.name.trim();
  const modelId = model.id.trim();
  return {
    target: outcome.target || `${slug}/${modelId}`,
    providerLabel: prov.displayName?.trim() || slug,
    modelLabel: model.displayName.trim() || modelId,
    ok: outcome.ok,
    isEmptyWarn: outcome.ok ? isTestOutcomeEmptyWarning(outcome) : undefined,
    latencyMs: outcome.latencyMs,
    replyPreview: outcome.replyPreview,
    error: outcome.error,
  };
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

function resolveInitialSelection(providers: UiProviderConfig[]): {
  providerUid: string | null;
  modelUid: string | null;
} {
  let savedTarget = "";
  try {
    const hash = window.location.hash;
    const match = /model=([^&]+)/.exec(hash);
    if (match) {
      savedTarget = decodeURIComponent(match[1]);
    } else {
      savedTarget = window.localStorage.getItem(SELECTED_MODEL_STORAGE_KEY) ?? "";
    }
  } catch {
    // Ignore storage/hash read errors
  }

  if (savedTarget) {
    for (const p of providers) {
      for (const m of p.models) {
        if (`${p.name.trim()}/${m.id.trim()}` === savedTarget) {
          return { providerUid: p.uid, modelUid: m.uid };
        }
      }
    }
  }

  for (const p of providers) {
    if (p.models.length > 0) {
      return { providerUid: p.uid, modelUid: p.models[0].uid };
    }
  }
  return { providerUid: providers[0]?.uid ?? null, modelUid: null };
}

export function ModelsConfigPanel({
  initialConfig,
  secretStates = [],
  hindsightEnabled = false,
  onDirtyChange,
  onSaved,
  onSecretsUpdated,
  onToast,
}: ModelsConfigPanelProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [slots, setSlots] = useState<ModelsFileConfig["slots"]>(() => ({
    ...initialConfig.slots,
  }));
  const [slotThinking, setSlotThinking] = useState<SlotThinkingMap>(() =>
    normalizeSlotThinkingMap(initialConfig.slot_thinking),
  );
  const [providers, setProviders] = useState<UiProviderConfig[]>(() =>
    toUiProviders(initialConfig),
  );
  const [savedSnapshot, setSavedSnapshot] = useState<{
    comparable: string;
    slots: ModelsFileConfig["slots"];
    slotThinking: SlotThinkingMap;
    providers: UiProviderConfig[];
  }>(() => {
    const uiProviders = toUiProviders(initialConfig);
    const initialThinking = normalizeSlotThinkingMap(initialConfig.slot_thinking);
    return {
      comparable: serializeComparableState(initialConfig.slots, uiProviders, initialThinking),
      slots: { ...initialConfig.slots },
      slotThinking: initialThinking,
      providers: uiProviders,
    };
  });
  const [pendingSecrets, setPendingSecrets] = useState<Record<string, string>>({});
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(() =>
    readStoredProviderDraft(),
  );
  const [drawerState, setDrawerState] = useState<DrawerState>({ open: false });
  const [collapsedProviderIds, setCollapsedProviderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedModelRef, setSelectedModelRef] = useState<{
    providerUid: string | null;
    modelUid: string | null;
  }>(() => resolveInitialSelection(toUiProviders(initialConfig)));
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [testingModelIds, setTestingModelIds] = useState<Set<string>>(() => new Set());
  const [testOutcomes, setTestOutcomes] = useState<Record<string, ModelTestOutcome>>({});
  const [testDetailModal, setTestDetailModal] = useState<TestDetailState | null>(null);
  const [copiedDetail, setCopiedDetail] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>(null);
  const [changeListOpen, setChangeListOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<ListFilterMode>("all");
  const [savePhase, setSavePhase] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    const nextSlots = { ...initialConfig.slots };
    const nextThinking = normalizeSlotThinkingMap(initialConfig.slot_thinking);
    const nextProviders = toUiProviders(initialConfig);
    setSlots(nextSlots);
    setSlotThinking(nextThinking);
    setProviders(nextProviders);
    setSavedSnapshot({
      comparable: serializeComparableState(nextSlots, nextProviders, nextThinking),
      slots: nextSlots,
      slotThinking: nextThinking,
      providers: nextProviders,
    });
    setSelectedModelRef((prev) => {
      if (
        prev.providerUid &&
        prev.modelUid &&
        nextProviders.some(
          (p) =>
            p.uid === prev.providerUid &&
            p.models.some((m) => m.uid === prev.modelUid),
        )
      ) {
        return prev;
      }
      return resolveInitialSelection(nextProviders);
    });
  }, [initialConfig]);

  const isDirty = useMemo(() => {
    if (Object.keys(pendingSecrets).length > 0) return true;
    return serializeComparableState(slots, providers, slotThinking) !== savedSnapshot.comparable;
  }, [slots, slotThinking, providers, savedSnapshot.comparable, pendingSecrets]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!isDirty) {
      setChangeListOpen(false);
      return;
    }
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  // Compute modified models & human-readable change list for bottom floating save bar
  const { modifiedModelUids, changeSummaryList } = useMemo(() => {
    const modUids = new Set<string>();
    const items: string[] = [];

    const baselineProvidersByUid = new Map(
      savedSnapshot.providers.map((p) => [p.uid, p]),
    );

    for (const def of SLOT_DEFINITIONS) {
      if (def.key === "hindsight_llm" && !hindsightEnabled) continue;
      const before = savedSnapshot.slots[def.key]?.trim() ?? "";
      const after = slots[def.key]?.trim() ?? "";
      if (before !== after) {
        items.push(`槽位 ${def.key}：${before || "未指定"} → ${after || "自动回退"}`);
      }
      const beforeThinking = savedSnapshot.slotThinking[def.key] ?? "自动";
      const afterThinking = slotThinking[def.key] ?? "自动";
      if (beforeThinking !== afterThinking) {
        items.push(`槽位 ${def.key} 思考强度：${beforeThinking} → ${afterThinking}`);
      }
    }

    for (const p of providers) {
      const baseProv = baselineProvidersByUid.get(p.uid);
      if (!baseProv) {
        items.push(`新增供应商：${p.displayName?.trim() || p.name}`);
        p.models.forEach((m) => modUids.add(m.uid));
        continue;
      }
      if (
        baseProv.name !== p.name ||
        baseProv.displayName !== p.displayName ||
        baseProv.protocol !== p.protocol ||
        baseProv.baseUrl !== p.baseUrl ||
        baseProv.apiKeyEnv !== p.apiKeyEnv ||
        baseProv.cacheTtlMinutes !== p.cacheTtlMinutes ||
        baseProv.customHeaders !== p.customHeaders
      ) {
        items.push(`更新供应商设置：${p.displayName?.trim() || p.name}`);
      }
      const baseModelsByUid = new Map(baseProv.models.map((m) => [m.uid, m]));
      for (const m of p.models) {
        const bm = baseModelsByUid.get(m.uid);
        if (!bm) {
          modUids.add(m.uid);
          items.push(`新增模型：${p.name}/${m.id || "未命名"}`);
        } else if (JSON.stringify(bm) !== JSON.stringify(m)) {
          modUids.add(m.uid);
          items.push(`修改模型：${p.name}/${m.id || "未命名"}`);
        }
      }
      for (const bm of baseProv.models) {
        if (!p.models.some((m) => m.uid === bm.uid)) {
          items.push(`移除模型：${p.name}/${bm.id}`);
        }
      }
    }

    for (const bp of savedSnapshot.providers) {
      if (!providers.some((p) => p.uid === bp.uid)) {
        items.push(`删除供应商：${bp.displayName?.trim() || bp.name}`);
      }
    }

    for (const envName of Object.keys(pendingSecrets)) {
      items.push(`待写入密钥：${envName}`);
    }

    return { modifiedModelUids: modUids, changeSummaryList: items };
  }, [slots, slotThinking, providers, savedSnapshot, pendingSecrets, hindsightEnabled]);

  const slotIndex = useMemo(() => {
    const byTarget = new Map<string, SlotKey[]>();
    const byProvider = new Map<string, SlotKey[]>();

    for (const def of SLOT_DEFINITIONS) {
      if (def.key === "hindsight_llm" && !hindsightEnabled) continue;
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
  }, [slots, hindsightEnabled]);

  const slotTargetLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of providers) {
      const slug = p.name.trim();
      if (!slug) continue;
      const pLabel = p.displayName?.trim() || slug;
      for (const m of p.models) {
        const mid = m.id.trim();
        if (!mid) continue;
        map.set(`${slug}/${mid}`, `${pLabel}/${m.displayName.trim() || mid}`);
      }
    }
    return map;
  }, [providers]);

  const selectedEntry = useMemo(() => {
    for (const p of providers) {
      const found = p.models.find((m) => m.uid === selectedModelRef.modelUid);
      if (found) {
        const idCount = p.models.filter((m) => m.id.trim() === found.id.trim()).length;
        return {
          provider: p,
          model: found,
          isDuplicateId: Boolean(found.id.trim() && idCount > 1),
        };
      }
    }
    return null;
  }, [providers, selectedModelRef.modelUid]);

  // Persist selected model target in localStorage
  useEffect(() => {
    if (!selectedEntry) return;
    const slug = selectedEntry.provider.name.trim();
    const mid = selectedEntry.model.id.trim();
    if (!slug || !mid) return;
    const target = `${slug}/${mid}`;
    try {
      window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, target);
    } catch {
      // Ignore storage errors
    }
  }, [selectedEntry]);

  const editingProvider =
    drawerState.open && drawerState.mode === "edit"
      ? providers.find((p) => p.uid === drawerState.providerUid) ?? null
      : null;

  const handleSelectModel = (providerUid: string, modelUid: string) => {
    setSelectedModelRef({ providerUid, modelUid });
    setMobileDetailOpen(true);
  };

  const handleResetChanges = () => {
    const nextSlots = { ...savedSnapshot.slots };
    const nextThinking = { ...savedSnapshot.slotThinking };
    const nextProviders = toUiProviders(initialConfig);
    setSlots(nextSlots);
    setSlotThinking(nextThinking);
    setProviders(nextProviders);
    setPendingSecrets({});
    setChangeListOpen(false);
    onToast({ title: "已还原未保存更改", status: "info" });
  };

  const handleToggleProviderCollapse = (uid: string) => {
    setCollapsedProviderIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const handleChangeSlot = (slotKey: SlotKey, value: string) => {
    setSlots((prev) => ({ ...prev, [slotKey]: value }));
  };

  const handleChangeSlotThinking = (slotKey: SlotKey, value: ThinkingLevel | undefined) => {
    setSlotThinking((prev) => {
      const next = { ...prev };
      if (!value) {
        delete next[slotKey];
      } else {
        next[slotKey] = value;
      }
      return next;
    });
  };

  const handleSaveProviderDraft = (draft: ProviderDraft) => {
    try {
      window.localStorage.setItem(PROVIDER_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Ignore storage restrictions
    }
    setProviderDraft(draft);
    setDrawerState({ open: false });
    onToast({ title: "供应商草稿已保存", status: "info" });
  };

  const handleDiscardProviderDraft = () => {
    try {
      window.localStorage.removeItem(PROVIDER_DRAFT_STORAGE_KEY);
    } catch {
      // Ignore storage restrictions
    }
    setProviderDraft(null);
    onToast({ title: "已清空供应商草稿", status: "info" });
  };

  const handleCreateProviderFromDrawer = (draft: ProviderDraft) => {
    const providerUid = createUid("prov");
    const modUid = createUid("mod");
    const models: UiModelEntry[] = draft.includeInitialModel
      ? [
          {
            uid: modUid,
            id: draft.initialModelId,
            displayName: draft.initialModelName || draft.initialModelId,
            supportsVision: draft.initialModelVision,
            supportsThinking: draft.initialModelThinking,
            modelsDev: { enabled: false, modelRef: "" },
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
    if (models.length > 0) {
      setSelectedModelRef({ providerUid, modelUid: modUid });
      setMobileDetailOpen(true);
    }

    if (draft.apiKeyValue && draft.apiKeyEnv) {
      setPendingSecrets((prev) => ({
        ...prev,
        [draft.apiKeyEnv]: draft.apiKeyValue,
      }));
    }

    try {
      window.localStorage.removeItem(PROVIDER_DRAFT_STORAGE_KEY);
    } catch {
      // Ignore storage restrictions
    }
    setProviderDraft(null);
    setDrawerState({ open: false });
    onToast({
      title: `已添加供应商 ${draft.name}`,
      description: "请点击底部「保存 ⌘S」使配置生效",
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
          const cur = nextSlots[key];
          if (cur && cur.startsWith(prefix)) {
            nextSlots[key] = `${patch.name}/${cur.slice(prefix.length)}`;
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
      description: "请点击底部「保存 ⌘S」保存并应用更改",
      status: "info",
    });
  };

  const requestDeleteProvider = (providerUid: string) => {
    const target = providers.find((p) => p.uid === providerUid);
    if (!target) return;
    const bound = slotIndex.byProvider.get(target.name.trim()) ?? [];
    setDeleteConfirm({
      kind: "provider",
      providerUid,
      title: target.displayName?.trim() || target.name,
      boundSlots: bound,
      modelCount: target.models.length,
    });
  };

  const requestRemoveModel = (providerUid: string, modelUid: string) => {
    const prov = providers.find((p) => p.uid === providerUid);
    const model = prov?.models.find((m) => m.uid === modelUid);
    if (!prov || !model) return;
    const targetKey = `${prov.name.trim()}/${model.id.trim()}`;
    const bound = slotIndex.byTarget.get(targetKey) ?? [];
    setDeleteConfirm({
      kind: "model",
      providerUid,
      modelUid,
      title: model.displayName.trim() || model.id.trim() || "未命名模型",
      boundSlots: bound,
    });
  };

  const confirmDeleteAction = () => {
    if (!deleteConfirm || deleteConfirm.boundSlots.length > 0) return;

    if (deleteConfirm.kind === "provider") {
      const uid = deleteConfirm.providerUid;
      setProviders((prev) => {
        const next = prev.filter((p) => p.uid !== uid);
        if (selectedModelRef.providerUid === uid) {
          const fallback = resolveInitialSelection(next);
          setSelectedModelRef(fallback);
          setMobileDetailOpen(false);
        }
        return next;
      });
      onToast({ title: `已删除供应商 ${deleteConfirm.title}`, status: "info" });
    } else {
      const { providerUid, modelUid } = deleteConfirm;
      setProviders((prev) => {
        const next = prev.map((p) =>
          p.uid === providerUid
            ? { ...p, models: p.models.filter((m) => m.uid !== modelUid) }
            : p,
        );
        if (selectedModelRef.modelUid === modelUid) {
          const fallback = resolveInitialSelection(next);
          setSelectedModelRef(fallback);
          setMobileDetailOpen(false);
        }
        return next;
      });
      onToast({ title: `已移除模型 ${deleteConfirm.title}`, status: "info" });
    }
    setDeleteConfirm(null);
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
      modelsDev: { enabled: false, modelRef: "" },
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
    setSelectedModelRef({ providerUid, modelUid: modUid });
    setMobileDetailOpen(true);
  };

  const handleDuplicateModel = (providerUid: string, modelUid: string) => {
    const targetProv = providers.find((p) => p.uid === providerUid);
    const source = targetProv?.models.find((m) => m.uid === modelUid);
    if (!targetProv || !source) return;

    const newUid = createUid("mod");
    const newId = generateUniqueModelId(targetProv.models, source.id.trim() || "model");
    const clone: UiModelEntry = {
      ...source,
      uid: newUid,
      id: newId,
      displayName: source.displayName
        ? `${source.displayName} (副本)`
        : newId,
      modelsDev: source.modelsDev ? { ...source.modelsDev } : { enabled: false, modelRef: "" },
      advanced: { ...source.advanced },
      preserved: source.preserved ? { ...source.preserved } : undefined,
    };

    setProviders((prev) =>
      prev.map((p) =>
        p.uid === providerUid ? { ...p, models: [...p.models, clone] } : p,
      ),
    );
    setSelectedModelRef({ providerUid, modelUid: newUid });
    onToast({ title: `已复制模型为 ${newId}`, status: "info" });
  };

  const handleUpdateModel = (
    providerUid: string,
    modelUid: string,
    patch: Partial<UiModelEntry>,
  ) => {
    const prov = providers.find((p) => p.uid === providerUid);
    const oldModel = prov?.models.find((m) => m.uid === modelUid);
    const oldId = oldModel?.id.trim();
    const newId = patch.id !== undefined ? patch.id.trim() : undefined;

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

    if (prov && oldId && newId && oldId !== newId) {
      const slug = prov.name.trim();
      const oldTarget = `${slug}/${oldId}`;
      const newTarget = `${slug}/${newId}`;
      setSlots((prev) => {
        const nextSlots = { ...prev };
        (Object.keys(nextSlots) as SlotKey[]).forEach((key) => {
          if (nextSlots[key] === oldTarget) {
            nextSlots[key] = newTarget;
          }
        });
        return nextSlots;
      });
    }
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
      const nextOutcome: ModelTestOutcome = {
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        replyPreview: outcome.replyPreview,
        error: outcome.error,
        testedAt: Date.now(),
      };
      const emptyWarn = isTestOutcomeEmptyWarning(nextOutcome);
      const detailPayload = buildTestDetailState(prov, model, {
        ...nextOutcome,
        target: outcome.target,
      });
      setTestOutcomes((prev) => ({
        ...prev,
        [modelUid]: nextOutcome,
      }));

      if (outcome.ok && !emptyWarn) {
        onToast({
          title: `测试成功 · ${outcome.target}`,
          description: `问好回复: "${outcome.replyPreview}" · 耗时 ${outcome.latencyMs}ms`,
          status: "success",
          duration: 6000,
          action: {
            label: "详情",
            onClick: () => {
              setCopiedDetail(false);
              setTestDetailModal(detailPayload);
            },
          },
        });
      } else if (outcome.ok && emptyWarn) {
        onToast({
          title: `测试返回空响应 · ${outcome.target}`,
          description: `上游连接正常但未返回文本内容 · 耗时 ${outcome.latencyMs}ms`,
          status: "info",
          duration: 7000,
          action: {
            label: "详情",
            onClick: () => {
              setCopiedDetail(false);
              setTestDetailModal(detailPayload);
            },
          },
        });
      } else {
        onToast({
          title: `测试失败 · ${outcome.target}`,
          description: outcome.error || "未知错误",
          status: "error",
          duration: 8000,
          action: {
            label: "详情",
            onClick: () => {
              setCopiedDetail(false);
              setTestDetailModal(detailPayload);
            },
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detailPayload = buildTestDetailState(prov, model, {
        ok: false,
        latencyMs: 0,
        error: msg,
      });
      setTestOutcomes((prev) => ({
        ...prev,
        [modelUid]: {
          ok: false,
          latencyMs: 0,
          error: msg,
          testedAt: Date.now(),
        },
      }));
      onToast({
        title: `测试失败 · ${slug}/${modelId}`,
        description: msg,
        status: "error",
        duration: 8000,
        action: {
          label: "详情",
          onClick: () => {
            setCopiedDetail(false);
            setTestDetailModal(detailPayload);
          },
        },
      });
    } finally {
      setTestingModelIds((prev) => {
        const next = new Set(prev);
        next.delete(modelUid);
        return next;
      });
    }
  };

  const handleTestProviderAll = (providerUid: string) => {
    const prov = providers.find((p) => p.uid === providerUid);
    if (!prov || prov.models.length === 0) return;
    void Promise.all(prov.models.map((m) => handleTestModel(providerUid, m.uid)));
  };

  const handleSaveConfig = useCallback(async () => {
    if (savePhase === "saving") return;

    const built = buildApiModelsConfig(slots, providers, slotThinking);
    if (!built.ok) {
      if (built.providerUid) {
        setCollapsedProviderIds((prev) => {
          if (!prev.has(built.providerUid!)) return prev;
          const next = new Set(prev);
          next.delete(built.providerUid!);
          return next;
        });
      }
      if (built.modelUid && built.providerUid) {
        setSelectedModelRef({
          providerUid: built.providerUid,
          modelUid: built.modelUid,
        });
        setMobileDetailOpen(true);
      }
      onToast({
        title: "配置校验未通过",
        description: built.error,
        status: "error",
      });
      return;
    }

    setSavePhase("saving");
    try {
      const secretEntries = Object.entries(pendingSecrets).filter(
        ([k, v]) => k.trim().length > 0 && v.trim().length > 0,
      );
      if (secretEntries.length > 0) {
        const secretMap = Object.fromEntries(secretEntries);
        const secretRes = await api.saveSecrets(secretMap);
        onSecretsUpdated?.(secretRes.secretStates);
        setPendingSecrets({});
      }

      const saveRes = await api.saveModelsConfig(built.config);
      const changeList = saveRes.changes ?? [];
      setSavePhase("saved");
      setChangeListOpen(false);
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
  }, [savePhase, slots, slotThinking, providers, pendingSecrets, onSecretsUpdated, onSaved, onToast]);

  // Close modals on Escape
  useEffect(() => {
    if (!testDetailModal && !deleteConfirm) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setTestDetailModal(null);
        setDeleteConfirm(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [testDetailModal, deleteConfirm]);

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

  return (
    <div className="relative flex flex-col pb-24">
      {/* Solid Sticky Page Header (prevents bleed-through on scroll) */}
      <div className="sticky top-0 z-30 border-b border-border bg-background px-6 py-3.5">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="text-base font-semibold tracking-tight text-balance text-foreground">
              模型与供应商
            </h1>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {providerDraft ? (
              <button
                type="button"
                onClick={() => setDrawerState({ open: true, mode: "create" })}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
              >
                <Bookmark className="size-3.5" />
                <span>继续编辑供应商草稿</span>
              </button>
            ) : null}

            {savePhase === "saved" && !isDirty ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Check className="size-3.5" />
                <span>已保存并生效</span>
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Main Content Container */}
      <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-4 py-6 sm:px-6">
        {/* Section 1: Function Slots Routing Table */}
        <FunctionSlotsPanel
          slots={slots}
          slotThinking={slotThinking}
          providers={providers}
          secretStates={secretStates}
          pendingSecrets={pendingSecrets}
          hindsightEnabled={hindsightEnabled}
          onChangeSlot={handleChangeSlot}
          onChangeSlotThinking={handleChangeSlotThinking}
          onConfigureProvider={(providerUid) =>
            setDrawerState({ open: true, mode: "edit", providerUid })
          }
        />

        {/* Section 2: Two-column Master-Detail Split */}
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          {/* Left: Provider & Model Tree */}
          <div className={mobileDetailOpen ? "hidden lg:block" : "block"}>
            <ProviderModelList
              providers={providers}
              selectedModelUid={selectedEntry?.model.uid ?? null}
              modifiedModelUids={modifiedModelUids}
              slotIndex={slotIndex}
              secretStates={secretStates}
              pendingSecrets={pendingSecrets}
              collapsedProviderIds={collapsedProviderIds}
              testingModelIds={testingModelIds}
              testOutcomes={testOutcomes}
              searchQuery={searchQuery}
              filterMode={filterMode}
              onSearchChange={setSearchQuery}
              onFilterModeChange={setFilterMode}
              onSelectModel={handleSelectModel}
              onToggleProviderCollapse={handleToggleProviderCollapse}
              onAddProvider={() => setDrawerState({ open: true, mode: "create" })}
              onConfigureProvider={(providerUid) =>
                setDrawerState({ open: true, mode: "edit", providerUid })
              }
              onRequestDeleteProvider={requestDeleteProvider}
              onAddModel={handleAddModel}
              onTestProviderAll={handleTestProviderAll}
            />
          </div>

          {/* Right: Selected Model Detail Panel */}
          <div
            className={
              mobileDetailOpen
                ? "block"
                : "hidden lg:sticky lg:top-[68px] lg:block lg:max-h-[calc(100vh-88px)] lg:overflow-y-auto"
            }
          >
            {selectedEntry ? (
              <ModelDetailPanel
                provider={selectedEntry.provider}
                model={selectedEntry.model}
                slots={slots}
                hindsightEnabled={hindsightEnabled}
                isDuplicateId={selectedEntry.isDuplicateId}
                isTesting={testingModelIds.has(selectedEntry.model.uid)}
                testOutcome={testOutcomes[selectedEntry.model.uid]}
                slotTargetLabels={slotTargetLabels}
                onBackMobile={() => setMobileDetailOpen(false)}
                onUpdate={(patch) =>
                  handleUpdateModel(
                    selectedEntry.provider.uid,
                    selectedEntry.model.uid,
                    patch,
                  )
                }
                onUpdateAdvanced={(patch) =>
                  handleUpdateModelAdvanced(
                    selectedEntry.provider.uid,
                    selectedEntry.model.uid,
                    patch,
                  )
                }
                onChangeSlot={handleChangeSlot}
                onTest={() =>
                  void handleTestModel(
                    selectedEntry.provider.uid,
                    selectedEntry.model.uid,
                  )
                }
                onShowTestDetail={() => {
                  const outcome = testOutcomes[selectedEntry.model.uid];
                  if (!outcome) return;
                  setCopiedDetail(false);
                  setTestDetailModal(
                    buildTestDetailState(
                      selectedEntry.provider,
                      selectedEntry.model,
                      outcome,
                    ),
                  );
                }}
                onDuplicate={() =>
                  handleDuplicateModel(
                    selectedEntry.provider.uid,
                    selectedEntry.model.uid,
                  )
                }
                onRequestRemove={() =>
                  requestRemoveModel(
                    selectedEntry.provider.uid,
                    selectedEntry.model.uid,
                  )
                }
                onConfigureProvider={() =>
                  setDrawerState({
                    open: true,
                    mode: "edit",
                    providerUid: selectedEntry.provider.uid,
                  })
                }
              />
            ) : (
              <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-200 bg-white/50 p-8 text-center dark:border-zinc-800 dark:bg-[#0f1418]/50">
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  请从左侧选择一个模型进行编辑
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  或点击左侧「+ 供应商」添加新的上游接口与模型
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Floating Save Bar (shown only when dirty) */}
      <AnimatePresence>
        {isDirty ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={
              reduceMotion
                ? undefined
                : { opacity: 0, y: 10, scale: 0.96, transition: { duration: 0.14, ease: EASE_OUT } }
            }
            transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
            className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4"
          >
            <div className="pointer-events-auto relative flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 shadow-xl dark:border-zinc-700 dark:bg-[#161e24]">
              <AnimatePresence>
                {changeListOpen && changeSummaryList.length > 0 ? (
                  <motion.div
                    initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={
                      reduceMotion
                        ? undefined
                        : { opacity: 0, y: 6, scale: 0.97, transition: { duration: 0.12, ease: EASE_OUT } }
                    }
                    transition={reduceMotion ? { duration: 0 } : SPRING_SWAP}
                    className="absolute bottom-full left-0 mb-2 w-80 max-w-[90vw] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-[#161e24]"
                  >
                    <div className="mb-2 flex items-center justify-between text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                      <span>待保存更改清单</span>
                      <button
                        type="button"
                        onClick={() => setChangeListOpen(false)}
                        className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-zinc-600 dark:text-zinc-300">
                      {changeSummaryList.map((item, idx) => (
                        <li key={idx} className="truncate font-mono text-[11px]">
                          • {item}
                        </li>
                      ))}
                    </ul>
                  </motion.div>
                ) : null}
              </AnimatePresence>

            <button
              type="button"
              onClick={() => setChangeListOpen((v) => !v)}
              className="inline-flex items-center gap-2 text-xs font-medium text-zinc-800 hover:text-emerald-600 dark:text-zinc-200 dark:hover:text-emerald-400"
            >
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              <span>
                有 {Math.max(1, changeSummaryList.length)} 项未保存更改
              </span>
              <ChevronUp
                className={`h-3.5 w-3.5 transition-transform ${
                  changeListOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={savePhase === "saving"}
                onClick={handleResetChanges}
              >
                <RotateCcw className="size-3.5" />
                <span>放弃</span>
              </Button>

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
                ) : (
                  <>
                    <Save className="size-3.5" />
                    <span>保存 ⌘S</span>
                  </>
                )}
              </Button>
            </div>
          </div>
        </motion.div>
      ) : null}
      </AnimatePresence>

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

      {/* Delete Protection Confirmation Modal */}
      <AnimatePresence>
        {deleteConfirm ? (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
            onClick={() => setDeleteConfirm(null)}
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.12, ease: EASE_OUT } }}
              transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
              className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-[#0f1418]"
              onClick={(e) => e.stopPropagation()}
            >
            <div className="flex items-start gap-3">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400">
                <ShieldAlert className="h-4 w-4" />
              </span>
              <div className="flex flex-col gap-1">
                <h3
                  id="delete-confirm-title"
                  className="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
                >
                  {deleteConfirm.kind === "provider"
                    ? `删除供应商「${deleteConfirm.title}」`
                    : `移除模型「${deleteConfirm.title}」`}
                </h3>
                {deleteConfirm.boundSlots.length > 0 ? (
                  <p className="text-xs leading-relaxed text-rose-600 dark:text-rose-300">
                    当前正被 <b>{deleteConfirm.boundSlots.length}</b> 个功能槽位引用（
                    <span className="font-mono">
                      {deleteConfirm.boundSlots.join(", ")}
                    </span>
                    ）。请先在上方路由表或模型详情中将这些槽位改绑到其他模型后再删除。
                  </p>
                ) : (
                  <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {deleteConfirm.kind === "provider" && deleteConfirm.modelCount > 0
                      ? `该供应商下包含 ${deleteConfirm.modelCount} 个模型配置，删除后将一并移除（保存前可通过「放弃」还原）。`
                      : "确认移除此配置？保存前可通过底部「放弃」按钮还原。"}
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDeleteConfirm(null)}
              >
                取消
              </Button>
              <button
                type="button"
                disabled={deleteConfirm.boundSlots.length > 0}
                onClick={confirmDeleteAction}
                className="inline-flex h-8 items-center rounded-lg bg-rose-600 px-3 text-xs font-medium text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {deleteConfirm.boundSlots.length > 0 ? "请先解绑槽位" : "确认删除"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
      </AnimatePresence>

      {/* Model Test Detail Modal */}
      <AnimatePresence>
        {testDetailModal ? (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="test-detail-modal-title"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
            onClick={() => setTestDetailModal(null)}
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.12, ease: EASE_OUT } }}
              transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
              className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-[#0f1418]"
              onClick={(e) => e.stopPropagation()}
            >
            <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                    !testDetailModal.ok
                      ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                      : testDetailModal.isEmptyWarn
                        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                        : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  {!testDetailModal.ok ? (
                    <AlertCircle className="h-3.5 w-3.5" />
                  ) : testDetailModal.isEmptyWarn ? (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                </span>
                <div className="min-w-0">
                  <h3
                    id="test-detail-modal-title"
                    className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100"
                  >
                    {!testDetailModal.ok
                      ? "上游测试失败详情"
                      : testDetailModal.isEmptyWarn
                        ? "上游测试空响应警告"
                        : "上游测试回复详情"}
                  </h3>
                  <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="min-w-0 truncate font-medium text-zinc-700 dark:text-zinc-300">
                      {testDetailModal.modelLabel}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                      {testDetailModal.providerLabel}
                    </span>
                    {testDetailModal.latencyMs > 0 ? (
                      <>
                        <span className="shrink-0" aria-hidden="true">·</span>
                        <span className="shrink-0 font-mono tabular-nums">
                          {testDetailModal.latencyMs}ms
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setTestDetailModal(null)}
                aria-label="关闭详情"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
              <div className="flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span>
                  目标：
                  <code className="font-mono text-zinc-700 dark:text-zinc-300">
                    {testDetailModal.target}
                  </code>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const text = testDetailModal.ok
                      ? (testDetailModal.replyPreview ?? "")
                      : (testDetailModal.error ?? "");
                    void navigator.clipboard
                      ?.writeText(text)
                      .then(() => {
                        setCopiedDetail(true);
                        window.setTimeout(() => setCopiedDetail(false), 1800);
                      })
                      .catch(() => {
                        onToast({ title: "复制失败，请手动复制", status: "error" });
                      });
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {copiedDetail ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-500" />
                      <span>已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>复制内容</span>
                    </>
                  )}
                </button>
              </div>

              <pre className="max-h-[50vh] overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-zinc-800 dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-200">
                {testDetailModal.ok
                  ? (testDetailModal.replyPreview || "(empty text response)")
                  : (testDetailModal.error || "未知错误")}
              </pre>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
      </AnimatePresence>
    </div>
  );
}
