import type { Dispatch, SetStateAction } from "react";
import type { HatoConfig } from "@/api";
import { ConsoleInput, ConsoleSelect } from "@/components/console/ConsolePrimitives";
import { NumericConsoleInput, SettingsCardGroup, SettingsRow } from "@/components/console/settings/Primitives";
import { Switch } from "@/components/motion/switch";

export interface GatewaySectionProps {
  draft: HatoConfig;
  setDraft: Dispatch<SetStateAction<HatoConfig>>;
  retryCfg: NonNullable<HatoConfig["gateway"]["retry"]>;
}

export function GatewaySection({ draft, setDraft, retryCfg }: GatewaySectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <SettingsCardGroup title="消息通道">
        <SettingsRow
          title="启用 Telegram 通道"
          description="开启后自动接收并回复白名单用户的 Telegram 消息"
        >
          <Switch
            ariaLabel="启用 Telegram 通道"
            checked={draft.gateway.telegram.enabled}
            onCheckedChange={(on) =>
              setDraft((p) => ({
                ...p,
                gateway: {
                  ...p.gateway,
                  telegram: { ...p.gateway.telegram, enabled: on },
                },
              }))
            }
          />
        </SettingsRow>
        <SettingsRow title="Telegram API 地址" description="可填写官方地址或自定义反向代理端点">
          <div className="w-full sm:w-72">
            <ConsoleInput
              size="sm"
              value={draft.gateway.telegram.base_url}
              onChange={(v) =>
                setDraft((p) => ({
                  ...p,
                  gateway: {
                    ...p.gateway,
                    telegram: { ...p.gateway.telegram, base_url: v },
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow title="Bot Token 环境变量" description="用于读取 Telegram 机器人令牌的变量名">
          <div className="w-full sm:w-56">
            <ConsoleInput
              size="sm"
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
        </SettingsRow>
      </SettingsCardGroup>

      <SettingsCardGroup
        title="QQ 官方机器人"
        description="QQ 开放平台 C2C 官方机器人接入配置（OpenAPI v2 + WebSocket 网关）"
      >
        <SettingsRow
          title="启用 QQ 通道"
          description="开启后通过 QQ 官方 WebSocket 网关接收并回复白名单用户的私聊消息"
        >
          <Switch
            ariaLabel="启用 QQ 通道"
            checked={draft.gateway.qq.enabled}
            onCheckedChange={(on) =>
              setDraft((p) => ({
                ...p,
                gateway: {
                  ...p.gateway,
                  qq: { ...p.gateway.qq, enabled: on },
                },
              }))
            }
          />
        </SettingsRow>
        <SettingsRow title="QQ OpenAPI 地址" description="默认 https://api.bot.qq.com，可按需填写沙箱或反代地址">
          <div className="w-full sm:w-72">
            <ConsoleInput
              size="sm"
              value={draft.gateway.qq.base_url}
              placeholder="https://api.bot.qq.com"
              onChange={(v) =>
                setDraft((p) => ({
                  ...p,
                  gateway: {
                    ...p.gateway,
                    qq: { ...p.gateway.qq, base_url: v },
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow title="QQ App ID" description="QQ 开放平台机器人应用的 AppID">
          <div className="w-full sm:w-56">
            <ConsoleInput
              size="sm"
              value={draft.gateway.qq.app_id}
              placeholder="例如 102000001"
              onChange={(v) =>
                setDraft((p) => ({
                  ...p,
                  gateway: {
                    ...p.gateway,
                    qq: { ...p.gateway.qq, app_id: v },
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow title="Client Secret 环境变量" description="用于读取 QQ 机器人 AppSecret 的环境变量名">
          <div className="w-full sm:w-56">
            <ConsoleInput
              size="sm"
              value={draft.gateway.qq.client_secret_env}
              placeholder="QQ_BOT_SECRET"
              onChange={(v) =>
                setDraft((p) => ({
                  ...p,
                  gateway: {
                    ...p.gateway,
                    qq: { ...p.gateway.qq, client_secret_env: v },
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow title="回退通道" description="QQ 主动推送受限时是否回退到 Telegram 发送">
          <div className="w-full sm:w-44">
            <ConsoleSelect
              size="sm"
              value={draft.gateway.qq.fallback_channel}
              onValueChange={(v) =>
                setDraft((p) => ({
                  ...p,
                  gateway: {
                    ...p.gateway,
                    qq: { ...p.gateway.qq, fallback_channel: v as "tg" | "none" },
                  },
                }))
              }
              options={[
                { value: "tg", label: "Telegram" },
                { value: "none", label: "不回退" },
              ]}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="QQ OpenID 白名单"
          description="允许私聊的主人 user_openid 列表（多个用逗号分隔，也可留空后通过 /sethome 配对）"
        >
          <div className="w-full sm:w-72">
            <ConsoleInput
              size="sm"
              value={draft.owner.channels.qq.open_ids.join(", ")}
              placeholder="留空可通过 /sethome 自动绑定"
              onChange={(v) =>
                setDraft((p) => ({
                  ...p,
                  owner: {
                    ...p.owner,
                    channels: {
                      ...p.owner.channels,
                      qq: {
                        ...p.owner.channels.qq,
                        open_ids: v
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    },
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
      </SettingsCardGroup>

      <SettingsCardGroup
        title="回复气泡"
        description="控制聊天回复是否拆分为多条连续气泡发送"
      >
        <SettingsRow
          title="启用多气泡分段"
          description="开启后按段落或分隔符拆分为多条消息依次发送，模拟真人聊天节奏"
        >
          <Switch
            ariaLabel="启用多气泡分段"
            checked={draft.gateway.bubbles.enabled}
            onCheckedChange={(on) =>
              setDraft((p) => ({
                ...p,
                gateway: {
                  ...p.gateway,
                  bubbles: { ...p.gateway.bubbles, enabled: on },
                },
              }))
            }
          />
        </SettingsRow>
        <SettingsRow
          title="单轮最多气泡数"
          description="填 0 表示不限制数量，1 表示合并为单条；QQ 官方私聊单条被动回复上限为 4 条"
        >
          <div className="w-full sm:w-32">
            <NumericConsoleInput
              size="sm"
              value={draft.gateway.bubbles.max_per_turn}
              fallback={3}
              min={0}
              onCommit={(max_per_turn) =>
                setDraft((p) => ({
                  ...p,
                  gateway: {
                    ...p.gateway,
                    bubbles: { ...p.gateway.bubbles, max_per_turn },
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="气泡发送间隔（毫秒）"
          description="多条气泡依次发送时的随机停顿范围（最小 – 最大）"
        >
          <div className="flex w-full items-center gap-2 sm:w-64">
            <NumericConsoleInput
              size="sm"
              value={draft.gateway.bubbles.delay_ms_range[0]}
              fallback={0}
              min={0}
              onCommit={(minDelay) =>
                setDraft((p) => {
                  const curMax = p.gateway.bubbles.delay_ms_range[1];
                  return {
                    ...p,
                    gateway: {
                      ...p.gateway,
                      bubbles: {
                        ...p.gateway.bubbles,
                        delay_ms_range: [minDelay, Math.max(minDelay, curMax)],
                      },
                    },
                  };
                })
              }
            />
            <span className="text-muted-foreground text-xs">~</span>
            <NumericConsoleInput
              size="sm"
              value={draft.gateway.bubbles.delay_ms_range[1]}
              fallback={0}
              min={0}
              onCommit={(maxDelay) =>
                setDraft((p) => {
                  const curMin = p.gateway.bubbles.delay_ms_range[0];
                  return {
                    ...p,
                    gateway: {
                      ...p.gateway,
                      bubbles: {
                        ...p.gateway.bubbles,
                        delay_ms_range: [Math.min(curMin, maxDelay), maxDelay],
                      },
                    },
                  };
                })
              }
            />
          </div>
        </SettingsRow>
      </SettingsCardGroup>

      <SettingsCardGroup title="断线重连策略" description="各消息网关共用的重试与退避配置">
        <SettingsRow title="最大重试次数" description="连接或发送异常后的最大自动重试次数">
          <div className="w-full sm:w-32">
            <NumericConsoleInput
              size="sm"
              value={retryCfg.max_retries}
              fallback={0}
              min={0}
              onCommit={(max_retries) =>
                setDraft((p) => ({
                  ...p,
                  gateway: {
                    ...p.gateway,
                    retry: { ...retryCfg, max_retries },
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow title="初始重试间隔（毫秒）" description="首次重试前的等待时长">
          <div className="w-full sm:w-32">
            <NumericConsoleInput
              size="sm"
              value={retryCfg.initial_delay_ms}
              fallback={0}
              min={0}
              onCommit={(initial_delay_ms) =>
                setDraft((p) => ({
                  ...p,
                  gateway: {
                    ...p.gateway,
                    retry: { ...retryCfg, initial_delay_ms },
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow title="最大重试间隔（毫秒）" description="指数退避等待间隔上限">
          <div className="w-full sm:w-32">
            <NumericConsoleInput
              size="sm"
              value={retryCfg.max_delay_ms}
              fallback={0}
              min={0}
              onCommit={(max_delay_ms) =>
                setDraft((p) => ({
                  ...p,
                  gateway: {
                    ...p.gateway,
                    retry: { ...retryCfg, max_delay_ms },
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow title="重连随机抖动" description="错开重连时间，避免并发请求集中">
          <Switch
            ariaLabel="重连随机抖动"
            checked={retryCfg.jitter}
            onCheckedChange={(on) =>
              setDraft((p) => ({
                ...p,
                gateway: { ...p.gateway, retry: { ...retryCfg, jitter: on } },
              }))
            }
          />
        </SettingsRow>
      </SettingsCardGroup>
    </div>
  );
}
