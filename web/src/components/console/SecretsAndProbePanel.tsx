import { Activity, KeyRound, Pencil, Plus, Save, X } from "lucide-react";
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

export function SecretsAndProbePanel({
  secretStates,
  onSecretsUpdated,
  onToast,
}: SecretsAndProbePanelProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);
  const [customKey, setCustomKey] = useState("");
  const [customVal, setCustomVal] = useState("");
  const [saveState, setSaveState] = useState<ButtonState>("idle");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResponse["results"] | null>(null);

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
      setAddingCustom(false);
      setCustomKey("");
      setCustomVal("");
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
    setProbing(true);
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
      setProbing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ConsolePageHeader
        title="密钥与自检"
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditingKey(null);
              setAddingCustom((v) => !v);
            }}
          >
            <Plus className="size-3.5" />
            新增密钥
          </Button>
        }
      />

      <div className="overflow-hidden rounded-xl border border-border bg-card divide-y divide-border">
        {/* Section 1: Credentials */}
        <div className="flex items-center justify-between bg-muted/25 px-4 py-2.5">
          <span className="text-xs font-semibold text-foreground">已注册凭据</span>
        </div>

        {addingCustom && (
          <form
            className="grid items-end gap-3 bg-muted/20 px-4 py-3 md:grid-cols-12"
            onSubmit={(e) => {
              e.preventDefault();
              void commitSecretUpdate(customKey, customVal);
            }}
          >
            <div className="md:col-span-4">
              <ConsoleInput
                label="环境变量名称"
                value={customKey}
                onChange={setCustomKey}
                placeholder="例如 DEEPSEEK_API_KEY"
                autoFocus
              />
            </div>
            <div className="md:col-span-5">
              <ConsoleInput
                label="密钥内容"
                type="password"
                value={customVal}
                onChange={setCustomVal}
                placeholder="输入密钥值"
              />
            </div>
            <div className="md:col-span-3 flex h-9 items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setAddingCustom(false)}
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

        <div className="divide-y divide-border/70">
          {secretStates.map((item) => {
            const isEditing = editingKey === item.key;
            return (
              <div
                key={item.key}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <KeyRound className="size-3.5 text-muted-foreground" />
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
                    onSubmit={(e) => {
                      e.preventDefault();
                      void commitSecretUpdate(item.key, editValue);
                    }}
                  >
                    <div className="flex-1">
                      <ConsoleInput
                        size="sm"
                        type="password"
                        value={editValue}
                        onChange={setEditValue}
                        placeholder="输入新密钥值"
                        autoFocus
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
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </form>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAddingCustom(false);
                      setEditingKey(item.key);
                      setEditValue("");
                    }}
                  >
                    <Pencil className="size-3.5" />
                    修改密钥
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        {/* Section 2: Connectivity Probe */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/25 px-4 py-2.5">
          <span className="text-xs font-semibold text-foreground">服务连通性检测</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={probing}
              onClick={() => void runProbe("telegram")}
            >
              检测 Telegram
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={probing}
              onClick={() => void runProbe("persona")}
            >
              检测主模型
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={probing}
              onClick={() => void runProbe("tavily")}
            >
              检测 Tavily
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={probing}
              onClick={() => void runProbe("all")}
            >
              <Activity className={`size-3.5 ${probing ? "animate-pulse" : ""}`} />
              {probing ? "检测中…" : "检测全部链路"}
            </Button>
          </div>
        </div>

        <div className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
          {(
            [
              ["telegram", "Telegram 网关"],
              ["persona", "主对话模型"],
              ["tavily", "Tavily 搜索"],
            ] as const
          ).map(([key, title]) => {
            const r = probeResult?.[key];
            return (
              <div key={key} className="flex flex-col gap-1.5 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">{title}</span>
                  {r ? (
                    <AnimatedBadge status={r.ok ? "success" : "danger"} size="sm">
                      {r.ok ? `${r.latencyMs}ms` : "连接失败"}
                    </AnimatedBadge>
                  ) : (
                    <AnimatedBadge status="neutral" size="sm">
                      未执行检测
                    </AnimatedBadge>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {r ? r.message : "点击上方按钮验证当前链路配置"}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
