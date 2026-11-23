import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import type { KnownApi } from "@earendil-works/pi-ai";
import {
  loadHatoConfig,
  resolveTavilySearchConfig,
  type HatoConfig,
  type ProxyRuleConfig,
} from "../config/app.js";
import {
  deriveApiKeyEnvFromSlug,
  KNOWN_APIS,
  loadModelsFileConfig,
  MODEL_SLOTS,
  ModelRegistry,
  PROVIDER_SLUG_PATTERN,
  type ModelsFileConfig,
  type ModelSlot,
} from "../config/models.js";
import { ScopedProxyRouter } from "../config/proxy.js";
import { mergeEnvFile, readEnvMap, writeHatoConfig, writeModelsConfig } from "../config/store.js";
import { API_PROTOCOL_DESCRIPTIONS, createDefaultHatoConfig, PROVIDER_PRESETS } from "./presets.js";
import { probeModelSlot, probeTavilySearch, probeTelegramGateway } from "./probe.js";
import {
  buildTimezoneMenu,
  getSystemTimezone,
  listAllTimezoneOptions,
  MORE_TIMEZONES_VALUE,
} from "./timezone.js";

export interface SetupPaths {
  hatoConfigPath: string;
  modelsConfigPath: string;
  envPath: string;
}

export const DEFAULT_SETUP_PATHS: SetupPaths = {
  hatoConfigPath: "config/hato.toml",
  modelsConfigPath: "config/models.toml",
  envPath: ".env",
};

type ProviderTable = ModelsFileConfig["providers"][string];
type ModelEntry = ProviderTable["models"][number];

const SLOT_DESCRIPTIONS: Record<ModelSlot, string> = {
  persona: "persona（主对话陪聊与微工具）",
  router: "router（轻路由、工单区间划定与追问判定）",
  curator: "curator（上下文压缩与异步记忆提炼）",
  worker: "worker（工程执行与写脚本）",
  hindsight_llm: "hindsight_llm（记忆抽取与反思）",
  vision: "vision（图像理解与表情包打标，未配则回退 persona）",
};

function guardCancel<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("已取消配置，未写入任何改动。");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

function maskSecretPreview(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return "*".repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function isValidHttpOrHttpsUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidProxyTarget(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "direct") return true;
  try {
    const parsed = new URL(trimmed);
    return /^(?:http|https|socks4|socks4a|socks5|socks5h):$/i.test(parsed.protocol);
  } catch {
    return false;
  }
}

function validateHhMm(raw: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return "请使用 HH:MM 格式";
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return "小时须在 0-23 之间，分钟须在 0-59 之间";
  }
  return undefined;
}

async function promptText(opts: {
  message: string;
  placeholder?: string;
  initialValue?: string;
  defaultValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  const res = guardCancel(
    await p.text({
      message: opts.message,
      placeholder: opts.placeholder ?? opts.defaultValue,
      initialValue: opts.initialValue,
      defaultValue: opts.defaultValue,
      validate: (val) => {
        const raw = val ?? "";
        if (opts.defaultValue !== undefined && !raw.trim()) {
          return undefined;
        }
        return opts.validate ? opts.validate(raw) : undefined;
      },
    }),
  );
  return (res ?? "").trim() || opts.defaultValue || "";
}

async function promptSecretForEnv(
  envName: string,
  label: string,
  existingEnv: Record<string, string>,
): Promise<string | undefined> {
  const existing = existingEnv[envName]?.trim();
  const hint = existing
    ? `当前 .env 已存在（${maskSecretPreview(existing)}），直接回车保留原值`
    : "将写入 .env；若暂不填写可直接回车跳过";

  const entered = guardCancel(
    await p.password({
      message: `请输入 ${envName}（${label}）\n  ${hint}`,
    }),
  );

  const trimmed = (entered ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

async function confirmTomlOverwriteIfNeeded(pathsToCheck: string[]): Promise<boolean> {
  const existing = pathsToCheck.filter((filePath) => existsSync(filePath));
  if (existing.length === 0) return true;

  const ok = guardCancel(
    await p.confirm({
      message: `检测到已有配置文件：${existing.join("、")}。继续保存将先自动备份为 .bak 再写入，确认继续吗？`,
      initialValue: true,
    }),
  );
  if (!ok) {
    p.cancel("已保留原有配置，未做任何写入。");
    return false;
  }
  return true;
}

function suggestProtocolBaseUrl(baseUrl: string, targetApi: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (!clean) return baseUrl;
  const root = clean.replace(/\/v1(?:beta\d*)?$/, "");

  if (targetApi === "google-generative-ai") {
    return `${root}/v1beta`;
  }
  if (targetApi === "anthropic-messages") {
    return root;
  }
  if (
    targetApi === "openai-completions" ||
    targetApi === "openai-responses" ||
    targetApi === "mistral-conversations"
  ) {
    return `${root}/v1`;
  }
  return baseUrl;
}

function collectPrefixedTargets(providers: Record<string, ProviderTable>): string[] {
  const targets: string[] = [];
  for (const [key, provider] of Object.entries(providers)) {
    const slug = (provider.slug ?? key).trim();
    for (const model of provider.models) {
      targets.push(`${slug}/${model.id}`);
    }
  }
  return targets;
}

async function promptOwnerAndTelegramStep(
  baseConfig: HatoConfig,
  existingEnv: Record<string, string>,
  envUpdates: Record<string, string | undefined>,
): Promise<HatoConfig> {
  p.log.step("第 1/4 步 · 主人档案、作息与 Telegram 网关");

  const defaultOwnerId = baseConfig.owner.canonical_user_id || "owner";
  const canonicalUserId = await promptText({
    message: `本地内部用户 ID（用于统一跨渠道的对话与记忆，默认 "${defaultOwnerId}"）`,
    placeholder: defaultOwnerId,
    defaultValue: defaultOwnerId,
    validate: (v) => (!v.trim() ? "不能为空" : undefined),
  });

  const systemTz = getSystemTimezone();
  const tzMenu = buildTimezoneMenu({
    systemTimezone: systemTz,
    currentConfiguredTimezone: baseConfig.owner.timezone,
  });

  const tzChoice = guardCancel(
    await p.select({
      message: "所在时区（owner.timezone，用于时间卡与日期计算）",
      initialValue: tzMenu.initialValue,
      options: tzMenu.options,
    }),
  );

  const timezone =
    tzChoice === MORE_TIMEZONES_VALUE
      ? guardCancel(
          await p.autocomplete({
            message: "搜索并选择时区（按城市/地区或 UTC 偏移过滤）",
            placeholder: "输入关键词搜索...",
            maxItems: 10,
            initialValue: systemTz,
            options: listAllTimezoneOptions(),
          }),
        )
      : tzChoice;

  const hasExistingQuietHours =
    baseConfig.owner.quiet_hours.start !== baseConfig.owner.quiet_hours.end;
  const enableQuietHours = guardCancel(
    await p.confirm({
      message: "是否设置免打扰时段？（该时段内避免主动推送消息）",
      initialValue: hasExistingQuietHours,
    }),
  );

  let quietStart = "00:00";
  let quietEnd = "00:00";
  if (enableQuietHours) {
    quietStart = await promptText({
      message: "免打扰开始时间（HH:MM）",
      ...(hasExistingQuietHours
        ? {
            placeholder: baseConfig.owner.quiet_hours.start,
            defaultValue: baseConfig.owner.quiet_hours.start,
          }
        : { placeholder: "HH:MM" }),
      validate: validateHhMm,
    });

    quietEnd = await promptText({
      message: "免打扰结束时间（HH:MM）",
      ...(hasExistingQuietHours
        ? {
            placeholder: baseConfig.owner.quiet_hours.end,
            defaultValue: baseConfig.owner.quiet_hours.end,
          }
        : { placeholder: "HH:MM" }),
      validate: validateHhMm,
    });
  }

  const tgEnabled = guardCancel(
    await p.confirm({
      message: "是否启用 Telegram 私聊网关？",
      initialValue: baseConfig.gateway.telegram.enabled,
    }),
  );

  let tgBaseUrl = baseConfig.gateway.telegram.base_url;
  const tgTokenEnv = baseConfig.gateway.telegram.bot_token_env;
  let tgUserIds: Array<number | string> = [...baseConfig.owner.channels.tg.user_ids];

  if (tgEnabled) {
    const token = await promptSecretForEnv(tgTokenEnv, "Telegram Bot Token", existingEnv);
    if (token !== undefined) {
      envUpdates[tgTokenEnv] = token;
    }

    const tgEndpointMode = guardCancel(
      await p.select({
        message: "Telegram Bot API 地址",
        initialValue: tgBaseUrl !== "https://api.telegram.org" ? "custom" : "official",
        options: [
          { value: "official", label: "官方端点 (https://api.telegram.org)" },
          { value: "custom", label: "自定义 / 反代端点" },
        ],
      }),
    );

    if (tgEndpointMode === "custom") {
      tgBaseUrl = await promptText({
        message: "输入 Telegram Bot API base_url",
        ...(tgBaseUrl !== "https://api.telegram.org"
          ? { initialValue: tgBaseUrl }
          : { placeholder: "https://..." }),
        validate: (v) => (!isValidHttpOrHttpsUrl(v.trim()) ? "请输入合法的 http:// 或 https:// 地址" : undefined),
      });
    } else {
      tgBaseUrl = "https://api.telegram.org";
    }

    const existingIdsText = tgUserIds.map(String).join(", ");
    const bindMode = guardCancel(
      await p.select({
        message: "主人 Telegram 账号绑定方式（仅白名单用户可交互）",
        initialValue: tgUserIds.length > 0 ? "manual" : "sethome",
        options: [
          {
            value: "sethome",
            label: "启动后通过 /sethome <配对码> 自动认领",
            hint: "首次启动会在终端生成一次性配对码，在私聊发送即可完成绑定",
          },
          {
            value: "manual",
            label: "现在手动填写 Telegram User ID",
            hint: existingIdsText ? `当前: ${existingIdsText}` : undefined,
          },
        ],
      }),
    );

    if (bindMode === "manual") {
      const rawIds = await promptText({
        message: "输入允许私聊的主人 Telegram User ID（多个逗号分隔，留空则改用 /sethome 配对）",
        ...(existingIdsText ? { initialValue: existingIdsText } : { placeholder: "数字 User ID" }),
        validate: (v) => {
          const trimmed = v.trim();
          if (!trimmed) return undefined;
          const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
          for (const part of parts) {
            if (!/^\d+$/.test(part)) return `无效数字 ID: "${part}"`;
          }
          return undefined;
        },
      });
      tgUserIds = rawIds
        ? rawIds
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => Number(s))
        : [];
    } else {
      tgUserIds = [];
    }
  }

  const baseSearchCfg = resolveTavilySearchConfig(baseConfig);
  const hasExistingTavilyKey = Boolean(existingEnv[baseSearchCfg.apiKeyEnv]?.trim());
  const enableTavily = guardCancel(
    await p.confirm({
      message: `是否启用联网搜索（Tavily · ${baseSearchCfg.apiKeyEnv}）？`,
      initialValue: baseConfig.web?.search?.enabled ?? hasExistingTavilyKey,
    }),
  );

  if (enableTavily) {
    const tavilyKey = await promptSecretForEnv(
      baseSearchCfg.apiKeyEnv,
      "Tavily API Key（用于 web_search 工具）",
      existingEnv,
    );
    if (tavilyKey !== undefined) {
      envUpdates[baseSearchCfg.apiKeyEnv] = tavilyKey;
    }
  }

  return {
    ...baseConfig,
    owner: {
      ...baseConfig.owner,
      canonical_user_id: canonicalUserId,
      timezone,
      proactive_channel: tgEnabled ? "tg" : "last_active",
      quiet_hours: {
        start: quietStart,
        end: quietEnd,
      },
      channels: {
        ...baseConfig.owner.channels,
        tg: {
          user_ids: tgUserIds,
        },
      },
    },
    web: {
      search: {
        provider: "tavily",
        enabled: enableTavily,
        api_key_env: baseSearchCfg.apiKeyEnv,
        base_url: baseSearchCfg.baseUrl,
        max_results: baseSearchCfg.maxResults,
        search_depth: baseSearchCfg.searchDepth,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      telegram: {
        ...baseConfig.gateway.telegram,
        enabled: tgEnabled,
        base_url: tgBaseUrl,
        bot_token_env: tgTokenEnv,
      },
    },
  };
}

async function promptSingleProxyRule(
  index: number,
  providerSlugs: string[],
): Promise<ProxyRuleConfig> {
  const scopeOptions: Array<{ value: string; label: string; hint?: string }> = [
    { value: "gateway", label: "gateway", hint: "聊天网关（Telegram / QQ）" },
    { value: "gateway.telegram", label: "gateway.telegram", hint: "仅 Telegram 网关" },
    { value: "gateway.qq", label: "gateway.qq", hint: "仅 QQ 网关" },
    { value: "llm-calling", label: "llm-calling", hint: "所有大模型请求" },
    ...providerSlugs.map((slug) => ({
      value: `llm-calling.${slug}`,
      label: `llm-calling.${slug}`,
      hint: `仅针对 Provider "${slug}"`,
    })),
    { value: "memory", label: "memory", hint: "记忆检索与云端向量服务" },
    { value: "web_access", label: "web_access", hint: "联网搜索与网页正文抓取（Tavily / web_fetch）" },
    { value: "browser", label: "browser", hint: "浏览器任务独立作用域（如指定专属代理或直连）" },
    { value: "worker", label: "worker", hint: "Worker 允许出网工单" },
    { value: "all", label: "all", hint: "全局兜底" },
  ];

  const selectedScopes = guardCancel(
    await p.multiselect({
      message: `规则 #${index + 1}：选择该代理生效的 Scope（空格勾选，回车确认）`,
      options: scopeOptions,
      initialValues: [],
      required: true,
    }),
  );

  const url = await promptText({
    message: `规则 #${index + 1}：输入上述 Scope 的代理 URL（或填 "direct" 显式直连）`,
    placeholder: "http://host:port | socks5://host:port | direct",
    validate: (v) =>
      !isValidProxyTarget(v) ? '请输入合法的 http(s)/socks5 URL 或 "direct"' : undefined,
  });

  const namePrefix = url.trim().toLowerCase() === "direct" ? "direct" : "proxy";
  return {
    name: `${namePrefix}-${index + 1}`,
    url,
    scope: [...new Set(selectedScopes)],
  };
}

async function promptScopedProxiesStep(
  existingRules: ProxyRuleConfig[],
  providerSlugs: string[],
): Promise<ProxyRuleConfig[]> {
  p.log.step("Scoped Proxy 网络代理配置");

  if (existingRules.length > 0) {
    const summary = existingRules.map((r) => `• ${r.name}: ${r.url} -> [${r.scope.join(", ")}]`).join("\n");
    p.note(summary, "当前已配置代理规则");
  }

  const mode = guardCancel(
    await p.select({
      message: "是否配置按 Scope 生效的网络代理？（匹配优先级：子 Scope > 父 Scope > all > 直连）",
      initialValue: existingRules.length > 0 ? "keep" : "direct",
      options: [
        ...(existingRules.length > 0
          ? [{ value: "keep", label: "保留当前代理规则不变" }]
          : []),
        { value: "direct", label: "无需代理（全部直连）" },
        { value: "configure", label: "配置代理规则（选择生效 Scope 与代理 URL）" },
      ],
    }),
  );

  if (mode === "keep") return existingRules;
  if (mode === "direct") return [];

  const rules: ProxyRuleConfig[] = [];
  let keepAdding = true;
  while (keepAdding) {
    const rule = await promptSingleProxyRule(rules.length, providerSlugs);
    rules.push(rule);
    keepAdding = guardCancel(
      await p.confirm({
        message: "继续添加另一条 Scope 代理规则？",
        initialValue: false,
      }),
    );
  }
  return rules;
}

async function promptSingleModel(
  providerSlug: string,
  defaultApi: KnownApi,
  defaultBaseUrl: string,
  existingIdsInProvider: Set<string>,
): Promise<ModelEntry> {
  const id = await promptText({
    message: `为 "${providerSlug}" 添加模型 ID`,
    placeholder: "输入模型 ID",
    validate: (v) => {
      const trimmed = v.trim();
      if (!trimmed || /\s/.test(trimmed)) return "模型 ID 不能为空且不能包含空格";
      if (existingIdsInProvider.has(trimmed)) {
        return `Provider "${providerSlug}" 下已存在模型 ID "${trimmed}"`;
      }
      return undefined;
    },
  });

  const name = await promptText({
    message: "模型展示名称",
    placeholder: id,
    defaultValue: id,
    validate: (v) => (!v.trim() ? "模型展示名称不能为空" : undefined),
  });

  const overrideApi = guardCancel(
    await p.confirm({
      message: `该模型是否沿用 "${providerSlug}" 的协议 (${defaultApi}) 与地址？`,
      initialValue: true,
    }),
  );

  let modelApi: string | undefined;
  let modelBaseUrl: string | undefined;
  if (!overrideApi) {
    modelApi = guardCancel(
      await p.select({
        message: `为模型 "${id}" 选择协议`,
        initialValue: defaultApi,
        options: KNOWN_APIS.map((api) => ({
          value: api,
          label: api,
          hint: API_PROTOCOL_DESCRIPTIONS[api],
        })),
      }),
    );
    const suggestedBaseUrl = suggestProtocolBaseUrl(defaultBaseUrl, modelApi);
    modelBaseUrl = await promptText({
      message: `模型 "${id}" 专用 base_url`,
      placeholder: suggestedBaseUrl,
      defaultValue: suggestedBaseUrl,
      validate: (v) => (!isValidHttpOrHttpsUrl(v.trim()) ? "请输入合法 URL" : undefined),
    });
  }

  const capabilities = guardCancel(
    await p.multiselect({
      message: `模型 "${id}" 能力标记（可选，直接回车跳过则为纯文本）`,
      initialValues: [],
      options: [
        { value: "reasoning", label: "支持推理 / Thinking", hint: "reasoning = true" },
        { value: "image", label: "支持图片多模态输入", hint: 'input = ["text", "image"]' },
      ],
      required: false,
    }),
  );

  const contextWindowStr = await promptText({
    message: "上下文窗口大小 (context_window)",
    placeholder: "128000",
    defaultValue: "128000",
    validate: (v) => (!/^\d+$/.test(v.trim()) || Number(v.trim()) < 1 ? "请输入正整数" : undefined),
  });

  const maxTokensStr = await promptText({
    message: "单轮最大输出 Token 数 (max_tokens)",
    placeholder: "8192",
    defaultValue: "8192",
    validate: (v) => (!/^\d+$/.test(v.trim()) || Number(v.trim()) < 1 ? "请输入正整数" : undefined),
  });

  return {
    id,
    name,
    ...(modelApi && modelApi !== defaultApi ? { api: modelApi } : {}),
    ...(modelBaseUrl && modelBaseUrl !== defaultBaseUrl ? { base_url: modelBaseUrl } : {}),
    reasoning: capabilities.includes("reasoning"),
    input: capabilities.includes("image") ? ["text", "image"] : ["text"],
    context_window: Number(contextWindowStr),
    max_tokens: Number(maxTokensStr),
  };
}

async function promptSingleProvider(params: {
  existingSlugs: Set<string>;
  existingEnv: Record<string, string>;
  envUpdates: Record<string, string | undefined>;
  allowUpdateExisting?: boolean;
}): Promise<{ slug: string; provider: ProviderTable }> {
  const presetId = guardCancel(
    await p.select({
      message: "选择 Provider 类型",
      options: PROVIDER_PRESETS.map((preset) => ({
        value: preset.id,
        label: preset.label,
        hint: preset.hint,
      })),
    }),
  );

  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId) ?? PROVIDER_PRESETS[0]!;
  const isCustomPreset = preset.id === "custom";

  const name = await promptText({
    message: "Provider 名称",
    ...(isCustomPreset
      ? { placeholder: "输入 Provider 名称" }
      : { placeholder: preset.defaultName, defaultValue: preset.defaultName }),
    validate: (v) => (!v.trim() ? "Provider 名称不能为空" : undefined),
  });

  const derivedSlug = preset.defaultSlug || name.trim().replace(/\s+/g, "-");
  const slugValidAsDefault = PROVIDER_SLUG_PATTERN.test(derivedSlug);
  const slug = await promptText({
    message: "Provider Slug（用于 `<slug>/<model_id>` 前缀与 `<SLUG>_API_KEY` 推导）",
    ...(slugValidAsDefault
      ? { placeholder: derivedSlug, defaultValue: derivedSlug }
      : { placeholder: "仅含字母、数字、点、下划线或连字符" }),
    validate: (v) => {
      const trimmed = v.trim();
      if (!PROVIDER_SLUG_PATTERN.test(trimmed)) {
        return 'Slug 只能包含字母、数字、点、下划线与连字符，不能含 "/" 或空格';
      }
      if (!params.allowUpdateExisting && params.existingSlugs.has(trimmed)) {
        return `Slug "${trimmed}" 已被其他 Provider 占用`;
      }
      return undefined;
    },
  });

  const derivedEnv = deriveApiKeyEnvFromSlug(slug);
  p.log.info(`已自动推导密钥环境变量名：${derivedEnv}`);

  const useCustomEnvName = guardCancel(
    await p.confirm({
      message: `默认将读取环境变量 ${derivedEnv}，是否改为其它环境变量名？`,
      initialValue: false,
    }),
  );

  const customEnvName = useCustomEnvName
    ? await promptText({
        message: "输入自定义 api_key_env 变量名",
        placeholder: derivedEnv,
        defaultValue: derivedEnv,
        validate: (v) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) ? "请输入合法的环境变量名" : undefined,
      })
    : undefined;

  const effectiveEnvName = customEnvName ?? derivedEnv;
  const secretVal = await promptSecretForEnv(effectiveEnvName, `Provider "${slug}"`, params.existingEnv);
  if (secretVal !== undefined) {
    params.envUpdates[effectiveEnvName] = secretVal;
  }

  const api = guardCancel(
    await p.select({
      message: `选择 "${slug}" 默认 API 协议`,
      ...(preset.defaultApi ? { initialValue: preset.defaultApi } : {}),
      options: KNOWN_APIS.map((item) => ({
        value: item,
        label: item,
        hint: API_PROTOCOL_DESCRIPTIONS[item],
      })),
    }),
  );

  const baseUrl = await promptText({
    message: `输入 "${slug}" 的 base_url`,
    ...(isCustomPreset
      ? { placeholder: "https://..." }
      : { placeholder: preset.defaultBaseUrl, defaultValue: preset.defaultBaseUrl }),
    validate: (v) => (!isValidHttpOrHttpsUrl(v.trim()) ? "请输入合法的 http:// 或 https:// 地址" : undefined),
  });

  const models: ModelEntry[] = [];
  const seenIds = new Set<string>();

  let addMoreModels = true;
  while (addMoreModels) {
    const added = await promptSingleModel(slug, api, baseUrl, seenIds);
    seenIds.add(added.id);
    models.push(added);
    addMoreModels = guardCancel(
      await p.confirm({
        message: `继续为 "${slug}" 添加下一个模型？`,
        initialValue: false,
      }),
    );
  }

  const provider: ProviderTable = {
    ...(name !== slug ? { name } : {}),
    ...(customEnvName ? { api_key_env: customEnvName } : {}),
    api,
    base_url: baseUrl,
    models,
  };

  return { slug, provider };
}

async function promptSlotsStep(
  providers: Record<string, ProviderTable>,
  initialSlots?: Partial<ModelsFileConfig["slots"]>,
): Promise<ModelsFileConfig["slots"]> {
  p.log.step("角色槽位绑定（所有槽位均强制携带 <provider_slug>/<model_id> 前缀）");

  const targets = collectPrefixedTargets(providers);
  if (targets.length === 0) {
    throw new Error("至少需要配置 1 个包含模型的 Provider 才能绑定角色槽位。");
  }

  const pickTarget = async (slot: ModelSlot, fallbackTarget: string): Promise<string> => {
    const initial =
      initialSlots?.[slot] && targets.includes(initialSlots[slot]!) ? initialSlots[slot]! : fallbackTarget;
    if (targets.length === 1) {
      p.log.info(`${SLOT_DESCRIPTIONS[slot]} -> ${targets[0]}`);
      return targets[0]!;
    }
    return guardCancel(
      await p.select({
        message: `为 ${SLOT_DESCRIPTIONS[slot]} 选择模型`,
        initialValue: initial,
        options: targets.map((t) => ({ value: t, label: t })),
      }),
    );
  };

  const persona = await pickTarget("persona", targets[0]!);

  const reuseAll =
    targets.length === 1 ||
    guardCancel(
      await p.confirm({
        message: `其余 4 个槽位（router / curator / worker / hindsight_llm）是否也设为 "${persona}"？`,
        initialValue: true,
      }),
    );

  if (reuseAll) {
    return {
      persona,
      router: persona,
      curator: persona,
      worker: persona,
      hindsight_llm: persona,
    };
  }

  return {
    persona,
    router: await pickTarget("router", persona),
    curator: await pickTarget("curator", persona),
    worker: await pickTarget("worker", persona),
    hindsight_llm: await pickTarget("hindsight_llm", persona),
  };
}

async function runConnectivityChecks(paths: SetupPaths): Promise<void> {
  const hatoConfig = loadHatoConfig(paths.hatoConfigPath);
  const envMap = readEnvMap(paths.envPath);
  const proxyRouter = new ScopedProxyRouter(hatoConfig.network?.proxies ?? []);
  const modelRegistry = new ModelRegistry(paths.modelsConfigPath);

  const spin = p.spinner();
  const reportLines: string[] = [];

  if (hatoConfig.gateway.telegram.enabled) {
    const botToken =
      envMap[hatoConfig.gateway.telegram.bot_token_env]?.trim() ||
      process.env[hatoConfig.gateway.telegram.bot_token_env]?.trim() ||
      "";
    spin.start(`正在通过 Scoped Proxy 探测 Telegram (${hatoConfig.gateway.telegram.base_url})...`);
    const tgRes = await probeTelegramGateway({
      baseUrl: hatoConfig.gateway.telegram.base_url,
      botToken,
      proxyRouter,
    });
    spin.stop(tgRes.ok ? "Telegram 连通性探测完成" : "Telegram 探测未通过");
    const proxyTag =
      tgRes.proxy.mode === "proxy" ? `proxy(${tgRes.proxy.url})` : `direct(${tgRes.proxy.matchedScope ?? "default"})`;
    reportLines.push(
      tgRes.ok
        ? `✓ Telegram Bot: @${tgRes.username ?? "?"} (${tgRes.latencyMs}ms · ${proxyTag})`
        : `✗ Telegram Bot: ${tgRes.error} (${proxyTag})`,
    );
  } else {
    reportLines.push("- Telegram Bot: 未启用，跳过");
  }

  const personaSlot = modelRegistry.resolveSlot("persona");
  spin.start(`正在通过 Scoped Proxy 探测主模型 ${personaSlot.target} (${personaSlot.model.api})...`);
  const llmRes = await probeModelSlot({
    slot: "persona",
    modelRegistry,
    proxyRouter,
    envOverrides: envMap,
  });
  spin.stop(llmRes.ok ? "主模型连通性探测完成" : "主模型探测未通过");
  const llmProxyTag =
    llmRes.proxy.mode === "proxy" ? `proxy(${llmRes.proxy.url})` : `direct(${llmRes.proxy.matchedScope ?? "default"})`;
  reportLines.push(
    llmRes.ok
      ? `✓ Persona (${llmRes.target}): "${llmRes.replyPreview}" (${llmRes.latencyMs}ms · in=${llmRes.inputTokens ?? 0}, out=${llmRes.outputTokens ?? 0} · ${llmProxyTag})`
      : `✗ Persona (${llmRes.target}): ${llmRes.error} (${llmProxyTag})`,
  );

  const searchCfg = resolveTavilySearchConfig(hatoConfig);
  const tavilyApiKey =
    envMap[searchCfg.apiKeyEnv]?.trim() || process.env[searchCfg.apiKeyEnv]?.trim() || "";
  if (searchCfg.enabled && tavilyApiKey) {
    spin.start(`正在通过 Scoped Proxy (web_access) 探测 Tavily (${searchCfg.baseUrl})...`);
    const tavilyRes = await probeTavilySearch({
      config: searchCfg,
      proxyRouter,
      apiKey: tavilyApiKey,
    });
    spin.stop(tavilyRes.ok ? "Tavily 连通性探测完成" : "Tavily 探测未通过");
    const webProxyTag =
      tavilyRes.proxy.mode === "proxy"
        ? `proxy(${tavilyRes.proxy.url})`
        : `direct(${tavilyRes.proxy.matchedScope ?? "default"})`;
    reportLines.push(
      tavilyRes.ok
        ? `✓ Tavily Search: 返回 ${tavilyRes.resultCount ?? 0} 条结果 (${tavilyRes.latencyMs}ms · ${webProxyTag})`
        : `✗ Tavily Search: ${tavilyRes.error} (${webProxyTag})`,
    );
  } else if (!searchCfg.enabled) {
    reportLines.push("- Tavily Search: 已禁用，跳过");
  } else {
    reportLines.push(`- Tavily Search: 未配置 ${searchCfg.apiKeyEnv}，跳过`);
  }

  p.note(reportLines.join("\n"), "连通性自检结果");
}

function validateModelsInMemory(modelsConfig: ModelsFileConfig): void {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-setup-verify-"));
  const probeFile = join(tempDir, "models.toml");
  try {
    writeModelsConfig(probeFile, modelsConfig, { backup: false });
    new ModelRegistry(probeFile);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function runInitWizard(paths: SetupPaths = DEFAULT_SETUP_PATHS): Promise<void> {
  const existingEnv = readEnvMap(paths.envPath);
  const envUpdates: Record<string, string | undefined> = {};

  const baseHato = existsSync(paths.hatoConfigPath)
    ? loadHatoConfig(paths.hatoConfigPath)
    : createDefaultHatoConfig();

  const nextHato = await promptOwnerAndTelegramStep(baseHato, existingEnv, envUpdates);

  p.log.step("第 2/4 步 · Provider 与多模型配置（按 <SLUG>_API_KEY 自动读取密钥）");
  const providers: Record<string, ProviderTable> = {};
  const existingSlugs = new Set<string>();

  let addMoreProviders = true;
  while (addMoreProviders) {
    const { slug, provider } = await promptSingleProvider({
      existingSlugs,
      existingEnv,
      envUpdates,
    });
    providers[slug] = provider;
    existingSlugs.add(slug);

    addMoreProviders = guardCancel(
      await p.confirm({
        message: "是否继续添加下一个 Provider？",
        initialValue: false,
      }),
    );
  }

  p.log.step("第 3/4 步 · Scoped Proxy 按域代理规则");
  const nextProxies = await promptScopedProxiesStep(
    baseHato.network?.proxies ?? [],
    [...existingSlugs],
  );
  nextHato.network = { proxies: nextProxies };

  p.log.step("第 4/4 步 · 5 角色模型槽位绑定");
  const nextSlots = await promptSlotsStep(providers);
  const nextModels: ModelsFileConfig = {
    slots: nextSlots,
    providers,
  };

  validateModelsInMemory(nextModels);

  const updateChannel = guardCancel(
    await p.select({
      message: "版本更新检查渠道（按渠道检查 GitHub Release）",
      initialValue: baseHato.updates?.channel ?? "stable",
      options: [
        { value: "stable", label: "stable（正式发行版，推荐）" },
        { value: "nightly", label: "nightly（每提交预览版）" },
      ],
    }),
  ) as "stable" | "nightly";

  const imNotifyEnabled = guardCancel(
    await p.confirm({
      message: "是否开启 IM 新版本推送通知？（默认关闭，开启后仅在发现新版本时向 Home Channel 提醒一次）",
      initialValue: baseHato.updates?.im_notify_enabled ?? false,
    }),
  );

  nextHato.updates = {
    check_enabled: baseHato.updates?.check_enabled ?? true,
    channel: updateChannel,
    im_notify_enabled: imNotifyEnabled,
    check_interval_hours: baseHato.updates?.check_interval_hours ?? 24,
  };

  if (!(await confirmTomlOverwriteIfNeeded([paths.hatoConfigPath, paths.modelsConfigPath]))) {
    return;
  }

  const hatoWrite = writeHatoConfig(paths.hatoConfigPath, nextHato, { backup: true });
  const modelsWrite = writeModelsConfig(paths.modelsConfigPath, nextModels, { backup: true });
  const envWrite = mergeEnvFile(paths.envPath, envUpdates);

  const summary = [
    `• 系统配置: ${hatoWrite.path}${hatoWrite.backupPath ? `（已备份 ${hatoWrite.backupPath}）` : ""}`,
    `• 模型配置: ${modelsWrite.path}${modelsWrite.backupPath ? `（已备份 ${modelsWrite.backupPath}）` : ""}`,
    `• 密钥文件: ${envWrite.path}（本次更新/写入 ${envWrite.writtenKeys.length} 项：${envWrite.writtenKeys.join(", ") || "沿用现有配置"}）`,
  ];
  if (nextHato.gateway.telegram.enabled && nextHato.owner.channels.tg.user_ids.length === 0) {
    summary.push("• TG 认领提示: 启动 `npm run dev` 后查看终端输出的 `/sethome HATO-XXXXXX`，在私聊发送给 Bot 即可绑定主人并设为 Home Channel。");
  }
  p.note(summary.join("\n"), "写入完成");

  const runProbe = guardCancel(
    await p.confirm({
      message: "是否立即执行一次 Scoped Proxy 连通性自检？（Telegram getMe + 主模型握手）",
      initialValue: true,
    }),
  );
  if (runProbe) {
    await runConnectivityChecks(paths);
  }
}

export async function runProviderAddWizard(paths: SetupPaths = DEFAULT_SETUP_PATHS): Promise<void> {
  if (!existsSync(paths.modelsConfigPath)) {
    p.log.warn(`未找到 ${paths.modelsConfigPath}，将直接进入完整初始化向导。`);
    await runInitWizard(paths);
    return;
  }

  const currentModels = loadModelsFileConfig(paths.modelsConfigPath);
  const existingEnv = readEnvMap(paths.envPath);
  const envUpdates: Record<string, string | undefined> = {};

  const existingSlugs = new Set(
    Object.entries(currentModels.providers).map(([key, val]) => (val.slug ?? key).trim()),
  );

  const { slug, provider } = await promptSingleProvider({
    existingSlugs,
    existingEnv,
    envUpdates,
    allowUpdateExisting: true,
  });

  // Remove any old key whose effective slug equals the updated slug so TOML stays normalized.
  const nextProviders: Record<string, ProviderTable> = {};
  for (const [k, v] of Object.entries(currentModels.providers)) {
    if ((v.slug ?? k).trim() === slug) continue;
    nextProviders[k] = v;
  }
  nextProviders[slug] = provider;

  const updateSlots = guardCancel(
    await p.confirm({
      message: "是否顺便调整某个角色槽位（slots）指向刚添加的模型？",
      initialValue: true,
    }),
  );

  const nextSlots = updateSlots
    ? await promptSlotsStep(nextProviders, currentModels.slots)
    : currentModels.slots;

  const nextModels: ModelsFileConfig = {
    slots: nextSlots,
    providers: nextProviders,
  };
  validateModelsInMemory(nextModels);

  if (!(await confirmTomlOverwriteIfNeeded([paths.modelsConfigPath]))) {
    return;
  }

  const written = writeModelsConfig(paths.modelsConfigPath, nextModels, { backup: true });
  const envWrite = mergeEnvFile(paths.envPath, envUpdates);
  p.note(
    [
      `• 模型配置已更新: ${written.path}${written.backupPath ? `（备份: ${written.backupPath}）` : ""}`,
      `• 环境变量: ${envWrite.path}（写入 ${envWrite.writtenKeys.join(", ") || "未改动"}）`,
      "• 若 Hato 正在运行，请在聊天中发送 `/reload` 热重载生效。",
    ].join("\n"),
    "Provider 更新成功",
  );
}

export async function runSlotsWizard(paths: SetupPaths = DEFAULT_SETUP_PATHS): Promise<void> {
  if (!existsSync(paths.modelsConfigPath)) {
    p.log.warn(`未找到 ${paths.modelsConfigPath}，请先运行初始化向导。`);
    return;
  }

  const currentModels = loadModelsFileConfig(paths.modelsConfigPath);
  const nextSlots = await promptSlotsStep(currentModels.providers, currentModels.slots);
  const nextModels: ModelsFileConfig = {
    ...currentModels,
    slots: nextSlots,
  };
  validateModelsInMemory(nextModels);

  if (!(await confirmTomlOverwriteIfNeeded([paths.modelsConfigPath]))) {
    return;
  }
  const written = writeModelsConfig(paths.modelsConfigPath, nextModels, { backup: true });
  p.note(
    `• 已保存角色槽位至 ${written.path}${written.backupPath ? `（备份: ${written.backupPath}）` : ""}\n• 运行中请发送 \`/reload\` 热重载。`,
    "槽位更新成功",
  );
}

export async function runProxyWizard(paths: SetupPaths = DEFAULT_SETUP_PATHS): Promise<void> {
  if (!existsSync(paths.hatoConfigPath)) {
    p.log.warn(`未找到 ${paths.hatoConfigPath}，请先运行初始化向导。`);
    return;
  }

  const currentHato = loadHatoConfig(paths.hatoConfigPath);
  const providerSlugs = existsSync(paths.modelsConfigPath)
    ? Object.entries(loadModelsFileConfig(paths.modelsConfigPath).providers).map(([k, v]) =>
        (v.slug ?? k).trim(),
      )
    : [];

  const nextProxies = await promptScopedProxiesStep(currentHato.network?.proxies ?? [], providerSlugs);
  const nextHato: HatoConfig = {
    ...currentHato,
    network: { proxies: nextProxies },
  };

  if (!(await confirmTomlOverwriteIfNeeded([paths.hatoConfigPath]))) {
    return;
  }
  const written = writeHatoConfig(paths.hatoConfigPath, nextHato, { backup: true });
  p.note(
    `• 代理规则已保存至 ${written.path}${written.backupPath ? `（备份: ${written.backupPath}）` : ""}\n• 运行中请发送 \`/reload\` 热重载。`,
    "Scoped Proxy 更新成功",
  );
}

export async function runCheckWizard(paths: SetupPaths = DEFAULT_SETUP_PATHS): Promise<void> {
  if (!existsSync(paths.hatoConfigPath) || !existsSync(paths.modelsConfigPath)) {
    p.log.error(
      `缺少配置文件（${paths.hatoConfigPath} 或 ${paths.modelsConfigPath}），请先执行 \`npm run setup\` 完成初始化。`,
    );
    return;
  }
  await runConnectivityChecks(paths);
}

export async function runSetupWizard(
  args: string[] = process.argv.slice(2),
  paths: SetupPaths = DEFAULT_SETUP_PATHS,
): Promise<void> {
  p.intro("Hato 交互式配置向导");

  const cmd = args[0]?.toLowerCase();
  const sub = args[1]?.toLowerCase();

  if (cmd === "init") {
    await runInitWizard(paths);
    p.outro("配置完成，运行 `npm run dev` 启动 Hato。");
    return;
  }
  if (cmd === "provider" && (sub === "add" || !sub)) {
    await runProviderAddWizard(paths);
    p.outro("完成。");
    return;
  }
  if (cmd === "slots") {
    await runSlotsWizard(paths);
    p.outro("完成。");
    return;
  }
  if (cmd === "proxy") {
    await runProxyWizard(paths);
    p.outro("完成。");
    return;
  }
  if (cmd === "check") {
    await runCheckWizard(paths);
    p.outro("自检结束。");
    return;
  }

  const hasExisting = existsSync(paths.hatoConfigPath) && existsSync(paths.modelsConfigPath);
  if (!hasExisting) {
    p.log.info("检测到尚未创建 config/hato.toml 或 config/models.toml，将引导完成首次初始化。");
    await runInitWizard(paths);
    p.outro("初始化完成！可运行 `npm run dev` 启动 Hato。");
    return;
  }

  const action = guardCancel(
    await p.select({
      message: "检测到现有配置，请选择要执行的操作",
      options: [
        { value: "provider-add", label: "新增 / 更新 Provider 与模型（写入 <SLUG>_API_KEY）" },
        { value: "slots", label: "调整 5 角色模型槽位分配 (slots)" },
        { value: "proxy", label: "修改 Scoped Proxy 按域代理规则" },
        { value: "check", label: "验证当前配置并测试 Telegram / 主模型连通性" },
        { value: "init", label: "重新走完整 4 步初始化（自动保留 .bak 备份与现有 .env 密钥）" },
        { value: "exit", label: "退出" },
      ],
    }),
  );

  switch (action) {
    case "provider-add":
      await runProviderAddWizard(paths);
      break;
    case "slots":
      await runSlotsWizard(paths);
      break;
    case "proxy":
      await runProxyWizard(paths);
      break;
    case "check":
      await runCheckWizard(paths);
      break;
    case "init":
      await runInitWizard(paths);
      break;
    default:
      break;
  }

  p.outro("已完成。");
}
