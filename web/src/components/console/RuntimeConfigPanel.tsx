import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type HatoConfig, type ProxyRuleConfig } from "@/api";
import {
  ConsoleInput,
  ConsoleMultiSelect,
  ConsolePageHeader,
  ConsoleSelect,
} from "@/components/console/ConsolePrimitives";
import { Button, StatefulButton, type ButtonState } from "@/components/motion/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/motion/collapsible";
import { Switch } from "@/components/motion/switch";

const SCOPE_OPTIONS = [
  { value: "all", label: "all（全局默认）" },
  { value: "gateway", label: "gateway（Telegram 网关）" },
  { value: "llm-calling", label: "llm-calling（模型接口）" },
  { value: "web_access", label: "web_access（搜索与抓取）" },
  { value: "browser", label: "browser（浏览器访问）" },
  { value: "memory", label: "memory（长期记忆）" },
  { value: "worker", label: "worker（后台任务）" },
];

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

  useEffect(() => {
    setDraft(structuredClone(initialConfig));
  }, [initialConfig]);

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

  const handleSave = async () => {
    setSaveState("loading");
    try {
      const res = await api.saveHatoConfig(draft);
      setSaveState("success");
      onSaved(draft, res.changes);
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
  };

  return (
    <div className="flex flex-col gap-4">
      <ConsolePageHeader
        title="网关与网络设置"
        actions={
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
        }
      />

      {/* Unified Continuous Runtime Settings Sheet */}
      <div className="overflow-hidden rounded-xl border border-border bg-card divide-y divide-border">
        {/* Section 1: Owner & Telegram */}
        <div className="space-y-3 p-4">
          <div className="text-xs font-semibold text-foreground">基础与 Telegram 网关</div>
          <div className="grid items-end gap-3 md:grid-cols-3">
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
            />
            <ConsoleInput
              label="Telegram 白名单 ID"
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
            />
          </div>

          <div className="grid items-end gap-3 md:grid-cols-3">
            <div className="flex h-9 items-center justify-between rounded-xl border border-border px-3">
              <span className="text-xs font-medium text-foreground">启用 Telegram 网关</span>
              <Switch
                checked={draft.gateway.telegram.enabled}
                onCheckedChange={(on) =>
                  setDraft((p) => ({
                    ...p,
                    gateway: { ...p.gateway, telegram: { ...p.gateway.telegram, enabled: on } },
                  }))
                }
              />
            </div>
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
            <CollapsibleTrigger className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground">
              高级参数（网关断线重连策略）
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 grid items-end gap-3 md:grid-cols-4">
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
              <div className="flex h-9 items-center justify-between rounded-xl border border-border px-3">
                <span className="text-xs text-foreground">随机抖动 (jitter)</span>
                <Switch
                  checked={retryCfg.jitter}
                  onCheckedChange={(on) =>
                    setDraft((p) => ({
                      ...p,
                      gateway: { ...p.gateway, retry: { ...retryCfg, jitter: on } },
                    }))
                  }
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        {/* Section 2: Scoped Proxy Rules (Seamless rows) */}
        <div className="divide-y divide-border/70">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/25 px-4 py-2.5">
            <span className="text-xs font-semibold text-foreground">网络代理规则</span>
            <Button type="button" variant="outline" size="sm" onClick={addProxyRule}>
              <Plus className="size-3.5" />
              添加代理规则
            </Button>
          </div>

          {proxies.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              暂无代理规则，当前所有请求直连。
            </div>
          ) : (
            proxies.map((rule, idx) => {
              const isDirect = rule.url.trim().toLowerCase() === "direct";
              const scopeArr = Array.isArray(rule.scope)
                ? rule.scope
                : typeof rule.scope === "string" && String(rule.scope).trim()
                  ? [String(rule.scope).trim()]
                  : ["all"];

              return (
                <div
                  key={`proxy-rule-${idx}`}
                  className="grid items-end gap-3 px-4 py-3 md:grid-cols-12"
                >
                  <div className="md:col-span-2">
                    <ConsoleInput
                      label="规则名称"
                      value={rule.name}
                      onChange={(v) => updateProxyRule(idx, { name: v })}
                      placeholder="llm-scope"
                    />
                  </div>
                  <div className="md:col-span-4">
                    <ConsoleMultiSelect
                      label="作用范围"
                      values={scopeArr}
                      options={SCOPE_OPTIONS}
                      allowCustom
                      onValuesChange={(nextScopes) => updateProxyRule(idx, { scope: nextScopes })}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <ConsoleSelect
                      label="方式"
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
                  <div className="md:col-span-3">
                    <ConsoleInput
                      label="代理地址"
                      value={isDirect ? "" : rule.url}
                      disabled={isDirect}
                      onChange={(v) => updateProxyRule(idx, { url: v })}
                      placeholder={isDirect ? "直连模式" : "http://127.0.0.1:7890"}
                    />
                  </div>
                  <div className="md:col-span-1 flex h-9 items-center justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="删除代理规则"
                      onClick={() => setProxies(proxies.filter((_, i) => i !== idx))}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Section 3: Browser & Web Search / Console (2-col divided sheet) */}
        <div className="grid divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <div className="flex flex-col gap-3 p-4">
            <div className="text-xs font-semibold text-foreground">浏览器自动化</div>
            <div className="flex h-9 items-center justify-between rounded-xl border border-border px-3">
              <span className="text-xs font-medium text-foreground">启用浏览器工具</span>
              <Switch
                checked={browserCfg.enabled}
                onCheckedChange={(on) => setBrowserCfg({ enabled: on })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
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
              <CollapsibleTrigger className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground">
                高级参数（缓存目录与回收阈值）
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 grid gap-3 sm:grid-cols-2">
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
              </CollapsibleContent>
            </Collapsible>
          </div>

          <div className="flex flex-col gap-3 p-4">
            <div className="text-xs font-semibold text-foreground">联网搜索与控制台监听</div>
            <div className="flex h-9 items-center justify-between rounded-xl border border-border px-3">
              <span className="text-xs font-medium text-foreground">启用 Tavily 搜索</span>
              <Switch
                checked={searchCfg.enabled}
                onCheckedChange={(on) => setSearchCfg({ enabled: on })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
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
              <CollapsibleTrigger className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground">
                高级参数（检索条数与访问令牌变量）
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 grid gap-3 sm:grid-cols-2">
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
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </div>
    </div>
  );
}
