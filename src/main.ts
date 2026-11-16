import { ActorLock, EventBus } from "./bus/actor-bus.js";
import { BrowserRuntime } from "./browser/runtime.js";
import { tryHandleSlashCommand } from "./commands/slash.js";
import { loadHatoConfig, resolveTavilySearchConfig, type HatoConfig } from "./config/app.js";
import { collectReloadDiff, fingerprintSecret, type ReloadSnapshot } from "./config/diff.js";
import { ModelRegistry } from "./config/models.js";
import { ScopedProxyRouter } from "./config/proxy.js";
import { loadSecretEnv, reloadSecretEnv, requireSecret } from "./config/secrets.js";
import { bindTelegramHomeChannel } from "./config/store.js";
import { openDatabase } from "./db/client.js";
import { HatoRepository } from "./db/repo.js";
import { MessageDebouncer } from "./gateway/debouncer.js";
import { TelegramAdapter } from "./gateway/tg.js";
import { CompactionManager } from "./memory/compaction.js";
import { PersonaRuntime } from "./persona/agent.js";
import { logError, logInfo, setLogTimezone, summarizeError } from "./utils/logger.js";

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
  const browserRuntime = new BrowserRuntime(hatoConfig, modelRegistry, proxyRouter);
  const personaRuntime = new PersonaRuntime(hatoConfig, modelRegistry, proxyRouter, repo, browserRuntime);
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
    },
  );

  let tgAdapter: TelegramAdapter | null = null;

  const debouncer = new MessageDebouncer(hatoConfig.gateway.debounce_ms, (batch) => {
    void bus.emit({ type: "user_batch", batch });
  });

  bus.on("user_batch", async ({ batch }) => {
    await actorLock.run(batch.canonicalUserId, async () => {
      if (!tgAdapter) return;

      const tgTargetId = batch.originPlatformUserId;
      await tgAdapter.sendTyping(tgTargetId).catch(() => undefined);

      let bubblesToSend: string[];
      let repliedToTriggerMsg = false;
      try {
        const output = await personaRuntime.handleUserBatch(batch, batch.images ?? [], {
          sendPhotoToUser: (photo, caption) => tgAdapter!.sendPhoto(tgTargetId, photo, caption),
          sendBubblesToUser: async (earlyBubbles) => {
            if (earlyBubbles.length === 0) return;
            const replyTo =
              !repliedToTriggerMsg && batch.platformMsgIds.length === 1
                ? batch.latestPlatformMsgId
                : undefined;
            await tgAdapter!.sendBubbles(
              tgTargetId,
              earlyBubbles,
              hatoConfig.gateway.bubbles.delay_ms_range,
              replyTo,
            );
            repliedToTriggerMsg = true;
            await tgAdapter!.sendTyping(tgTargetId).catch(() => undefined);
          },
        });
        bubblesToSend = output.bubbles;
      } catch (err) {
        const msg = summarizeError(err);
        logError("PERSONA", "turn failed", err);
        await tgAdapter
          .sendText(tgTargetId, `处理刚才这条消息时出错了：${msg}`)
          .catch(() => undefined);
        return;
      }

      try {
        if (bubblesToSend.length > 0) {
          const replyTo =
            !repliedToTriggerMsg && batch.platformMsgIds.length === 1
              ? batch.latestPlatformMsgId
              : undefined;
          await tgAdapter.sendBubbles(
            tgTargetId,
            bubblesToSend,
            hatoConfig.gateway.bubbles.delay_ms_range,
            replyTo,
          );
        }
        compactionManager.recordInteraction(batch.canonicalUserId);
        void compactionManager.checkHighWatermark(batch.canonicalUserId).catch((err) => {
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
          const reply = await tryHandleSlashCommand(msg.canonicalUserId, msg.text, {
            repo,
            listModelSlots: () =>
              modelRegistry.listSlots().map((s) => ({
                slot: s.slot,
                target: s.target,
                api: String(s.model.api),
                baseUrl: s.model.baseUrl,
              })),
            listAvailableModels: () => modelRegistry.listTargets(),
            setModelSlot: (slot, target) => {
              const updated = modelRegistry.setSlotOverride(slot, target);
              return {
                slot: updated.slot,
                target: updated.target,
                api: String(updated.model.api),
                baseUrl: updated.model.baseUrl,
              };
            },
            reloadAll: async () => {
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
              personaRuntime.updateConfig(nextConfig);
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
            },
            forceCompact: (uid) => compactionManager.runIdleCommit(uid),
            resetContext: async (uid) => {
              debouncer.discardUser(uid);
              return actorLock.run(uid, async () => {
                compactionManager.resetUser(uid);
                const res = repo.resetWorkingContext(uid);
                personaRuntime.resetSession();
                return res;
              });
            },
            setHomeChannel: async () => {
              const bound = bindTelegramHomeChannel({
                hatoConfigPath: HATO_CONFIG_PATH,
                repo,
                canonicalUserId: msg.canonicalUserId,
                tgUserId: msg.platformUserId,
                currentConfig: hatoConfig,
              });
              hatoConfig = bound.updatedConfig;
              personaRuntime.updateConfig(hatoConfig);
              tgAdapter?.updateConfig(hatoConfig);
              return {
                channel: msg.channel,
                targetId: msg.platformUserId,
                addedToWhitelist: bound.addedToWhitelist,
                savedToConfig: bound.savedToConfig,
              };
            },
          });

          if (reply !== null) {
            await tgAdapter?.sendText(msg.platformUserId, reply, msg.platformMsgId);
            return;
          }
        }

        debouncer.enqueue(msg);
      },
    });

    await tgAdapter.start();
  }

  const shutdown = async () => {
    logInfo("HATO", "shutting down...");
    debouncer.dispose();
    compactionManager.dispose();
    await browserRuntime.dispose();
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
