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
import { loadSecretEnv, reloadSecretEnv, requireSecret } from "./config/secrets.js";
import { bindTelegramHomeChannel } from "./config/store.js";
import { openDatabase } from "./db/client.js";
import { HatoRepository } from "./db/repo.js";
import { TicketCoordinator } from "./dispatch/coordinator.js";
import { NeutralRouter } from "./dispatch/router.js";
import { parseWorkerMandate } from "./dispatch/schema.js";
import { MessageDebouncer, mergeInboundBatches } from "./gateway/debouncer.js";
import { TelegramAdapter } from "./gateway/tg.js";
import type { ChannelName, InboundBatch } from "./gateway/types.js";
import { McpClientPool } from "./mcp/pool.js";
import { CompactionManager } from "./memory/compaction.js";
import { MemoryCurator } from "./memory/curator.js";
import { MemoryEchoStore } from "./memory/memoryecho.js";
import type { MemoryStore } from "./memory/store.js";
import { PersonaRuntime } from "./persona/agent.js";
import { logError, logInfo, logWarn, setLogTimezone, summarizeError } from "./utils/logger.js";
import { WebConsoleServer } from "./web-console/server.js";
import { WorkerDispatcher } from "./worker/backend.js";
import { BuiltinPiRunner } from "./worker/builtin-pi.js";
import { ExternalCliRunner } from "./worker/external-cli.js";

const HATO_CONFIG_PATH = "config/hato.toml";
const MODELS_CONFIG_PATH = "config/models.toml";
const MCP_CONFIG_PATH = "config/mcp.toml";

async function main(): Promise<void> {
  loadSecretEnv();

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
    const tgTargetId = resolveTgTarget();
    if (channel === "web") {
      return {
        ok: false,
        message: `Web Console 暂不支持直接发送文件附件，本地路径为: ${path}`,
      };
    }
    if (!tgAdapter || !tgTargetId) {
      return {
        ok: false,
        message: `Telegram 网关未就绪或未绑定 owner，无法发送文件: ${path}`,
      };
    }
    await tgAdapter.sendFile(tgTargetId, path, basename(path), caption);
    return { ok: true, message: `已发送文件到 Telegram: ${basename(path)}` };
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
      if (drained.length === 0 || !tgAdapter) return;

      const mergedBatch = mergeInboundBatches(drained);
      const tgTargetId = mergedBatch.originPlatformUserId;

      const routedToTicket = await ticketCoordinator
        .tryRouteInboundToTicket(mergedBatch)
        .catch(() => ({ handledByTicket: false as const }));
      if (routedToTicket.handledByTicket) {
        return;
      }

      await tgAdapter.sendTyping(tgTargetId).catch(() => undefined);

      const hasNewerQueuedInput = () =>
        debouncer.hasPending(uid) || (queuedBatchesByUser.get(uid)?.length ?? 0) > 0;

      let bubblesToSend: string[];
      let superseded = false;
      try {
        const output = await personaRuntime.handleUserBatch(mergedBatch, mergedBatch.images ?? [], {
          sendPhotoToUser: (photo, caption) => tgAdapter!.sendPhoto(tgTargetId, photo, caption),
          shouldSuppressSend: hasNewerQueuedInput,
          sendBubblesToUser: async (earlyBubbles) => {
            if (earlyBubbles.length === 0 || hasNewerQueuedInput()) return;
            await tgAdapter!.sendBubbles(
              tgTargetId,
              earlyBubbles,
              hatoConfig.gateway.bubbles.delay_ms_range,
            );
            await tgAdapter!.sendTyping(tgTargetId).catch(() => undefined);
          },
        });
        bubblesToSend = output.bubbles;
        superseded = output.superseded;
      } catch (err) {
        const msg = summarizeError(err);
        logError("PERSONA", "turn failed", err);
        await tgAdapter
          .sendText(tgTargetId, `处理刚才这条消息时出错了：${msg}`)
          .catch(() => undefined);
        return;
      }

      if (superseded) {
        logInfo("PERSONA", `superseded stale reply for ${uid}; re-thinking with newer message`);
        return;
      }

      try {
        if (bubblesToSend.length > 0) {
          await tgAdapter.sendBubbles(
            tgTargetId,
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
        logError("TG", "outbound send failed after retries", err);
      }
    });
  });

  const resolveTgTarget = (): string | null => {
    const first = hatoConfig.owner.channels.tg.user_ids[0];
    return first !== undefined ? String(first) : null;
  };

  bus.on("ticket_result", async ({ canonicalUserId, originChannel, briefTitle, result }) => {
    const tgTargetId = resolveTgTarget();
    const hasTg = Boolean(tgAdapter && tgTargetId);
    const deliverToTg = hasTg && originChannel !== "web";
    if (!deliverToTg && originChannel !== "web") {
      // Allow offline/TG-disabled sessions to still record background results for Web Console.
    }
    const deliveryChannel: ChannelName = originChannel === "web" || !hasTg ? "web" : originChannel;

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
      if (deliverToTg) {
        await tgAdapter!.sendBubbles(tgTargetId!, bubbles, hatoConfig.gateway.bubbles.delay_ms_range);
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
        if (deliverToTg) {
          await tgAdapter!.sendText(tgTargetId!, text);
        }
      }
      const ticketRow = repo.getTicket(result.ticket_id);
      const deliverFiles = Boolean(
        parseWorkerMandate(ticketRow?.mandateJson ?? null)?.deliver_files,
      );
      for (const artifact of result.artifacts) {
        if (deliverToTg && (artifact.send_as === "photo" || deliverFiles)) {
          await tgAdapter!.sendFile(tgTargetId!, artifact.path, artifact.filename).catch((err) => {
            logWarn("TG", `failed to send artifact ${artifact.filename}: ${summarizeError(err)}`);
          });
        }
      }

      if (!deliverToTg && webVerbatimParts.length > 0) {
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
    const tgTargetId = resolveTgTarget();
    const hasTg = Boolean(tgAdapter && tgTargetId);
    const deliverToTg = hasTg && originChannel !== "web";
    const deliveryChannel: ChannelName = originChannel === "web" || !hasTg ? "web" : originChannel;

    await actorLock.run(canonicalUserId, async () => {
      const bubbles = await personaRuntime.narrateBackgroundEvent({
        canonicalUserId,
        channel: deliveryChannel,
        eventSummary: `工单 ${ticketId} (${briefTitle}) 需要补充信息: ${question}`,
        promptInstruction: `[系统事件：后台工单 "${briefTitle}" (${ticketId}) 需要用户补充以下信息后继续：${question}。请自然转达给用户。]`,
      });
      if (deliverToTg) {
        await tgAdapter!.sendBubbles(tgTargetId!, bubbles, hatoConfig.gateway.bubbles.delay_ms_range);
      }
    });
  });

  bus.on("ticket_confirm_required", async ({ canonicalUserId, originChannel, ticketId, briefTitle, promptText }) => {
    const tgTargetId = resolveTgTarget();
    const hasTg = Boolean(tgAdapter && tgTargetId);
    if (hasTg && originChannel !== "web") {
      await tgAdapter!.sendConfirm(tgTargetId!, {
        ticketId,
        promptText: `工单 ${ticketId} (${briefTitle}) 请求确认高危操作：\n${promptText}`,
      });
      return;
    }
    await actorLock.run(canonicalUserId, async () => {
      repo.appendRawMessage({
        canonicalUserId,
        channel: originChannel === "web" || !hasTg ? "web" : originChannel,
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
    const tgTargetId = resolveTgTarget();
    if (!silent && tgAdapter && tgTargetId) {
      await tgAdapter.sendText(tgTargetId, summary).catch(() => undefined);
    }
  });

  if (hatoConfig.gateway.telegram.enabled) {
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
  }

  webConsoleServer = new WebConsoleServer({
    hatoConfigPath: HATO_CONFIG_PATH,
    modelsConfigPath: MODELS_CONFIG_PATH,
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
