import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  Cpu,
  Database,
  KeyRound,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Timer,
  Unlink,
  Wifi,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type OverviewResponse,
  type PairingCodeResponse,
  type ProbeItemResult,
  type ProbeResponse,
} from "@/api";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { SPRING_LAYOUT } from "@/lib/ease";

const PROBE_STORAGE_KEY = "hato_service_probe_results_v1";

export interface OverviewPanelProps {
  onNavigateTab: (tab: "chat" | "browser" | "models" | "prompt" | "settings") => void;
  onNavigateSettings: (
    section: "general" | "gateway" | "worker" | "proxy" | "browser" | "search" | "secrets",
  ) => void;
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
}

function formatDurationClock(totalSec: number): string {
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return [hrs, mins, secs].map((n) => String(n).padStart(2, "0")).join(":");
}

function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return "--";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function loadSavedProbeResults(): ProbeResponse["results"] {
  try {
    const raw = window.localStorage.getItem(PROBE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ProbeResponse["results"]) : {};
  } catch {
    return {};
  }
}

function saveProbeResults(results: ProbeResponse["results"]): void {
  try {
    window.localStorage.setItem(PROBE_STORAGE_KEY, JSON.stringify(results));
  } catch {
    // ignore storage errors
  }
}

interface GatewayCardProps {
  code: "TG" | "QQ";
  title: string;
  subtitle?: string;
  protocol: string;
  enabled: boolean;
  running: boolean;
  online: boolean;
  avatarUrl?: string;
  uptimeSec: number;
  messageCount: number;
  whitelistCount: number;
  extraMeta?: string;
  probeResult?: ProbeItemResult;
  probing: boolean;
  toggling: boolean;
  onToggle: () => void;
  onTestLatency: () => void;
  onOpenSettings: () => void;
}

function PlatformEmblem({ code, className = "size-11" }: { code: "TG" | "QQ"; className?: string }) {
  if (code === "TG") {
    return (
      <svg viewBox="0 0 24 24" className={`${className} text-sky-500 dark:text-sky-400`} fill="currentColor" aria-hidden="true">
        <path d="M21.94 4.66a1.1 1.1 0 0 0-1.15-.16L2.7 11.77a1.02 1.02 0 0 0 .06 1.92l4.47 1.48 1.66 5.26a.96.96 0 0 0 1.62.38l2.58-2.61 4.53 3.31a1.1 1.1 0 0 0 1.72-.66l3.15-15.01a1.1 1.1 0 0 0-.55-1.18ZM9.65 14.37l-.38 3.63-1.08-3.43 9.79-6.23-8.33 6.03Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={`${className} text-primary`} fill="currentColor" aria-hidden="true">
      <path d="M12 2c-3.3 0-5.7 2.55-5.7 6.1 0 .9.14 1.62.25 2.08-.85.92-1.75 2.48-1.75 3.92 0 .92.34 1.48.88 1.48.36 0 .68-.26.96-.67.18.67.5 1.24.94 1.68-.74.29-1.23.75-1.23 1.29 0 .85 1.45 1.52 3.35 1.52.83 0 1.6-.13 2.2-.34.07.01.13.01.2.01s.13 0 .2-.01c.6.21 1.37.34 2.2.34 1.9 0 3.35-.67 3.35-1.52 0-.54-.49-1-1.23-1.29.44-.44.76-1.01.94-1.68.28.41.6.67.96.67.54 0 .88-.56.88-1.48 0-1.44-.9-3-1.75-3.92.11-.46.25-1.18.25-2.08C17.7 4.55 15.3 2 12 2Z" />
    </svg>
  );
}

function GatewayStatusCard({
  code,
  title,
  subtitle,
  protocol,
  enabled,
  running,
  online,
  avatarUrl,
  uptimeSec,
  messageCount,
  whitelistCount,
  extraMeta,
  probeResult,
  probing,
  toggling,
  onToggle,
  onTestLatency,
  onOpenSettings,
}: GatewayCardProps) {
  const statusLabel = !enabled ? "已暂停" : online ? "运行中" : running ? "连接中" : "离线";
  const statusBadgeTone = !enabled
    ? "neutral"
    : online
      ? "success"
      : running
        ? "warning"
        : "danger";
  const platformName = code === "TG" ? "Telegram" : "QQ 机器人";

  return (
    <motion.div
      layout
      whileHover={{ y: -2 }}
      transition={{
        layout: SPRING_LAYOUT,
        type: "spring",
        stiffness: 360,
        damping: 26,
      }}
      className="relative overflow-hidden rounded-2xl border border-border/80 bg-card/75 p-5 shadow-sm transition-colors hover:border-primary/35 hover:shadow-md"
    >
      {/* Subtle top-right radial ambient glow aligned with brand palette */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute -right-12 -top-12 size-44 rounded-full blur-3xl transition-opacity duration-300 ${
          enabled
            ? code === "TG"
              ? "bg-sky-500/10 opacity-100"
              : "bg-primary/12 opacity-100"
            : "bg-muted-foreground/5 opacity-40"
        }`}
      />

      {/* Top-right Start / Stop button */}
      <motion.button
        type="button"
        title={enabled ? `暂停 ${platformName}` : `启动 ${platformName}`}
        aria-label={enabled ? `暂停 ${platformName}` : `启动 ${platformName}`}
        disabled={toggling}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.92 }}
        transition={{ type: "spring", stiffness: 420, damping: 22 }}
        onClick={onToggle}
        className={`absolute right-4 top-4 z-20 flex size-9 cursor-pointer items-center justify-center rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70 ${
          enabled
            ? "border-border/80 bg-muted/60 text-muted-foreground hover:border-primary/40 hover:bg-primary/12 hover:text-primary"
            : "border-primary/30 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
        }`}
      >
        {toggling ? (
          <Loader2 className="size-4 animate-spin" />
        ) : enabled ? (
          <Pause className="size-3.5" />
        ) : (
          <Play className="size-3.5 translate-x-[1px]" />
        )}
      </motion.button>

      <div className="relative z-10 flex flex-col gap-4">
        {/* Platform + Status header */}
        <div className="flex items-center gap-2 pr-12 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/45 px-2 py-0.5 text-[11px] font-medium text-foreground">
            <PlatformEmblem code={code} className="size-3.5" />
            {platformName}
          </span>
          <AnimatedBadge status={statusBadgeTone} size="sm">
            {statusLabel}
          </AnimatedBadge>
        </div>

        {/* Identity + protocol + click-to-test latency */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onOpenSettings}
            className="relative flex size-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-2xl border border-border/60 bg-muted/30 transition-transform hover:scale-105"
            title="点击前往网关设置"
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt={title} className="size-full object-cover" />
            ) : (
              <PlatformEmblem code={code} className="size-8" />
            )}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold leading-tight tracking-tight text-foreground">
              {title}
            </div>
            {subtitle ? (
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                {subtitle}
              </div>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <AnimatedBadge status="neutral" size="sm" showIcon={false}>
                {protocol}
              </AnimatedBadge>
              <button
                type="button"
                disabled={probing}
                onClick={onTestLatency}
                title="点击测试通道延迟"
                className="inline-flex cursor-pointer items-center rounded-full transition-opacity hover:opacity-85 disabled:cursor-wait"
              >
                {probing ? (
                  <AnimatedBadge status="loading" size="sm">
                    测延迟中…
                  </AnimatedBadge>
                ) : probeResult ? (
                  <AnimatedBadge
                    status={
                      probeResult.ok ? "success" : probeResult.skipped ? "neutral" : "danger"
                    }
                    size="sm"
                  >
                    {probeResult.ok
                      ? `延迟 ${formatLatency(probeResult.latencyMs)}`
                      : probeResult.skipped
                        ? "未启用"
                        : "测试失败"}
                  </AnimatedBadge>
                ) : (
                  <AnimatedBadge status="neutral" size="sm">
                    点击测延迟
                  </AnimatedBadge>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Bottom metadata grid */}
        <div className="grid grid-cols-3 gap-3 border-t border-border/50 pt-3 text-xs">
          <div>
            <div className="text-[11px] text-muted-foreground">运行时长</div>
            <div className="mt-0.5 font-mono font-medium tabular-nums text-foreground">
              {enabled ? formatDurationClock(uptimeSec) : "--:--:--"}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">消息数</div>
            <div className="mt-0.5 font-mono font-medium tabular-nums text-foreground">{messageCount}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">白名单</div>
            <div className="mt-0.5 font-medium text-foreground">
              {whitelistCount} 人{extraMeta ? ` · ${extraMeta}` : ""}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function OverviewPanel({
  onNavigateTab,
  onNavigateSettings,
  onToast,
}: OverviewPanelProps) {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [liveUptimeSec, setLiveUptimeSec] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [probeResults, setProbeResults] = useState<ProbeResponse["results"]>(() =>
    loadSavedProbeResults(),
  );
  const [probingChannel, setProbingChannel] = useState<"telegram" | "qq" | null>(null);
  const [togglingChannel, setTogglingChannel] = useState<"tg" | "qq" | null>(null);
  const [pairingInfo, setPairingInfo] = useState<PairingCodeResponse | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [unbindingHome, setUnbindingHome] = useState(false);
  const [clearWhitelistOnUnbind, setClearWhitelistOnUnbind] = useState(false);
  const [copiedPairing, setCopiedPairing] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  const loadOverview = useCallback(
    async (quiet = false) => {
      if (!quiet) setRefreshing(true);
      try {
        const data = await api.getOverview();
        setOverview(data);
        setLiveUptimeSec(data.uptimeSec);
        setLoadError(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
        if (!quiet) {
          onToast({
            title: "获取系统概览失败",
            description: msg,
            status: "error",
          });
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onToast],
  );

  useEffect(() => {
    void loadOverview(true);
    const pollTimer = window.setInterval(() => {
      void loadOverview(true);
    }, 10_000);
    const tickTimer = window.setInterval(() => {
      setLiveUptimeSec((prev) => prev + 1);
    }, 1000);
    return () => {
      window.clearInterval(pollTimer);
      window.clearInterval(tickTimer);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, [loadOverview]);

  const handleToggleGateway = async (channel: "tg" | "qq", nextEnabled: boolean) => {
    setTogglingChannel(channel);
    try {
      await api.toggleGateway(channel, nextEnabled);
      await loadOverview(true);
      onToast({
        title: `${channel === "tg" ? "Telegram" : "QQ"} 通道已${nextEnabled ? "启动" : "暂停"}`,
        status: "success",
      });
    } catch (err) {
      onToast({
        title: `${nextEnabled ? "启动" : "暂停"} ${channel === "tg" ? "Telegram" : "QQ"} 通道失败`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setTogglingChannel(null);
    }
  };

  const handleTestLatency = async (target: "telegram" | "qq") => {
    setProbingChannel(target);
    try {
      const res = await api.probe(target);
      const nowMs = Date.now();
      const stamped: ProbeResponse["results"] = {};
      for (const [k, v] of Object.entries(res.results)) {
        if (v) {
          stamped[k as keyof ProbeResponse["results"]] = { ...v, testedAtMs: nowMs };
        }
      }
      setProbeResults((prev) => {
        const merged = { ...prev, ...stamped };
        saveProbeResults(merged);
        return merged;
      });
    } catch (err) {
      onToast({
        title: `${target === "telegram" ? "Telegram" : "QQ"} 延迟测试失败`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setProbingChannel(null);
    }
  };

  const handleLoadPairingCode = async (refresh = false) => {
    setPairingLoading(true);
    try {
      const res = await api.getPairingCode(refresh);
      setPairingInfo(res);
      setPairingOpen(true);
    } catch (err) {
      onToast({
        title: "获取配对码失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setPairingLoading(false);
    }
  };

  const handleUnbindHome = async () => {
    setUnbindingHome(true);
    try {
      const res = await api.unbindHome(clearWhitelistOnUnbind);
      setPairingInfo({
        ok: true,
        homeBound: res.home.bound,
        currentHome: res.home,
        code: res.pairing.code,
        command: res.pairing.command,
        expiresAt: res.pairing.expiresAt,
      });
      setPairingOpen(true);
      await loadOverview(true);
      onToast({
        title: "已解绑原 Home Channel",
        description: res.clearedWhitelist
          ? "已同时清空原通道主人白名单，现在可使用 /sethome 绑定新账号。"
          : "现在可在 Telegram 或 QQ 发送 /sethome 重新绑定。",
        status: "success",
      });
    } catch (err) {
      onToast({
        title: "解绑原 Home 失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setUnbindingHome(false);
    }
  };

  const handleCopyPairing = async () => {
    if (!pairingInfo?.command) return;
    try {
      await navigator.clipboard.writeText(pairingInfo.command);
      setCopiedPairing(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => setCopiedPairing(false), 1500);
    } catch {
      onToast({ title: "复制失败，请手动复制指令", status: "error" });
    }
  };

  if (loading && !overview) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        正在加载系统概览…
      </div>
    );
  }

  if (!overview && loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          <span>获取系统概览失败</span>
        </div>
        <p className="max-w-md text-xs text-muted-foreground">{loadError}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => void loadOverview(false)}
        >
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          重试
        </Button>
      </div>
    );
  }

  return (
    <LayoutGroup>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-5 sm:p-7">
      {/* Top header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">系统概览</h2>
        </div>
        <div className="flex items-center gap-2">
          {overview ? (
            <AnimatedBadge status="neutral" size="md" showIcon={false}>
              <span className="inline-flex items-center gap-1.5 font-mono">
                <Timer className="size-3.5 shrink-0" />
                <span>运行 {formatDurationClock(liveUptimeSec)}</span>
              </span>
            </AnimatedBadge>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pairingLoading}
            onClick={() => {
              if (pairingOpen && pairingInfo) {
                setPairingOpen(false);
              } else {
                void handleLoadPairingCode(false);
              }
            }}
          >
            <KeyRound className="size-3.5" />
            {pairingOpen ? "收起 Home 绑定" : "Home 绑定 / 配对码"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => void loadOverview(false)}
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {pairingOpen && pairingInfo ? (
          <motion.div
            key="pairing-banner"
            layout
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ ...SPRING_LAYOUT, opacity: { duration: 0.16 } }}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3 text-xs"
          >
            {pairingInfo.homeBound ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound className="size-4 text-primary" />
                    <span className="font-medium text-foreground">当前已绑定 Home Channel：</span>
                    <code className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs font-semibold text-foreground">
                      {pairingInfo.currentHome.channel === "tg" ? "Telegram" : "QQ"} ·{" "}
                      {pairingInfo.currentHome.targetId}
                    </code>
                    <span className="text-muted-foreground">
                      如需执行 /sethome 更换 Home，必须先在此解绑原 Home
                    </span>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground select-none">
                    <input
                      type="checkbox"
                      className="size-3.5 rounded border-border accent-primary"
                      checked={clearWhitelistOnUnbind}
                      onChange={(e) => setClearWhitelistOnUnbind(e.target.checked)}
                    />
                    同时清空原通道主人白名单（换绑同平台新账号时勾选）
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    disabled={unbindingHome}
                    onClick={() => void handleUnbindHome()}
                  >
                    {unbindingHome ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Unlink className="size-3.5" />
                    )}
                    解绑原 Home
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound className="size-4 text-primary" />
                  <span className="font-medium text-foreground">主人绑定指令（15 分钟有效）：</span>
                  <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs font-semibold text-foreground">
                    {pairingInfo.command}
                  </code>
                  <span className="text-muted-foreground">
                    在 Telegram 或 QQ 私聊机器人发送即可绑定并设为 Home Channel（已在白名单的账号可直接发送 /sethome）
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCopyPairing()}
                  >
                    {copiedPairing ? (
                      <Check className="size-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copiedPairing ? "已复制" : "复制"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pairingLoading}
                    onClick={() => void handleLoadPairingCode(true)}
                  >
                    <RefreshCw className={`size-3.5 ${pairingLoading ? "animate-spin" : ""}`} />
                    换一个
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Separate TG & QQ Gateway Cards */}
      <motion.div
        layout
        transition={{ layout: SPRING_LAYOUT }}
        className="grid grid-cols-1 gap-4 md:grid-cols-2"
      >
        <GatewayStatusCard
          code="TG"
          title={
            overview?.gateways.telegram.displayName ||
            (overview?.gateways.telegram.username
              ? `@${overview.gateways.telegram.username}`
              : "Telegram 通道")
          }
          subtitle={
            overview?.gateways.telegram.displayName && overview?.gateways.telegram.username
              ? `@${overview.gateways.telegram.username}`
              : undefined
          }
          protocol="Polling"
          enabled={overview?.gateways.telegram.enabled ?? false}
          running={overview?.gateways.telegram.running ?? false}
          online={overview?.gateways.telegram.online ?? false}
          avatarUrl={overview?.gateways.telegram.avatarUrl}
          uptimeSec={liveUptimeSec}
          messageCount={overview?.messages.byChannel.tg ?? 0}
          whitelistCount={overview?.gateways.telegram.whitelistCount ?? 0}
          probeResult={probeResults.telegram}
          probing={probingChannel === "telegram"}
          toggling={togglingChannel === "tg"}
          onToggle={() =>
            void handleToggleGateway("tg", !(overview?.gateways.telegram.enabled ?? false))
          }
          onTestLatency={() => void handleTestLatency("telegram")}
          onOpenSettings={() => onNavigateSettings("gateway")}
        />
        <GatewayStatusCard
          code="QQ"
          title={overview?.gateways.qq.username || "QQ 官方机器人"}
          subtitle={overview?.gateways.qq.botId ? `QQ号 ${overview.gateways.qq.botId}` : undefined}
          protocol="WebSocket v2"
          enabled={overview?.gateways.qq.enabled ?? false}
          running={overview?.gateways.qq.running ?? false}
          online={overview?.gateways.qq.online ?? false}
          avatarUrl={overview?.gateways.qq.avatarUrl}
          uptimeSec={liveUptimeSec}
          messageCount={overview?.messages.byChannel.qq ?? 0}
          whitelistCount={overview?.gateways.qq.whitelistCount ?? 0}
          probeResult={probeResults.qq}
          probing={probingChannel === "qq"}
          toggling={togglingChannel === "qq"}
          onToggle={() =>
            void handleToggleGateway("qq", !(overview?.gateways.qq.enabled ?? false))
          }
          onTestLatency={() => void handleTestLatency("qq")}
          onOpenSettings={() => onNavigateSettings("gateway")}
        />
      </motion.div>

      {/* Messages & Runtime Stats */}
      <motion.div
        layout
        transition={{ layout: SPRING_LAYOUT }}
        className="grid grid-cols-1 gap-4 md:grid-cols-2"
      >
        <motion.div
          layout
          whileHover={{ y: -3, scale: 1.005 }}
          transition={{ layout: SPRING_LAYOUT, type: "spring", stiffness: 360, damping: 24 }}
        >
          <Card
            variant="muted"
            className="h-full rounded-2xl border border-border/80 bg-card/75 px-1 shadow-sm transition-colors hover:border-primary/35 hover:shadow-md"
          >
            <CardHeader className="pb-1">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <MessageSquare className="size-4 text-primary" />
                  消息与上下文统计
                </CardTitle>
                <Button type="button" variant="ghost" size="sm" onClick={() => onNavigateTab("chat")}>
                  前往对话
                </Button>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <div className="text-[11px] text-muted-foreground">总消息数</div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                  {overview?.messages.total ?? 0}
                </div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <div className="text-[11px] text-muted-foreground">接收消息</div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                  {overview?.messages.inbound ?? 0}
                </div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <div className="text-[11px] text-muted-foreground">发出回复</div>
                <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                  {overview?.messages.outbound ?? 0}
                </div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <div className="text-[11px] text-muted-foreground">近 24 小时</div>
                <div
                  className={`mt-1 font-mono text-base font-semibold tabular-nums ${
                    (overview?.messages.last24h ?? 0) === 0
                      ? "text-muted-foreground"
                      : "text-foreground"
                  }`}
                >
                  {overview?.messages.last24h ?? 0}
                </div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <div className="text-[11px] text-muted-foreground">热区消息</div>
                <div
                  className={`mt-1 font-mono text-base font-semibold tabular-nums ${
                    (overview?.messages.hotCount ?? 0) === 0
                      ? "text-muted-foreground"
                      : "text-foreground"
                  }`}
                >
                  {overview?.messages.hotCount ?? 0}
                </div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <div className="text-[11px] text-muted-foreground">Web 消息</div>
                <div
                  className={`mt-1 font-mono text-base font-semibold tabular-nums ${
                    (overview?.messages.byChannel.web ?? 0) === 0
                      ? "text-muted-foreground"
                      : "text-foreground"
                  }`}
                >
                  {overview?.messages.byChannel.web ?? 0}
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div
          layout
          whileHover={{ y: -2 }}
          transition={{ layout: SPRING_LAYOUT, type: "spring", stiffness: 360, damping: 26 }}
        >
          <Card
            variant="muted"
            className="h-full rounded-2xl border border-border/80 bg-card/75 px-1 shadow-sm transition-colors hover:border-primary/35 hover:shadow-md"
          >
            <CardHeader className="pb-1">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Cpu className="size-4 text-primary" />
                  工单与推理概况
                </CardTitle>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigateTab("models")}
                >
                  模型配置
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                  <div className="text-[11px] text-muted-foreground">后台工单</div>
                  <div className="mt-1 font-mono text-base font-semibold tabular-nums text-foreground">
                    {overview?.tickets.total ?? 0}
                    <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                      ({overview?.tickets.active ?? 0} 活跃)
                    </span>
                  </div>
                </div>
                <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                  <div className="text-[11px] text-muted-foreground">平均耗时</div>
                  <div
                    className="mt-1 font-mono text-base font-semibold tabular-nums text-foreground"
                    title={
                      overview?.turns.avgLatencyMs != null
                        ? `${overview.turns.avgLatencyMs}ms`
                        : undefined
                    }
                  >
                    {formatLatency(overview?.turns.avgLatencyMs)}
                  </div>
                </div>
                <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                  <div className="text-[11px] text-muted-foreground">缓存命中率</div>
                  <div
                    className={`mt-1 font-mono text-base font-semibold tabular-nums ${
                      (overview?.turns.avgCacheHitRate ?? 0) === 0
                        ? "text-muted-foreground"
                        : "text-foreground"
                    }`}
                  >
                    {overview?.turns.avgCacheHitRate != null
                      ? `${overview.turns.avgCacheHitRate}%`
                      : "--"}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/20 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    <Bot className="size-3.5" />
                    主对话模型
                  </span>
                  <span className="min-w-0 truncate font-mono text-foreground">
                    {overview?.runtime.personaModel || "--"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    <Wifi className="size-3.5" />
                    Worker 后端
                  </span>
                  <span className="min-w-0 truncate font-mono text-foreground">
                    {overview?.runtime.workerBackend || "--"} (
                    {overview?.runtime.workerRoutingMode || "smart"})
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    <Database className="size-3.5" />
                    记忆后端
                  </span>
                  <span className="min-w-0 truncate font-mono text-foreground">
                    {overview?.runtime.memoryProvider || "none"}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
      </div>
    </LayoutGroup>
  );
}
