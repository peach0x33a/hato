import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import {
  loadHatoConfig,
  resolveHindsightConfig,
  resolveMemoryEchoConfig,
  resolveMemoryProvider,
  resolveTavilySearchConfig,
  resolveWebConsoleConfig,
  type HatoConfig,
} from "../config/app.js";
import {
  loadModelsFileConfig,
  ModelRegistry,
  type ModelsFileConfig,
} from "../config/models.js";
import { ScopedProxyRouter } from "../config/proxy.js";
import { mergeEnvFile, readEnvMap, writeHatoConfig, writeModelsConfig } from "../config/store.js";
import { createDefaultHatoConfig } from "./presets.js";
import {
  probeMemoryService,
  probeModelSlot,
  probeQqGateway,
  probeTavilySearch,
  probeTelegramGateway,
} from "./probe.js";
import {
  buildQuickProxyRules,
  buildQuickSlots,
  confirmTomlOverwriteIfNeeded,
  formatSetupHelp,
  guardCancel,
  parseWizardCommand,
  type ProviderTable,
  type WizardMode,
} from "./wizard-prompts.js";
import {
  promptFullContextStep,
  promptFullGatewayStep,
  promptFullMemoryStep,
  promptFullOwnerPathsStep,
  promptFullProvidersStep,
  promptFullWebStep,
  promptFullWorkerAndUpdatesStep,
  promptQuickBasicFeaturesStep,
  promptQuickChannelsStep,
  promptQuickModelStep,
  promptScopedProxiesStep,
  promptSingleProvider,
  promptSlotsStep,
} from "./wizard-sections.js";

export { buildQuickProxyRules, buildQuickSlots, formatSetupHelp, parseWizardCommand };

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

function validateConfigsInMemory(hatoConfig: HatoConfig, modelsConfig: ModelsFileConfig): void {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-setup-verify-"));
  const hatoFile = join(tempDir, "hato.toml");
  const modelsFile = join(tempDir, "models.toml");
  try {
    writeHatoConfig(hatoFile, hatoConfig, { backup: false });
    loadHatoConfig(hatoFile);
    writeModelsConfig(modelsFile, modelsConfig, { backup: false });
    new ModelRegistry(modelsFile);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

function listProviderSlugs(providers: Record<string, ProviderTable>): string[] {
  return Object.entries(providers).map(([key, val]) => (val.slug ?? key).trim());
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

  if (hatoConfig.gateway.qq.enabled) {
    const qqSecret =
      envMap[hatoConfig.gateway.qq.client_secret_env]?.trim() ||
      process.env[hatoConfig.gateway.qq.client_secret_env]?.trim() ||
      "";
    spin.start(`正在通过 Scoped Proxy 探测 QQ (${hatoConfig.gateway.qq.base_url})...`);
    const qqRes = await probeQqGateway({
      baseUrl: hatoConfig.gateway.qq.base_url,
      appId: hatoConfig.gateway.qq.app_id,
      clientSecret: qqSecret,
      proxyRouter,
    });
    spin.stop(qqRes.ok ? "QQ 连通性探测完成" : "QQ 探测未通过");
    const proxyTag =
      qqRes.proxy.mode === "proxy" ? `proxy(${qqRes.proxy.url})` : `direct(${qqRes.proxy.matchedScope ?? "default"})`;
    reportLines.push(
      qqRes.ok
        ? `✓ QQ Bot: app_id=${hatoConfig.gateway.qq.app_id} (${qqRes.latencyMs}ms · ${proxyTag})`
        : `✗ QQ Bot: ${qqRes.error} (${proxyTag})`,
    );
  } else {
    reportLines.push("- QQ Bot: 未启用，跳过");
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

  const memProvider = resolveMemoryProvider(hatoConfig);
  if (memProvider !== "none") {
    const meCfg = resolveMemoryEchoConfig(hatoConfig);
    const hsCfg = resolveHindsightConfig(hatoConfig);
    const memKey =
      envMap[meCfg.apiKeyEnv]?.trim() || process.env[meCfg.apiKeyEnv]?.trim() || "";
    spin.start(`正在探测记忆服务 (${memProvider})...`);
    const memRes = await probeMemoryService({
      provider: memProvider,
      memoryEcho: meCfg,
      hindsight: { base_url: hsCfg.baseUrl },
      proxyRouter,
      apiKey: memKey,
    });
    spin.stop(memRes.ok ? "记忆服务探测完成" : "记忆服务探测未通过");
    const memProxyTag =
      memRes.proxy.mode === "proxy" ? `proxy(${memRes.proxy.url})` : `direct(${memRes.proxy.matchedScope ?? "default"})`;
    reportLines.push(
      memRes.ok
        ? `✓ Memory (${memProvider}): 可达 (${memRes.latencyMs}ms · ${memProxyTag})`
        : `✗ Memory (${memProvider}): ${memRes.error} (${memProxyTag})`,
    );
  } else {
    reportLines.push("- Memory: 未启用外部服务，跳过");
  }

  p.note(reportLines.join("\n"), "连通性自检结果");
}

async function writeAndFinalizeWizard(params: {
  mode: WizardMode;
  paths: SetupPaths;
  hatoConfig: HatoConfig;
  modelsConfig: ModelsFileConfig;
  envUpdates: Record<string, string | undefined>;
}): Promise<void> {
  validateConfigsInMemory(params.hatoConfig, params.modelsConfig);

  if (!(await confirmTomlOverwriteIfNeeded([params.paths.hatoConfigPath, params.paths.modelsConfigPath]))) {
    return;
  }

  const hatoWrite = writeHatoConfig(params.paths.hatoConfigPath, params.hatoConfig, { backup: true });
  const modelsWrite = writeModelsConfig(params.paths.modelsConfigPath, params.modelsConfig, { backup: true });
  const envWrite = mergeEnvFile(params.paths.envPath, params.envUpdates);

  const summary = [
    `• 系统配置: ${hatoWrite.path}${hatoWrite.backupPath ? `（已备份 ${hatoWrite.backupPath}）` : ""}`,
    `• 模型配置: ${modelsWrite.path}${modelsWrite.backupPath ? `（已备份 ${modelsWrite.backupPath}）` : ""}`,
    `• 密钥文件: ${envWrite.path}（本次更新/写入 ${envWrite.writtenKeys.length} 项：${envWrite.writtenKeys.join(", ") || "沿用现有配置"}）`,
  ];

  const needTgClaim =
    params.hatoConfig.gateway.telegram.enabled && params.hatoConfig.owner.channels.tg.user_ids.length === 0;
  const needQqClaim =
    params.hatoConfig.gateway.qq.enabled && params.hatoConfig.owner.channels.qq.open_ids.length === 0;
  if (needTgClaim || needQqClaim) {
    summary.push(
      "• 账号认领: 启动服务后查看终端输出的 `/sethome HATO-XXXXXX`，在对应机器人私聊发送即可绑定主人并设为 Home Channel。",
    );
  }

  const consoleCfg = resolveWebConsoleConfig(params.hatoConfig);
  if (consoleCfg.enabled) {
    summary.push(`• Web 控制台: http://${consoleCfg.host}:${consoleCfg.port}`);
  }

  if (params.mode === "quick") {
    summary.push(
      "• 后续调整: 其余高级参数已采用默认值，后续可按需在 WebUI、聊天中让 Agent 协助，或通过 `hato setup full` 修改。",
    );
  }

  p.note(summary.join("\n"), "写入完成");

  const runProbe = guardCancel(
    await p.confirm({
      message: "是否立即执行一次连通性自检？（网关 + 主模型 + 联网/记忆）",
      initialValue: true,
    }),
  );
  if (runProbe) {
    await runConnectivityChecks(params.paths);
  }
}

export async function runQuickInitWizard(paths: SetupPaths = DEFAULT_SETUP_PATHS): Promise<void> {
  p.log.info("已进入【简易模式】：只需 3 步即可开始在聊天平台对话，其余设置使用默认值，后续可在 WebUI 或对话中按需调整。");

  const existingEnv = readEnvMap(paths.envPath);
  const envUpdates: Record<string, string | undefined> = {};

  const baseHato = existsSync(paths.hatoConfigPath)
    ? loadHatoConfig(paths.hatoConfigPath)
    : createDefaultHatoConfig();
  const existingModels = existsSync(paths.modelsConfigPath)
    ? loadModelsFileConfig(paths.modelsConfigPath)
    : null;

  const hatoAfterChannels = await promptQuickChannelsStep(baseHato, existingEnv, envUpdates);
  const nextModels = await promptQuickModelStep(existingModels, existingEnv, envUpdates);
  const nextHato = await promptQuickBasicFeaturesStep(
    hatoAfterChannels,
    listProviderSlugs(nextModels.providers),
    existingEnv,
    envUpdates,
  );

  await writeAndFinalizeWizard({
    mode: "quick",
    paths,
    hatoConfig: nextHato,
    modelsConfig: nextModels,
    envUpdates,
  });
}

export async function runFullInitWizard(paths: SetupPaths = DEFAULT_SETUP_PATHS): Promise<void> {
  p.log.info("已进入【全量配置模式】：将按 9 个模块依次配置所有参数，已有配置会作为默认值保留。");

  const existingEnv = readEnvMap(paths.envPath);
  const envUpdates: Record<string, string | undefined> = {};

  const baseHato = existsSync(paths.hatoConfigPath)
    ? loadHatoConfig(paths.hatoConfigPath)
    : createDefaultHatoConfig();
  const existingModels = existsSync(paths.modelsConfigPath)
    ? loadModelsFileConfig(paths.modelsConfigPath)
    : null;

  let nextHato = await promptFullOwnerPathsStep(baseHato);
  nextHato = await promptFullGatewayStep(nextHato, existingEnv, envUpdates);

  const providers = await promptFullProvidersStep(existingModels?.providers, existingEnv, envUpdates);

  p.log.step("第 4/9 步 · 6 角色模型槽位与思考等级绑定");
  const { slots, slotThinking } = await promptSlotsStep(
    providers,
    existingModels?.slots,
    existingModels?.slot_thinking,
    { askThinking: true },
  );
  const nextModels: ModelsFileConfig = {
    slots,
    ...(slotThinking ? { slot_thinking: slotThinking } : {}),
    providers,
  };

  p.log.step("第 5/9 步 · Scoped Proxy 按域代理规则");
  nextHato = {
    ...nextHato,
    network: {
      proxies: await promptScopedProxiesStep(
        nextHato.network?.proxies ?? [],
        listProviderSlugs(providers),
      ),
    },
  };

  nextHato = await promptFullContextStep(nextHato);
  nextHato = await promptFullMemoryStep(nextHato, existingEnv, envUpdates);
  nextHato = await promptFullWebStep(nextHato, existingEnv, envUpdates);
  nextHato = await promptFullWorkerAndUpdatesStep(nextHato);

  await writeAndFinalizeWizard({
    mode: "full",
    paths,
    hatoConfig: nextHato,
    modelsConfig: nextModels,
    envUpdates,
  });
}

export async function runInitWizard(
  paths: SetupPaths = DEFAULT_SETUP_PATHS,
  mode?: WizardMode,
): Promise<void> {
  const chosenMode: WizardMode =
    mode ??
    (guardCancel(
      await p.select({
        message: "选择初始化配置模式",
        initialValue: "quick",
        options: [
          {
            value: "quick",
            label: "简易模式（推荐 · 3 步快速开聊）",
            hint: "配置聊天平台、1 个主模型与基础功能，其余使用默认值（后续可在 WebUI 或对话中按需调整）",
          },
          {
            value: "full",
            label: "全量配置模式（9 步完整配置）",
            hint: "逐项决定所有槽位/思考等级、代理、上下文压缩、记忆、Web 与 Worker 设置",
          },
        ],
      }),
    ) as WizardMode);

  if (chosenMode === "full") {
    await runFullInitWizard(paths);
  } else {
    await runQuickInitWizard(paths);
  }
}

export async function runProviderAddWizard(paths: SetupPaths = DEFAULT_SETUP_PATHS): Promise<void> {
  if (!existsSync(paths.modelsConfigPath)) {
    p.log.warn(`未找到 ${paths.modelsConfigPath}，将直接进入初始化向导。`);
    await runInitWizard(paths);
    return;
  }

  const currentModels = loadModelsFileConfig(paths.modelsConfigPath);
  const existingEnv = readEnvMap(paths.envPath);
  const envUpdates: Record<string, string | undefined> = {};

  const existingSlugs = new Set(listProviderSlugs(currentModels.providers));

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

  let nextSlots = currentModels.slots;
  let nextThinking = currentModels.slot_thinking;
  if (updateSlots) {
    const res = await promptSlotsStep(
      nextProviders,
      currentModels.slots,
      currentModels.slot_thinking,
      { askThinking: false },
    );
    nextSlots = res.slots;
    nextThinking = res.slotThinking;
  }

  const nextModels: ModelsFileConfig = {
    slots: nextSlots,
    ...(nextThinking ? { slot_thinking: nextThinking } : {}),
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
  const { slots, slotThinking } = await promptSlotsStep(
    currentModels.providers,
    currentModels.slots,
    currentModels.slot_thinking,
    { askThinking: true },
  );
  const nextModels: ModelsFileConfig = {
    slots,
    ...(slotThinking ? { slot_thinking: slotThinking } : {}),
    providers: currentModels.providers,
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
    ? listProviderSlugs(loadModelsFileConfig(paths.modelsConfigPath).providers)
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
      `缺少配置文件（${paths.hatoConfigPath} 或 ${paths.modelsConfigPath}），请先执行 \`hato setup\` 完成初始化。`,
    );
    return;
  }
  await runConnectivityChecks(paths);
}

export async function runSetupWizard(
  args: string[] = process.argv.slice(2),
  paths: SetupPaths = DEFAULT_SETUP_PATHS,
): Promise<void> {
  const action = parseWizardCommand(args);

  if (action === "help") {
    console.log(formatSetupHelp());
    return;
  }

  p.intro("Hato 交互式配置向导");

  if (action === "quick") {
    await runQuickInitWizard(paths);
    p.outro("简易配置完成，运行 `bun run start`（或 `hato start`）启动 Hato。");
    return;
  }
  if (action === "full") {
    await runFullInitWizard(paths);
    p.outro("全量配置完成，运行 `bun run start`（或 `hato start`）启动 Hato。");
    return;
  }
  if (action === "init") {
    await runInitWizard(paths);
    p.outro("配置完成，运行 `bun run start`（或 `hato start`）启动 Hato。");
    return;
  }
  if (action === "provider-add") {
    await runProviderAddWizard(paths);
    p.outro("完成。");
    return;
  }
  if (action === "slots") {
    await runSlotsWizard(paths);
    p.outro("完成。");
    return;
  }
  if (action === "proxy") {
    await runProxyWizard(paths);
    p.outro("完成。");
    return;
  }
  if (action === "check") {
    await runCheckWizard(paths);
    p.outro("自检结束。");
    return;
  }

  const hasExisting = existsSync(paths.hatoConfigPath) && existsSync(paths.modelsConfigPath);
  if (!hasExisting) {
    p.log.info("检测到尚未创建 config/hato.toml 或 config/models.toml，将引导完成首次初始化。");
    await runInitWizard(paths);
    p.outro("初始化完成！可运行 `bun run start`（或 `hato start`）启动 Hato。");
    return;
  }

  const choice = guardCancel(
    await p.select({
      message: "检测到现有配置，请选择要执行的操作",
      options: [
        {
          value: "quick",
          label: "简易模式重新配置（3 步：聊天平台 + 主模型 + 基础功能）",
        },
        {
          value: "full",
          label: "全量配置向导（9 步：决定所有系统、模型、上下文、记忆与 Worker 设置）",
        },
        { value: "provider-add", label: "新增 / 更新 Provider 与模型（写入 <SLUG>_API_KEY）" },
        { value: "slots", label: "调整 6 角色模型槽位与思考等级 (slots)" },
        { value: "proxy", label: "修改 Scoped Proxy 按域代理规则" },
        { value: "check", label: "验证当前配置并测试网关 / 主模型 / 联网 / 记忆连通性" },
        { value: "exit", label: "退出" },
      ],
    }),
  );

  switch (choice) {
    case "quick":
      await runQuickInitWizard(paths);
      break;
    case "full":
      await runFullInitWizard(paths);
      break;
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
    default:
      break;
  }

  p.outro("已完成。");
}
