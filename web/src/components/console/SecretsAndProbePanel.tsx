import { Activity, Eye, EyeOff, KeyRound, Pencil, Plus, Save, X } from "lucide-react";
import { useState } from "react";
import { api, type ProbeResponse, type SecretState } from "@/api";
import { ConsoleInput, ConsolePageHeader } from "@/components/console/ConsolePrimitives";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, StatefulButton, type ButtonState } from "@/components/motion/button";

export interface SecretsAndProbePanelProps {
  secretStates: SecretState[];
  onSecretsUpdated: (nextStates: SecretState[], changes?: string[]) => void;
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
}

const PROBE_TARGETS = [
  {
    key: "telegram",
    title: "Telegram 网关",
    description: "检查 Bot Token 有效性及 Telegram API 网络可达性",
  },
  {
    key: "persona",
    title: "主对话模型",
    description: "向当前 persona 槽位模型发起最小连通性探测",
  },
  {
    key: "tavily",
    title: "Tavily 搜索",
    description: "验证联网检索密钥与 Tavily 接口响应状态",
  },
] as const;

export function SecretsAndProbePanel({
  secretStates,
  onSecretsUpdated,
  onToast,
}: SecretsAndProbePanelProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showEditValue, setShowEditValue] = useState(false);

  const [addingCustom, setAddingCustom] = useState(false);
  const [customKey, setCustomKey] = useState("");
  const [customVal, setCustomVal] = useState("");
  const [showCustomVal, setShowCustomVal] = useState(false);

  const [saveState, setSaveState] = useState<ButtonState>("idle");
  const [probingTarget, setProbingTarget] = useState<"all" | "telegram" | "persona" | "tavily" | null>(
    null,
  );
  const [probeResult, setProbeResult] = useState<ProbeResponse["results"] | null>(null);

  const configuredCount = secretStates.filter((s) => s.configured).length;
  const probing = probingTarget !== null;

  const commitSecretUpdate = async (key: string, value: string) => {
    const cleanKey = key.trim();
    const cleanVal = value.trim();
    if (!cleanKey || !cleanVal) {
      onToast({ title: "请输入有效的变量名与密钥值", status: "error" });
      return;
    }

    setSaveState("loading");
    try {
      const res = await api.saveSecrets({ [cleanKey]: cleanVal });
      setSaveState("success");
      setEditingKey(null);
      setEditValue("");
      setShowEditValue(false);
      setAddingCustom(false);
      setCustomKey("");
      setCustomVal("");
      setShowCustomVal(false);
      onSecretsUpdated(res.secretStates, res.changes);
      onToast({
        title: `已更新密钥 ${cleanKey}`,
        description: res.changes?.length ? res.changes.join("；") : undefined,
        status: "success",
      });
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err) {
      setSaveState("error");
      onToast({
        title: "保存密钥失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
      setTimeout(() => setSaveState("idle"), 1800);
    }
  };

  const runProbe = async (target: "all" | "telegram" | "persona" | "tavily") => {
    setProbingTarget(target);
    try {
      const res = await api.probe(target);
      setProbeResult((prev) => ({ ...(prev ?? {}), ...res.results }));
    } catch (err) {
      onToast({
        title: "连通性检测失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setProbingTarget(null);
    }
  };

  return (
    <div className="flex flex-col gap-8 pb-6">
      <ConsolePageHeader
        title="密钥与自检"
        badges={
          <AnimatedBadge
            status={configuredCount === secretStates.length && secretStates.length > 0 ? "success" : "neutral"}
            size="sm"
          >
            {configuredCount}/{secretStates.length} 已配置
          </AnimatedBadge>
        }
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditingKey(null);
              setShowEditValue(false);
              setAddingCustom((v) => !v);
            }}
          >
            <Plus className="size-3.5" />
            新增密钥
          </Button>
        }
      />

      {/* Section 1: Credentials */}
      <section aria-labelledby="credentials-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 id="credentials-heading" className="text-sm font-semibold text-foreground">
              已注册凭据
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              保存后立即写入本地环境配置并应用至运行时，界面仅展示脱敏掩码。
            </p>
          </div>
        </div>

        {addingCustom && (
          <form
            className="grid gap-4 border-y border-border bg-muted/20 px-3 py-4 md:grid-cols-12"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setAddingCustom(false);
                setShowCustomVal(false);
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              void commitSecretUpdate(customKey, customVal);
            }}
          >
            <div className="md:col-span-4">
              <p className="text-xs font-medium text-foreground">新增环境变量</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                建议使用大写字母与下划线命名，例如 DEEPSEEK_API_KEY。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 md:col-span-8">
              <ConsoleInput
                label="环境变量名称"
                value={customKey}
                onChange={setCustomKey}
                placeholder="例如 DEEPSEEK_API_KEY"
                autoFocus
              />
              <ConsoleInput
                label="密钥内容"
                type={showCustomVal ? "text" : "password"}
                value={customVal}
                onChange={setCustomVal}
                placeholder="输入密钥值"
                rightIcon={
                  <button
                    type="button"
                    aria-label={showCustomVal ? "隐藏密钥" : "显示密钥"}
                    onClick={() => setShowCustomVal((v) => !v)}
                    className="!size-8 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showCustomVal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                }
              />
              <div className="flex items-center justify-end gap-2 sm:col-span-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAddingCustom(false);
                    setShowCustomVal(false);
                  }}
                >
                  取消
                </Button>
                <StatefulButton
                  type="submit"
                  size="sm"
                  state={saveState}
                  loadingText="保存中…"
                  successText="已保存"
                  icon={<Save className="size-3.5" />}
                >
                  保存密钥
                </StatefulButton>
              </div>
            </div>
          </form>
        )}

        {secretStates.length === 0 ? (
          <div className="border-y border-border py-8 text-center text-xs text-muted-foreground">
            暂无已注册的环境变量密钥，点击右上角「新增密钥」添加。
          </div>
        ) : (
          <div className="divide-y divide-border/80 border-y border-border">
            {secretStates.map((item) => {
              const isEditing = editingKey === item.key;
              return (
                <div
                  key={item.key}
                  className="flex flex-col gap-3 px-1 py-3 transition-colors hover:bg-muted/20 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                    <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-xs font-semibold text-foreground">
                      {item.key}
                    </span>
                    <AnimatedBadge status={item.configured ? "success" : "warning"} size="sm">
                      {item.configured ? item.masked : "未配置"}
                    </AnimatedBadge>
                  </div>

                  {isEditing ? (
                    <form
                      className="flex w-full items-center gap-2 sm:w-auto sm:min-w-[360px]"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setEditingKey(null);
                          setEditValue("");
                          setShowEditValue(false);
                        }
                      }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void commitSecretUpdate(item.key, editValue);
                      }}
                    >
                      <div className="flex-1">
                        <ConsoleInput
                          size="sm"
                          type={showEditValue ? "text" : "password"}
                          value={editValue}
                          onChange={setEditValue}
                          placeholder="输入新密钥值"
                          autoFocus
                          rightIcon={
                            <button
                              type="button"
                              aria-label={showEditValue ? "隐藏密钥" : "显示密钥"}
                              onClick={() => setShowEditValue((v) => !v)}
                              className="!size-8 text-muted-foreground transition-colors hover:text-foreground"
                            >
                              {showEditValue ? (
                                <EyeOff className="size-3.5" />
                              ) : (
                                <Eye className="size-3.5" />
                              )}
                            </button>
                          }
                        />
                      </div>
                      <StatefulButton
                        type="submit"
                        size="sm"
                        state={saveState}
                        loadingText="保存…"
                        successText="已保存"
                      >
                        保存
                      </StatefulButton>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="取消修改"
                        onClick={() => {
                          setEditingKey(null);
                          setEditValue("");
                          setShowEditValue(false);
                        }}
                      >
                        <X className="size-4" />
                      </Button>
                    </form>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant={item.configured ? "ghost" : "outline"}
                      onClick={() => {
                        setAddingCustom(false);
                        setShowCustomVal(false);
                        setEditingKey(item.key);
                        setEditValue("");
                        setShowEditValue(false);
                      }}
                    >
                      <Pencil className="size-3.5" />
                      {item.configured ? "修改密钥" : "立即配置"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 2: Connectivity Probe */}
      <section aria-labelledby="probe-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="probe-heading" className="text-sm font-semibold text-foreground">
              服务连通性检测
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              按链路单独验证或一键巡检核心服务可用性与延迟。
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={probing}
            onClick={() => void runProbe("all")}
          >
            <Activity className={`size-3.5 ${probingTarget === "all" ? "animate-pulse" : ""}`} />
            {probingTarget === "all" ? "全链路检测中…" : "检测全部链路"}
          </Button>
        </div>

        <div className="divide-y divide-border/80 border-y border-border">
          {PROBE_TARGETS.map(({ key, title, description }) => {
            const r = probeResult?.[key];
            const isTargetProbing = probingTarget === key || probingTarget === "all";
            return (
              <div
                key={key}
                className="grid items-center gap-3 px-1 py-3.5 md:grid-cols-12"
              >
                <div className="md:col-span-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground">{title}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
                </div>

                <div className="flex min-w-0 flex-wrap items-center gap-2.5 md:col-span-6">
                  {isTargetProbing ? (
                    <AnimatedBadge status="loading" size="sm">
                      检测中…
                    </AnimatedBadge>
                  ) : r ? (
                    <AnimatedBadge status={r.ok ? "success" : "danger"} size="sm">
                      {r.ok ? `${r.latencyMs}ms` : "连接失败"}
                    </AnimatedBadge>
                  ) : (
                    <AnimatedBadge status="neutral" size="sm">
                      未执行检测
                    </AnimatedBadge>
                  )}
                  <span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground break-words">
                    {r ? r.message : "点击右侧按钮验证当前链路配置"}
                  </span>
                </div>

                <div className="flex justify-end md:col-span-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={probing}
                    onClick={() => void runProbe(key)}
                  >
                    {probingTarget === key ? "检测中…" : "单项检测"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
