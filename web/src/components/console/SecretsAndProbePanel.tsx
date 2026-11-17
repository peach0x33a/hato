import { Activity, Eye, EyeOff, KeyRound, Pencil, Plus, Save, X } from "lucide-react";
import { useState } from "react";
import { api, type ProbeResponse, type SecretState } from "@/api";
import { ConsoleInput } from "@/components/console/ConsolePrimitives";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, StatefulButton, type ButtonState } from "@/components/motion/button";

export interface SecretsAndProbePanelProps {
  secretStates: SecretState[];
  onSecretsUpdated: (nextStates: SecretState[], changes?: string[]) => void;
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
  embedded?: boolean;
}

const PROBE_STORAGE_KEY = "hato_service_probe_results_v1";

type ProbeTargetKey = "telegram" | "qq" | "tavily" | "memory";

const PROBE_TARGETS: ReadonlyArray<{
  key: ProbeTargetKey;
  title: string;
  description: string;
}> = [
  {
    key: "telegram",
    title: "Telegram 通道",
    description: "检查 Bot Token 有效性及 Telegram API 网络可达性",
  },
  {
    key: "qq",
    title: "QQ 通道",
    description: "检查 QQ App Access Token 兑换与官方 WebSocket 网关可达性",
  },
  {
    key: "tavily",
    title: "Tavily 搜索",
    description: "验证联网检索密钥与 Tavily 接口响应状态",
  },
  {
    key: "memory",
    title: "记忆服务",
    description: "检查当前记忆后端（MemoryEcho / Hindsight）连通性与鉴权状态",
  },
];

function loadSavedProbeResults(): ProbeResponse["results"] | null {
  try {
    const raw = window.localStorage.getItem(PROBE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ProbeResponse["results"]) : null;
  } catch {
    return null;
  }
}

function saveProbeResults(results: ProbeResponse["results"]): void {
  try {
    window.localStorage.setItem(PROBE_STORAGE_KEY, JSON.stringify(results));
  } catch {
    // ignore storage quota errors
  }
}

export function SecretsAndProbePanel({
  secretStates,
  onSecretsUpdated,
  onToast,
  embedded = false,
}: SecretsAndProbePanelProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showEditValue, setShowEditValue] = useState(false);

  const [addingCustom, setAddingCustom] = useState(false);
  const [customKey, setCustomKey] = useState("");
  const [customVal, setCustomVal] = useState("");
  const [showCustomVal, setShowCustomVal] = useState(false);

  const [saveState, setSaveState] = useState<ButtonState>("idle");
  const [probingTarget, setProbingTarget] = useState<"all" | ProbeTargetKey | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResponse["results"] | null>(() =>
    loadSavedProbeResults(),
  );

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

  const runProbe = async (target: "all" | ProbeTargetKey) => {
    setProbingTarget(target);
    try {
      const res = await api.probe(target);
      const nowMs = Date.now();
      const stamped: ProbeResponse["results"] = {};
      for (const [k, val] of Object.entries(res.results)) {
        if (val) {
          stamped[k as ProbeTargetKey] = { ...val, testedAtMs: nowMs };
        }
      }
      setProbeResult((prev) => {
        const merged = { ...(prev ?? {}), ...stamped };
        saveProbeResults(merged);
        return merged;
      });
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
    <div className="flex flex-col gap-7">
      {!embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">密钥与自检</h2>
            <AnimatedBadge
              status={
                configuredCount === secretStates.length && secretStates.length > 0
                  ? "success"
                  : "neutral"
              }
              size="sm"
            >
              {configuredCount}/{secretStates.length} 已配置
            </AnimatedBadge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
        </div>
      ) : null}

      {/* Group 1: Credentials */}
      <section aria-labelledby="credentials-heading" className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id="credentials-heading" className="text-xs font-medium text-muted-foreground">
              已注册凭据
            </h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">
              更新后立即生效，页面仅显示脱敏掩码。
            </p>
          </div>
          {embedded ? (
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
          ) : null}
        </div>

        <div className="divide-y divide-border/70 rounded-xl border border-border/80 bg-card/60">
          {addingCustom && (
            <form
              className="flex flex-col gap-3 bg-muted/20 px-4 py-4"
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
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-foreground">新增环境变量</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    建议使用大写字母与下划线命名，例如 DEEPSEEK_API_KEY。
                  </p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
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
              </div>
              <div className="flex items-center justify-end gap-2">
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
            </form>
          )}

          {secretStates.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              暂无已注册的环境变量密钥，点击右上角「新增密钥」添加。
            </div>
          ) : (
            secretStates.map((item) => {
              const isEditing = editingKey === item.key;
              return (
                <div
                  key={item.key}
                  className="flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-muted/20 sm:flex-row sm:items-center sm:justify-between"
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
                      className="flex w-full items-center gap-2 sm:w-auto sm:min-w-[340px]"
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
            })
          )}
        </div>
      </section>

      {/* Group 2: Connectivity Probe */}
      <section aria-labelledby="probe-heading" className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id="probe-heading" className="text-xs font-medium text-muted-foreground">
              服务连通性检测
            </h3>
          </div>
          {embedded ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={probing}
              onClick={() => void runProbe("all")}
            >
              <Activity className={`size-3.5 ${probingTarget === "all" ? "animate-pulse" : ""}`} />
              {probingTarget === "all" ? "全链路检测中…" : "检测全部链路"}
            </Button>
          ) : null}
        </div>

        <div className="divide-y divide-border/70 rounded-xl border border-border/80 bg-card/60">
          {PROBE_TARGETS.map(({ key, title, description }) => {
            const r = probeResult?.[key];
            const isTargetProbing = probingTarget === key || probingTarget === "all";
            return (
              <div
                key={key}
                className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-foreground">{title}</span>
                    {isTargetProbing ? (
                      <AnimatedBadge status="loading" size="sm">
                        检测中…
                      </AnimatedBadge>
                    ) : r ? (
                      <AnimatedBadge
                        status={r.ok ? "success" : r.skipped ? "neutral" : "danger"}
                        size="sm"
                      >
                        {r.ok ? `${r.latencyMs}ms` : r.skipped ? "未启用" : "连接失败"}
                      </AnimatedBadge>
                    ) : (
                      <AnimatedBadge status="neutral" size="sm">
                        未执行检测
                      </AnimatedBadge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r ? r.message : description}
                  </p>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={probing}
                  onClick={() => void runProbe(key)}
                >
                  {probingTarget === key ? "检测中…" : "检测此项"}
                </Button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
