import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Compass,
  Cpu,
  FileText,
  History,
  LayoutDashboard,
  Loader2,
  Lock,
  MessageSquare,
  PanelLeft,
  RefreshCw,
  Settings,
  Smile,
  X,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ChatSessionRecord,
  type ConfigSnapshotResponse,
  getStoredToken,
  type HealthResponse,
  setStoredToken,
} from "@/api";
import { ChatPanel } from "@/components/console/ChatPanel";
import { ConsoleInput } from "@/components/console/ConsolePrimitives";
import { ModelsConfigPanel } from "@/components/console/ModelsConfigPanel";
import { OverviewPanel } from "@/components/console/OverviewPanel";
import { PromptPanel } from "@/components/console/PromptPanel";
import { RemoteBrowserPanel } from "@/components/console/RemoteBrowserPanel";
import { StickersPanel } from "@/components/console/StickersPanel";
import {
  SettingsPanel,
  type SettingsSectionId,
  VALID_SETTINGS_SECTIONS,
} from "@/components/console/SettingsPanel";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import {
  AnimatedToastStack,
  useAnimatedToastStack,
} from "@/components/motion/animated-toast-stack";
import { Button, StatefulButton, type ButtonState } from "@/components/motion/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/motion/card";
import { SharedLayoutBg } from "@/components/motion/shared-layout-bg";
import { ThemeToggle } from "@/components/motion/theme-toggle";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";

type ConsoleTab = "overview" | "chat" | "stickers" | "browser" | "models" | "prompt" | "settings";

const NAV_ITEMS: Array<{
  id: Exclude<ConsoleTab, "settings">;
  label: string;
  icon: typeof MessageSquare;
}> = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "stickers", label: "表情包库", icon: Smile },
  { id: "browser", label: "远程浏览器", icon: Compass },
  { id: "models", label: "模型与供应商", icon: Cpu },
  { id: "prompt", label: "提示词", icon: FileText },
];

const VALID_TABS = new Set<ConsoleTab>([
  "overview",
  "chat",
  "stickers",
  "browser",
  "models",
  "prompt",
  "settings",
]);

const ACTIVE_TAB_STORAGE_KEY = "hato.activeTab";
const SETTINGS_SECTION_STORAGE_KEY = "hato.settingsSection";

function isValidConsoleTab(value: string | null | undefined): value is ConsoleTab {
  return Boolean(value && VALID_TABS.has(value as ConsoleTab));
}

function isValidSettingsSection(value: string | null | undefined): value is SettingsSectionId {
  return Boolean(value && VALID_SETTINGS_SECTIONS.has(value as SettingsSectionId));
}

function readStoredSettingsSection(): SettingsSectionId {
  try {
    const stored = window.localStorage.getItem(SETTINGS_SECTION_STORAGE_KEY);
    if (isValidSettingsSection(stored)) {
      return stored;
    }
  } catch {
    // Ignore storage restrictions.
  }
  return "general";
}

function parseRouteHash(rawHash: string): {
  tab?: ConsoleTab;
  settingsSection?: SettingsSectionId;
} {
  const clean = rawHash.replace(/^#\/?/, "").trim();
  if (!clean) return {};
  if (clean === "runtime") {
    return { tab: "settings", settingsSection: "general" };
  }
  if (clean === "secrets") {
    return { tab: "settings", settingsSection: "secrets" };
  }
  if (clean === "settings" || clean.startsWith("settings/")) {
    const sub = clean.slice("settings/".length);
    return {
      tab: "settings",
      settingsSection: isValidSettingsSection(sub) ? sub : undefined,
    };
  }
  if (isValidConsoleTab(clean)) {
    return { tab: clean };
  }
  return {};
}

function readInitialRoute(): { tab: ConsoleTab; settingsSection: SettingsSectionId } {
  const fallbackSection = readStoredSettingsSection();
  try {
    const fromHash = parseRouteHash(window.location.hash);
    if (fromHash.tab) {
      return {
        tab: fromHash.tab,
        settingsSection: fromHash.settingsSection ?? fallbackSection,
      };
    }
    const storedTab = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (storedTab === "runtime") {
      return { tab: "settings", settingsSection: "general" };
    }
    if (storedTab === "secrets") {
      return { tab: "settings", settingsSection: "secrets" };
    }
    if (isValidConsoleTab(storedTab)) {
      return { tab: storedTab, settingsSection: fallbackSection };
    }
  } catch {
    // Ignore storage or location restrictions.
  }
  return { tab: "overview", settingsSection: fallbackSection };
}

function ConsoleShell() {
  const [initialRoute] = useState(readInitialRoute);
  const [activeTab, setActiveTab] = useState<ConsoleTab>(initialRoute.tab);
  const [lastNonSettingsTab, setLastNonSettingsTab] = useState<Exclude<ConsoleTab, "settings">>(
    initialRoute.tab === "settings" ? "chat" : initialRoute.tab,
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>(
    initialRoute.settingsSection,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("hato.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [rootWarningDismissed, setRootWarningDismissed] = useState(() => {
    try {
      return window.localStorage.getItem("hato.rootWarningDismissed") === "1";
    } catch {
      return false;
    }
  });
  const [healthOffline, setHealthOffline] = useState(false);
  const [pendingTakeover, setPendingTakeover] = useState(false);
  const [configSnap, setConfigSnap] = useState<ConfigSnapshotResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [tokenInput, setTokenInput] = useState(getStoredToken);
  const [reloadState, setReloadState] = useState<ButtonState>("idle");
  const reloadTimerRef = useRef<number | null>(null);
  const [modelsDirty, setModelsDirty] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({ limit: 4 });
  const reduceMotion = useReducedMotion();
  const isSettings = activeTab === "settings";
  const workspaceTab: Exclude<ConsoleTab, "settings"> = isSettings
    ? lastNonSettingsTab
    : activeTab;

  useEffect(() => {
    if (activeTab !== "settings") {
      setLastNonSettingsTab(activeTab);
    }
    try {
      window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTab);
      window.localStorage.setItem(SETTINGS_SECTION_STORAGE_KEY, settingsSection);
      const nextHash =
        activeTab === "settings" ? `#settings/${settingsSection}` : `#${activeTab}`;
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", nextHash);
      }
    } catch {
      // Ignore storage or history restrictions.
    }
  }, [activeTab, settingsSection]);

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseRouteHash(window.location.hash);
      if (parsed.tab) {
        setActiveTab(parsed.tab);
      }
      if (parsed.settingsSection) {
        setSettingsSection(parsed.settingsSection);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("hato.sidebarCollapsed", next ? "1" : "0");
      } catch {
        // Ignore storage restrictions.
      }
      return next;
    });
  };

  const notify = useCallback(
    (input: {
      title: string;
      description?: string;
      status?: "info" | "success" | "error";
      action?: { label: string; onClick: () => void };
      duration?: number;
    }) => {
      showToast({
        title: input.title,
        description: input.description,
        status: input.status ?? "info",
        action: input.action
          ? {
              label: input.action.label,
              onClick: () => input.action?.onClick(),
            }
          : undefined,
        duration: input.duration,
      });
    },
    [showToast],
  );

  const refreshSessions = useCallback(async () => {
    try {
      const res = await api.getSessions();
      setSessions(res.sessions);
    } catch {
      // Non-fatal; active session remains usable.
    }
  }, []);

  const loadHealthAndConfig = useCallback(async () => {
    setConfigError(null);
    try {
      const h = await api.getHealth();
      setHealth(h);
      setHealthOffline(false);
      setPendingTakeover(h.pendingTakeover);

      if (h.authRequired && !getStoredToken()) {
        setAuthNeeded(true);
        return;
      }

      const [snap, sessRes] = await Promise.all([
        api.getConfig(),
        api.getSessions().catch(() => ({ ok: true, sessions: [] as ChatSessionRecord[] })),
      ]);
      setConfigSnap(snap);
      setSessions(sessRes.sessions);
      setAuthNeeded(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unauthorized") || msg.includes("401")) {
        setAuthNeeded(true);
      } else {
        setHealthOffline(true);
        setConfigError(msg);
        notify({ title: "无法连接 Hato 服务", description: msg, status: "error" });
      }
    }
  }, [notify]);

  useEffect(() => {
    void loadHealthAndConfig();
    const timer = window.setInterval(() => {
      void api
        .getHealth()
        .then((h) => {
          setHealth(h);
          setHealthOffline(false);
          setPendingTakeover(h.pendingTakeover);
        })
        .catch(() => {
          setHealthOffline(true);
        });
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [loadHealthAndConfig]);

  useEffect(() => {
    return () => {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
    };
  }, []);

  const navigateToTab = useCallback(
    (
      nextTab: ConsoleTab,
      opts?: { sessionId?: string | null; settingsSection?: SettingsSectionId },
    ) => {
      if (activeTab === "models" && nextTab !== "models" && modelsDirty) {
        if (!window.confirm("「模型与供应商」存在未保存的更改，确定要离开吗？")) return;
      }
      if (activeTab === "prompt" && nextTab !== "prompt" && promptDirty) {
        if (!window.confirm("「提示词」存在未保存的更改，确定要离开吗？")) return;
      }
      if (opts?.settingsSection) {
        setSettingsSection(opts.settingsSection);
      }
      if (opts && "sessionId" in opts) {
        setSelectedSessionId(opts.sessionId ?? null);
      } else if (nextTab === "chat") {
        setSelectedSessionId(null);
      }
      setActiveTab(nextTab);
    },
    [activeTab, modelsDirty, promptDirty],
  );

  const handleGlobalReload = async () => {
    if (reloadTimerRef.current !== null) {
      window.clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = null;
    }
    setReloadState("loading");
    try {
      const res = await api.reloadConfig();
      setReloadState("success");
      const snap = await api.getConfig();
      setConfigSnap(snap);
      setConfigError(null);
      notify({
        title: "配置已重新加载",
        description: res.changes?.length ? res.changes.join("；") : "配置内容无变化",
        status: "success",
      });
      reloadTimerRef.current = window.setTimeout(() => setReloadState("idle"), 1500);
    } catch (err) {
      setReloadState("error");
      notify({
        title: "重新加载配置失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
      reloadTimerRef.current = window.setTimeout(() => setReloadState("idle"), 2000);
    }
  };

  if (authNeeded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
        <Card className="w-full max-w-sm border-b-0">
          <CardHeader className="border-b border-border/75 pb-4">
            <div className="mb-1.5 flex items-center gap-2 text-primary">
              <Lock className="size-4" />
              <span className="text-xs font-medium tracking-wide">Hato 控制台</span>
            </div>
            <CardTitle as="h2" className="text-lg tracking-tight">
              验证访问令牌
            </CardTitle>
            <CardDescription>请输入控制台访问令牌以继续。</CardDescription>
          </CardHeader>
          <CardContent className="pt-1">
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                setStoredToken(tokenInput);
                void loadHealthAndConfig();
              }}
            >
              <ConsoleInput
                type="password"
                label="访问令牌"
                value={tokenInput}
                onChange={setTokenInput}
                placeholder="输入访问令牌"
                autoFocus
              />
              <Button type="submit" className="w-full">
                进入控制台
              </Button>
            </form>
          </CardContent>
        </Card>
        <AnimatedToastStack toasts={toasts} onDismiss={dismissToast} fixed />
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-background px-3 sm:gap-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2.5">
          {activeTab === "settings" ? (
            <button
              type="button"
              onClick={() => setActiveTab(lastNonSettingsTab)}
              title="返回控制台"
              aria-label="返回控制台"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={toggleSidebar}
              title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              data-testid="sidebar-toggle"
              className="hidden size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:inline-flex"
            >
              <PanelLeft className="size-4" />
            </button>
          )}
          <div className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
            <Bot className="size-3.5" />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2.5">
            <h1 className="shrink-0 whitespace-nowrap text-[13px] font-semibold tracking-tight text-foreground">
              Hato 控制台
            </h1>
            <span className="hidden h-3.5 w-px bg-border sm:block" aria-hidden="true" />
            {healthOffline ? (
              <AnimatedBadge status="danger" size="sm">
                服务连接断开
              </AnimatedBadge>
            ) : health?.ok ? (
              <AnimatedBadge status="success" size="sm">
                {health.console.host}:{health.console.port}
              </AnimatedBadge>
            ) : (
              <AnimatedBadge status="neutral" size="sm">
                连接中
              </AnimatedBadge>
            )}
            {pendingTakeover && (
              <button
                type="button"
                onClick={() => navigateToTab("browser")}
                className="hidden cursor-pointer sm:inline-flex"
              >
                <AnimatedBadge status="warning" size="sm" pulse>
                  浏览器待操作 · 点击处理
                </AnimatedBadge>
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          <a
            href={health?.githubUrl ?? "https://github.com/peach0x33a/hato"}
            target="_blank"
            rel="noreferrer"
            title={`GitHub · Hato${health?.version ? ` v${health.version}` : ""}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/80 bg-muted/40 px-2 font-mono text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" className="size-3.5 fill-current" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            <span>{health?.version ? `v${health.version}` : "GitHub"}</span>
          </a>
          {health?.update?.hasUpdate && health.update.latestTag ? (
            <a
              href={health.update.releaseUrl}
              target="_blank"
              rel="noreferrer"
              title={`发现新版本 ${health.update.latestTag} (${health.update.channel})`}
              className="hidden sm:inline-flex"
            >
              <AnimatedBadge status="warning" size="sm">
                新版本 {health.update.latestTag}
              </AnimatedBadge>
            </a>
          ) : null}
          <StatefulButton
            type="button"
            variant="ghost"
            size="sm"
            title="重载配置"
            aria-label="重载配置"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground sm:px-2.5"
            state={reloadState}
            loadingText="重载中…"
            successText="已重载"
            errorText="重载失败"
            icon={<RefreshCw className="size-3" />}
            onClick={() => void handleGlobalReload()}
          >
            <span className="hidden sm:inline">重载配置</span>
          </StatefulButton>
          <span className="mx-0.5 h-3.5 w-px bg-border/80" aria-hidden="true" />
          <ThemeToggle variant="circle-blur" start="top-right" />
        </div>
      </header>

      {health?.runtime?.showRootWarning && !rootWarningDismissed ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/35 bg-amber-500/12 px-4 py-2 text-xs text-amber-900 dark:text-amber-200"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="font-medium">使用root用户运行Hato存在未知的风险</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                try {
                  window.localStorage.setItem("hato.rootWarningDismissed", "1");
                } catch {
                  // Ignore storage restrictions.
                }
                setRootWarningDismissed(true);
              }}
              className="inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium text-amber-800/90 transition-colors hover:bg-amber-500/20 hover:text-amber-950 dark:text-amber-200/90 dark:hover:text-amber-50"
            >
              不再提示
            </button>
            <button
              type="button"
              onClick={() => setRootWarningDismissed(true)}
              title="本次关闭提示"
              aria-label="关闭 root 风险提示"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-amber-800/80 transition-colors hover:bg-amber-500/20 hover:text-amber-950 dark:text-amber-200/80 dark:hover:text-amber-50"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <motion.div
          inert={isSettings}
          aria-hidden={isSettings}
          animate={
            isSettings
              ? reduceMotion
                ? { opacity: 0 }
                : { opacity: 0.3, scale: 0.985 }
              : { opacity: 1, scale: 1 }
          }
          transition={reduceMotion ? { duration: 0.1 } : { duration: 0.22, ease: EASE_OUT }}
          className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden lg:flex-row"
        >
          <aside
            data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
            className={`flex shrink-0 flex-row items-center gap-1 border-b border-border/80 bg-muted/20 p-2 transition-[width] duration-150 lg:flex-col lg:items-stretch lg:gap-0 lg:border-r lg:border-b-0 ${
              sidebarCollapsed ? "lg:w-[52px]" : "lg:w-52"
            }`}
          >
            <SharedLayoutBg
              as="div"
              inset={0}
              pillClassName="rounded-md bg-muted"
              className="flex flex-row min-w-0 flex-1 gap-1 overflow-x-auto lg:flex-none lg:flex-col"
            >
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = workspaceTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  onClick={() => {
                    navigateToTab(item.id, item.id === "chat" ? { sessionId: null } : undefined);
                  }}
                  className={`relative flex h-8 shrink-0 items-center overflow-hidden rounded-md transition-colors ${
                    sidebarCollapsed ? "justify-center px-2.5 lg:px-0" : "px-2.5 text-left"
                  } ${
                    isActive
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div className={`flex items-center ${sidebarCollapsed ? "gap-2 lg:gap-0" : "gap-2.5"}`}>
                    <Icon
                      className={`size-4 shrink-0 ${isActive ? "text-primary" : ""}`}
                    />
                    <span
                      className={`truncate text-xs ${sidebarCollapsed ? "lg:hidden" : ""}`}
                    >
                      {item.label}
                    </span>
                    {item.id === "browser" && pendingTakeover && (
                      <span
                        className={`size-2 shrink-0 rounded-full bg-amber-500 ${
                          sidebarCollapsed ? "lg:absolute lg:top-1.5 lg:right-1.5" : ""
                        }`}
                      />
                    )}
                  </div>
                </button>
              );
            })}
          </SharedLayoutBg>

          {/* Compact Read-Only Session History */}
          {!sidebarCollapsed && (
            <div className="mt-3 hidden min-h-0 flex-1 flex-col border-t border-border/75 pt-3 lg:flex">
              <div className="mb-1.5 flex items-center justify-between px-2 text-[10px] font-medium tracking-wide text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <History className="size-3" />
                  会话记录
                </span>
                <span className="font-mono tabular-nums">{sessions.length + 1}</span>
              </div>

              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
                <button
                  type="button"
                  onClick={() => navigateToTab("chat", { sessionId: null })}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                      workspaceTab === "chat" && selectedSessionId === null
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <span className="truncate">当前会话</span>
                    <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                  </button>

                  {sessions.length === 0 ? (
                    <p className="px-2 py-2 text-[11px] text-muted-foreground/75">
                      暂无历史会话记录
                    </p>
                  ) : (
                    sessions.map((sess) => {
                      const isSel = workspaceTab === "chat" && selectedSessionId === sess.id;
                      const endedDate = new Date(sess.endedAt);
                      const shortDate = Number.isNaN(endedDate.getTime())
                        ? "--"
                        : endedDate.toLocaleDateString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                          });
                      return (
                        <button
                          key={sess.id}
                          type="button"
                          title={`${sess.title} (只读 · ${sess.messageCount} 条消息)`}
                          onClick={() => navigateToTab("chat", { sessionId: sess.id })}
                          className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ${
                            isSel
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          }`}
                        >
                          <span className="truncate text-[11px] font-medium">{sess.title}</span>
                          <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground/80">
                            <span>{shortDate}</span>
                            <span>{sess.messageCount}条 · 只读</span>
                          </div>
                        </button>
                      );
                    })
                  )}
              </div>
            </div>
          )}

          {/* Bottom-pinned Settings Trigger (matching reference skeleton) */}
          <div className="shrink-0 border-l border-border/75 pl-1 lg:mt-auto lg:border-t lg:border-l-0 lg:pt-2 lg:pl-0">
            <button
              type="button"
              title="设置"
              aria-label="设置"
              onClick={() => navigateToTab("settings")}
              className={`flex h-8 shrink-0 items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground lg:w-full ${
                sidebarCollapsed ? "justify-center px-2.5 lg:px-0" : "gap-2.5 px-2.5 text-left"
              }`}
            >
              <Settings className="size-4 shrink-0" />
              <span className={`truncate text-xs ${sidebarCollapsed ? "lg:hidden" : ""}`}>
                设置
              </span>
            </button>
          </div>
          </aside>

          <main
            className={`min-h-0 min-w-0 max-w-full flex-1 bg-background ${
              workspaceTab === "chat" ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"
            }`}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={workspaceTab}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transitionEnd: { transform: "none" },
                }}
                exit={
                  reduceMotion
                    ? undefined
                    : { opacity: 0, y: -4, transition: { duration: 0.12, ease: EASE_OUT } }
                }
                transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
                className={
                  workspaceTab === "chat" || workspaceTab === "browser" || workspaceTab === "prompt"
                    ? "h-full min-h-0"
                    : "min-h-full"
                }
              >
                {workspaceTab === "overview" && (
                  <OverviewPanel
                    onNavigateTab={(tab) => navigateToTab(tab)}
                    onNavigateSettings={(section) =>
                      navigateToTab("settings", { settingsSection: section })
                    }
                    onToast={notify}
                  />
                )}

                {workspaceTab === "chat" && (
                  <div className="flex h-full min-h-0 min-w-0 w-full flex-col">
                    <ChatPanel
                      onToast={notify}
                      pendingTakeover={pendingTakeover}
                      onPendingTakeoverChange={setPendingTakeover}
                      onOpenBrowserPanel={() => navigateToTab("browser")}
                      onAuthError={() => setAuthNeeded(true)}
                      sessions={sessions}
                      selectedSessionId={selectedSessionId}
                      onSelectSession={setSelectedSessionId}
                      onSessionsChanged={() => void refreshSessions()}
                    />
                  </div>
                )}

                {workspaceTab === "stickers" && <StickersPanel onToast={notify} />}

                {workspaceTab === "browser" && (
                  <div className="flex h-full min-h-0 w-full flex-col p-3 sm:p-5">
                    <RemoteBrowserPanel
                      onToast={notify}
                      onPendingTakeoverChange={setPendingTakeover}
                      onGoToChatAndResume={() => {
                        navigateToTab("chat");
                        notify({
                          title: "已解除挂起状态",
                          description: "回到对话后可点击继续任务，或发送下一步指令。",
                          status: "success",
                        });
                      }}
                    />
                  </div>
                )}

                {workspaceTab === "models" &&
                  (configSnap ? (
                    <ModelsConfigPanel
                      initialConfig={configSnap.modelsConfig}
                      secretStates={configSnap.secretStates}
                      hindsightEnabled={configSnap.hatoConfig.memory?.provider === "hindsight"}
                      onDirtyChange={setModelsDirty}
                      onToast={notify}
                      onSaved={(next) => {
                        setConfigSnap((prev) => (prev ? { ...prev, modelsConfig: next } : prev));
                      }}
                      onSecretsUpdated={(nextStates) => {
                        setConfigSnap((prev) =>
                          prev ? { ...prev, secretStates: nextStates } : prev,
                        );
                      }}
                    />
                  ) : (
                    <ConfigFallbackState
                      label="正在加载模型配置…"
                      error={configError ?? (healthOffline ? "无法连接 Hato 服务" : null)}
                      onRetry={() => void loadHealthAndConfig()}
                    />
                  ))}

                {workspaceTab === "prompt" &&
                  (configSnap ? (
                    <PromptPanel
                      promptPath={configSnap.promptPath}
                      initialPrompt={configSnap.promptText}
                      promptLayers={configSnap.promptLayers}
                      onDirtyChange={setPromptDirty}
                      onToast={notify}
                      onSaved={(nextPrompt) => {
                        setConfigSnap((prev) =>
                          prev ? { ...prev, promptText: nextPrompt } : prev,
                        );
                      }}
                      onLayersSynced={(next) => {
                        setConfigSnap((prev) =>
                          prev
                            ? {
                                ...prev,
                                hatoConfig: next.hatoConfig ?? prev.hatoConfig,
                                promptPath: next.promptPath ?? prev.promptPath,
                                promptText: next.promptText ?? prev.promptText,
                                promptLayers: next.promptLayers ?? prev.promptLayers,
                              }
                            : prev,
                        );
                      }}
                    />
                  ) : (
                    <ConfigFallbackState
                      label="正在加载提示词配置…"
                      error={configError ?? (healthOffline ? "无法连接 Hato 服务" : null)}
                      onRetry={() => void loadHealthAndConfig()}
                    />
                  ))}
              </motion.div>
            </AnimatePresence>
          </main>
        </motion.div>

        <AnimatePresence>
          {isSettings && (
            <motion.div
              key="settings-view"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.992 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.992 }}
              transition={reduceMotion ? { duration: 0.1 } : { duration: 0.22, ease: EASE_OUT }}
              className="absolute inset-0 z-20 flex min-h-0 bg-background"
            >
              {configSnap ? (
                <SettingsPanel
                  initialConfig={configSnap.hatoConfig}
                  secretStates={configSnap.secretStates}
                  activeSection={settingsSection}
                  onSectionChange={setSettingsSection}
                  onBack={() => setActiveTab(lastNonSettingsTab)}
                  onToast={notify}
                  onSavedConfig={(next) => {
                    setConfigSnap((prev) => (prev ? { ...prev, hatoConfig: next } : prev));
                  }}
                  onSecretsUpdated={(nextStates) => {
                    setConfigSnap((prev) =>
                      prev ? { ...prev, secretStates: nextStates } : prev,
                    );
                  }}
                />
              ) : (
                <ConfigFallbackState
                  label="正在加载设置…"
                  error={configError ?? (healthOffline ? "无法连接 Hato 服务" : null)}
                  onRetry={() => void loadHealthAndConfig()}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatedToastStack toasts={toasts} onDismiss={dismissToast} fixed />
    </div>
  );
}

function ConfigFallbackState({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          <span>配置加载失败</span>
        </div>
        <p className="max-w-md text-xs text-muted-foreground">{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          重试
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <MotionConfig transition={{ layout: SPRING_LAYOUT }}>
        <LayoutGroup>
          <ConsoleShell />
        </LayoutGroup>
      </MotionConfig>
    </ThemeProvider>
  );
}

export default App;
