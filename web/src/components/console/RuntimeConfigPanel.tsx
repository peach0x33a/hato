import { Plus, RefreshCw, RotateCcw, Save, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type ExternalCliPermissionPreset,
  type ExternalCliProbeEntry,
  type HatoConfig,
  type ProxyRuleConfig,
} from "@/api";
import {
  ConsoleInput,
  ConsoleMultiSelect,
  ConsolePageHeader,
  ConsoleSelect,
} from "@/components/console/ConsolePrimitives";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, StatefulButton, type ButtonState } from "@/components/motion/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleIndicator,
  CollapsibleTrigger,
} from "@/components/motion/collapsible";
import { Switch } from "@/components/motion/switch";

const SCOPE_OPTIONS = [
  { value: "all", label: "all（全局默认）" },
  { value: "gateway", label: "gateway（Telegram 网关）" },
  { value: "llm-calling", label: "llm-calling（模型接口）" },
  { value: "web_access", label: "web_access（搜索与抓取）" },
  { value: "browser", label: "browser（浏览器访问）" },
  { value: "memory", label: "memory（长期记忆）" },
  { value: "mcp", label: "mcp（远程 MCP 服务）" },
  { value: "worker", label: "worker（后台任务）" },
];

const WORKER_BACKEND_OPTIONS = [
  { value: "codex", label: "codex（Tier 1 · Codex CLI）" },
  { value: "agy", label: "agy（Tier 1 · Antigravity CLI）" },
  { value: "opencode-v2", label: "opencode-v2（Tier 1 · OpenCode V2）" },
  { value: "external-pi", label: "external-pi（Tier 2 · 独立 Pi CLI）" },
  { value: "claude-code", label: "claude-code（Tier 3 · Claude Code）" },
  { value: "builtin-pi", label: "builtin-pi（内置沙箱 Worker）" },
];

const PERMISSION_PRESET_OPTIONS = [
  { value: "auto_safe", label: "auto_safe（沙箱内自动放行，推荐）" },
  { value: "yolo", label: "yolo（全部无需审批，完全放开）" },
  { value: "follow_host", label: "follow_host（沿用各工具本机配置）" },
  { value: "read_only", label: "read_only（只读分析 / 规划模式）" },
  { value: "custom", label: "custom（按各工具单独设置）" },
];

const FOLLOW_PRESET_VALUE = "__follow_preset__";

const BACKEND_CONFIG_KEYS: Record<
  ExternalCliProbeEntry["backend"],
  "codex" | "agy" | "opencode_v2" | "external_pi" | "claude_code"
> = {
  codex: "codex",
  agy: "agy",
  "opencode-v2": "opencode_v2",
  "external-pi": "external_pi",
  "claude-code": "claude_code",
};

const MODE_OPTIONS = [
  { value: "proxy", label: "走代理" },
  { value: "direct", label: "直连" },
];

const CHANNEL_OPTIONS = [
  { value: "chrome", label: "Google Chrome" },
  { value: "chromium", label: "Chromium" },
];

const XVFB_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "true", label: "始终开启" },
  { value: "false", label: "禁用" },
];

export interface RuntimeConfigPanelProps {
  initialConfig: HatoConfig;
  onSaved: (next: HatoConfig, changes?: string[]) => void;
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
}

export function RuntimeConfigPanel({
  initialConfig,
  onSaved,
  onToast,
}: RuntimeConfigPanelProps) {
  const [draft, setDraft] = useState<HatoConfig>(() => structuredClone(initialConfig));
  const [saveState, setSaveState] = useState<ButtonState>("idle");
  const [lastProxyUrls, setLastProxyUrls] = useState<Record<number, string>>({});
  const [cliProbes, setCliProbes] = useState<ExternalCliProbeEntry[]>([]);
  const [probingClis, setProbingClis] = useState(false);

  const loadCliProbes = useCallback(
    async (refresh = false) => {
      setProbingClis(true);
      try {
        const res = await api.probeWorkerClis(refresh);
        setCliProbes(res.probes);
      } catch (err) {
        if (refresh) {
          onToast({
            title: "探测外部 CLI 模式失败",
            description: err instanceof Error ? err.message : String(err),
            status: "error",
          });
        }
      } finally {
        setProbingClis(false);
      }
    },
    [onToast],
  );

  useEffect(() => {
    setDraft(structuredClone(initialConfig));
  }, [initialConfig]);

  useEffect(() => {
    void loadCliProbes(false);
  }, [loadCliProbes]);

  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initialConfig),
    [draft, initialConfig],
  );

  const proxies = draft.network?.proxies ?? [];

  const setProxies = (next: ProxyRuleConfig[]) => {
    setDraft((prev) => ({
      ...prev,
      network: { ...prev.network, proxies: next },
    }));
  };

  const addProxyRule = () => {
    setProxies([
      ...proxies,
      {
        name: `proxy-${proxies.length + 1}`,
        url: "http://127.0.0.1:7890",
        scope: ["browser"],
      },
    ]);
  };

  const updateProxyRule = (index: number, patch: Partial<ProxyRuleConfig>) => {
    setProxies(proxies.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const browserCfg = draft.web?.browser ?? {
    enabled: true,
    channel: "chrome",
    profile_dir: "./data/browser-profile",
    headless: "auto" as const,
    max_steps: 15,
    action_timeout_ms: 15000,
    idle_timeout_minutes: 5,
    xvfb: "auto" as const,
  };

  const setBrowserCfg = (patch: Partial<NonNullable<NonNullable<HatoConfig["web"]>["browser"]>>) => {
    setDraft((prev) => ({
      ...prev,
      web: {
        ...prev.web,
        browser: { ...browserCfg, ...patch },
      },
    }));
  };

  const searchCfg = draft.web?.search ?? {
    enabled: true,
    provider: "tavily" as const,
    api_key_env: "TAVILY_API_KEY",
    base_url: "https://api.tavily.com",
    max_results: 5,
    search_depth: "basic" as const,
  };

  const setSearchCfg = (patch: Partial<typeof searchCfg>) => {
    setDraft((prev) => ({
      ...prev,
      web: {
        ...prev.web,
        search: { ...searchCfg, ...patch },
      },
    }));
  };

  const consoleCfg = draft.web?.console ?? {
    enabled: true,
    host: "127.0.0.1",
    port: 3820,
  };

  const setConsoleCfg = (patch: Partial<typeof consoleCfg>) => {
    setDraft((prev) => ({
      ...prev,
      web: {
        ...prev.web,
        console: { ...consoleCfg, ...patch },
      },
    }));
  };

  const retryCfg = draft.gateway.retry ?? {
    max_retries: 3,
    initial_delay_ms: 500,
    backoff_multiplier: 2,
    max_delay_ms: 8000,
    jitter: true,
  };

  const handleReset = () => {
    setDraft(structuredClone(initialConfig));
    onToast({ title: "已还原未保存更改", status: "info" });
  };

  const handleSave = useCallback(async () => {
    if (saveState === "loading") return;
    setSaveState("loading");
    try {
      const res = await api.saveHatoConfig(draft);
      setSaveState("success");
      onSaved(draft, res.changes);
      void loadCliProbes(true);
      onToast({
        title: "运行配置已保存",
        description: res.changes?.length ? res.changes.join("；") : "配置已生效",
        status: "success",
      });
      setTimeout(() => setSaveState("idle"), 1600);
    } catch (err) {
      setSaveState("error");
      onToast({
        title: "保存运行配置失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
      setTimeout(() => setSaveState("idle"), 2000);
    }
  }, [draft, loadCliProbes, onSaved, onToast, saveState]);

  const extCliCfg = draft.worker.external_cli;
  const setExtCliCfg = (patch: Partial<HatoConfig["worker"]["external_cli"]>) => {
    setDraft((prev) => ({
      ...prev,
      worker: {
        ...prev.worker,
        external_cli: {
          ...prev.worker.external_cli,
          ...patch,
        },
      },
    }));
  };

  const applyAllNoApprovalPreset = () => {
    setDraft((prev) => {
      const ext = prev.worker.external_cli;
      const stripOverrides = <T extends Record<string, unknown> | undefined>(
        obj: T,
        keys: string[],
      ): T => {
        if (!obj) return obj;
        const copy: Record<string, unknown> = { ...obj };
        for (const k of keys) delete copy[k];
        return copy as T;
      };
      return {
        ...prev,
        worker: {
          ...prev.worker,
          external_cli: {
            ...ext,
            permission_preset: "yolo",
            codex: stripOverrides(ext.codex, ["sandbox", "approval"]),
            agy: stripOverrides(ext.agy, ["mode", "skip_permissions", "sandbox"]),
            opencode_v2: stripOverrides(ext.opencode_v2, ["auto"]),
            claude_code: stripOverrides(ext.claude_code, ["permission_mode", "skip_permissions"]),
          },
        },
      };
    });
    onToast({
      title: "已切换为全部无需审批 (YOLO)",
      description: "已清除各后端单独立覆写，点击「保存运行配置」后仅对 Hato Worker 生效。",
      status: "info",
    });
  };

  const setBackendOptionOverride = (
    backend: ExternalCliProbeEntry["backend"],
    optionKey: string,
    nextVal: string | boolean | undefined,
  ) => {
    const cfgKey = BACKEND_CONFIG_KEYS[backend];
    setDraft((prev) => {
      const ext = prev.worker.external_cli;
      const curSection = { ...((ext[cfgKey] as Record<string, unknown> | undefined) ?? {}) };
      if (nextVal === undefined) {
        delete curSection[optionKey];
      } else {
        curSection[optionKey] = nextVal;
      }
      return {
        ...prev,
        worker: {
          ...prev.worker,
          external_cli: {
            ...ext,
            [cfgKey]: curSection,
          },
        },
      };
    });
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  return (
    <div className="flex flex-col pb-8">
      <ConsolePageHeader
        title="网关与网络设置"
        badges={
          isDirty ? (
            <AnimatedBadge status="warning" size="sm">
              有未保存更改
            </AnimatedBadge>
          ) : (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              ⌘/Ctrl+S 快速保存
            </span>
          )
        }
        actions={
          <div className="flex items-center gap-2">
            {isDirty && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saveState === "loading"}
                onClick={handleReset}
              >
                <RotateCcw className="size-3.5" />
                还原
              </Button>
            )}
            <StatefulButton
              type="button"
              size="sm"
              state={saveState}
              loadingText="保存中…"
              successText="已保存"
              errorText="保存失败"
              icon={<Save className="size-3.5" />}
              onClick={() => void handleSave()}
            >
              保存运行配置
            </StatefulButton>
          </div>
        }
      />

      {/* Flat divided two-column settings rows */}
      <div className="divide-y divide-border">
        {/* Section 1: Owner & Identity */}
        <section className="grid gap-6 py-6 md:grid-cols-12">
          <div className="md:col-span-4">
            <h3 className="text-sm font-semibold text-foreground">主人与身份</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              配置系统默认主人标识、调度时区与 Telegram 允许交互的用户白名单。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 md:col-span-8">
            <ConsoleInput
              label="主人账号标识"
              value={draft.owner.canonical_user_id}
              onChange={(v) =>
                setDraft((p) => ({ ...p, owner: { ...p.owner, canonical_user_id: v } }))
              }
            />
            <ConsoleInput
              label="时区 (IANA)"
              value={draft.owner.timezone}
              onChange={(v) =>
                setDraft((p) => ({ ...p, owner: { ...p.owner, timezone: v } }))
              }
              placeholder="Asia/Shanghai"
            />
            <div className="sm:col-span-2">
              <ConsoleInput
                label="Telegram 白名单 ID（多个 ID 请以英文逗号分隔）"
                value={draft.owner.channels.tg.user_ids.join(", ")}
                onChange={(v) =>
                  setDraft((p) => ({
                    ...p,
                    owner: {
                      ...p.owner,
                      channels: {
                        ...p.owner.channels,
                        tg: {
                          user_ids: v
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .map((s) => (/^\d+$/.test(s) ? Number(s) : s)),
                        },
                      },
                    },
                  }))
                }
                placeholder="123456789, 987654321"
              />
            </div>
          </div>
        </section>

        {/* Section 2: Telegram Gateway */}
        <section className="grid gap-6 py-6 md:grid-cols-12">
          <div className="md:col-span-4">
            <h3 className="text-sm font-semibold text-foreground">Telegram 网关</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              控制 Telegram Bot 通道开关、API 端点及断线重连的指数退避策略。
            </p>
          </div>

          <div className="flex flex-col gap-4 md:col-span-8">
            <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-4">
              <div>
                <div className="text-xs font-medium text-foreground">启用 Telegram 网关</div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  开启后将在后台轮询并响应白名单用户的 Telegram 消息
                </p>
              </div>
              <Switch
                ariaLabel="启用 Telegram 网关"
                checked={draft.gateway.telegram.enabled}
                onCheckedChange={(on) =>
                  setDraft((p) => ({
                    ...p,
                    gateway: { ...p.gateway, telegram: { ...p.gateway.telegram, enabled: on } },
                  }))
                }
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <ConsoleInput
                label="Telegram API 地址"
                value={draft.gateway.telegram.base_url}
                onChange={(v) =>
                  setDraft((p) => ({
                    ...p,
                    gateway: { ...p.gateway, telegram: { ...p.gateway.telegram, base_url: v } },
                  }))
                }
              />
              <ConsoleInput
                label="Bot Token 变量名"
                value={draft.gateway.telegram.bot_token_env}
                onChange={(v) =>
                  setDraft((p) => ({
                    ...p,
                    gateway: {
                      ...p.gateway,
                      telegram: { ...p.gateway.telegram, bot_token_env: v },
                    },
                  }))
                }
              />
            </div>

            <Collapsible>
              <CollapsibleTrigger className="h-8 min-h-0 w-auto gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                <span>高级参数（网关断线重连策略）</span>
                <CollapsibleIndicator className="ml-0 size-3.5" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid gap-4 border-l-2 border-border pl-4 sm:grid-cols-2">
                  <ConsoleInput
                    label="最大重试次数"
                    type="number"
                    value={String(retryCfg.max_retries)}
                    onChange={(v) =>
                      setDraft((p) => ({
                        ...p,
                        gateway: { ...p.gateway, retry: { ...retryCfg, max_retries: Number(v) || 0 } },
                      }))
                    }
                  />
                  <ConsoleInput
                    label="初始退避 (ms)"
                    type="number"
                    value={String(retryCfg.initial_delay_ms)}
                    onChange={(v) =>
                      setDraft((p) => ({
                        ...p,
                        gateway: {
                          ...p.gateway,
                          retry: { ...retryCfg, initial_delay_ms: Number(v) || 0 },
                        },
                      }))
                    }
                  />
                  <ConsoleInput
                    label="最大退避 (ms)"
                    type="number"
                    value={String(retryCfg.max_delay_ms)}
                    onChange={(v) =>
                      setDraft((p) => ({
                        ...p,
                        gateway: {
                          ...p.gateway,
                          retry: { ...retryCfg, max_delay_ms: Number(v) || 0 },
                        },
                      }))
                    }
                  />
                  <div className="flex items-center justify-between gap-3 pt-4">
                    <div>
                      <div className="text-xs font-medium text-foreground">随机抖动 (jitter)</div>
                      <div className="text-[11px] text-muted-foreground">分散重连峰值</div>
                    </div>
                    <Switch
                      ariaLabel="随机抖动 (jitter)"
                      checked={retryCfg.jitter}
                      onCheckedChange={(on) =>
                        setDraft((p) => ({
                          ...p,
                          gateway: { ...p.gateway, retry: { ...retryCfg, jitter: on } },
                        }))
                      }
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </section>

        {/* Section 3: Scoped Proxy Rules */}
        <section className="grid gap-6 py-6 md:grid-cols-12">
          <div className="flex flex-col items-start gap-3 md:col-span-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">网络代理规则</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                按模块或子范围分流 HTTP/SOCKS 流量；未命中的请求将走默认直连。
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addProxyRule}>
              <Plus className="size-3.5" />
              添加代理规则
            </Button>
          </div>

          <div className="md:col-span-8">
            {proxies.length === 0 ? (
              <div className="border-y border-border/70 py-8 text-center text-xs text-muted-foreground">
                暂无代理规则，当前所有请求均保持直连。
              </div>
            ) : (
              <div className="divide-y divide-border/80 border-t border-border">
                {proxies.map((rule, idx) => {
                  const isDirect = rule.url.trim().toLowerCase() === "direct";
                  const scopeArr = Array.isArray(rule.scope)
                    ? rule.scope
                    : typeof rule.scope === "string" && String(rule.scope).trim()
                      ? [String(rule.scope).trim()]
                      : ["all"];

                  return (
                    <div
                      key={`proxy-rule-${idx}`}
                      className="flex flex-col gap-3 py-4 first:pt-3 last:pb-0"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="grid flex-1 gap-3 sm:grid-cols-2">
                          <ConsoleInput
                            label="规则名称"
                            value={rule.name}
                            onChange={(v) => updateProxyRule(idx, { name: v })}
                            placeholder="llm-scope"
                          />
                          <ConsoleMultiSelect
                            label="作用范围"
                            values={scopeArr}
                            options={SCOPE_OPTIONS}
                            allowCustom
                            onValuesChange={(nextScopes) => updateProxyRule(idx, { scope: nextScopes })}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="删除代理规则"
                          onClick={() => setProxies(proxies.filter((_, i) => i !== idx))}
                          className="mt-5 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>

                      <div className="grid gap-3 pr-12 sm:grid-cols-12">
                        <div className="sm:col-span-4">
                          <ConsoleSelect
                            label="连接方式"
                            value={isDirect ? "direct" : "proxy"}
                            options={MODE_OPTIONS}
                            onValueChange={(nextMode) => {
                              if (nextMode === "direct") {
                                if (!isDirect && rule.url.trim()) {
                                  setLastProxyUrls((prev) => ({ ...prev, [idx]: rule.url.trim() }));
                                }
                                updateProxyRule(idx, { url: "direct" });
                              } else {
                                updateProxyRule(idx, {
                                  url: lastProxyUrls[idx] || "http://127.0.0.1:7890",
                                });
                              }
                            }}
                          />
                        </div>
                        <div className="sm:col-span-8">
                          <ConsoleInput
                            label="代理地址"
                            value={isDirect ? "" : rule.url}
                            disabled={isDirect}
                            onChange={(v) => updateProxyRule(idx, { url: v })}
                            placeholder={isDirect ? "直连模式（无需填写代理地址）" : "http://127.0.0.1:7890"}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Section 4: Browser Automation */}
        <section className="grid gap-6 py-6 md:grid-cols-12">
          <div className="md:col-span-4">
            <h3 className="text-sm font-semibold text-foreground">浏览器自动化</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              配置远程浏览器的内核类型、虚拟显示环境及会话空闲回收策略。
            </p>
          </div>

          <div className="flex flex-col gap-4 md:col-span-8">
            <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-4">
              <div>
                <div className="text-xs font-medium text-foreground">启用浏览器工具</div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  允许 Agent 调用浏览器打开网页、截图及触发人工接管
                </p>
              </div>
              <Switch
                ariaLabel="启用浏览器工具"
                checked={browserCfg.enabled}
                onCheckedChange={(on) => setBrowserCfg({ enabled: on })}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <ConsoleSelect
                label="浏览器内核"
                value={browserCfg.channel === "chromium" ? "chromium" : "chrome"}
                options={CHANNEL_OPTIONS}
                onValueChange={(next) =>
                  setBrowserCfg({ channel: next as "chrome" | "chromium" })
                }
              />
              <ConsoleSelect
                label="虚拟屏幕 (Xvfb)"
                value={String(browserCfg.xvfb ?? "auto")}
                options={XVFB_OPTIONS}
                onValueChange={(v) =>
                  setBrowserCfg({ xvfb: v === "auto" ? "auto" : v === "true" })
                }
              />
            </div>

            <Collapsible>
              <CollapsibleTrigger className="h-8 min-h-0 w-auto gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                <span>高级参数（缓存目录与回收阈值）</span>
                <CollapsibleIndicator className="ml-0 size-3.5" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid gap-4 border-l-2 border-border pl-4 sm:grid-cols-2">
                  <ConsoleInput
                    label="浏览器数据目录"
                    value={browserCfg.profile_dir ?? "./data/browser-profile"}
                    onChange={(v) => setBrowserCfg({ profile_dir: v })}
                  />
                  <ConsoleInput
                    label="可执行文件路径（可选）"
                    value={browserCfg.executable_path ?? ""}
                    onChange={(v) => setBrowserCfg({ executable_path: v.trim() || undefined })}
                    placeholder="留空自动识别"
                  />
                  <ConsoleInput
                    label="单次最大操作步数"
                    type="number"
                    value={String(browserCfg.max_steps ?? 15)}
                    onChange={(v) => setBrowserCfg({ max_steps: Number(v) || 15 })}
                  />
                  <ConsoleInput
                    label="空闲回收时长 (分钟)"
                    type="number"
                    value={String(browserCfg.idle_timeout_minutes ?? 5)}
                    onChange={(v) => setBrowserCfg({ idle_timeout_minutes: Number(v) || 0 })}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </section>

        {/* Section 5: Web Search & Console */}
        <section className="grid gap-6 py-6 md:grid-cols-12">
          <div className="md:col-span-4">
            <h3 className="text-sm font-semibold text-foreground">联网搜索与控制台</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              管理 Tavily 联网检索能力及 Web 控制台的本地监听端口与访问鉴权。
            </p>
          </div>

          <div className="flex flex-col gap-4 md:col-span-8">
            <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-4">
              <div>
                <div className="text-xs font-medium text-foreground">启用 Tavily 搜索</div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  为模型提供实时网页搜索与摘要提取能力
                </p>
              </div>
              <Switch
                ariaLabel="启用 Tavily 搜索"
                checked={searchCfg.enabled}
                onCheckedChange={(on) => setSearchCfg({ enabled: on })}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <ConsoleInput
                label="控制台 Host"
                value={consoleCfg.host}
                onChange={(v) => setConsoleCfg({ host: v })}
              />
              <ConsoleInput
                label="控制台 Port"
                type="number"
                value={String(consoleCfg.port)}
                onChange={(v) => setConsoleCfg({ port: Number(v) || 3820 })}
              />
            </div>

            <Collapsible>
              <CollapsibleTrigger className="h-8 min-h-0 w-auto gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                <span>高级参数（检索条数与访问令牌变量）</span>
                <CollapsibleIndicator className="ml-0 size-3.5" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid gap-4 border-l-2 border-border pl-4 sm:grid-cols-2">
                  <ConsoleInput
                    label="Tavily Key 变量名"
                    value={searchCfg.api_key_env}
                    onChange={(v) => setSearchCfg({ api_key_env: v })}
                  />
                  <ConsoleInput
                    label="搜索最大结果数"
                    type="number"
                    value={String(searchCfg.max_results ?? 5)}
                    onChange={(v) => setSearchCfg({ max_results: Number(v) || 5 })}
                  />
                  <div className="sm:col-span-2">
                    <ConsoleInput
                      label="控制台访问令牌变量名（可选）"
                      value={consoleCfg.auth_token_env ?? ""}
                      onChange={(v) => setConsoleCfg({ auth_token_env: v.trim() || undefined })}
                      placeholder="留空免登录验证"
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </section>

        {/* Section 6: Worker & External CLI Modes (Hato-Only) */}
        <section className="grid gap-6 py-6 md:grid-cols-12">
          <div className="md:col-span-4">
            <h3 className="text-sm font-semibold text-foreground">Worker 与 External CLI 模式</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              动态读取本机 CLI 支持的权限模式与默认配置。所有模式覆写仅在 Hato 拉起 Worker 子进程时生效，绝不修改本机全局 CLI 配置。
            </p>
          </div>

          <div className="flex flex-col gap-5 md:col-span-8">
            <div className="grid gap-4 sm:grid-cols-2">
              <ConsoleSelect
                label="默认 Worker 后端"
                value={draft.worker.default_backend}
                options={WORKER_BACKEND_OPTIONS}
                onValueChange={(val) =>
                  setDraft((prev) => ({
                    ...prev,
                    worker: {
                      ...prev.worker,
                      default_backend: val as HatoConfig["worker"]["default_backend"],
                    },
                  }))
                }
              />
              <ConsoleSelect
                label="全局权限预设（仅 Hato 生效）"
                value={extCliCfg.permission_preset ?? "auto_safe"}
                options={PERMISSION_PRESET_OPTIONS}
                onValueChange={(val) =>
                  setExtCliCfg({ permission_preset: val as ExternalCliPermissionPreset })
                }
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/80 bg-muted/20 px-4 py-3">
              <div className="text-xs text-muted-foreground">
                一键将所有已启用的外部 CLI（Codex / agy / OpenCode V2 等）统一切换为无需审批：
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={probingClis}
                  onClick={() => void loadCliProbes(true)}
                >
                  <RefreshCw className={`size-3.5 ${probingClis ? "animate-spin" : ""}`} />
                  刷新探测
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={applyAllNoApprovalPreset}
                >
                  <ShieldAlert className="size-3.5 text-amber-500" />
                  全部设为无需审批
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3.5 py-3">
                <div>
                  <div className="text-xs font-medium text-foreground">复用本机登录与中转站</div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    继承 ~/.codex/config.toml 等本机配置
                  </p>
                </div>
                <Switch
                  ariaLabel="复用本机登录与中转站"
                  checked={extCliCfg.reuse_host_auth_and_provider ?? true}
                  onCheckedChange={(on) => setExtCliCfg({ reuse_host_auth_and_provider: on })}
                />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3.5 py-3">
                <div>
                  <div className="text-xs font-medium text-foreground">继承本机个人 MCP</div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    默认关闭防污染；仅加载 Worker MCP
                  </p>
                </div>
                <Switch
                  ariaLabel="继承本机个人 MCP"
                  checked={extCliCfg.inherit_host_mcp ?? false}
                  onCheckedChange={(on) => setExtCliCfg({ inherit_host_mcp: on })}
                />
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {cliProbes.map((probe) => {
                const cfgKey = BACKEND_CONFIG_KEYS[probe.backend];
                const backendCfg = (extCliCfg[cfgKey] as Record<string, unknown> | undefined) ?? {};
                const hostSummaryEntries = Object.entries(probe.hostSummary);

                return (
                  <div
                    key={probe.backend}
                    className="flex flex-col gap-3 rounded-xl border border-border bg-card/50 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-foreground">
                          {probe.backend}
                        </span>
                        <AnimatedBadge status="neutral" size="sm">
                          Tier {probe.tier}
                        </AnimatedBadge>
                        {probe.available ? (
                          <AnimatedBadge status="success" size="sm">
                            {probe.version ? `已就绪 ${probe.version}` : "已就绪"}
                          </AnimatedBadge>
                        ) : (
                          <AnimatedBadge
                            status={probe.installed ? "danger" : "warning"}
                            size="sm"
                          >
                            {probe.installed ? "版本不兼容" : "未安装"}
                          </AnimatedBadge>
                        )}
                        {probe.backend === "opencode-v2" && probe.v2Verified && (
                          <AnimatedBadge status="success" size="sm">
                            V2 已校验
                          </AnimatedBadge>
                        )}
                      </div>

                      <Switch
                        ariaLabel={`启用 ${probe.backend}`}
                        checked={typeof backendCfg.enabled === "boolean" ? backendCfg.enabled : probe.enabled}
                        onCheckedChange={(on) => setBackendOptionOverride(probe.backend, "enabled", on)}
                      />
                    </div>

                    {probe.reason && (
                      <div className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
                        {probe.reason}
                      </div>
                    )}

                    {hostSummaryEntries.length > 0 && (
                      <div className="text-[11px] text-muted-foreground">
                        本机配置（只读参考）：
                        {hostSummaryEntries
                          .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
                          .join(" · ")}
                      </div>
                    )}

                    {probe.options.length > 0 && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {probe.options.map((opt) => {
                          const rawOverride = backendCfg[opt.key];
                          if (opt.kind === "enum") {
                            const currentStr =
                              typeof rawOverride === "string" ? rawOverride : FOLLOW_PRESET_VALUE;
                            const selectOptions = [
                              {
                                value: FOLLOW_PRESET_VALUE,
                                label: `跟随全局预设 (${String(opt.effectiveHatoValue ?? "默认")})`,
                              },
                              ...(opt.choices ?? []).map((c) => ({
                                value: c,
                                label:
                                  opt.hostDefault === c ? `${c}（本机当前）` : c,
                              })),
                            ];
                            return (
                              <ConsoleSelect
                                key={opt.key}
                                label={opt.label}
                                value={currentStr}
                                options={selectOptions}
                                onValueChange={(next) =>
                                  setBackendOptionOverride(
                                    probe.backend,
                                    opt.key,
                                    next === FOLLOW_PRESET_VALUE ? undefined : next,
                                  )
                                }
                              />
                            );
                          }

                          const boolValue =
                            typeof rawOverride === "boolean"
                              ? rawOverride
                              : Boolean(opt.effectiveHatoValue);
                          return (
                            <div
                              key={opt.key}
                              className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
                            >
                              <div className="text-[11px] font-medium text-foreground">
                                {opt.label}
                                {rawOverride === undefined && (
                                  <span className="ml-1 text-muted-foreground">(随预设)</span>
                                )}
                              </div>
                              <Switch
                                ariaLabel={`${probe.backend} ${opt.label}`}
                                checked={boolValue}
                                onCheckedChange={(on) =>
                                  setBackendOptionOverride(probe.backend, opt.key, on)
                                }
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                      Hato 启动参数预览: {probe.command}{" "}
                      {probe.effectiveArgsPreview.length > 0
                        ? probe.effectiveArgsPreview.join(" ")
                        : "(沿用本机默认模式)"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
