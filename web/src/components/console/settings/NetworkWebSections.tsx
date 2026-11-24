import { Plus, Trash2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { HatoConfig, ProxyRuleConfig } from "@/api";
import {
  ConsoleInput,
  ConsoleMultiSelect,
  ConsoleSelect,
} from "@/components/console/ConsolePrimitives";
import {
  NumericConsoleInput,
  SettingsCardGroup,
  SettingsRow,
} from "@/components/console/settings/Primitives";
import {
  CHANNEL_OPTIONS,
  MODE_OPTIONS,
  SCOPE_OPTIONS,
  XVFB_OPTIONS,
} from "@/components/console/settings/types";
import { Button } from "@/components/motion/button";
import { Switch } from "@/components/motion/switch";

export interface ProxySectionProps {
  proxies: ProxyRuleConfig[];
  proxyIds: string[];
  lastProxyUrls: Record<string, string>;
  setLastProxyUrls: Dispatch<SetStateAction<Record<string, string>>>;
  addProxyRule: () => void;
  updateProxyRule: (idx: number, patch: Partial<ProxyRuleConfig>) => void;
  removeProxyRule: (idx: number, ruleId: string) => void;
}

export function ProxySection({
  proxies,
  proxyIds,
  lastProxyUrls,
  setLastProxyUrls,
  addProxyRule,
  updateProxyRule,
  removeProxyRule,
}: ProxySectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <SettingsCardGroup
        title="分流规则"
        description="按模块或子范围分流 HTTP/SOCKS 流量；未命中的请求将走默认直连。"
        actions={
          <Button type="button" variant="outline" size="sm" onClick={addProxyRule}>
            <Plus className="size-3.5" />
            添加代理规则
          </Button>
        }
      >
        {proxies.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            暂无代理规则，当前所有请求均保持直连。
          </div>
        ) : (
          proxies.map((rule, idx) => {
            const ruleId = proxyIds[idx] ?? `proxy-fallback-${idx}`;
            const isDirect = rule.url.trim().toLowerCase() === "direct";
            const scopeArr = Array.isArray(rule.scope)
              ? rule.scope
              : typeof rule.scope === "string" && String(rule.scope).trim()
                ? [String(rule.scope).trim()]
                : ["all"];

            return (
              <div key={ruleId} className="flex items-start gap-3 px-4 py-4">
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ConsoleInput
                      size="sm"
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
                      onValuesChange={(nextScopes) =>
                        updateProxyRule(idx, { scope: nextScopes })
                      }
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-12">
                    <div className="sm:col-span-4">
                      <ConsoleSelect
                        size="sm"
                        label="连接方式"
                        value={isDirect ? "direct" : "proxy"}
                        options={MODE_OPTIONS}
                        onValueChange={(nextMode) => {
                          if (nextMode === "direct") {
                            if (!isDirect && rule.url.trim()) {
                              setLastProxyUrls((prev) => ({
                                ...prev,
                                [ruleId]: rule.url.trim(),
                              }));
                            }
                            updateProxyRule(idx, { url: "direct" });
                          } else {
                            updateProxyRule(idx, {
                              url: lastProxyUrls[ruleId] || "http://127.0.0.1:7890",
                            });
                          }
                        }}
                      />
                    </div>
                    <div className="sm:col-span-8">
                      <ConsoleInput
                        size="sm"
                        label="代理地址"
                        value={isDirect ? "" : rule.url}
                        disabled={isDirect}
                        onChange={(v) => updateProxyRule(idx, { url: v })}
                        placeholder={
                          isDirect ? "直连模式（无需填写代理地址）" : "http://127.0.0.1:7890"
                        }
                      />
                    </div>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="删除代理规则"
                  onClick={() => removeProxyRule(idx, ruleId)}
                  className="mt-5 shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            );
          })
        )}
      </SettingsCardGroup>
    </div>
  );
}

export interface BrowserSectionProps {
  browserCfg: NonNullable<NonNullable<HatoConfig["web"]>["browser"]>;
  setBrowserCfg: (patch: Partial<NonNullable<NonNullable<HatoConfig["web"]>["browser"]>>) => void;
}

export function BrowserSection({ browserCfg, setBrowserCfg }: BrowserSectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <SettingsCardGroup title="运行控制">
        <SettingsRow
          title="启用浏览器工具"
          description="允许后台任务打开网页、截图及请求人工接管"
        >
          <Switch
            ariaLabel="启用浏览器工具"
            checked={browserCfg.enabled}
            onCheckedChange={(on) => setBrowserCfg({ enabled: on })}
          />
        </SettingsRow>
        <SettingsRow title="浏览器内核" description="选择用于网页自动化的浏览器">
          <div className="w-full sm:w-52">
            <ConsoleSelect
              size="sm"
              value={browserCfg.channel === "chromium" ? "chromium" : "chrome"}
              options={CHANNEL_OPTIONS}
              onValueChange={(next) =>
                setBrowserCfg({ channel: next as "chrome" | "chromium" })
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow title="虚拟屏幕" description="无桌面环境下启用虚拟显示以支持人工接管">
          <div className="w-full sm:w-52">
            <ConsoleSelect
              size="sm"
              value={String(browserCfg.xvfb ?? "auto")}
              options={XVFB_OPTIONS}
              onValueChange={(v) =>
                setBrowserCfg({ xvfb: v === "auto" ? "auto" : v === "true" })
              }
            />
          </div>
        </SettingsRow>
      </SettingsCardGroup>

      <SettingsCardGroup title="路径与会话回收">
        <SettingsRow title="用户数据目录" description="保存登录态、Cookie 与本地存储的目录">
          <div className="w-full sm:w-72">
            <ConsoleInput
              size="sm"
              value={browserCfg.profile_dir ?? "./data/browser-profile"}
              onChange={(v) => setBrowserCfg({ profile_dir: v })}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="自定义浏览器路径"
          description="留空时由系统自动查找已安装的浏览器"
        >
          <div className="w-full sm:w-72">
            <ConsoleInput
              size="sm"
              value={browserCfg.executable_path ?? ""}
              onChange={(v) => setBrowserCfg({ executable_path: v.trim() || undefined })}
              placeholder="留空自动查找"
            />
          </div>
        </SettingsRow>
        <SettingsRow title="单次最大操作步数" description="限制单轮任务连续点击与跳转上限">
          <div className="w-full sm:w-32">
            <NumericConsoleInput
              size="sm"
              value={browserCfg.max_steps ?? 15}
              fallback={15}
              min={1}
              onCommit={(max_steps) => setBrowserCfg({ max_steps })}
            />
          </div>
        </SettingsRow>
        <SettingsRow title="空闲自动关闭（分钟）" description="无操作后自动释放浏览器进程，设为 0 则不关闭">
          <div className="w-full sm:w-32">
            <NumericConsoleInput
              size="sm"
              value={browserCfg.idle_timeout_minutes ?? 5}
              fallback={5}
              min={0}
              onCommit={(idle_timeout_minutes) => setBrowserCfg({ idle_timeout_minutes })}
            />
          </div>
        </SettingsRow>
      </SettingsCardGroup>
    </div>
  );
}

export interface SearchSectionProps {
  searchCfg: NonNullable<NonNullable<HatoConfig["web"]>["search"]>;
  setSearchCfg: (patch: Partial<NonNullable<NonNullable<HatoConfig["web"]>["search"]>>) => void;
}

export function SearchSection({ searchCfg, setSearchCfg }: SearchSectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <SettingsCardGroup title="Tavily 搜索">
        <SettingsRow
          title="启用联网搜索"
          description="开启后可在对话中检索实时公开网页信息"
        >
          <Switch
            ariaLabel="启用联网搜索"
            checked={searchCfg.enabled}
            onCheckedChange={(on) => setSearchCfg({ enabled: on })}
          />
        </SettingsRow>
        <SettingsRow title="接口地址" description="Tavily 服务基础地址">
          <div className="w-full sm:w-72">
            <ConsoleInput
              size="sm"
              value={searchCfg.base_url ?? "https://api.tavily.com"}
              onChange={(v) => setSearchCfg({ base_url: v })}
            />
          </div>
        </SettingsRow>
        <SettingsRow title="API Key 环境变量" description="用于读取 Tavily 密钥的变量名">
          <div className="w-full sm:w-56">
            <ConsoleInput
              size="sm"
              value={searchCfg.api_key_env}
              onChange={(v) => setSearchCfg({ api_key_env: v })}
            />
          </div>
        </SettingsRow>
        <SettingsRow title="最大返回条数" description="单次检索最多引用的结果数量">
          <div className="w-full sm:w-32">
            <NumericConsoleInput
              size="sm"
              value={searchCfg.max_results ?? 5}
              fallback={5}
              min={1}
              onCommit={(max_results) => setSearchCfg({ max_results })}
            />
          </div>
        </SettingsRow>
      </SettingsCardGroup>
    </div>
  );
}
