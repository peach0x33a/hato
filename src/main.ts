import { basename } from "node:path";
import { ActorLock, EventBus } from "./bus/actor-bus.js";
import { BrowserRuntime } from "./browser/runtime.js";
import { tryHandleSlashCommand } from "./commands/slash.js";
import {
  loadHatoConfig,
  resolveMemoryCuratorConfig,
  resolveMemoryEchoConfig,
  resolveMemoryProvider,
  resolveMemoryRecallConfig,
  resolveTavilySearchConfig,
  type HatoConfig,
} from "./config/app.js";
import { collectReloadDiff, fingerprintSecret, type ReloadSnapshot } from "./config/diff.js";
import { loadMcpConfig, type McpConfig } from "./config/mcp.js";
import { ModelRegistry } from "./config/models.js";
import { ScopedProxyRouter } from "./config/proxy.js";
import { getOptionalSecret, loadSecretEnv, reloadSecretEnv, requireSecret } from "./config/secrets.js";
import { ensureHatoHomeConfig } from "./config/paths.js";
import { bindQqHomeChannel, bindTelegramHomeChannel, writeHatoConfig } from "./config/store.js";
import { openDatabase } from "./db/client.js";
import { HatoRepository } from "./db/repo.js";
import { TicketCoordinator } from "./dispatch/coordinator.js";
import { NeutralRouter } from "./dispatch/router.js";
import { parseWorkerMandate } from "./dispatch/schema.js";
import { MessageDebouncer, mergeInboundBatches } from "./gateway/debouncer.js";
import { QqAdapter } from "./gateway/qq.js";
import { QqOpenApiClient } from "./gateway/qq-client.js";
import { TelegramAdapter } from "./gateway/tg.js";
import type { ChannelAdapter, ChannelName, InboundBatch } from "./gateway/types.js";
import { McpClientPool } from "./mcp/pool.js";
import { CompactionManager } from "./memory/compaction.js";
import { MemoryCurator } from "./memory/curator.js";
import { MemoryEchoStore } from "./memory/memoryecho.js";
import type { MemoryStore } from "./memory/store.js";
import { PersonaRuntime } from "./persona/agent.js";
import { probeTelegramGateway, updateTelegramBotProfile } from "./setup/probe.js";
import { logError, logInfo, logWarn, setLogTimezone, summarizeError } from "./utils/logger.js";
import { WebConsoleServer } from "./web-console/server.js";
import { WorkerDispatcher } from "./worker/backend.js";
import { BuiltinPiRunner } from "./worker/builtin-pi.js";
import { ExternalCliRunner } from "./worker/external-cli.js";

const APP_PATHS = ensureHatoHomeConfig();
const HATO_CONFIG_PATH = APP_PATHS.hatoConfigPath;
const MODELS_CONFIG_PATH = APP_PATHS.modelsConfigPath;
const MCP_CONFIG_PATH = APP_PATHS.mcpConfigPath;

async function main(): Promise<void> {
  loadSecretEnv(APP_PATHS.envPath);

  let hatoConfig = loadHatoConfig(HATO_CONFIG_PATH);
  setLogTimezone(hatoConfig.owner.timezone);
  const proxyRouter = new ScopedProxyRouter(hatoConfig.network?.proxies ?? []);
  proxyRouter.installGlobalFetchHook();

  const dbHandle = openDatabase(hatoConfig.paths.sqlite);
  const repo = new HatoRepository(dbHandle.db);

  repo.ensureOwner({
    canonicalUserId: hatoConfig.owner.canonical_user_id,
    tgUserId: hatoConfig.owner.channels.tg.user_ids[0]
      ? String(hatoConfig.owner.channels.tg.user_ids[0])
      : null,
    qqOpenId: hatoConfig.owner.channels.qq.open_ids[0] ?? null,
    timezone: hatoConfig.owner.timezone,
    proactiveChannel: hatoConfig.owner.proactive_channel,
  });

  const modelRegistry = new ModelRegistry(MODELS_CONFIG_PATH, repo);
  let mcpConfig: McpConfig = loadMcpConfig(MCP_CONFIG_PATH);
  const mcpPool = new McpClientPool(proxyRouter);
  await mcpPool.syncConfig(mcpConfig, { eagerZones: ["personal"] });
  const browserRuntime = new BrowserRuntime(hatoConfig, modelRegistry, proxyRouter, undefined, repo);
  let memoryStore = buildMemoryStore(hatoConfig, proxyRouter, repo);
  const personaRuntime = new PersonaRuntime(
    hatoConfig,
    modelRegistry,
    proxyRouter,
    repo,
    browserRuntime,
    memoryStore,
    HATO_CONFIG_PATH,
    mcpPool,
  );
  const memoryCurator = new MemoryCurator(
    hatoConfig,
    modelRegistry,
    proxyRouter,
    repo,
    memoryStore,
  );
  const actorLock = new ActorLock();
  const bus = new EventBus();

  const neutralRouter = new NeutralRouter({
    getHatoConfig: () => hatoConfig,
    getMcpConfig: () => mcpConfig,
    modelRegistry,
    proxyRouter,
    repo,
    getMemoryStore: () => memoryStore,
  });
  const builtinRunner = new BuiltinPiRunner({
    getHatoConfig: () => hatoConfig,
    modelRegistry,
    proxyRouter,
    repo,
    mcpPool,
  });
  const externalRunner = new ExternalCliRunner({
    getHatoConfig: () => hatoConfig,
    getMcpConfig: () => mcpConfig,
    proxyRouter,
  });
  const workerDispatcher = new WorkerDispatcher(builtinRunner, externalRunner);
  const ticketCoordinator = new TicketCoordinator({
    getHatoConfig: () => hatoConfig,
    repo,
    router: neutralRouter,
    dispatcher: workerDispatcher,
    bus,
  });
  personaRuntime.setDelegateHandler((input) => ticketCoordinator.enqueueDelegation(input));
  personaRuntime.setSendFileHandler(async ({ channel, path, caption }) => {
    if (channel === "web") {
      return {
        ok: false,
        message: `Web Console 暂不支持直接发送文件附件，本地路径为: ${path}`,
      };
    }
    const outbound = resolveOutboundTarget(channel);
    if (!outbound?.adapter.sendFile) {
      return {
        ok: false,
        message: `${channel.toUpperCase()} 网关未就绪或未绑定 owner，无法发送文件: ${path}`,
      };
    }
    await outbound.adapter.sendFile(outbound.targetId, path, basename(path), caption);
    return {
      ok: true,
      message: `已发送文件到 ${outbound.channel.toUpperCase()}: ${basename(path)}`,
    };
  });
  personaRuntime.setBotProfileHandler(async (input) => {
    if (input.platform === "tg") {
      const botToken = getOptionalSecret(hatoConfig.gateway.telegram.bot_token_env);
      if (!botToken) {
        return { ok: false, message: `未配置环境变量 ${hatoConfig.gateway.telegram.bot_token_env}` };
      }
      if (input.action === "inspect") {
        const me = await probeTelegramGateway({
          baseUrl: hatoConfig.gateway.telegram.base_url,
          botToken,
          proxyRouter,
        });
        if (!me.ok) {
          return { ok: false, message: me.error ?? "获取 Telegram 机器人信息失败" };
        }
        return {
          ok: true,
          message: `Telegram 机器人: ${me.firstName ?? ""} (@${me.username ?? ""}), botId=${me.botId ?? ""}`,
          details: { botId: me.botId, username: me.username, firstName: me.firstName },
        };
      }
      const res = await updateTelegramBotProfile({
        baseUrl: hatoConfig.gateway.telegram.base_url,
        botToken,
        proxyRouter,
        name: input.name,
        description: input.description,
        shortDescription: input.shortDescription,
        avatarPath: input.avatarPath,
        removeAvatar: input.action === "remove_avatar",
      });
      if (!res.ok) {
        return { ok: false, message: res.error ?? "修改 Telegram 机器人资料失败" };
      }
      webConsoleServer?.invalidateBotProfileCache("tg");
      return {
        ok: true,
        message:
          res.updated.length > 0
            ? `已更新 Telegram 机器人资料: ${res.updated.join(", ")}`
            : "未提供需要修改的字段",
        details: { updated: res.updated },
      };
    }

    // QQ Official Bot
    const appId = hatoConfig.gateway.qq.app_id.trim();
    const clientSecret = getOptionalSecret(hatoConfig.gateway.qq.client_secret_env);
    if (!appId || !clientSecret) {
      return {
        ok: false,
        message: `未配置 QQ app_id 或环境变量 ${hatoConfig.gateway.qq.client_secret_env}`,
      };
    }
    if (input.action === "inspect") {
      try {
        const client = new QqOpenApiClient({
          baseUrl: hatoConfig.gateway.qq.base_url,
          appId,
          clientSecret,
          proxyRouter,
        });
        const me = await client.getMe();
        return {
          ok: true,
          message: `QQ 机器人: ${me.username ?? ""} (id=${me.id ?? appId})`,
          details: { id: me.id, username: me.username, avatar: me.avatar },
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
    return {
      ok: false,
      message:
        "QQ 开放平台 OpenAPI v2 暂未提供修改机器人名称或头像的接口，需前往 QQ 开放平台控制台（q.qq.com）修改并提交审核。",
    };
  });

  const compactionManager = new CompactionManager(
    {
      hotMessagesHighWatermark: hatoConfig.context.hot_messages_high_watermark,
      hotMessagesKeepAfterCompact: hatoConfig.context.hot_messages_keep_after_compact,
      minMessagesToCompact: hatoConfig.context.min_messages_to_compact,
      preCompactAfterMinutes: hatoConfig.context.pre_compact_after_minutes,
      idleCommitAfterMinutes: hatoConfig.context.idle_commit_after_minutes,
    },
    repo,
    actorLock,
    {
      summarizeBlock: (params) => personaRuntime.summarizeBlockWithWarmPrefix(params),
      ensureRetained: async (canonicalUserId, messages) => {
        await memoryCurator.retainBeforeCompaction(canonicalUserId, messages);
      },
    },
  );

  let tgAdapter: TelegramAdapter | null = null;
  let qqAdapter: QqAdapter | null = null;
  let webConsoleServer: WebConsoleServer | null = null;

  const debouncer = new MessageDebouncer(hatoConfig.gateway.debounce_ms, (batch) => {
    void bus.emit({ type: "user_batch", batch });
  });

  const reloadAll = async () => {
    const prevSnapshot = captureReloadSnapshot(hatoConfig, modelRegistry, personaRuntime);

    reloadSecretEnv();
    const nextConfig = loadHatoConfig(HATO_CONFIG_PATH);
    setLogTimezone(nextConfig.owner.timezone);
    modelRegistry.reload();
    proxyRouter.reload(nextConfig.network?.proxies ?? []);
    hatoConfig = nextConfig;
    debouncer.updateDelay(nextConfig.gateway.debounce_ms);
    compactionManager.updateConfig({
      hotMessagesHighWatermark: nextConfig.context.hot_messages_high_watermark,
      hotMessagesKeepAfterCompact: nextConfig.context.hot_messages_keep_after_compact,
      minMessagesToCompact: nextConfig.context.min_messages_to_compact,
      preCompactAfterMinutes: nextConfig.context.pre_compact_after_minutes,
      idleCommitAfterMinutes: nextConfig.context.idle_commit_after_minutes,
    });
    memoryStore = buildMemoryStore(nextConfig, proxyRouter, repo, memoryStore);
    mcpConfig = loadMcpConfig(MCP_CONFIG_PATH);
    await mcpPool.syncConfig(mcpConfig, { eagerZones: ["personal"] });
    personaRuntime.updateConfig(nextConfig, memoryStore);
    memoryCurator.updateConfig(nextConfig, memoryStore);
    tgAdapter?.updateConfig(nextConfig);
    qqAdapter?.updateConfig(nextConfig);

    const nextSnapshot = captureReloadSnapshot(nextConfig, modelRegistry, personaRuntime);
    const changes = collectReloadDiff(prevSnapshot, nextSnapshot);

    return {
      slots: modelRegistry.listSlots().map((s) => ({
        slot: s.slot,
        target: s.target,
        api: String(s.model.api),
        baseUrl: s.model.baseUrl,
      })),
      proxyCount: nextConfig.network?.proxies?.length ?? 0,
      changes,
    };
  };

  personaRuntime.setReloadHandler(async () => {
    await reloadAll();
  });

  const buildSlashDeps = (
    canonicalUserId: string,
    platformInfo?: { channel: "tg" | "qq" | "web"; platformUserId: string },
  ) => ({
    repo,
    listModelSlots: () =>
      modelRegistry.listSlots().map((s) => ({
        slot: s.slot,
        target: s.target,
        api: String(s.model.api),
        baseUrl: s.model.baseUrl,
      })),
    listAvailableModels: () => modelRegistry.listTargets(),
    setModelSlot: (slot: string, target: string) => {
      const updated = modelRegistry.setSlotOverride(slot, target);
      return {
        slot: updated.slot,
        target: updated.target,
        api: String(updated.model.api),
        baseUrl: updated.model.baseUrl,
      };
    },
    reloadAll,
    forceCompact: (uid: string) => compactionManager.runIdleCommit(uid),
    resetContext: async (uid: string) => {
      debouncer.discardUser(uid);
      queuedBatchesByUser.delete(uid);
      return actorLock.run(uid, async () => {
        compactionManager.resetUser(uid);
        await memoryCurator.retainPending(uid).catch((err) => {
          logError("CURATOR", `pre-reset retain failed for ${uid}`, err);
        });
        const res = repo.resetWorkingContext(uid);
        personaRuntime.resetSession();
        return res;
      });
    },
    getMemoryStatus: async (uid: string) => {
      const provider = resolveMemoryProvider(hatoConfig);
      const recallCfg = resolveMemoryRecallConfig(hatoConfig);
      const curatorCfg = resolveMemoryCuratorConfig(hatoConfig);
      const [personaVault, techVault, usage] = memoryStore
        ? await Promise.all([
            memoryStore.resolveVaultId(uid, "persona", { createIfMissing: false }).catch(() => null),
            memoryStore.resolveVaultId(uid, "tech", { createIfMissing: false }).catch(() => null),
            memoryStore.getUsage?.().catch(() => null) ?? Promise.resolve(null),
          ])
        : [null, null, null];
      return {
        provider,
        configured: Boolean(memoryStore?.isConfigured()),
        recallMode: recallCfg.mode,
        curatorEnabled: curatorCfg.enabled,
        vaultIds: { persona: personaVault, tech: techVault },
        usage,
      };
    },
    syncMemory: (uid: string, opts?: { includeDenied?: boolean }) =>
      memoryCurator.retainPending(uid, { includeDeniedRetries: opts?.includeDenied ?? true }),
    forgetMemory: (uid: string, query: string) => memoryCurator.forgetByQuery(uid, query),
    ...(platformInfo?.channel === "tg"
      ? {
          setHomeChannel: async () => {
            const bound = bindTelegramHomeChannel({
              hatoConfigPath: HATO_CONFIG_PATH,
              repo,
              canonicalUserId,
              tgUserId: platformInfo.platformUserId,
              currentConfig: hatoConfig,
            });
            hatoConfig = bound.updatedConfig;
            personaRuntime.updateConfig(hatoConfig);
            tgAdapter?.updateConfig(hatoConfig);
            return {
              channel: platformInfo.channel,
              targetId: platformInfo.platformUserId,
              addedToWhitelist: bound.addedToWhitelist,
              savedToConfig: bound.savedToConfig,
            };
          },
        }
      : {}),
  });

  const queuedBatchesByUser = new Map<string, InboundBatch[]>();

  bus.on("user_batch", async ({ batch }) => {
    const uid = batch.canonicalUserId;
    const queue = queuedBatchesByUser.get(uid) ?? [];
    queue.push(batch);
    queuedBatchesByUser.set(uid, queue);
    if (queue.length > 1) {
      // Another batch is already scheduled/waiting for actorLock; it will drain and merge this batch.
      return;
    }

    await actorLock.run(uid, async () => {
      const drained = queuedBatchesByUser.get(uid) ?? [];
      queuedBatchesByUser.delete(uid);
      if (drained.length === 0) return;

      const mergedBatch = mergeInboundBatches(drained);
      const adapter: ChannelAdapter | null =
        mergedBatch.originChannel === "qq" ? qqAdapter : tgAdapter;
      if (!adapter) return;
      const targetId = mergedBatch.originPlatformUserId;

      const routedToTicket = await ticketCoordinator
        .tryRouteInboundToTicket(mergedBatch)
        .catch(() => ({ handledByTicket: false as const }));
      if (routedToTicket.handledByTicket) {
        return;
      }

      await adapter.sendTyping?.(targetId).catch(() => undefined);

      const hasNewerQueuedInput = () =>
        debouncer.hasPending(uid) || (queuedBatchesByUser.get(uid)?.length ?? 0) > 0;

      let bubblesToSend: string[];
      let superseded = false;
      try {
        const output = await personaRuntime.handleUserBatch(mergedBatch, mergedBatch.images ?? [], {
          sendPhotoToUser: adapter.sendPhoto
            ? (photo, caption) => adapter.sendPhoto!(targetId, photo, caption)
            : undefined,
          shouldSuppressSend: hasNewerQueuedInput,
          sendBubblesToUser: async (earlyBubbles) => {
            if (earlyBubbles.length === 0 || hasNewerQueuedInput()) return;
            await adapter.sendBubbles(
              targetId,
              earlyBubbles,
              hatoConfig.gateway.bubbles.delay_ms_range,
            );
            await adapter.sendTyping?.(targetId).catch(() => undefined);
          },
        });
        bubblesToSend = output.bubbles;
        superseded = output.superseded;
      } catch (err) {
        const msg = summarizeError(err);
        logError("PERSONA", "turn failed", err);
        await adapter
          .sendText(targetId, `处理刚才这条消息时出错了：${msg}`)
          .catch(() => undefined);
        return;
      }

      if (superseded) {
        logInfo("PERSONA", `superseded stale reply for ${uid}; re-thinking with newer message`);
        return;
      }

      try {
        if (bubblesToSend.length > 0) {
          await adapter.sendBubbles(
            targetId,
            bubblesToSend,
            hatoConfig.gateway.bubbles.delay_ms_range,
          );
        }
        compactionManager.recordInteraction(uid);
        memoryCurator.recordInteraction(uid);
        void compactionManager.checkHighWatermark(uid).catch((err) => {
          logError("COMPACTION", "high-watermark check failed", err);
        });
      } catch (err) {
        logError(mergedBatch.originChannel.toUpperCase(), "outbound send failed after retries", err);
      }
    });
  });

  const resolveTgTarget = (): string | null => {
    const first = hatoConfig.owner.channels.tg.user_ids[0];
    return first !== undefined ? String(first) : null;
  };

  const resolveQqTarget = (): string | null => {
    const first = hatoConfig.owner.channels.qq.open_ids[0];
    return first !== undefined ? String(first) : null;
  };

  const resolveOutboundTarget = (
    preferredChannel?: ChannelName,
  ): { channel: "tg" | "qq"; adapter: ChannelAdapter; targetId: string } | null => {
    const tgTargetId = resolveTgTarget();
    const qqTargetId = resolveQqTarget();

    if (preferredChannel === "qq") {
      if (qqAdapter && qqTargetId) {
        return { channel: "qq", adapter: qqAdapter, targetId: qqTargetId };
      }
      if (hatoConfig.gateway.qq.fallback_channel === "tg" && tgAdapter && tgTargetId) {
        return { channel: "tg", adapter: tgAdapter, targetId: tgTargetId };
      }
      return null;
    }

    if (tgAdapter && tgTargetId) {
      return { channel: "tg", adapter: tgAdapter, targetId: tgTargetId };
    }
    if (qqAdapter && qqTargetId) {
      return { channel: "qq", adapter: qqAdapter, targetId: qqTargetId };
    }
    return null;
  };

  bus.on("ticket_result", async ({ canonicalUserId, originChannel, briefTitle, result }) => {
    const outbound = originChannel === "web" ? null : resolveOutboundTarget(originChannel);
    const deliveryChannel: ChannelName = outbound ? outbound.channel : "web";

    await actorLock.run(canonicalUserId, async () => {
      const caveatText =
        result.caveats.length > 0 ? `\n需要注意：${result.caveats.join("；")}` : "";
      const secretsNote =
        result.required_secrets.length > 0
          ? `\n所需环境变量密钥（勿发聊天窗口，请在 .env 配置）：${result.required_secrets.join(", ")}`
          : "";
      const artifactNames =
        result.artifacts.length > 0
          ? `\n生成文件（如需发给用户可调用 send_file）：${result.artifacts.map((a) => `${a.filename} (${a.path})`).join(", ")}`
          : "";
      const summary = `[工单 ${result.ticket_id} · ${briefTitle}] (${result.status}): ${result.narration_hint}${caveatText}${secretsNote}`;

      const bubbles = await personaRuntime.narrateBackgroundEvent({
        canonicalUserId,
        channel: deliveryChannel,
        eventSummary: summary,
        promptInstruction: `[系统事件：后台任务 "${briefTitle}" (${result.ticket_id}) 已结束，状态=${result.status}。请用自然日常口吻直接告诉用户结果要点（除非出错或用户要求，不要主动报工单号，也不要倾倒冗长执行日志）：${result.narration_hint}${artifactNames}${caveatText}${secretsNote}]`,
      });
      if (outbound) {
        await outbound.adapter.sendBubbles(
          outbound.targetId,
          bubbles,
          hatoConfig.gateway.bubbles.delay_ms_range,
        );
      }

      // Wall 3: only send failure diagnostics or explicit code/diff blocks unprompted;
      // prose "执行输出详情" reports stay in DB / trace for on-demand inspection via inspect_tickets.
      const webVerbatimParts: string[] = [];
      for (const block of result.verbatim_blocks) {
        const shouldAutoEmit =
          result.status !== "done" ||
          block.format === "code" ||
          block.title.includes("git diff");
        if (!shouldAutoEmit) continue;
        const text =
          block.format === "code"
            ? `**${block.title}**\n\`\`\`\n${block.content}\n\`\`\``
            : `**${block.title}**\n${block.content}`;
        webVerbatimParts.push(text);
        if (outbound) {
          await outbound.adapter.sendText(outbound.targetId, text);
        }
      }
      const ticketRow = repo.getTicket(result.ticket_id);
      const deliverFiles = Boolean(
        parseWorkerMandate(ticketRow?.mandateJson ?? null)?.deliver_files,
      );
      for (const artifact of result.artifacts) {
        if (outbound?.adapter.sendFile && (artifact.send_as === "photo" || deliverFiles)) {
          await outbound.adapter
            .sendFile(outbound.targetId, artifact.path, artifact.filename)
            .catch((err) => {
              logWarn(
                outbound.channel.toUpperCase(),
                `failed to send artifact ${artifact.filename}: ${summarizeError(err)}`,
              );
            });
        }
      }

      if (!outbound && webVerbatimParts.length > 0) {
        repo.appendRawMessage({
          canonicalUserId,
          channel: deliveryChannel,
          role: "assistant",
          content: webVerbatimParts.join("\n\n"),
          createdAt: Date.now(),
        });
        personaRuntime.refreshTranscriptFromDb();
      }
    });
  });

  bus.on("ticket_needs_input", async ({ canonicalUserId, originChannel, ticketId, briefTitle, question }) => {
    const outbound = originChannel === "web" ? null : resolveOutboundTarget(originChannel);
    const deliveryChannel: ChannelName = outbound ? outbound.channel : "web";

    await actorLock.run(canonicalUserId, async () => {
      const bubbles = await personaRuntime.narrateBackgroundEvent({
        canonicalUserId,
        channel: deliveryChannel,
        eventSummary: `工单 ${ticketId} (${briefTitle}) 需要补充信息: ${question}`,
        promptInstruction: `[系统事件：后台工单 "${briefTitle}" (${ticketId}) 需要用户补充以下信息后继续：${question}。请自然转达给用户。]`,
      });
      if (outbound) {
        await outbound.adapter.sendBubbles(
          outbound.targetId,
          bubbles,
          hatoConfig.gateway.bubbles.delay_ms_range,
        );
      }
    });
  });

  bus.on("ticket_confirm_required", async ({ canonicalUserId, originChannel, ticketId, briefTitle, promptText }) => {
    const outbound = originChannel === "web" ? null : resolveOutboundTarget(originChannel);
    if (outbound?.adapter.sendConfirm) {
      await outbound.adapter.sendConfirm(outbound.targetId, {
        ticketId,
        promptText: `工单 ${ticketId} (${briefTitle}) 请求确认高危操作：\n${promptText}`,
      });
      return;
    }
    await actorLock.run(canonicalUserId, async () => {
      repo.appendRawMessage({
        canonicalUserId,
        channel: originChannel === "web" || !outbound ? "web" : outbound.channel,
        role: "executed_event",
        content: `[工单 ${ticketId} · ${briefTitle}] 等待确认执行：${promptText}`,
        createdAt: Date.now(),
      });
      personaRuntime.refreshTranscriptFromDb();
    });
  });

  bus.on("executed_event", async ({ canonicalUserId, channel, summary, occurredAtMs, silent }) => {
    repo.appendRawMessage({
      canonicalUserId,
      channel,
      role: "executed_event",
      content: summary,
      createdAt: occurredAtMs,
    });
    const outbound = channel === "web" ? null : resolveOutboundTarget(channel);
    if (!silent && outbound) {
      await outbound.adapter.sendText(outbound.targetId, summary).catch(() => undefined);
    }
  });

  const ensureTelegramStarted = async () => {
    if (tgAdapter) return;
    if (hatoConfig.owner.channels.tg.user_ids.length === 0) {
      const pairingCode = repo.getOrCreateHomePairingCode();
      logInfo(
        "TG",
        `owner.channels.tg.user_ids 为空，尚未绑定主人。请在 Telegram 私聊 Bot 发送: /sethome ${pairingCode}`,
      );
    } else {
      repo.deleteRuntimeSetting("home_pairing_code");
    }

    const botToken = requireSecret(hatoConfig.gateway.telegram.bot_token_env, "Telegram gateway");
    tgAdapter = new TelegramAdapter({
      config: hatoConfig,
      botToken,
      proxyRouter,
      onConfirmAction: (ticketId, approved) =>
        ticketCoordinator.handleConfirmAction(ticketId, approved),
      onClaimHome: async ({ platformUserId, code, username }) => {
        if (!repo.verifyAndConsumeHomePairingCode(code)) {
          return {
            ok: false,
            reply: "配对码无效或已过期，请核对启动终端中显示的 `/sethome <配对码>`。",
          };
        }
        const bound = bindTelegramHomeChannel({
          hatoConfigPath: HATO_CONFIG_PATH,
          repo,
          canonicalUserId: hatoConfig.owner.canonical_user_id,
          tgUserId: platformUserId,
          currentConfig: hatoConfig,
        });
        hatoConfig = bound.updatedConfig;
        personaRuntime.updateConfig(hatoConfig);
        tgAdapter?.updateConfig(hatoConfig);
        logInfo(
          "TG",
          `owner paired via /sethome: tgUserId=${platformUserId}${username ? ` (@${username})` : ""}`,
        );
        return {
          ok: true,
          reply: [
            `认领成功！已绑定主人 Telegram ID \`${platformUserId}\`，并将当前私聊设为 Home Channel。`,
            bound.savedToConfig ? "已自动同步写入 `config/hato.toml`（原配置已备份为 `.bak`）。" : "",
            "现在可以直接开始聊天，或发送 `/help` 查看系统指令。",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      },
      onInboundMessage: async (msg) => {
        if (msg.text.trim().startsWith("/")) {
          const reply = await tryHandleSlashCommand(
            msg.canonicalUserId,
            msg.text,
            buildSlashDeps(msg.canonicalUserId, {
              channel: msg.channel,
              platformUserId: msg.platformUserId,
            }),
          );

          if (reply !== null) {
            await tgAdapter?.sendText(msg.platformUserId, reply, msg.platformMsgId);
            return;
          }
        }

        const interrupt = personaRuntime.handleIncomingDuringActiveTurn(msg);
        if (interrupt.action === "steered") {
          if (interrupt.shouldSendAck) {
            void tgAdapter?.sendText(msg.platformUserId, "知道了").catch((err) => {
              logWarn("TG", `failed to send steer ack: ${summarizeError(err)}`);
            });
          }
          return;
        }

        debouncer.enqueue(msg);
      },
    });

    await tgAdapter.start();
  };

  if (hatoConfig.gateway.telegram.enabled) {
    await ensureTelegramStarted();
  }

  const ensureQqStarted = async () => {
    if (qqAdapter) return;
    if (hatoConfig.owner.channels.qq.open_ids.length === 0) {
      const pairingCode = repo.getOrCreateHomePairingCode();
      logInfo(
        "QQ",
        `owner.channels.qq.open_ids 为空，尚未绑定主人。请在 QQ 私聊机器人发送: /sethome ${pairingCode}`,
      );
    }
    const appId = hatoConfig.gateway.qq.app_id.trim();
    if (!appId) {
      throw new Error("QQ gateway is enabled, but gateway.qq.app_id is empty in config/hato.toml.");
    }
    const clientSecret = requireSecret(hatoConfig.gateway.qq.client_secret_env, "QQ gateway");
    qqAdapter = new QqAdapter({
      config: hatoConfig,
      appId,
      clientSecret,
      proxyRouter,
      onClaimHome: async ({ platformUserId, code }) => {
        if (!repo.verifyAndConsumeHomePairingCode(code)) {
          return {
            ok: false,
            reply: "配对码无效或已过期，请核对启动终端中显示的 /sethome <配对码>。",
          };
        }
        const bound = bindQqHomeChannel({
          hatoConfigPath: HATO_CONFIG_PATH,
          repo,
          canonicalUserId: hatoConfig.owner.canonical_user_id,
          qqOpenId: platformUserId,
          currentConfig: hatoConfig,
        });
        hatoConfig = bound.updatedConfig;
        personaRuntime.updateConfig(hatoConfig);
        qqAdapter?.updateConfig(hatoConfig);
        logInfo("QQ", `owner paired via /sethome: qqOpenId=${platformUserId}`);
        return {
          ok: true,
          reply: [
            `认领成功！已绑定主人 QQ OpenID ${platformUserId}，并将当前私聊设为 Home Channel。`,
            bound.savedToConfig ? "已同步写入 config/hato.toml。" : "",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      },
      onInboundMessage: async (msg) => {
        if (msg.text.trim().startsWith("/")) {
          const reply = await tryHandleSlashCommand(
            msg.canonicalUserId,
            msg.text,
            buildSlashDeps(msg.canonicalUserId, {
              channel: msg.channel,
              platformUserId: msg.platformUserId,
            }),
          );
          if (reply !== null) {
            await qqAdapter?.sendText(msg.platformUserId, reply, msg.platformMsgId);
            return;
          }
        }

        const interrupt = personaRuntime.handleIncomingDuringActiveTurn(msg);
        if (interrupt.action === "steered") {
          if (interrupt.shouldSendAck) {
            void qqAdapter?.sendText(msg.platformUserId, "知道了", msg.platformMsgId).catch((err) => {
              logWarn("QQ", `failed to send steer ack: ${summarizeError(err)}`);
            });
          }
          return;
        }

        debouncer.enqueue(msg);
      },
    });

    await qqAdapter.start();
  };

  if (hatoConfig.gateway.qq.enabled) {
    await ensureQqStarted();
  }

  webConsoleServer = new WebConsoleServer({
    hatoConfigPath: HATO_CONFIG_PATH,
    modelsConfigPath: MODELS_CONFIG_PATH,
    envPath: APP_PATHS.envPath,
    getConfig: () => hatoConfig,
    getModelRegistry: () => modelRegistry,
    getProxyRouter: () => proxyRouter,
    getRepo: () => repo,
    getPersonaRuntime: () => personaRuntime,
    getBrowserRuntime: () => browserRuntime,
    getCompactionManager: () => compactionManager,
    getMemoryCurator: () => memoryCurator,
    getTicketCoordinator: () => ticketCoordinator,
    getActorLock: () => actorLock,
    getSlashDeps: (uid) => buildSlashDeps(uid),
    reloadAll,
    getGatewayStatus: () => ({
      telegram: {
        enabled: hatoConfig.gateway.telegram.enabled,
        ...(tgAdapter ? tgAdapter.getStatus() : { running: false, online: false }),
      },
      qq: {
        enabled: hatoConfig.gateway.qq.enabled,
        ...(qqAdapter ? qqAdapter.getStatus() : { running: false, online: false }),
      },
    }),
    toggleGateway: async (channel, enabled) => {
      try {
        const nextConfig: HatoConfig = {
          ...hatoConfig,
          gateway: {
            ...hatoConfig.gateway,
            ...(channel === "tg"
              ? { telegram: { ...hatoConfig.gateway.telegram, enabled } }
              : { qq: { ...hatoConfig.gateway.qq, enabled } }),
          },
        };
        if (enabled) {
          hatoConfig = nextConfig;
          if (channel === "tg") {
            await ensureTelegramStarted();
          } else {
            await ensureQqStarted();
          }
        } else {
          hatoConfig = nextConfig;
          if (channel === "tg" && tgAdapter) {
            await tgAdapter.stop();
            tgAdapter = null;
          } else if (channel === "qq" && qqAdapter) {
            await qqAdapter.stop();
            qqAdapter = null;
          }
        }
        writeHatoConfig(HATO_CONFIG_PATH, nextConfig, { backup: true });
        personaRuntime.updateConfig(hatoConfig);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  await webConsoleServer.start();

  const shutdown = async () => {
    logInfo("HATO", "shutting down...");
    debouncer.dispose();
    compactionManager.dispose();
    memoryCurator.dispose();
    await browserRuntime.dispose();
    await mcpPool.closeAll();
    await webConsoleServer?.stop();
    await tgAdapter?.stop();
    await qqAdapter?.stop();
    proxyRouter.uninstallGlobalFetchHook();
    dbHandle.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function captureReloadSnapshot(
  config: HatoConfig,
  modelRegistry: ModelRegistry,
  personaRuntime: PersonaRuntime,
): ReloadSnapshot {
  const envNames = new Set<string>([
    config.gateway.telegram.bot_token_env,
    config.gateway.qq.client_secret_env,
    resolveTavilySearchConfig(config).apiKeyEnv,
    resolveMemoryEchoConfig(config).apiKeyEnv,
    ...modelRegistry.listProviders().map((p) => p.apiKeyEnv),
  ]);
  const secretFingerprints: Record<string, string> = {};
  for (const name of envNames) {
    if (name.trim()) {
      secretFingerprints[name] = fingerprintSecret(process.env[name]);
    }
  }

  return {
    hatoConfig: config,
    slots: modelRegistry.listSlots().map((s) => ({
      slot: s.slot,
      target: s.target,
      api: String(s.model.api),
      baseUrl: s.model.baseUrl,
      reasoning: s.model.reasoning,
      input: s.model.input,
    })),
    availableTargets: modelRegistry.listTargets(),
    promptText: personaRuntime.getBasePersonaPrompt(),
    secretFingerprints,
  };
}

main().catch((err) => {
  logError("HATO", "fatal startup error", err);
  process.exit(1);
});

function buildMemoryStore(
  config: HatoConfig,
  proxyRouter: ScopedProxyRouter,
  repo: HatoRepository,
  existing?: MemoryStore | null,
): MemoryStore | null {
  const provider = resolveMemoryProvider(config);
  if (provider === "memoryecho") {
    const meConfig = resolveMemoryEchoConfig(config);
    if (existing instanceof MemoryEchoStore) {
      existing.updateConfig(meConfig);
      return existing;
    }
    return new MemoryEchoStore(meConfig, proxyRouter, repo);
  }
  if (provider === "hindsight") {
    logInfo("MEMORY", "memory.provider = hindsight 暂未实现，长期记忆处于未激活状态");
  }
  return null;
}
