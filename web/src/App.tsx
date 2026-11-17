import {
  Bot,
  Compass,
  Cpu,
  FileText,
  History,
  KeyRound,
  Lock,
  MessageSquare,
  PanelLeft,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useState } from "react";
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
import { PromptPanel } from "@/components/console/PromptPanel";
import { RemoteBrowserPanel } from "@/components/console/RemoteBrowserPanel";
import { RuntimeConfigPanel } from "@/components/console/RuntimeConfigPanel";
import { SecretsAndProbePanel } from "@/components/console/SecretsAndProbePanel";
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

type ConsoleTab =
  | "chat"
  | "browser"
  | "models"
  | "runtime"
  | "prompt"
  | "secrets";

const NAV_ITEMS: Array<{
  id: ConsoleTab;
  label: string;
  icon: typeof MessageSquare;
}> = [
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "browser", label: "远程浏览器", icon: Compass },
  { id: "models", label: "模型与供应商", icon: Cpu },
  { id: "runtime", label: "网关与代理", icon: Settings2 },
  { id: "prompt", label: "人设提示词", icon: FileText },
  { id: "secrets", label: "密钥与自检", icon: KeyRound },
];

function ConsoleShell() {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("hato.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthOffline, setHealthOffline] = useState(false);
  const [pendingTakeover, setPendingTakeover] = useState(false);
  const [configSnap, setConfigSnap] = useState<ConfigSnapshotResponse | null>(null);
  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [tokenInput, setTokenInput] = useState(getStoredToken);
  const [reloadState, setReloadState] = useState<ButtonState>("idle");
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({ limit: 4 });

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
    (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => {
      showToast({
        title: input.title,
        description: input.description,
        status: input.status ?? "info",
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

  const handleGlobalReload = async () => {
    setReloadState("loading");
    try {
      const res = await api.reloadConfig();
      setReloadState("success");
      const snap = await api.getConfig();
      setConfigSnap(snap);
      notify({
        title: "配置已重新加载",
        description: res.changes?.length ? res.changes.join("；") : "配置内容无变化",
        status: "success",
      });
      setTimeout(() => setReloadState("idle"), 1500);
    } catch (err) {
      setReloadState("error");
      notify({
        title: "重新加载配置失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
      setTimeout(() => setReloadState("idle"), 2000);
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
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-background px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
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
          <div className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
            <Bot className="size-3.5" />
          </div>
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="truncate text-[13px] font-semibold tracking-tight text-foreground">
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
                onClick={() => setActiveTab("browser")}
                className="cursor-pointer"
              >
                <AnimatedBadge status="warning" size="sm" pulse>
                  浏览器待操作 · 点击处理
                </AnimatedBadge>
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setActiveTab("browser")}
          >
            <Compass className="size-3.5" />
            <span className="hidden sm:inline">远程浏览器</span>
          </Button>
          <StatefulButton
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            state={reloadState}
            loadingText="重载中…"
            successText="已重载"
            errorText="重载失败"
            icon={<RefreshCw className="size-3" />}
            onClick={() => void handleGlobalReload()}
          >
            重载配置
          </StatefulButton>
          <span className="mx-0.5 h-3.5 w-px bg-border/80" aria-hidden="true" />
          <ThemeToggle variant="circle-blur" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside
          data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
          className={`flex shrink-0 flex-col border-b border-border/80 bg-muted/20 p-2 transition-[width] duration-150 lg:border-r lg:border-b-0 ${
            sidebarCollapsed ? "lg:w-[52px]" : "lg:w-52"
          }`}
        >
          <SharedLayoutBg
            as="div"
            inset={0}
            pillClassName="rounded-md bg-muted"
            className="flex shrink-0 gap-1 overflow-x-auto lg:flex-col"
          >
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  onClick={() => {
                    setActiveTab(item.id);
                    if (item.id === "chat") {
                      setSelectedSessionId(null);
                    }
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
                  onClick={() => {
                    setSelectedSessionId(null);
                    setActiveTab("chat");
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    activeTab === "chat" && selectedSessionId === null
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                >
                  <span className="truncate">当前会话</span>
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                </button>

                {sessions.map((sess) => {
                  const isSel = activeTab === "chat" && selectedSessionId === sess.id;
                  const shortDate = new Date(sess.endedAt).toLocaleDateString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                  });
                  return (
                    <button
                      key={sess.id}
                      type="button"
                      title={`${sess.title} (只读 · ${sess.messageCount} 条消息)`}
                      onClick={() => {
                        setSelectedSessionId(sess.id);
                        setActiveTab("chat");
                      }}
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
                })}
              </div>
            </div>
          )}
        </aside>

        <main className="min-h-0 flex-1 overflow-y-auto bg-background">
          {activeTab === "chat" && (
            <div className="flex h-full min-h-0 w-full flex-col">
              <ChatPanel
                onToast={notify}
                pendingTakeover={pendingTakeover}
                onPendingTakeoverChange={setPendingTakeover}
                onOpenBrowserPanel={() => setActiveTab("browser")}
                onAuthError={() => setAuthNeeded(true)}
                selectedSessionId={selectedSessionId}
                onSelectSession={setSelectedSessionId}
                onSessionsChanged={() => void refreshSessions()}
              />
            </div>
          )}

          {activeTab === "browser" && (
            <div className="flex h-full min-h-0 w-full flex-col p-3 sm:p-5">
              <RemoteBrowserPanel
                onToast={notify}
                onPendingTakeoverChange={setPendingTakeover}
                onGoToChatAndResume={() => {
                  setActiveTab("chat");
                  notify({
                    title: "已解除挂起状态",
                    description: "回到对话后可点击继续任务，或发送下一步指令。",
                    status: "success",
                  });
                }}
              />
            </div>
          )}

          {activeTab === "models" && configSnap && (
            <ModelsConfigPanel
              initialConfig={configSnap.modelsConfig}
              secretStates={configSnap.secretStates}
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
          )}

          {activeTab === "prompt" && configSnap && (
            <PromptPanel
              promptPath={configSnap.promptPath}
              initialPrompt={configSnap.promptText}
              promptLayers={configSnap.promptLayers}
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
          )}

          {(activeTab === "runtime" ||
            activeTab === "secrets") && (
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6">
              {activeTab === "runtime" && configSnap && (
                <RuntimeConfigPanel
                  initialConfig={configSnap.hatoConfig}
                  onToast={notify}
                  onSaved={(next) => {
                    setConfigSnap((prev) => (prev ? { ...prev, hatoConfig: next } : prev));
                  }}
                />
              )}

              {activeTab === "secrets" && configSnap && (
                <SecretsAndProbePanel
                  secretStates={configSnap.secretStates}
                  onToast={notify}
                  onSecretsUpdated={(nextStates) => {
                    setConfigSnap((prev) =>
                      prev ? { ...prev, secretStates: nextStates } : prev,
                    );
                  }}
                />
              )}
            </div>
          )}
        </main>
      </div>

      <AnimatedToastStack toasts={toasts} onDismiss={dismissToast} fixed />
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <ConsoleShell />
    </ThemeProvider>
  );
}

export default App;
