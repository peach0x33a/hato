import { Edit3, RefreshCw, Search, Smile, Trash2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { api, type StickerRecord } from "@/api";
import { ConsoleInput } from "@/components/console/ConsolePrimitives";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Card, CardContent } from "@/components/motion/card";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";

export interface StickersPanelProps {
  onToast: (t: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[\s,，、/|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function StickerImage({
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
    return <Smile className="size-6 text-muted-foreground/50" aria-label={alt} />;
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

export function StickersPanel({ onToast }: StickersPanelProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [stickers, setStickers] = useState<StickerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<StickerRecord | null>(null);
  const [editCaption, setEditCaption] = useState("");
  const [editEmotions, setEditEmotions] = useState("");
  const [editScenes, setEditScenes] = useState("");
  const [editStyle, setEditStyle] = useState("");
  const [saving, setSaving] = useState(false);

  const loadStickers = useCallback(
    async (searchQuery?: string) => {
      setLoading(true);
      try {
        const res = await api.listStickers(searchQuery);
        setStickers(res.stickers ?? []);
      } catch (err) {
        onToast({
          title: "加载表情包库失败",
          description: err instanceof Error ? err.message : String(err),
          status: "error",
        });
      } finally {
        setLoading(false);
      }
    },
    [onToast],
  );

  useEffect(() => {
    void loadStickers();
  }, [loadStickers]);

  useEffect(() => {
    if (!editing) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEditing(null);
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [editing]);

  const openEditor = (item: StickerRecord) => {
    setEditing(item);
    setEditCaption(item.caption);
    setEditEmotions(item.emotions.join(", "));
    setEditScenes(item.scenes.join(", "));
    setEditStyle(item.style);
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const res = await api.updateSticker(editing.id, {
        caption: editCaption.trim(),
        emotions: splitTags(editEmotions),
        scenes: splitTags(editScenes),
        style: editStyle.trim(),
      });
      setStickers((prev) => prev.map((s) => (s.id === editing.id ? res.sticker : s)));
      setEditing(null);
      onToast({ title: "表情包标签已更新", status: "success" });
    } catch (err) {
      onToast({
        title: "更新失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: StickerRecord) => {
    if (!window.confirm(`确定要删除表情包「${item.caption || item.id}」吗？`)) return;
    try {
      await api.deleteSticker(item.id);
      setStickers((prev) => prev.filter((s) => s.id !== item.id));
      if (editing?.id === item.id) setEditing(null);
      onToast({ title: "已删除表情包", status: "info" });
    } catch (err) {
      onToast({
        title: "删除失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <Smile className="size-4 text-primary" />
            表情包库
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">共 {stickers.length} 张</p>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <ConsoleInput
              value={query}
              onChange={(val) => setQuery(val)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void loadStickers(query);
              }}
              placeholder="搜索情绪、语境或画面…"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadStickers(query)}
          >
            <Search className="size-3.5" />
            搜索
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              void loadStickers("");
            }}
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {loading && stickers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-14 text-center">
            <RefreshCw className="size-6 animate-spin text-muted-foreground" />
            <div className="text-xs text-muted-foreground">正在加载表情包库…</div>
          </CardContent>
        </Card>
      ) : stickers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-14 text-center">
            <Smile className="size-8 text-muted-foreground/50" />
            <div className="text-sm font-medium text-foreground">暂无表情包</div>
            <p className="max-w-md text-xs text-muted-foreground">
              可以在 Telegram / QQ 中对 Hato 说「我给你发一堆表情包你保存下来」，或直接发送 TG 贴纸包链接让她导入。
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stickers.map((item) => (
            <Card key={item.id} className="overflow-hidden">
              <CardContent className="flex gap-3 p-3.5">
                <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-muted/30">
                  <StickerImage
                    src={api.stickerImageUrl(item.id)}
                    alt={item.caption || item.id}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <AnimatedBadge
                        status={
                          item.status === "ready"
                            ? "success"
                            : item.status === "pending"
                              ? "warning"
                              : "danger"
                        }
                        size="sm"
                      >
                        {item.status === "ready"
                          ? "已量化"
                          : item.status === "pending"
                            ? "标注中"
                            : "失败"}
                      </AnimatedBadge>
                      {item.tgFileId ? (
                        <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                          TG原生
                        </span>
                      ) : null}
                      {item.emoji ? <span className="text-xs">{item.emoji}</span> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEditor(item)}
                        title="编辑标签"
                        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Edit3 className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(item)}
                        title="删除"
                        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>

                  <p className="line-clamp-2 text-xs font-medium text-foreground">
                    {item.caption || "(待标注)"}
                  </p>

                  {item.emotions.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {item.emotions.slice(0, 4).map((emo) => (
                        <span
                          key={emo}
                          className="rounded border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {emo}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-auto flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="truncate">{item.setName ? `包: ${item.setName}` : item.style || item.source}</span>
                    <span className="font-mono">用过 {item.useCount} 次</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AnimatePresence>
        {editing ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } }}
            onClick={() => setEditing(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.12, ease: EASE_OUT } }}
              transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[90dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-2xl border border-border/80 bg-background p-5 shadow-2xl"
            >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">编辑表情包语义标签</h3>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
              >
                <X className="size-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-muted/30">
                <StickerImage
                  src={api.stickerImageUrl(editing.id)}
                  alt={editing.id}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              <div className="text-xs text-muted-foreground">
                <div className="font-mono">{editing.id}</div>
                {editing.setName ? <div>贴纸包：{editing.setName}</div> : null}
              </div>
            </div>

            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSaveEdit();
              }}
            >
              <div className="flex flex-col gap-3 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="font-medium">画面描述与文字</span>
                  <ConsoleInput value={editCaption} onChange={setEditCaption} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-medium">情绪标签（逗号或空格分隔）</span>
                  <ConsoleInput value={editEmotions} onChange={setEditEmotions} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-medium">适用语境（逗号或空格分隔）</span>
                  <ConsoleInput value={editScenes} onChange={setEditScenes} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-medium">画风 / 角色</span>
                  <ConsoleInput value={editStyle} onChange={setEditStyle} />
                </label>
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "保存中…" : "保存"}
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
