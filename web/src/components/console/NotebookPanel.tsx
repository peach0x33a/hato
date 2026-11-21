import {
  BookMarked,
  Check,
  Copy,
  Edit3,
  Eye,
  FileText,
  Image as ImageIcon,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type NotebookEntryKind,
  type NotebookEntryRecord,
  type NotebookStats,
} from "@/api";
import { ConsoleInput } from "@/components/console/ConsolePrimitives";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Card, CardContent } from "@/components/motion/card";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";

export interface NotebookPanelProps {
  onToast: (t: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
}

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const KIND_FILTERS: Array<{ id: NotebookEntryKind | "all"; label: string }> = [
  { id: "all", label: "全部" },
  { id: "text", label: "纯文本" },
  { id: "image", label: "图片" },
  { id: "mixed", label: "图文" },
];

function splitTags(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,，、/|]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

function formatDateTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

function kindMeta(kind: NotebookEntryKind): { label: string; icon: typeof FileText } {
  switch (kind) {
    case "image":
      return { label: "图片", icon: ImageIcon };
    case "mixed":
      return { label: "图文", icon: Layers };
    default:
      return { label: "纯文本", icon: FileText };
  }
}

function indexStatusMeta(status: NotebookEntryRecord["indexStatus"]): {
  label: string;
  badge: "success" | "warning" | "danger" | "neutral";
} {
  switch (status) {
    case "synced":
      return { label: "已建索引", badge: "success" };
    case "degraded":
      return { label: "索引降级", badge: "warning" };
    case "denied":
    case "error":
      return { label: "索引失败", badge: "danger" };
    default:
      return { label: "仅本地", badge: "neutral" };
  }
}

function NotebookImagePreview({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed) {
    return <ImageIcon className="size-6 text-muted-foreground/50" aria-label={alt} />;
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function NotebookPanel({ onToast }: NotebookPanelProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [entries, setEntries] = useState<NotebookEntryRecord[]>([]);
  const [stats, setStats] = useState<NotebookStats>({
    total: 0,
    textCount: 0,
    imageCount: 0,
    mixedCount: 0,
    syncedCount: 0,
  });
  const [memoryConfigured, setMemoryConfigured] = useState(false);
  const [usedSemanticIndex, setUsedSemanticIndex] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<NotebookEntryKind | "all">("all");

  const [viewing, setViewing] = useState<NotebookEntryRecord | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<NotebookEntryRecord | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formSummary, setFormSummary] = useState("");
  const [formReason, setFormReason] = useState("");
  const [formTags, setFormTags] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formImageDataUrl, setFormImageDataUrl] = useState<string | null>(null);
  const [formRemoveImage, setFormRemoveImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadEntries = useCallback(
    async (opts?: { q?: string; kind?: NotebookEntryKind | "all" }) => {
      const q = opts?.q !== undefined ? opts.q : query;
      const kind = opts?.kind !== undefined ? opts.kind : kindFilter;
      setLoading(true);
      try {
        const res = await api.listNotebook({ q, kind });
        setEntries(res.entries ?? []);
        if (res.stats) setStats(res.stats);
        setMemoryConfigured(Boolean(res.memoryConfigured));
        setUsedSemanticIndex(Boolean(res.usedSemanticIndex));
      } catch (err) {
        onToast({
          title: "加载小本本失败",
          description: err instanceof Error ? err.message : String(err),
          status: "error",
        });
      } finally {
        setLoading(false);
      }
    },
    [kindFilter, onToast, query],
  );

  useEffect(() => {
    void loadEntries({ q: "", kind: "all" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!viewing && !editorOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editorOpen) setEditorOpen(false);
        else setViewing(null);
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [editorOpen, viewing]);

  const openCreateModal = () => {
    setEditingEntry(null);
    setFormTitle("");
    setFormSummary("");
    setFormReason("");
    setFormTags("");
    setFormContent("");
    setFormImageDataUrl(null);
    setFormRemoveImage(false);
    setEditorOpen(true);
  };

  const openEditModal = (entry: NotebookEntryRecord) => {
    setEditingEntry(entry);
    setFormTitle(entry.title);
    setFormSummary(entry.summary);
    setFormReason(entry.reason);
    setFormTags(entry.tags.join(", "));
    setFormContent(entry.content);
    setFormImageDataUrl(null);
    setFormRemoveImage(false);
    setEditorOpen(true);
  };

  const handleImageFile = (file: File | null | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type)) {
      onToast({ title: "不支持的图片格式", description: "仅支持 PNG / JPG / WEBP / GIF", status: "error" });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      onToast({ title: "图片过大", description: "单张图片不能超过 12MB", status: "error" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setFormImageDataUrl(reader.result);
        setFormRemoveImage(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmitEditor = async () => {
    const summary = formSummary.trim();
    const reason = formReason.trim();
    const content = formContent;
    const hasExistingImage = Boolean(editingEntry?.hasImage && !formRemoveImage);
    const hasAnyImage = Boolean(formImageDataUrl || hasExistingImage);

    if (!summary) {
      onToast({ title: "请填写概要", status: "error" });
      return;
    }
    if (!reason) {
      onToast({ title: "请填写存入原因", status: "error" });
      return;
    }
    if (!content.trim() && !hasAnyImage) {
      onToast({ title: "纯文本内容和图片至少填写一项", status: "error" });
      return;
    }

    setSaving(true);
    try {
      if (editingEntry) {
        const res = await api.updateNotebookEntry(editingEntry.id, {
          title: formTitle.trim(),
          summary,
          reason,
          tags: splitTags(formTags),
          content,
          ...(formImageDataUrl ? { imageDataUrl: formImageDataUrl } : {}),
          ...(formRemoveImage && !formImageDataUrl ? { removeImage: true } : {}),
        });
        setEntries((prev) => prev.map((e) => (e.id === editingEntry.id ? res.entry : e)));
        if (viewing?.id === editingEntry.id) setViewing(res.entry);
        setEditorOpen(false);
        onToast({ title: "小本本条目已更新", status: "success" });
      } else {
        const res = await api.createNotebookEntry({
          title: formTitle.trim() || undefined,
          summary,
          reason,
          tags: splitTags(formTags),
          content: content.trim() ? content : undefined,
          ...(formImageDataUrl ? { imageDataUrl: formImageDataUrl } : {}),
        });
        setEditorOpen(false);
        onToast({ title: "已记入小本本", description: res.entry.id, status: "success" });
        await loadEntries({ q: query, kind: kindFilter });
        return;
      }
      await loadEntries({ q: query, kind: kindFilter });
    } catch (err) {
      onToast({
        title: editingEntry ? "更新失败" : "保存失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (entry: NotebookEntryRecord) => {
    const label = entry.title || entry.summary || entry.id;
    if (!window.confirm(`确定要从小本本删除「${label}」吗？关联的记忆索引也会一并清理。`)) {
      return;
    }
    try {
      await api.deleteNotebookEntry(entry.id);
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      if (viewing?.id === entry.id) setViewing(null);
      if (editingEntry?.id === entry.id) setEditorOpen(false);
      onToast({ title: "已删除小本本条目", status: "info" });
      await loadEntries({ q: query, kind: kindFilter });
    } catch (err) {
      onToast({
        title: "删除失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    }
  };

  const handleReindex = async () => {
    setReindexing(true);
    try {
      const res = await api.reindexNotebook(false);
      onToast({
        title: res.ok ? "索引同步完成" : "部分索引同步失败",
        description:
          res.errorMessage || `共处理 ${res.total} 条：成功 ${res.synced}，失败 ${res.failed}`,
        status: res.ok ? "success" : "error",
      });
      await loadEntries({ q: query, kind: kindFilter });
    } catch (err) {
      onToast({
        title: "索引同步失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setReindexing(false);
    }
  };

  const handleCopyText = async (entry: NotebookEntryRecord) => {
    try {
      await navigator.clipboard.writeText(entry.content);
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((prev) => (prev === entry.id ? null : prev)), 1500);
    } catch {
      onToast({ title: "复制失败", status: "error" });
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <BookMarked className="size-4 text-primary" />
            Hato 的小本本
            <AnimatedBadge status={memoryConfigured ? "success" : "neutral"} size="sm">
              {memoryConfigured ? "记忆索引已接入" : "仅本地索引"}
            </AnimatedBadge>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            共 {stats.total} 条 · 文本 {stats.textCount} · 图片 {stats.imageCount} · 图文{" "}
            {stats.mixedCount}
            {memoryConfigured ? ` · 已同步索引 ${stats.syncedCount}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={openCreateModal}>
            <Plus className="size-3.5" />
            新建条目
          </Button>
          {memoryConfigured ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reindexing}
              onClick={() => void handleReindex()}
            >
              <Sparkles className={`size-3.5 ${reindexing ? "animate-pulse" : ""}`} />
              {reindexing ? "同步中…" : "补齐索引"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadEntries({ q: query, kind: kindFilter })}
            title="刷新"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {KIND_FILTERS.map((f) => {
            const active = kindFilter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setKindFilter(f.id);
                  void loadEntries({ q: query, kind: f.id });
                }}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/70 bg-background/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                {f.label}
              </button>
            );
          })}
          {query.trim() && usedSemanticIndex ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              <Sparkles className="size-3" />
              语义+本地联合召回
            </span>
          ) : null}
        </div>

        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <ConsoleInput
              value={query}
              onChange={(val) => setQuery(val)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void loadEntries({ q: query, kind: kindFilter });
              }}
              placeholder="搜标题、概要、存入原因、标签或正文…"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadEntries({ q: query, kind: kindFilter })}
          >
            <Search className="size-3.5" />
            搜索
          </Button>
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("");
                void loadEntries({ q: "", kind: kindFilter });
              }}
            >
              清空
            </Button>
          ) : null}
        </div>
      </div>

      {loading && entries.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-14 text-center">
            <RefreshCw className="size-6 animate-spin text-muted-foreground" />
            <div className="text-xs text-muted-foreground">正在翻开 Hato 的小本本…</div>
          </CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/80 bg-card/30 px-6 py-16 text-center">
          <div className="grid size-12 place-items-center rounded-2xl border border-border/60 bg-muted/40 text-muted-foreground">
            <BookMarked className="size-6" />
          </div>
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">
              {query.trim() ? "没有找到匹配的条目" : "小本本还是空的"}
            </div>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              这里用来沉淀需要长期复用的纯文本、参考图片、模板与重要备忘。Hato
              在聊天中会自己决定什么时候记一笔，你也可以直接在这里新建或维护。
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => {
            const kMeta = kindMeta(entry.kind);
            const KindIcon = kMeta.icon;
            const idxMeta = indexStatusMeta(entry.indexStatus);
            return (
              <Card key={entry.id} className="flex flex-col overflow-hidden">
                <CardContent className="flex flex-1 flex-col gap-2.5 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                        <KindIcon className="size-3 text-primary" />
                        {kMeta.label}
                      </span>
                      <AnimatedBadge status={idxMeta.badge} size="sm">
                        {idxMeta.label}
                      </AnimatedBadge>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setViewing(entry)}
                        title="查看详情"
                        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Eye className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditModal(entry)}
                        title="编辑"
                        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Edit3 className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(entry)}
                        title="删除"
                        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>

                  {entry.hasImage ? (
                    <button
                      type="button"
                      onClick={() => setViewing(entry)}
                      className="group relative flex h-36 w-full items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-muted/30"
                    >
                      <NotebookImagePreview
                        src={api.notebookImageUrl(entry.id, entry.updatedAt)}
                        alt={entry.title || entry.summary}
                        className="max-h-full max-w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                      />
                    </button>
                  ) : null}

                  <div className="space-y-1">
                    {entry.title ? (
                      <h3 className="line-clamp-1 text-sm font-semibold text-foreground">
                        {entry.title}
                      </h3>
                    ) : null}
                    <p className="line-clamp-2 text-xs font-medium text-foreground/90">
                      {entry.summary}
                    </p>
                  </div>

                  <div className="rounded-lg border border-border/60 bg-muted/35 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground/80">原因：</span>
                    <span className="line-clamp-2">{entry.reason}</span>
                  </div>

                  {entry.hasText ? (
                    <p className="line-clamp-3 whitespace-pre-wrap break-words rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                      {entry.content}
                    </p>
                  ) : null}

                  {entry.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {entry.tags.slice(0, 4).map((tag) => (
                        <span
                          key={tag}
                          className="rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          #{tag}
                        </span>
                      ))}
                      {entry.tags.length > 4 ? (
                        <span className="px-1 text-[10px] text-muted-foreground">
                          +{entry.tags.length - 4}
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="mt-auto flex items-center justify-between pt-1 text-[10px] text-muted-foreground">
                    <span className="truncate font-mono">{entry.id}</span>
                    <span className="shrink-0">
                      {formatDateTime(entry.updatedAt)} · 翻阅 {entry.accessCount} 次
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      <AnimatePresence>
        {viewing ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={
              reduceMotion
                ? undefined
                : { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } }
            }
            onClick={() => setViewing(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={
                reduceMotion
                  ? undefined
                  : { opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.12, ease: EASE_OUT } }
              }
              transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[90dvh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-2xl border border-border/80 bg-background p-5 shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-muted-foreground">{viewing.id}</span>
                    <AnimatedBadge status={indexStatusMeta(viewing.indexStatus).badge} size="sm">
                      {indexStatusMeta(viewing.indexStatus).label}
                    </AnimatedBadge>
                  </div>
                  <h3 className="text-base font-semibold text-foreground">
                    {viewing.title || viewing.summary}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setViewing(null)}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                >
                  <X className="size-4" />
                </button>
              </div>

              {viewing.hasImage ? (
                <div className="flex max-h-80 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-muted/30 p-2">
                  <NotebookImagePreview
                    src={api.notebookImageUrl(viewing.id, viewing.updatedAt)}
                    alt={viewing.title || viewing.summary}
                    className="max-h-72 max-w-full rounded-lg object-contain"
                  />
                </div>
              ) : null}

              <div className="grid gap-2 rounded-xl border border-border/70 bg-muted/30 p-3 text-xs">
                <div>
                  <span className="font-medium text-foreground">概要：</span>
                  <span className="text-muted-foreground">{viewing.summary}</span>
                </div>
                <div>
                  <span className="font-medium text-foreground">存入原因：</span>
                  <span className="text-muted-foreground">{viewing.reason}</span>
                </div>
                {viewing.tags.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="font-medium text-foreground">标签：</span>
                    {viewing.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded border border-border/70 bg-background/80 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        #{t}
                      </span>
                    ))}
                  </div>
                ) : null}
                {viewing.indexError ? (
                  <div className="text-[11px] text-amber-600 dark:text-amber-400">
                    索引提示：{viewing.indexError}
                  </div>
                ) : null}
              </div>

              {viewing.hasText ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">正文内容</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleCopyText(viewing)}
                    >
                      {copiedId === viewing.id ? (
                        <>
                          <Check className="size-3.5 text-emerald-500" />
                          已复制
                        </>
                      ) : (
                        <>
                          <Copy className="size-3.5" />
                          复制正文
                        </>
                      )}
                    </Button>
                  </div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/70 bg-muted/25 p-3 font-mono text-xs leading-relaxed text-foreground">
                    {viewing.content}
                  </pre>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
                <span className="text-[11px] text-muted-foreground">
                  创建于 {formatDateTime(viewing.createdAt)} · 更新于{" "}
                  {formatDateTime(viewing.updatedAt)} · 翻阅 {viewing.accessCount} 次
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const target = viewing;
                      setViewing(null);
                      openEditModal(target);
                    }}
                  >
                    <Edit3 className="size-3.5" />
                    编辑
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleDelete(viewing)}
                  >
                    <Trash2 className="size-3.5" />
                    删除
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Create / Edit Modal */}
      <AnimatePresence>
        {editorOpen ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={
              reduceMotion
                ? undefined
                : { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } }
            }
            onClick={() => setEditorOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={
                reduceMotion
                  ? undefined
                  : { opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.12, ease: EASE_OUT } }
              }
              transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
              onClick={(e) => e.stopPropagation()}
              onPaste={(e) => {
                const items = Array.from(e.clipboardData?.items ?? []);
                const imageItem = items.find((i) => i.type.startsWith("image/"));
                if (imageItem) {
                  handleImageFile(imageItem.getAsFile());
                }
              }}
              className="flex max-h-[90dvh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-2xl border border-border/80 bg-background p-5 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  {editingEntry ? `编辑小本本条目 (${editingEntry.id})` : "新建小本本条目"}
                </h3>
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                >
                  <X className="size-3.5" />
                </button>
              </div>

              <form
                className="flex flex-col gap-3.5 text-xs"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSubmitEditor();
                }}
              >
                <label className="flex flex-col gap-1">
                  <span className="font-medium">标题（可选）</span>
                  <ConsoleInput
                    value={formTitle}
                    onChange={setFormTitle}
                    placeholder="例如：Hato 角色三视图 / 常用服务器排查命令"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-medium">
                    概要 <span className="text-destructive">*</span>
                  </span>
                  <ConsoleInput
                    value={formSummary}
                    onChange={setFormSummary}
                    placeholder="一句话概括里面存了什么"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-medium">
                    存入原因 <span className="text-destructive">*</span>
                  </span>
                  <ConsoleInput
                    value={formReason}
                    onChange={setFormReason}
                    placeholder="为什么要存、以后什么时候会复用"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-medium">标签（空格或逗号分隔，可选）</span>
                  <ConsoleInput
                    value={formTags}
                    onChange={setFormTags}
                    placeholder="例如：人设 三视图 参考图"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-medium">纯文本内容（与图片至少填一项）</span>
                  <textarea
                    value={formContent}
                    onChange={(e) => setFormContent(e.target.value)}
                    rows={5}
                    placeholder="原样保存的文本、Prompt、命令、地址或清单…"
                    className="w-full rounded-xl border border-input bg-background/80 px-3 py-2 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
                  />
                </label>

                <div className="flex flex-col gap-1.5">
                  <span className="font-medium">图片附件（支持点击上传、拖拽或 Ctrl/Cmd+V 粘贴）</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => handleImageFile(e.target.files?.[0])}
                  />
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleImageFile(e.dataTransfer.files?.[0]);
                    }}
                    className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 bg-muted/25 p-3 text-center"
                  >
                    {formImageDataUrl ? (
                      <div className="flex w-full flex-col items-center gap-2">
                        <img
                          src={formImageDataUrl}
                          alt="预览"
                          className="max-h-44 rounded-lg object-contain"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputRef.current?.click()}
                          >
                            更换图片
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setFormImageDataUrl(null);
                              if (editingEntry?.hasImage) setFormRemoveImage(true);
                            }}
                          >
                            清除
                          </Button>
                        </div>
                      </div>
                    ) : editingEntry?.hasImage && !formRemoveImage ? (
                      <div className="flex w-full flex-col items-center gap-2">
                        <NotebookImagePreview
                          src={api.notebookImageUrl(editingEntry.id, editingEntry.updatedAt)}
                          alt={editingEntry.title || editingEntry.summary}
                          className="max-h-44 rounded-lg object-contain"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputRef.current?.click()}
                          >
                            替换图片
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setFormRemoveImage(true)}
                          >
                            移除图片
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex flex-col items-center gap-1.5 py-2 text-muted-foreground hover:text-foreground"
                      >
                        <Upload className="size-5" />
                        <span>点击选择图片，或直接拖入 / 粘贴图片（≤12MB）</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditorOpen(false)}
                  >
                    取消
                  </Button>
                  <Button type="submit" size="sm" disabled={saving}>
                    {saving ? "保存中…" : editingEntry ? "保存修改" : "存入小本本"}
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
