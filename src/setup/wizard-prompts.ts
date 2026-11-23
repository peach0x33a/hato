import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import type { ProxyRuleConfig } from "../config/app.js";
import type { ModelsFileConfig, ModelSlot } from "../config/models.js";

export type WizardMode = "quick" | "full";
export type WizardAction =
  | "menu"
  | "init"
  | "quick"
  | "full"
  | "provider-add"
  | "slots"
  | "proxy"
  | "check"
  | "help";

export type ProviderTable = ModelsFileConfig["providers"][string];
export type ModelEntry = ProviderTable["models"][number];

export const SLOT_DESCRIPTIONS: Record<ModelSlot, string> = {
  persona: "persona（主对话陪聊与微工具）",
  router: "router（轻路由、工单区间划定与追问判定）",
  curator: "curator（上下文压缩与异步记忆提炼）",
  worker: "worker（工程执行与写脚本）",
  hindsight_llm: "hindsight_llm（记忆抽取与反思）",
  vision: "vision（图像理解与表情包打标，未配则回退 persona）",
};

export function parseWizardCommand(args: string[]): WizardAction {
  const normalized = args.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const first = normalized[0];
  const second = normalized[1];

  if (!first) return "menu";
  if (first === "-h" || first === "--help" || first === "help") return "help";
  if (first === "quick" || first === "--quick") return "quick";
  if (first === "full" || first === "--full") return "full";
  if (first === "init") {
    if (second === "--quick" || second === "quick") return "quick";
    if (second === "--full" || second === "full") return "full";
    return "init";
  }
  if (first === "provider" && (second === "add" || !second)) return "provider-add";
  if (first === "slots") return "slots";
  if (first === "proxy") return "proxy";
  if (first === "check") return "check";
  return "menu";
}

export function formatSetupHelp(): string {
  return [
    "用法: hato setup [子命令]",
    "",
    "可用子命令:",
    "  (无参数)        进入交互式向导（首次自动选择简易/全量模式）",
    "  quick, --quick  简易模式：仅配置聊天平台、1 个主模型与基础功能，其余使用默认值（后续可在 WebUI 或对话中按需调整）",
    "  full, --full    全量模式：完整配置档案、网关、多模型/思考等级、代理、上下文、记忆、Web 与 Worker",
    "  init            选择简易或全量模式执行初始化",
    "  provider add    新增或更新 Provider 与模型",
    "  slots           调整 6 个角色模型槽位与思考等级",
    "  proxy           修改 Scoped Proxy 按域代理规则",
    "  check           验证当前配置并探测网关、主模型、联网搜索与记忆服务连通性",
    "  -h, --help      显示此帮助",
  ].join("\n");
}

export function buildQuickSlots(target: string): ModelsFileConfig["slots"] {
  return {
    persona: target,
    router: target,
    curator: target,
    worker: target,
    hindsight_llm: target,
  };
}

export function buildQuickProxyRules(proxyUrl: string): ProxyRuleConfig[] {
  const trimmed = proxyUrl.trim();
  if (!trimmed || trimmed.toLowerCase() === "direct") {
    return [];
  }
  return [
    {
      name: "proxy-1",
      url: trimmed,
      scope: ["gateway", "llm-calling", "web_access", "memory"],
    },
  ];
}

export function guardCancel<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("已取消配置，未写入任何改动。");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

export function maskSecretPreview(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function isValidHttpOrHttpsUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidProxyTarget(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase() === "direct") return true;
  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "socks5:", "socks5h:", "socks4:", "socks:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function validateHhMm(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!/^\d{1,2}:\d{2}$/.test(trimmed)) return "格式应为 HH:MM，例如 23:30";
  const [hStr, mStr] = trimmed.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (h < 0 || h > 23 || m < 0 || m > 59) return "小时需为 0-23，分钟需为 0-59";
  return undefined;
}

export function suggestProtocolBaseUrl(baseUrl: string, targetApi: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (targetApi === "anthropic-messages") {
    return clean.replace(/\/v1beta$/, "").replace(/\/v1$/, "");
  }
  if (targetApi === "google-generative-ai") {
    if (clean.endsWith("/v1beta")) return clean;
    return `${clean.replace(/\/v1$/, "")}/v1beta`;
  }
  if (targetApi === "openai-completions" || targetApi === "openai-responses") {
    if (clean.endsWith("/v1")) return clean;
    return `${clean.replace(/\/v1beta$/, "")}/v1`;
  }
  return baseUrl;
}

export function collectPrefixedTargets(providers: Record<string, ProviderTable>): string[] {
  const targets: string[] = [];
  for (const [key, provider] of Object.entries(providers)) {
    const slug = (provider.slug ?? key).trim();
    for (const model of provider.models) {
      targets.push(`${slug}/${model.id}`);
    }
  }
  return targets;
}

export async function promptText(opts: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  const raw = guardCancel(
    await p.text({
      message: opts.message,
      placeholder: opts.placeholder,
      defaultValue: opts.defaultValue,
      initialValue: opts.initialValue,
      validate: (value) => opts.validate?.(value ?? ""),
    }),
  );
  return String(raw).trim();
}

export async function promptNumber(opts: {
  message: string;
  defaultValue: number;
  min?: number;
  max?: number;
  integer?: boolean;
}): Promise<number> {
  const def = String(opts.defaultValue);
  const raw = await promptText({
    message: opts.message,
    placeholder: def,
    defaultValue: def,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "请输入数字";
      const num = Number(trimmed);
      if (!Number.isFinite(num)) return "请输入合法数字";
      if (opts.integer && !Number.isInteger(num)) return "请输入整数";
      if (opts.min !== undefined && num < opts.min) return `不能小于 ${opts.min}`;
      if (opts.max !== undefined && num > opts.max) return `不能大于 ${opts.max}`;
      return undefined;
    },
  });
  return Number(raw);
}

export async function promptSecretForEnv(
  envKey: string,
  purposeLabel: string,
  existingEnv: Record<string, string>,
): Promise<string | undefined> {
  const existing = existingEnv[envKey]?.trim();
  if (existing) {
    const keepExisting = guardCancel(
      await p.confirm({
        message: `检测到 .env 中已存在 ${envKey} (${maskSecretPreview(existing)})，是否沿用？`,
        initialValue: true,
      }),
    );
    if (keepExisting) {
      return undefined;
    }
  }

  const secret = guardCancel(
    await p.password({
      message: `请输入 ${purposeLabel} 密钥（将写入 .env 的 ${envKey}）`,
      validate: (value) => (!value || !value.trim() ? `${envKey} 不能为空` : undefined),
    }),
  );
  return secret.trim();
}

export async function confirmTomlOverwriteIfNeeded(pathsToCheck: string[]): Promise<boolean> {
  const existing = pathsToCheck.filter((filePath) => existsSync(filePath));
  if (existing.length === 0) return true;

  const confirm = guardCancel(
    await p.confirm({
      message: `以下配置文件已存在，写入前将自动生成 .bak 备份：${existing.join(", ")}。确认继续？`,
      initialValue: true,
    }),
  );
  return confirm;
}
