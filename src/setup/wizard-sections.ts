import * as p from "@clack/prompts";
import type { KnownApi } from "@earendil-works/pi-ai";
import {
  resolveContextClearConfig,
  resolveContextCompactionMode,
  resolveEffectiveDefaultBackend,
  resolveHindsightConfig,
  resolveMemoryCuratorConfig,
  resolveMemoryEchoConfig,
  resolveMemoryProvider,
  resolveMemoryRecallConfig,
  resolvePromptOrder,
  resolveTavilySearchConfig,
  resolveUpdatesConfig,
  resolveWebBrowserConfig,
  resolveWebConsoleConfig,
  resolveWebFetchConfig,
  resolveWorkerExecutionMode,
  resolveWorkerVmWorkdir,
  type ExternalCliPermissionPreset,
  type HatoConfig,
  type ProxyRuleConfig,
} from "../config/app.js";
import {
  deriveApiKeyEnvFromSlug,
  KNOWN_APIS,
  MODEL_SLOTS,
  PROVIDER_SLUG_PATTERN,
  THINKING_LEVEL_OPTIONS,
  type ConfiguredThinkingLevel,
  type ModelsFileConfig,
  type ModelSlot,
} from "../config/models.js";
import { API_PROTOCOL_DESCRIPTIONS, PROVIDER_PRESETS } from "./presets.js";
import {
  buildQuickProxyRules,
  buildQuickSlots,
  collectPrefixedTargets,
  guardCancel,
  isValidHttpOrHttpsUrl,
  isValidProxyTarget,
  promptNumber,
  promptSecretForEnv,
  promptText,
  SLOT_DESCRIPTIONS,
  suggestProtocolBaseUrl,
  validateHhMm,
  type ModelEntry,
  type ProviderTable,
} from "./wizard-prompts.js";
import {
  buildTimezoneMenu,
  getSystemTimezone,
  listAllTimezoneOptions,
  MORE_TIMEZONES_VALUE,
} from "./timezone.js";

const INHERIT_PERSONA_VALUE = "__inherit_persona__";
const DEFAULT_THINKING_VALUE = "__default__";

// ============================================================================
// Quick Mode Sections (3 concise steps)
// ============================================================================

export async function promptQuickChannelsStep(
  baseConfig: HatoConfig,
  existingEnv: Record<string, string>,
  envUpdates: Record<string, string | undefined>,
): Promise<HatoConfig> {
  p.log.step("第 1/3 步 · 选择聊天平台");

  const defaultChannels: Array<"tg" | "qq"> = [];
  if (baseConfig.gateway.telegram.enabled) defaultChannels.push("tg");
  if (baseConfig.gateway.qq.enabled) defaultChannels.push("qq");
  if (defaultChannels.length === 0 && !baseConfig.gateway.qq.app_id) {
    defaultChannels.push("tg");
  }

  const selected = guardCancel(
    await p.multiselect({
      message: "启用哪些聊天平台？（空格勾选/取消，回车确认；不选则仅用 Web 控制台）",
      initialValues: defaultChannels,
      options: [
        { value: "tg", label: "Telegram 机器人", hint: "需要 TG_BOT_TOKEN，支持 /sethome 自动配对" },
        { value: "qq", label: "QQ 官方机器人", hint: "需要 App ID 与 QQ_BOT_SECRET，支持 /sethome 自动配对" },
      ],
      required: false,
    }),
  ) as Array<"tg" | "qq">;

  const tgEnabled = selected.includes("tg");
  const qqEnabled = selected.includes("qq");

  if (tgEnabled) {
    const tgTokenEnv = baseConfig.gateway.telegram.bot_token_env;
    const token = await promptSecretForEnv(tgTokenEnv, "Telegram Bot Token", existingEnv);
    if (token !== undefined) {
      envUpdates[tgTokenEnv] = token;
    }
  }

  let qqAppId = baseConfig.gateway.qq.app_id;
  if (qqEnabled) {
    qqAppId = await promptText({
      message: "请输入 QQ 机器人 App ID",
      ...(qqAppId ? { placeholder: qqAppId, defaultValue: qqAppId } : { placeholder: "例如 102000000" }),
      validate: (v) => (!v.trim() ? "QQ App ID 不能为空" : undefined),
    });
    const qqSecretEnv = baseConfig.gateway.qq.client_secret_env;
    const secret = await promptSecretForEnv(qqSecretEnv, "QQ 机器人 AppSecret", existingEnv);
    if (secret !== undefined) {
      envUpdates[qqSecretEnv] = secret;
    }
  }

  const proactiveChannel: "tg" | "qq" | "last_active" = tgEnabled
    ? "tg"
    : qqEnabled
      ? "qq"
      : "last_active";

  return {
    ...baseConfig,
    owner: {
      ...baseConfig.owner,
      timezone: baseConfig.owner.timezone || getSystemTimezone(),
      proactive_channel: proactiveChannel,
    },
    gateway: {
      ...baseConfig.gateway,
      telegram: {
        ...baseConfig.gateway.telegram,
        enabled: tgEnabled,
      },
      qq: {
        ...baseConfig.gateway.qq,
        enabled: qqEnabled,
        app_id: qqAppId,
      },
    },
  };
}

export async function promptQuickModelStep(
  existingModels: ModelsFileConfig | null,
  existingEnv: Record<string, string>,
  envUpdates: Record<string, string | undefined>,
): Promise<ModelsFileConfig> {
  p.log.step("第 2/3 步 · 配置主模型（自动绑定全部角色槽位）");

  if (existingModels && Object.keys(existingModels.providers).length > 0) {
    const keep = guardCancel(
      await p.select({
        message: `检测到已有模型配置（主对话: ${existingModels.slots.persona}），如何处理？`,
        initialValue: "keep",
        options: [
          { value: "keep", label: "保留现有模型与槽位配置不变" },
          { value: "replace", label: "重新配置一个主模型（自动绑定全部槽位）" },
        ],
      }),
    );
    if (keep === "keep") {
      return existingModels;
    }
  }

  const presetId = guardCancel(
    await p.select({
      message: "选择模型服务商 (Provider)",
      options: PROVIDER_PRESETS.map((preset) => ({
        value: preset.id,
        label: preset.label,
        hint: preset.hint,
      })),
    }),
  );

  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId) ?? PROVIDER_PRESETS[0]!;
  const isCustomPreset = preset.id === "custom";

  let name = preset.defaultName;
  let slug = preset.defaultSlug;
  let api: KnownApi = preset.defaultApi ?? "openai-completions";

  if (isCustomPreset) {
    name = await promptText({
      message: "Provider 名称",
      placeholder: "例如 OpenRouter",
      validate: (v) => (!v.trim() ? "Provider 名称不能为空" : undefined),
    });
    const derivedSlug = name.trim().toLowerCase().replace(/\s+/g, "-");
    const slugValid = PROVIDER_SLUG_PATTERN.test(derivedSlug);
    slug = await promptText({
      message: "Provider Slug（仅含字母、数字、点、下划线或连字符）",
      ...(slugValid ? { placeholder: derivedSlug, defaultValue: derivedSlug } : { placeholder: "my-provider" }),
      validate: (v) =>
        !PROVIDER_SLUG_PATTERN.test(v.trim())
          ? 'Slug 只能包含字母、数字、点、下划线与连字符，不能含 "/" 或空格'
          : undefined,
    });
    api = guardCancel(
      await p.select({
        message: `选择 "${slug}" API 协议`,
        initialValue: "openai-completions",
        options: KNOWN_APIS.map((item) => ({
          value: item,
          label: item,
          hint: API_PROTOCOL_DESCRIPTIONS[item],
        })),
      }),
    );
  }

  const envKey = deriveApiKeyEnvFromSlug(slug);
  const secret = await promptSecretForEnv(envKey, `Provider "${slug}"`, existingEnv);
  if (secret !== undefined) {
    envUpdates[envKey] = secret;
  }

  const baseUrl = await promptText({
    message: `API base_url（官方地址直接回车，中转站可粘贴替换）`,
    ...(isCustomPreset
      ? { placeholder: "https://..." }
      : { placeholder: preset.defaultBaseUrl, defaultValue: preset.defaultBaseUrl }),
    validate: (v) => (!isValidHttpOrHttpsUrl(v.trim()) ? "请输入合法的 http:// 或 https:// 地址" : undefined),
  });

  const modelId = await promptText({
    message: "主模型 ID（例如 gpt-5 / claude-sonnet-4-5 / gemini-2.5-pro / deepseek-chat）",
    placeholder: "输入模型 ID",
    validate: (v) => (!v.trim() || /\s/.test(v.trim()) ? "模型 ID 不能为空且不能包含空格" : undefined),
  });

  const capabilities = guardCancel(
    await p.multiselect({
      message: `模型 "${modelId}" 能力标记（可选，直接回车跳过则为纯文本）`,
      initialValues: [],
      options: [
        { value: "reasoning", label: "支持推理 / Thinking", hint: "reasoning = true" },
        { value: "image", label: "支持图片多模态输入", hint: 'input = ["text", "image"]' },
      ],
      required: false,
    }),
  ) as string[];

  const target = `${slug}/${modelId}`;
  return {
    slots: buildQuickSlots(target),
    providers: {
      [slug]: {
        ...(name !== slug ? { name } : {}),
        api,
        base_url: baseUrl,
        models: [
          {
            id: modelId,
            name: modelId,
            reasoning: capabilities.includes("reasoning"),
            input: capabilities.includes("image") ? ["text", "image"] : ["text"],
            context_window: 128000,
            max_tokens: 8192,
          },
        ],
      },
    },
  };
}

export async function promptQuickBasicFeaturesStep(
  baseConfig: HatoConfig,
  providerSlugs: string[],
  existingEnv: Record<string, string>,
  envUpdates: Record<string, string | undefined>,
): Promise<HatoConfig> {
  p.log.step("第 3/3 步 · 网络代理与基础功能");

  const existingProxies = baseConfig.network?.proxies ?? [];
  const proxyChoice = guardCancel(
    await p.select({
      message: "网络代理设置（国内直连中转站可选直连；访问官方/Telegram 可填 1 个代理）",
      initialValue: existingProxies.length > 0 ? "keep" : "direct",
      options: [
        ...(existingProxies.length > 0
          ? [{ value: "keep", label: `保留现有 ${existingProxies.length} 条代理规则` }]
          : []),
        { value: "direct", label: "无需代理（全部直连）" },
        { value: "single", label: "填写 1 个通用代理地址（用于网关 / 大模型 / 联网）" },
        { value: "advanced", label: "按域分别配置代理规则 (Scoped Proxy)" },
      ],
    }),
  );

  let nextProxies: ProxyRuleConfig[] = existingProxies;
  if (proxyChoice === "direct") {
    nextProxies = [];
  } else if (proxyChoice === "single") {
    const proxyUrl = await promptText({
      message: "输入代理 URL（如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7891）",
      placeholder: "http://127.0.0.1:7890",
      validate: (v) => (!isValidProxyTarget(v) || v.trim().toLowerCase() === "direct" ? "请输入合法的 http(s)/socks5 代理 URL" : undefined),
    });
    nextProxies = buildQuickProxyRules(proxyUrl);
  } else if (proxyChoice === "advanced") {
    nextProxies = await promptScopedProxiesStep(existingProxies, providerSlugs);
  }

  const consoleCfg = resolveWebConsoleConfig(baseConfig);
  const searchCfg = resolveTavilySearchConfig(baseConfig);
  const browserCfg = resolveWebBrowserConfig(baseConfig);
  const memoryProvider = resolveMemoryProvider(baseConfig);
  const hasTavilyKey = Boolean(existingEnv[searchCfg.apiKeyEnv]?.trim());

  const initialFeatures: string[] = [];
  if (consoleCfg.enabled) initialFeatures.push("web_console");
  if (searchCfg.enabled && hasTavilyKey) initialFeatures.push("tavily");
  if (browserCfg.enabled) initialFeatures.push("browser");
  if (memoryProvider === "memoryecho") initialFeatures.push("memoryecho");

  const selectedFeatures = guardCancel(
    await p.multiselect({
      message: "启用哪些基础功能？（空格勾选/取消，回车确认；其余细节采用默认值）",
      initialValues: initialFeatures,
      options: [
        {
          value: "web_console",
          label: "Web 控制台",
          hint: `默认 ${consoleCfg.host}:${consoleCfg.port}，可查看轨迹与可视化改配置`,
        },
        {
          value: "tavily",
          label: "联网搜索 (Tavily)",
          hint: `需要 ${searchCfg.apiKeyEnv}`,
        },
        {
          value: "browser",
          label: "浏览器自动化 (Playwright)",
          hint: "支持网页操作与登录态接管",
        },
        {
          value: "memoryecho",
          label: "云端长期记忆 (MemoryEcho)",
          hint: `需要 ${resolveMemoryEchoConfig(baseConfig).apiKeyEnv}`,
        },
      ],
      required: false,
    }),
  ) as string[];

  const enableConsole = selectedFeatures.includes("web_console");
  const enableTavily = selectedFeatures.includes("tavily");
  const enableBrowser = selectedFeatures.includes("browser");
  const enableMemoryEcho = selectedFeatures.includes("memoryecho");

  if (enableTavily) {
    const tavilyKey = await promptSecretForEnv(
      searchCfg.apiKeyEnv,
      "Tavily API Key（用于 web_search 工具）",
      existingEnv,
    );
    if (tavilyKey !== undefined) {
      envUpdates[searchCfg.apiKeyEnv] = tavilyKey;
    }
  }

  const meCfg = resolveMemoryEchoConfig(baseConfig);
  if (enableMemoryEcho) {
    const meKey = await promptSecretForEnv(
      meCfg.apiKeyEnv,
      "MemoryEcho API Key（用于长期记忆存储与检索）",
      existingEnv,
    );
    if (meKey !== undefined) {
      envUpdates[meCfg.apiKeyEnv] = meKey;
    }
  }

  const nextMemoryProvider: "none" | "memoryecho" | "hindsight" = enableMemoryEcho
    ? "memoryecho"
    : memoryProvider === "hindsight"
      ? "hindsight"
      : "none";

  return {
    ...baseConfig,
    network: { proxies: nextProxies },
    web: {
      ...baseConfig.web,
      search: {
        provider: "tavily",
        enabled: enableTavily,
        api_key_env: searchCfg.apiKeyEnv,
        base_url: searchCfg.baseUrl,
        max_results: searchCfg.maxResults,
        search_depth: searchCfg.searchDepth,
      },
      fetch: (() => {
        const fetchCfg = resolveWebFetchConfig(baseConfig);
        return {
          enabled: fetchCfg.enabled,
          timeout_ms: fetchCfg.timeoutMs,
          max_chars: fetchCfg.maxChars,
        };
      })(),
      browser: {
        ...browserCfg,
        enabled: enableBrowser,
        model_slot: browserCfg.modelSlot,
        profile_dir: browserCfg.profileDir,
        max_steps: browserCfg.maxSteps,
        action_timeout_ms: browserCfg.actionTimeoutMs,
        idle_timeout_minutes: browserCfg.idleTimeoutMinutes,
        ...(browserCfg.executablePath ? { executable_path: browserCfg.executablePath } : {}),
        ...(browserCfg.channel ? { channel: browserCfg.channel } : {}),
        ...(browserCfg.display ? { display: browserCfg.display } : {}),
        ...(browserCfg.novncHint ? { novnc_hint: browserCfg.novncHint } : {}),
      },
      console: {
        enabled: enableConsole,
        host: consoleCfg.host,
        port: consoleCfg.port,
        ...(consoleCfg.authTokenEnv ? { auth_token_env: consoleCfg.authTokenEnv } : {}),
      },
    },
    memory: {
      ...baseConfig.memory,
      provider: nextMemoryProvider,
      memoryecho: {
        enabled: enableMemoryEcho,
        base_url: meCfg.baseUrl,
        api_key_env: meCfg.apiKeyEnv,
        timeout_ms: meCfg.timeoutMs,
        auto_create_vaults: meCfg.autoCreateVaults,
        vaults: {
          persona: meCfg.vaults.persona,
          tech: meCfg.vaults.tech,
          ...(meCfg.vaults.notebook ? { notebook: meCfg.vaults.notebook } : {}),
        },
      },
    },
  };
}

// ============================================================================
// Full Mode Sections (9 comprehensive steps) & Reusable Components
// ============================================================================

export async function promptFullOwnerPathsStep(baseConfig: HatoConfig): Promise<HatoConfig> {
  p.log.step("第 1/9 步 · 主人档案、时区与数据路径");

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
        : { placeholder: "23:30", defaultValue: "23:30" }),
      validate: validateHhMm,
    });

    quietEnd = await promptText({
      message: "免打扰结束时间（HH:MM）",
      ...(hasExistingQuietHours
        ? {
            placeholder: baseConfig.owner.quiet_hours.end,
            defaultValue: baseConfig.owner.quiet_hours.end,
          }
        : { placeholder: "08:00", defaultValue: "08:00" }),
      validate: validateHhMm,
    });
  }

  const proactiveChannel = guardCancel(
    await p.select({
      message: "主动消息推送渠道 (owner.proactive_channel)",
      initialValue: baseConfig.owner.proactive_channel,
      options: [
        { value: "tg", label: "tg（固定推送到 Telegram）" },
        { value: "qq", label: "qq（固定推送到 QQ）" },
        { value: "last_active", label: "last_active（跟随最近活跃平台）" },
      ],
    }),
  ) as "tg" | "qq" | "last_active";

  const customizePaths = guardCancel(
    await p.confirm({
      message: "是否自定义数据路径与提示词层级顺序 (paths / prompts)？",
      initialValue: false,
    }),
  );

  let nextPaths = { ...baseConfig.paths };
  let nextPrompts = {
    order: resolvePromptOrder(baseConfig),
    ...(baseConfig.prompts?.disabled ? { disabled: baseConfig.prompts.disabled } : {}),
  };

  if (customizePaths) {
    const sqlite = await promptText({
      message: "SQLite 数据库路径 (paths.sqlite)",
      defaultValue: baseConfig.paths.sqlite,
      placeholder: baseConfig.paths.sqlite,
      validate: (v) => (!v.trim() ? "不能为空" : undefined),
    });
    const workspacesDir = await promptText({
      message: "Worker 工作区目录 (paths.workspaces_dir)",
      defaultValue: baseConfig.paths.workspaces_dir,
      placeholder: baseConfig.paths.workspaces_dir,
      validate: (v) => (!v.trim() ? "不能为空" : undefined),
    });
    const promptsDir = await promptText({
      message: "提示词目录 (paths.prompts_dir)",
      defaultValue: baseConfig.paths.prompts_dir,
      placeholder: baseConfig.paths.prompts_dir,
      validate: (v) => (!v.trim() ? "不能为空" : undefined),
    });
    const skillsDir = await promptText({
      message: "技能目录 (paths.skills_dir，留空使用默认)",
      defaultValue: baseConfig.paths.skills_dir ?? "",
      placeholder: "留空则使用默认路径",
    });
    const orderRaw = await promptText({
      message: "提示词加载顺序（逗号分隔：blocks, system, soul）",
      defaultValue: nextPrompts.order.join(", "),
      placeholder: "blocks, system, soul",
      validate: (v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean).length === 0
          ? "至少需要一个提示词层"
          : undefined,
    });
    nextPaths = {
      sqlite,
      workspaces_dir: workspacesDir,
      prompts_dir: promptsDir,
      ...(skillsDir ? { skills_dir: skillsDir } : {}),
    };
    nextPrompts = {
      ...nextPrompts,
      order: orderRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  return {
    ...baseConfig,
    paths: nextPaths,
    prompts: nextPrompts,
    owner: {
      ...baseConfig.owner,
      canonical_user_id: canonicalUserId,
      timezone,
      proactive_channel: proactiveChannel,
      quiet_hours: {
        start: quietStart,
        end: quietEnd,
      },
    },
  };
}

export async function promptFullGatewayStep(
  baseConfig: HatoConfig,
  existingEnv: Record<string, string>,
  envUpdates: Record<string, string | undefined>,
): Promise<HatoConfig> {
  p.log.step("第 2/9 步 · 消息网关（Telegram / QQ）、气泡分段与重试");

  // --- Telegram ---
  const tgEnabled = guardCancel(
    await p.confirm({
      message: "是否启用 Telegram 私聊网关？",
      initialValue: baseConfig.gateway.telegram.enabled,
    }),
  );

  let tgBaseUrl = baseConfig.gateway.telegram.base_url;
  let tgMode = baseConfig.gateway.telegram.mode;
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
        validate: (v) =>
          !isValidHttpOrHttpsUrl(v.trim()) ? "请输入合法的 http:// 或 https:// 地址" : undefined,
      });
    } else {
      tgBaseUrl = "https://api.telegram.org";
    }

    tgMode = guardCancel(
      await p.select({
        message: "Telegram 接收模式 (gateway.telegram.mode)",
        initialValue: "polling",
        options: [
          { value: "polling", label: "polling（长轮询，无需公网域名）" },
        ],
      }),
    ) as "polling";

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

  // --- QQ ---
  const qqEnabled = guardCancel(
    await p.confirm({
      message: "是否启用 QQ 官方机器人网关？",
      initialValue: baseConfig.gateway.qq.enabled,
    }),
  );

  let qqAppId = baseConfig.gateway.qq.app_id;
  let qqBaseUrl = baseConfig.gateway.qq.base_url;
  const qqSecretEnv = baseConfig.gateway.qq.client_secret_env;
  let qqFallbackChannel = baseConfig.gateway.qq.fallback_channel;
  let qqOpenIds = [...baseConfig.owner.channels.qq.open_ids];

  if (qqEnabled) {
    qqAppId = await promptText({
      message: "QQ 机器人 App ID",
      ...(qqAppId ? { defaultValue: qqAppId, placeholder: qqAppId } : { placeholder: "例如 102000000" }),
      validate: (v) => (!v.trim() ? "QQ App ID 不能为空" : undefined),
    });
    const secret = await promptSecretForEnv(qqSecretEnv, "QQ 机器人 AppSecret", existingEnv);
    if (secret !== undefined) {
      envUpdates[qqSecretEnv] = secret;
    }
    qqBaseUrl = await promptText({
      message: "QQ OpenAPI base_url",
      defaultValue: qqBaseUrl,
      placeholder: qqBaseUrl,
      validate: (v) => (!isValidHttpOrHttpsUrl(v.trim()) ? "请输入合法 URL" : undefined),
    });
    qqFallbackChannel = guardCancel(
      await p.select({
        message: "QQ 主动消息超限/失败时的回退渠道 (fallback_channel)",
        initialValue: qqFallbackChannel,
        options: [
          { value: "tg", label: "tg（回退到 Telegram）" },
          { value: "none", label: "none（不回退）" },
        ],
      }),
    ) as "tg" | "none";

    const existingOpenIds = qqOpenIds.join(", ");
    const qqBindMode = guardCancel(
      await p.select({
        message: "主人 QQ 账号绑定方式",
        initialValue: qqOpenIds.length > 0 ? "manual" : "sethome",
        options: [
          { value: "sethome", label: "启动后通过 /sethome <配对码> 自动认领" },
          {
            value: "manual",
            label: "现在手动填写 QQ open_id",
            hint: existingOpenIds ? `当前: ${existingOpenIds}` : undefined,
          },
        ],
      }),
    );
    if (qqBindMode === "manual") {
      const rawOpenIds = await promptText({
        message: "输入主人 QQ open_id（多个逗号分隔，留空改用 /sethome）",
        ...(existingOpenIds ? { initialValue: existingOpenIds } : { placeholder: "open_id" }),
      });
      qqOpenIds = rawOpenIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      qqOpenIds = [];
    }
  }

  // --- Debounce & Bubbles ---
  const debounceMs = await promptNumber({
    message: "连发消息合并防抖时间 (gateway.debounce_ms，毫秒)",
    defaultValue: baseConfig.gateway.debounce_ms,
    min: 0,
    integer: true,
  });

  const bubblesEnabled = guardCancel(
    await p.confirm({
      message: "是否开启回复多气泡分段发送 (gateway.bubbles.enabled)？",
      initialValue: baseConfig.gateway.bubbles.enabled,
    }),
  );

  let bubblesCfg = { ...baseConfig.gateway.bubbles, enabled: bubblesEnabled };
  if (bubblesEnabled) {
    const maxPerTurn = await promptNumber({
      message: "单轮最多气泡数 (max_per_turn)",
      defaultValue: baseConfig.gateway.bubbles.max_per_turn,
      min: 1,
      integer: true,
    });
    const minDelay = await promptNumber({
      message: "气泡间最小延迟（毫秒）",
      defaultValue: baseConfig.gateway.bubbles.delay_ms_range[0],
      min: 0,
      integer: true,
    });
    const maxDelay = await promptNumber({
      message: "气泡间最大延迟（毫秒）",
      defaultValue: Math.max(minDelay, baseConfig.gateway.bubbles.delay_ms_range[1]),
      min: minDelay,
      integer: true,
    });
    const delimiter = await promptText({
      message: "气泡分隔符 (delimiter)",
      defaultValue: baseConfig.gateway.bubbles.delimiter,
      placeholder: "[SPLIT]",
      validate: (v) => (!v.trim() ? "不能为空" : undefined),
    });
    bubblesCfg = {
      enabled: true,
      max_per_turn: maxPerTurn,
      delay_ms_range: [minDelay, maxDelay],
      delimiter,
    };
  }

  const customizeRetry = guardCancel(
    await p.confirm({
      message: "是否调整网络与 LLM 自动重试策略 (gateway.retry / llm_retry)？",
      initialValue: false,
    }),
  );
  let nextGatewayRetry = baseConfig.gateway.retry;
  let nextLlmRetry = baseConfig.llm_retry;
  if (customizeRetry) {
    const gwMaxRetries = await promptNumber({
      message: "网关请求最大重试次数 (gateway.retry.max_retries)",
      defaultValue: baseConfig.gateway.retry?.max_retries ?? 3,
      min: 0,
      max: 10,
      integer: true,
    });
    nextGatewayRetry = {
      max_retries: gwMaxRetries,
      initial_delay_ms: baseConfig.gateway.retry?.initial_delay_ms ?? 500,
      backoff_multiplier: baseConfig.gateway.retry?.backoff_multiplier ?? 2,
      max_delay_ms: baseConfig.gateway.retry?.max_delay_ms ?? 8000,
      jitter: baseConfig.gateway.retry?.jitter ?? true,
    };

    const llmMaxRetries = await promptNumber({
      message: "LLM 调用最大重试次数 (llm_retry.max_retries)",
      defaultValue: baseConfig.llm_retry?.max_retries ?? 3,
      min: 0,
      max: 10,
      integer: true,
    });
    const notifyAfterRetry = await promptNumber({
      message: "第几次重试后向用户发等待提示 (llm_retry.notify_after_retry，0 表示不提示)",
      defaultValue: baseConfig.llm_retry?.notify_after_retry ?? 1,
      min: 0,
      max: 10,
      integer: true,
    });
    nextLlmRetry = {
      ...baseConfig.llm_retry,
      max_retries: llmMaxRetries,
      notify_after_retry: notifyAfterRetry,
    };
  }

  return {
    ...baseConfig,
    owner: {
      ...baseConfig.owner,
      channels: {
        tg: { user_ids: tgUserIds },
        qq: { open_ids: qqOpenIds },
      },
    },
    ...(nextLlmRetry ? { llm_retry: nextLlmRetry } : {}),
    gateway: {
      ...baseConfig.gateway,
      debounce_ms: debounceMs,
      ...(nextGatewayRetry ? { retry: nextGatewayRetry } : {}),
      bubbles: bubblesCfg,
      telegram: {
        ...baseConfig.gateway.telegram,
        enabled: tgEnabled,
        base_url: tgBaseUrl,
        mode: tgMode,
      },
      qq: {
        ...baseConfig.gateway.qq,
        enabled: qqEnabled,
        app_id: qqAppId,
        base_url: qqBaseUrl,
        fallback_channel: qqFallbackChannel,
      },
    },
  };
}

export async function promptSingleModel(
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

  const contextWindow = await promptNumber({
    message: "上下文窗口大小 (context_window)",
    defaultValue: 128000,
    min: 1,
    integer: true,
  });

  const maxTokens = await promptNumber({
    message: "单轮最大输出 Token 数 (max_tokens)",
    defaultValue: 8192,
    min: 1,
    integer: true,
  });

  return {
    id,
    name,
    ...(modelApi && modelApi !== defaultApi ? { api: modelApi } : {}),
    ...(modelBaseUrl && modelBaseUrl !== defaultBaseUrl ? { base_url: modelBaseUrl } : {}),
    reasoning: capabilities.includes("reasoning"),
    input: capabilities.includes("image") ? ["text", "image"] : ["text"],
    context_window: contextWindow,
    max_tokens: maxTokens,
  };
}

export async function promptSingleProvider(params: {
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
    validate: (v) =>
      !isValidHttpOrHttpsUrl(v.trim()) ? "请输入合法的 http:// 或 https:// 地址" : undefined,
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

export async function promptFullProvidersStep(
  existingProviders: Record<string, ProviderTable> | undefined,
  existingEnv: Record<string, string>,
  envUpdates: Record<string, string | undefined>,
): Promise<Record<string, ProviderTable>> {
  p.log.step("第 3/9 步 · Provider 与多模型配置（按 <SLUG>_API_KEY 自动读取密钥）");

  const providers: Record<string, ProviderTable> = {};
  const existingSlugs = new Set<string>();
  let needAdd = true;

  if (existingProviders && Object.keys(existingProviders).length > 0) {
    const summary = Object.entries(existingProviders)
      .map(([k, v]) => `• ${v.slug ?? k} (${v.api}): ${v.models.map((m) => m.id).join(", ")}`)
      .join("\n");
    p.note(summary, "当前已配置 Provider 与模型");

    const mode = guardCancel(
      await p.select({
        message: "如何处理现有 Provider？",
        initialValue: "keep",
        options: [
          { value: "keep", label: "保留现有配置不改" },
          { value: "append", label: "保留现有配置并继续新增/更新 Provider" },
          { value: "reset", label: "清空并重新配置所有 Provider" },
        ],
      }),
    );

    if (mode !== "reset") {
      for (const [k, v] of Object.entries(existingProviders)) {
        providers[k] = v;
        existingSlugs.add((v.slug ?? k).trim());
      }
    }
    needAdd = mode !== "keep";
  }

  while (needAdd) {
    const { slug, provider } = await promptSingleProvider({
      existingSlugs,
      existingEnv,
      envUpdates,
      allowUpdateExisting: true,
    });
    for (const [k, v] of Object.entries(providers)) {
      if ((v.slug ?? k).trim() === slug && k !== slug) {
        delete providers[k];
      }
    }
    providers[slug] = provider;
    existingSlugs.add(slug);

    needAdd = guardCancel(
      await p.confirm({
        message: "是否继续添加下一个 Provider？",
        initialValue: false,
      }),
    );
  }

  return providers;
}

export async function promptSlotsStep(
  providers: Record<string, ProviderTable>,
  initialSlots?: Partial<ModelsFileConfig["slots"]>,
  initialSlotThinking?: Partial<Record<ModelSlot, ConfiguredThinkingLevel>>,
  opts?: { askThinking?: boolean },
): Promise<{
  slots: ModelsFileConfig["slots"];
  slotThinking?: Partial<Record<ModelSlot, ConfiguredThinkingLevel>>;
}> {
  p.log.step("角色槽位与思考等级绑定（所有槽位均携带 <provider_slug>/<model_id> 前缀）");

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
  const currentlyAllSame =
    !initialSlots ||
    (["router", "curator", "worker"] as const).every(
      (s) => !initialSlots[s] || initialSlots[s] === persona,
    );

  const reuseAll =
    targets.length === 1 ||
    guardCancel(
      await p.confirm({
        message: `其余 3 个必选槽位（router / curator / worker）是否也设为 "${persona}"？`,
        initialValue: currentlyAllSame,
      }),
    );

  const requiredSlots: ModelsFileConfig["slots"] = reuseAll
    ? {
        persona,
        router: persona,
        curator: persona,
        worker: persona,
      }
    : {
        persona,
        router: await pickTarget("router", persona),
        curator: await pickTarget("curator", persona),
        worker: await pickTarget("worker", persona),
      };

  let visionTarget: string | undefined =
    initialSlots?.vision && targets.includes(initialSlots.vision) ? initialSlots.vision : undefined;
  if (targets.length > 1) {
    const visionChoice = guardCancel(
      await p.select({
        message: `为 ${SLOT_DESCRIPTIONS.vision} 选择模型`,
        initialValue: visionTarget ?? INHERIT_PERSONA_VALUE,
        options: [
          { value: INHERIT_PERSONA_VALUE, label: `跟随 persona（当前: ${persona}）` },
          ...targets.map((t) => ({ value: t, label: t })),
        ],
      }),
    );
    visionTarget = visionChoice === INHERIT_PERSONA_VALUE ? undefined : visionChoice;
  } else {
    visionTarget = undefined;
  }

  const slots: ModelsFileConfig["slots"] = {
    ...requiredSlots,
    ...(visionTarget ? { vision: visionTarget } : {}),
  };

  let nextThinking: Partial<Record<ModelSlot, ConfiguredThinkingLevel>> | undefined =
    initialSlotThinking && Object.keys(initialSlotThinking).length > 0
      ? { ...initialSlotThinking }
      : undefined;

  if (opts?.askThinking !== false) {
    const hasCustomThinking = Boolean(initialSlotThinking && Object.keys(initialSlotThinking).length > 0);
    const configureThinking = guardCancel(
      await p.confirm({
        message: "是否自定义各槽位思考等级 (slot_thinking)？",
        initialValue: hasCustomThinking,
      }),
    );

    if (configureThinking) {
      const collected: Partial<Record<ModelSlot, ConfiguredThinkingLevel>> = {};
      for (const slot of MODEL_SLOTS) {
        const current = initialSlotThinking?.[slot];
        const chosen = guardCancel(
          await p.select({
            message: `${slot} 思考等级`,
            initialValue: current ?? DEFAULT_THINKING_VALUE,
            options: [
              { value: DEFAULT_THINKING_VALUE, label: "跟随系统默认" },
              ...THINKING_LEVEL_OPTIONS.map((lvl) => ({ value: lvl, label: lvl })),
            ],
          }),
        );
        if (chosen !== DEFAULT_THINKING_VALUE) {
          collected[slot] = chosen as ConfiguredThinkingLevel;
        }
      }
      nextThinking = Object.keys(collected).length > 0 ? collected : undefined;
    }
  }

  return { slots, slotThinking: nextThinking };
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

export async function promptScopedProxiesStep(
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

export async function promptFullContextStep(baseConfig: HatoConfig): Promise<HatoConfig> {
  p.log.step("第 6/9 步 · 上下文压缩与热区清空策略");

  const compactionMode = guardCancel(
    await p.select({
      message: "上下文压缩方式 (context.compaction_mode)",
      initialValue: resolveContextCompactionMode(baseConfig),
      options: [
        { value: "curator", label: "curator（独立精简提示词低成本压缩）" },
        { value: "reuse_conversation", label: "reuse_conversation（只读分支复用主对话缓存）" },
      ],
    }),
  ) as "curator" | "reuse_conversation";

  const clearCfg = resolveContextClearConfig(baseConfig);
  const clearMode = guardCancel(
    await p.select({
      message: "热区清空模式 (context.clear_mode)",
      initialValue: clearCfg.clearMode,
      options: [
        { value: "cache", label: "cache（缓存模式：无新消息后预摘要并在闲置后归档）" },
        { value: "scheduled", label: "scheduled（定时模式：每日固定时间清空归档，活跃时顺延）" },
        { value: "idle", label: "idle（静默模式：无对话指定分钟数后直接清空热区，不发摘要请求）" },
      ],
    }),
  ) as "cache" | "scheduled" | "idle";

  let preCompactAfterMinutes = baseConfig.context.pre_compact_after_minutes;
  let idleCommitAfterMinutes = baseConfig.context.idle_commit_after_minutes;
  let scheduledClearTime = clearCfg.scheduledClearTime;
  let scheduledDeferMinutes = clearCfg.scheduledDeferMinutes;

  if (clearMode === "cache") {
    preCompactAfterMinutes = await promptNumber({
      message: "热缓存预摘要时间（分钟，pre_compact_after_minutes）",
      defaultValue: preCompactAfterMinutes,
      min: 1,
      integer: true,
    });
    idleCommitAfterMinutes = await promptNumber({
      message: "闲置归档提交时间（分钟，idle_commit_after_minutes）",
      defaultValue: idleCommitAfterMinutes,
      min: 1,
      integer: true,
    });
  } else if (clearMode === "idle") {
    idleCommitAfterMinutes = await promptNumber({
      message: "无对话静默清空时间（分钟，idle_commit_after_minutes）",
      defaultValue: idleCommitAfterMinutes,
      min: 1,
      integer: true,
    });
  } else {
    scheduledClearTime = await promptText({
      message: "每日定时清空时间（HH:MM，scheduled_clear_time）",
      defaultValue: scheduledClearTime,
      placeholder: "01:00",
      validate: validateHhMm,
    });
    scheduledDeferMinutes = await promptNumber({
      message: "活跃聊天顺延分钟数 (scheduled_defer_minutes)",
      defaultValue: scheduledDeferMinutes,
      min: 1,
      integer: true,
    });
  }

  const hotWatermark = await promptNumber({
    message: "热区高水位阈值消息条数 (hot_messages_high_watermark)",
    defaultValue: baseConfig.context.hot_messages_high_watermark,
    min: 4,
    integer: true,
  });
  const keepAfterCompact = await promptNumber({
    message: "压缩后保留在热区的最近消息条数 (hot_messages_keep_after_compact)",
    defaultValue: baseConfig.context.hot_messages_keep_after_compact,
    min: 1,
    integer: true,
  });
  const minToCompact = await promptNumber({
    message: "触发压缩的最小消息条数 (min_messages_to_compact)",
    defaultValue: baseConfig.context.min_messages_to_compact,
    min: 2,
    integer: true,
  });
  const gapMarkerMinutes = await promptNumber({
    message: "对话间隔标记阈值（分钟，gap_marker_threshold_minutes）",
    defaultValue: baseConfig.context.gap_marker_threshold_minutes,
    min: 1,
    integer: true,
  });

  let lookback = { ...baseConfig.context.lookback };
  const customizeLookback = guardCancel(
    await p.confirm({
      message: "是否调整历史回看窗口 (context.lookback)？",
      initialValue: false,
    }),
  );
  if (customizeLookback) {
    lookback = {
      max_step_count: await promptNumber({
        message: "最大回看步数 (max_step_count)",
        defaultValue: lookback.max_step_count,
        min: 1,
        integer: true,
      }),
      max_total_messages: await promptNumber({
        message: "最大回看消息条数 (max_total_messages)",
        defaultValue: lookback.max_total_messages,
        min: 1,
        integer: true,
      }),
      max_hours: await promptNumber({
        message: "最大回看小时数 (max_hours)",
        defaultValue: lookback.max_hours,
        min: 1,
        integer: true,
      }),
    };
  }

  return {
    ...baseConfig,
    context: {
      ...baseConfig.context,
      hot_messages_high_watermark: hotWatermark,
      hot_messages_keep_after_compact: keepAfterCompact,
      min_messages_to_compact: minToCompact,
      pre_compact_after_minutes: preCompactAfterMinutes,
      idle_commit_after_minutes: idleCommitAfterMinutes,
      clear_mode: clearMode,
      compaction_mode: compactionMode,
      scheduled_clear_time: scheduledClearTime,
      scheduled_defer_minutes: scheduledDeferMinutes,
      gap_marker_threshold_minutes: gapMarkerMinutes,
      lookback,
    },
  };
}

export async function promptFullMemoryStep(
  baseConfig: HatoConfig,
  existingEnv: Record<string, string>,
  envUpdates: Record<string, string | undefined>,
): Promise<HatoConfig> {
  p.log.step("第 7/9 步 · 长期记忆与召回提炼配置");

  const currentProvider = resolveMemoryProvider(baseConfig);
  const provider = guardCancel(
    await p.select({
      message: "选择长期记忆后端 (memory.provider)",
      initialValue: currentProvider,
      options: [
        { value: "none", label: "none（仅使用本地 SQLite 工作记忆与小本本）" },
        { value: "memoryecho", label: "memoryecho（MemoryEcho 云端记忆服务）" },
        { value: "hindsight", label: "hindsight（本地/自建 Hindsight 服务）" },
      ],
    }),
  ) as "none" | "memoryecho" | "hindsight";

  const meCfg = resolveMemoryEchoConfig(baseConfig);
  let nextMe = {
    enabled: provider === "memoryecho",
    base_url: meCfg.baseUrl,
    api_key_env: meCfg.apiKeyEnv,
    timeout_ms: meCfg.timeoutMs,
    auto_create_vaults: meCfg.autoCreateVaults,
    vaults: {
      persona: meCfg.vaults.persona,
      tech: meCfg.vaults.tech,
      ...(meCfg.vaults.notebook ? { notebook: meCfg.vaults.notebook } : {}),
    },
  };

  if (provider === "memoryecho") {
    const meBaseUrl = await promptText({
      message: "MemoryEcho 服务地址 (memory.memoryecho.base_url)",
      defaultValue: meCfg.baseUrl,
      placeholder: meCfg.baseUrl,
      validate: (v) => (!isValidHttpOrHttpsUrl(v.trim()) ? "请输入合法 URL" : undefined),
    });
    const meKeyEnv = await promptText({
      message: "MemoryEcho API Key 环境变量名 (api_key_env)",
      defaultValue: meCfg.apiKeyEnv,
      placeholder: "MEMORYECHO_API_KEY",
      validate: (v) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) ? "请输入合法的环境变量名" : undefined,
    });
    const meSecret = await promptSecretForEnv(meKeyEnv, "MemoryEcho API Key", existingEnv);
    if (meSecret !== undefined) {
      envUpdates[meKeyEnv] = meSecret;
    }
    const autoCreate = guardCancel(
      await p.confirm({
        message: "是否自动创建 Vault (auto_create_vaults)？",
        initialValue: meCfg.autoCreateVaults,
      }),
    );
    const timeoutMs = await promptNumber({
      message: "MemoryEcho 请求超时（毫秒）",
      defaultValue: meCfg.timeoutMs,
      min: 1000,
      integer: true,
    });
    let vaults = { ...nextMe.vaults };
    if (!autoCreate) {
      vaults = {
        persona: await promptText({
          message: "persona Vault ID",
          defaultValue: meCfg.vaults.persona,
          placeholder: "vault_id",
        }),
        tech: await promptText({
          message: "tech Vault ID",
          defaultValue: meCfg.vaults.tech,
          placeholder: "vault_id",
        }),
        ...(meCfg.vaults.notebook ? { notebook: meCfg.vaults.notebook } : {}),
      };
    }
    nextMe = {
      enabled: true,
      base_url: meBaseUrl,
      api_key_env: meKeyEnv,
      timeout_ms: timeoutMs,
      auto_create_vaults: autoCreate,
      vaults,
    };
  }

  const hsCfg = resolveHindsightConfig(baseConfig);
  let nextHs = {
    base_url: hsCfg.baseUrl,
    embedding_dimensions: hsCfg.embeddingDimensions,
    banks: {
      persona: hsCfg.banks.persona,
      tech: hsCfg.banks.tech,
      ...(hsCfg.banks.notebook ? { notebook: hsCfg.banks.notebook } : {}),
    },
  };
  if (provider === "hindsight") {
    const hsBaseUrl = await promptText({
      message: "Hindsight 服务地址 (memory.hindsight.base_url)",
      defaultValue: hsCfg.baseUrl,
      placeholder: "http://127.0.0.1:8888",
      validate: (v) => (!isValidHttpOrHttpsUrl(v.trim()) ? "请输入合法 URL" : undefined),
    });
    const embedDim = await promptNumber({
      message: "Embedding 维度 (embedding_dimensions)",
      defaultValue: hsCfg.embeddingDimensions,
      min: 1,
      integer: true,
    });
    const personaBank = await promptText({
      message: "persona 记忆库名称",
      defaultValue: hsCfg.banks.persona,
      validate: (v) => (!v.trim() ? "不能为空" : undefined),
    });
    const techBank = await promptText({
      message: "tech 记忆库名称",
      defaultValue: hsCfg.banks.tech,
      validate: (v) => (!v.trim() ? "不能为空" : undefined),
    });
    nextHs = {
      base_url: hsBaseUrl,
      embedding_dimensions: embedDim,
      banks: {
        persona: personaBank,
        tech: techBank,
        ...(hsCfg.banks.notebook ? { notebook: hsCfg.banks.notebook } : {}),
      },
    };
  }

  let nextRecall = resolveMemoryRecallConfig(baseConfig);
  let nextCurator = resolveMemoryCuratorConfig(baseConfig);

  if (provider !== "none") {
    const recallMode = guardCancel(
      await p.select({
        message: "记忆召回模式 (memory.recall.mode)",
        initialValue: nextRecall.mode,
        options: [
          { value: "hybrid", label: "hybrid（自动召回 + 工具按需补充，推荐）" },
          { value: "auto", label: "auto（每轮自动召回）" },
          { value: "tool", label: "tool（仅模型主动调用 recall_memory）" },
          { value: "off", label: "off（关闭召回）" },
        ],
      }),
    ) as "hybrid" | "auto" | "tool" | "off";
    const maxResults = await promptNumber({
      message: "单次召回最大条数 (max_results, 1-20)",
      defaultValue: nextRecall.maxResults,
      min: 1,
      max: 20,
      integer: true,
    });
    const minQueryChars = await promptNumber({
      message: "触发自动召回的最短输入字符数 (min_query_chars, 1-50)",
      defaultValue: nextRecall.minQueryChars,
      min: 1,
      max: 50,
      integer: true,
    });
    nextRecall = { mode: recallMode, maxResults, minQueryChars };

    const curatorEnabled = guardCancel(
      await p.confirm({
        message: "是否启用异步记忆提炼 (memory.curator.enabled)？",
        initialValue: nextCurator.enabled,
      }),
    );
    if (curatorEnabled) {
      nextCurator = {
        enabled: true,
        idleRetainAfterMinutes: await promptNumber({
          message: "闲置提炼等待分钟数 (idle_retain_after_minutes)",
          defaultValue: nextCurator.idleRetainAfterMinutes,
          min: 1,
          integer: true,
        }),
        batchMessageThreshold: await promptNumber({
          message: "触发批量提炼的消息条数阈值 (batch_message_threshold)",
          defaultValue: nextCurator.batchMessageThreshold,
          min: 2,
          integer: true,
        }),
        maxBatchMessages: await promptNumber({
          message: "单批最多提炼消息条数 (max_batch_messages, 2-100)",
          defaultValue: nextCurator.maxBatchMessages,
          min: 2,
          max: 100,
          integer: true,
        }),
      };
    } else {
      nextCurator = { ...nextCurator, enabled: false };
    }
  }

  const deferMinutes = await promptNumber({
    message: "主动关怀挂起等待时间（分钟，open_loops.defer_after_chat_minutes）",
    defaultValue: baseConfig.memory.open_loops.defer_after_chat_minutes,
    min: 0,
    integer: true,
  });
  const maxStreak = await promptNumber({
    message: "未回复主动关怀最大连续次数 (max_unanswered_streak)",
    defaultValue: baseConfig.memory.open_loops.max_unanswered_streak,
    min: 1,
    integer: true,
  });

  return {
    ...baseConfig,
    memory: {
      ...baseConfig.memory,
      provider,
      recall: {
        mode: nextRecall.mode,
        max_results: nextRecall.maxResults,
        min_query_chars: nextRecall.minQueryChars,
      },
      curator: {
        enabled: nextCurator.enabled,
        idle_retain_after_minutes: nextCurator.idleRetainAfterMinutes,
        batch_message_threshold: nextCurator.batchMessageThreshold,
        max_batch_messages: nextCurator.maxBatchMessages,
      },
      memoryecho: nextMe,
      hindsight: nextHs,
      open_loops: {
        defer_after_chat_minutes: deferMinutes,
        max_unanswered_streak: maxStreak,
      },
    },
  };
}

export async function promptFullWebStep(
  baseConfig: HatoConfig,
  existingEnv: Record<string, string>,
  envUpdates: Record<string, string | undefined>,
): Promise<HatoConfig> {
  p.log.step("第 8/9 步 · 联网搜索、网页抓取、浏览器自动化与 Web 控制台");

  // --- Search (Tavily) ---
  const searchCfg = resolveTavilySearchConfig(baseConfig);
  const hasExistingTavilyKey = Boolean(existingEnv[searchCfg.apiKeyEnv]?.trim());
  const enableTavily = guardCancel(
    await p.confirm({
      message: `是否启用联网搜索（Tavily · ${searchCfg.apiKeyEnv}）？`,
      initialValue: baseConfig.web?.search?.enabled ?? hasExistingTavilyKey,
    }),
  );

  let nextSearch = {
    provider: "tavily" as const,
    enabled: enableTavily,
    api_key_env: searchCfg.apiKeyEnv,
    base_url: searchCfg.baseUrl,
    max_results: searchCfg.maxResults,
    search_depth: searchCfg.searchDepth,
  };
  if (enableTavily) {
    const tavilyKey = await promptSecretForEnv(
      searchCfg.apiKeyEnv,
      "Tavily API Key（用于 web_search 工具）",
      existingEnv,
    );
    if (tavilyKey !== undefined) {
      envUpdates[searchCfg.apiKeyEnv] = tavilyKey;
    }
    const maxResults = await promptNumber({
      message: "每次搜索返回最大结果数 (web.search.max_results, 1-20)",
      defaultValue: searchCfg.maxResults,
      min: 1,
      max: 20,
      integer: true,
    });
    const depth = guardCancel(
      await p.select({
        message: "Tavily 搜索深度 (search_depth)",
        initialValue: searchCfg.searchDepth,
        options: [
          { value: "basic", label: "basic（快速，节省额度）" },
          { value: "advanced", label: "advanced（深度摘要）" },
        ],
      }),
    ) as "basic" | "advanced";
    nextSearch = { ...nextSearch, max_results: maxResults, search_depth: depth };
  }

  // --- Fetch ---
  const fetchCfg = resolveWebFetchConfig(baseConfig);
  const enableFetch = guardCancel(
    await p.confirm({
      message: "是否启用网页正文抓取工具 (web.fetch)？",
      initialValue: fetchCfg.enabled,
    }),
  );

  // --- Browser ---
  const browserCfg = resolveWebBrowserConfig(baseConfig);
  const enableBrowser = guardCancel(
    await p.confirm({
      message: "是否启用浏览器自动化工具 (web.browser / Playwright)？",
      initialValue: browserCfg.enabled,
    }),
  );
  let nextBrowser = {
    ...browserCfg,
    enabled: enableBrowser,
    model_slot: browserCfg.modelSlot,
    profile_dir: browserCfg.profileDir,
    max_steps: browserCfg.maxSteps,
    action_timeout_ms: browserCfg.actionTimeoutMs,
    idle_timeout_minutes: browserCfg.idleTimeoutMinutes,
    ...(browserCfg.executablePath ? { executable_path: browserCfg.executablePath } : {}),
    ...(browserCfg.channel ? { channel: browserCfg.channel } : {}),
    ...(browserCfg.display ? { display: browserCfg.display } : {}),
    ...(browserCfg.novncHint ? { novnc_hint: browserCfg.novncHint } : {}),
  };
  if (enableBrowser) {
    const headlessChoice = guardCancel(
      await p.select({
        message: "浏览器无头模式 (web.browser.headless)",
        initialValue: String(browserCfg.headless),
        options: [
          { value: "auto", label: "auto（自动判断）" },
          { value: "true", label: "true（强制无头）" },
          { value: "false", label: "false（弹出可见窗口）" },
        ],
      }),
    );
    const modelSlot = guardCancel(
      await p.select({
        message: "浏览器任务使用的模型槽位 (web.browser.model_slot)",
        initialValue: browserCfg.modelSlot,
        options: [
          { value: "persona", label: "persona" },
          { value: "worker", label: "worker" },
          { value: "router", label: "router" },
          { value: "curator", label: "curator" },
        ],
      }),
    ) as "persona" | "worker" | "router" | "curator";
    const maxSteps = await promptNumber({
      message: "单次浏览器任务最大步数 (max_steps, 1-50)",
      defaultValue: browserCfg.maxSteps,
      min: 1,
      max: 50,
      integer: true,
    });
    nextBrowser = {
      ...nextBrowser,
      headless: headlessChoice === "auto" ? "auto" : headlessChoice === "true",
      model_slot: modelSlot,
      max_steps: maxSteps,
    };
  }

  // --- Web Console ---
  const consoleCfg = resolveWebConsoleConfig(baseConfig);
  const enableConsole = guardCancel(
    await p.confirm({
      message: "是否启用 Web 控制台 (web.console)？",
      initialValue: consoleCfg.enabled,
    }),
  );
  let nextConsole: NonNullable<HatoConfig["web"]>["console"] = {
    enabled: enableConsole,
    host: consoleCfg.host,
    port: consoleCfg.port,
    ...(consoleCfg.authTokenEnv ? { auth_token_env: consoleCfg.authTokenEnv } : {}),
  };
  if (enableConsole) {
    const host = await promptText({
      message: "Web 控制台监听地址 (web.console.host)",
      defaultValue: consoleCfg.host,
      placeholder: "127.0.0.1",
      validate: (v) => (!v.trim() ? "不能为空" : undefined),
    });
    const port = await promptNumber({
      message: "Web 控制台端口 (web.console.port, 0-65535)",
      defaultValue: consoleCfg.port,
      min: 0,
      max: 65535,
      integer: true,
    });
    const authEnv = await promptText({
      message: "访问令牌环境变量名 (auth_token_env，留空则自动生成或无需固定环境变量)",
      defaultValue: consoleCfg.authTokenEnv ?? "",
      placeholder: "例如 HATO_CONSOLE_TOKEN（可留空）",
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return undefined;
        return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? "请输入合法的环境变量名" : undefined;
      },
    });
    if (authEnv) {
      const tokenVal = await promptSecretForEnv(authEnv, "Web 控制台访问令牌", existingEnv);
      if (tokenVal !== undefined) {
        envUpdates[authEnv] = tokenVal;
      }
    }
    nextConsole = {
      enabled: true,
      host,
      port,
      ...(authEnv ? { auth_token_env: authEnv } : {}),
    };
  }

  return {
    ...baseConfig,
    web: {
      ...baseConfig.web,
      search: nextSearch,
      fetch: {
        enabled: enableFetch,
        timeout_ms: fetchCfg.timeoutMs,
        max_chars: fetchCfg.maxChars,
      },
      browser: nextBrowser,
      console: nextConsole,
    },
  };
}

export async function promptFullWorkerAndUpdatesStep(baseConfig: HatoConfig): Promise<HatoConfig> {
  p.log.step("第 9/9 步 · Worker 后台执行与版本更新设置");

  const defaultBackend = guardCancel(
    await p.select({
      message: "默认后台执行器 (worker.default_backend)",
      initialValue: resolveEffectiveDefaultBackend(baseConfig),
      options: [
        { value: "builtin-pi", label: "builtin-pi（内置 Worker Agent，无需额外 CLI）" },
        { value: "codex-cli", label: "codex-cli（OpenAI Codex CLI）" },
        { value: "claude-code", label: "claude-code（Claude Code CLI）" },
        { value: "antigravity-cli", label: "antigravity-cli（Antigravity CLI）" },
        { value: "opencode-v2", label: "opencode-v2（OpenCode）" },
        { value: "external-pi", label: "external-pi（外部 Pi CLI）" },
      ],
    }),
  ) as HatoConfig["worker"]["default_backend"];

  const routingMode = guardCancel(
    await p.select({
      message: "工单路由方式 (worker.routing_mode)",
      initialValue: baseConfig.worker.routing_mode ?? "smart",
      options: [
        { value: "smart", label: "smart（智能选择最合适的后端）" },
        { value: "always_default", label: "always_default（始终使用默认后端）" },
      ],
    }),
  ) as "smart" | "always_default";

  const executionMode = guardCancel(
    await p.select({
      message: "工作区隔离模式 (worker.execution_mode)",
      initialValue: resolveWorkerExecutionMode(baseConfig),
      options: [
        { value: "isolated", label: "isolated（隔离临时工作区，安全推荐）" },
        { value: "vm_unrestricted", label: "vm_unrestricted（直接操作指定目录，无隔离）" },
      ],
    }),
  ) as "isolated" | "vm_unrestricted";

  let vmWorkdir = resolveWorkerVmWorkdir(baseConfig);
  if (executionMode === "vm_unrestricted") {
    vmWorkdir = await promptText({
      message: "非隔离工作目录 (worker.vm_workdir)",
      defaultValue: vmWorkdir,
      placeholder: vmWorkdir,
      validate: (v) => (!v.trim() ? "不能为空" : undefined),
    });
  }

  const workspaceTtlDays = await promptNumber({
    message: "临时工作区保留天数 (worker.workspace_ttl_days)",
    defaultValue: baseConfig.worker.workspace_ttl_days,
    min: 1,
    integer: true,
  });

  let nextExternalCli = { ...baseConfig.worker.external_cli };
  const configureExtCli =
    defaultBackend !== "builtin-pi" ||
    guardCancel(
      await p.confirm({
        message: "是否配置外部 Coding CLI 权限与仓库白名单 (worker.external_cli)？",
        initialValue: false,
      }),
    );

  if (configureExtCli) {
    const permissionPreset = guardCancel(
      await p.select({
        message: "外部 CLI 权限预设 (permission_preset)",
        initialValue: nextExternalCli.permission_preset ?? "follow_host",
        options: [
          { value: "follow_host", label: "follow_host（跟随宿主机默认设置）" },
          { value: "auto_safe", label: "auto_safe（自动审批安全操作）" },
          { value: "yolo", label: "yolo（全自动免确认）" },
          { value: "read_only", label: "read_only（仅只读分析）" },
          { value: "custom", label: "custom（自定义各 CLI 参数）" },
        ],
      }),
    ) as ExternalCliPermissionPreset;

    const reuseAuth = guardCancel(
      await p.confirm({
        message: "外部 CLI 是否复用宿主机登录态与 Provider (reuse_host_auth_and_provider)？",
        initialValue: nextExternalCli.reuse_host_auth_and_provider ?? true,
      }),
    );
    const inheritMcp = guardCancel(
      await p.confirm({
        message: "外部 CLI 是否继承宿主机 MCP 工具 (inherit_host_mcp)？",
        initialValue: nextExternalCli.inherit_host_mcp ?? false,
      }),
    );
    const allowedReposRaw = await promptText({
      message: "允许外部 CLI 操作的本地仓库路径（多个逗号分隔，留空则不限制额外白名单）",
      defaultValue: nextExternalCli.allowed_repos.join(", "),
      placeholder: "/path/to/repo1, /path/to/repo2",
    });

    nextExternalCli = {
      ...nextExternalCli,
      permission_preset: permissionPreset,
      reuse_host_auth_and_provider: reuseAuth,
      inherit_host_mcp: inheritMcp,
      allowed_repos: allowedReposRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  const updatesCfg = resolveUpdatesConfig(baseConfig);
  const checkEnabled = guardCancel(
    await p.confirm({
      message: "是否启用 GitHub Release 自动检查更新 (updates.check_enabled)？",
      initialValue: updatesCfg.checkEnabled,
    }),
  );
  const updateChannel = guardCancel(
    await p.select({
      message: "版本更新检查渠道 (updates.channel)",
      initialValue: updatesCfg.channel,
      options: [
        { value: "stable", label: "stable（正式发行版，推荐）" },
        { value: "nightly", label: "nightly（每提交预览版）" },
      ],
    }),
  ) as "stable" | "nightly";
  const imNotifyEnabled = guardCancel(
    await p.confirm({
      message: "是否开启 IM 新版本推送通知？",
      initialValue: updatesCfg.imNotifyEnabled,
    }),
  );

  return {
    ...baseConfig,
    worker: {
      ...baseConfig.worker,
      default_backend: defaultBackend,
      routing_mode: routingMode,
      execution_mode: executionMode,
      ...(executionMode === "vm_unrestricted" ? { vm_workdir: vmWorkdir } : {}),
      workspace_ttl_days: workspaceTtlDays,
      external_cli: nextExternalCli,
    },
    updates: {
      check_enabled: checkEnabled,
      channel: updateChannel,
      im_notify_enabled: imNotifyEnabled,
      check_interval_hours: updatesCfg.checkIntervalHours,
    },
  };
}
