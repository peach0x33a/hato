import {
  Clock,
  Cpu,
  Database,
  Layers,
  PanelRight,
  RefreshCw,
  Search,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type TraceStepRecord, type TurnTraceRecord } from "@/api";
import { ApiBadge, ConsoleSelect, SlotBadge } from "@/components/console/ConsolePrimitives";
import {
  Alert,
  AlertAction,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@/components/motion/alert";
import { Button } from "@/components/motion/button";

type TimelineMode = "duration" | "turns" | "tokens";
type InspectorTab = "overview" | "preview" | "raw" | "snapshot" | "timing";
type LedgerKind = "input" | "recall" | "tool" | "assistant";

interface LedgerEvent {
  key: string;
  traceId: string;
  turnNumber: number;
  stepNumber?: number;
  kind: LedgerKind;
  slot: string;
  primaryText: string;
  secondaryText?: string;
  meta: string;
  createdAt: number;
  stepData?: TraceStepRecord;
}

const MODE_OPTIONS: Array<{ id: TimelineMode; label: string; icon: typeof Clock }> = [
  { id: "duration", label: "时长", icon: Clock },
  { id: "turns", label: "轮次", icon: Layers },
  { id: "tokens", label: "Token", icon: Cpu },
];

const DEFAULT_SLOT_OPTIONS = [
  { value: "__all__", label: "全部调用" },
  { value: "persona", label: "persona · 主对话" },
  { value: "worker", label: "worker · 浏览器" },
  { value: "curator", label: "curator · 记忆压缩" },
  { value: "router", label: "router · 路由" },
  { value: "hindsight_llm", label: "hindsight_llm · 反思" },
];

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseStepsJson(raw: string | null | undefined): TraceStepRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TraceStepRecord[]) : [];
  } catch {
    return [];
  }
}

function singleLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function safeStringify(value: unknown, pretty = false): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, pretty ? 2 : 0);
  } catch {
    return String(value);
  }
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function getKindBadge(kind: LedgerKind, slot: string): { text: string; cls: string } {
  if (kind === "tool") {
    return {
      text: "工具",
      cls: "border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    };
  }
  if (kind === "recall") {
    return {
      text: "记忆",
      cls: "border-emerald-500/35 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    };
  }
  if (kind === "input") {
    if (slot === "worker") {
      return {
        text: "浏览",
        cls: "border-cyan-500/35 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
      };
    }
    if (slot === "curator") {
      return {
        text: "压缩",
        cls: "border-emerald-500/35 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      };
    }
    return {
      text: "输入",
      cls: "border-sky-500/35 bg-sky-500/15 text-sky-700 dark:text-sky-300",
    };
  }
  return {
    text: "助手",
    cls: "border-violet-500/35 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  };
}

export interface TrajectoryPanelProps {
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
  sessionEpoch?: number;
  sessionId?: string | null;
}

export function TrajectoryPanel({ onToast, sessionEpoch = 0, sessionId = null }: TrajectoryPanelProps) {
  const [slot, setSlot] = useState("__all__");
  const [mode, setMode] = useState<TimelineMode>("duration");
  const [searchText, setSearchText] = useState("");
  const [showInputs, setShowInputs] = useState(true);
  const [showTools, setShowTools] = useState(true);
  const [showModels, setShowModels] = useState(true);
  const [showRecall, setShowRecall] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const [viewState, setViewState] = useState<"loading" | "error" | "ready">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [traces, setTraces] = useState<TurnTraceRecord[]>([]);

  const loadTraces = async () => {
    setViewState("loading");
    setErrorMessage("");
    try {
      const res = await api.getStatics({
        limit: 80,
        slot: slot === "__all__" ? undefined : slot,
        sessionId,
      });
      const chronological = [...res.traces].reverse();
      setTraces(chronological);
      setSelectedTraceId((prev) =>
        prev && chronological.some((t) => t.id === prev)
          ? prev
          : chronological[chronological.length - 1]?.id ?? null,
      );
      setViewState("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      setViewState("error");
      onToast({ title: "轨迹加载失败", description: msg, status: "error" });
    }
  };

  useEffect(() => {
    void loadTraces();
  }, [slot, sessionEpoch, sessionId]);

  const slotOptions = useMemo(() => {
    const known = new Set(DEFAULT_SLOT_OPTIONS.map((o) => o.value));
    const extras: Array<{ value: string; label: string }> = [];
    for (const tr of traces) {
      if (!known.has(tr.slot)) {
        known.add(tr.slot);
        extras.push({ value: tr.slot, label: tr.slot });
      }
    }
    return [...DEFAULT_SLOT_OPTIONS, ...extras];
  }, [traces]);

  const filteredTraces = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return traces;
    return traces.filter((tr) => {
      const tools = parseJsonArray(tr.toolCallsJson).join(" ").toLowerCase();
      return (
        tr.slot.toLowerCase().includes(q) ||
        tr.provider.toLowerCase().includes(q) ||
        tr.modelId.toLowerCase().includes(q) ||
        tr.api.toLowerCase().includes(q) ||
        (tr.userPreview ?? "").toLowerCase().includes(q) ||
        (tr.stepsJson ?? "").toLowerCase().includes(q) ||
        tr.timeCardText.toLowerCase().includes(q) ||
        tools.includes(q)
      );
    });
  }, [traces, searchText]);

  const totalSpanWeight = useMemo(() => {
    if (filteredTraces.length === 0) return 1;
    if (mode === "turns") return filteredTraces.length;
    if (mode === "tokens") {
      return Math.max(
        1,
        filteredTraces.reduce(
          (sum, t) =>
            sum + Math.max(1, t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens),
          0,
        ),
      );
    }
    return Math.max(
      1,
      filteredTraces.reduce((sum, t) => sum + Math.max(1, t.latencyMs), 0),
    );
  }, [filteredTraces, mode]);

  const ledgerEvents = useMemo<LedgerEvent[]>(() => {
    const events: LedgerEvent[] = [];
    const chronologicalWithIndex = filteredTraces.map((tr, i) => ({ tr, turnNumber: i + 1 }));

    for (let idx = chronologicalWithIndex.length - 1; idx >= 0; idx--) {
      const { tr, turnNumber } = chronologicalWithIndex[idx]!;
      const steps = parseStepsJson(tr.stepsJson);
      const tools = parseJsonArray(tr.toolCallsJson);
      const recalled = parseJsonArray(tr.recalledIdsJson);

      if (showInputs && tr.userPreview) {
        events.push({
          key: `${tr.id}:input`,
          traceId: tr.id,
          turnNumber,
          kind: "input",
          slot: tr.slot,
          primaryText: tr.userPreview,
          meta: `#${turnNumber}`,
          createdAt: tr.createdAt,
        });
      }

      if (showRecall && recalled.length > 0) {
        events.push({
          key: `${tr.id}:recall`,
          traceId: tr.id,
          turnNumber,
          kind: "recall",
          slot: tr.slot,
          primaryText: `召回记忆 ${recalled.length} 条`,
          secondaryText: recalled.slice(0, 4).join(", "),
          meta: `#${turnNumber}`,
          createdAt: tr.createdAt,
        });
      }

      if (steps.length > 0) {
        for (let sIdx = steps.length - 1; sIdx >= 0; sIdx--) {
          const st = steps[sIdx]!;
          if (st.kind === "tool") {
            if (!showTools) continue;
            const argStr = st.args !== undefined ? singleLine(safeStringify(st.args)) : "";
            const outStr = singleLine(st.output);
            const parts = [argStr, outStr ? `→ ${outStr}` : ""].filter(Boolean).join(" ");
            events.push({
              key: `${tr.id}:step:${st.step}`,
              traceId: tr.id,
              turnNumber,
              stepNumber: st.step,
              kind: "tool",
              slot: tr.slot,
              primaryText: st.name,
              secondaryText: parts || undefined,
              meta: `#${turnNumber}.${st.step}`,
              createdAt: tr.createdAt,
              stepData: st,
            });
          } else {
            if (!showModels) continue;
            const outPreview = singleLine(st.text) || singleLine(st.thinking);
            const displayText =
              outPreview ||
              (st.toolCalls.length > 0
                ? `（仅工具调用：${st.toolCalls.map((c) => c.name).join(", ")}）`
                : `${tr.provider}/${tr.modelId}`);
            const tokStr = st.tokens?.output ? `${st.tokens.output} tok` : `${tr.outputTokens} tok`;
            events.push({
              key: `${tr.id}:step:${st.step}`,
              traceId: tr.id,
              turnNumber,
              stepNumber: st.step,
              kind: "assistant",
              slot: tr.slot,
              primaryText: displayText,
              secondaryText: tokStr,
              meta: `#${turnNumber}.${st.step}`,
              createdAt: tr.createdAt,
              stepData: st,
            });
          }
        }
      } else {
        // Fallback for older trace rows recorded before stepsJson migration
        if (showModels) {
          events.push({
            key: `${tr.id}:assistant`,
            traceId: tr.id,
            turnNumber,
            kind: "assistant",
            slot: tr.slot,
            primaryText:
              tools.length > 0
                ? `（历史调用 · 工具：${tools.join(", ")}）`
                : `${tr.provider}/${tr.modelId}`,
            secondaryText: `${tr.outputTokens} tok · ${tr.latencyMs}ms`,
            meta: `#${turnNumber}`,
            createdAt: tr.createdAt,
          });
        }
        if (showTools) {
          for (let tIdx = tools.length - 1; tIdx >= 0; tIdx--) {
            const toolName = tools[tIdx]!;
            events.push({
              key: `${tr.id}:tool:${tIdx}`,
              traceId: tr.id,
              turnNumber,
              kind: "tool",
              slot: tr.slot,
              primaryText: toolName,
              meta: `#${turnNumber}.${tIdx + 1}`,
              createdAt: tr.createdAt,
            });
          }
        }
      }
    }
    return events;
  }, [filteredTraces, showInputs, showRecall, showTools, showModels]);

  const selectedEvent = useMemo(
    () => ledgerEvents.find((ev) => ev.key === selectedEventKey) ?? null,
    [ledgerEvents, selectedEventKey],
  );

  const selectedTrace = useMemo(
    () =>
      filteredTraces.find((t) => t.id === (selectedEvent?.traceId ?? selectedTraceId)) ??
      filteredTraces[filteredTraces.length - 1] ??
      null,
    [filteredTraces, selectedEvent, selectedTraceId],
  );

  const selectedTurnNumber = useMemo(() => {
    if (!selectedTrace) return 0;
    return filteredTraces.findIndex((t) => t.id === selectedTrace.id) + 1;
  }, [filteredTraces, selectedTrace]);

  const selectedSteps = useMemo(
    () => (selectedTrace ? parseStepsJson(selectedTrace.stepsJson) : []),
    [selectedTrace],
  );

  const activeStep: TraceStepRecord | null = useMemo(() => {
    if (selectedEvent?.stepData) return selectedEvent.stepData;
    const assistants = selectedSteps.filter((s) => s.kind === "assistant");
    return assistants[assistants.length - 1] ?? selectedSteps[selectedSteps.length - 1] ?? null;
  }, [selectedEvent, selectedSteps]);

  const selectedTools = useMemo(
    () => (selectedTrace ? parseJsonArray(selectedTrace.toolCallsJson) : []),
    [selectedTrace],
  );
  const selectedRecalled = useMemo(
    () => (selectedTrace ? parseJsonArray(selectedTrace.recalledIdsJson) : []),
    [selectedTrace],
  );

  const assistantOutputBlocks = useMemo(() => {
    if (activeStep?.kind === "assistant") {
      return [activeStep];
    }
    return selectedSteps.filter(
      (s): s is Extract<TraceStepRecord, { kind: "assistant" }> => s.kind === "assistant",
    );
  }, [activeStep, selectedSteps]);

  const inspectorTabList = useMemo<Array<[InspectorTab, string]>>(() => {
    if (activeStep?.kind === "tool") {
      return [
        ["overview", "概述"],
        ["preview", "参数"],
        ["raw", "结果"],
        ["timing", "计时"],
      ];
    }
    return [
      ["overview", "概述"],
      ["preview", "预览"],
      ["raw", "原始内容"],
      ["snapshot", "上下文"],
      ["timing", "计时"],
    ];
  }, [activeStep]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* 1. DSH Sticky Dense Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card/30 px-2.5 py-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center rounded-md border border-border bg-background/70 p-0.5">
            {MODE_OPTIONS.map((m) => {
              const Icon = m.icon;
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors ${
                    active
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="size-3" />
                  {m.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-0.5 rounded-md border border-border bg-background/70 p-0.5">
            {(
              [
                ["输入", showInputs, () => setShowInputs((v) => !v)],
                ["记忆", showRecall, () => setShowRecall((v) => !v)],
                ["工具", showTools, () => setShowTools((v) => !v)],
                ["助手", showModels, () => setShowModels((v) => !v)],
              ] as const
            ).map(([label, pressed, onToggle]) => (
              <button
                key={label}
                type="button"
                aria-pressed={pressed}
                onClick={onToggle}
                className={`inline-flex h-6 items-center rounded px-2 text-[11px] transition-colors ${
                  pressed
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground/70 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <ConsoleSelect
            size="sm"
            className="w-40"
            value={slot}
            options={slotOptions}
            onValueChange={setSlot}
          />
        </div>

        <div className="flex items-center gap-1.5">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2 size-3 text-muted-foreground" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="搜索输出、工具、模型…"
              className="h-7 w-44 rounded-md border border-border bg-background pr-6 pl-6 text-[11px] text-foreground outline-none focus:border-ring sm:w-52"
            />
            {searchText && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => setSearchText("")}
                className="absolute right-1.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          <Button
            type="button"
            variant={inspectorOpen ? "secondary" : "outline"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => setInspectorOpen((v) => !v)}
          >
            <PanelRight className="size-3.5" />
            检查器
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={viewState === "loading"}
            onClick={() => void loadTraces()}
          >
            <RefreshCw className={`size-3 ${viewState === "loading" ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      </div>

      {/* 2. DSH 54px Compact 3-Track Swimlane */}
      {filteredTraces.length > 0 && (
        <div className="flex h-[54px] shrink-0 overflow-hidden border-b border-border bg-card/20">
          <div className="flex w-11 shrink-0 select-none flex-col justify-between border-r border-border bg-muted/25 px-1.5 py-1 text-right text-[10px] leading-none text-muted-foreground">
            <span>输入</span>
            <span>模型</span>
            <span>工具</span>
          </div>

          <div className="flex min-w-0 flex-1 overflow-x-auto">
            {filteredTraces.map((tr) => {
              const weight =
                mode === "turns"
                  ? 1
                  : mode === "tokens"
                    ? Math.max(1, tr.inputTokens + tr.cacheReadTokens + tr.cacheWriteTokens + tr.outputTokens)
                    : Math.max(1, tr.latencyMs);
              const pct = Math.max(2, (weight / totalSpanWeight) * 100);
              const ttftRatio =
                tr.ttftMs !== null && tr.latencyMs > 0
                  ? Math.min(0.9, Math.max(0.08, tr.ttftMs / tr.latencyMs))
                  : 0.25;
              const tools = parseJsonArray(tr.toolCallsJson);
              const isSelected = selectedTrace?.id === tr.id;

              return (
                <button
                  key={tr.id}
                  type="button"
                  onClick={() => {
                    setSelectedTraceId(tr.id);
                    const matching = ledgerEvents.find(
                      (ev) => ev.traceId === tr.id && ev.kind === "assistant",
                    );
                    setSelectedEventKey(matching?.key ?? null);
                    setInspectorOpen(true);
                  }}
                  style={{ flexBasis: `${pct}%`, flexGrow: weight, minWidth: 18 }}
                  title={`[${tr.slot}] ${tr.provider}/${tr.modelId} · ${tr.latencyMs}ms`}
                  className={`flex h-full flex-col justify-between border-r border-border/50 px-0.5 py-1 transition-colors ${
                    isSelected ? "bg-primary/12 ring-1 ring-inset ring-primary/45" : "hover:bg-muted/40"
                  }`}
                >
                  <div className="flex h-2.5 items-center">
                    <span
                      className={`block h-2 w-full rounded-[2px] ${
                        tr.slot === "worker"
                          ? "bg-cyan-500/80"
                          : tr.slot === "curator"
                            ? "bg-emerald-500/80"
                            : tr.userPreview
                              ? "bg-sky-500/80"
                              : "bg-sky-500/35"
                      }`}
                    />
                  </div>
                  <div className="flex h-2.5 overflow-hidden rounded-[2px] bg-violet-500/20">
                    <span
                      className="block h-full bg-violet-400/50"
                      style={{ width: `${ttftRatio * 100}%` }}
                    />
                    <span className="block h-full flex-1 bg-violet-500/85" />
                  </div>
                  <div className="flex h-2.5 items-center">
                    {tools.length > 0 && (
                      <span className="block h-2 w-full rounded-[2px] bg-amber-500/85" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Master-Detail Split Body */}
      {viewState === "error" ? (
        <div className="p-3">
          <Alert variant="destructive" open>
            <AlertIcon />
            <AlertContent>
              <AlertTitle>轨迹数据获取失败</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
              <AlertAction>
                <Button type="button" size="sm" variant="outline" onClick={() => void loadTraces()}>
                  重试
                </Button>
              </AlertAction>
            </AlertContent>
          </Alert>
        </div>
      ) : viewState === "loading" && traces.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          正在加载运行轨迹…
        </div>
      ) : filteredTraces.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          暂无匹配的轨迹记录。发送对话或运行浏览器任务后即可在此追踪每次调用与输出。
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left: High-Density DSH Event Ledger showing actual Tool args/results & LLM output */}
          <div className="min-w-0 flex-1 overflow-y-auto divide-y divide-border/50">
            {ledgerEvents.map((ev) => {
              const badge = getKindBadge(ev.kind, ev.slot);
              const isSelected =
                selectedEventKey === ev.key ||
                (selectedEventKey === null &&
                  selectedTrace?.id === ev.traceId &&
                  ev.kind === "assistant");

              return (
                <button
                  key={ev.key}
                  type="button"
                  onClick={() => {
                    setSelectedTraceId(ev.traceId);
                    setSelectedEventKey(ev.key);
                    setInspectorTab("overview");
                    setInspectorOpen(true);
                  }}
                  className={`flex min-h-7 w-full items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors ${
                    isSelected
                      ? "bg-primary/10 text-foreground"
                      : "hover:bg-muted/45 text-foreground/90"
                  }`}
                >
                  <span
                    className={`inline-flex h-4 w-8 shrink-0 items-center justify-center rounded border text-[10px] font-medium leading-none ${badge.cls}`}
                  >
                    {badge.text}
                  </span>

                  {ev.kind === "tool" && (
                    <Wrench className="size-3 shrink-0 text-amber-500" />
                  )}
                  {ev.kind === "assistant" && (
                    <Sparkles className="size-3 shrink-0 text-violet-400" />
                  )}
                  {ev.kind === "recall" && (
                    <Database className="size-3 shrink-0 text-emerald-500" />
                  )}

                  <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    {ev.kind === "tool" ? (
                      <>
                        <span className="shrink-0 font-mono text-[11px] font-medium text-foreground">
                          {ev.primaryText}
                        </span>
                        {ev.secondaryText && (
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {ev.secondaryText}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="truncate text-xs text-foreground">
                          {ev.primaryText}
                        </span>
                        {ev.secondaryText && (
                          <span className="hidden shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground sm:inline">
                            · {ev.secondaryText}
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  <SlotBadge slot={ev.slot} className="hidden h-4 px-1 text-[10px] md:inline-flex" />

                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {ev.meta} · {formatTime(ev.createdAt)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Right: Collapsible DSH Inspector Drawer with actual LLM Output / Tool Args & Results */}
          {inspectorOpen && selectedTrace && (
            <aside className="flex w-84 shrink-0 flex-col overflow-hidden border-l border-border bg-card/35 lg:w-[440px]">
              <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={`inline-flex h-4 items-center rounded border px-1.5 text-[10px] font-medium leading-none ${
                      activeStep?.kind === "tool"
                        ? "border-amber-500/35 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        : "border-violet-500/35 bg-violet-500/15 text-violet-700 dark:text-violet-300"
                    }`}
                  >
                    {activeStep?.kind === "tool" ? "工具" : "助手"}
                  </span>
                  <span className="truncate text-[11px] font-medium text-foreground">
                    第 {selectedTurnNumber} 轮
                    {activeStep ? ` · 第 ${activeStep.step} 步` : ""}
                    {activeStep?.kind === "tool" ? ` · ${activeStep.name}` : ""}
                  </span>
                  <SlotBadge slot={selectedTrace.slot} className="h-4 px-1 text-[10px]" />
                </div>
                <button
                  type="button"
                  aria-label="关闭检查器"
                  onClick={() => setInspectorOpen(false)}
                  className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>

              <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-2">
                {inspectorTabList.map(([tabId, label]) => (
                  <button
                    key={tabId}
                    type="button"
                    onClick={() => setInspectorTab(tabId)}
                    className={`h-6 rounded px-2 text-[11px] transition-colors ${
                      inspectorTab === tabId
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
                {inspectorTab === "overview" && activeStep?.kind === "tool" && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-[64px_1fr] gap-y-1.5 border-b border-border/60 pb-2 text-[11px]">
                      <span className="text-muted-foreground">工具名</span>
                      <span className="font-mono font-medium text-foreground">{activeStep.name}</span>
                      <span className="text-muted-foreground">状态</span>
                      <span className={activeStep.isError ? "text-destructive" : "text-foreground"}>
                        {activeStep.isError ? "执行异常" : "已完成"}
                      </span>
                      <span className="text-muted-foreground">归属槽位</span>
                      <div className="flex items-center gap-1.5">
                        <SlotBadge slot={selectedTrace.slot} className="h-4 px-1 text-[10px]" />
                        <span className="font-mono text-[11px]">{selectedTrace.provider}/{selectedTrace.modelId}</span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] text-muted-foreground">参数</span>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background/85 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                        {safeStringify(activeStep.args, true) || "{}"}
                      </pre>
                    </div>

                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] text-muted-foreground">结果</span>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background/85 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                        {activeStep.output || "（无文本返回）"}
                      </pre>
                    </div>
                  </div>
                )}

                {inspectorTab === "overview" && activeStep?.kind !== "tool" && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-[64px_1fr] gap-y-1.5 border-b border-border/60 pb-2 text-[11px]">
                      <span className="text-muted-foreground">来源</span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SlotBadge slot={selectedTrace.slot} className="h-4 px-1 text-[10px]" />
                        <span className="font-mono font-medium text-foreground">
                          {selectedTrace.provider}/{selectedTrace.modelId}
                        </span>
                        <ApiBadge api={selectedTrace.api} className="h-4 px-1 text-[10px]" />
                      </div>
                      <span className="text-muted-foreground">状态</span>
                      <span className="text-foreground">
                        {activeStep?.kind === "assistant" && activeStep.stopReason === "toolUse"
                          ? "工具调用中"
                          : "已完成"}
                      </span>
                      <span className="text-muted-foreground">Token</span>
                      <span className="font-mono tabular-nums text-foreground">
                        输入 {(selectedTrace.inputTokens + selectedTrace.cacheReadTokens + selectedTrace.cacheWriteTokens).toLocaleString()} · 输出 {selectedTrace.outputTokens.toLocaleString()}
                      </span>
                    </div>

                    {/* Actual LLM Output Preview */}
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => setInspectorTab("preview")}
                        className="flex items-center gap-1 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
                      >
                        预览 &gt;
                      </button>

                      {assistantOutputBlocks.length > 0 ? (
                        <div className="flex flex-col gap-2.5">
                          {assistantOutputBlocks.map((block) => (
                            <div key={block.step} className="flex flex-col gap-1.5">
                              {block.thinking && (
                                <details className="rounded border border-border/70 bg-muted/25 px-2.5 py-1.5">
                                  <summary className="cursor-pointer select-none text-[11px] text-muted-foreground">
                                    思考过程（第 {block.step} 步）
                                  </summary>
                                  <pre className="mt-1.5 whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-muted-foreground">
                                    {block.thinking}
                                  </pre>
                                </details>
                              )}
                              {block.text ? (
                                <div className="whitespace-pre-wrap break-words rounded border border-border/70 bg-background/80 p-2.5 text-xs leading-relaxed text-foreground">
                                  {block.text}
                                </div>
                              ) : block.toolCalls.length > 0 ? (
                                <div className="rounded border border-dashed border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
                                  该步直接发起工具调用：{block.toolCalls.map((c) => c.name).join("、")}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded border border-dashed border-border px-2.5 py-2 text-[11px] text-muted-foreground">
                          旧版轨迹记录未保存原始输出正文（仅新产生的调用会完整记录每步模型输出）。
                        </div>
                      )}
                    </div>

                    {selectedTools.length > 0 && (
                      <div className="flex flex-col gap-1 border-t border-border/60 pt-2">
                        <span className="text-[11px] text-muted-foreground">
                          本轮工具调用 ({selectedTools.length})
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {selectedTools.map((t, i) => (
                            <span
                              key={`${t}-${i}`}
                              className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300"
                            >
                              <Wrench className="size-2.5" />
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {inspectorTab === "preview" && activeStep?.kind === "tool" && (
                  <pre className="overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background/85 p-2.5 font-mono text-[11px] leading-relaxed text-foreground">
                    {safeStringify(activeStep.args, true) || "{}"}
                  </pre>
                )}

                {inspectorTab === "preview" && activeStep?.kind !== "tool" && (
                  <div className="flex flex-col gap-3">
                    {assistantOutputBlocks.length === 0 ? (
                      <span className="text-[11px] text-muted-foreground">（暂无模型输出正文）</span>
                    ) : (
                      assistantOutputBlocks.map((block) => (
                        <div key={block.step} className="flex flex-col gap-1.5">
                          <div className="text-[11px] font-medium text-muted-foreground">
                            第 {block.step} 步输出
                          </div>
                          {block.thinking && (
                            <pre className="whitespace-pre-wrap break-words rounded border border-border/60 bg-muted/30 p-2 font-sans text-[11px] leading-relaxed text-muted-foreground">
                              {block.thinking}
                            </pre>
                          )}
                          <div className="whitespace-pre-wrap break-words rounded border border-border bg-background/85 p-2.5 text-xs leading-relaxed text-foreground">
                            {block.text || `（仅调用工具：${block.toolCalls.map((c) => c.name).join(", ")}）`}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {inspectorTab === "raw" && activeStep?.kind === "tool" && (
                  <pre className="overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background/85 p-2.5 font-mono text-[11px] leading-relaxed text-foreground">
                    {activeStep.output || "（无输出内容）"}
                  </pre>
                )}

                {inspectorTab === "raw" && activeStep?.kind !== "tool" && (
                  <pre className="overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background/85 p-2.5 font-mono text-[11px] leading-relaxed text-foreground">
                    {safeStringify(
                      activeStep?.kind === "assistant" ? activeStep : selectedSteps,
                      true,
                    ) || "[]"}
                  </pre>
                )}

                {inspectorTab === "snapshot" && (
                  <div className="flex flex-col gap-2">
                    <div>
                      <span className="text-[11px] text-muted-foreground">触发输入 / 任务目标</span>
                      <p className="mt-1 whitespace-pre-wrap break-words rounded border border-border/60 bg-background/70 p-2 text-xs text-foreground">
                        {selectedTrace.userPreview || "（无文本输入）"}
                      </p>
                    </div>
                    {selectedRecalled.length > 0 && (
                      <div>
                        <span className="text-[11px] text-muted-foreground">召回记忆 ID</span>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {selectedRecalled.map((rid) => (
                            <span
                              key={rid}
                              className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:text-emerald-300"
                            >
                              {rid}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div>
                      <span className="text-[11px] text-muted-foreground">时间卡片 / 上下文快照</span>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                        {selectedTrace.timeCardText || "（本次未记录快照内容）"}
                      </pre>
                    </div>
                  </div>
                )}

                {inspectorTab === "timing" && (
                  <div className="flex flex-col divide-y divide-border/60">
                    {(
                      [
                        ["调用时间", formatDateTime(selectedTrace.createdAt)],
                        ["总耗时", `${selectedTrace.latencyMs} ms`],
                        [
                          "首字延迟 (TTFT)",
                          selectedTrace.ttftMs !== null ? `${selectedTrace.ttftMs} ms` : "未测量",
                        ],
                        [
                          "生成阶段耗时",
                          selectedTrace.ttftMs !== null
                            ? `${Math.max(0, selectedTrace.latencyMs - selectedTrace.ttftMs)} ms`
                            : "--",
                        ],
                        [
                          "解码速率 (TPS)",
                          selectedTrace.tps !== null
                            ? `${selectedTrace.tps.toFixed(2)} tok/s`
                            : "未测量",
                        ],
                        ["未命中输入 Token", selectedTrace.inputTokens.toLocaleString()],
                        ["缓存命中读 (Cache Read)", selectedTrace.cacheReadTokens.toLocaleString()],
                        ["缓存写入 (Cache Write)", selectedTrace.cacheWriteTokens.toLocaleString()],
                        ["缓存命中率", `${(selectedTrace.cacheHitRate * 100).toFixed(1)}%`],
                        ["输出 Token", selectedTrace.outputTokens.toLocaleString()],
                      ] as const
                    ).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between py-1.5">
                        <span className="text-[11px] text-muted-foreground">{k}</span>
                        <span className="font-mono text-[11px] font-medium tabular-nums text-foreground">
                          {v}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
