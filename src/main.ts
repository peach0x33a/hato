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
import { ModelRegistry } from "./config/models.js";
import { ScopedProxyRouter } from "./config/proxy.js";
import { loadSecretEnv, reloadSecretEnv, requireSecret } from "./config/secrets.js";
import { bindTelegramHomeChannel } from "./config/store.js";
import { openDatabase } from "./db/client.js";
import { HatoRepository } from "./db/repo.js";
import { MessageDebouncer, mergeInboundBatches } from "./gateway/debouncer.js";
import { TelegramAdapter } from "./gateway/tg.js";
import type { InboundBatch } from "./gateway/types.js";
import { CompactionManager } from "./memory/compaction.js";
import { MemoryCurator } from "./memory/curator.js";
import { MemoryEchoStore } from "./memory/memoryecho.js";
import type { MemoryStore } from "./memory/store.js";
import { PersonaRuntime } from "./persona/agent.js";
import { logError, logInfo, logWarn, setLogTimezone, summarizeError } from "./utils/logger.js";
import { WebConsoleServer } from "./web-console/server.js";

const HATO_CONFIG_PATH = "config/hato.toml";
const MODELS_CONFIG_PATH = "config/models.toml";

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
