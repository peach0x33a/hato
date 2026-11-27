import { Plus, RefreshCw, Trash2, User } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { HatoConfig, TelegramUserProfile } from "@/api";
import { ConsoleInput, ConsoleSelect } from "@/components/console/ConsolePrimitives";
import {
  NumericConsoleInput,
  SettingsCardGroup,
  SettingsRow,
  THEME_OPTIONS,
} from "@/components/console/settings/Primitives";
import { getAvatarInitials, getAvatarTone } from "@/components/console/settings/types";
import { Button } from "@/components/motion/button";
import { Switch } from "@/components/motion/switch";
import { cn } from "@/lib/utils";

export interface GeneralSectionProps {
  draft: HatoConfig;
  setDraft: Dispatch<SetStateAction<HatoConfig>>;
  consoleCfg: { enabled: boolean; host: string; port: number; auth_token_env?: string };
  setConsoleCfg: (patch: Partial<{ enabled: boolean; host: string; port: number; auth_token_env?: string }>) => void;
  tgWhitelistIds: Array<string | number>;
  tgProfiles: Record<string, TelegramUserProfile>;
  loadingTgProfiles: boolean;
  loadTgProfiles: (ids: Array<string | number>, forceRefresh?: boolean) => Promise<void>;
  newTgIdInput: string;
  setNewTgIdInput: (value: string) => void;
  handleAddTgWhitelistIds: () => void;
  handleRemoveTgWhitelistId: (idStr: string) => void;
  theme: string | undefined;
  setTheme: (theme: string) => void;
}

export function GeneralSection({
  draft,
  setDraft,
  consoleCfg,
  setConsoleCfg,
  tgWhitelistIds,
  tgProfiles,
  loadingTgProfiles,
  loadTgProfiles,
  newTgIdInput,
  setNewTgIdInput,
  handleAddTgWhitelistIds,
  handleRemoveTgWhitelistId,
  theme,
  setTheme,
}: GeneralSectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <SettingsCardGroup title="主人与身份">
        <SettingsRow title="主人账号标识" description="默认会话关联的主人 ID">
          <div className="w-full sm:w-64">
            <ConsoleInput
              size="sm"
              value={draft.owner.canonical_user_id}
              onChange={(v) =>
                setDraft((p) => ({ ...p, owner: { ...p.owner, canonical_user_id: v } }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow title="时区" description="用于日程提醒、时间展示与日志记录">
          <div className="w-full sm:w-64">
            <ConsoleInput
              size="sm"
              value={draft.owner.timezone}
              onChange={(v) =>
                setDraft((p) => ({ ...p, owner: { ...p.owner, timezone: v } }))
              }
              placeholder="Asia/Shanghai"
            />
          </div>
        </SettingsRow>
      </SettingsCardGroup>

      <SettingsCardGroup
        title="上下文压缩与热区清空"
        description="控制上下文摘要压缩方式，以及工作记忆热区何时归档长期记忆并清空"
      >
        <SettingsRow
          title="上下文压缩方式"
          description="使用 curator 时以独立精简提示词低成本压缩；复用主对话时参照 CodingAgent 做法，以只读分支复用当前对话完整前缀（含系统提示词、工具声明与热区消息）命中提示词缓存，不修改当前会话且禁止执行工具"
        >
          <div className="w-full sm:w-64">
            <ConsoleSelect
              size="sm"
              value={draft.context.compaction_mode ?? "curator"}
              onValueChange={(v) =>
                setDraft((p) => ({
                  ...p,
                  context: {
                    ...p.context,
                    compaction_mode:
                      v === "reuse_conversation" ? "reuse_conversation" : "curator",
                  },
                }))
              }
              options={[
                { value: "curator", label: "使用 curator（独立低成本槽位）" },
                { value: "reuse_conversation", label: "复用主对话（只读分支命中缓存）" },
              ]}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="清空模式"
          description="定时模式按每日固定时间清空（聊天时自动顺延）；缓存模式趁提示词缓存未过期时预摘要并在闲置后归档"
        >
          <div className="w-full sm:w-64">
            <ConsoleSelect
              size="sm"
              value={draft.context.clear_mode ?? "idle"}
              onValueChange={(v) =>
                setDraft((p) => ({
                  ...p,
                  context: {
                    ...p.context,
                    clear_mode:
                      v === "scheduled" ? "scheduled" : v === "idle" ? "idle" : "cache",
                  },
                }))
              }
              options={[
                { value: "cache", label: "缓存模式（趁缓存未过期归档）" },
                { value: "scheduled", label: "定时模式（每日定时清空归档）" },
                { value: "idle", label: "静默模式（无对话超时直接清空，不发请求）" },
              ]}
            />
          </div>
        </SettingsRow>

        {(draft.context.clear_mode ?? "idle") === "scheduled" ? (
          <>
            <SettingsRow
              title="每日清空时间"
              description={`按主人时区（${draft.owner.timezone || "Asia/Shanghai"}）触发，格式 HH:MM`}
            >
              <div className="w-full sm:w-40">
                <ConsoleInput
                  size="sm"
                  value={draft.context.scheduled_clear_time ?? "01:00"}
                  onChange={(v) =>
                    setDraft((p) => ({
                      ...p,
                      context: { ...p.context, scheduled_clear_time: v },
                    }))
                  }
                  placeholder="01:00"
                />
              </div>
            </SettingsRow>
            <SettingsRow
              title="活跃聊天顺延（分钟）"
              description="到达清空时间或顺延期内有新消息时，每发一条消息向后顺延的分钟数"
            >
              <div className="w-full sm:w-40">
                <ConsoleInput
                  size="sm"
                  type="number"
                  min={1}
                  value={String(draft.context.scheduled_defer_minutes ?? 30)}
                  onChange={(v) => {
                    const num = Math.max(1, Number(v) || 30);
                    setDraft((p) => ({
                      ...p,
                      context: { ...p.context, scheduled_defer_minutes: num },
                    }));
                  }}
                  placeholder="30"
                />
              </div>
            </SettingsRow>
          </>
        ) : (
          <>
            {(draft.context.clear_mode ?? "idle") === "cache" ? (
              <SettingsRow
                title="热缓存预摘要时间（分钟）"
                description="无新消息后趁提示词缓存未失效生成过渡摘要草稿"
              >
                <div className="w-full sm:w-40">
                  <ConsoleInput
                    size="sm"
                    type="number"
                    min={1}
                    value={String(draft.context.pre_compact_after_minutes)}
                    onChange={(v) => {
                      const num = Math.max(1, Number(v) || 50);
                      setDraft((p) => ({
                        ...p,
                        context: { ...p.context, pre_compact_after_minutes: num },
                      }));
                    }}
                    placeholder="50"
                  />
                </div>
              </SettingsRow>
            ) : null}
            <SettingsRow
              title={
                (draft.context.clear_mode ?? "idle") === "idle"
                  ? "无对话静默清空时间（分钟）"
                  : "闲置归档提交时间（分钟）"
              }
              description={
                (draft.context.clear_mode ?? "idle") === "idle"
                  ? "无新消息超过该时长后直接清空并归档热区，不发起摘要请求"
                  : "无新消息后将旧热区写入长期记忆并提交压缩摘要"
              }
            >
              <div className="w-full sm:w-40">
                <ConsoleInput
                  size="sm"
                  type="number"
                  min={1}
                  value={String(draft.context.idle_commit_after_minutes)}
                  onChange={(v) => {
                    const num = Math.max(1, Number(v) || 60);
                    setDraft((p) => ({
                      ...p,
                      context: { ...p.context, idle_commit_after_minutes: num },
                    }));
                  }}
                  placeholder="60"
                />
              </div>
            </SettingsRow>
          </>
        )}
      </SettingsCardGroup>

      <SettingsCardGroup
        title="Telegram 白名单"
        description="仅列表中的账号可通过 Telegram Bot 发起私聊"
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loadingTgProfiles || tgWhitelistIds.length === 0}
            onClick={() => void loadTgProfiles(tgWhitelistIds, true)}
          >
            <RefreshCw className={`size-3.5 ${loadingTgProfiles ? "animate-spin" : ""}`} />
            刷新用户资料
          </Button>
        }
      >
        <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
          <div className="flex-1">
            <ConsoleInput
              size="sm"
              value={newTgIdInput}
              onChange={setNewTgIdInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddTgWhitelistIds();
                }
              }}
              placeholder="输入 Telegram 用户 ID（支持逗号分隔）"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleAddTgWhitelistIds}
            disabled={!newTgIdInput.trim()}
          >
            <Plus className="size-3.5" />
            添加到白名单
          </Button>
        </div>

        {tgWhitelistIds.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            暂无 Telegram 白名单用户，请在上方输入用户 ID 添加。
          </div>
        ) : (
          tgWhitelistIds.map((rawId) => {
            const idStr = String(rawId).trim();
            const profile = tgProfiles[idStr];
            const initials = getAvatarInitials(idStr, profile?.displayName);
            const tone = getAvatarTone(idStr);

            return (
              <div
                key={idStr}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/20"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {profile?.avatarDataUrl ? (
                    <img
                      src={profile.avatarDataUrl}
                      alt={profile.displayName || idStr}
                      className="size-9 shrink-0 rounded-full object-cover ring-1 ring-border/80"
                    />
                  ) : profile?.displayName ? (
                    <div
                      className={cn(
                        "grid size-9 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                        tone,
                      )}
                    >
                      {initials}
                    </div>
                  ) : (
                    <div className="grid size-9 shrink-0 place-items-center rounded-full border border-border/70 bg-muted/50 text-muted-foreground">
                      <User className="size-4" />
                    </div>
                  )}

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {profile?.displayName || `用户 ${idStr}`}
                      </span>
                      {profile?.username ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          @{profile.username}
                        </span>
                      ) : null}
                      {profile && !profile.ok ? (
                        <span
                          title={profile.error}
                          className="text-[11px] text-muted-foreground/75"
                        >
                          未同步资料
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                      ID: {idStr}
                    </div>
                  </div>
                </div>

                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`移除用户 ${idStr}`}
                  onClick={() => handleRemoveTgWhitelistId(idStr)}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            );
          })
        )}
      </SettingsCardGroup>

      <SettingsCardGroup title="外观与控制台">
        <SettingsRow title="界面外观" description="切换控制台浅色、深色或跟随系统主题">
          <div className="w-full sm:w-44">
            <ConsoleSelect
              size="sm"
              value={theme ?? "system"}
              options={THEME_OPTIONS}
              onValueChange={(val) => setTheme(val)}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="启用 Web 控制台"
          description="关闭后将停止本地管理界面服务（修改需重启服务生效）"
        >
          <Switch
            ariaLabel="启用 Web 控制台"
            checked={consoleCfg.enabled}
            onCheckedChange={(on) => setConsoleCfg({ enabled: on })}
          />
        </SettingsRow>
        <SettingsRow title="监听地址" description="默认仅本机可访问，公网暴露建议配合访问令牌（修改需重启服务生效）">
          <div className="w-full sm:w-52">
            <ConsoleInput
              size="sm"
              value={consoleCfg.host}
              onChange={(v) => setConsoleCfg({ host: v })}
            />
          </div>
        </SettingsRow>
        <SettingsRow title="服务端口" description="修改端口需重启服务生效">
          <div className="w-full sm:w-32">
            <NumericConsoleInput
              size="sm"
              value={consoleCfg.port}
              fallback={3820}
              min={1}
              onCommit={(port) => setConsoleCfg({ port })}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="访问令牌环境变量"
          description="填写环境变量名以启用登录验证，留空则直接访问"
        >
          <div className="w-full sm:w-64">
            <ConsoleInput
              size="sm"
              value={consoleCfg.auth_token_env ?? ""}
              onChange={(v) => setConsoleCfg({ auth_token_env: v.trim() || undefined })}
              placeholder="留空免验证"
            />
          </div>
        </SettingsRow>
      </SettingsCardGroup>
    </div>
  );
}
