import {
  AlertCircle,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  Loader2,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type TicketSummary, type WorkerActivityItem } from "@/api";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

const ACTIVE_STATUSES = new Set(["routing", "pending", "running", "needs_input", "awaiting_confirm"]);

function formatStatusLabel(status: string): string {
  switch (status) {
    case "routing":
      return "路由分析中";
    case "pending":
      return "排队中";
    case "running":
      return "执行中";
    case "needs_input":
      return "等待补充";
    case "awaiting_confirm":
      return "等待确认";
    case "done":
      return "已完成";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "已中止";
    default:
      return status;
  }
}

function statusBadgeVariant(
  status: string,
): "neutral" | "success" | "warning" | "danger" {
  if (status === "done") return "success";
  if (status === "failed") return "danger";
  if (status === "awaiting_confirm" || status === "needs_input") return "warning";
  return "neutral";
}

function formatClockTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) {
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}:${String(remMin).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatDurationMs(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

interface CommandTerminalBlockProps {
  item: WorkerActivityItem;
  onCopyText: (text: string, label: string) => void;
}

function CommandTerminalBlock({ item, onCopyText }: CommandTerminalBlockProps) {
  const lines = useMemo(() => (item.output ? item.output.split(/\r?\n/) : []), [item.output]);
  const isLong = lines.length > 18;
  const [expanded, setExpanded] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (item.state === "running" && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [item.output, item.state]);

  const visibleOutput = useMemo(() => {
    if (!item.output) return "";
    if (!isLong || expanded || item.state === "running") return item.output;
    return `${lines.slice(0, 8).join("\n")}\n... (${lines.length - 14} 行已折叠) ...\n${lines.slice(-6).join("\n")}`;
  }, [expanded, isLong, item.output, item.state, lines]);

  const durationLabel = formatDurationMs(item.durationMs);

  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-zinc-800/90 bg-zinc-950 text-zinc-100 shadow-inner">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 bg-zinc-900/80 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
          <span className="shrink-0 select-none text-emerald-400">$</span>
          <span className="truncate text-zinc-100" title={item.command || item.title}>
            {item.command || item.title}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {durationLabel && (
            <span className="font-mono text-[11px] tabular-nums text-zinc-400">
              {durationLabel}
            </span>
          )}
          {typeof item.exitCode === "number" && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                item.exitCode === 0
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-red-500/20 text-red-300",
              )}
            >
              exit {item.exitCode}
            </span>
          )}
          {(item.output || item.command) && (
            <button
              type="button"
              aria-label="复制命令与输出"
              title="复制命令与输出"
              onClick={() =>
                onCopyText(
                  [item.command ? `$ ${item.command}` : "", item.output || ""]
                    .filter(Boolean)
                    .join("\n"),
                  "命令输出",
                )
              }
              className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            >
              <Copy className="size-3" />
            </button>
          )}
        </div>
      </div>

      {visibleOutput ? (
        <pre
          ref={preRef}
          className={cn(
            "overflow-x-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-zinc-200",
            item.state === "running" && "max-h-64 overflow-y-auto",
            expanded && "max-h-[28rem] overflow-y-auto",
          )}
        >
          {visibleOutput}
          {item.state === "running" && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-emerald-400 align-middle" />
          )}
        </pre>
      ) : item.state === "running" ? (
        <div className="flex items-center gap-2 px-3 py-2.5 font-mono text-[11.5px] text-zinc-400">
          <span>正在执行并等待标准输出</span>
          <span className="inline-block h-3.5 w-1.5 animate-pulse bg-emerald-400" />
        </div>
      ) : null}

      {isLong && item.state !== "running" && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-center gap-1 border-t border-zinc-800/80 bg-zinc-900/50 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
        >
          {expanded ? (
            <>
              收起输出 <ChevronDown className="size-3 rotate-180" />
            </>
          ) : (
            <>
              展开全部 {lines.length} 行 <ChevronDown className="size-3" />
            </>
          )}
        </button>
      )}
    </div>
  );
}

function ToolActivityRow({ item }: { item: WorkerActivityItem }) {
  const [open, setOpen] = useState(false);
  const hasOutput = Boolean(item.output && item.output.trim());
  const durationLabel = formatDurationMs(item.durationMs);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={!hasOutput}
          onClick={() => hasOutput && setOpen((v) => !v)}
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-left text-xs text-foreground/90",
            hasOutput && "hover:text-foreground cursor-pointer",
          )}
        >
          <Wrench className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{item.title}</span>
          {hasOutput && (
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
          )}
        </button>
        {durationLabel && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {durationLabel}
          </span>
        )}
      </div>
      {open && hasOutput && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-md border border-border/70 bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
          {item.output}
        </pre>
      )}
    </div>
  );
}

export interface TicketInspectorDrawerProps {
  ticketId: string | null;
  activeTickets: TicketSummary[];
  onSelectTicket: (ticketId: string) => void;
  onClose: () => void;
  onConfirmTicket: (ticketId: string, approved: boolean) => Promise<void>;
  onTicketMutated: () => Promise<void>;
  onToast: (opts: {
    title: string;
    description?: string;
    status?: "success" | "error" | "info";
  }) => void;
}

export function TicketInspectorDrawer({
  ticketId,
  activeTickets,
  onSelectTicket,
  onClose,
  onConfirmTicket,
  onTicketMutated,
  onToast,
}: TicketInspectorDrawerProps) {
  const [ticket, setTicket] = useState<TicketSummary | null>(null);
  const [items, setItems] = useState<WorkerActivityItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setConfirmingAbort(false);
    setAutoScroll(true);
    if (!ticketId) {
      setTicket(null);
      setItems([]);
      setConnected(false);
      return;
    }

    const fallback = activeTickets.find((t) => t.id === ticketId) ?? null;
    if (fallback) {
      setTicket(fallback);
    }
    setItems([]);

    const unsub = api.subscribeTicketStream(
      ticketId,
      (ev) => {
        setConnected(true);
        if (ev.type === "snapshot") {
          setTicket(ev.ticket);
          setItems(ev.items);
        } else if (ev.type === "ticket") {
          setTicket(ev.ticket);
        } else if (ev.type === "item") {
          setItems((prev) => {
            const idx = prev.findIndex(
              (x) =>
                x.id === ev.item.id ||
                (Boolean(ev.item.stepKey) && x.stepKey === ev.item.stepKey),
            );
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = ev.item;
              return next;
            }
            return [...prev, ev.item];
          });
        }
      },
      () => {
        setConnected(false);
      },
    );

    return unsub;
  }, [ticketId]);

  const isRunning = Boolean(ticket && ACTIVE_STATUSES.has(ticket.status));

  useEffect(() => {
    if (!ticketId || !isRunning) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ticketId, isRunning]);

  useEffect(() => {
    if (!ticketId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ticketId, onClose]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = viewportRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 42;
    setAutoScroll(nearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    setAutoScroll(true);
  }, []);

  const handleCopyText = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        onToast({ title: `已复制${label}`, status: "success" });
      } catch (err) {
        onToast({
          title: "复制失败",
          description: err instanceof Error ? err.message : String(err),
          status: "error",
        });
      }
    },
    [onToast],
  );

  const handleAbort = async () => {
    if (!ticket) return;
    setActionBusy(true);
    try {
      const res = await api.abortTicket(ticket.id);
      onToast({ title: "已中止后台任务", description: res.message, status: "info" });
      setConfirmingAbort(false);
      await onTicketMutated();
    } catch (err) {
      onToast({
        title: "中止任务失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setActionBusy(false);
    }
  };

  const handleConfirm = async (approved: boolean) => {
    if (!ticket) return;
    setActionBusy(true);
    try {
      await onConfirmTicket(ticket.id, approved);
    } finally {
      setActionBusy(false);
    }
  };

  const elapsedMs = ticket
    ? isRunning
      ? Math.max(0, nowMs - ticket.createdAt)
      : Math.max(0, ticket.updatedAt - ticket.createdAt)
    : 0;

  const switcherTickets = useMemo(() => {
    if (!ticket) return activeTickets;
    if (activeTickets.some((t) => t.id === ticket.id)) return activeTickets;
    return [ticket, ...activeTickets];
  }, [activeTickets, ticket]);

  return (
    <AnimatePresence>
      {ticketId && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/45 backdrop-blur-[1px]"
          />

          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="Worker 实时执行详情"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.24, ease: EASE_OUT }}
            className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-border bg-background shadow-2xl"
          >
            {/* Header */}
            <div className="shrink-0 border-b border-border/80 bg-card/70 px-4 py-3.5 sm:px-5">
              {switcherTickets.length > 1 && (
                <div className="mb-2.5 flex items-center gap-1.5 overflow-x-auto pb-1">
                  {switcherTickets.map((t) => {
                    const selected = t.id === ticketId;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onSelectTicket(t.id)}
                        className={cn(
                          "flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors",
                          selected
                            ? "border-primary/40 bg-accent text-foreground font-medium"
                            : "border-border/70 bg-background/70 text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            ACTIVE_STATUSES.has(t.status)
                              ? "bg-primary animate-pulse"
                              : "bg-muted-foreground/60",
                          )}
                        />
                        <span className="max-w-36 truncate">{t.briefTitle}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <AnimatedBadge
                      status={statusBadgeVariant(ticket?.status ?? "running")}
                      size="sm"
                      pulse={ticket?.status === "running" || ticket?.status === "routing"}
                    >
                      {formatStatusLabel(ticket?.status ?? "running")}
                    </AnimatedBadge>
                    {ticket?.backend && (
                      <span className="rounded border border-border/80 bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {ticket.backend}
                      </span>
                    )}
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatElapsed(elapsedMs)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          connected ? "bg-emerald-500" : "bg-amber-500",
                        )}
                      />
                      {connected ? "实时流" : "连接中"}
                    </span>
                  </div>

                  <h2 className="mt-1.5 truncate text-sm font-semibold text-foreground">
                    {ticket?.briefTitle || `工单 ${ticketId}`}
                  </h2>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-mono">{ticket?.id ?? ticketId}</span>
                    {ticket?.workspaceDir && (
                      <button
                        type="button"
                        onClick={() => void handleCopyText(ticket.workspaceDir!, "工作区路径")}
                        title={`点击复制工作区路径: ${ticket.workspaceDir}`}
                        className="inline-flex min-w-0 max-w-full items-center gap-1 truncate font-mono hover:text-foreground"
                      >
                        <FolderOpen className="size-3 shrink-0" />
                        <span className="truncate">{ticket.workspaceDir}</span>
                      </button>
                    )}
                  </div>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="关闭执行详情"
                  onClick={onClose}
                  className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>

            {/* Live Timeline & Command Output Body */}
            <div className="relative min-h-0 flex-1">
              <div
                ref={viewportRef}
                onScroll={handleScroll}
                className="h-full overflow-y-auto px-4 py-4 sm:px-5"
              >
                {items.length === 0 ? (
                  <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
                    {isRunning ? (
                      <>
                        <Loader2 className="size-5 animate-spin text-primary" />
                        <p className="text-xs font-medium text-foreground">
                          {ticket?.progressNote || "正在初始化 Worker 执行环境..."}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          命令调用与标准输出到达后将在此实时滚动展示
                        </p>
                      </>
                    ) : (
                      <>
                        <Terminal className="size-5 text-muted-foreground" />
                        <p className="text-xs text-muted-foreground">
                          {ticket?.progressNote || "该工单未留下可回放的命令或流式输出记录"}
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <ol className="relative ml-2 border-l border-border/80 pl-4">
                    {items.map((item) => {
                      const isErr = item.state === "error" || item.kind === "error";
                      const isActive = item.state === "running";

                      return (
                        <li key={item.id} className="relative pb-4 last:pb-1">
                          {/* Timeline node */}
                          <span
                            className={cn(
                              "absolute -left-[21px] top-0.5 flex size-2.5 items-center justify-center rounded-full ring-4 ring-background",
                              isErr
                                ? "bg-destructive"
                                : isActive
                                  ? "bg-primary"
                                  : item.kind === "lifecycle"
                                    ? "bg-muted-foreground/50"
                                    : "bg-emerald-500/85",
                            )}
                          />

                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="font-mono tabular-nums">
                              {formatClockTime(item.timestamp)}
                            </span>
                            {isActive && (
                              <span className="inline-flex items-center gap-1 text-primary">
                                <Loader2 className="size-3 animate-spin" />
                                运行中
                              </span>
                            )}
                            {item.state === "done" && item.kind === "command" && (
                              <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                                <Check className="size-3" />
                                完成
                              </span>
                            )}
                            {isErr && (
                              <span className="inline-flex items-center gap-0.5 text-destructive">
                                <AlertCircle className="size-3" />
                                异常
                              </span>
                            )}
                          </div>

                          {item.kind === "command" ? (
                            <CommandTerminalBlock item={item} onCopyText={handleCopyText} />
                          ) : item.kind === "tool" ? (
                            <div className="mt-1">
                              <ToolActivityRow item={item} />
                            </div>
                          ) : item.kind === "stderr" || item.kind === "error" ? (
                            <div className="mt-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                              <div className="text-xs font-medium text-destructive">
                                {item.title}
                              </div>
                              {(item.output || item.text) && (
                                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/85">
                                  {item.output || item.text}
                                </pre>
                              )}
                            </div>
                          ) : item.kind === "assistant" ? (
                            <div className="mt-1 rounded-lg border border-border/65 bg-card/65 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">
                              {item.text}
                              {isActive && (
                                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle" />
                              )}
                            </div>
                          ) : (
                            <div className="mt-0.5">
                              <div className="text-xs font-medium text-foreground/90">
                                {item.title}
                              </div>
                              {item.text && (
                                <p className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-muted-foreground">
                                  {item.text}
                                </p>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              {!autoScroll && items.length > 0 && (
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="absolute bottom-3 right-5 inline-flex items-center gap-1.5 rounded-full border border-border bg-popover/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-md backdrop-blur transition-colors hover:bg-accent"
                >
                  <ArrowDown className="size-3.5 text-primary" />
                  跟随最新输出
                </button>
              )}
            </div>

            {/* Footer Controls */}
            {(ticket?.status === "awaiting_confirm" || isRunning) && (
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/80 bg-card/70 px-4 py-3 sm:px-5">
                {ticket?.status === "awaiting_confirm" ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      该任务请求确认高危操作，请核对上方执行记录后选择：
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={actionBusy}
                        onClick={() => void handleConfirm(true)}
                      >
                        允许执行
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={actionBusy}
                        onClick={() => void handleConfirm(false)}
                      >
                        取消任务
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="truncate text-xs text-muted-foreground">
                      {ticket?.progressNote || "Worker 正在后台运行"}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      {confirmingAbort ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={actionBusy}
                            onClick={() => void handleAbort()}
                            className="border-destructive/50 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            确认中止
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={actionBusy}
                            onClick={() => setConfirmingAbort(false)}
                          >
                            返回
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={actionBusy}
                          onClick={() => setConfirmingAbort(true)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Square className="size-3 fill-current" />
                          中止任务
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
