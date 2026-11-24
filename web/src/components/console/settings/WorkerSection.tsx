import {
  Cpu,
  FileText,
  Laptop,
  Layers,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type {
  ExternalCliPermissionPreset,
  ExternalCliProbeEntry,
  HatoConfig,
} from "@/api";
import { ConsoleInput, ConsoleSelect } from "@/components/console/ConsolePrimitives";
import {
  CLI_CHOICE_ICONS,
  listEnabledBackendOptions,
  PERMISSION_PRESET_OPTIONS,
  SettingsCardGroup,
  SettingsRow,
} from "@/components/console/settings/Primitives";
import {
  BACKEND_CONFIG_KEYS,
  BACKEND_DISPLAY_NAMES,
  CLI_CHOICE_LABELS,
  FOLLOW_PRESET_VALUE,
  resolveEffectiveDefaultBackendInDraft,
} from "@/components/console/settings/types";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Switch } from "@/components/motion/switch";

export interface WorkerSectionProps {
  draft: HatoConfig;
  setDraft: Dispatch<SetStateAction<HatoConfig>>;
  extCliCfg: HatoConfig["worker"]["external_cli"];
  setExtCliCfg: (patch: Partial<HatoConfig["worker"]["external_cli"]>) => void;
  setVmConfirmOpen: (open: boolean) => void;
  applyAllNoApprovalPreset: () => void;
  envRows: Array<{ id: string; key: string; value: string }>;
  updateEnvRows: (next: Array<{ id: string; key: string; value: string }>) => void;
  cliProbes: ExternalCliProbeEntry[];
  probingClis: boolean;
  loadCliProbes: (forceRefresh?: boolean) => Promise<void>;
  setDiagCopied: (copied: boolean) => void;
  setDiagBackend: (backend: ExternalCliProbeEntry["backend"] | null) => void;
  setBackendOptionOverride: (
    backend: ExternalCliProbeEntry["backend"],
    key: string,
    value: string | boolean | undefined,
  ) => void;
  readEnumOverrideValue: (
    backend: ExternalCliProbeEntry["backend"],
    key: string,
    backendCfg: Record<string, unknown>,
  ) => string;
  loadingModelsByBackend: Record<string, boolean>;
  refreshBackendModels: (backend: ExternalCliProbeEntry["backend"]) => Promise<void>;
  patchBackendConfig: (
    backend: ExternalCliProbeEntry["backend"],
    patch: Record<string, string | boolean | undefined>,
  ) => void;
}

export function WorkerSection({
  draft,
  setDraft,
  extCliCfg,
  setExtCliCfg,
  setVmConfirmOpen,
  applyAllNoApprovalPreset,
  envRows,
  updateEnvRows,
  cliProbes,
  probingClis,
  loadCliProbes,
  setDiagCopied,
  setDiagBackend,
  setBackendOptionOverride,
  readEnumOverrideValue,
  loadingModelsByBackend,
  refreshBackendModels,
  patchBackendConfig,
}: WorkerSectionProps) {
  const enabledBackendOptions = listEnabledBackendOptions(draft);
  const effectiveDefaultBackend = resolveEffectiveDefaultBackendInDraft(draft);

  return (
    <div className="flex flex-col gap-6">
      <SettingsCardGroup
        title="权限与执行策略"
        description="仅作用于 Hato 启动的后台任务进程，不会修改本机全局配置"
      >
        <SettingsRow title="默认 Worker 后端" description="高难/仓库任务或关闭智能分流时优先使用的已启用后端">
          <div className="w-full sm:w-56">
            <ConsoleSelect
              size="sm"
              value={effectiveDefaultBackend}
              options={enabledBackendOptions}
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
          </div>
        </SettingsRow>
        <SettingsRow
          title="任务分流策略"
          description="智能分流会把单文件小脚本/简单命令交给内置 builtin-pi，仓库或复杂工程再交给默认后端"
        >
          <div className="w-full sm:w-56">
            <ConsoleSelect
              size="sm"
              value={draft.worker.routing_mode ?? "smart"}
              options={[
                { value: "smart", label: "智能分流（轻量内置）" },
                { value: "always_default", label: "始终使用默认后端" },
              ]}
              onValueChange={(val) =>
                setDraft((prev) => ({
                  ...prev,
                  worker: {
                    ...prev.worker,
                    routing_mode: val as "smart" | "always_default",
                  },
                }))
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="机器独占权"
          description="默认关闭。开启后 Hato 与 Worker 将获得整机持久工作目录与完整执行权限（仍保留审批机制且严格禁止读取 .env 密钥）"
        >
          <Switch
            ariaLabel="机器独占权"
            checked={draft.worker.execution_mode === "vm_unrestricted"}
            onCheckedChange={(checked) => {
              if (checked) {
                setVmConfirmOpen(true);
              } else {
                setDraft((prev) => ({
                  ...prev,
                  worker: {
                    ...prev.worker,
                    execution_mode: "isolated",
                  },
                }));
              }
            }}
          />
        </SettingsRow>
        {draft.worker.execution_mode === "vm_unrestricted" ? (
          <SettingsRow
            title="VM 持久工作目录"
            description="留空则默认使用当前用户主目录（~）作为持久工作目录"
          >
            <div className="w-full sm:w-56">
              <ConsoleInput
                value={draft.worker.vm_workdir ?? ""}
                placeholder="~"
                onChange={(val) =>
                  setDraft((prev) => ({
                    ...prev,
                    worker: {
                      ...prev.worker,
                      vm_workdir: val,
                    },
                  }))
                }
              />
            </div>
          </SettingsRow>
        ) : null}
        <SettingsRow
          title="全局权限预设"
          description="作为各后端选择「跟随全局」时的默认策略；下方可对单个后端单独覆写"
        >
          <div className="w-full sm:w-56">
            <ConsoleSelect
              size="sm"
              value={
                extCliCfg.permission_preset === "custom"
                  ? "follow_host"
                  : (extCliCfg.permission_preset ?? "auto_safe")
              }
              options={PERMISSION_PRESET_OPTIONS}
              onValueChange={(val) =>
                setExtCliCfg({ permission_preset: val as ExternalCliPermissionPreset })
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="复用本机配置"
          description="继承本机已有账号登录与供应商中转设置"
        >
          <Switch
            ariaLabel="复用本机配置"
            checked={extCliCfg.reuse_host_auth_and_provider ?? true}
            onCheckedChange={(on) => setExtCliCfg({ reuse_host_auth_and_provider: on })}
          />
        </SettingsRow>
        <SettingsRow
          title="继承本机个人 MCP"
          description="开启后同步加载本机已配置的个人 MCP 服务"
        >
          <Switch
            ariaLabel="继承本机个人 MCP"
            checked={extCliCfg.inherit_host_mcp ?? false}
            onCheckedChange={(on) => setExtCliCfg({ inherit_host_mcp: on })}
          />
        </SettingsRow>
      </SettingsCardGroup>

      <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/6 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-foreground">一键完全访问（高权限）</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              无需批准即可编辑文件并运行可访问网络的命令，且将清除各后端单独覆写设置
            </div>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 border-amber-500/40 text-amber-700 hover:bg-amber-500/12 dark:text-amber-300"
          onClick={applyAllNoApprovalPreset}
        >
          <ShieldAlert className="size-3.5" />
          设为完全访问
        </Button>
      </div>

      <SettingsCardGroup
        title="环境变量"
        description="注入到所有外置 CLI Worker 进程中的自定义环境变量（如镜像源、证书路径等）"
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              updateEnvRows([
                ...envRows,
                { id: `env-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, key: "", value: "" },
              ])
            }
          >
            <Plus className="size-3.5" />
            添加变量
          </Button>
        }
      >
        {envRows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            暂无自定义环境变量，仅保留基础系统变量与代理配置
          </div>
        ) : (
          envRows.map((row, idx) => (
            <div
              key={row.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-2.5"
            >
              <div className="w-full sm:w-52">
                <ConsoleInput
                  size="sm"
                  aria-label={`环境变量名 ${idx + 1}`}
                  placeholder="变量名 (如 PIP_INDEX_URL)"
                  value={row.key}
                  onChange={(nextKey) =>
                    updateEnvRows(
                      envRows.map((r) => (r.id === row.id ? { ...r, key: nextKey } : r)),
                    )
                  }
                />
              </div>
              <div className="min-w-0 flex-1">
                <ConsoleInput
                  size="sm"
                  aria-label={`环境变量值 ${idx + 1}`}
                  placeholder="变量值"
                  value={row.value}
                  onChange={(nextValue) =>
                    updateEnvRows(
                      envRows.map((r) => (r.id === row.id ? { ...r, value: nextValue } : r)),
                    )
                  }
                />
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`删除环境变量 ${row.key || idx + 1}`}
                onClick={() => updateEnvRows(envRows.filter((r) => r.id !== row.id))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </SettingsCardGroup>

      <section className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">外部执行后端</h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={probingClis}
            onClick={() => void loadCliProbes(true)}
          >
            <RefreshCw className={`size-3.5 ${probingClis ? "animate-spin" : ""}`} />
            刷新后端状态
          </Button>
        </div>

        <div className="flex flex-col gap-3">
          {cliProbes.map((probe) => {
            const cfgKey = BACKEND_CONFIG_KEYS[probe.backend];
            const backendCfg = (extCliCfg[cfgKey] as Record<string, unknown> | undefined) ?? {};

            return (
              <div
                key={probe.backend}
                className="divide-y divide-border/70 rounded-xl border border-border/80 bg-card/60"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-foreground">
                      {BACKEND_DISPLAY_NAMES[probe.backend]}
                    </span>
                    {probe.available ? (
                      <AnimatedBadge status="success" size="sm">
                        已就绪
                      </AnimatedBadge>
                    ) : (
                      <AnimatedBadge
                        status={probe.installed ? "danger" : "warning"}
                        size="sm"
                      >
                        {probe.installed ? "版本不兼容" : "未安装"}
                      </AnimatedBadge>
                    )}
                  </div>

                  <div className="flex items-center gap-2.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        setDiagCopied(false);
                        setDiagBackend(probe.backend);
                      }}
                    >
                      <FileText className="size-3.5" />
                      诊断
                    </Button>
                    <Switch
                      ariaLabel={`启用 ${BACKEND_DISPLAY_NAMES[probe.backend]}`}
                      checked={
                        typeof backendCfg.enabled === "boolean"
                          ? backendCfg.enabled
                          : probe.enabled
                      }
                      onCheckedChange={(on) =>
                        setBackendOptionOverride(probe.backend, "enabled", on)
                      }
                    />
                  </div>
                </div>

                {!probe.installed ? (
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    未检测到 {probe.command} 命令，安装后点击「刷新后端状态」即可启用
                  </p>
                ) : probe.reason ? (
                  <div className="bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
                    {probe.reason}
                  </div>
                ) : null}

                {probe.options.map((opt) => {
                  const rawOverride = backendCfg[opt.key];
                  if (opt.kind === "enum") {
                    const currentStr = readEnumOverrideValue(
                      probe.backend,
                      opt.key,
                      backendCfg,
                    );
                    const selectOptions = [
                      {
                        value: FOLLOW_PRESET_VALUE,
                        label: "跟随全局",
                        icon: <Layers className="size-3.5 text-muted-foreground" />,
                      },
                      ...(opt.choices ?? []).map((c) => ({
                        value: c,
                        label: CLI_CHOICE_LABELS[c] ?? c,
                        icon: CLI_CHOICE_ICONS[c],
                      })),
                    ];
                    return (
                      <div
                        key={opt.key}
                        className="flex h-12 items-center justify-between gap-4 px-4"
                      >
                        <span className="text-[13px] font-medium text-foreground">
                          {opt.label}
                        </span>
                        <ConsoleSelect
                          size="sm"
                          className="w-48 shrink-0"
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
                      </div>
                    );
                  }

                  const boolValue =
                    typeof rawOverride === "boolean"
                      ? rawOverride
                      : Boolean(opt.effectiveHatoValue);
                  return (
                    <div
                      key={opt.key}
                      className="flex h-12 items-center justify-between gap-4 px-4"
                    >
                      <span className="text-[13px] font-medium text-foreground">
                        {opt.label}
                      </span>
                      <Switch
                        ariaLabel={`${BACKEND_DISPLAY_NAMES[probe.backend]} ${opt.label}`}
                        checked={boolValue}
                        onCheckedChange={(on) =>
                          setBackendOptionOverride(probe.backend, opt.key, on)
                        }
                      />
                    </div>
                  );
                })}

                {(() => {
                  const configuredModel =
                    typeof backendCfg.model === "string" ? backendCfg.model.trim() : "";
                  const probedModels = probe.models ?? [];
                  const hasConfiguredInList =
                    configuredModel.length > 0 &&
                    probedModels.some((m) => m.id === configuredModel);
                  const modelSelectOptions = [
                    {
                      value: FOLLOW_PRESET_VALUE,
                      label: "跟随本机",
                      icon: <Laptop className="size-3.5 text-muted-foreground" />,
                    },
                    ...probedModels.map((m) => ({
                      value: m.id,
                      label: m.label && m.label !== m.id ? m.label : m.id,
                      icon: <Cpu className="size-3.5 text-muted-foreground" />,
                    })),
                    ...(configuredModel && !hasConfiguredInList
                      ? [
                          {
                            value: configuredModel,
                            label: configuredModel,
                            icon: <Cpu className="size-3.5 text-muted-foreground" />,
                          },
                        ]
                      : []),
                  ];
                  const modelBusy = Boolean(loadingModelsByBackend[probe.backend]);
                  return (
                    <div className="flex h-12 items-center justify-between gap-4 px-4">
                      <span className="text-[13px] font-medium text-foreground">
                        模型
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={modelBusy || !probe.installed}
                          onClick={() => void refreshBackendModels(probe.backend)}
                          title="实时刷新可用模型列表"
                          aria-label={`刷新 ${BACKEND_DISPLAY_NAMES[probe.backend]} 模型列表`}
                          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                        >
                          <RefreshCw className={`size-3.5 ${modelBusy ? "animate-spin" : ""}`} />
                        </button>
                        <ConsoleSelect
                          size="sm"
                          className="w-48 shrink-0"
                          value={configuredModel || FOLLOW_PRESET_VALUE}
                          options={modelSelectOptions}
                          onValueChange={(next) =>
                            patchBackendConfig(probe.backend, {
                              model: next === FOLLOW_PRESET_VALUE ? undefined : next,
                            })
                          }
                        />
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
