import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ActorLock, EventBus } from "./bus/actor-bus.js";
import { BrowserRuntime } from "./browser/runtime.js";
import { tryExecuteSlashCommand } from "./commands/slash.js";
import {
  loadHatoConfig,
  resolveContextClearConfig,
  resolveMemoryCuratorConfig,
  resolveHindsightConfig,
  resolveMemoryEchoConfig,
  resolveMemoryProvider,
  resolveMemoryRecallConfig,
  resolveTavilySearchConfig,
  resolveUpdatesConfig,
  resolveWebBrowserConfig,
  resolveExternalCliCustomEnv,
  type HatoConfig,
} from "./config/app.js";
import { collectReloadDiff, fingerprintSecret, type ReloadSnapshot } from "./config/diff.js";
import { loadMcpConfig, type McpConfig } from "./config/mcp.js";
import { ModelRegistry } from "./config/models.js";
import { ScopedProxyRouter } from "./config/proxy.js";
import { getOptionalSecret, loadSecretEnv, reloadSecretEnv, requireSecret } from "./config/secrets.js";
import { ensureHatoHomeConfig } from "./config/paths.js";
import {
  bindQqHomeChannel,
  bindTelegramHomeChannel,
  resolvePlatformHomeBinding,
  unbindHomeChannel,
  updateProactiveChannel,
  writeHatoConfig,
} from "./config/store.js";
import { openDatabase } from "./db/client.js";
import { HatoRepository } from "./db/repo.js";
import { runSelfConfigAction } from "./persona/self-config.js";
import {
  filterPendingAutoArtifacts,
  formatTicketArtifactPromptHint,
  loadArtifactImagesForModel,
  partitionTicketArtifacts,
} from "./dispatch/artifact-delivery.js";
import { TicketCoordinator } from "./dispatch/coordinator.js";
import { ProactiveCareScheduler } from "./dispatch/proactive-care.js";
import { ScriptScheduler } from "./dispatch/script-scheduler.js";
import { cleanupExpiredWorkspaces } from "./dispatch/workspace-gc.js";
import { NeutralRouter } from "./dispatch/router.js";
import { parseWorkerMandate } from "./dispatch/schema.js";
import { MessageDebouncer, mergeInboundBatches } from "./gateway/debouncer.js";
import { QqAdapter } from "./gateway/qq.js";
import { QqOpenApiClient } from "./gateway/qq-client.js";
import { TelegramAdapter } from "./gateway/tg.js";
import type {
  ChannelAdapter,
  ChannelName,
  HomeChannelPlatform,
  InboundBatch,
  ProactiveChannelOption,
} from "./gateway/types.js";
import { MarkdownImageRenderer } from "./render/markdown-image.js";
import { buildUpdateNotificationKey, checkForUpdates } from "./utils/update-check.js";
import { McpClientPool } from "./mcp/pool.js";
import { CompactionManager } from "./memory/compaction.js";
import { MemoryCurator } from "./memory/curator.js";
import { HindsightStore } from "./memory/hindsight.js";
import { MemoryEchoStore } from "./memory/memoryecho.js";
import type { MemoryStore } from "./memory/store.js";
import { PersonaRuntime } from "./persona/agent.js";
import { NotebookService } from "./notebook/service.js";
import { NotebookStore } from "./notebook/store.js";
import { probeTelegramGateway, updateTelegramBotProfile } from "./setup/probe.js";
import { StickerService } from "./stickers/service.js";
import { StickerStore } from "./stickers/store.js";
import { LiveTraceTracker } from "./stats/live-trace.js";
import {
  formatUserFacingTurnError,
  logError,
  logInfo,
  logWarn,
  setLogTimezone,
  summarizeError,
} from "./utils/logger.js";
import { WebConsoleServer } from "./web-console/server.js";
import { WorkerDispatcher } from "./worker/backend.js";
import { BuiltinPiRunner } from "./worker/builtin-pi.js";
import { ExternalCliRunner } from "./worker/external-cli.js";
import { resolveBackendCommand } from "./worker/overlay.js";

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
  const stickerStore = new StickerStore(dbHandle.db);
  const notebookStore = new NotebookStore(dbHandle.db);

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
  const liveTraceTracker = new LiveTraceTracker();
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
  personaRuntime.setLiveTraceTracker(liveTraceTracker);
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
    filterAvailableBackends: (backends, cfg) => {
      const customEnv = resolveExternalCliCustomEnv(cfg);
      const searchPath = customEnv.PATH ?? process.env.PATH;
      return backends.filter((backend) => {
        if (backend === "builtin-pi") return true;
        const cmd = resolveBackendCommand(backend, cfg);
        return cmd.includes("/") ? existsSync(cmd) : Bun.which(cmd, { PATH: searchPath }) !== null;
      });
    },
  });
  const builtinRunner = new BuiltinPiRunner({
    getHatoConfig: () => hatoConfig,
    modelRegistry,
    proxyRouter,
    repo,
    mcpPool,
    liveTraceTracker,
  });
  const externalRunner = new ExternalCliRunner({
    getHatoConfig: () => hatoConfig,
    getMcpConfig: () => mcpConfig,
    proxyRouter,
  });
  const workerDispatcher = new WorkerDispatcher(builtinRunner, externalRunner);
  const stickerService = new StickerService({
    store: stickerStore,
    getHatoConfig: () => hatoConfig,
    getModelRegistry: () => modelRegistry,
    getProxyRouter: () => proxyRouter,
    getTelegramAdapter: () => tgAdapter,
  });
  const notebookService = new NotebookService({
    store: notebookStore,
    getHatoConfig: () => hatoConfig,
    getMemoryStore: () => memoryStore,
  });
  const ticketCoordinator = new TicketCoordinator({
    getHatoConfig: () => hatoConfig,
    repo,
    router: neutralRouter,
    dispatcher: workerDispatcher,
    bus,
    getModelRegistry: () => modelRegistry,
    proxyRouter,
    liveTraceTracker,
    executeSelfConfigConfirm: async (_canonicalUserId, payload) => {
      const out = await runSelfConfigAction(
        {
          hatoConfigPath: HATO_CONFIG_PATH,
          getHatoConfig: () => hatoConfig,
          getModelRegistry: () => modelRegistry,
          repo,
          onReloadRuntime: async () => {
            await reloadAll();
          },
          onThinkingUpdated: () => {
            personaRuntime.syncThinkingLevelFromRegistry();
          },
        },
        payload.action,
      );
      return { ok: out.ok, message: out.summary };
    },
    executeSensitiveFileConfirm: async (canonicalUserId, payload) => {
      if (payload.channel === "web") {
        if (payload.text?.trim()) {
          repo.appendRawMessage({
            canonicalUserId,
            channel: "web",
            role: "assistant",
            content: payload.text.trim(),
            createdAt: Date.now(),
          });
          personaRuntime.refreshTranscriptFromDb();
        }
        return {
          ok: false,
          message: `Web Console 暂不支持直接发送文件附件，本地路径为: ${payload.path}`,
        };
      }
      const outbound = payload.strictChannel
        ? resolveStrictOutboundTarget(payload.channel)
        : resolveOutboundTarget(payload.channel);
      if (!outbound?.adapter.sendFile) {
        return {
          ok: false,
          message: `${payload.channel.toUpperCase()} 网关未就绪或未绑定 owner，无法发送文件: ${payload.path}`,
        };
      }
      if (payload.text?.trim()) {
        await outbound.adapter.sendText(outbound.targetId, payload.text.trim());
      }
      await outbound.adapter.sendFile(
        outbound.targetId,
        payload.path,
        basename(payload.path),
        payload.caption,
      );
      return {
        ok: true,
        message: `已发送敏感文件到 ${outbound.channel.toUpperCase()}: ${basename(payload.path)}`,
      };
    },
  });
  const recoveredTickets = ticketCoordinator.recoverStaleTickets();
  if (recoveredTickets > 0) {
    logWarn("DISPATCH", `recovered ${recoveredTickets} stale in-flight ticket(s) from previous run`);
  }
  personaRuntime.setDelegateHandler((input) => ticketCoordinator.enqueueDelegation(input));
  personaRuntime.setImageGenHandler((input) => ticketCoordinator.enqueueImageGeneration(input));
  personaRuntime.setSensitiveFileConfirmHandler((input) =>
    ticketCoordinator.enqueueSensitiveFileConfirm(input),
  );
  personaRuntime.setSelfConfigConfirmHandler((input) =>
    ticketCoordinator.enqueueSelfConfigConfirm(input),
  );
  personaRuntime.setStickerHandlers({
    onSearch: async ({ canonicalUserId, query, emotion, limit }) => {
      const matches = stickerStore.search(canonicalUserId, query, { emotion, limit });
      if (matches.length === 0) {
        return "表情包库目前还没有已就绪的表情包。";
      }
      return matches
        .map(
          (s) =>
            `[${s.id}] 情绪:${s.emotions.join("/") || "通用"} | 描述:${s.caption} | 语境:${s.scenes.join("/") || "日常"}${s.tgFileId ? " | TG原生" : ""}`,
        )
        .join("\n");
    },
    onSend: async ({ canonicalUserId, stickerId, channel, strictChannel }) => {
      const rec = stickerStore.getById(canonicalUserId, stickerId);
      if (!rec) {
        return { ok: false, message: `未找到表情包 ${stickerId}` };
      }
      if (channel === "web") {
        return {
          ok: false,
          message: `Web Console 暂不支持发送贴纸气泡，本地路径为: ${rec.localPath}`,
        };
      }
      const outbound = strictChannel
        ? resolveStrictOutboundTarget(channel)
        : resolveOutboundTarget(channel);
      if (!outbound) {
        return { ok: false, message: `${channel.toUpperCase()} 网关未就绪或未绑定 owner` };
      }
      if (outbound.adapter.sendSticker) {
        await outbound.adapter.sendSticker(outbound.targetId, {
          fileId: outbound.channel === "tg" ? rec.tgFileId ?? undefined : undefined,
          localPath: rec.localPath,
        });
      } else if (outbound.adapter.sendFile) {
        await outbound.adapter.sendFile(outbound.targetId, rec.localPath, basename(rec.localPath));
      } else {
        return { ok: false, message: `${outbound.channel.toUpperCase()} 网关不支持发送表情包` };
      }
      stickerStore.recordUsed(canonicalUserId, rec.id);
      return {
        ok: true,
        message: `已发送表情包 ${rec.id} 到 ${outbound.channel.toUpperCase()}`,
      };
    },
    onSave: async ({ canonicalUserId, path, packUrl, note, source }) => {
      if (packUrl) {
        const res = await stickerService.importTelegramPack({
          canonicalUserId,
          setNameOrUrl: packUrl,
          onComplete: (summary) => {
            const tgOut = resolveStrictOutboundTarget("tg");
            const msg = `贴纸包「${summary.title}」导入完成：新增 ${summary.imported} 张，跳过重复 ${summary.skipped} 张${summary.failed > 0 ? `，失败 ${summary.failed} 张` : ""}。`;
            if (tgOut) {
              void tgOut.adapter.sendText(tgOut.targetId, msg).catch(() => undefined);
            }
          },
        });
        return {
          ok: true,
          message: `已开始后台导入 Telegram 贴纸包「${res.title}」(${res.setName})：共 ${res.total} 张，排队打标 ${res.queued} 张，跳过重复 ${res.skipped} 张。`,
        };
      }
      if (!path) {
        return { ok: false, message: "请提供本地图片/贴纸 path 或 TG 贴纸包 pack_url。" };
      }
      const saved = await stickerService.saveFromLocalFile({
        canonicalUserId,
        localPath: path,
        source: source ?? "user_send",
        note,
        awaitTag: true,
      });
      return {
        ok: true,
        message: saved.deduplicated
          ? `该表情包已在库中（${saved.record.id}）：${saved.record.caption}`
          : `已保存并完成视觉标注（${saved.record.id}）：描述=${saved.record.caption}；情绪=${saved.record.emotions.join("/")}`,
      };
    },
    onCollect: async ({ canonicalUserId, action }) => {
      if (action === "start") {
        stickerService.setCollectMode(canonicalUserId, true);
        return {
          ok: true,
          message: "已开启批量收图模式：接下来用户发来的图片与贴纸都会自动入库并后台视觉打标。",
        };
      }
      if (action === "stop") {
        stickerService.setCollectMode(canonicalUserId, false);
        const total = stickerStore.list(canonicalUserId).length;
        return {
          ok: true,
          message: `已关闭批量收图模式，当前表情包库共 ${total} 张。`,
        };
      }
      const active = stickerService.isCollectMode(canonicalUserId);
      const total = stickerStore.list(canonicalUserId).length;
      return {
        ok: true,
        message: `批量收图模式当前${active ? "开启中" : "未开启"}，库内共 ${total} 张。`,
      };
    },
  });
  personaRuntime.setNotebookHandlers({
    onSave: async ({ canonicalUserId, summary, reason, title, content, imagePath, tags }) => {
      try {
        const saved = await notebookService.saveEntry(canonicalUserId, {
          summary,
          reason,
          title,
          content,
          imagePath,
          tags,
        });
        const kindLabel = saved.kind === "mixed" ? "图文" : saved.kind === "image" ? "图片" : "纯文本";
        const idxLabel =
          saved.indexStatus === "synced"
            ? "已同步语义索引"
            : saved.indexStatus === "local_only"
              ? "仅本地索引"
              : `索引状态=${saved.indexStatus}`;
        const pathNote = saved.imagePath ? `，image_path=${saved.imagePath}` : "";
        return {
          ok: true,
          entryId: saved.id,
          message: `已存入小本本 [${saved.id}] (${kindLabel} · ${idxLabel}${pathNote})`,
        };
      } catch (err) {
        return {
          ok: false,
          message: `存入小本本失败: ${summarizeError(err)}`,
        };
      }
    },
    onSearch: async ({ canonicalUserId, query, kind, limit }) => {
      const res = await notebookService.searchEntries(canonicalUserId, { query, kind, limit });
      if (res.entries.length === 0) {
        return query?.trim()
          ? `小本本中没有找到与「${query.trim()}」相关的条目。`
          : "小本本目前还是空的。";
      }
      const header = query?.trim()
        ? `小本本检索结果（${res.usedSemanticIndex ? "语义索引+本地" : "本地检索"}${res.degraded ? "，语义检索降级" : ""}，共 ${res.entries.length} 条）：`
        : `小本本最近条目（共 ${res.entries.length} 条）：`;
      const lines = res.entries.map((e) => {
        const tagText = e.tags.length > 0 ? ` | 标签: ${e.tags.join(", ")}` : "";
        const titleText = e.title ? ` ${e.title} |` : "";
        return `- [${e.id}] (${e.kind})${titleText} 概要: ${e.summary} | 原因: ${e.reason}${tagText} | 更新: ${new Date(e.updatedAt).toISOString().slice(0, 10)}`;
      });
      return [header, ...lines].join("\n");
    },
    onRead: async ({ canonicalUserId, entryId }) => {
      const entry = notebookService.readEntry(canonicalUserId, entryId);
      if (!entry) {
        return { ok: false, text: `未找到小本本条目: ${entryId}` };
      }
      const lines = [
        `[${entry.id}] (${entry.kind})`,
        ...(entry.title ? [`标题: ${entry.title}`] : []),
        `概要: ${entry.summary}`,
        `存入原因: ${entry.reason}`,
        ...(entry.tags.length > 0 ? [`标签: ${entry.tags.join(", ")}`] : []),
        `索引状态: ${entry.indexStatus}`,
        ...(entry.imagePath ? [`image_path: ${entry.imagePath}`] : []),
        ...(entry.content.trim() ? ["", "正文内容:", entry.content] : []),
      ];
      return {
        ok: true,
        text: lines.join("\n"),
        imagePath: entry.imagePath,
      };
    },
    onManage: async ({
      canonicalUserId,
      action,
      entryId,
      title,
      summary,
      reason,
      content,
      tags,
      imagePath,
      removeImage,
    }) => {
      try {
        if (action === "delete") {
          const ok = await notebookService.deleteEntry(canonicalUserId, entryId);
          return ok
            ? { ok: true, message: `已从小本本删除条目 ${entryId}（同步清理关联索引）。` }
            : { ok: false, message: `未找到小本本条目: ${entryId}` };
        }
        const updated = await notebookService.updateEntry(canonicalUserId, entryId, {
          title,
          summary,
          reason,
          content,
          tags,
          imagePath,
          removeImage,
        });
        if (!updated) {
          return { ok: false, message: `未找到小本本条目: ${entryId}` };
        }
        return {
          ok: true,
          message: `已更新小本本条目 [${updated.id}] (${updated.kind} · 索引=${updated.indexStatus})`,
        };
      } catch (err) {
        return {
          ok: false,
          message: `操作小本本条目失败: ${summarizeError(err)}`,
        };
      }
    },
  });
  const resolveStrictOutboundTarget = (
    channel: "tg" | "qq",
  ): { channel: "tg" | "qq"; adapter: ChannelAdapter; targetId: string } | null => {
    if (channel === "qq") {
      const qqTargetId = resolveQqTarget();
      return qqAdapter && qqTargetId ? { channel: "qq", adapter: qqAdapter, targetId: qqTargetId } : null;
    }
    const tgTargetId = resolveTgTarget();
    return tgAdapter && tgTargetId ? { channel: "tg", adapter: tgAdapter, targetId: tgTargetId } : null;
  };

  const narrationSentFilesByTarget = new Map<string, Set<string>>();

  personaRuntime.setSendFileHandler(async ({ channel, strictChannel, path, caption }) => {
    if (channel === "web") {
      return {
        ok: false,
        message: `Web Console 暂不支持直接发送文件附件，本地路径为: ${path}`,
      };
    }
    const outbound = strictChannel
      ? resolveStrictOutboundTarget(channel)
      : resolveOutboundTarget(channel);
    if (!outbound?.adapter.sendFile) {
      return {
        ok: false,
        message: `${channel.toUpperCase()} 网关未就绪或未绑定 owner，无法发送文件: ${path}`,
      };
    }
    await outbound.adapter.sendFile(outbound.targetId, path, basename(path), caption);
    narrationSentFilesByTarget.get(`${outbound.channel}:${outbound.targetId}`)?.add(resolve(path));
    return {
      ok: true,
      message: `已发送文件到 ${outbound.channel.toUpperCase()}: ${basename(path)}`,
    };
  });

  personaRuntime.setSendMessageHandler(async ({ canonicalUserId, channel, text, filePath, caption }) => {
    const trimmedText = text?.trim();
    if (channel === "web") {
      if (trimmedText) {
        repo.appendRawMessage({
          canonicalUserId,
          channel: "web",
          role: "assistant",
          content: trimmedText,
          createdAt: Date.now(),
        });
        personaRuntime.refreshTranscriptFromDb();
      }
      if (filePath && !trimmedText) {
        return {
          ok: false,
          message: `Web Console 暂不支持直接发送文件附件，本地路径为: ${filePath}`,
        };
      }
      return {
        ok: true,
        message: filePath
          ? `已将文本消息写入 Web 控制台（文件附件请取本地路径: ${filePath}）`
          : "已发送消息到 Web 控制台",
      };
    }

    const outbound = resolveStrictOutboundTarget(channel);
    if (!outbound) {
      return {
        ok: false,
        message: `${channel.toUpperCase()} 网关未就绪或未绑定 owner（可通过 /sethome 绑定），无法发送跨平台消息`,
      };
    }

    const sentParts: string[] = [];
    if (trimmedText) {
      await outbound.adapter.sendText(outbound.targetId, trimmedText);
      sentParts.push("文本消息");
    }
    if (filePath) {
      if (!outbound.adapter.sendFile) {
        return {
          ok: false,
          message: `${channel.toUpperCase()} 网关当前不支持发送文件: ${filePath}`,
        };
      }
      await outbound.adapter.sendFile(outbound.targetId, filePath, basename(filePath), caption);
      narrationSentFilesByTarget
        .get(`${outbound.channel}:${outbound.targetId}`)
        ?.add(resolve(filePath));
      sentParts.push(`文件 ${basename(filePath)}`);
    }

    return {
      ok: true,
      message: `已发送到 ${outbound.channel.toUpperCase()}: ${sentParts.join(" + ")}`,
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

  const buildCompactionConfig = (cfg: HatoConfig) => {
    const clearCfg = resolveContextClearConfig(cfg);
    return {
      hotMessagesHighWatermark: cfg.context.hot_messages_high_watermark,
      hotMessagesKeepAfterCompact: cfg.context.hot_messages_keep_after_compact,
      minMessagesToCompact: cfg.context.min_messages_to_compact,
      preCompactAfterMinutes: cfg.context.pre_compact_after_minutes,
      idleCommitAfterMinutes: cfg.context.idle_commit_after_minutes,
      clearMode: clearCfg.clearMode,
      scheduledClearTime: clearCfg.scheduledClearTime,
      scheduledDeferMinutes: clearCfg.scheduledDeferMinutes,
      timezone: cfg.owner.timezone,
    };
  };

  const archiveAndResetHotZone = async (uid: string) => {
    debouncer.discardUser(uid);
    queuedBatchesByUser.delete(uid);
    const res = await actorLock.run(uid, async () => {
      compactionManager.resetUser(uid);
      const resetRes = repo.resetWorkingContext(uid);
      personaRuntime.resetSession();
      return resetRes;
    });
    void memoryCurator.retainPending(uid).catch((err) => {
      logError("CURATOR", `post-reset background retain failed for ${uid}`, err);
    });
    return res;
  };

  const compactionManager = new CompactionManager(
    buildCompactionConfig(hatoConfig),
    repo,
    actorLock,
    {
      summarizeBlock: (params) => personaRuntime.summarizeCompactionBlock(params),
      ensureRetained: async (canonicalUserId, messages) => {
        await memoryCurator.retainBeforeCompaction(canonicalUserId, messages);
      },
      clearHotZoneAndArchive: async (canonicalUserId) => {
        const res = await archiveAndResetHotZone(canonicalUserId);
        return res.clearedHotMessages > 0 || res.hadSummary;
      },
      listActiveUserIds: () => repo.listWorkingMemoryUserIds(),
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
    compactionManager.updateConfig(buildCompactionConfig(nextConfig));
    memoryStore = buildMemoryStore(nextConfig, proxyRouter, repo, memoryStore);
    mcpConfig = loadMcpConfig(MCP_CONFIG_PATH);
    await mcpPool.syncConfig(mcpConfig, { eagerZones: ["personal"] });
    personaRuntime.updateConfig(nextConfig, memoryStore);
    memoryCurator.updateConfig(nextConfig, memoryStore);
    markdownRenderer.updateBrowserConfig(resolveWebBrowserConfig(nextConfig));
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

  const markdownRenderer = new MarkdownImageRenderer({
    browserConfig: resolveWebBrowserConfig(hatoConfig),
  });
  personaRuntime.setRenderMarkdownImageHandler((markdown, options) =>
    markdownRenderer.render(markdown, options),
  );

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
    renderMarkdownImage: (markdown: string, options?: { theme?: "light" | "dark" }) =>
      markdownRenderer.render(markdown, options),
    resetContext: archiveAndResetHotZone,
    getMemoryStatus: async (uid: string) => {
      const provider = resolveMemoryProvider(hatoConfig);
      const recallCfg = resolveMemoryRecallConfig(hatoConfig);
      const curatorCfg = resolveMemoryCuratorConfig(hatoConfig);
      const [personaVault, techVault, notebookVault, usage] = memoryStore
        ? await Promise.all([
            memoryStore.resolveVaultId(uid, "persona", { createIfMissing: false }).catch(() => null),
            memoryStore.resolveVaultId(uid, "tech", { createIfMissing: false }).catch(() => null),
            memoryStore.resolveVaultId(uid, "notebook", { createIfMissing: false }).catch(() => null),
            memoryStore.getUsage?.().catch(() => null) ?? Promise.resolve(null),
          ])
        : [null, null, null, null];
      return {
        provider,
        configured: Boolean(memoryStore?.isConfigured()),
        recallMode: recallCfg.mode,
        curatorEnabled: curatorCfg.enabled,
        vaultIds: { persona: personaVault, tech: techVault, notebook: notebookVault },
        usage,
      };
    },
    syncMemory: (uid: string, opts?: { includeDenied?: boolean }) =>
      memoryCurator.retainPending(uid, { includeDeniedRetries: opts?.includeDenied ?? true }),
    forgetMemory: (uid: string, query: string) => memoryCurator.forgetByQuery(uid, query),
    notebookService,
    ...(platformInfo?.channel === "tg" || platformInfo?.channel === "qq"
      ? {
          setHomeChannel: async () => {
            const platformChannel: HomeChannelPlatform =
              platformInfo.channel === "tg" ? "tg" : "qq";
            const activeHome = resolvePlatformHomeBinding(platformChannel, hatoConfig, repo);
            if (activeHome.bound) {
              const channelLabel = platformInfo.channel === "tg" ? "Telegram" : "QQ";
              throw new Error(
                `当前 ${channelLabel} 已绑定原 Home Channel（${activeHome.targetId ?? ""}），必须先前往 Web 控制台解绑该平台原 Home 后，/sethome 才能生效。`,
              );
            }
            if (platformInfo.channel === "tg") {
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
            }
            const bound = bindQqHomeChannel({
              hatoConfigPath: HATO_CONFIG_PATH,
              repo,
              canonicalUserId,
              qqOpenId: platformInfo.platformUserId,
              currentConfig: hatoConfig,
            });
            hatoConfig = bound.updatedConfig;
            personaRuntime.updateConfig(hatoConfig);
            qqAdapter?.updateConfig(hatoConfig);
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

      if (stickerService.isCollectMode(uid)) {
        const mediaItems = mergedBatch.attachments.filter(
          (a) => (a.kind === "image" || a.kind === "sticker") && Boolean(a.localPath),
        );
        if (mediaItems.length > 0) {
          let queuedCount = 0;
          let dupCount = 0;
          for (const item of mediaItems) {
            try {
              const saved = await stickerService.saveFromLocalFile({
                canonicalUserId: uid,
                localPath: item.localPath!,
                source: "user_send",
                setName: item.setName,
                emoji: item.emoji,
                tgFileId: item.tgFileId,
                tgFileUniqueId: item.tgFileUniqueId,
                isAnimated: item.isAnimated,
                note: mergedBatch.combinedText || undefined,
                awaitTag: false,
              });
              if (saved.deduplicated) dupCount++;
              else queuedCount++;
            } catch (err) {
              logWarn("STICKER", `collect mode failed: ${summarizeError(err)}`);
            }
          }
          const note = `[系统：批量收图模式已处理本条消息中的 ${mediaItems.length} 张表情包（新增排队打标 ${queuedCount} 张，跳过重复 ${dupCount} 张）]`;
          mergedBatch.combinedText = mergedBatch.combinedText
            ? `${mergedBatch.combinedText}\n${note}`
            : note;
        }
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
          onRetryNotice: async (noticeText) => {
            if (hasNewerQueuedInput()) return;
            await adapter.sendText(targetId, noticeText).catch(() => undefined);
            await adapter.sendTyping?.(targetId).catch(() => undefined);
          },
        });
        bubblesToSend = output.bubbles;
        superseded = output.superseded;
      } catch (err) {
        logError("PERSONA", "turn failed", err);
        await adapter
          .sendText(targetId, formatUserFacingTurnError(err))
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
    const binding = resolvePlatformHomeBinding("tg", hatoConfig, repo);
    if (binding.bound && binding.targetId) {
      return binding.targetId;
    }
    const first = hatoConfig.owner.channels.tg.user_ids[0];
    return first !== undefined ? String(first) : null;
  };

  const resolveQqTarget = (): string | null => {
    const binding = resolvePlatformHomeBinding("qq", hatoConfig, repo);
    if (binding.bound && binding.targetId) {
      return binding.targetId;
    }
    const first = hatoConfig.owner.channels.qq.open_ids[0];
    return first !== undefined ? String(first) : null;
  };

  const resolveOutboundTarget = (
    preferredChannel?: ChannelName | "last_active",
  ): { channel: "tg" | "qq"; adapter: ChannelAdapter; targetId: string } | null => {
    const tgTargetId = resolveTgTarget();
    const qqTargetId = resolveQqTarget();

    let effectivePreferred: HomeChannelPlatform | undefined;
    let allowFallbackFromQq = hatoConfig.gateway.qq.fallback_channel === "tg";

    if (preferredChannel === "tg" || preferredChannel === "qq") {
      effectivePreferred = preferredChannel;
    } else if (preferredChannel === "last_active") {
      effectivePreferred =
        repo.getLastActiveImChannel(hatoConfig.owner.canonical_user_id) ?? undefined;
      allowFallbackFromQq = true;
    } else {
      const configured = hatoConfig.owner.proactive_channel;
      if (configured === "tg" || configured === "qq") {
        effectivePreferred = configured;
      } else {
        effectivePreferred =
          repo.getLastActiveImChannel(hatoConfig.owner.canonical_user_id) ?? undefined;
        allowFallbackFromQq = true;
      }
    }

    if (effectivePreferred === "qq") {
      if (qqAdapter && qqTargetId) {
        return { channel: "qq", adapter: qqAdapter, targetId: qqTargetId };
      }
      if (allowFallbackFromQq && tgAdapter && tgTargetId) {
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
      const ticketRow = repo.getTicket(result.ticket_id);
      const deliverFiles = Boolean(
        parseWorkerMandate(ticketRow?.mandateJson ?? null)?.deliver_files,
      );
      const artifactPartition = partitionTicketArtifacts({
        artifacts: result.artifacts,
        canAutoSend: Boolean(outbound?.adapter.sendFile),
        deliverFiles,
      });
      const artifactImages = await loadArtifactImagesForModel(result.artifacts);
      const artifactNames = formatTicketArtifactPromptHint(artifactPartition, {
        hasAttachedImages: artifactImages.length > 0,
      });
      const summary = `[工单 ${result.ticket_id} · ${briefTitle}] (${result.status}): ${result.narration_hint}${caveatText}${secretsNote}`;

      const narrationKey = outbound ? `${outbound.channel}:${outbound.targetId}` : null;
      const sentDuringNarration = new Set<string>();
      if (narrationKey) {
        narrationSentFilesByTarget.set(narrationKey, sentDuringNarration);
      }
      let bubbles: string[];
      try {
        bubbles = await personaRuntime.narrateBackgroundEvent({
          canonicalUserId,
          channel: deliveryChannel,
          eventSummary: summary,
          promptInstruction: `[系统事件：后台任务 "${briefTitle}" (${result.ticket_id}) 已结束，状态=${result.status}。请用自然日常口吻直接告诉用户结果要点（除非出错或用户要求，不要主动报工单号，也不要倾倒冗长执行日志）：${result.narration_hint}${artifactNames}${caveatText}${secretsNote}]`,
          images: artifactImages,
        });
      } finally {
        if (narrationKey) {
          narrationSentFilesByTarget.delete(narrationKey);
        }
      }
      if (outbound) {
        await outbound.adapter
          .sendBubbles(outbound.targetId, bubbles, hatoConfig.gateway.bubbles.delay_ms_range)
          .catch((err) => {
            logWarn(
              outbound.channel.toUpperCase(),
              `failed to send ticket_result narration bubbles: ${summarizeError(err)}`,
            );
          });
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
          await outbound.adapter.sendText(outbound.targetId, text).catch((err) => {
            logWarn(
              outbound.channel.toUpperCase(),
              `failed to send verbatim block ${block.title}: ${summarizeError(err)}`,
            );
          });
        }
      }
      const pendingArtifacts = filterPendingAutoArtifacts({
        autoDelivered: artifactPartition.autoDelivered,
        sentPaths: sentDuringNarration,
      });
      for (const artifact of pendingArtifacts) {
        if (outbound?.adapter.sendFile) {
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
    await actorLock.run(canonicalUserId, async () => {
      repo.appendRawMessage({
        canonicalUserId,
        channel,
        role: "executed_event",
        content: summary,
        createdAt: occurredAtMs,
      });
      personaRuntime.refreshTranscriptFromDb();
    });
    const outbound = channel === "web" ? null : resolveOutboundTarget(channel);
    if (!silent && outbound) {
      await outbound.adapter.sendText(outbound.targetId, summary).catch(() => undefined);
    }
  });

  const ensureTelegramStarted = async () => {
    if (tgAdapter) return;
    const activeHome = resolvePlatformHomeBinding("tg", hatoConfig, repo);
    if (!activeHome.bound && hatoConfig.owner.channels.tg.user_ids.length === 0) {
      const pairingCode = repo.getOrCreateHomePairingCode("tg");
      logInfo(
        "TG",
        `Telegram 尚未绑定 Home Channel。请在 Telegram 私聊 Bot 发送: /sethome ${pairingCode}`,
      );
    }

    const botToken = requireSecret(hatoConfig.gateway.telegram.bot_token_env, "Telegram gateway");
    const adapter = new TelegramAdapter({
      config: hatoConfig,
      botToken,
      proxyRouter,
      onConfirmAction: (ticketId, approved) =>
        ticketCoordinator.handleConfirmAction(ticketId, approved),
      onClaimHome: async ({ platformUserId, code, username }) => {
        const currentHome = resolvePlatformHomeBinding("tg", hatoConfig, repo);
        if (currentHome.bound) {
          return {
            ok: false,
            reply: `当前 Telegram 已绑定原 Home Channel（${currentHome.targetId ?? ""}），必须先在 Web 控制台解绑 Telegram 原 Home 后，/sethome 才能生效。`,
          };
        }
        if (!repo.verifyAndConsumeHomePairingCode("tg", code)) {
          return {
            ok: false,
            reply: "配对码无效、已过期或尝试次数过多，请前往 Web 控制台查看最新 Telegram `/sethome <配对码>`。",
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
          const slashOut = await tryExecuteSlashCommand({
            canonicalUserId: msg.canonicalUserId,
            text: msg.text,
            channel: msg.channel,
            platformUserId: msg.platformUserId,
            platformMsgId: msg.platformMsgId,
            replyToPlatformMsgId: msg.replyToPlatformMsgId,
            replyToText: msg.replyToText,
            deps: buildSlashDeps(msg.canonicalUserId, {
              channel: msg.channel,
              platformUserId: msg.platformUserId,
            }),
          });

          if (slashOut !== null) {
            if (slashOut.photo) {
              await tgAdapter?.sendPhoto(
                msg.platformUserId,
                slashOut.photo.buffer,
                slashOut.photo.caption,
              );
            }
            if (slashOut.text !== undefined) {
              await tgAdapter?.sendText(msg.platformUserId, slashOut.text, msg.platformMsgId);
            }
            return;
          }
        }

        const confirmTextRes = await ticketCoordinator.tryHandleConfirmText(
          msg.canonicalUserId,
          msg.text,
        );
        if (confirmTextRes.handled) {
          if (confirmTextRes.reply) {
            await tgAdapter?.sendText(msg.platformUserId, confirmTextRes.reply, msg.platformMsgId);
          }
          return;
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

    await adapter.start();
    tgAdapter = adapter;
  };

  if (hatoConfig.gateway.telegram.enabled) {
    await ensureTelegramStarted();
  }

  const ensureQqStarted = async () => {
    if (qqAdapter) return;
    const activeHome = resolvePlatformHomeBinding("qq", hatoConfig, repo);
    if (!activeHome.bound && hatoConfig.owner.channels.qq.open_ids.length === 0) {
      const pairingCode = repo.getOrCreateHomePairingCode("qq");
      logInfo(
        "QQ",
        `QQ 尚未绑定 Home Channel。请在 QQ 私聊机器人发送: /sethome ${pairingCode}`,
      );
    }
    const appId = hatoConfig.gateway.qq.app_id.trim();
    if (!appId) {
      throw new Error("QQ gateway is enabled, but gateway.qq.app_id is empty in config/hato.toml.");
    }
    const clientSecret = requireSecret(hatoConfig.gateway.qq.client_secret_env, "QQ gateway");
    const adapter = new QqAdapter({
      config: hatoConfig,
      appId,
      clientSecret,
      proxyRouter,
      onClaimHome: async ({ platformUserId, code }) => {
        const currentHome = resolvePlatformHomeBinding("qq", hatoConfig, repo);
        if (currentHome.bound) {
          return {
            ok: false,
            reply: `当前 QQ 已绑定原 Home Channel（${currentHome.targetId ?? ""}），必须先在 Web 控制台解绑 QQ 原 Home 后，/sethome 才能生效。`,
          };
        }
        if (!repo.verifyAndConsumeHomePairingCode("qq", code)) {
          return {
            ok: false,
            reply: "配对码无效、已过期或尝试次数过多，请前往 Web 控制台查看最新 QQ /sethome <配对码>。",
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
          const slashOut = await tryExecuteSlashCommand({
            canonicalUserId: msg.canonicalUserId,
            text: msg.text,
            channel: msg.channel,
            platformUserId: msg.platformUserId,
            platformMsgId: msg.platformMsgId,
            replyToPlatformMsgId: msg.replyToPlatformMsgId,
            replyToText: msg.replyToText,
            deps: buildSlashDeps(msg.canonicalUserId, {
              channel: msg.channel,
              platformUserId: msg.platformUserId,
            }),
          });
          if (slashOut !== null) {
            if (slashOut.photo) {
              await qqAdapter?.sendPhoto(
                msg.platformUserId,
                slashOut.photo.buffer,
                slashOut.photo.caption,
              );
            }
            if (slashOut.text !== undefined) {
              await qqAdapter?.sendText(msg.platformUserId, slashOut.text, msg.platformMsgId);
            }
            return;
          }
        }

        const confirmTextRes = await ticketCoordinator.tryHandleConfirmText(
          msg.canonicalUserId,
          msg.text,
        );
        if (confirmTextRes.handled) {
          if (confirmTextRes.reply) {
            await qqAdapter?.sendText(msg.platformUserId, confirmTextRes.reply, msg.platformMsgId);
          }
          return;
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

    await adapter.start();
    qqAdapter = adapter;
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
    getStickerService: () => stickerService,
    getNotebookService: () => notebookService,
    getRepo: () => repo,
    getPersonaRuntime: () => personaRuntime,
    getBrowserRuntime: () => browserRuntime,
    getCompactionManager: () => compactionManager,
    getMemoryCurator: () => memoryCurator,
    getMemoryStore: () => memoryStore,
    getTicketCoordinator: () => ticketCoordinator,
    getLiveTraceTracker: () => liveTraceTracker,
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
      const prevConfig = hatoConfig;
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
        hatoConfig = prevConfig;
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    unbindHome: async (opts) => {
      const res = unbindHomeChannel({
        channel: opts.channel,
        hatoConfigPath: HATO_CONFIG_PATH,
        repo,
        canonicalUserId: hatoConfig.owner.canonical_user_id,
        currentConfig: hatoConfig,
        clearChannelWhitelist: opts.clearChannelWhitelist,
      });
      hatoConfig = res.updatedConfig;
      personaRuntime.updateConfig(hatoConfig);
      tgAdapter?.updateConfig(hatoConfig);
      qqAdapter?.updateConfig(hatoConfig);
      logInfo(
        "HATO",
        `unbound ${opts.channel} home channel via Web Console (prev=${res.previousHome.channel}:${res.previousHome.targetId ?? ""}, clearedWhitelist=${res.clearedWhitelist})`,
      );
      return {
        ok: true,
        previousHome: res.previousHome,
        home: resolvePlatformHomeBinding(opts.channel, hatoConfig, repo),
        clearedWhitelist: res.clearedWhitelist,
      };
    },
    setProactiveChannel: async (proactiveChannel: ProactiveChannelOption) => {
      const res = updateProactiveChannel({
        hatoConfigPath: HATO_CONFIG_PATH,
        repo,
        canonicalUserId: hatoConfig.owner.canonical_user_id,
        proactiveChannel,
        currentConfig: hatoConfig,
      });
      hatoConfig = res.updatedConfig;
      personaRuntime.updateConfig(hatoConfig);
      tgAdapter?.updateConfig(hatoConfig);
      qqAdapter?.updateConfig(hatoConfig);
      logInfo("HATO", `updated default proactive_channel=${proactiveChannel} via Web Console`);
      return { ok: true, proactiveChannel };
    },
  });
  await webConsoleServer.start();

  const runUpdateNotificationCheck = async () => {
    const updatesCfg = resolveUpdatesConfig(hatoConfig);
    if (!updatesCfg.checkEnabled || !updatesCfg.imNotifyEnabled) return;
    const res = await checkForUpdates({
      channel: updatesCfg.channel,
      ttlHours: updatesCfg.checkIntervalHours,
      fetchFn: proxyRouter.createScopedFetch("updates.github"),
    });
    const notifyKey = buildUpdateNotificationKey(res);
    if (!notifyKey || !res.latestTag) return;
    if (repo.getRuntimeSetting("last_notified_update_key") === notifyKey) return;

    const outbound = resolveOutboundTarget();
    if (!outbound) return;
    const lines = [
      `Hato 发现新版本 ${res.latestTag}（当前 v${res.currentVersion}，渠道 ${res.channel}）`,
      `发布页: ${res.releaseUrl}`,
    ];
    if (res.notesPreview) {
      lines.push(`更新摘要:\n${res.notesPreview}`);
    }
    await outbound.adapter.sendText(outbound.targetId, lines.join("\n"));
    repo.setRuntimeSetting("last_notified_update_key", notifyKey);
  };

  const updateStartupTimer = setTimeout(() => {
    void runUpdateNotificationCheck().catch((err) => {
      logWarn("UPDATE", `update check failed: ${summarizeError(err)}`);
    });
  }, 15_000);
  updateStartupTimer.unref?.();

  const updatePeriodicTimer = setInterval(() => {
    void runUpdateNotificationCheck().catch((err) => {
      logWarn("UPDATE", `periodic update check failed: ${summarizeError(err)}`);
    });
    try {
      const gc = cleanupExpiredWorkspaces({
        repo,
        workspacesDir: hatoConfig.paths.workspaces_dir,
      });
      if (gc.removedCount > 0) {
        logInfo("HATO", `cleaned up ${gc.removedCount} expired workspace(s)`);
      }
    } catch (err) {
      logWarn("HATO", `workspace cleanup failed: ${summarizeError(err)}`);
    }
  }, 6 * 3600 * 1000);
  updatePeriodicTimer.unref?.();

  try {
    cleanupExpiredWorkspaces({
      repo,
      workspacesDir: hatoConfig.paths.workspaces_dir,
    });
  } catch (err) {
    logWarn("HATO", `startup workspace cleanup failed: ${summarizeError(err)}`);
  }

  const proactiveCareScheduler = new ProactiveCareScheduler({
    getHatoConfig: () => hatoConfig,
    repo,
    actorLock,
    deliverOpenLoop: async ({ canonicalUserId, notifyChannel, loopId, content }) => {
      const preferred: ChannelName | "last_active" | undefined =
        notifyChannel === "tg" || notifyChannel === "qq" || notifyChannel === "last_active"
          ? notifyChannel
          : undefined;
      const outbound = resolveOutboundTarget(preferred);
      if (!outbound) {
        return "no_outbound";
      }
      const bubbles = await personaRuntime.narrateBackgroundEvent({
        canonicalUserId,
        channel: outbound.channel,
        eventSummary: `[主动关怀 ${loopId}] ${content}`,
        promptInstruction: `[系统事件：现在到了主动关怀/跟进时间：${content}。请结合你们的聊天记忆，用自然、温暖、不生硬的日常口吻主动发消息关心或提醒用户（不要提“工单”“open_loop”“系统提醒”等词汇）。如果觉得此刻不适合打扰，输出 [NO_REPLY]。]`,
        fallbackToSummary: false,
        persistEvent: false,
      });
      if (bubbles.length === 0) {
        return "failed";
      }
      const nonEmpty = bubbles.filter((b) => b.trim() && b.trim() !== "[NO_REPLY]");
      if (nonEmpty.length === 0) {
        return "no_reply";
      }
      await outbound.adapter.sendBubbles(
        outbound.targetId,
        nonEmpty,
        hatoConfig.gateway.bubbles.delay_ms_range,
      );
      return "sent";
    },
  });
  proactiveCareScheduler.start(60_000);

  const scriptScheduler = new ScriptScheduler({
    getHatoConfig: () => hatoConfig,
    repo,
    getProtectedSecretNames: () => new Set(modelRegistry.listProviders().map((p) => p.apiKeyEnv)),
    onScriptOutput: async ({ name, notifyChannel, exitCode, stdoutTail, stderrTail }) => {
      const preferred: ChannelName | "last_active" | undefined =
        notifyChannel === "tg" || notifyChannel === "qq" || notifyChannel === "last_active"
          ? notifyChannel
          : undefined;
      const outbound = resolveOutboundTarget(preferred);
      if (!outbound) return;
      const body =
        exitCode === 0
          ? stdoutTail.trim()
          : `退出码=${exitCode}\n${(stderrTail || stdoutTail).trim()}`;
      if (!body) return;
      await outbound.adapter.sendText(
        outbound.targetId,
        `[定时脚本: ${name}] ${exitCode === 0 ? "执行输出" : "执行异常"}\n${body}`,
      );
    },
  });
  scriptScheduler.start(15_000);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo("HATO", "shutting down...");
    clearTimeout(updateStartupTimer);
    clearInterval(updatePeriodicTimer);
    proactiveCareScheduler.dispose();
    scriptScheduler.dispose();
    debouncer.dispose();
    compactionManager.dispose();
    memoryCurator.dispose();
    await ticketCoordinator.abortAll().catch(() => undefined);
    await browserRuntime.dispose();
    await markdownRenderer.dispose();
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
  const hindsightApiKeyEnv = resolveHindsightConfig(config).apiKeyEnv;
  const envNames = new Set<string>([
    config.gateway.telegram.bot_token_env,
    config.gateway.qq.client_secret_env,
    resolveTavilySearchConfig(config).apiKeyEnv,
    resolveMemoryEchoConfig(config).apiKeyEnv,
    ...(hindsightApiKeyEnv ? [hindsightApiKeyEnv] : []),
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
      thinkingLevel: modelRegistry.resolveSlotThinkingLevel(s.slot),
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
    const hsConfig = resolveHindsightConfig(config);
    if (existing instanceof HindsightStore) {
      existing.updateConfig(hsConfig);
      return existing;
    }
    return new HindsightStore(hsConfig, proxyRouter, repo);
  }
  return null;
}
