import {
  Activity,
  Bot,
  Compass,
  Database,
  ImagePlus,
  RefreshCw,
  Terminal,
  Trash2,
  User,
  X,
} from "lucide-react";
import { type ChangeEvent, type ClipboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ChatSessionRecord,
  type ChatSseEvent,
  type SlotView,
  type StoredMessageRecord,
  type TicketSummary,
  type TurnTelemetry,
  type TurnTraceRecord,
} from "@/api";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import {
  Message,
  MessageAvatar,
  MessageBubble,
  MessageBubbleContent,
  MessageBubbleGroup,
  MessageContent,
  MessageFooter,
  MessageHeader,
  MessageMarker,
  MessageScroller,
} from "@/components/agents/message";
import { PromptInput } from "@/components/agents/prompt-input";
import { ApiBadge, SlotBadge } from "@/components/console/ConsolePrimitives";
import { MarkdownContent } from "@/components/console/MarkdownContent";
import { StaticsPanel } from "@/components/console/StaticsPanel";
import { TrajectoryPanel } from "@/components/console/TrajectoryPanel";
import {
  Alert,
  AlertAction,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@/components/motion/alert";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { MorphingLightbox, type LightboxImage } from "@/components/motion/morphing-lightbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/motion/tabs";

interface UiChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  bubbles: string[];
  images?: string[];
  createdAt: number;
  telemetry?: TurnTelemetry;
}

interface PendingImage {
  id: string;
  data: string;
  mimeType: string;
  previewUrl: string;
  name: string;
}

export interface ChatPanelProps {
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
  onPendingTakeoverChange: (pending: boolean) => void;
  onOpenBrowserPanel: () => void;
  onAuthError: () => void;
  pendingTakeover: boolean;
  selectedSessionId?: string | null;
  onSelectSession?: (id: string | null) => void;
  onSessionsChanged?: () => void;
}

function mapStoredToUi(records: StoredMessageRecord[]): UiChatItem[] {
  return records.map((rec) => ({
    id: rec.id,
    role: rec.role === "executed_event" ? "system" : rec.role,
    bubbles:
      rec.bubbles && rec.bubbles.length > 0
        ? rec.bubbles
        : rec.content
          ? [rec.content]
          : [],
    createdAt: rec.createdAt,
  }));
}

const ACTIVE_TICKET_STATUSES = new Set([
  "routing",
  "pending",
  "running",
  "needs_input",
  "awaiting_confirm",
]);

function formatTicketStatusLabel(status: string): string {
  switch (status) {
    case "routing":
      return "路由规划中";
    case "pending":
      return "排队中";
    case "running":
      return "后台执行中";
    case "needs_input":
      return "等待补充说明";
    case "awaiting_confirm":
      return "等待确认执行";
    default:
      return status;
  }
}

function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function ChatPanel({
  onToast,
  onPendingTakeoverChange,
  onOpenBrowserPanel,
  onAuthError,
  pendingTakeover,
  selectedSessionId = null,
  onSelectSession,
  onSessionsChanged,
}: ChatPanelProps) {
  const [subTab, setSubTab] = useState<"chat" | "trajectory" | "stats">("chat");
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [readonlySession, setReadonlySession] = useState<ChatSessionRecord | null>(null);
  const [items, setItems] = useState<UiChatItem[]>([]);
  const [slots, setSlots] = useState<SlotView[]>([]);
  const [summaryText, setSummaryText] = useState("");
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [earlyStatus, setEarlyStatus] = useState<string>("正在处理…");
  const [historyState, setHistoryState] = useState<"loading" | "error" | "ready">("loading");
  const [historyError, setHistoryError] = useState("");
  const [hoverTraceOpen, setHoverTraceOpen] = useState(false);
  const [hoverMemoryOpen, setHoverMemoryOpen] = useState(false);
  const [latestTrace, setLatestTrace] = useState<TurnTraceRecord | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [slashBusy, setSlashBusy] = useState(false);
  const [activeTickets, setActiveTickets] = useState<TicketSummary[]>([]);
  const [ticketActionBusy, setTicketActionBusy] = useState<string | null>(null);
  const prevActiveCountRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadLatestTrace = async () => {
    setTraceLoading(true);
    try {
      const res = await api.getStatics({ limit: 1, sessionId: selectedSessionId });
      setLatestTrace(res.traces[0] ?? null);
    } catch {
      // Non-fatal in hover preview.
    } finally {
      setTraceLoading(false);
    }
  };

  const personaSlot = useMemo(
    () => slots.find((s) => s.slot === "persona"),
    [slots],
  );

  const loadHistory = async (targetSessionId = selectedSessionId) => {
    setHistoryState("loading");
    setHistoryError("");
    try {
      const res = await api.getChatHistory(targetSessionId);
      setReadonlySession(res.readonly ? (res.session ?? null) : null);
      setItems(mapStoredToUi(res.messages));
      setSlots(res.slots);
      setSummaryText(res.summaryText || "");
      onPendingTakeoverChange(res.pendingTakeover);
      setHistoryState("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unauthorized") || msg.includes("401")) {
        onAuthError();
      } else {
        setHistoryError(msg);
        setHistoryState("error");
      }
    }
  };

  const syncTicketsAndHistory = async (targetSessionId = selectedSessionId) => {
    if (targetSessionId) return;
    try {
      const ticketRes = await api.getTickets();
      const nextActive = ticketRes.tickets.filter((t) => ACTIVE_TICKET_STATUSES.has(t.status));
      const hadActive = prevActiveCountRef.current > 0;
      prevActiveCountRef.current = nextActive.length;
      setActiveTickets(nextActive);

      if (nextActive.length > 0 || hadActive) {
        const h = await api.getChatHistory(null);
        setItems(mapStoredToUi(h.messages));
        setSlots(h.slots);
        setSummaryText(h.summaryText || "");
        onPendingTakeoverChange(h.pendingTakeover);
        if (hadActive && nextActive.length === 0) {
          setSessionEpoch((n) => n + 1);
        }
      }
    } catch {
      // Ignore transient poll errors.
    }
  };

  useEffect(() => {
    void loadHistory(selectedSessionId);
    if (!selectedSessionId) {
      void syncTicketsAndHistory(null);
    } else {
      setActiveTickets([]);
      prevActiveCountRef.current = 0;
    }
  }, [selectedSessionId]);

  useEffect(() => {
    if (selectedSessionId || activeTickets.length === 0) return;
    const timer = window.setInterval(() => {
      void syncTicketsAndHistory(null);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [selectedSessionId, activeTickets.length]);

  const handleConfirmTicket = async (ticketId: string, approved: boolean) => {
    setTicketActionBusy(ticketId);
    try {
      const res = await api.confirmTicket(ticketId, approved);
      onToast({
        title: approved ? "已确认执行" : "已取消工单",
        description: res.message,
        status: "info",
      });
      await syncTicketsAndHistory(null);
    } catch (err) {
      onToast({
        title: "工单确认失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setTicketActionBusy(null);
    }
  };

  const readFileAsPendingImage = (file: File): Promise<PendingImage | null> =>
    new Promise((resolve) => {
      if (!file.type.startsWith("image/")) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const comma = result.indexOf(",");
        if (comma < 0) {
          resolve(null);
          return;
        }
        resolve({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          data: result.slice(comma + 1),
          mimeType: file.type,
          previewUrl: result,
          name: file.name || "image",
        });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });

  const appendFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).slice(0, Math.max(0, 4 - pendingImages.length));
    const parsed = (await Promise.all(arr.map(readFileAsPendingImage))).filter(
      (img): img is PendingImage => img !== null,
    );
    if (parsed.length > 0) {
      setPendingImages((prev) => [...prev, ...parsed].slice(0, 4));
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      void appendFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void appendFiles(files);
    }
  };

  const runSlashCommand = async (rawCmd: string) => {
    const cmd = rawCmd.trim();
    if (!cmd || streaming || slashBusy) return;
    setSlashBusy(true);
    try {
      let replyText = "";
      await api.sendChatStream({ text: cmd, images: [] }, (evt: ChatSseEvent) => {
        if (evt.type === "slash_reply") {
          replyText = evt.text;
        } else if (evt.type === "error") {
          throw new Error(evt.message);
        }
      });

      const lower = cmd.toLowerCase();
      if (lower.startsWith("/new")) {
        setItems([]);
        setSummaryText("");
        setLatestTrace(null);
        setSessionEpoch((n) => n + 1);
        onSessionsChanged?.();
        onToast({
          title: "已开启新对话",
          description: replyText || "当前上下文已清空。",
          status: "success",
        });
      } else if (lower.startsWith("/compact")) {
        await api
          .getChatHistory(selectedSessionId)
          .then((h) => {
            setSlots(h.slots);
            setSummaryText(h.summaryText || "");
          })
          .catch(() => undefined);
        setSessionEpoch((n) => n + 1);
        onToast({
          title: "压缩记忆",
          description: replyText || "操作完成",
          status: "info",
        });
      } else if (lower.startsWith("/trace")) {
        await loadLatestTrace();
        setHoverTraceOpen(true);
      } else {
        if (lower.startsWith("/reload") || lower.startsWith("/model")) {
          await api
            .getChatHistory(selectedSessionId)
            .then((h) => {
              setSlots(h.slots);
              setSummaryText(h.summaryText || "");
            })
            .catch(() => undefined);
        }
        onToast({
          title: cmd.split(/\s+/)[0] || "指令执行结果",
          description: replyText || "已完成",
          status: "info",
        });
      }
    } catch (err) {
      onToast({
        title: "指令执行失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setSlashBusy(false);
    }
  };

  const sendMessage = async (rawText: string) => {
    const text = rawText.trim();
    if ((!text && pendingImages.length === 0) || streaming || slashBusy) return;

    // Never inject temporary slash command bubbles into the chat viewport.
    if (text.startsWith("/") && pendingImages.length === 0) {
      setDraft("");
      await runSlashCommand(text);
      return;
    }

    const imagesToSend = pendingImages.map((img) => ({
      data: img.data,
      mimeType: img.mimeType,
    }));
    const userPreviewUrls = pendingImages.map((img) => img.previewUrl);

    setDraft("");
    setPendingImages([]);
    setStreaming(true);
    setEarlyStatus("正在生成回复…");

    const userMsgId = `local-user-${Date.now()}`;
    const assistantMsgId = `local-assistant-${Date.now()}`;

    setItems((prev) => [
      ...prev,
      {
        id: userMsgId,
        role: "user",
        bubbles: text ? [text] : ["[图片消息]"],
        images: userPreviewUrls,
        createdAt: Date.now(),
      },
      {
        id: assistantMsgId,
        role: "assistant",
        bubbles: [],
        images: [],
        createdAt: Date.now(),
      },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await api.sendChatStream(
        { text, images: imagesToSend },
        (evt: ChatSseEvent) => {
          if (evt.type === "early_bubbles") {
            setEarlyStatus("正在执行操作…");
            setItems((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, bubbles: [...m.bubbles, ...evt.bubbles] }
                  : m,
              ),
            );
          } else if (evt.type === "photo") {
            setItems((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      images: [...(m.images ?? []), evt.dataUrl],
                      ...(evt.caption ? { bubbles: [...m.bubbles, evt.caption] } : {}),
                    }
                  : m,
              ),
            );
          } else if (evt.type === "assistant_bubbles") {
            setItems((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      bubbles: [...m.bubbles, ...evt.bubbles],
                      telemetry: evt.telemetry,
                    }
                  : m,
              ),
            );
          } else if (evt.type === "done") {
            onPendingTakeoverChange(evt.pendingTakeover);
            setSessionEpoch((n) => n + 1);
            void syncTicketsAndHistory(selectedSessionId);
          } else if (evt.type === "error") {
            onToast({ title: "消息发送失败", description: evt.message, status: "error" });
            setItems((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, bubbles: [...m.bubbles, `错误：${evt.message}`] }
                  : m,
              ),
            );
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        onToast({ title: "发送失败", description: msg, status: "error" });
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  return (
    <Tabs
      variant="underline"
      value={subTab}
      onValueChange={(v) => setSubTab(v as "chat" | "trajectory" | "stats")}
      className="flex h-full min-h-0 min-w-0 w-full flex-col gap-0 overflow-hidden"
    >
      {/* Flat Top Header: 对话 | 轨迹 | 统计 + Model & Quick Actions */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-background px-3 py-1 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <TabsList wrapperClassName="w-auto shrink-0" className="shrink-0 border-b-0">
            <TabsTrigger value="chat" className="py-2 text-xs">对话</TabsTrigger>
            <TabsTrigger value="trajectory" className="py-2 text-xs">轨迹</TabsTrigger>
            <TabsTrigger value="stats" className="py-2 text-xs">统计</TabsTrigger>
          </TabsList>

          {personaSlot && (
            <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
              <SlotBadge slot={personaSlot.slot} />
              <span
                className="truncate font-mono text-[11px] font-medium text-foreground"
                title={personaSlot.target}
              >
                {personaSlot.target}
              </span>
              <ApiBadge api={personaSlot.api} />
            </div>
          )}
          {pendingTakeover && (
            <AnimatedBadge status="warning" size="sm" pulse>
              浏览器待接管
            </AnimatedBadge>
          )}
        </div>

        {subTab === "chat" && (
          <div className="flex flex-wrap items-center gap-1">
            {readonlySession ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => onSelectSession?.(null)}
              >
                回到当前会话
              </Button>
            ) : (
              <>
                {/* Hover Popover: 查看 Trace */}
                <div
                  className="relative"
                  onMouseEnter={() => {
                    setHoverTraceOpen(true);
                    void loadLatestTrace();
                  }}
                  onMouseLeave={() => setHoverTraceOpen(false)}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setHoverTraceOpen(false);
                      setSubTab("trajectory");
                    }}
                  >
                    <Activity className="size-3.5" />
                    查看 Trace
                  </Button>

                  {hoverTraceOpen && (
                    <div className="absolute top-full right-0 z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-3 text-xs shadow-md">
                      <div className="mb-2 flex items-center justify-between border-b border-border/70 pb-1.5">
                        <span className="font-medium text-foreground">最近一次调用 Trace</span>
                        <button
                          type="button"
                          onClick={() => {
                            setHoverTraceOpen(false);
                            setSubTab("trajectory");
                          }}
                          className="text-[11px] text-primary hover:underline"
                        >
                          查看完整轨迹 →
                        </button>
                      </div>
                      {traceLoading && !latestTrace ? (
                        <div className="py-3 text-center text-muted-foreground">读取中…</div>
                      ) : !latestTrace ? (
                        <div className="py-2 text-muted-foreground">当前会话暂无 Trace 记录</div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <SlotBadge slot={latestTrace.slot} className="h-4 px-1 text-[10px]" />
                            <span className="truncate font-mono text-[11px] text-foreground">
                              {latestTrace.provider}/{latestTrace.modelId}
                            </span>
                            <ApiBadge api={latestTrace.api} className="h-4 px-1 text-[10px]" />
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                            <span>
                              命中率:{" "}
                              <strong className="text-foreground">
                                {(latestTrace.cacheHitRate * 100).toFixed(1)}%
                              </strong>
                            </span>
                            <span>
                              耗时: <strong className="text-foreground">{latestTrace.latencyMs}ms</strong>
                            </span>
                            <span>
                              首字: {latestTrace.ttftMs !== null ? `${latestTrace.ttftMs}ms` : "--"}
                            </span>
                            <span>
                              输出: {latestTrace.outputTokens} tok
                              {latestTrace.tps !== null ? ` (${latestTrace.tps.toFixed(0)}/s)` : ""}
                            </span>
                          </div>
                          {latestTrace.timeCardText && (
                            <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                              {latestTrace.timeCardText}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Hover Popover + Click Trigger: 压缩记忆 */}
                <div
                  className="relative"
                  onMouseEnter={() => setHoverMemoryOpen(true)}
                  onMouseLeave={() => setHoverMemoryOpen(false)}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={streaming || slashBusy}
                    onClick={() => void runSlashCommand("/compact")}
                  >
                    <Database className="size-3.5" />
                    压缩记忆
                  </Button>

                  {hoverMemoryOpen && (
                    <div className="absolute top-full right-0 z-50 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-3 text-xs shadow-md">
                      <div className="mb-1.5 flex items-center justify-between border-b border-border/70 pb-1.5">
                        <span className="font-medium text-foreground">工作记忆摘要预览</span>
                        <span className="text-[10px] text-muted-foreground">点击按钮触发压缩</span>
                      </div>
                      {summaryText.trim() ? (
                        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground">
                          {summaryText}
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          当前暂无滚动摘要；当对话消息达到阈值后会自动或手动整理到此区域。
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={streaming || slashBusy}
                  onClick={() => void runSlashCommand("/new")}
                >
                  <Terminal className="size-3.5" />
                  清空上下文
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={historyState === "loading" || streaming}
              onClick={() => void loadHistory(selectedSessionId)}
            >
              <RefreshCw
                className={`size-3.5 ${historyState === "loading" ? "animate-spin" : ""}`}
              />
              刷新记录
            </Button>
          </div>
        )}
      </div>

      {readonlySession && (
        <div className="flex min-h-8 shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-3 py-1 text-xs sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-medium text-primary">
              只读历史会话
            </span>
            <span className="text-border">·</span>
            <span className="truncate font-medium text-foreground">{readonlySession.title}</span>
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
              · {readonlySession.messageCount} 条消息 · {readonlySession.traceCount} 次调用
            </span>
          </div>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">只读模式</span>
        </div>
      )}

      <TabsContent value="chat" className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col gap-0 overflow-hidden">
        {activeTickets.length > 0 && !readonlySession && (
          <div className="shrink-0 border-b border-border/80 bg-muted/25 px-3 py-2 sm:px-6">
            <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
              {activeTickets.map((tk) => (
                <div
                  key={tk.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <AnimatedBadge
                      status={
                        tk.status === "awaiting_confirm" || tk.status === "needs_input"
                          ? "warning"
                          : "neutral"
                      }
                      size="sm"
                      pulse={tk.status === "running" || tk.status === "routing"}
                    >
                      {formatTicketStatusLabel(tk.status)}
                    </AnimatedBadge>
                    <span className="truncate font-medium text-foreground">
                      {tk.briefTitle}
                    </span>
                    <span className="hidden shrink-0 rounded border border-border/70 bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
                      {tk.backend}
                    </span>
                    {tk.progressNote && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        · {tk.progressNote}
                      </span>
                    )}
                  </div>
                  {tk.status === "awaiting_confirm" && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        disabled={ticketActionBusy === tk.id}
                        onClick={() => void handleConfirmTicket(tk.id, true)}
                      >
                        允许执行
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        disabled={ticketActionBusy === tk.id}
                        onClick={() => void handleConfirmTicket(tk.id, false)}
                      >
                        取消
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {pendingTakeover && (
          <div className="shrink-0 border-b border-amber-500/25 bg-amber-500/5 px-3 py-2 sm:px-6">
            <div className="mx-auto max-w-3xl">
              <Alert variant="warning" open className="border-0 bg-transparent p-0">
                <AlertIcon />
                <AlertContent>
                  <AlertTitle>浏览器等待手动操作</AlertTitle>
                  <AlertDescription>
                    请在远程浏览器中点击「接管操作」完成登录、验证码或确认，完成后即可继续任务。
                  </AlertDescription>
                  <AlertAction>
                    <Button type="button" size="sm" onClick={onOpenBrowserPanel}>
                      <Compass className="size-3.5" />
                      前往浏览器
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={streaming}
                      onClick={() => void sendMessage("我已操作完成，继续")}
                    >
                      继续任务
                    </Button>
                  </AlertAction>
                </AlertContent>
              </Alert>
            </div>
          </div>
        )}

        <MessageScroller
          className="min-h-0 flex-1 overflow-hidden bg-background"
          contentClassName="mx-auto flex w-full max-w-3xl flex-col gap-5 px-3 py-4 sm:px-6"
        >
          {historyState === "error" && (
            <Alert variant="destructive" open>
              <AlertIcon />
              <AlertContent>
                <AlertTitle>历史记录加载失败</AlertTitle>
                <AlertDescription>{historyError}</AlertDescription>
                <AlertAction>
                  <Button type="button" size="sm" variant="outline" onClick={() => void loadHistory()}>
                    重试加载
                  </Button>
                </AlertAction>
              </AlertContent>
            </Alert>
          )}

          {summaryText && (
            <MessageMarker>
              早期对话摘要：{summaryText.slice(0, 72)}
              {summaryText.length > 72 ? "…" : ""}
            </MessageMarker>
          )}

          {items.length === 0 && historyState === "ready" && (
            <div className="mx-auto my-16 flex max-w-md flex-col items-center gap-2 text-center">
              <div className="grid size-10 place-items-center rounded-full bg-muted/60 text-muted-foreground">
                <Bot className="size-5" />
              </div>
              <p className="text-sm font-medium text-foreground">开始新的对话</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                在下方输入消息、粘贴图片，或输入 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">/help</code> 查看系统指令。
              </p>
            </div>
          )}

          {items.map((item, idx) => {
            const isLastStreaming =
              streaming && idx === items.length - 1 && item.role === "assistant";

            if (item.role === "system") {
              return (
                <MessageMarker key={item.id}>
                  {item.bubbles.join(" · ")}
                </MessageMarker>
              );
            }

            const lightboxImages: LightboxImage[] = (item.images ?? []).map((src, i) => ({
              id: `${item.id}-img-${i}`,
              src,
              alt: `消息图片 ${i + 1}`,
              width: 1280,
              height: 800,
            }));

            return (
              <Message key={item.id} from={item.role} animateIn>
                <MessageAvatar
                  className={
                    item.role === "assistant"
                      ? "bg-primary/12 text-primary"
                      : "bg-muted/80 text-muted-foreground"
                  }
                >
                  {item.role === "user" ? (
                    <User className="size-3.5" />
                  ) : (
                    <Bot className="size-3.5" />
                  )}
                </MessageAvatar>

                <MessageContent>
                  <MessageHeader>
                    <span className="font-medium text-foreground/80">
                      {item.role === "user" ? "你" : "Hato"}
                    </span>
                    {formatClock(item.createdAt) && (
                      <span>{formatClock(item.createdAt)}</span>
                    )}
                  </MessageHeader>

                  {item.bubbles.length > 0 && (
                    <MessageBubbleGroup spacing="compact">
                      {item.bubbles.map((text, bIdx) => (
                        <MessageBubble
                          key={`${item.id}-b-${bIdx}`}
                          variant={item.role === "user" ? "tint" : "soft"}
                        >
                          <MessageBubbleContent
                            className={
                              item.role === "user"
                                ? "whitespace-pre-wrap break-words text-sm leading-relaxed"
                                : "break-words text-sm leading-relaxed"
                            }
                          >
                            {item.role === "assistant" ? (
                              <MarkdownContent content={text} />
                            ) : (
                              text
                            )}
                          </MessageBubbleContent>
                        </MessageBubble>
                      ))}
                    </MessageBubbleGroup>
                  )}

                  {lightboxImages.length > 0 && (
                    <MorphingLightbox
                      images={lightboxImages}
                      className="mt-1 max-w-md"
                      thumbnailClassName="max-h-56 rounded-lg object-contain ring-1 ring-border/50"
                    />
                  )}

                  {isLastStreaming && (
                    <div className="py-1 text-xs">
                      <ThinkingShimmer>{earlyStatus}</ThinkingShimmer>
                    </div>
                  )}

                  {item.telemetry && (
                    <MessageFooter className="tabular-nums">
                      <span>{item.telemetry.latencyMs}ms</span>
                      {typeof item.telemetry.ttftMs === "number" && (
                        <span>· TTFT {item.telemetry.ttftMs}ms</span>
                      )}
                      {typeof item.telemetry.cacheHitRate === "number" && (
                        <span>
                          · 命中 {(item.telemetry.cacheHitRate * 100).toFixed(1)}%
                        </span>
                      )}
                      {item.telemetry.toolCalls.length > 0 && (
                        <span>· 工具：{item.telemetry.toolCalls.join(", ")}</span>
                      )}
                    </MessageFooter>
                  )}
                </MessageContent>
              </Message>
            );
          })}
        </MessageScroller>

        {readonlySession ? (
          <div className="shrink-0 border-t border-border/70 bg-background px-3 py-2.5 text-center text-xs text-muted-foreground sm:px-6">
            历史会话仅支持只读浏览（主对话中也可让 Hato 自动检索往期记录）。
          </div>
        ) : (
          <div className="shrink-0 border-t border-border/60 bg-background px-3 py-2.5 sm:px-6">
            <div className="mx-auto w-full max-w-3xl">
              {pendingImages.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center gap-2 pb-1">
                  {pendingImages.map((img) => (
                    <div key={img.id} className="group relative overflow-hidden rounded-md ring-1 ring-border/70">
                      <img
                        src={img.previewUrl}
                        alt={img.name}
                        className="h-12 w-12 object-cover"
                      />
                      <button
                        type="button"
                        aria-label="移除图片"
                        onClick={() =>
                          setPendingImages((prev) => prev.filter((p) => p.id !== img.id))
                        }
                        className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-black/70 text-white"
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingImages([])}
                    className="ml-auto h-7 px-2 text-xs"
                  >
                    <Trash2 className="size-3.5" />
                    清空图片
                  </Button>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileChange}
                className="hidden"
              />

              <PromptInput
                value={draft}
                onValueChange={setDraft}
                onPaste={handlePaste}
                loading={streaming}
                onStop={() => abortRef.current?.abort()}
                onSubmit={(val) => void sendMessage(val)}
                placeholder="输入消息，粘贴图片，或输入 /help 查看系统指令"
                labels={{
                  placeholder: "输入消息，粘贴图片，或输入 /help 查看系统指令",
                  send: "发送消息",
                  stop: "停止生成",
                }}
                leadingAction={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="上传图片"
                    aria-label="上传图片"
                    disabled={streaming || pendingImages.length >= 4}
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-full"
                  >
                    <ImagePlus className="size-4" />
                  </Button>
                }
              />
            </div>
          </div>
        )}
      </TabsContent>

      <TabsContent value="trajectory" className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {subTab === "trajectory" && (
          <TrajectoryPanel
            onToast={onToast}
            sessionEpoch={sessionEpoch}
            sessionId={selectedSessionId}
          />
        )}
      </TabsContent>

      <TabsContent value="stats" className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {subTab === "stats" && (
          <StaticsPanel
            onToast={onToast}
            embedded
            sessionEpoch={sessionEpoch}
            sessionId={selectedSessionId}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}
