import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ExternalCliProbeEntry,
  type HatoConfig,
  type ProxyRuleConfig,
  type TelegramUserProfile,
} from "@/api";
import { ConsoleInput } from "@/components/console/ConsolePrimitives";
import { SecretsAndProbePanel } from "@/components/console/SecretsAndProbePanel";
import { GatewaySection } from "@/components/console/settings/GatewaySection";
import { GeneralSection } from "@/components/console/settings/GeneralSection";
import {
  BrowserSection,
  ProxySection,
  SearchSection,
} from "@/components/console/settings/NetworkWebSections";
import {
  BACKEND_CONFIG_KEYS,
  BACKEND_DISPLAY_NAMES,
  envRecordToRows,
  FOLLOW_PRESET_VALUE,
  formatDiagnosticsReport,
  makeProxyId,
  resolveEffectiveDefaultBackendInDraft,
  SETTINGS_GROUPS,
  SETTINGS_NAV_ITEMS,
  type SettingsPanelProps,
  type SettingsSectionId,
  VALID_SETTINGS_SECTIONS,
} from "@/components/console/settings/types";
import { WorkerSection } from "@/components/console/settings/WorkerSection";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, StatefulButton, type ButtonState } from "@/components/motion/button";
import { EASE_OUT, SPRING_LAYOUT, SPRING_PANEL } from "@/lib/ease";
import { cn } from "@/lib/utils";

export { type SettingsPanelProps, type SettingsSectionId, VALID_SETTINGS_SECTIONS };

export function SettingsPanel({
  initialConfig,
  secretStates,
  activeSection,
  onSectionChange,
  onBack,
  onSavedConfig,
  onSecretsUpdated,
  onToast,
}: SettingsPanelProps) {
  const { theme, setTheme } = useTheme();
  const [vmConfirmOpen, setVmConfirmOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const [searchQuery, setSearchQuery] = useState("");
  const [draft, setDraft] = useState<HatoConfig>(() => structuredClone(initialConfig));
  const [saveState, setSaveState] = useState<ButtonState>("idle");
  const [lastProxyUrls, setLastProxyUrls] = useState<Record<string, string>>({});
  const [proxyIds, setProxyIds] = useState<string[]>(() =>
    (initialConfig.network?.proxies ?? []).map(() => makeProxyId()),
  );
  const [cliProbes, setCliProbes] = useState<ExternalCliProbeEntry[]>([]);
  const [probingClis, setProbingClis] = useState(false);
  const [loadingModelsByBackend, setLoadingModelsByBackend] = useState<Record<string, boolean>>({});
  const [diagBackend, setDiagBackend] = useState<ExternalCliProbeEntry["backend"] | null>(null);
  const [diagCopied, setDiagCopied] = useState(false);
  const [newTgIdInput, setNewTgIdInput] = useState("");
  const [tgProfiles, setTgProfiles] = useState<Record<string, TelegramUserProfile>>({});
  const [loadingTgProfiles, setLoadingTgProfiles] = useState(false);
  const [envRows, setEnvRows] = useState<Array<{ id: string; key: string; value: string }>>(() =>
    envRecordToRows(initialConfig.worker.external_cli.env),
  );

  const loadTgProfiles = useCallback(
    async (userIds: Array<string | number>, refresh = false) => {
      const clean = userIds.map((v) => String(v).trim()).filter(Boolean);
      if (clean.length === 0) return;
      setLoadingTgProfiles(true);
      try {
        const res = await api.fetchTelegramUsers(clean, refresh);
        setTgProfiles((prev) => {
          const next = { ...prev };
          for (const profile of res.profiles) {
            next[profile.id] = profile;
          }
          return next;
        });
      } catch (err) {
        if (refresh) {
          onToast({
            title: "拉取 Telegram 头像与资料失败",
            description: err instanceof Error ? err.message : String(err),
            status: "error",
          });
        }
      } finally {
        setLoadingTgProfiles(false);
      }
    },
    [onToast],
  );

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

  const refreshBackendModels = useCallback(
    async (backend: ExternalCliProbeEntry["backend"]) => {
      setLoadingModelsByBackend((prev) => ({ ...prev, [backend]: true }));
      try {
        const res = await api.getWorkerCliModels(backend);
        setCliProbes((prev) =>
          prev.map((p) => (p.backend === backend ? { ...p, models: res.models } : p)),
        );
        onToast({
          title: `${BACKEND_DISPLAY_NAMES[backend]} 模型列表已刷新`,
          description: `共发现 ${res.models.length} 个可用模型`,
          status: "success",
        });
      } catch (err) {
        onToast({
          title: `刷新 ${BACKEND_DISPLAY_NAMES[backend]} 模型失败`,
          description: err instanceof Error ? err.message : String(err),
          status: "error",
        });
      } finally {
        setLoadingModelsByBackend((prev) => ({ ...prev, [backend]: false }));
      }
    },
    [onToast],
  );

  useEffect(() => {
    setDraft(structuredClone(initialConfig));
    setEnvRows(envRecordToRows(initialConfig.worker.external_cli.env));
    setLastProxyUrls({});
    setProxyIds((initialConfig.network?.proxies ?? []).map(() => makeProxyId()));
  }, [initialConfig]);

  useEffect(() => {
    void loadCliProbes(false);
  }, [loadCliProbes]);

  const tgWhitelistIds = draft.owner.channels.tg.user_ids;
  const tgWhitelistKey = tgWhitelistIds.map((id) => String(id).trim()).filter(Boolean).join(",");

  useEffect(() => {
    const missing = tgWhitelistIds
      .map((id) => String(id).trim())
      .filter((id) => id.length > 0 && !tgProfiles[id]);
    if (missing.length > 0) {
      void loadTgProfiles(missing, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgWhitelistKey]);

  const handleAddTgWhitelistIds = () => {
    const tokens = newTgIdInput
      .split(/[\s,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;

    const existingSet = new Set(tgWhitelistIds.map((id) => String(id).trim()));
    const added: Array<string | number> = [];
    for (const tok of tokens) {
      if (existingSet.has(tok)) continue;
      existingSet.add(tok);
      added.push(/^\d+$/.test(tok) ? Number(tok) : tok);
    }
    if (added.length === 0) {
      setNewTgIdInput("");
      onToast({ title: "该 Telegram ID 已在白名单中", status: "info" });
      return;
    }

    setDraft((p) => ({
      ...p,
      owner: {
        ...p.owner,
        channels: {
          ...p.owner.channels,
          tg: {
            user_ids: [...p.owner.channels.tg.user_ids, ...added],
          },
        },
      },
    }));
    setNewTgIdInput("");
    void loadTgProfiles(added, false);
  };

  const handleRemoveTgWhitelistId = (targetId: string) => {
    setDraft((p) => ({
      ...p,
      owner: {
        ...p.owner,
        channels: {
          ...p.owner.channels,
          tg: {
            user_ids: p.owner.channels.tg.user_ids.filter((id) => String(id) !== targetId),
          },
        },
      },
    }));
  };

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
    setProxyIds((prev) => [...prev, makeProxyId()]);
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

  const removeProxyRule = (index: number, ruleId: string) => {
    setProxyIds((prev) => prev.filter((_, i) => i !== index));
    setLastProxyUrls((prev) => {
      if (!(ruleId in prev)) return prev;
      const next = { ...prev };
      delete next[ruleId];
      return next;
    });
    setProxies(proxies.filter((_, i) => i !== index));
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

  const setBrowserCfg = (
    patch: Partial<NonNullable<NonNullable<HatoConfig["web"]>["browser"]>>,
  ) => {
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
    setEnvRows(envRecordToRows(initialConfig.worker.external_cli.env));
    setLastProxyUrls({});
    setProxyIds((initialConfig.network?.proxies ?? []).map(() => makeProxyId()));
    onToast({ title: "已还原未保存更改", status: "info" });
  };

  const handleSave = useCallback(async () => {
    if (saveState === "loading") return;
    setSaveState("loading");
    const effectiveBackend = resolveEffectiveDefaultBackendInDraft(draft);
    const nextDraft: HatoConfig =
      effectiveBackend !== draft.worker.default_backend
        ? { ...draft, worker: { ...draft.worker, default_backend: effectiveBackend } }
        : draft;
    try {
      const res = await api.saveHatoConfig(nextDraft);
      setSaveState("success");
      setDraft(nextDraft);
      onSavedConfig(nextDraft, res.changes);
      void loadCliProbes(true);
      onToast({
        title: "设置已保存",
        description: res.changes?.length ? res.changes.join("；") : "配置已生效",
        status: "success",
      });
      setTimeout(() => setSaveState("idle"), 1600);
    } catch (err) {
      setSaveState("error");
      onToast({
        title: "保存设置失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
      setTimeout(() => setSaveState("idle"), 2000);
    }
  }, [draft, loadCliProbes, onSavedConfig, onToast, saveState]);

  const updateEnvRows = (nextRows: Array<{ id: string; key: string; value: string }>) => {
    setEnvRows(nextRows);
    const nextEnv: Record<string, string> = {};
    for (const row of nextRows) {
      const k = row.key.trim();
      if (!k) continue;
      nextEnv[k] = row.value;
    }
    setDraft((prev) => {
      const ext = { ...prev.worker.external_cli };
      if (Object.keys(nextEnv).length === 0) {
        delete ext.env;
      } else {
        ext.env = nextEnv;
      }
      return {
        ...prev,
        worker: {
          ...prev.worker,
          external_cli: ext,
        },
      };
    });
  };

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
            codex_cli: stripOverrides(ext.codex_cli, ["sandbox", "approval"]),
            antigravity_cli: stripOverrides(ext.antigravity_cli, [
              "mode",
              "skip_permissions",
              "sandbox",
            ]),
            opencode_v2: stripOverrides(ext.opencode_v2, ["permission_mode", "auto"]),
            claude_code: stripOverrides(ext.claude_code, [
              "permission_mode",
              "skip_permissions",
            ]),
          },
        },
      };
    });
    onToast({
      title: "已切换为完全访问",
      description: "已清除各后端单独覆写，点击「保存设置」后生效。",
      status: "info",
    });
  };

  const patchBackendConfig = (
    backend: ExternalCliProbeEntry["backend"],
    patch: Record<string, string | boolean | undefined>,
  ) => {
    const cfgKey = BACKEND_CONFIG_KEYS[backend];
    setDraft((prev) => {
      const ext = prev.worker.external_cli;
      const curSection = { ...((ext[cfgKey] as Record<string, unknown> | undefined) ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          delete curSection[k];
        } else {
          curSection[k] = v;
        }
      }
      const nextConfig: HatoConfig = {
        ...prev,
        worker: {
          ...prev.worker,
          external_cli: {
            ...ext,
            [cfgKey]: curSection,
          },
        },
      };
      nextConfig.worker.default_backend = resolveEffectiveDefaultBackendInDraft(nextConfig);
      return nextConfig;
    });
  };

  const setBackendOptionOverride = (
    backend: ExternalCliProbeEntry["backend"],
    optionKey: string,
    nextVal: string | boolean | undefined,
  ) => {
    if (backend === "codex-cli" && optionKey === "codex_mode") {
      if (nextVal === undefined) {
        patchBackendConfig(backend, { sandbox: undefined, approval: undefined });
      } else if (nextVal === "host") {
        patchBackendConfig(backend, { sandbox: undefined, approval: "host" });
      } else if (nextVal === "approve-for-me") {
        patchBackendConfig(backend, { sandbox: "workspace-write", approval: "approve-for-me" });
      } else if (nextVal === "danger-full-access") {
        patchBackendConfig(backend, { sandbox: "danger-full-access", approval: "bypass" });
      } else {
        patchBackendConfig(backend, { sandbox: nextVal, approval: undefined });
      }
      return;
    }

    if (backend === "antigravity-cli" && optionKey === "mode") {
      if (nextVal === undefined) {
        patchBackendConfig(backend, { mode: undefined, skip_permissions: undefined });
      } else if (nextVal === "skip-permissions") {
        patchBackendConfig(backend, { mode: "auto", skip_permissions: true });
      } else {
        patchBackendConfig(backend, { mode: nextVal, skip_permissions: false });
      }
      return;
    }

    if (backend === "claude-code" && optionKey === "permission_mode") {
      if (nextVal === undefined) {
        patchBackendConfig(backend, { permission_mode: undefined, skip_permissions: undefined });
      } else if (nextVal === "bypassPermissions") {
        patchBackendConfig(backend, { permission_mode: "bypassPermissions", skip_permissions: true });
      } else {
        patchBackendConfig(backend, { permission_mode: nextVal, skip_permissions: false });
      }
      return;
    }

    if (backend === "opencode-v2" && optionKey === "permission_mode") {
      if (nextVal === undefined) {
        patchBackendConfig(backend, { permission_mode: undefined, auto: undefined });
      } else {
        patchBackendConfig(backend, {
          permission_mode: nextVal,
          auto: nextVal === "auto" || nextVal === "full_access",
        });
      }
      return;
    }

    patchBackendConfig(backend, { [optionKey]: nextVal });
  };

  const readEnumOverrideValue = (
    backend: ExternalCliProbeEntry["backend"],
    optionKey: string,
    backendCfg: Record<string, unknown>,
  ): string => {
    if (backend === "codex-cli" && optionKey === "codex_mode") {
      if (backendCfg.approval === "bypass" || backendCfg.sandbox === "danger-full-access") {
        return "danger-full-access";
      }
      if (backendCfg.approval === "approve-for-me") return "approve-for-me";
      if (typeof backendCfg.sandbox === "string") return backendCfg.sandbox;
      if (backendCfg.approval === "host") return "host";
      return FOLLOW_PRESET_VALUE;
    }
    if (backend === "antigravity-cli" && optionKey === "mode") {
      if (backendCfg.skip_permissions === true) return "skip-permissions";
      return typeof backendCfg.mode === "string" ? backendCfg.mode : FOLLOW_PRESET_VALUE;
    }
    if (backend === "claude-code" && optionKey === "permission_mode") {
      if (backendCfg.skip_permissions === true) return "bypassPermissions";
      return typeof backendCfg.permission_mode === "string"
        ? backendCfg.permission_mode
        : FOLLOW_PRESET_VALUE;
    }
    if (backend === "opencode-v2" && optionKey === "permission_mode") {
      if (typeof backendCfg.permission_mode === "string") {
        return backendCfg.permission_mode;
      }
      if (backendCfg.auto === true) return "auto";
      if (backendCfg.auto === false) return "ask";
      return FOLLOW_PRESET_VALUE;
    }
    const raw = backendCfg[optionKey];
    return typeof raw === "string" ? raw : FOLLOW_PRESET_VALUE;
  };

  const diagProbe = useMemo(
    () => (diagBackend ? cliProbes.find((p) => p.backend === diagBackend) ?? null : null),
    [cliProbes, diagBackend],
  );

  useEffect(() => {
    if (!diagBackend) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDiagBackend(null);
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [diagBackend]);

  useEffect(() => {
    if (!vmConfirmOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setVmConfirmOpen(false);
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [vmConfirmOpen]);

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  const handleBack = () => {
    if (!onBack) return;
    if (isDirty && !window.confirm("有未保存的设置更改，确定要放弃并返回吗？")) {
      return;
    }
    onBack();
  };

  const handleCopyDiagnostics = async () => {
    if (!diagProbe) return;
    const text = formatDiagnosticsReport(diagProbe);
    try {
      await navigator.clipboard.writeText(text);
      setDiagCopied(true);
      onToast({ title: "已复制诊断信息", status: "success" });
      setTimeout(() => setDiagCopied(false), 1500);
    } catch {
      onToast({ title: "复制失败，请手动选中复制", status: "error" });
    }
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

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const isSearching = normalizedSearch.length > 0;

  const matchingNavItems = useMemo(() => {
    if (!isSearching) return SETTINGS_NAV_ITEMS;
    return SETTINGS_NAV_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(normalizedSearch) ||
        item.keywords.some((kw) => kw.toLowerCase().includes(normalizedSearch)),
    );
  }, [isSearching, normalizedSearch]);

  const activeNavMeta =
    SETTINGS_NAV_ITEMS.find((item) => item.id === activeSection) ?? SETTINGS_NAV_ITEMS[0];

  const renderSectionBody = (sectionId: SettingsSectionId, embedded = false) => {
    switch (sectionId) {
      case "general":
        return (
          <GeneralSection
            draft={draft}
            setDraft={setDraft}
            consoleCfg={consoleCfg}
            setConsoleCfg={setConsoleCfg}
            tgWhitelistIds={tgWhitelistIds}
            tgProfiles={tgProfiles}
            loadingTgProfiles={loadingTgProfiles}
            loadTgProfiles={loadTgProfiles}
            newTgIdInput={newTgIdInput}
            setNewTgIdInput={setNewTgIdInput}
            handleAddTgWhitelistIds={handleAddTgWhitelistIds}
            handleRemoveTgWhitelistId={handleRemoveTgWhitelistId}
            theme={theme}
            setTheme={setTheme}
          />
        );

      case "gateway":
        return <GatewaySection draft={draft} setDraft={setDraft} retryCfg={retryCfg} />;

      case "worker":
        return (
          <WorkerSection
            draft={draft}
            setDraft={setDraft}
            extCliCfg={extCliCfg}
            setExtCliCfg={setExtCliCfg}
            setVmConfirmOpen={setVmConfirmOpen}
            applyAllNoApprovalPreset={applyAllNoApprovalPreset}
            envRows={envRows}
            updateEnvRows={updateEnvRows}
            cliProbes={cliProbes}
            probingClis={probingClis}
            loadCliProbes={loadCliProbes}
            setDiagCopied={setDiagCopied}
            setDiagBackend={setDiagBackend}
            setBackendOptionOverride={setBackendOptionOverride}
            readEnumOverrideValue={readEnumOverrideValue}
            loadingModelsByBackend={loadingModelsByBackend}
            refreshBackendModels={refreshBackendModels}
            patchBackendConfig={patchBackendConfig}
          />
        );

      case "proxy":
        return (
          <ProxySection
            proxies={proxies}
            proxyIds={proxyIds}
            lastProxyUrls={lastProxyUrls}
            setLastProxyUrls={setLastProxyUrls}
            addProxyRule={addProxyRule}
            updateProxyRule={updateProxyRule}
            removeProxyRule={removeProxyRule}
          />
        );

      case "browser":
        return <BrowserSection browserCfg={browserCfg} setBrowserCfg={setBrowserCfg} />;

      case "search":
        return (
          <SearchSection
            searchCfg={searchCfg}
            setSearchCfg={setSearchCfg}
            webLimits={{
              max_tool_calls_per_turn: draft.web?.max_tool_calls_per_turn,
              max_consecutive_failures: draft.web?.max_consecutive_failures,
            }}
            setWebLimits={(patch) =>
              setDraft((prev) => ({
                ...prev,
                web: {
                  ...prev.web,
                  ...patch,
                },
              }))
            }
          />
        );

      case "secrets":
        return (
          <SecretsAndProbePanel
            embedded={embedded}
            secretStates={secretStates}
            onToast={onToast}
            onSecretsUpdated={onSecretsUpdated}
          />
        );
    }
  };

  const renderSaveActions = (showSaveWhenClean: boolean) => {
    if (!isDirty && !showSaveWhenClean) return null;
    return (
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
            还原更改
          </Button>
        )}
        <StatefulButton
          type="button"
          size="sm"
          variant={isDirty || saveState !== "idle" ? undefined : "secondary"}
          disabled={!isDirty && saveState === "idle"}
          state={saveState}
          loadingText="保存中…"
          successText="已保存"
          errorText="保存失败"
          icon={<Save className="size-3.5" />}
          onClick={() => void handleSave()}
        >
          {isDirty ? "保存设置" : "已保存"}
        </StatefulButton>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background md:flex-row">
      {/* Left Settings Sidebar (replaces outer app sidebar while in Settings) */}
      <motion.aside
        initial={reduceMotion ? false : { x: -12, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }}
        className="flex w-full shrink-0 flex-col border-b border-border/80 bg-muted/20 md:w-56 md:border-r md:border-b-0"
      >
        <div className="flex flex-col gap-3 px-3 pt-3.5 pb-3">
          {onBack ? (
            <button
              type="button"
              onClick={handleBack}
              className="flex h-7 w-fit items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              <span>返回控制台</span>
            </button>
          ) : null}
          <div className="flex items-center justify-between px-1">
            <h2 className="text-base font-semibold tracking-tight text-foreground">设置</h2>
            {isDirty && (
              <AnimatedBadge status="warning" size="sm">
                未保存
              </AnimatedBadge>
            )}
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && searchQuery) {
                  e.preventDefault();
                  setSearchQuery("");
                }
              }}
              placeholder="搜索"
              aria-label="搜索设置"
              className="h-8 w-full rounded-lg border border-border/80 bg-background/80 pr-7 pl-8 text-xs text-foreground transition-colors placeholder:text-muted-foreground focus:border-ring focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setSearchQuery("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        <nav className="flex flex-1 flex-wrap gap-1 px-2.5 pb-3 md:flex-col md:flex-nowrap md:overflow-y-auto md:pb-5">
          {matchingNavItems.length === 0 ? (
            <div className="px-2.5 py-4 text-xs text-muted-foreground">无匹配设置分类</div>
          ) : (
            SETTINGS_GROUPS.map((group) => {
              const items = matchingNavItems.filter((item) => item.group === group.id);
              if (items.length === 0) return null;
              return (
                <div
                  key={group.id}
                  className="flex flex-wrap items-center gap-1 md:mb-3 md:flex-col md:flex-nowrap md:items-stretch md:gap-0.5"
                >
                  <div className="hidden px-2.5 py-1 text-[11px] font-medium text-muted-foreground/85 md:block">
                    {group.label}
                  </div>
                  {items.map((item) => {
                    const Icon = item.icon;
                    const isActive = !isSearching && activeSection === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setSearchQuery("");
                          onSectionChange(item.id);
                        }}
                        className={cn(
                          "relative flex h-8 shrink-0 items-center gap-2.5 overflow-hidden rounded-lg px-2.5 text-left text-xs transition-colors",
                          isActive
                            ? "font-medium text-foreground"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        )}
                      >
                        {isActive && (
                          <motion.span
                            layoutId="settings-nav-pill"
                            transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
                            className="absolute inset-0 rounded-lg bg-muted shadow-2xs"
                          />
                        )}
                        <Icon
                          className={cn(
                            "relative z-10 size-3.5 shrink-0",
                            isActive ? "text-foreground" : "",
                          )}
                        />
                        <span className="relative z-10 truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </nav>
      </motion.aside>

      {/* Right Settings Content Pane */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-7 px-5 py-7 sm:px-8">
          {isSearching ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold tracking-tight text-foreground">
                    搜索结果
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    匹配「{searchQuery.trim()}」的设置分组（{matchingNavItems.length}）
                  </p>
                </div>
                {renderSaveActions(false)}
              </div>

              {matchingNavItems.length === 0 ? (
                <div className="rounded-xl border border-border/80 bg-card/60 px-6 py-12 text-center text-xs text-muted-foreground">
                  未找到包含「{searchQuery.trim()}」的设置项。
                </div>
              ) : (
                <div className="flex flex-col gap-9">
                  {matchingNavItems.map((item) => (
                    <div key={item.id} className="flex flex-col gap-4">
                      <div className="flex items-center justify-between border-b border-border/70 pb-2">
                        <div className="flex items-center gap-2">
                          <item.icon className="size-4 text-muted-foreground" />
                          <h3 className="text-sm font-semibold text-foreground">{item.label}</h3>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery("");
                            onSectionChange(item.id);
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                        >
                          <span>定位到此页</span>
                          <ArrowUpRight className="size-3.5" />
                        </button>
                      </div>
                      {renderSectionBody(item.id, true)}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activeSection}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -4, transition: { duration: 0.12, ease: EASE_OUT } }}
                transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
                className="flex flex-col gap-7"
              >
                {activeSection !== "secrets" && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h2 className="text-base font-semibold tracking-tight text-foreground">
                        {activeNavMeta.label}
                      </h2>
                      {isDirty && (
                        <AnimatedBadge status="warning" size="sm">
                          有未保存更改
                        </AnimatedBadge>
                      )}
                    </div>
                    {renderSaveActions(true)}
                  </div>
                )}

                {renderSectionBody(activeSection)}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </div>

      {/* Paseo-style Diagnostics Modal */}
      <AnimatePresence>
        {diagProbe && (
          <motion.div
            key="cli-diagnostics-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: EASE_OUT }}
            onClick={() => setDiagBackend(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="cli-diagnostics-title"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97 }}
              transition={reduceMotion ? { duration: 0.1 } : SPRING_PANEL}
              onClick={(e) => e.stopPropagation()}
              className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-border/80 bg-background p-5 shadow-2xl"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <h3 id="cli-diagnostics-title" className="text-sm font-semibold text-foreground">
                    诊断
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {BACKEND_DISPLAY_NAMES[diagProbe.backend]}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void handleCopyDiagnostics()}
                    title="复制诊断信息"
                    aria-label="复制诊断信息"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {diagCopied ? (
                      <Check className="size-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={probingClis}
                    onClick={() => void loadCliProbes(true)}
                    title="刷新诊断"
                    aria-label="刷新诊断"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw className={`size-3.5 ${probingClis ? "animate-spin" : ""}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiagBackend(null)}
                    title="关闭"
                    aria-label="关闭诊断弹窗"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>

              <pre className="max-h-[60vh] overflow-y-auto rounded-xl border border-border/80 bg-muted/40 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/90 select-text">
                {formatDiagnosticsReport(diagProbe)}
              </pre>
            </motion.div>
          </motion.div>
        )}
        {vmConfirmOpen && (
          <motion.div
            key="vm-unrestricted-confirm-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: EASE_OUT }}
            onClick={() => setVmConfirmOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="vm-unrestricted-confirm-title"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97 }}
              transition={reduceMotion ? { duration: 0.1 } : SPRING_PANEL}
              onClick={(e) => e.stopPropagation()}
              className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border/80 bg-background p-5 shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3
                    id="vm-unrestricted-confirm-title"
                    className="text-sm font-semibold text-foreground"
                  >
                    确认启用「机器独占权」？
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setVmConfirmOpen(false)}
                  title="关闭"
                  aria-label="关闭确认弹窗"
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>

              <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3.5 text-xs leading-relaxed text-foreground">
                <p>启用该模式后，Hato 将会把机器占为所有...这里就是她家了！</p>
                <p className="mt-1 font-medium">她和她的worker将获得完全权限</p>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setVmConfirmOpen(false)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setDraft((prev) => ({
                      ...prev,
                      worker: {
                        ...prev.worker,
                        execution_mode: "vm_unrestricted",
                      },
                    }));
                    setVmConfirmOpen(false);
                  }}
                >
                  确认启用
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
