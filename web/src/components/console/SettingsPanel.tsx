import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  Compass,
  Copy,
  Cpu,
  Eye,
  FastForward,
  FilePenLine,
  FileText,
  Globe,
  Hand,
  KeyRound,
  Laptop,
  Layers,
  Monitor,
  Moon,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTheme } from "next-themes";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ExternalCliPermissionPreset,
  type ExternalCliProbeEntry,
  type HatoConfig,
  type ProxyRuleConfig,
  type SecretState,
  type TelegramUserProfile,
} from "@/api";
import {
  ConsoleInput,
  type ConsoleInputProps,
  ConsoleMultiSelect,
  ConsoleSelect,
} from "@/components/console/ConsolePrimitives";
import { SecretsAndProbePanel } from "@/components/console/SecretsAndProbePanel";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, StatefulButton, type ButtonState } from "@/components/motion/button";
import { Switch } from "@/components/motion/switch";
import { EASE_OUT, SPRING_LAYOUT, SPRING_PANEL } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type SettingsSectionId =
  | "general"
  | "gateway"
  | "worker"
  | "proxy"
  | "browser"
  | "search"
  | "secrets";

export const VALID_SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  "general",
  "gateway",
  "worker",
  "proxy",
  "browser",
  "search",
  "secrets",
]);

interface SettingsNavItem {
  id: SettingsSectionId;
  group: "basic" | "integrations";
  label: string;
  icon: typeof SlidersHorizontal;
  keywords: string[];
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    id: "general",
    group: "basic",
    label: "常规",
    icon: SlidersHorizontal,
    keywords: [
      "常规",
      "主人",
      "身份",
      "时区",
      "timezone",
      "白名单",
      "telegram",
      "主题",
      "外观",
      "深色",
      "浅色",
      "控制台",
      "host",
      "port",
      "端口",
      "令牌",
      "auth",
    ],
  },
  {
    id: "gateway",
    group: "basic",
    label: "消息网关",
    icon: Radio,
    keywords: [
      "消息网关",
      "gateway",
      "telegram",
      "qq",
      "openid",
      "app_id",
      "通道",
      "bot",
      "token",
      "api",
      "重连",
      "退避",
      "retry",
      "jitter",
    ],
  },
  {
    id: "worker",
    group: "basic",
    label: "Worker 与权限",
    icon: Shield,
    keywords: [
      "worker",
      "权限",
      "预设",
      "yolo",
      "无需审批",
      "sandbox",
      "沙箱",
      "codex-cli",
      "antigravity-cli",
      "opencode-v2",
      "external-pi",
      "claude-code",
      "builtin-pi",
      "复用本机配置",
      "mcp",
      "cli",
    ],
  },
  {
    id: "proxy",
    group: "basic",
    label: "网络与代理",
    icon: Globe,
    keywords: [
      "代理",
      "proxy",
      "网络",
      "直连",
      "分流",
      "作用域",
      "scope",
      "gateway",
      "llm-calling",
      "web_access",
      "browser",
    ],
  },
  {
    id: "browser",
    group: "integrations",
    label: "浏览器自动化",
    icon: Compass,
    keywords: [
      "浏览器",
      "browser",
      "chrome",
      "chromium",
      "xvfb",
      "虚拟屏幕",
      "数据目录",
      "profile",
      "步数",
      "回收",
    ],
  },
  {
    id: "search",
    group: "integrations",
    label: "联网搜索",
    icon: Search,
    keywords: ["联网搜索", "tavily", "search", "检索", "结果数", "api_key_env"],
  },
  {
    id: "secrets",
    group: "integrations",
    label: "密钥与自检",
    icon: KeyRound,
    keywords: ["密钥", "凭据", "secret", "环境变量", "自检", "探针", "probe", "连通性"],
  },
];

const SETTINGS_GROUPS: Array<{ id: "basic" | "integrations"; label: string }> = [
  { id: "basic", label: "基础与运行" },
  { id: "integrations", label: "能力与集成" },
];

const SCOPE_OPTIONS = [
  { value: "all", label: "all（全局默认）" },
  { value: "gateway", label: "gateway（消息网关）" },
  { value: "llm-calling", label: "llm-calling（模型接口）" },
  { value: "web_access", label: "web_access（搜索与抓取）" },
  { value: "browser", label: "browser（浏览器访问）" },
  { value: "memory", label: "memory（长期记忆）" },
  { value: "mcp", label: "mcp（远程 MCP 服务）" },
  { value: "worker", label: "worker（后台任务）" },
];

const WORKER_BACKEND_OPTIONS = [
  { value: "codex-cli", label: "Codex CLI", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "antigravity-cli", label: "Antigravity CLI", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "opencode-v2", label: "OpenCode V2", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "external-pi", label: "独立 Pi CLI", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "claude-code", label: "Claude Code", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "builtin-pi", label: "内置沙箱 Worker", icon: <Bot className="size-3.5 text-muted-foreground" /> },
];

const BACKEND_DISPLAY_NAMES: Record<ExternalCliProbeEntry["backend"], string> = {
  "codex-cli": "Codex CLI",
  "antigravity-cli": "Antigravity CLI",
  "opencode-v2": "OpenCode V2",
  "external-pi": "独立 Pi CLI",
  "claude-code": "Claude Code",
};

const PERMISSION_PRESET_OPTIONS = [
  { value: "auto_safe", label: "自动审批", icon: <ShieldCheck className="size-3.5 text-emerald-500" /> },
  { value: "yolo", label: "完全访问", icon: <ShieldAlert className="size-3.5 text-amber-500" /> },
  { value: "follow_host", label: "跟随本机", icon: <Laptop className="size-3.5 text-muted-foreground" /> },
  { value: "read_only", label: "只读模式", icon: <Eye className="size-3.5 text-sky-500" /> },
];

const FOLLOW_PRESET_VALUE = "__follow_preset__";

const BACKEND_CONFIG_KEYS: Record<
  ExternalCliProbeEntry["backend"],
  "codex_cli" | "antigravity_cli" | "opencode_v2" | "external_pi" | "claude_code"
> = {
  "codex-cli": "codex_cli",
  "antigravity-cli": "antigravity_cli",
  "opencode-v2": "opencode_v2",
  "external-pi": "external_pi",
  "claude-code": "claude_code",
};

const EXTERNAL_BACKEND_DEFAULT_ENABLED: Record<ExternalCliProbeEntry["backend"], boolean> = {
  "codex-cli": true,
  "antigravity-cli": true,
  "opencode-v2": true,
  "external-pi": false,
  "claude-code": false,
};

function isWorkerBackendEnabledInConfig(
  cfg: HatoConfig,
  backend: HatoConfig["worker"]["default_backend"],
): boolean {
  if (backend === "builtin-pi") return true;
  const key = BACKEND_CONFIG_KEYS[backend];
  const entry = cfg.worker.external_cli[key] as { enabled?: boolean } | undefined;
  return typeof entry?.enabled === "boolean"
    ? entry.enabled
    : EXTERNAL_BACKEND_DEFAULT_ENABLED[backend];
}

function listEnabledBackendOptions(cfg: HatoConfig) {
  return WORKER_BACKEND_OPTIONS.filter((opt) =>
    isWorkerBackendEnabledInConfig(cfg, opt.value as HatoConfig["worker"]["default_backend"]),
  );
}

function resolveEffectiveDefaultBackendInDraft(
  cfg: HatoConfig,
): HatoConfig["worker"]["default_backend"] {
  if (isWorkerBackendEnabledInConfig(cfg, cfg.worker.default_backend)) {
    return cfg.worker.default_backend;
  }
  const firstEnabled = listEnabledBackendOptions(cfg)[0];
  return (firstEnabled?.value ?? "builtin-pi") as HatoConfig["worker"]["default_backend"];
}

const HOST_SUMMARY_LABELS: Record<string, string> = {
  model: "Host model",
  model_provider: "Host provider",
  providers: "Providers",
  sandbox_mode: "Host sandbox",
  approval_policy: "Host approval",
  host_mcp_servers: "Host MCP servers",
  mode: "Host mode",
  sandbox: "Host terminal sandbox",
};

const CLI_CHOICE_LABELS: Record<string, string> = {
  "read-only": "只读模式",
  "workspace-write": "请求批准",
  "approve-for-me": "自动审批",
  "danger-full-access": "完全访问",
  bypass: "完全访问",
  host: "跟随本机",
  "accept-edits": "自动编辑",
  acceptEdits: "自动编辑",
  auto: "自动审批",
  ask: "请求批准",
  full_access: "完全访问",
  "skip-permissions": "完全访问",
  plan: "只读模式",
  default: "请求批准",
  dontAsk: "跳过询问",
  manual: "手动审批",
  bypassPermissions: "完全访问",
};

const CLI_CHOICE_ICONS: Record<string, ReactNode> = {
  "read-only": <Eye className="size-3.5 text-sky-500" />,
  plan: <Eye className="size-3.5 text-sky-500" />,
  "workspace-write": <Hand className="size-3.5 text-muted-foreground" />,
  ask: <Hand className="size-3.5 text-muted-foreground" />,
  default: <Hand className="size-3.5 text-muted-foreground" />,
  manual: <Hand className="size-3.5 text-muted-foreground" />,
  "accept-edits": <FilePenLine className="size-3.5 text-blue-500" />,
  acceptEdits: <FilePenLine className="size-3.5 text-blue-500" />,
  "approve-for-me": <ShieldCheck className="size-3.5 text-emerald-500" />,
  auto: <ShieldCheck className="size-3.5 text-emerald-500" />,
  "danger-full-access": <ShieldAlert className="size-3.5 text-amber-500" />,
  full_access: <ShieldAlert className="size-3.5 text-amber-500" />,
  bypass: <ShieldAlert className="size-3.5 text-amber-500" />,
  "skip-permissions": <ShieldAlert className="size-3.5 text-amber-500" />,
  bypassPermissions: <ShieldAlert className="size-3.5 text-amber-500" />,
  host: <Laptop className="size-3.5 text-muted-foreground" />,
  dontAsk: <FastForward className="size-3.5 text-muted-foreground" />,
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

const THEME_OPTIONS = [
  { value: "system", label: "跟随系统", icon: <Monitor className="size-3.5 text-muted-foreground" /> },
  { value: "dark", label: "深色", icon: <Moon className="size-3.5 text-muted-foreground" /> },
  { value: "light", label: "浅色", icon: <Sun className="size-3.5 text-muted-foreground" /> },
];

const AVATAR_TONES = [
  "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/25",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/25",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/25",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/25",
  "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/25",
];

function getAvatarTone(idStr: string): string {
  let hash = 0;
  for (let i = 0; i < idStr.length; i += 1) {
    hash = (hash * 31 + idStr.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function getAvatarInitials(idStr: string, displayName?: string): string {
  const cleanName = displayName?.replace(/^@/, "").trim();
  if (cleanName) {
    return Array.from(cleanName)[0]?.toUpperCase() ?? "TG";
  }
  return idStr.length >= 2 ? idStr.slice(-2) : idStr || "TG";
}

function formatDiagnosticsReport(probe: ExternalCliProbeEntry): string {
  const title =
    probe.backend === "external-pi" ? "Pi CLI" : BACKEND_DISPLAY_NAMES[probe.backend];
  const lines: string[] = [
    title,
    `  Command source: ${probe.commandSource ?? "default"}`,
    `  Configured command: ${probe.command}`,
    `  Resolved path: ${probe.resolvedPath ?? (probe.installed ? probe.command : "not found")}`,
    `  Version: ${probe.version ?? "unknown"}`,
    `  Status: ${probe.available ? "Ready" : probe.installed ? "Incompatible" : "Not installed"}`,
  ];
  if (probe.reason) {
    lines.push(`  Reason: ${probe.reason}`);
  }
  if (probe.hostConfigPath) {
    lines.push(`  Host config: ${probe.hostConfigPath}`);
  }
  for (const [key, value] of Object.entries(probe.hostSummary)) {
    const label = HOST_SUMMARY_LABELS[key] ?? key;
    const formatted = Array.isArray(value) ? value.join(", ") : String(value);
    lines.push(`  ${label}: ${formatted}`);
  }
  lines.push(
    `  Effective args: ${
      probe.effectiveArgsPreview.length > 0
        ? `${probe.command} ${probe.effectiveArgsPreview.join(" ")}`
        : `${probe.command} (host default)`
    }`,
  );
  lines.push(`  Probed at: ${new Date(probe.probedAtMs).toISOString()}`);
  return lines.join("\n");
}

function SettingsCardGroup({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <motion.section layout className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className="divide-y divide-border/70 rounded-xl border border-border/80 bg-card/60">
        {children}
      </div>
    </motion.section>
  );
}

function SettingsRow({
  title,
  description,
  children,
  alignTop = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:justify-between sm:gap-6",
        alignTop ? "sm:items-start" : "sm:items-center",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0 sm:flex sm:justify-end">{children}</div>
    </div>
  );
}

export interface SettingsPanelProps {
  initialConfig: HatoConfig;
  secretStates: SecretState[];
  activeSection: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  onBack?: () => void;
  onSavedConfig: (next: HatoConfig, changes?: string[]) => void;
  onSecretsUpdated: (nextStates: SecretState[], changes?: string[]) => void;
  onToast: (input: {
    title: string;
    description?: string;
    status?: "info" | "success" | "error";
  }) => void;
}

let nextProxyIdCounter = 0;
function makeProxyId(): string {
  nextProxyIdCounter += 1;
  return `proxy-${nextProxyIdCounter}`;
}

function NumericConsoleInput({
  value,
  fallback,
  min,
  onCommit,
  onBlur,
  onFocus,
  ...props
}: Omit<ConsoleInputProps, "value" | "onChange" | "type"> & {
  value: number;
  fallback: number;
  min?: number;
  onCommit: (next: number) => void;
}) {
  const [text, setText] = useState(() => String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(String(value));
    }
  }, [value]);

  return (
    <ConsoleInput
      {...props}
      type="number"
      value={text}
      onFocus={(e) => {
        focusedRef.current = true;
        onFocus?.(e);
      }}
      onChange={(v) => {
        setText(v);
        const trimmed = v.trim();
        if (trimmed === "") return;
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) return;
        if (min !== undefined && parsed < min) return;
        onCommit(parsed);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        const trimmed = text.trim();
        const parsed = trimmed === "" ? NaN : Number(trimmed);
        const committed =
          !Number.isFinite(parsed) || (min !== undefined && parsed < min) ? fallback : parsed;
        setText(String(committed));
        onCommit(committed);
        onBlur?.(e);
      }}
    />
  );
}

function envRecordToRows(
  env?: Record<string, string>,
): Array<{ id: string; key: string; value: string }> {
  if (!env) return [];
  return Object.entries(env).map(([key, value], idx) => ({
    id: `env-${idx}-${key}`,
    key,
    value,
  }));
}

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
                    placeholder="输入 Telegram 用户 ID（如 123456789，支持逗号批量添加）"
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
                        ) : (
                          <div
                            className={cn(
                              "grid size-9 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                              tone,
                            )}
                          >
                            {initials}
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
                description="关闭后将停止本地管理界面服务"
              >
                <Switch
                  ariaLabel="启用 Web 控制台"
                  checked={consoleCfg.enabled}
                  onCheckedChange={(on) => setConsoleCfg({ enabled: on })}
                />
              </SettingsRow>
              <SettingsRow title="监听地址" description="默认仅本机可访问，公网暴露建议配合访问令牌">
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

      case "gateway":
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

      case "worker": {
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
                  aria-label="机器独占权"
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
                title="完全访问"
                description="无需批准即可编辑文件并运行可访问网络的命令，将清除各后端单独设置"
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={applyAllNoApprovalPreset}
                >
                  <ShieldAlert className="size-3.5 text-amber-500" />
                  设为完全访问
                </Button>
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

      case "proxy":
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
                    <div key={ruleId} className="flex flex-col gap-3 px-4 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="grid flex-1 gap-3 sm:grid-cols-2">
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

                      <div className="grid gap-3 pr-11 sm:grid-cols-12">
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
                  );
                })
              )}
            </SettingsCardGroup>
          </div>
        );

      case "browser":
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

      case "search":
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
          state={saveState}
          loadingText="保存中…"
          successText="已保存"
          errorText="保存失败"
          icon={<Save className="size-3.5" />}
          onClick={() => void handleSave()}
        >
          保存设置
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

        <nav className="flex flex-1 gap-1 overflow-x-auto px-2.5 pb-3 md:flex-col md:overflow-y-auto md:pb-5">
          {matchingNavItems.length === 0 ? (
            <div className="px-2.5 py-4 text-xs text-muted-foreground">无匹配设置分类</div>
          ) : (
            SETTINGS_GROUPS.map((group) => {
              const items = matchingNavItems.filter((item) => item.group === group.id);
              if (items.length === 0) return null;
              return (
                <div
                  key={group.id}
                  className="flex shrink-0 items-center gap-1 md:mb-3 md:flex-col md:items-stretch md:gap-0.5"
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
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}
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
