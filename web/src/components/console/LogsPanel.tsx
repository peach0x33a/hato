import { ArrowDown, Copy, Pause, Play, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type RuntimeLogEntry } from "@/api";
import { ConsoleInput, ConsolePageHeader } from "@/components/console/ConsolePrimitives";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { cn } from "@/lib/utils";

const MAX_CLIENT_LOGS = 1000;
const CATEGORIES = ["ALL", "ERR", "WARN", "SYS", "LLM", "MSG"] as const;
type LogCategoryFilter = (typeof CATEGORIES)[number];

const CATEGORY_BADGE_CLASS: Record<string, string> = {
  ERR: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
  WARN: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  SYS: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  LLM: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30",
  MSG: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
};

export interface LogsPanelProps {
  onToast: (opts: { title: string; description?: string; status?: "success" | "error" }) => void;
}

export function LogsPanel({ onToast }: LogsPanelProps) {
  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const [category, setCategory] = useState<LogCategoryFilter>("ALL");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsub = api.subscribeLogStream(
      (ev) => {
        setConnected(true);
        if (pausedRef.current) return;
        if (ev.type === "snapshot") {
          setLogs(ev.logs.slice(-MAX_CLIENT_LOGS));
        } else if (ev.type === "log") {
          setLogs((prev) => {
            if (prev.length > 0 && prev[prev.length - 1]!.id === ev.entry.id) {
              return prev;
            }
            const next = [...prev, ev.entry];
            return next.length > MAX_CLIENT_LOGS ? next.slice(next.length - MAX_CLIENT_LOGS) : next;
          });
        }
      },
      () => {
        setConnected(false);
      },
    );
    return unsub;
  }, []);

  const counts = useMemo(() => {
    let err = 0;
    let warn = 0;
    for (const item of logs) {
      if (item.category === "ERR") err += 1;
      else if (item.category === "WARN") warn += 1;
    }
    return { err, warn };
  }, [logs]);

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((item) => {
      if (category !== "ALL" && item.category !== category) return false;
      if (!q) return true;
      return (
        item.scope.toLowerCase().includes(q) ||
        item.message.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [logs, category, query]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = viewportRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredLogs, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
    setAutoScroll(nearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    setAutoScroll(true);
  }, []);

  const handleCopy = useCallback(async () => {
    if (filteredLogs.length === 0) return;
    const text = filteredLogs
      .map((item) => `[${item.timeText}] [${item.category}] [${item.scope}] ${item.message}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      onToast({ title: "已复制日志", description: `共 ${filteredLogs.length} 条`, status: "success" });
    } catch (err) {
      onToast({
        title: "复制失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    }
  }, [filteredLogs, onToast]);

  const handleTogglePause = useCallback(async () => {
    const next = !paused;
    setPaused(next);
    if (!next) {
      try {
        const res = await api.getLogs({ limit: 300 });
        setLogs(res.logs.slice(-MAX_CLIENT_LOGS));
      } catch {
        // Ignore refresh error; live stream will continue delivering.
      }
    }
  }, [paused]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ConsolePageHeader
        title="服务端日志"
        description="实时查看进程内存中的运行日志（最多保留最近 1000 条）"
        className="px-4 pt-4 sm:px-6"
        badges={
          <AnimatedBadge
            status={paused ? "warning" : connected ? "success" : "danger"}
          >
            {paused ? "已暂停" : connected ? "实时连接" : "重连中"}
          </AnimatedBadge>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleTogglePause()}
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {paused ? "继续" : "暂停"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLogs([])}
              disabled={logs.length === 0}
            >
              <Trash2 className="size-3.5" />
              清屏
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleCopy()}
              disabled={filteredLogs.length === 0}
            >
              <Copy className="size-3.5" />
              复制
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5 sm:px-6">
        <div className="flex flex-wrap items-center gap-1.5">
          {CATEGORIES.map((cat) => {
            const active = category === cat;
            const badgeCount = cat === "ERR" ? counts.err : cat === "WARN" ? counts.warn : 0;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                  active
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/70 bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <span>{cat === "ALL" ? "全部" : cat}</span>
                {badgeCount > 0 && (
                  <span
                    className={cn(
                      "rounded px-1 text-[10px] leading-4 tabular-nums",
                      cat === "ERR"
                        ? "bg-red-500/20 text-red-600 dark:text-red-400"
                        : "bg-amber-500/20 text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {badgeCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <ConsoleInput
            size="sm"
            value={query}
            onChange={setQuery}
            placeholder="过滤模块或关键词…"
            className="pl-8 pr-7"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="清除搜索"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-muted/20">
        <div
          ref={viewportRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed sm:px-6"
        >
          {filteredLogs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {logs.length === 0 ? "暂无服务端日志" : "没有匹配当前筛选条件的日志"}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredLogs.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    "flex items-start gap-2 rounded px-1.5 py-0.5 hover:bg-muted/50",
                    entry.category === "ERR" && "bg-red-500/5",
                    entry.category === "WARN" && "bg-amber-500/5",
                  )}
                >
                  <span className="shrink-0 text-muted-foreground/80 tabular-nums">
                    {entry.timeText}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded border px-1.5 py-0 text-[10px] font-semibold leading-4",
                      CATEGORY_BADGE_CLASS[entry.category] ??
                        "border-border bg-muted text-foreground",
                    )}
                  >
                    {entry.category}
                  </span>
                  <span className="shrink-0 font-semibold text-foreground/80">
                    [{entry.scope}]
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 whitespace-pre-wrap break-all",
                      entry.category === "ERR"
                        ? "text-red-600 dark:text-red-400"
                        : entry.category === "WARN"
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-foreground/90",
                    )}
                  >
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {!autoScroll && filteredLogs.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={scrollToBottom}
            className="absolute bottom-4 right-6 shadow-md"
          >
            <ArrowDown className="size-3.5" />
            回到底部
          </Button>
        )}
      </div>
    </div>
  );
}
