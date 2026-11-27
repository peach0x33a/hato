import {
  Compass,
  Globe,
  KeyRound,
  Radio,
  Search,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import type { ExternalCliProbeEntry, HatoConfig, SecretState } from "@/api";

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

export interface SettingsNavItem {
  id: SettingsSectionId;
  group: "basic" | "integrations";
  label: string;
  icon: typeof SlidersHorizontal;
  keywords: string[];
}

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
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
      "热区",
      "热区清空时机",
      "清空",
      "归档",
      "定时",
      "缓存",
      "clear_mode",
      "上下文压缩",
      "compaction_mode",
      "curator",
      "复用对话",
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
      "气泡",
      "bubbles",
      "max_per_turn",
      "分段",
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

export const SETTINGS_GROUPS: Array<{ id: "basic" | "integrations"; label: string }> = [
  { id: "basic", label: "基础与运行" },
  { id: "integrations", label: "能力与集成" },
];

export const SCOPE_OPTIONS = [
  { value: "all", label: "all（全局默认）" },
  { value: "gateway", label: "gateway（消息网关）" },
  { value: "llm-calling", label: "llm-calling（模型接口）" },
  { value: "web_access", label: "web_access（搜索与抓取）" },
  { value: "browser", label: "browser（浏览器访问）" },
  { value: "memory", label: "memory（长期记忆）" },
  { value: "mcp", label: "mcp（远程 MCP 服务）" },
  { value: "worker", label: "worker（后台任务）" },
  { value: "updates", label: "updates（版本更新检查）" },
];

export const BACKEND_DISPLAY_NAMES: Record<ExternalCliProbeEntry["backend"], string> = {
  "codex-cli": "Codex CLI",
  "antigravity-cli": "Antigravity CLI",
  "opencode-v2": "OpenCode V2",
  "external-pi": "独立 Pi CLI",
  "claude-code": "Claude Code",
};

export const FOLLOW_PRESET_VALUE = "__follow_preset__";

export const BACKEND_CONFIG_KEYS: Record<
  ExternalCliProbeEntry["backend"],
  "codex_cli" | "antigravity_cli" | "opencode_v2" | "external_pi" | "claude_code"
> = {
  "codex-cli": "codex_cli",
  "antigravity-cli": "antigravity_cli",
  "opencode-v2": "opencode_v2",
  "external-pi": "external_pi",
  "claude-code": "claude_code",
};

export const EXTERNAL_BACKEND_DEFAULT_ENABLED: Record<ExternalCliProbeEntry["backend"], boolean> = {
  "codex-cli": true,
  "antigravity-cli": true,
  "opencode-v2": true,
  "external-pi": false,
  "claude-code": false,
};

export function isWorkerBackendEnabledInConfig(
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

const WORKER_BACKEND_VALUES: HatoConfig["worker"]["default_backend"][] = [
  "codex-cli",
  "antigravity-cli",
  "opencode-v2",
  "external-pi",
  "claude-code",
  "builtin-pi",
];

export function resolveEffectiveDefaultBackendInDraft(
  cfg: HatoConfig,
): HatoConfig["worker"]["default_backend"] {
  if (isWorkerBackendEnabledInConfig(cfg, cfg.worker.default_backend)) {
    return cfg.worker.default_backend;
  }
  const firstEnabled = WORKER_BACKEND_VALUES.find((v) => isWorkerBackendEnabledInConfig(cfg, v));
  return firstEnabled ?? "builtin-pi";
}

export const HOST_SUMMARY_LABELS: Record<string, string> = {
  model: "Host model",
  model_provider: "Host provider",
  providers: "Providers",
  sandbox_mode: "Host sandbox",
  approval_policy: "Host approval",
  host_mcp_servers: "Host MCP servers",
  mode: "Host mode",
  sandbox: "Host terminal sandbox",
};

export const CLI_CHOICE_LABELS: Record<string, string> = {
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
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "Max",
  ultra: "Ultra",
};

export const MODE_OPTIONS = [
  { value: "proxy", label: "走代理" },
  { value: "direct", label: "直连" },
];

export const CHANNEL_OPTIONS = [
  { value: "chrome", label: "Google Chrome" },
  { value: "chromium", label: "Chromium" },
];

export const XVFB_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "true", label: "始终开启" },
  { value: "false", label: "禁用" },
];

export const AVATAR_TONES = [
  "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/25",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/25",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/25",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/25",
  "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/25",
];

export function getAvatarTone(idStr: string): string {
  let hash = 0;
  for (let i = 0; i < idStr.length; i += 1) {
    hash = (hash * 31 + idStr.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export function getAvatarInitials(idStr: string, displayName?: string): string {
  const cleanName = displayName?.replace(/^@/, "").trim();
  if (cleanName) {
    return Array.from(cleanName)[0]?.toUpperCase() ?? "TG";
  }
  return idStr.length >= 2 ? idStr.slice(-2) : idStr || "TG";
}

export function formatDiagnosticsReport(probe: ExternalCliProbeEntry): string {
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
export function makeProxyId(): string {
  nextProxyIdCounter += 1;
  return `proxy-${nextProxyIdCounter}`;
}

export function envRecordToRows(
  env?: Record<string, string>,
): Array<{ id: string; key: string; value: string }> {
  if (!env) return [];
  return Object.entries(env).map(([key, value], idx) => ({
    id: `env-${idx}-${key}`,
    key,
    value,
  }));
}
