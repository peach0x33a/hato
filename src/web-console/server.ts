import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { WebChatGateway } from "../gateway/web.js";
import type { BrowserRuntime } from "../browser/runtime.js";
import type { ActorLock } from "../bus/actor-bus.js";
import { tryExecuteSlashCommand, type SlashCommandDeps } from "../commands/slash.js";
import {
  loadHatoConfig,
  resolveHindsightConfig,
  resolveMemoryEchoConfig,
  resolvePromptDisabled,
  resolveMemoryProvider,
  resolvePromptOrder,
  resolveSkillsDir,
  resolveTavilySearchConfig,
  resolveUpdatesConfig,
  resolveWebConsoleConfig,
  resolveWorkerExternalCliConfig,
  validateHatoConfigObject,
  type HatoConfig,
} from "../config/app.js";
import type { ModelRegistry } from "../config/models.js";
import { ModelsDevRegistry } from "../config/models-dev.js";
import { fetchUpstreamModels } from "../config/upstream-models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { ConfigMutationService } from "../config/mutation.js";
import { getOptionalSecret } from "../config/secrets.js";
import {
  isForbiddenSecretEnvName,
  mergeEnvFile,
  readEnvMap,
  resolveAllHomeBindings,
  resolvePlatformHomeBinding,
  unbindHomeChannel,
  updateProactiveChannel,
  writeModelsConfig,
  type PlatformHomeBinding,
} from "../config/store.js";
import {
  HttpStatusError,
  isLoopbackHost,
  maskSecretPreview,
  pruneCache,
  readJsonBody,
  sendJson,
  serveStaticAsset,
  timingSafeTokenEqual,
  validateRequestOriginAndHost,
} from "./http-utils.js";
import {
  handleMemoryForget,
  handleMemoryOverview,
  handleMemoryRecall,
  handleMemoryRecords,
  handleMemorySync,
} from "./memory-routes.js";
import {
  handleBrowserAction,
  handleBrowserInput,
  handleBrowserScreenshot,
  handleBrowserStatus,
  handleBrowserStream,
} from "./browser-routes.js";
import { tryHandleMediaNotebookRoute } from "./media-notebook-routes.js";
import type {
  HatoRepository,
  MemorySyncBank,
  MemorySyncStatus,
} from "../db/repo.js";
import type { TicketCoordinator } from "../dispatch/coordinator.js";
import type { HomeChannelPlatform, ProactiveChannelOption } from "../gateway/types.js";
import { QqOpenApiClient } from "../gateway/qq-client.js";
import { formatGatewayMessageLog } from "../gateway/msg-log.js";
import type { CompactionManager } from "../memory/compaction.js";
import type { MemoryCurator } from "../memory/curator.js";
import type { MemoryStore } from "../memory/store.js";
import type { PersonaRuntime } from "../persona/agent.js";
import { splitIntoBubbles } from "../persona/bubbles.js";
import { buildSystemInjectedPromptText } from "../persona/context.js";
import {
  deletePromptBlock,
  loadLayeredPrompts,
  normalizePromptBlockFilename,
  upsertPromptBlock,
} from "../persona/prompts.js";
import { formatSkillsIndexBlock, loadZoneSkills } from "../skills/loader.js";
import {
  HATO_GITHUB_URL,
  checkForUpdates,
  getCachedUpdateStatus,
  readCurrentHatoVersion,
} from "../utils/update-check.js";
import {
  fetchTelegramBotAvatar,
  fetchTelegramUserProfiles,
  probeAdHocModel,
  probeMemoryService,
  probeModelSlot,
  probeQqGateway,
  probeTavilySearch,
  probeTelegramGateway,
  type TelegramUserProfileResult,
} from "../setup/probe.js";
import {
  computeTurnCostUsd,
  type ModelCostRates,
  parseSinceSpec,
  summarizeTurnTraces,
} from "../stats/metrics.js";
import type { LiveTraceTracker } from "../stats/live-trace.js";
import type { NotebookService } from "../notebook/service.js";
import type { NotebookEntryKind } from "../notebook/store.js";
import type { StickerService } from "../stickers/service.js";
import { getRuntimeLogs, logError, logInfo, logWarn, subscribeRuntimeLogs, summarizeError } from "../utils/logger.js";
import { parseWorkerMandate } from "../dispatch/schema.js";
import { workerActivityHub } from "../worker/activity-stream.js";
import {
  EXTERNAL_CLI_BACKENDS,
  probeAllExternalClis,
  probeExternalCliModels,
  type ExternalCliBackend,
  type ExternalCliProbeEntry,
} from "../worker/cli-probe.js";

export interface WebConsoleReloadResult {
  slots: Array<{ slot: string; target: string; api: string; baseUrl: string }>;
  proxyCount: number;
  changes?: string[];
}

export interface WebConsoleServerDeps {
  hatoConfigPath: string;
  modelsConfigPath: string;
  envPath?: string;
  staticDir?: string;
  getConfig: () => HatoConfig;
  getModelRegistry: () => ModelRegistry;
  getProxyRouter: () => ScopedProxyRouter;
  getStickerService?: () => StickerService;
  getNotebookService?: () => NotebookService | null;
  getRepo: () => HatoRepository;
  getPersonaRuntime: () => PersonaRuntime;
  getBrowserRuntime: () => BrowserRuntime;
  getCompactionManager: () => CompactionManager;
  getMemoryCurator?: () => MemoryCurator;
  getMemoryStore?: () => MemoryStore | null;
  getTicketCoordinator?: () => TicketCoordinator;
  onConfirmAction?: (ticketId: string, approved: boolean) => Promise<string>;
  getLiveTraceTracker?: () => LiveTraceTracker;
  getActorLock: () => ActorLock;
  getSlashDeps: (canonicalUserId: string) => SlashCommandDeps;
  reloadAll: () => Promise<WebConsoleReloadResult>;
  configMutation?: ConfigMutationService<WebConsoleReloadResult>;
  modelsDevRegistry?: ModelsDevRegistry;
  probeExternalClis?: (config: HatoConfig) => Promise<ExternalCliProbeEntry[]>;
  getGatewayStatus?: () => {
    telegram: { enabled: boolean; running: boolean; online: boolean; username?: string };
    qq: { enabled: boolean; running: boolean; online: boolean; sessionId?: string };
  };
  toggleGateway?: (channel: "tg" | "qq", enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  unbindHome?: (options: {
    channel: HomeChannelPlatform;
    clearChannelWhitelist?: boolean;
  }) => Promise<{
    ok: boolean;
    previousHome: PlatformHomeBinding;
    home: PlatformHomeBinding;
    clearedWhitelist: boolean;
    error?: string;
  }>;
  setProactiveChannel?: (proactiveChannel: ProactiveChannelOption) => Promise<{
    ok: boolean;
    proactiveChannel: ProactiveChannelOption;
    error?: string;
  }>;
}

/**
 * Embedded HTTP/SSE console server exposing config, diagnostics, telemetry, and live chat APIs
 * alongside the built Vite + beUI SPA bundle.
 */
export class WebConsoleServer {
  private server: http.Server | null = null;
  private boundPort: number | null = null;
  private readonly startedAtMs = Date.now();
  private readonly envPath: string;
  private readonly staticDir: string;
  private readonly modelsDevRegistry: ModelsDevRegistry;
  private readonly configMutation: ConfigMutationService<WebConsoleReloadResult>;
  private readonly webChatGateway: WebChatGateway;
  private readonly tgProfileCache = new Map<
    string,
    { expiresAt: number; profile: TelegramUserProfileResult }
  >();
  private readonly botAvatarCache = new Map<
    string,
    { expiresAt: number; avatarUrl?: string; username?: string; displayName?: string; botId?: string }
  >();

  constructor(private readonly deps: WebConsoleServerDeps) {
    this.envPath = deps.envPath ?? ".env";
    this.staticDir = resolve(deps.staticDir ?? "web/dist");
    this.modelsDevRegistry =
      deps.modelsDevRegistry ??
      new ModelsDevRegistry({
        cacheFilePath: resolve("data/models-dev-cache.json"),
        getProxyRouter: deps.getProxyRouter,
      });
    this.configMutation =
      deps.configMutation ??
      new ConfigMutationService<WebConsoleReloadResult>({
        hatoConfigPath: deps.hatoConfigPath,
        envPath: this.envPath,
        getFallbackConfig: deps.getConfig,
        onReload: deps.reloadAll,
      });
    this.webChatGateway = new WebChatGateway({
      getOwnerUserId: () => deps.getConfig().owner.canonical_user_id,
      getTimezone: () => deps.getConfig().owner.timezone,
      getBubbleConfig: () => {
        const b = deps.getConfig().gateway.bubbles;
        return { enabled: b.enabled, maxPerTurn: b.max_per_turn, delimiter: b.delimiter };
      },
      splitBubbles: (text, opts) => splitIntoBubbles(text, opts),
      getRepo: deps.getRepo,
      isPendingTakeover: () => deps.getBrowserRuntime().isPendingTakeover(),
      getSlotViews: () => this.buildSlotViews(deps.getModelRegistry()),
      getAvailableModels: () => deps.getModelRegistry().listTargets(),
      trySlashCommand: ({ canonicalUserId, text }) =>
        tryExecuteSlashCommand({
          canonicalUserId,
          text,
          channel: "web",
          platformUserId: canonicalUserId,
          deps: deps.getSlashDeps(canonicalUserId),
        }),
      handleChatTurn: async ({ batch, images, emit }) => {
        const uid = batch.canonicalUserId;
        const compactionManager = deps.getCompactionManager();
        const personaRuntime = deps.getPersonaRuntime();
        const actorLock = deps.getActorLock();
        const ticketCoordinator = deps.getTicketCoordinator?.();

        await actorLock.run(uid, async () => {
          if (ticketCoordinator) {
            const routed = await ticketCoordinator
              .tryRouteInboundToTicket(batch)
              .catch(() => ({ handledByTicket: false as const }));
            if (routed.handledByTicket) {
              const ackBubbles = [`已收到补充说明，正在继续执行工单 ${routed.ticketId ?? ""}…`];
              emit({ type: "assistant_bubbles", bubbles: ackBubbles });
              return;
            }
          }

          const output = await personaRuntime.handleUserBatch(batch, images, {
            sendPhotoToUser: async (photo, caption) => {
              const dataUrl = `data:image/png;base64,${photo.toString("base64")}`;
              emit({ type: "photo", dataUrl, caption });
            },
            sendBubblesToUser: async (earlyBubbles) => {
              if (earlyBubbles.length === 0) return;
              for (const bubble of earlyBubbles) {
                console.log(
                  formatGatewayMessageLog({
                    direction: "outbound",
                    channel: "web",
                    timeZone: deps.getConfig().owner.timezone,
                    userSlug: uid,
                    text: bubble,
                  }),
                );
              }
              emit({ type: "early_bubbles", bubbles: earlyBubbles });
            },
            onRetryNotice: async (noticeText) => {
              emit({ type: "early_bubbles", bubbles: [noticeText] });
            },
          });

          for (const bubble of output.bubbles) {
            console.log(
              formatGatewayMessageLog({
                direction: "outbound",
                channel: "web",
                timeZone: deps.getConfig().owner.timezone,
                userSlug: uid,
                text: bubble,
              }),
            );
          }

          emit({
            type: "assistant_bubbles",
            bubbles: output.bubbles,
            telemetry: {
              latencyMs: output.latencyMs,
              ttftMs: output.ttftMs,
              cacheHitRate: output.cacheHitRate,
              tps: output.tps,
              toolCalls: output.toolCalls,
            },
          });

          compactionManager.recordInteraction(uid);
          deps.getMemoryCurator?.().recordInteraction(uid);
          void compactionManager.checkHighWatermark(uid).catch(() => undefined);
        });
      },
      readJsonBody,
      sendJson,
    });
  }

  getAddress(): { host: string; port: number } | null {
    if (!this.server || this.boundPort === null) return null;
    const cfg = resolveWebConsoleConfig(this.deps.getConfig());
    return { host: cfg.host, port: this.boundPort };
  }

  invalidateBotProfileCache(channel?: "tg" | "qq"): void {
    if (!channel) {
      this.botAvatarCache.clear();
      return;
    }
    for (const key of this.botAvatarCache.keys()) {
      if (key.startsWith(`${channel}:`)) {
        this.botAvatarCache.delete(key);
      }
    }
  }

  async start(): Promise<{ host: string; port: number } | null> {
    const cfg = resolveWebConsoleConfig(this.deps.getConfig());
    if (!cfg.enabled) return null;
    if (this.server) return this.getAddress();
    this.modelsDevRegistry.warmCache();
    if (!isLoopbackHost(cfg.host) && !getOptionalSecret(cfg.authTokenEnv)) {
      const msg = cfg.authTokenEnv
        ? `Web Console is bound to non-loopback host "${cfg.host}" without ${cfg.authTokenEnv}. Set ${cfg.authTokenEnv} in .env if exposed beyond a trusted LAN.`
        : `Web Console is bound to non-loopback host "${cfg.host}" without auth_token_env configured. Set [web.console].auth_token_env in hato.toml and the corresponding token in .env if exposed beyond a trusted LAN.`;
      logWarn("WEB", msg);
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(cfg.port, cfg.host, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });

    const addr = server.address();
    this.server = server;
    this.boundPort = addr && typeof addr !== "string" ? addr.port : cfg.port;
    logInfo("WEB", `console listening on http://${cfg.host}:${this.boundPort}`);
    return { host: cfg.host, port: this.boundPort };
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = null;
    this.boundPort = null;
    if (!srv) return;
    srv.closeAllConnections?.();
    await new Promise<void>((resolveClose) => srv.close(() => resolveClose()));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = parsedUrl.pathname;

    try {
      if (pathname.startsWith("/api/")) {
        const consoleCfg = resolveWebConsoleConfig(this.deps.getConfig());
        const csrfCheck = validateRequestOriginAndHost(req, method, consoleCfg.host);
        if (!csrfCheck.ok) {
          sendJson(res, 403, { ok: false, error: csrfCheck.error });
          return;
        }
      }

      if (pathname === "/api/health" && method === "GET") {
        const hato = this.deps.getConfig();
        const consoleCfg = resolveWebConsoleConfig(hato);
        const authSecret = getOptionalSecret(consoleCfg.authTokenEnv);
        const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
        let inDocker = existsSync("/.dockerenv");
        if (!inDocker) {
          try {
            if (existsSync("/proc/1/cgroup")) {
              const cgroup = readFileSync("/proc/1/cgroup", "utf8");
              inDocker = /(docker|containerd|kubepods|podman|lxc)/i.test(cgroup);
            }
          } catch {
            // ignore
          }
        }
        const updatesCfg = resolveUpdatesConfig(hato);
        const currentVersion = readCurrentHatoVersion();
        const cachedUpdate = updatesCfg.checkEnabled
          ? getCachedUpdateStatus({ channel: updatesCfg.channel })
          : null;
        if (
          updatesCfg.checkEnabled &&
          (!cachedUpdate ||
            Date.now() - cachedUpdate.checkedAtMs >= updatesCfg.checkIntervalHours * 3600 * 1000)
        ) {
          void checkForUpdates({
            channel: updatesCfg.channel,
            ttlHours: updatesCfg.checkIntervalHours,
            fetchFn: this.deps.getProxyRouter().createScopedFetch("updates.github"),
          }).catch(() => undefined);
        }
        sendJson(res, 200, {
          ok: true,
          version: currentVersion,
          githubUrl: HATO_GITHUB_URL,
          update: cachedUpdate
            ? {
                channel: cachedUpdate.channel,
                hasUpdate: cachedUpdate.hasUpdate,
                latestTag: cachedUpdate.latestTag,
                releaseUrl: cachedUpdate.releaseUrl,
              }
            : {
                channel: updatesCfg.channel,
                hasUpdate: false,
                latestTag: null,
                releaseUrl: `${HATO_GITHUB_URL}/releases`,
              },
          uptimeSec: Math.round((Date.now() - this.startedAtMs) / 1000),
          telegramEnabled: hato.gateway.telegram.enabled,
          pendingTakeover: this.deps.getBrowserRuntime().isPendingTakeover(),
          authRequired: Boolean(authSecret),
          unauthenticatedPublicBind: !isLoopbackHost(consoleCfg.host) && !authSecret,
          runtime: {
            isRoot,
            inDocker,
            showRootWarning: isRoot && !inDocker,
          },
          console: {
            host: consoleCfg.host,
            port: this.boundPort ?? consoleCfg.port,
          },
        });
        return;
      }

      if (pathname.startsWith("/api/")) {
        if (!this.isAuthorized(req, pathname, parsedUrl)) {
          sendJson(res, 401, { ok: false, error: "Unauthorized: invalid or missing console token" });
          return;
        }

        if (pathname === "/api/overview" && method === "GET") {
          await this.handleGetOverview(res);
          return;
        }
        if (pathname === "/api/pairing-code" && method === "GET") {
          const refresh = parsedUrl.searchParams.get("refresh") === "1";
          const chParam = parsedUrl.searchParams.get("channel");
          const refreshChannel: HomeChannelPlatform | undefined =
            chParam === "tg" || chParam === "qq" ? chParam : undefined;
          sendJson(res, 200, this.buildHomeBindingsSnapshot({ refresh, refreshChannel }));
          return;
        }
        if (pathname === "/api/home/unbind" && method === "POST") {
          await this.handleUnbindHome(req, res);
          return;
        }
        if (pathname === "/api/home/proactive-channel" && method === "PUT") {
          await this.handleSetProactiveChannel(req, res);
          return;
        }
        if (pathname === "/api/gateway/toggle" && method === "POST") {
          await this.handleToggleGateway(req, res);
          return;
        }
        if (pathname === "/api/sessions" && method === "GET") {
          this.handleListSessions(res);
          return;
        }
        if (pathname === "/api/chat/history" && method === "GET") {
          await this.webChatGateway.handleHistory(parsedUrl, res);
          return;
        }
        if (pathname === "/api/chat/send" && method === "POST") {
          await this.webChatGateway.handleSend(req, res);
          return;
        }
        if (pathname === "/api/config" && method === "GET") {
          await this.handleGetConfig(res);
          return;
        }
        if (pathname === "/api/config/hato" && method === "PUT") {
          await this.handleSaveHato(req, res);
          return;
        }
        if (pathname === "/api/config/models" && method === "PUT") {
          await this.handleSaveModels(req, res);
          return;
        }
        if (pathname === "/api/config/thinking" && method === "PUT") {
          await this.handleSaveThinking(req, res);
          return;
        }
        if (pathname === "/api/config/models/test" && method === "POST") {
          await this.handleTestModel(req, res);
          return;
        }
        if (pathname === "/api/config/models/upstream" && method === "POST") {
          await this.handleFetchUpstreamModels(req, res);
          return;
        }
        if (pathname === "/api/models-dev/lookup" && method === "GET") {
          await this.handleModelsDevLookup(parsedUrl, res);
          return;
        }
        if (pathname === "/api/models-dev/search" && method === "GET") {
          await this.handleModelsDevSearch(parsedUrl, res);
          return;
        }
        if (pathname === "/api/config/prompt" && method === "PUT") {
          await this.handleSavePrompt(req, res);
          return;
        }
        if (pathname === "/api/config/prompts/order" && method === "PUT") {
          await this.handleSavePromptOrder(req, res);
          return;
        }
        if (pathname === "/api/config/prompts/block" && method === "PUT") {
          await this.handleUpsertPromptBlock(req, res);
          return;
        }
        if (pathname === "/api/config/prompts/block" && method === "DELETE") {
          await this.handleDeletePromptBlock(parsedUrl, req, res);
          return;
        }
        if (pathname === "/api/config/secrets" && method === "PUT") {
          await this.handleSaveSecrets(req, res);
          return;
        }
        if (pathname === "/api/config/reload" && method === "POST") {
          const reloadRes = await this.configMutation.reloadRuntime();
          sendJson(res, 200, { ok: true, ...reloadRes });
          return;
        }
        if (pathname === "/api/config/probe" && method === "POST") {
          await this.handleProbe(req, res);
          return;
        }
        if (pathname === "/api/gateway/telegram/users" && method === "POST") {
          await this.handleTelegramUsersLookup(req, res);
          return;
        }
        if (pathname === "/api/worker/cli-probe" && (method === "GET" || method === "POST")) {
          await this.handleWorkerCliProbe(res);
          return;
        }
        if (pathname === "/api/worker/cli-models" && method === "GET") {
          await this.handleWorkerCliModels(parsedUrl, res);
          return;
        }
        if (pathname === "/api/memory/overview" && method === "GET") {
          await handleMemoryOverview(this.deps, res);
          return;
        }
        if (pathname === "/api/memory/records" && method === "GET") {
          await handleMemoryRecords(this.deps, parsedUrl, res);
          return;
        }
        if (pathname === "/api/memory/recall" && method === "POST") {
          await handleMemoryRecall(this.deps, req, res);
          return;
        }
        if (pathname === "/api/memory/sync" && method === "POST") {
          await handleMemorySync(this.deps, req, res);
          return;
        }
        if (pathname === "/api/memory/forget" && method === "POST") {
          await handleMemoryForget(this.deps, req, res);
          return;
        }
        if (pathname === "/api/statics" && method === "GET") {
          this.handleStatics(parsedUrl, res);
          return;
        }
        if (pathname === "/api/traces/stream" && method === "GET") {
          this.handleTracesStream(req, res);
          return;
        }
        if (pathname === "/api/logs" && method === "GET") {
          const rawLimit = Number(parsedUrl.searchParams.get("limit") ?? "300");
          const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.floor(rawLimit))) : 300;
          const category = parsedUrl.searchParams.get("category") ?? undefined;
          const scope = parsedUrl.searchParams.get("scope") ?? undefined;
          const q = parsedUrl.searchParams.get("q") ?? undefined;
          sendJson(res, 200, { ok: true, logs: getRuntimeLogs({ limit, category, scope, q }) });
          return;
        }
        if (pathname === "/api/logs/stream" && method === "GET") {
          this.handleLogsStream(req, res);
          return;
        }
        if (await tryHandleMediaNotebookRoute(this.deps, req, res, pathname, method, parsedUrl)) {
          return;
        }
        if (pathname === "/api/tickets" && method === "GET") {
          this.handleListTickets(res);
          return;
        }
        if (pathname === "/api/tickets/stream" && method === "GET") {
          this.handleTicketActivityStream(parsedUrl, req, res);
          return;
        }
        if (pathname === "/api/tickets/confirm" && method === "POST") {
          await this.handleTicketConfirm(req, res);
          return;
        }
        if (pathname === "/api/tickets/abort" && method === "POST") {
          await this.handleTicketAbort(req, res);
          return;
        }
        if (pathname === "/api/browser/status" && method === "GET") {
          await handleBrowserStatus(this.deps, res);
          return;
        }
        if (pathname === "/api/browser/stream" && method === "GET") {
          handleBrowserStream(this.deps, req, res);
          return;
        }
        if (pathname === "/api/browser/screenshot" && method === "GET") {
          await handleBrowserScreenshot(this.deps, res);
          return;
        }
        if (pathname === "/api/browser/action" && method === "POST") {
          await handleBrowserAction(this.deps, req, res);
          return;
        }
        if (pathname === "/api/browser/input" && method === "POST") {
          await handleBrowserInput(this.deps, req, res);
          return;
        }

        sendJson(res, 404, { ok: false, error: `Unknown API route: ${method} ${pathname}` });
        return;
      }

      if (method === "GET" || method === "HEAD") {
        serveStaticAsset(this.staticDir, pathname, res, method === "HEAD");
        return;
      }

      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
    } catch (err) {
      const statusCode = err instanceof HttpStatusError ? err.statusCode : 500;
      const msg = err instanceof HttpStatusError ? err.message : summarizeError(err);
      if (statusCode >= 500) {
        logError("WEB", `${method} ${pathname} (${statusCode})`, err);
      } else if (statusCode >= 400 && statusCode !== 401) {
        logWarn("WEB", `${method} ${pathname} (${statusCode}): ${msg}`);
      }
      if (!res.headersSent) {
        sendJson(res, statusCode, { ok: false, error: msg });
      } else {
        res.end();
      }
    }
  }

  private isAuthorized(req: IncomingMessage, pathname: string, parsedUrl: URL): boolean {
    const consoleCfg = resolveWebConsoleConfig(this.deps.getConfig());
    const requiredToken = getOptionalSecret(consoleCfg.authTokenEnv);
    if (!requiredToken) return true;

    const authHeader = req.headers.authorization ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (bearer && timingSafeTokenEqual(bearer, requiredToken)) return true;

    const customHeader = req.headers["x-hato-token"];
    if (typeof customHeader === "string" && timingSafeTokenEqual(customHeader.trim(), requiredToken)) {
      return true;
    }

    // Support query token exclusively for image <img> tags on sticker & notebook thumbnails.
    if (
      (req.method ?? "GET").toUpperCase() === "GET" &&
      (/^\/api\/stickers\/[^/]+\/image$/.test(pathname) ||
        /^\/api\/notebook\/[^/]+\/image$/.test(pathname))
    ) {
      const queryToken = parsedUrl.searchParams.get("token")?.trim() ?? "";
      if (queryToken && timingSafeTokenEqual(queryToken, requiredToken)) {
        return true;
      }
    }

    return false;
  }

  private buildHomeBindingsSnapshot(options?: {
    refresh?: boolean;
    refreshChannel?: HomeChannelPlatform;
  }) {
    const hato = this.deps.getConfig();
    const repo = this.deps.getRepo();

    const buildEntry = (channel: HomeChannelPlatform) => {
      const binding = resolvePlatformHomeBinding(channel, hato, repo);
      if (
        !binding.bound &&
        options?.refresh &&
        (!options.refreshChannel || options.refreshChannel === channel)
      ) {
        repo.deleteHomePairingCode(channel);
      }
      const pairingInfo = binding.bound ? null : repo.getHomePairingCodeInfo(channel);
      return {
        channel,
        enabled: channel === "tg" ? hato.gateway.telegram.enabled : hato.gateway.qq.enabled,
        bound: binding.bound,
        targetId: binding.targetId,
        source: binding.source,
        whitelistCount:
          channel === "tg"
            ? hato.owner.channels.tg.user_ids.length
            : hato.owner.channels.qq.open_ids.length,
        pairing: pairingInfo
          ? {
              code: pairingInfo.code,
              command: `/sethome ${pairingInfo.code}`,
              expiresAt: pairingInfo.expiresAt,
            }
          : null,
      };
    };

    return {
      ok: true,
      proactiveChannel: hato.owner.proactive_channel,
      lastActiveChannel: repo.getLastActiveImChannel(hato.owner.canonical_user_id),
      platforms: {
        tg: buildEntry("tg"),
        qq: buildEntry("qq"),
      },
    };
  }

  private async handleUnbindHome(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as {
      channel?: unknown;
      clearChannelWhitelist?: unknown;
    };
    const channel: HomeChannelPlatform | null =
      body.channel === "tg" ? "tg" : body.channel === "qq" ? "qq" : null;
    if (!channel) {
      sendJson(res, 400, { ok: false, error: "Invalid channel (expected 'tg' or 'qq')" });
      return;
    }
    const clearChannelWhitelist = body.clearChannelWhitelist === true;
    const repo = this.deps.getRepo();

    if (this.deps.unbindHome) {
      const result = await this.deps.unbindHome({ channel, clearChannelWhitelist });
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.error ?? "解绑原 Home 失败" });
        return;
      }
      sendJson(res, 200, {
        ...this.buildHomeBindingsSnapshot(),
        channel,
        previousHome: result.previousHome,
        clearedWhitelist: result.clearedWhitelist,
      });
      return;
    }

    const hato = this.deps.getConfig();
    const resUnbind = unbindHomeChannel({
      channel,
      hatoConfigPath: this.deps.hatoConfigPath,
      repo,
      canonicalUserId: hato.owner.canonical_user_id,
      currentConfig: hato,
      clearChannelWhitelist,
    });
    await this.deps.reloadAll();
    sendJson(res, 200, {
      ...this.buildHomeBindingsSnapshot(),
      channel,
      previousHome: resUnbind.previousHome,
      clearedWhitelist: resUnbind.clearedWhitelist,
    });
  }

  private async handleSetProactiveChannel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as { proactiveChannel?: unknown };
    const proactiveChannel: ProactiveChannelOption | null =
      body.proactiveChannel === "tg" ||
      body.proactiveChannel === "qq" ||
      body.proactiveChannel === "last_active"
        ? body.proactiveChannel
        : null;
    if (!proactiveChannel) {
      sendJson(res, 400, {
        ok: false,
        error: "Invalid proactiveChannel (expected 'tg', 'qq', or 'last_active')",
      });
      return;
    }

    if (this.deps.setProactiveChannel) {
      const result = await this.deps.setProactiveChannel(proactiveChannel);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.error ?? "更新默认推送渠道失败" });
        return;
      }
      sendJson(res, 200, this.buildHomeBindingsSnapshot());
      return;
    }

    const hato = this.deps.getConfig();
    const repo = this.deps.getRepo();
    updateProactiveChannel({
      hatoConfigPath: this.deps.hatoConfigPath,
      repo,
      canonicalUserId: hato.owner.canonical_user_id,
      proactiveChannel,
      currentConfig: hato,
    });
    await this.deps.reloadAll();
    sendJson(res, 200, this.buildHomeBindingsSnapshot());
  }

  private async handleToggleGateway(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as { channel?: unknown; enabled?: unknown };
    const channel = body.channel === "qq" ? "qq" : body.channel === "tg" ? "tg" : null;
    if (!channel || typeof body.enabled !== "boolean") {
      sendJson(res, 400, { ok: false, error: "Invalid channel or enabled flag" });
      return;
    }
    if (!this.deps.toggleGateway) {
      sendJson(res, 501, { ok: false, error: "Gateway toggle handler is not configured" });
      return;
    }
    const result = await this.deps.toggleGateway(channel, body.enabled);
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error ?? "Failed to toggle gateway" });
      return;
    }
    sendJson(res, 200, { ok: true, channel, enabled: body.enabled });
  }

  private async resolveBotProfile(
    channel: "tg" | "qq",
    hato: HatoConfig,
  ): Promise<{ avatarUrl?: string; username?: string; displayName?: string; botId?: string }> {
    const cacheKey =
      channel === "tg"
        ? `tg:${hato.gateway.telegram.base_url}:${hato.gateway.telegram.bot_token_env}`
        : `qq:${hato.gateway.qq.base_url}:${hato.gateway.qq.app_id}`;
    const cached = this.botAvatarCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        avatarUrl: cached.avatarUrl,
        username: cached.username,
        displayName: cached.displayName,
        botId: cached.botId,
      };
    }

    const envMap = readEnvMap(this.envPath);
    const proxyRouter = this.deps.getProxyRouter();
    let avatarUrl: string | undefined;
    let username: string | undefined;
    let displayName: string | undefined;
    let botId: string | undefined;

    try {
      if (channel === "tg" && hato.gateway.telegram.enabled) {
        const botToken =
          envMap[hato.gateway.telegram.bot_token_env]?.trim() ||
          process.env[hato.gateway.telegram.bot_token_env]?.trim() ||
          "";
        if (botToken) {
          const me = await probeTelegramGateway({
            baseUrl: hato.gateway.telegram.base_url,
            botToken,
            proxyRouter,
            timeoutMs: 6000,
          });
          if (me.ok) {
            username = me.username || undefined;
            displayName = me.firstName?.trim() || undefined;
            if (me.botId) {
              botId = String(me.botId);
              avatarUrl = await fetchTelegramBotAvatar({
                baseUrl: hato.gateway.telegram.base_url,
                botToken,
                botId: me.botId,
                proxyRouter,
                timeoutMs: 12_000,
              });
            }
          }
        }
      } else if (channel === "qq" && hato.gateway.qq.enabled && hato.gateway.qq.app_id.trim()) {
        const clientSecret =
          envMap[hato.gateway.qq.client_secret_env]?.trim() ||
          process.env[hato.gateway.qq.client_secret_env]?.trim() ||
          "";
        if (clientSecret) {
          const client = new QqOpenApiClient({
            baseUrl: hato.gateway.qq.base_url,
            appId: hato.gateway.qq.app_id.trim(),
            clientSecret,
            proxyRouter,
          });
          const me = await client.getMe();
          avatarUrl = me.avatar || undefined;
          username = me.username?.trim() || undefined;
          botId = me.id?.trim() || hato.gateway.qq.app_id.trim();
        }
      }
    } catch {
      avatarUrl = undefined;
      username = undefined;
      displayName = undefined;
      botId = undefined;
    }

    pruneCache(this.botAvatarCache);
    this.botAvatarCache.set(cacheKey, {
      expiresAt: Date.now() + (avatarUrl || username || displayName ? 10 * 60_000 : 15_000),
      avatarUrl,
      username,
      displayName,
      botId,
    });
    return { avatarUrl, username, displayName, botId };
  }

  private async handleGetOverview(res: ServerResponse): Promise<void> {
    const hato = this.deps.getConfig();
    const repo = this.deps.getRepo();
    const registry = this.deps.getModelRegistry();
    const canonicalUserId = hato.owner.canonical_user_id;
    const dbStats = repo.getOverviewStats(canonicalUserId);

    const gwStatus = this.deps.getGatewayStatus?.() ?? {
      telegram: {
        enabled: hato.gateway.telegram.enabled,
        running: false,
        online: false,
      },
      qq: {
        enabled: hato.gateway.qq.enabled,
        running: false,
        online: false,
      },
    };

    const [tgProfile, qqProfile] = await Promise.all([
      this.resolveBotProfile("tg", hato),
      this.resolveBotProfile("qq", hato),
    ]);

    const slots = registry.listSlots();
    const personaTarget = slots.find((s) => s.slot === "persona")?.target ?? "";
    const routerTarget = slots.find((s) => s.slot === "router")?.target ?? "";
    const homes = {
      ...resolveAllHomeBindings(hato, repo),
      lastActiveChannel: repo.getLastActiveImChannel(hato.owner.canonical_user_id),
    };

    sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - this.startedAtMs) / 1000),
      homes,
      gateways: {
        telegram: {
          ...gwStatus.telegram,
          username: gwStatus.telegram.username || tgProfile.username,
          displayName: tgProfile.displayName,
          botId: tgProfile.botId,
          avatarUrl: tgProfile.avatarUrl,
          whitelistCount: hato.owner.channels.tg.user_ids.length,
        },
        qq: {
          ...gwStatus.qq,
          username: qqProfile.username,
          botId: qqProfile.botId || hato.gateway.qq.app_id.trim() || undefined,
          avatarUrl: qqProfile.avatarUrl,
          whitelistCount: hato.owner.channels.qq.open_ids.length,
        },
      },
      ...dbStats,
      runtime: {
        personaModel: personaTarget,
        routerModel: routerTarget,
        workerBackend: hato.worker.default_backend,
        workerRoutingMode: hato.worker.routing_mode ?? "smart",
        memoryProvider: resolveMemoryProvider(hato),
        pendingTakeover: this.deps.getBrowserRuntime().isPendingTakeover(),
      },
    });
  }

  private handleListSessions(res: ServerResponse): void {
    const hato = this.deps.getConfig();
    const repo = this.deps.getRepo();
    const sessions = repo.listChatSessions(hato.owner.canonical_user_id, 50);
    sendJson(res, 200, { ok: true, sessions });
  }

  private buildSlotViews(registry: ModelRegistry) {
    return registry.listSlots().map((s) => ({
      slot: s.slot,
      target: s.target,
      api: String(s.model.api),
      baseUrl: s.model.baseUrl,
      thinkingLevel: registry.resolveSlotThinkingLevel(s.slot),
      supportedThinkingLevels: getSupportedThinkingLevels(s.model),
      reasoning: Boolean(s.model.reasoning),
    }));
  }

  private buildPromptLayersSnapshot(hatoConfig: HatoConfig) {
    const layered = loadLayeredPrompts(
      hatoConfig.paths.prompts_dir,
      resolvePromptOrder(hatoConfig),
      resolvePromptDisabled(hatoConfig),
    );
    const personalSkills = loadZoneSkills(resolveSkillsDir(hatoConfig), "personal");
    const toolIndexText = this.deps.getPersonaRuntime().getToolIndexText();
    const systemInjectedText = buildSystemInjectedPromptText(
      this.deps.getRepo(),
      formatSkillsIndexBlock(personalSkills),
      toolIndexText,
      {
        enabled: hatoConfig.gateway.bubbles.enabled,
        maxPerTurn: hatoConfig.gateway.bubbles.max_per_turn,
        delimiter: hatoConfig.gateway.bubbles.delimiter,
      },
    );
    return {
      layered,
      promptLayers: {
        mode: layered.mode,
        order: layered.order,
        disabled: layered.disabled,
        blocks: layered.blocks.map((b) => ({
          name: b.name,
          path: b.path,
          content: b.content,
          ...(b.defaultDisabled ? { defaultDisabled: true } : {}),
        })),
        systemPath: layered.systemPath,
        systemText: layered.systemText,
        soulPath: layered.soulPath,
        soulText: layered.soulText,
        combinedText: layered.combinedText,
        systemInjectedText,
      },
    };
  }

  private async handleGetConfig(res: ServerResponse): Promise<void> {
    const hatoConfig = this.deps.getConfig();
    const modelsRegistry = this.deps.getModelRegistry();
    const modelsConfig = modelsRegistry.getFileConfig();
    modelsConfig.slots = modelsRegistry.getEffectiveSlots();
    const effectiveThinking = modelsRegistry.getEffectiveSlotThinkingMap();
    if (Object.keys(effectiveThinking).length > 0) {
      modelsConfig.slot_thinking = effectiveThinking;
    } else {
      delete modelsConfig.slot_thinking;
    }
    const { layered, promptLayers } = this.buildPromptLayersSnapshot(hatoConfig);
    const promptPath = layered.soulPath;
    const promptText = layered.soulText;

    const envMap = readEnvMap(this.envPath);
    const knownKeys = this.collectKnownSecretEnvNames(hatoConfig, modelsRegistry);
    const secretStates = knownKeys.map((key) => {
      const val = envMap[key]?.trim() || process.env[key]?.trim() || "";
      return {
        key,
        configured: val.length > 0,
        masked: val ? maskSecretPreview(val) : "",
      };
    });

    sendJson(res, 200, {
      ok: true,
      hatoConfig,
      modelsConfig,
      promptPath,
      promptText,
      promptLayers,
      secretStates,
    });
  }

  private async handleSaveHato(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = (await readJsonBody(req)) as { config?: unknown };
    const validated = validateHatoConfigObject(payload.config, this.deps.hatoConfigPath);
    const writeRes = await this.configMutation.writeHatoConfigAndReload(validated, { backup: true });
    sendJson(res, 200, {
      ok: true,
      path: writeRes.path,
      backupPath: writeRes.backupPath,
      ...writeRes.reload,
    });
  }

  private async handleSaveModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = (await readJsonBody(req)) as { config?: unknown };
    const writeRes = writeModelsConfig(
      this.deps.modelsConfigPath,
      payload.config as ReturnType<ModelRegistry["getFileConfig"]>,
      { backup: true },
    );
    this.deps.getModelRegistry().clearSlotOverrides();
    this.deps.getModelRegistry().clearSlotThinkingOverrides();
    const reloadRes = await this.configMutation.reloadRuntime();
    sendJson(res, 200, {
      ok: true,
      path: writeRes.path,
      backupPath: writeRes.backupPath,
      ...reloadRes,
    });
  }

  private async handleSaveThinking(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = (await readJsonBody(req)) as { slot?: unknown; level?: unknown };
    const slot = typeof payload.slot === "string" ? payload.slot.trim() : "";
    if (!slot) {
      sendJson(res, 400, { ok: false, error: "请提供有效的模型槽位" });
      return;
    }
    const level = typeof payload.level === "string" ? payload.level.trim() : null;
    const registry = this.deps.getModelRegistry();
    try {
      const updated = registry.setSlotThinkingOverride(slot, level);
      sendJson(res, 200, {
        ok: true,
        ...updated,
        slots: this.buildSlotViews(registry),
      });
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleModelsDevLookup(parsedUrl: URL, res: ServerResponse): Promise<void> {
    const ref = parsedUrl.searchParams.get("ref")?.trim() ?? "";
    if (!ref) {
      sendJson(res, 400, { ok: false, error: "请提供 models.dev 映射 ID (ref)" });
      return;
    }
    const refresh = parsedUrl.searchParams.get("refresh") === "1";
    try {
      const metadata = await this.modelsDevRegistry.lookup(ref, refresh);
      if (!metadata) {
        sendJson(res, 404, {
          ok: false,
          error: `未在 models.dev 找到 "${ref}"，请检查格式（如 openai/gpt-4o）或尝试搜索`,
        });
        return;
      }
      sendJson(res, 200, { ok: true, metadata });
    } catch (err) {
      const message = summarizeError(err);
      const status = message.includes("无效的 models.dev 映射 ID") ? 400 : 502;
      sendJson(res, status, { ok: false, error: message });
    }
  }

  private async handleModelsDevSearch(parsedUrl: URL, res: ServerResponse): Promise<void> {
    const q = parsedUrl.searchParams.get("q") ?? "";
    const rawLimit = Number(parsedUrl.searchParams.get("limit") ?? "15");
    const limit = Number.isFinite(rawLimit) ? rawLimit : 15;
    try {
      const items = await this.modelsDevRegistry.search(q, limit);
      sendJson(res, 200, { ok: true, items });
    } catch (err) {
      sendJson(res, 502, { ok: false, error: summarizeError(err) });
    }
  }

  private async handleSavePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = (await readJsonBody(req)) as { promptText?: unknown };
    if (typeof payload.promptText !== "string") {
      sendJson(res, 400, { ok: false, error: "promptText must be a string" });
      return;
    }

    const hato = this.deps.getConfig();
    const { layered } = this.buildPromptLayersSnapshot(hato);
    const absPromptPath = layered.soulPath;
    mkdirSync(dirname(absPromptPath), { recursive: true });
    let backupPath: string | undefined;
    if (existsSync(absPromptPath)) {
      backupPath = `${absPromptPath}.bak`;
      copyFileSync(absPromptPath, backupPath);
    }
    writeFileSync(absPromptPath, payload.promptText, "utf8");
    const reloadRes = await this.deps.reloadAll();
    const nextHato = this.deps.getConfig();
    const nextSnapshot = this.buildPromptLayersSnapshot(nextHato);
    sendJson(res, 200, {
      ok: true,
      path: absPromptPath,
      backupPath,
      hatoConfig: nextHato,
      promptPath: nextSnapshot.layered.soulPath,
      promptText: nextSnapshot.layered.soulText,
      promptLayers: nextSnapshot.promptLayers,
      ...reloadRes,
    });
  }

  private async persistPromptsSectionAndReload(nextPrompts: { order: string[]; disabled: string[] }): Promise<{
    path: string;
    backupPath?: string;
    config: HatoConfig;
    reload: WebConsoleReloadResult;
  }> {
    const cleanedOrder = nextPrompts.order.map((s) => s.trim()).filter(Boolean);
    const cleanedDisabled = nextPrompts.disabled.map((s) => s.trim()).filter(Boolean);
    let validated!: HatoConfig;
    const res = await this.configMutation.patchHatoConfigAndReload((base) => {
      const nextConfig: HatoConfig = {
        ...base,
        prompts: {
          order: cleanedOrder,
          ...(cleanedDisabled.length > 0 ? { disabled: cleanedDisabled } : {}),
        },
      };
      validated = validateHatoConfigObject(nextConfig, this.deps.hatoConfigPath);
      return validated;
    }, { backup: true });
    return { path: res.path, backupPath: res.backupPath, config: validated, reload: res.reload };
  }

  private async handleSavePromptOrder(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = (await readJsonBody(req)) as { order?: unknown; disabled?: unknown };
    if (!Array.isArray(payload.order) || !payload.order.every((item) => typeof item === "string" && item.trim().length > 0)) {
      sendJson(res, 400, { ok: false, error: "order 必须是非空字符串数组" });
      return;
    }
    if (
      payload.disabled !== undefined &&
      (!Array.isArray(payload.disabled) ||
        !payload.disabled.every((item) => typeof item === "string" && item.trim().length > 0))
    ) {
      sendJson(res, 400, { ok: false, error: "disabled 必须是非空字符串数组" });
      return;
    }

    const cur = this.deps.getConfig();
    const nextOrder = (payload.order as string[]).map((s) => s.trim());
    const nextDisabled =
      payload.disabled !== undefined
        ? (payload.disabled as string[]).map((s) => s.trim())
        : resolvePromptDisabled(cur);

    const writeRes = await this.persistPromptsSectionAndReload({ order: nextOrder, disabled: nextDisabled });
    const reloadRes = writeRes.reload;
    const nextHato = this.deps.getConfig();
    const nextSnapshot = this.buildPromptLayersSnapshot(nextHato);
    sendJson(res, 200, {
      ok: true,
      path: writeRes.path,
      backupPath: writeRes.backupPath,
      hatoConfig: nextHato,
      promptPath: nextSnapshot.layered.soulPath,
      promptText: nextSnapshot.layered.soulText,
      promptLayers: nextSnapshot.promptLayers,
      ...reloadRes,
    });
  }

  private async handleUpsertPromptBlock(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = (await readJsonBody(req)) as {
      name?: unknown;
      content?: unknown;
      enabled?: unknown;
    };
    if (typeof payload.name !== "string" || !payload.name.trim()) {
      sendJson(res, 400, { ok: false, error: "提示词名称不能为空" });
      return;
    }
    if (typeof payload.content !== "string") {
      sendJson(res, 400, { ok: false, error: "content 必须为字符串" });
      return;
    }

    const hato = this.deps.getConfig();
    const blockRes = upsertPromptBlock(hato.paths.prompts_dir, payload.name, payload.content);
    const token = `block:${blockRes.name}`;
    const bare = blockRes.name.endsWith(".md") ? blockRes.name.slice(0, -3) : blockRes.name;

    const currentOrder = resolvePromptOrder(hato);
    let nextOrder = [...currentOrder];
    const hasWildcard = nextOrder.includes("blocks");
    const hasExplicit = nextOrder.some((t) => t === token || t === `block:${bare}`);
    if (!hasWildcard && !hasExplicit) {
      nextOrder.push(token);
    }

    let nextDisabled = [...resolvePromptDisabled(hato)];
    if (typeof payload.enabled === "boolean") {
      nextDisabled = nextDisabled.filter(
        (t) => t !== token && t !== `block:${bare}` && t !== blockRes.name && t !== bare,
      );
      if (!payload.enabled) {
        nextDisabled.push(token);
      }
    }

    let reloadRes: WebConsoleReloadResult;
    if (
      nextOrder.length !== currentOrder.length ||
      typeof payload.enabled === "boolean"
    ) {
      reloadRes = (await this.persistPromptsSectionAndReload({ order: nextOrder, disabled: nextDisabled })).reload;
    } else {
      reloadRes = await this.configMutation.reloadRuntime();
    }
    const nextHato = this.deps.getConfig();
    const nextSnapshot = this.buildPromptLayersSnapshot(nextHato);
    sendJson(res, 200, {
      ok: true,
      block: blockRes,
      hatoConfig: nextHato,
      promptPath: nextSnapshot.layered.soulPath,
      promptText: nextSnapshot.layered.soulText,
      promptLayers: nextSnapshot.promptLayers,
      ...reloadRes,
    });
  }

  private async handleDeletePromptBlock(
    parsedUrl: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let rawName = parsedUrl.searchParams.get("name") ?? "";
    if (!rawName.trim()) {
      try {
        const body = (await readJsonBody(req)) as { name?: unknown };
        if (typeof body.name === "string") rawName = body.name;
      } catch {
        // Optional body when DELETE uses query param
      }
    }
    if (!rawName.trim()) {
      sendJson(res, 400, { ok: false, error: "缺少要删除的提示词名称 name" });
      return;
    }

    const hato = this.deps.getConfig();
    const filename = normalizePromptBlockFilename(rawName);
    const bare = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
    const token = `block:${filename}`;
    const delRes = deletePromptBlock(hato.paths.prompts_dir, filename);
    if (!delRes.deleted) {
      sendJson(res, 404, { ok: false, error: `提示词块 blocks/${filename} 不存在` });
      return;
    }

    const currentOrder = resolvePromptOrder(hato);
    const currentDisabled = resolvePromptDisabled(hato);
    const isMatch = (t: string) =>
      t === token || t === `block:${bare}` || t === filename || t === bare;
    const nextOrder = currentOrder.filter((t) => !isMatch(t));
    const nextDisabled = currentDisabled.filter((t) => !isMatch(t));
    let reloadRes: WebConsoleReloadResult;
    if (
      nextOrder.length !== currentOrder.length ||
      nextDisabled.length !== currentDisabled.length
    ) {
      reloadRes = (
        await this.persistPromptsSectionAndReload({
          order: nextOrder.length > 0 ? nextOrder : ["blocks", "system", "soul"],
          disabled: nextDisabled,
        })
      ).reload;
    } else {
      reloadRes = await this.configMutation.reloadRuntime();
    }
    const nextHato = this.deps.getConfig();
    const nextSnapshot = this.buildPromptLayersSnapshot(nextHato);
    sendJson(res, 200, {
      ok: true,
      ...delRes,
      hatoConfig: nextHato,
      promptPath: nextSnapshot.layered.soulPath,
      promptText: nextSnapshot.layered.soulText,
      promptLayers: nextSnapshot.promptLayers,
      ...reloadRes,
    });
  }

  private async handleSaveSecrets(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = (await readJsonBody(req)) as { updates?: Record<string, unknown> };
    const updatesInput = payload.updates ?? {};
    const updates: Record<string, string | null | undefined> = {};

    for (const [key, val] of Object.entries(updatesInput)) {
      const cleanKey = key.trim();
      if (!cleanKey) continue;
      if (isForbiddenSecretEnvName(cleanKey)) {
        throw new HttpStatusError(400, `Forbidden secret environment variable name "${cleanKey}"`);
      }
      if (val === null || (typeof val === "string" && val.trim() === "")) {
        updates[cleanKey] = null;
      } else if (typeof val === "string") {
        updates[cleanKey] = val.trim();
      }
    }

    const merged = mergeEnvFile(this.envPath, updates);
    const reloadRes = await this.configMutation.reloadSecretsAndRuntime(merged.deletedKeys);

    const envMap = readEnvMap(this.envPath);
    const knownKeys = this.collectKnownSecretEnvNames(this.deps.getConfig(), this.deps.getModelRegistry());
    const secretStates = knownKeys.map((key) => {
      const val = envMap[key]?.trim() || process.env[key]?.trim() || "";
      return {
        key,
        configured: val.length > 0,
        masked: val ? maskSecretPreview(val) : "",
      };
    });

    sendJson(res, 200, {
      ok: true,
      writtenKeys: merged.writtenKeys,
      deletedKeys: merged.deletedKeys,
      secretStates,
      ...reloadRes,
    });
  }

  private async handleProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as { target?: unknown };
    const target = typeof body.target === "string" ? body.target : "all";
    const hato = this.deps.getConfig();
    const proxyRouter = this.deps.getProxyRouter();
    const modelRegistry = this.deps.getModelRegistry();
    const envMap = readEnvMap(this.envPath);

    const results: Record<string, unknown> = {};

    if (target === "all" || target === "telegram") {
      if (!hato.gateway.telegram.enabled) {
        results.telegram = {
          ok: false,
          skipped: true,
          latencyMs: 0,
          message: "Telegram 网关未启用",
        };
      } else {
        const botToken =
          envMap[hato.gateway.telegram.bot_token_env]?.trim() ||
          process.env[hato.gateway.telegram.bot_token_env]?.trim() ||
          "";
        const tgRes = await probeTelegramGateway({
          baseUrl: hato.gateway.telegram.base_url,
          botToken,
          proxyRouter,
        });
        results.telegram = {
          ...tgRes,
          message: tgRes.ok
            ? `Telegram Bot${tgRes.username ? ` @${tgRes.username}` : ""} 连接正常`
            : tgRes.error ?? "Telegram 连接失败",
        };
      }
    }

    if (target === "all" || target === "qq") {
      if (!hato.gateway.qq.enabled) {
        results.qq = {
          ok: false,
          skipped: true,
          latencyMs: 0,
          message: "QQ 网关未启用",
        };
      } else {
        const clientSecret =
          envMap[hato.gateway.qq.client_secret_env]?.trim() ||
          process.env[hato.gateway.qq.client_secret_env]?.trim() ||
          "";
        const qqRes = await probeQqGateway({
          baseUrl: hato.gateway.qq.base_url,
          appId: hato.gateway.qq.app_id,
          clientSecret,
          proxyRouter,
        });
        results.qq = {
          ...qqRes,
          message: qqRes.ok
            ? "QQ App Access Token 与官方网关可达"
            : qqRes.error ?? "QQ 网关连接失败",
        };
      }
    }

    if (target === "persona") {
      results.persona = await probeModelSlot({
        slot: "persona",
        modelRegistry,
        proxyRouter,
        envOverrides: envMap,
      });
    }

    if (target === "all" || target === "tavily") {
      const searchCfg = resolveTavilySearchConfig(hato);
      const apiKey =
        envMap[searchCfg.apiKeyEnv]?.trim() || process.env[searchCfg.apiKeyEnv]?.trim() || "";
      const tavilyRes = await probeTavilySearch({
        config: searchCfg,
        proxyRouter,
        apiKey,
      });
      results.tavily = {
        ...tavilyRes,
        message: tavilyRes.ok
          ? `Tavily 搜索正常（返回 ${tavilyRes.resultCount ?? 0} 条）`
          : tavilyRes.error ?? "Tavily 连接失败",
      };
    }

    if (target === "all" || target === "memory") {
      const provider = resolveMemoryProvider(hato);
      const memoryEcho = resolveMemoryEchoConfig(hato);
      const hindsightCfg = resolveHindsightConfig(hato);
      const activeEnvName = provider === "hindsight" ? hindsightCfg.apiKeyEnv : memoryEcho.apiKeyEnv;
      const apiKey =
        (activeEnvName ? envMap[activeEnvName]?.trim() || process.env[activeEnvName]?.trim() : "") ||
        "";
      const memRes = await probeMemoryService({
        provider,
        memoryEcho,
        hindsight: hato.memory.hindsight,
        proxyRouter,
        apiKey,
      });
      results.memory = {
        ...memRes,
        message: memRes.ok
          ? memRes.provider === "hindsight"
            ? `Hindsight 服务连接正常 (${memRes.baseUrl})`
            : `MemoryEcho 连接正常${typeof memRes.vaultCount === "number" ? `（${memRes.vaultCount} 个 Vault）` : ""}`
          : memRes.error ?? "记忆服务连接失败",
      };
    }

    if (target === "all" || target === "models_dev") {
      const mdRes = await this.modelsDevRegistry.probe();
      results.models_dev = {
        ok: mdRes.ok,
        latencyMs: mdRes.latencyMs,
        ...(mdRes.ok ? { modelCount: mdRes.modelCount, providerCount: mdRes.providerCount } : {}),
        message: mdRes.ok
          ? `models.dev 可达（${mdRes.modelCount} 个模型 / ${mdRes.providerCount} 个供应商）`
          : mdRes.error ?? "models.dev 连接失败",
      };
    }

    sendJson(res, 200, { ok: true, results });
  }

  private async handleTelegramUsersLookup(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      userIds?: unknown;
      refresh?: unknown;
    };
    const hato = this.deps.getConfig();
    const refresh = body.refresh === true;
    const rawIds = Array.isArray(body.userIds)
      ? body.userIds.filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      : hato.owner.channels.tg.user_ids;

    const cleanIds: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawIds) {
      const id = String(raw).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      cleanIds.push(id);
      if (cleanIds.length >= 25) break;
    }

    const baseUrl = hato.gateway.telegram.base_url.replace(/\/+$/, "");
    const envMap = readEnvMap(this.envPath);
    const botToken =
      envMap[hato.gateway.telegram.bot_token_env]?.trim() ||
      process.env[hato.gateway.telegram.bot_token_env]?.trim() ||
      "";

    const now = Date.now();
    const resultsById = new Map<string, TelegramUserProfileResult>();
    const missingIds: string[] = [];

    for (const id of cleanIds) {
      const cacheKey = `${baseUrl}::${id}`;
      const cached = !refresh ? this.tgProfileCache.get(cacheKey) : undefined;
      if (cached && cached.expiresAt > now) {
        resultsById.set(id, cached.profile);
      } else {
        missingIds.push(id);
      }
    }

    if (missingIds.length > 0) {
      const fetched = await fetchTelegramUserProfiles({
        baseUrl,
        botToken,
        userIds: missingIds,
        proxyRouter: this.deps.getProxyRouter(),
      });
      const ttlMs = 5 * 60_000;
      pruneCache(this.tgProfileCache);
      for (const profile of fetched) {
        resultsById.set(profile.id, profile);
        if (profile.ok) {
          this.tgProfileCache.set(`${baseUrl}::${profile.id}`, {
            expiresAt: Date.now() + ttlMs,
            profile,
          });
        }
      }
    }

    const profiles = cleanIds
      .map((id) => resultsById.get(id))
      .filter((p): p is TelegramUserProfileResult => Boolean(p));
    sendJson(res, 200, { ok: true, profiles });
  }

  private checkApiKeyEnvOriginAllowed(
    api: string,
    apiKeyEnv: string,
    apiKeyOverride: string | undefined,
    targetBaseUrl: string,
  ): { ok: true } | { ok: false; status: number; error: string } {
    if (api === "hato-faux-api" || apiKeyOverride || !apiKeyEnv) {
      return { ok: true };
    }
    const registry = this.deps.getModelRegistry();
    const providers = registry.listProviders();
    const fileConfig = registry.getFileConfig();
    const matchingProviders = providers.filter((p) => p.apiKeyEnv === apiKeyEnv);
    let targetOrigin: string;
    try {
      targetOrigin = new URL(targetBaseUrl).origin;
    } catch {
      return { ok: false, status: 400, error: "无效的 Base URL" };
    }
    for (const p of matchingProviders) {
      const provCfg = fileConfig.providers[p.slug];
      const candidateUrls = [
        p.baseUrl,
        ...(provCfg?.models.map((m) => m.base_url).filter((u): u is string => Boolean(u)) ?? []),
      ];
      for (const candidate of candidateUrls) {
        try {
          if (new URL(candidate).origin === targetOrigin) {
            return { ok: true };
          }
        } catch {
          // ignore invalid stored URL
        }
      }
    }
    return {
      ok: false,
      status: 403,
      error:
        "出于安全限制，未显式传入 API Key 时仅允许将已配置供应商的密钥变量发往其已保存的 Base URL 源站。",
    };
  }

  private toStringMap(raw: unknown): Record<string, string> | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entries = Object.entries(raw as Record<string, unknown>)
      .filter(([k, v]) => k.trim().length > 0 && v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)] as const);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  private async handleFetchUpstreamModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as {
      providerSlug?: unknown;
      api?: unknown;
      baseUrl?: unknown;
      apiKeyEnv?: unknown;
      apiKeyOverride?: unknown;
      providerHeaders?: unknown;
    };

    const providerSlug = typeof body.providerSlug === "string" ? body.providerSlug.trim() : "";
    const api = typeof body.api === "string" ? body.api.trim() : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const apiKeyEnv = typeof body.apiKeyEnv === "string" ? body.apiKeyEnv.trim() : "";
    const apiKeyOverride = typeof body.apiKeyOverride === "string" ? body.apiKeyOverride.trim() : undefined;

    if (!providerSlug || !api || !baseUrl) {
      sendJson(res, 400, { ok: false, error: "拉取上游模型需要提供供应商名称、协议与 Base URL" });
      return;
    }

    const originCheck = this.checkApiKeyEnvOriginAllowed(api, apiKeyEnv, apiKeyOverride, baseUrl);
    if (!originCheck.ok) {
      sendJson(res, originCheck.status, { ok: false, error: originCheck.error });
      return;
    }

    const envOverrides = readEnvMap(this.envPath);
    const effectiveApiKey =
      apiKeyOverride ||
      (apiKeyEnv ? envOverrides[apiKeyEnv] || process.env[apiKeyEnv] : undefined);

    try {
      const result = await fetchUpstreamModels({
        providerSlug,
        api,
        baseUrl,
        apiKey: effectiveApiKey,
        providerHeaders: this.toStringMap(body.providerHeaders),
        proxyRouter: this.deps.getProxyRouter(),
      });
      const enriched = result.models.map((item) => {
        const matched = this.modelsDevRegistry.matchModelFromCache(item.id, {
          providerSlug,
          api,
        });
        return matched ? { ...item, modelsDev: matched } : item;
      });
      sendJson(res, 200, {
        ok: true,
        models: enriched,
        fetchedFrom: result.fetchedFrom,
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      sendJson(res, 502, { ok: false, error: summarizeError(err) });
    }
  }

  private async handleTestModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as {
      providerSlug?: unknown;
      api?: unknown;
      baseUrl?: unknown;
      apiKeyEnv?: unknown;
      apiKeyOverride?: unknown;
      providerHeaders?: unknown;
      providerCompat?: unknown;
      model?: {
        id?: unknown;
        name?: unknown;
        api?: unknown;
        base_url?: unknown;
        headers?: unknown;
        reasoning?: unknown;
        input?: unknown;
        context_window?: unknown;
        max_tokens?: unknown;
        compat?: unknown;
      };
    };

    const providerSlug = typeof body.providerSlug === "string" ? body.providerSlug.trim() : "";
    const api = typeof body.api === "string" ? body.api.trim() : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const apiKeyEnv = typeof body.apiKeyEnv === "string" ? body.apiKeyEnv.trim() : "";
    const apiKeyOverride = typeof body.apiKeyOverride === "string" ? body.apiKeyOverride.trim() : undefined;
    const modelId = typeof body.model?.id === "string" ? body.model.id.trim() : "";

    if (!providerSlug || !modelId || !api || !baseUrl) {
      sendJson(res, 400, { ok: false, error: "测试模型需要提供供应商名称、协议、Base URL 与模型 ID" });
      return;
    }

    // Guard against exfiltrating arbitrary env secrets to attacker-controlled baseUrls.
    const effectiveTestBaseUrl =
      (typeof body.model?.base_url === "string" && body.model.base_url.trim()) || baseUrl;
    const originCheck = this.checkApiKeyEnvOriginAllowed(
      api,
      apiKeyEnv,
      apiKeyOverride,
      effectiveTestBaseUrl,
    );
    if (!originCheck.ok) {
      sendJson(res, originCheck.status, { ok: false, error: originCheck.error });
      return;
    }

    const toPlainRecord = (val: unknown): Record<string, unknown> | undefined =>
      val && typeof val === "object" && !Array.isArray(val)
        ? (val as Record<string, unknown>)
        : undefined;

    const result = await probeAdHocModel({
      providerSlug,
      api,
      baseUrl,
      apiKeyEnv,
      apiKeyOverride,
      providerHeaders: this.toStringMap(body.providerHeaders),
      providerCompat: toPlainRecord(body.providerCompat),
      model: {
        id: modelId,
        name: typeof body.model?.name === "string" ? body.model.name.trim() : undefined,
        api: typeof body.model?.api === "string" ? body.model.api.trim() : undefined,
        base_url: typeof body.model?.base_url === "string" ? body.model.base_url.trim() : undefined,
        headers: this.toStringMap(body.model?.headers),
        reasoning: typeof body.model?.reasoning === "boolean" ? body.model.reasoning : undefined,
        input: Array.isArray(body.model?.input)
          ? (body.model.input.filter((x) => x === "text" || x === "image") as Array<"text" | "image">)
          : undefined,
        context_window:
          typeof body.model?.context_window === "number" ? body.model.context_window : undefined,
        max_tokens: typeof body.model?.max_tokens === "number" ? body.model.max_tokens : undefined,
        compat: toPlainRecord(body.model?.compat),
      },
      modelRegistry: this.deps.getModelRegistry(),
      proxyRouter: this.deps.getProxyRouter(),
      envOverrides: readEnvMap(this.envPath),
    });

    if (!result.ok) {
      logWarn(
        "LLM",
        `[TEST] ${result.target} (${result.api}) failed in ${result.latencyMs}ms: ${result.error ?? "unknown error"}`,
      );
    }

    sendJson(res, 200, { ok: true, result });
  }

  private async handleWorkerCliProbe(res: ServerResponse): Promise<void> {
    const config = this.deps.getConfig();
    const probeFn = this.deps.probeExternalClis ?? probeAllExternalClis;
    const probes = await probeFn(config);
    const resolved = resolveWorkerExternalCliConfig(config);
    sendJson(res, 200, {
      ok: true,
      hatoOnlyScope: true,
      permissionPreset: resolved.permissionPreset,
      probes,
    });
  }

  private async handleWorkerCliModels(url: URL, res: ServerResponse): Promise<void> {
    const rawBackend = url.searchParams.get("backend")?.trim() ?? "";
    if (!EXTERNAL_CLI_BACKENDS.includes(rawBackend as ExternalCliBackend)) {
      sendJson(res, 400, { ok: false, error: `不支持的后端: ${rawBackend || "(空)"}` });
      return;
    }
    const backend = rawBackend as ExternalCliBackend;
    const models = await probeExternalCliModels(backend, this.deps.getConfig());
    sendJson(res, 200, { ok: true, backend, models });
  }

  private handleListTickets(res: ServerResponse): void {
    const repo = this.deps.getRepo();
    const uid = this.deps.getConfig().owner.canonical_user_id;
    const tickets = repo.listTickets(uid, 20).map((t) => {
      const mandate = parseWorkerMandate(t.mandateJson);
      return {
        id: t.id,
        status: t.status,
        backend: t.backend,
        briefTitle: t.briefTitle,
        originChannel: t.originChannel,
        progressNote: t.progressNote,
        ...(mandate?.workspace_dir ? { workspaceDir: mandate.workspace_dir } : {}),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    });
    sendJson(res, 200, { ok: true, tickets });
  }

  private handleTicketActivityStream(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const ticketId = url.searchParams.get("ticketId")?.trim() ?? "";
    if (!ticketId) {
      sendJson(res, 400, { ok: false, error: "ticketId 不能为空" });
      return;
    }

    const repo = this.deps.getRepo();
    const cfg = this.deps.getConfig();
    const uid = cfg.owner.canonical_user_id;
    const row = repo.getTicket(ticketId);
    if (!row || row.canonicalUserId !== uid) {
      sendJson(res, 404, { ok: false, error: `未找到工单 ${ticketId}` });
      return;
    }

    const mandate = parseWorkerMandate(row.mandateJson);
    const activityPersistDir = join(
      resolve(dirname(cfg.paths.workspaces_dir), "worker-cli"),
      "activity",
    );

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const writeEvent = (payload: Record<string, unknown>) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    writeEvent({
      type: "snapshot",
      ticket: {
        id: row.id,
        status: row.status,
        backend: row.backend,
        briefTitle: row.briefTitle,
        originChannel: row.originChannel,
        progressNote: row.progressNote,
        ...(mandate?.workspace_dir ? { workspaceDir: mandate.workspace_dir } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      items: workerActivityHub.getItems(ticketId, activityPersistDir),
    });

    const unsub = workerActivityHub.subscribe((ev) => {
      if (ev.ticketId !== ticketId) return;
      if (ev.type === "item") {
        writeEvent({ type: "item", item: ev.item });
      } else if (ev.type === "ticket") {
        writeEvent({ type: "ticket", ticket: ev.ticket });
      }
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": ping\n\n");
      }
    }, 15_000);
    keepAlive.unref();

    const cleanup = () => {
      clearInterval(keepAlive);
      unsub();
      if (!res.writableEnded) res.end();
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
  }

  private async handleTicketConfirm(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const coordinator = this.deps.getTicketCoordinator?.();
    if (!coordinator) {
      sendJson(res, 503, { ok: false, error: "当前实例未启用后台工单协调器" });
      return;
    }
    const body = (await readJsonBody(req)) as { ticketId?: unknown; approved?: unknown };
    const ticketId = typeof body.ticketId === "string" ? body.ticketId.trim() : "";
    if (!ticketId) {
      sendJson(res, 400, { ok: false, error: "ticketId 不能为空" });
      return;
    }
    const row = this.deps.getRepo().getTicket(ticketId);
    const uid = this.deps.getConfig().owner.canonical_user_id;
    if (!row || row.canonicalUserId !== uid) {
      sendJson(res, 404, { ok: false, error: `未找到工单 ${ticketId}` });
      return;
    }
    const message = this.deps.onConfirmAction
      ? await this.deps.onConfirmAction(ticketId, Boolean(body.approved))
      : await coordinator.handleConfirmAction(ticketId, Boolean(body.approved));
    sendJson(res, 200, { ok: true, message });
  }

  private async handleTicketAbort(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const coordinator = this.deps.getTicketCoordinator?.();
    if (!coordinator) {
      sendJson(res, 503, { ok: false, error: "当前实例未启用后台工单协调器" });
      return;
    }
    const body = (await readJsonBody(req)) as { ticketId?: unknown };
    const ticketId = typeof body.ticketId === "string" ? body.ticketId.trim() : "";
    if (!ticketId) {
      sendJson(res, 400, { ok: false, error: "ticketId 不能为空" });
      return;
    }
    const row = this.deps.getRepo().getTicket(ticketId);
    const uid = this.deps.getConfig().owner.canonical_user_id;
    if (!row || row.canonicalUserId !== uid) {
      sendJson(res, 404, { ok: false, error: `未找到工单 ${ticketId}` });
      return;
    }
    const message = await coordinator.abortTicket(ticketId);
    sendJson(res, 200, { ok: true, message });
  }

  private buildCostResolver(): (provider: string, modelId: string) => ModelCostRates | undefined {
    const providers = this.deps.getModelRegistry().getFileConfig().providers;
    const byTarget = new Map<string, ModelCostRates>();
    const byModelId = new Map<string, ModelCostRates>();
    for (const [slug, prov] of Object.entries(providers)) {
      for (const m of prov.models) {
        if (!m.cost) continue;
        byTarget.set(`${slug}/${m.id}`, m.cost);
        if (!byModelId.has(m.id)) {
          byModelId.set(m.id, m.cost);
        }
      }
    }
    return (provider: string, modelId: string) =>
      byTarget.get(`${provider}/${modelId}`) ?? byModelId.get(modelId);
  }

  private handleStatics(url: URL, res: ServerResponse): void {
    const repo = this.deps.getRepo();
    const uid = this.deps.getConfig().owner.canonical_user_id;
    const limitParam = Number(url.searchParams.get("limit") ?? "30");
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(200, limitParam) : 30;
    const slot = url.searchParams.get("slot")?.trim() || undefined;
    const sessionId = url.searchParams.get("sessionId")?.trim() || "";
    const sinceRaw = url.searchParams.get("since")?.trim();
    const scope = url.searchParams.get("scope")?.trim();
    const resolveCostRates = this.buildCostResolver();

    const attachCost = <T extends Parameters<typeof computeTurnCostUsd>[0] & { provider: string; modelId: string }>(
      rows: readonly T[],
    ) =>
      rows.map((row) => {
        const rates = resolveCostRates(row.provider, row.modelId);
        return {
          ...row,
          costUsd: rates ? Number(computeTurnCostUsd(row, rates).costUsd.toFixed(6)) : null,
        };
      });

    if (sessionId) {
      const session = repo.getChatSession(sessionId);
      if (!session || session.canonicalUserId !== uid) {
        sendJson(res, 404, { ok: false, error: `未找到历史会话 ${sessionId}` });
        return;
      }
      const traces = repo.listTurnTraces({
        canonicalUserId: uid,
        limit,
        slot,
        sinceMs: session.startedAt,
        untilMs: session.endedAt,
      });
      const summary = summarizeTurnTraces(traces, resolveCostRates);
      sendJson(res, 200, { ok: true, session, summary, traces: attachCost(traces) });
      return;
    }

    const sinceMs = sinceRaw ? parseSinceSpec(sinceRaw) : undefined;
    const afterMs = scope === "history" ? undefined : repo.getSessionResetAt(uid) ?? undefined;

    const traces = repo.listTurnTraces({ canonicalUserId: uid, limit, slot, sinceMs, afterMs });
    const summary = summarizeTurnTraces(traces, resolveCostRates);
    sendJson(res, 200, { ok: true, summary, traces: attachCost(traces) });
  }

  private handleTracesStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const uid = this.deps.getConfig().owner.canonical_user_id;
    const tracker = this.deps.getLiveTraceTracker?.();
    const repo = this.deps.getRepo();

    const writeEvent = (payload: Record<string, unknown>) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    writeEvent({
      type: "snapshot",
      active: tracker?.listActive(uid) ?? [],
    });

    const unsubTracker = tracker?.subscribe((event) => {
      if (event.type === "active_update") {
        writeEvent({
          type: "active_update",
          active: event.active.filter((item) => item.canonicalUserId === uid),
        });
      }
    });

    const unsubRepo = repo.subscribeTurnTrace((info) => {
      if (info.canonicalUserId !== uid) return;
      writeEvent({
        type: "trace_inserted",
        traceId: info.id,
        slot: info.slot,
        createdAt: info.createdAt,
      });
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": ping\n\n");
      }
    }, 15_000);
    keepAlive.unref();

    const cleanup = () => {
      clearInterval(keepAlive);
      unsubTracker?.();
      unsubRepo();
      if (!res.writableEnded) res.end();
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
  }

  private handleLogsStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const writeEvent = (payload: Record<string, unknown>) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    writeEvent({
      type: "snapshot",
      logs: getRuntimeLogs({ limit: 300 }),
    });

    const unsubLogs = subscribeRuntimeLogs((entry) => {
      writeEvent({ type: "log", entry });
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": ping\n\n");
      }
    }, 15_000);
    keepAlive.unref();

    const cleanup = () => {
      clearInterval(keepAlive);
      unsubLogs();
      if (!res.writableEnded) res.end();
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
  }

  private collectKnownSecretEnvNames(hato: HatoConfig, registry: ModelRegistry): string[] {
    const envMap = readEnvMap(this.envPath);
    const consoleCfg = resolveWebConsoleConfig(hato);
    const hindsightApiKeyEnv = resolveHindsightConfig(hato).apiKeyEnv;
    const keys = new Set<string>([
      hato.gateway.telegram.bot_token_env,
      hato.gateway.qq.client_secret_env,
      resolveTavilySearchConfig(hato).apiKeyEnv,
      resolveMemoryEchoConfig(hato).apiKeyEnv,
      ...(hindsightApiKeyEnv ? [hindsightApiKeyEnv] : []),
      ...registry.listProviders().map((p) => p.apiKeyEnv),
      ...(consoleCfg.authTokenEnv ? [consoleCfg.authTokenEnv] : []),
      ...Object.keys(envMap),
    ]);
    return [...keys].filter((k) => k.trim().length > 0).sort();
  }
}
