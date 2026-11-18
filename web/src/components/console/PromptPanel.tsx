import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  FileCode2,
  GripVertical,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type HatoConfig,
  type PromptLayersSnapshot,
} from "@/api";
import { ConsoleInput } from "@/components/console/ConsolePrimitives";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Switch } from "@/components/motion/switch";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";

export interface PromptPanelProps {
  promptPath: string;
  initialPrompt: string;
  promptLayers?: PromptLayersSnapshot;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved: (nextPrompt: string, changes?: string[]) => void;
  onLayersSynced?: (next: {
    hatoConfig?: HatoConfig;
    promptPath?: string;
    promptText?: string;
    promptLayers?: PromptLayersSnapshot;
  }) => void;
  onToast: (input: {
    title: string;
    description?: string;
    status?: "info" | "success" | "error";
  }) => void;
}

type PromptKind = "user" | "system" | "soul";

interface OrderedPromptItem {
  token: string;
  kind: PromptKind;
  name: string;
  path: string;
  enabled: boolean;
}

const SAFE_BLOCK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

function normalizeBlockNameInput(raw: string): { ok: true; filename: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  const base = trimmed.endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
  if (!base || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || !SAFE_BLOCK_NAME_RE.test(base)) {
    return {
      ok: false,
      error: "名称仅允许字母、数字、点、短横线或下划线（不能包含空格或路径分隔符）",
    };
  }
  return { ok: true, filename: `${base}.md` };
}

function isTokenDisabled(token: string, disabledList: readonly string[]): boolean {
  const set = new Set(disabledList.map((d) => d.trim()).filter(Boolean));
  if (set.has(token)) return true;
  if (token.startsWith("block:")) {
    const filename = token.slice("block:".length);
    const bare = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
    return set.has(`block:${bare}`) || set.has(filename) || set.has(bare);
  }
  return false;
}

function expandLayersToItems(
  layers: PromptLayersSnapshot | undefined,
  fallbackPath: string,
): OrderedPromptItem[] {
  if (!layers) {
    return [
      {
        token: "soul",
        kind: "soul",
        name: fallbackPath.split("/").pop() || "soul.md",
        path: fallbackPath,
        enabled: true,
      },
    ];
  }

  const blockByRef = new Map<string, { name: string; path: string; content: string }>();
  for (const b of layers.blocks) {
    blockByRef.set(b.name, b);
    if (b.name.endsWith(".md")) {
      blockByRef.set(b.name.slice(0, -3), b);
    }
  }

  const explicitBlockNames = new Set<string>();
  for (const raw of layers.order) {
    const token = raw.trim();
    if (token.startsWith("block:")) {
      const ref = token.slice("block:".length).trim();
      const matched = blockByRef.get(ref) ?? blockByRef.get(`${ref}.md`);
      if (matched) explicitBlockNames.add(matched.name);
    }
  }

  const added = new Set<string>();
  const items: OrderedPromptItem[] = [];
  const soulFilename = layers.soulPath.split("/").pop() || "soul.md";
  const systemFilename = layers.systemPath.split("/").pop() || "system.md";

  const pushSystem = (enabled: boolean) => {
    if (added.has("system")) return;
    added.add("system");
    items.push({
      token: "system",
      kind: "system",
      name: systemFilename,
      path: layers.systemPath,
      enabled,
    });
  };

  const pushSoul = (enabled: boolean) => {
    if (added.has("soul")) return;
    added.add("soul");
    items.push({
      token: "soul",
      kind: "soul",
      name: soulFilename,
      path: layers.soulPath,
      enabled,
    });
  };

  const pushBlock = (b: { name: string; path: string }, forceDisabled = false) => {
    const token = `block:${b.name}`;
    if (added.has(token)) return;
    added.add(token);
    items.push({
      token,
      kind: "user",
      name: b.name,
      path: b.path,
      enabled: !forceDisabled && !isTokenDisabled(token, layers.disabled),
    });
  };

  const wildcardBlocksDisabled = layers.disabled.includes("blocks");

  for (const raw of layers.order) {
    const token = raw.trim();
    if (!token) continue;

    if (token === "blocks") {
      for (const b of layers.blocks) {
        if (explicitBlockNames.has(b.name)) continue;
        pushBlock(b, wildcardBlocksDisabled);
      }
      continue;
    }

    if (token.startsWith("block:")) {
      const ref = token.slice("block:".length).trim();
      const matched = blockByRef.get(ref) ?? blockByRef.get(`${ref}.md`);
      if (matched) pushBlock(matched);
      continue;
    }

    if (token === "system") {
      pushSystem(!isTokenDisabled("system", layers.disabled));
      continue;
    }

    if (token === "soul") {
      pushSoul(!isTokenDisabled("soul", layers.disabled));
    }
  }

  // Ensure items missing from custom order (e.g., disabled-by-omission or newly dropped files) remain visible
  for (const b of layers.blocks) {
    const token = `block:${b.name}`;
    if (!added.has(token)) {
      pushBlock(b, true);
    }
  }
  if (!added.has("system") && (layers.mode === "layered" || layers.systemText.trim().length > 0)) {
    pushSystem(false);
  }
  if (!added.has("soul")) {
    pushSoul(false);
  }

  return items;
}

const KIND_BADGE: Record<PromptKind, { label: string; className: string }> = {
  user: {
    label: "用户",
    className:
      "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  system: {
    label: "系统",
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  soul: {
    label: "人设",
    className:
      "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
};

export function PromptPanel({
  promptPath,
  initialPrompt,
  promptLayers,
  onDirtyChange,
  onSaved,
  onLayersSynced,
  onToast,
}: PromptPanelProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [items, setItems] = useState<OrderedPromptItem[]>(() =>
    expandLayersToItems(promptLayers, promptPath),
  );
  const [baselineItems, setBaselineItems] = useState<OrderedPromptItem[]>(() =>
    expandLayersToItems(promptLayers, promptPath),
  );

  const [soulDraft, setSoulDraft] = useState(
    () => promptLayers?.soulText ?? initialPrompt,
  );
  const [blockDrafts, setBlockDrafts] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const b of promptLayers?.blocks ?? []) {
      map[b.name] = b.content;
    }
    return map;
  });

  const [selectedToken, setSelectedToken] = useState<string>(() => {
    const expanded = expandLayersToItems(promptLayers, promptPath);
    return expanded.find((i) => i.kind === "soul")?.token ?? expanded[0]?.token ?? "soul";
  });
  const [viewMode, setViewMode] = useState<"edit" | "preview">("edit");
  const [savePhase, setSavePhase] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimerRef = useRef<number | null>(null);
  const [draggingToken, setDraggingToken] = useState<string | null>(null);
  const [dragOverToken, setDragOverToken] = useState<string | null>(null);
  const [confirmDeleteBlock, setConfirmDeleteBlock] = useState<string | null>(null);
  const [deletingBlock, setDeletingBlock] = useState(false);

  // Add New User Block Modal State
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newBlockName, setNewBlockName] = useState("");
  const [newBlockContent, setNewBlockContent] = useState("");
  const [newBlockEnabled, setNewBlockEnabled] = useState(true);
  const [newBlockError, setNewBlockError] = useState<string | null>(null);
  const [creatingBlock, setCreatingBlock] = useState(false);

  // Sync incoming snapshots from backend
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const expanded = expandLayersToItems(promptLayers, promptPath);
    setItems(expanded);
    setBaselineItems(expanded);
    setSoulDraft(promptLayers?.soulText ?? initialPrompt);
    const nextBlocks: Record<string, string> = {};
    for (const b of promptLayers?.blocks ?? []) {
      nextBlocks[b.name] = b.content;
    }
    setBlockDrafts(nextBlocks);
    setSelectedToken((prev) =>
      expanded.some((item) => item.token === prev)
        ? prev
        : expanded.find((item) => item.kind === "soul")?.token ?? expanded[0]?.token ?? "soul",
    );
  }, [promptLayers, promptPath, initialPrompt]);

  useEffect(() => {
    if (!confirmDeleteBlock) return;
    const timer = window.setTimeout(() => setConfirmDeleteBlock(null), 3200);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteBlock]);

  const savedSoulText = promptLayers?.soulText ?? initialPrompt;
  const savedBlocksMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of promptLayers?.blocks ?? []) {
      map.set(b.name, b.content);
    }
    return map;
  }, [promptLayers]);

  const getItemContent = useCallback(
    (item: OrderedPromptItem): string => {
      if (item.kind === "soul") return soulDraft;
      if (item.kind === "system") return promptLayers?.systemText ?? "";
      return blockDrafts[item.name] ?? savedBlocksMap.get(item.name) ?? "";
    },
    [soulDraft, promptLayers?.systemText, blockDrafts, savedBlocksMap],
  );

  const isItemContentDirty = useCallback(
    (item: OrderedPromptItem): boolean => {
      if (item.kind === "soul") return soulDraft !== savedSoulText;
      if (item.kind === "user") {
        return (blockDrafts[item.name] ?? "") !== (savedBlocksMap.get(item.name) ?? "");
      }
      return false;
    },
    [soulDraft, savedSoulText, blockDrafts, savedBlocksMap],
  );

  const dirtyBlockNames = useMemo(() => {
    const out: string[] = [];
    for (const b of promptLayers?.blocks ?? []) {
      if ((blockDrafts[b.name] ?? b.content) !== b.content) {
        out.push(b.name);
      }
    }
    return out;
  }, [promptLayers?.blocks, blockDrafts]);

  const soulDirty = soulDraft !== savedSoulText;

  const orderOrEnableDirty = useMemo(() => {
    if (items.length !== baselineItems.length) return true;
    return items.some(
      (item, idx) =>
        item.token !== baselineItems[idx]?.token ||
        item.enabled !== baselineItems[idx]?.enabled,
    );
  }, [items, baselineItems]);

  const anyDirty = soulDirty || dirtyBlockNames.length > 0 || orderOrEnableDirty;

  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);

  useEffect(() => {
    if (!anyDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [anyDirty]);

  const liveCombinedPreview = useMemo(() => {
    const parts: string[] = [];
    for (const item of items) {
      if (!item.enabled) continue;
      const text = getItemContent(item).trim();
      if (text) parts.push(text);
    }
    return parts.join("\n\n");
  }, [items, getItemContent]);

  const enabledItems = useMemo(
    () => items.filter((it) => it.enabled),
    [items],
  );

  const selectedItem =
    items.find((it) => it.token === selectedToken) ?? items[0] ?? null;

  const moveItem = (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    setItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      if (!moved) return prev;
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const reorderByToken = (sourceToken: string, targetToken: string) => {
    if (sourceToken === targetToken) return;
    setItems((prev) => {
      const fromIdx = prev.findIndex((i) => i.token === sourceToken);
      const toIdx = prev.findIndex((i) => i.token === targetToken);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      if (!moved) return prev;
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const toggleItemEnabled = (token: string) => {
    setItems((prev) =>
      prev.map((it) =>
        it.token === token ? { ...it, enabled: !it.enabled } : it,
      ),
    );
  };

  const handleResetDefaultOrder = () => {
    setItems((prev) => {
      const userBlocks = prev
        .filter((it) => it.kind === "user")
        .sort((a, b) => a.name.localeCompare(b.name));
      const system = prev.filter((it) => it.kind === "system");
      const soul = prev.filter((it) => it.kind === "soul");
      return [...userBlocks, ...system, ...soul].map((it) => ({
        ...it,
        enabled: true,
      }));
    });
    onToast({
      title: "已重置为默认顺序（用户提示词 → 系统 → 人设，全部启用）",
      description: "请点击右上角「保存更改」以生效",
      status: "info",
    });
  };

  const handleRevertAll = () => {
    setItems(baselineItems);
    setSoulDraft(savedSoulText);
    const resetBlocks: Record<string, string> = {};
    for (const b of promptLayers?.blocks ?? []) {
      resetBlocks[b.name] = b.content;
    }
    setBlockDrafts(resetBlocks);
    onToast({ title: "已还原全部未保存更改", status: "info" });
  };

  const handleSaveAll = useCallback(async () => {
    if (savePhase === "saving") return;

    setSavePhase("saving");
    try {
      const allChanges: string[] = [];
      let latestHato: HatoConfig | undefined;
      let latestLayers: PromptLayersSnapshot | undefined;
      let latestPromptPath: string | undefined;
      let latestSoulText: string | undefined;

      if (soulDirty) {
        const res = await api.savePrompt(soulDraft);
        if (res.changes?.length) allChanges.push(...res.changes);
        if (res.hatoConfig) latestHato = res.hatoConfig;
        if (res.promptLayers) latestLayers = res.promptLayers;
        if (res.promptPath) latestPromptPath = res.promptPath;
        if (res.promptText !== undefined) latestSoulText = res.promptText;
        onSaved(soulDraft, res.changes);
      }

      for (const blockName of dirtyBlockNames) {
        const res = await api.upsertPromptBlock(
          blockName,
          blockDrafts[blockName] ?? "",
        );
        allChanges.push(`已更新用户提示词 blocks/${blockName}`);
        if (res.hatoConfig) latestHato = res.hatoConfig;
        if (res.promptLayers) latestLayers = res.promptLayers;
        if (res.promptPath) latestPromptPath = res.promptPath;
        if (res.promptText !== undefined) latestSoulText = res.promptText;
      }

      if (orderOrEnableDirty) {
        const nextOrder = items.map((it) => it.token);
        const nextDisabled = items
          .filter((it) => !it.enabled)
          .map((it) => it.token);
        const res = await api.savePromptOrder(nextOrder, nextDisabled);
        if (res.changes?.length) allChanges.push(...res.changes);
        if (res.hatoConfig) latestHato = res.hatoConfig;
        if (res.promptLayers) latestLayers = res.promptLayers;
        if (res.promptPath) latestPromptPath = res.promptPath;
        if (res.promptText !== undefined) latestSoulText = res.promptText;
      }

      onLayersSynced?.({
        hatoConfig: latestHato,
        promptLayers: latestLayers,
        promptPath: latestPromptPath,
        promptText: latestSoulText,
      });

      setSavePhase("saved");
      onToast({
        title: "提示词配置已保存",
        description:
          allChanges.length > 0 ? allChanges.join("；") : "当前已是最新状态",
        status: "success",
      });
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => setSavePhase("idle"), 1600);
    } catch (err) {
      setSavePhase("idle");
      onToast({
        title: "保存提示词失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    }
  }, [
    savePhase,
    soulDirty,
    soulDraft,
    dirtyBlockNames,
    blockDrafts,
    orderOrEnableDirty,
    items,
    onSaved,
    onLayersSynced,
    onToast,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (addModalOpen) {
        if (e.key === "Escape") setAddModalOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveAll();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addModalOpen, handleSaveAll]);

  const handleOpenAddModal = () => {
    setNewBlockName("");
    setNewBlockContent("");
    setNewBlockEnabled(true);
    setNewBlockError(null);
    setAddModalOpen(true);
  };

  const handleCreateUserBlock = async (e: FormEvent) => {
    e.preventDefault();
    const norm = normalizeBlockNameInput(newBlockName);
    if (!norm.ok) {
      setNewBlockError(norm.error);
      return;
    }
    const exists = items.some(
      (it) =>
        it.kind === "user" &&
        it.name.toLowerCase() === norm.filename.toLowerCase(),
    );
    if (exists) {
      setNewBlockError(`提示词块 "${norm.filename}" 已存在，请更换名称`);
      return;
    }

    setCreatingBlock(true);
    try {
      const res = await api.upsertPromptBlock(
        norm.filename,
        newBlockContent,
        newBlockEnabled,
      );
      onLayersSynced?.({
        hatoConfig: res.hatoConfig,
        promptLayers: res.promptLayers,
        promptPath: res.promptPath,
        promptText: res.promptText,
      });
      setAddModalOpen(false);
      setSelectedToken(`block:${norm.filename}`);
      setViewMode("edit");
      onToast({
        title: `已新增用户提示词 ${norm.filename}`,
        description: newBlockEnabled ? "已自动加入提示词编排并启用" : "已创建为禁用状态",
        status: "success",
      });
    } catch (err) {
      setNewBlockError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingBlock(false);
    }
  };

  const handleDeleteUserBlock = async (blockName: string) => {
    if (confirmDeleteBlock !== blockName) {
      setConfirmDeleteBlock(blockName);
      return;
    }
    setDeletingBlock(true);
    try {
      const res = await api.deletePromptBlock(blockName);
      setConfirmDeleteBlock(null);
      onLayersSynced?.({
        hatoConfig: res.hatoConfig,
        promptLayers: res.promptLayers,
        promptPath: res.promptPath,
        promptText: res.promptText,
      });
      onToast({
        title: `已删除用户提示词 ${blockName}`,
        description: "原文件已自动备份为 .bak",
        status: "info",
      });
    } catch (err) {
      onToast({
        title: "删除用户提示词失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setDeletingBlock(false);
    }
  };

  const selectedContent = selectedItem ? getItemContent(selectedItem) : "";
  const selectedLineCount = selectedContent ? selectedContent.split("\n").length : 0;

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:min-h-0">
      {/* Sticky Page Header */}
      <div className="sticky top-0 z-30 shrink-0 border-b border-border bg-background px-6 py-3.5">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="text-base font-semibold tracking-tight text-foreground">
              提示词
            </h1>
            {anyDirty ? (
              <AnimatedBadge status="warning" size="sm">
                有未保存更改
              </AnimatedBadge>
            ) : (
              <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                已启用 {enabledItems.length} / {items.length} 层 · 最终注入{" "}
                {liveCombinedPreview.length} 字符 · ⌘/Ctrl+S 快速保存
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleOpenAddModal}
            >
              <Plus className="size-3.5" />
              新增用户提示词
            </Button>

            {anyDirty ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={savePhase === "saving"}
                onClick={handleRevertAll}
              >
                <RotateCcw className="size-3.5" />
                还原
              </Button>
            ) : null}

            <Button
              type="button"
              size="sm"
              disabled={savePhase === "saving"}
              onClick={() => void handleSaveAll()}
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
                  <span>保存更改</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content: Flat Hairline-Divided Split Pane */}
      <div className="mx-auto grid w-full max-w-[1280px] flex-1 grid-cols-1 divide-y divide-border lg:min-h-0 lg:grid-cols-[340px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:divide-x lg:divide-y-0 lg:overflow-hidden">
        {/* Left Pane: Ordered Prompt Layers */}
        <section
          aria-label="提示词层级列表"
          className="flex flex-col lg:h-full lg:min-h-0"
        >
          <div className="shrink-0 border-b border-border px-5 py-3.5">
            <h2 className="text-xs font-semibold tracking-wide text-foreground">
              提示词编排顺序
            </h2>
          </div>

          <div className="flex-1 divide-y divide-border/60 lg:min-h-0 lg:overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex h-32 items-center justify-center px-4 text-xs text-muted-foreground">
                暂无提示词层级
              </div>
            ) : (
              items.map((item, idx) => {
              const badge = KIND_BADGE[item.kind];
              const isSelected = selectedItem?.token === item.token;
              const charLen = getItemContent(item).trim().length;
              const contentDirty = isItemContentDirty(item);
              const isDragTarget = dragOverToken === item.token && draggingToken !== item.token;

              return (
                <div
                  key={item.token}
                  draggable
                  onDragStart={() => setDraggingToken(item.token)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragOverToken !== item.token) setDragOverToken(item.token);
                  }}
                  onDragLeave={() => {
                    if (dragOverToken === item.token) setDragOverToken(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggingToken) {
                      reorderByToken(draggingToken, item.token);
                    }
                    setDraggingToken(null);
                    setDragOverToken(null);
                  }}
                  onDragEnd={() => {
                    setDraggingToken(null);
                    setDragOverToken(null);
                  }}
                  className={`flex items-center gap-2 border-l-2 px-3.5 py-2.5 transition-colors ${
                    isSelected
                      ? "border-l-primary bg-primary/6"
                      : "border-l-transparent hover:bg-muted/40"
                  } ${
                    isDragTarget
                      ? "bg-primary/10 ring-1 ring-inset ring-primary/50"
                      : ""
                  } ${!item.enabled ? "opacity-55" : ""}`}
                >
                  <span
                    className="cursor-grab text-muted-foreground/60 transition-colors hover:text-foreground"
                    title="拖拽调整顺序"
                    aria-hidden="true"
                  >
                    <GripVertical className="size-3.5" />
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedToken(item.token);
                      setViewMode("edit");
                    }}
                    className="flex min-w-0 flex-1 flex-col gap-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                        #{idx + 1}
                      </span>
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                      <span className="truncate font-mono text-xs font-medium text-foreground">
                        {item.name}
                      </span>
                      {contentDirty ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-amber-500"
                          title="内容有未保存修改"
                        />
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                      <span>{charLen} 字</span>
                    </div>
                  </button>

                  {/* Reorder arrows + Enable/Disable switch */}
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => moveItem(idx, -1)}
                      aria-label={`上移 ${item.name}`}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === items.length - 1}
                      onClick={() => moveItem(idx, 1)}
                      aria-label={`下移 ${item.name}`}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>

                    <Switch
                      className="ml-1"
                      checked={item.enabled}
                      onCheckedChange={() => toggleItemEnabled(item.token)}
                      ariaLabel={`${item.enabled ? "禁用" : "启用"} ${item.name}`}
                    />
                  </div>
                </div>
              );
            }))}
          </div>

          <div className="mt-auto flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3">
            <button
              type="button"
              onClick={handleResetDefaultOrder}
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              恢复默认顺序
            </button>
          </div>
        </section>

        {/* Right Pane: Flat Editor & Live Combined Preview */}
        <section className="flex min-h-[480px] flex-col lg:h-full lg:min-h-0">
          {/* Flat Underline Sub-Tabs Header */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-6">
            <div className="-mb-px flex items-center gap-5" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "edit"}
                onClick={() => setViewMode("edit")}
                className={`inline-flex items-center gap-1.5 border-b-2 py-3 text-xs font-medium transition-colors ${
                  viewMode === "edit"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <FileCode2 className="size-3.5" />
                <span>当前选中项</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "preview"}
                onClick={() => setViewMode("preview")}
                className={`inline-flex items-center gap-1.5 border-b-2 py-3 text-xs font-medium transition-colors ${
                  viewMode === "preview"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Eye className="size-3.5" />
                <span>组合预览</span>
              </button>
            </div>

            {viewMode === "edit" && selectedItem ? (
              <div className="flex items-center gap-2.5 py-2">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {selectedContent.length} 字符 · {selectedLineCount} 行
                </span>
                {selectedItem.kind === "system" ? (
                  <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    <Lock className="size-3" />
                    <span>系统只读</span>
                  </span>
                ) : null}
                {selectedItem.kind === "user" ? (
                  <button
                    type="button"
                    disabled={deletingBlock}
                    onClick={() => void handleDeleteUserBlock(selectedItem.name)}
                    className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                      confirmDeleteBlock === selectedItem.name
                        ? "bg-destructive/15 text-destructive"
                        : "text-destructive hover:bg-destructive/10"
                    }`}
                  >
                    <Trash2 className="size-3.5" />
                    <span>
                      {confirmDeleteBlock === selectedItem.name ? "确认删除?" : "删除"}
                    </span>
                  </button>
                ) : null}
              </div>
            ) : viewMode === "preview" ? (
              <span className="py-2 text-xs text-muted-foreground tabular-nums">
                {enabledItems.length} 个启用层 · {liveCombinedPreview.length} 字符
              </span>
            ) : null}
          </div>

          {viewMode === "edit" ? (
            selectedItem ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${KIND_BADGE[selectedItem.kind].className}`}
                    >
                      {KIND_BADGE[selectedItem.kind].label}
                    </span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {selectedItem.path}
                    </span>
                  </div>
                </div>

                {selectedItem.kind === "system" ? (
                  <textarea
                    readOnly
                    value={selectedContent}
                    aria-label="系统提示词只读查看"
                    className="min-h-[360px] w-full flex-1 resize-none rounded-lg bg-muted/30 p-4 font-mono text-[13px] leading-relaxed text-muted-foreground focus:outline-none lg:min-h-0"
                  />
                ) : (
                  <textarea
                    value={selectedContent}
                    onChange={(e) => {
                      const nextVal = e.target.value;
                      if (selectedItem.kind === "soul") {
                        setSoulDraft(nextVal);
                      } else {
                        setBlockDrafts((prev) => ({
                          ...prev,
                          [selectedItem.name]: nextVal,
                        }));
                      }
                    }}
                    spellCheck={false}
                    placeholder={
                      selectedItem.kind === "user"
                        ? "输入注入到模型系统上下文中的用户自定义提示词内容…"
                        : "输入人设定义（soul.md）…"
                    }
                    aria-label={`编辑 ${selectedItem.name}`}
                    className="min-h-[360px] w-full flex-1 resize-none rounded-lg bg-muted/25 p-4 font-mono text-[13px] leading-relaxed text-foreground transition-colors placeholder:text-muted-foreground/60 focus:bg-muted/35 focus:ring-1 focus:ring-ring/40 focus:outline-none lg:min-h-0"
                  />
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-4 text-xs text-muted-foreground">
                暂无可编辑的提示词层级
              </div>
            )
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">注入链路：</span>
                {enabledItems.length === 0 ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    全部提示词均已禁用（当前不注入任何静态系统提示词）
                  </span>
                ) : (
                  enabledItems.map((it, idx) => (
                    <span key={it.token} className="inline-flex items-center gap-1">
                      {idx > 0 ? (
                        <span className="text-muted-foreground/60">→</span>
                      ) : null}
                      <span
                        className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${KIND_BADGE[it.kind].className}`}
                      >
                        {it.name}
                      </span>
                    </span>
                  ))
                )}
              </div>

              <textarea
                readOnly
                value={liveCombinedPreview}
                aria-label="最终组合提示词预览"
                placeholder="（当前无可注入的提示词内容）"
                className="min-h-[360px] w-full flex-1 resize-none rounded-lg bg-muted/30 p-4 font-mono text-[13px] leading-relaxed text-foreground focus:outline-none lg:min-h-0"
              />
            </div>
          )}
        </section>
      </div>

      {/* Add User Prompt Block Modal */}
      <AnimatePresence>
        {addModalOpen ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-user-prompt-title"
          >
            <div
              onClick={() => setAddModalOpen(false)}
              className="fixed inset-0 bg-black/50 backdrop-blur-[2px]"
            />

            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.12, ease: EASE_OUT } }}
              transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
              className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
            >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2
                  id="add-user-prompt-title"
                  className="text-sm font-semibold text-foreground"
                >
                  新增用户提示词
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  保存在 prompts/blocks/ 下，可随时调整注入顺序与启停状态
                </p>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => setAddModalOpen(false)}
                aria-label="关闭弹窗"
              >
                <X className="size-4" />
              </Button>
            </div>

            <form
              onSubmit={(e) => void handleCreateUserBlock(e)}
              className="flex flex-col gap-4 p-5"
            >
              {newBlockError ? (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  <AlertCircle className="size-4 shrink-0" />
                  <span>{newBlockError}</span>
                </div>
              ) : null}

              <ConsoleInput
                id="new-prompt-block-name"
                label="提示词块文件名 *"
                autoFocus
                value={newBlockName}
                onChange={(val) => {
                  setNewBlockError(null);
                  setNewBlockName(val);
                }}
                placeholder="例如 01-user-rules 或 reply-style.md"
              />

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="new-prompt-block-content"
                  className="text-xs font-medium text-muted-foreground"
                >
                  提示词内容
                </label>
                <textarea
                  id="new-prompt-block-content"
                  rows={8}
                  value={newBlockContent}
                  onChange={(e) => setNewBlockContent(e.target.value)}
                  placeholder="输入希望注入的规则、背景信息或风格要求…"
                  className="w-full resize-y rounded-xl border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                <div className="text-xs font-medium text-foreground">
                  创建后立即启用并加入编排
                </div>
                <Switch
                  ariaLabel="创建后立即启用并加入编排"
                  checked={newBlockEnabled}
                  onCheckedChange={setNewBlockEnabled}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setAddModalOpen(false)}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={creatingBlock}
                >
                  {creatingBlock ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      <span>创建中…</span>
                    </>
                  ) : (
                    <>
                      <Plus className="size-3.5" />
                      <span>创建提示词</span>
                    </>
                  )}
                </Button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      ) : null}
      </AnimatePresence>
    </div>
  );
}
