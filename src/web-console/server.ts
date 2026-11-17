import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { BrowserRuntime } from "../browser/runtime.js";
import type { ActorLock } from "../bus/actor-bus.js";
import { tryHandleSlashCommand, type SlashCommandDeps } from "../commands/slash.js";
import {
  loadHatoConfig,
  resolveMemoryEchoConfig,
  resolvePromptDisabled,
  resolvePromptOrder,
  resolveTavilySearchConfig,
  resolveWebConsoleConfig,
  validateHatoConfigObject,
  type HatoConfig,
} from "../config/app.js";
import type { ModelRegistry } from "../config/models.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { getOptionalSecret, reloadSecretEnv } from "../config/secrets.js";
import { mergeEnvFile, readEnvMap, writeHatoConfig, writeModelsConfig } from "../config/store.js";
import type { HatoRepository } from "../db/repo.js";
import { formatGatewayMessageLog } from "../gateway/msg-log.js";
import type { CompactionManager } from "../memory/compaction.js";
import type { MemoryCurator } from "../memory/curator.js";
import type { PersonaRuntime } from "../persona/agent.js";
import { splitIntoBubbles } from "../persona/bubbles.js";
import {
  deletePromptBlock,
  loadLayeredPrompts,
  normalizePromptBlockFilename,
  upsertPromptBlock,
} from "../persona/prompts.js";
import {
  probeAdHocModel,
  probeModelSlot,
  probeTavilySearch,
  probeTelegramGateway,
} from "../setup/probe.js";
import { parseSinceSpec, summarizeTurnTraces } from "../stats/metrics.js";
import { logInfo, summarizeError } from "../utils/logger.js";

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
  getRepo: () => HatoRepository;
  getPersonaRuntime: () => PersonaRuntime;
  getBrowserRuntime: () => BrowserRuntime;
  getCompactionManager: () => CompactionManager;
  getMemoryCurator?: () => MemoryCurator;
  getActorLock: () => ActorLock;
  getSlashDeps: (canonicalUserId: string) => SlashCommandDeps;
  reloadAll: () => Promise<WebConsoleReloadResult>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;

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

  constructor(private readonly deps: WebConsoleServerDeps) {
    this.envPath = deps.envPath ?? ".env";
    this.staticDir = resolve(deps.staticDir ?? "web/dist");
  }

  getAddress(): { host: string; port: number } | null {
    if (!this.server || this.boundPort === null) return null;
    const cfg = resolveWebConsoleConfig(this.deps.getConfig());
    return { host: cfg.host, port: this.boundPort };
  }

  async start(): Promise<{ host: string; port: number } | null> {
    const cfg = resolveWebConsoleConfig(this.deps.getConfig());
    if (!cfg.enabled) return null;
    if (this.server) return this.getAddress();

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
      if (pathname === "/api/health" && method === "GET") {
        const hato = this.deps.getConfig();
        const consoleCfg = resolveWebConsoleConfig(hato);
        const authSecret = getOptionalSecret(consoleCfg.authTokenEnv);
        sendJson(res, 200, {
          ok: true,
          uptimeSec: Math.round((Date.now() - this.startedAtMs) / 1000),
          telegramEnabled: hato.gateway.telegram.enabled,
          pendingTakeover: this.deps.getBrowserRuntime().isPendingTakeover(),
          authRequired: Boolean(authSecret),
          console: {
            host: consoleCfg.host,
            port: this.boundPort ?? consoleCfg.port,
          },
        });
        return;
      }

      if (pathname.startsWith("/api/")) {
        if (!this.isAuthorized(req)) {
          sendJson(res, 401, { ok: false, error: "Unauthorized: invalid or missing console token" });
          return;
        }

        if (pathname === "/api/sessions" && method === "GET") {
          this.handleListSessions(res);
          return;
        }
        if (pathname === "/api/chat/history" && method === "GET") {
          await this.handleChatHistory(parsedUrl, res);
          return;
        }
        if (pathname === "/api/chat/send" && method === "POST") {
          await this.handleChatSend(req, res);
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
        if (pathname === "/api/config/models/test" && method === "POST") {
          await this.handleTestModel(req, res);
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
          const reloadRes = await this.deps.reloadAll();
          sendJson(res, 200, { ok: true, ...reloadRes });
          return;
        }
        if (pathname === "/api/config/probe" && method === "POST") {
          await this.handleProbe(req, res);
          return;
        }
        if (pathname === "/api/statics" && method === "GET") {
          this.handleStatics(parsedUrl, res);
          return;
        }
        if (pathname === "/api/browser/status" && method === "GET") {
          const status = await this.deps.getBrowserRuntime().getInteractiveStatus();
          sendJson(res, 200, { ok: true, status });
          return;
        }
        if (pathname === "/api/browser/stream" && method === "GET") {
          this.handleBrowserStream(req, res);
          return;
        }
        if (pathname === "/api/browser/screenshot" && method === "GET") {
          const buf = await this.deps.getBrowserRuntime().captureScreenshot();
          if (!buf) {
            sendJson(res, 404, { ok: false, error: "浏览器尚未打开" });
            return;
          }
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": buf.byteLength,
            "Cache-Control": "no-store",
          });
          res.end(buf);
          return;
        }
        if (pathname === "/api/browser/action" && method === "POST") {
          await this.handleBrowserAction(req, res);
          return;
        }
        if (pathname === "/api/browser/input" && method === "POST") {
          await this.handleBrowserInput(req, res);
          return;
        }

        sendJson(res, 404, { ok: false, error: `Unknown API route: ${method} ${pathname}` });
        return;
      }

      if (method === "GET" || method === "HEAD") {
        this.serveStaticAsset(pathname, res, method === "HEAD");
        return;
      }

      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
    } catch (err) {
      const msg = summarizeError(err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: msg });
      } else {
        res.end();
      }
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const consoleCfg = resolveWebConsoleConfig(this.deps.getConfig());
    const requiredToken = getOptionalSecret(consoleCfg.authTokenEnv);
    if (!requiredToken) return true;

    const authHeader = req.headers.authorization ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (bearer && bearer === requiredToken) return true;

    const customHeader = req.headers["x-hato-token"];
    if (typeof customHeader === "string" && customHeader.trim() === requiredToken) return true;
    return false;
  }

  private handleListSessions(res: ServerResponse): void {
    const hato = this.deps.getConfig();
    const repo = this.deps.getRepo();
    const sessions = repo.listChatSessions(hato.owner.canonical_user_id, 50);
    sendJson(res, 200, { ok: true, sessions });
  }

  private async handleChatHistory(url: URL, res: ServerResponse): Promise<void> {
    const hato = this.deps.getConfig();
    const repo = this.deps.getRepo();
    const registry = this.deps.getModelRegistry();
    const uid = hato.owner.canonical_user_id;
    const bubbleCfg = hato.gateway.bubbles;
    const sessionId = url.searchParams.get("sessionId")?.trim() || "";

    let readonly = false;
    let session = null;
    let summaryText = "";
    let compactedUntilTs = 0;
    let rawMessages;

    if (sessionId) {
      const archived = repo.getSessionMessages(uid, sessionId);
      if (!archived) {
        sendJson(res, 404, { ok: false, error: `未找到历史会话 ${sessionId}` });
        return;
      }
      readonly = true;
      session = archived.session;
      summaryText = archived.session.summaryText;
      compactedUntilTs = archived.session.endedAt;
      rawMessages = archived.messages;
    } else {
      const wm = repo.getWorkingMemory(uid);
      summaryText = wm.summaryText;
      compactedUntilTs = wm.compactedUntilTs;
      rawMessages = repo.getHotMessages(uid, wm.compactedUntilTs);
    }

    const messages = rawMessages.map((m) => ({
      ...m,
      bubbles:
        m.role === "assistant"
          ? splitIntoBubbles(m.content, {
              enabled: bubbleCfg.enabled,
              maxPerTurn: Math.max(bubbleCfg.max_per_turn * 2, 6),
              delimiter: bubbleCfg.delimiter,
            })
          : m.content
            ? [m.content]
            : [],
    }));

    sendJson(res, 200, {
      ok: true,
      canonicalUserId: uid,
      readonly,
      session,
      summaryText,
      compactedUntilTs,
      pendingTakeover: this.deps.getBrowserRuntime().isPendingTakeover(),
      messages,
      slots: registry.listSlots().map((s) => ({
        slot: s.slot,
        target: s.target,
        api: String(s.model.api),
        baseUrl: s.model.baseUrl,
      })),
      availableModels: registry.listTargets(),
    });
  }

  private async handleChatSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as {
      text?: unknown;
      images?: Array<{ data?: unknown; mimeType?: unknown }>;
    };

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const rawImages = Array.isArray(body.images) ? body.images : [];
    const loadedImages: ImageContent[] = rawImages
      .filter(
        (img): img is { data: string; mimeType: string } =>
          typeof img?.data === "string" &&
          img.data.length > 0 &&
          typeof img?.mimeType === "string" &&
          img.mimeType.startsWith("image/"),
      )
      .slice(0, 4)
      .map((img) => ({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
      }));

    if (!text && loadedImages.length === 0) {
      sendJson(res, 400, { ok: false, error: "消息内容与图片不能同时为空" });
      return;
    }

    const hato = this.deps.getConfig();
    const uid = hato.owner.canonical_user_id;
    const attachments = loadedImages.map((img, i) => ({
      kind: "image" as const,
      filename: `web-image-${i + 1}`,
      mimeType: img.mimeType,
    }));

    console.log(
      formatGatewayMessageLog({
        direction: "inbound",
        channel: "web",
        timeZone: hato.owner.timezone,
        userSlug: uid,
        text,
        attachments,
      }),
    );

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const emit = (payload: Record<string, unknown>) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    try {
      if (text.startsWith("/")) {
        const slashReply = await tryHandleSlashCommand(uid, text, this.deps.getSlashDeps(uid));
        if (slashReply !== null) {
          console.log(
            formatGatewayMessageLog({
              direction: "outbound",
              channel: "web",
              timeZone: hato.owner.timezone,
              userSlug: uid,
              text: slashReply,
            }),
          );
          emit({ type: "slash_reply", text: slashReply });
          emit({ type: "done", pendingTakeover: this.deps.getBrowserRuntime().isPendingTakeover() });
          res.end();
          return;
        }
      }

      const now = Date.now();
      const msgId = `web_${now}`;
      const batch = {
        canonicalUserId: uid,
        originChannel: "web" as const,
        originPlatformUserId: uid,
        platformMsgIds: [msgId],
        latestPlatformMsgId: msgId,
        combinedText: text,
        attachments,
        images: loadedImages.length > 0 ? loadedImages : undefined,
        firstTimestampMs: now,
        lastTimestampMs: now,
      };

      const compactionManager = this.deps.getCompactionManager();
      const personaRuntime = this.deps.getPersonaRuntime();
      const actorLock = this.deps.getActorLock();

      await actorLock.run(uid, async () => {
        const output = await personaRuntime.handleUserBatch(batch, loadedImages, {
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
                  timeZone: this.deps.getConfig().owner.timezone,
                  userSlug: uid,
                  text: bubble,
                }),
              );
            }
            emit({ type: "early_bubbles", bubbles: earlyBubbles });
          },
        });

        for (const bubble of output.bubbles) {
          console.log(
            formatGatewayMessageLog({
              direction: "outbound",
              channel: "web",
              timeZone: this.deps.getConfig().owner.timezone,
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
        this.deps.getMemoryCurator?.().recordInteraction(uid);
        void compactionManager.checkHighWatermark(uid).catch(() => undefined);
      });

      emit({ type: "done", pendingTakeover: this.deps.getBrowserRuntime().isPendingTakeover() });
    } catch (err) {
      emit({ type: "error", message: summarizeError(err) });
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  private buildPromptLayersSnapshot(hatoConfig: HatoConfig) {
    const layered = loadLayeredPrompts(
      hatoConfig.paths.prompts_dir,
      resolvePromptOrder(hatoConfig),
      resolvePromptDisabled(hatoConfig),
    );
    return {
      layered,
      promptLayers: {
        mode: layered.mode,
        order: layered.order,
        disabled: layered.disabled,
        blocks: layered.blocks.map((b) => ({ name: b.name, path: b.path, content: b.content })),
        systemPath: layered.systemPath,
        systemText: layered.systemText,
        soulPath: layered.soulPath,
        soulText: layered.soulText,
        combinedText: layered.combinedText,
      },
    };
  }

  private async handleGetConfig(res: ServerResponse): Promise<void> {
    const hatoConfig = this.deps.getConfig();
    const modelsRegistry = this.deps.getModelRegistry();
    const modelsConfig = modelsRegistry.getFileConfig();
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
    const writeRes = writeHatoConfig(this.deps.hatoConfigPath, validated, { backup: true });
    const reloadRes = await this.deps.reloadAll();
    sendJson(res, 200, {
      ok: true,
      path: writeRes.path,
      backupPath: writeRes.backupPath,
      ...reloadRes,
    });
  }

  private async handleSaveModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = (await readJsonBody(req)) as { config?: unknown };
    const writeRes = writeModelsConfig(
      this.deps.modelsConfigPath,
      payload.config as ReturnType<ModelRegistry["getFileConfig"]>,
      { backup: true },
    );
    const reloadRes = await this.deps.reloadAll();
    sendJson(res, 200, {
      ok: true,
      path: writeRes.path,
      backupPath: writeRes.backupPath,
      ...reloadRes,
    });
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

  private persistPromptsSection(nextPrompts: { order: string[]; disabled: string[] }): {
    path: string;
    backupPath?: string;
    config: HatoConfig;
  } {
    const base = existsSync(resolve(this.deps.hatoConfigPath))
      ? loadHatoConfig(this.deps.hatoConfigPath)
      : this.deps.getConfig();
    const cleanedOrder = nextPrompts.order.map((s) => s.trim()).filter(Boolean);
    const cleanedDisabled = nextPrompts.disabled.map((s) => s.trim()).filter(Boolean);
    const nextConfig: HatoConfig = {
      ...base,
      prompts: {
        order: cleanedOrder,
        ...(cleanedDisabled.length > 0 ? { disabled: cleanedDisabled } : {}),
      },
    };
    const validated = validateHatoConfigObject(nextConfig, this.deps.hatoConfigPath);
    const writeRes = writeHatoConfig(this.deps.hatoConfigPath, validated, { backup: true });
    return { ...writeRes, config: validated };
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

    const writeRes = this.persistPromptsSection({ order: nextOrder, disabled: nextDisabled });
    const reloadRes = await this.deps.reloadAll();
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

    if (
      nextOrder.length !== currentOrder.length ||
      typeof payload.enabled === "boolean"
    ) {
      this.persistPromptsSection({ order: nextOrder, disabled: nextDisabled });
    }

    const reloadRes = await this.deps.reloadAll();
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
    if (
      nextOrder.length !== currentOrder.length ||
      nextDisabled.length !== currentDisabled.length
    ) {
      this.persistPromptsSection({
        order: nextOrder.length > 0 ? nextOrder : ["blocks", "system", "soul"],
        disabled: nextDisabled,
      });
    }

    const reloadRes = await this.deps.reloadAll();
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
    const updates: Record<string, string | undefined> = {};

    for (const [key, val] of Object.entries(updatesInput)) {
      if (typeof val === "string" && val.trim().length > 0) {
        updates[key.trim()] = val.trim();
      }
    }

    const merged = mergeEnvFile(this.envPath, updates);
    reloadSecretEnv(this.envPath);
    const reloadRes = await this.deps.reloadAll();

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
        results.telegram = { ok: false, skipped: true, error: "Telegram gateway disabled" };
      } else {
        const botToken =
          envMap[hato.gateway.telegram.bot_token_env]?.trim() ||
          process.env[hato.gateway.telegram.bot_token_env]?.trim() ||
          "";
        results.telegram = await probeTelegramGateway({
          baseUrl: hato.gateway.telegram.base_url,
          botToken,
          proxyRouter,
        });
      }
    }

    if (target === "all" || target === "persona") {
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
      results.tavily = await probeTavilySearch({
        config: searchCfg,
        proxyRouter,
        apiKey,
      });
    }

    sendJson(res, 200, { ok: true, results });
  }

  private async handleTestModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as {
      providerSlug?: unknown;
      api?: unknown;
      baseUrl?: unknown;
      apiKeyEnv?: unknown;
      apiKeyOverride?: unknown;
      providerHeaders?: unknown;
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

    const toStringMap = (raw: unknown): Record<string, string> | undefined => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const entries = Object.entries(raw as Record<string, unknown>)
        .filter(([k, v]) => k.trim().length > 0 && v !== undefined && v !== null)
        .map(([k, v]) => [k, String(v)] as const);
      return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    };

    const result = await probeAdHocModel({
      providerSlug,
      api,
      baseUrl,
      apiKeyEnv,
      apiKeyOverride,
      providerHeaders: toStringMap(body.providerHeaders),
      model: {
        id: modelId,
        name: typeof body.model?.name === "string" ? body.model.name.trim() : undefined,
        api: typeof body.model?.api === "string" ? body.model.api.trim() : undefined,
        base_url: typeof body.model?.base_url === "string" ? body.model.base_url.trim() : undefined,
        headers: toStringMap(body.model?.headers),
        reasoning: typeof body.model?.reasoning === "boolean" ? body.model.reasoning : undefined,
        input: Array.isArray(body.model?.input)
          ? (body.model.input.filter((x) => x === "text" || x === "image") as Array<"text" | "image">)
          : undefined,
        context_window:
          typeof body.model?.context_window === "number" ? body.model.context_window : undefined,
        max_tokens: typeof body.model?.max_tokens === "number" ? body.model.max_tokens : undefined,
      },
      modelRegistry: this.deps.getModelRegistry(),
      proxyRouter: this.deps.getProxyRouter(),
      envOverrides: readEnvMap(this.envPath),
    });

    sendJson(res, 200, { ok: true, result });
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
      const summary = summarizeTurnTraces(traces);
      sendJson(res, 200, { ok: true, session, summary, traces });
      return;
    }

    const sinceMs = sinceRaw ? parseSinceSpec(sinceRaw) : undefined;
    const afterMs = scope === "history" ? undefined : repo.getSessionResetAt(uid) ?? undefined;

    const traces = repo.listTurnTraces({ limit, slot, sinceMs, afterMs });
    const summary = summarizeTurnTraces(traces);
    sendJson(res, 200, { ok: true, summary, traces });
  }

  private handleBrowserStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const browser = this.deps.getBrowserRuntime();
    const unsubscribe = browser.subscribeStream((event) => {
      if (res.writableEnded) return;
      if (event.type === "status") {
        res.write(`data: ${JSON.stringify({ type: "status", status: { ...event.status, busy: browser.isBusy() } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
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
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
  }

  private async handleBrowserAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as {
      action?: unknown;
      url?: unknown;
      index?: unknown;
      width?: unknown;
      height?: unknown;
    };
    const action = typeof body.action === "string" ? body.action.trim() : "";
    const browser = this.deps.getBrowserRuntime();

    let status;
    switch (action) {
      case "open":
        status = await browser.openBrowser();
        if (typeof body.url === "string" && body.url.trim()) {
          status = await browser.navigateManual(body.url);
        }
        break;
      case "close":
        status = await browser.closeBrowser();
        break;
      case "navigate":
        if (typeof body.url !== "string" || !body.url.trim()) {
          sendJson(res, 400, { ok: false, error: "缺少 url 参数" });
          return;
        }
        status = await browser.navigateManual(body.url);
        break;
      case "back":
        status = await browser.goBackManual();
        break;
      case "forward":
        status = await browser.goForwardManual();
        break;
      case "reload":
        status = await browser.reloadManual();
        break;
      case "new_tab":
        status = await browser.newTabManual(typeof body.url === "string" ? body.url : undefined);
        break;
      case "switch_tab":
        status = await browser.switchTabManual(Number(body.index ?? 0));
        break;
      case "close_tab":
        status = await browser.closeTabManual(Number(body.index ?? 0));
        break;
      case "resize": {
        const w = Number(body.width);
        const h = Number(body.height);
        if (!Number.isFinite(w) || !Number.isFinite(h)) {
          sendJson(res, 400, { ok: false, error: "缺少有效 width/height 参数" });
          return;
        }
        status = await browser.resizeViewportManual(w, h);
        break;
      }
      case "takeover":
        status = await browser.beginManualControl();
        break;
      case "release_takeover":
        status = await browser.endManualControl();
        break;
      case "resume_takeover":
        status = await browser.resumeTakeover();
        break;
      default:
        sendJson(res, 400, { ok: false, error: `未知浏览器动作: ${action}` });
        return;
    }

    sendJson(res, 200, { ok: true, status });
  }

  private async handleBrowserInput(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as {
      kind?: unknown;
      action?: unknown;
      x?: unknown;
      y?: unknown;
      button?: unknown;
      deltaX?: unknown;
      deltaY?: unknown;
      key?: unknown;
      text?: unknown;
    };
    const kind = body.kind;
    const browser = this.deps.getBrowserRuntime();

    if (kind === "mouse") {
      const action = typeof body.action === "string" ? body.action : "";
      if (!["move", "down", "up", "click", "dblclick", "wheel"].includes(action)) {
        sendJson(res, 400, { ok: false, error: `无效鼠标动作: ${action}` });
        return;
      }
      const button =
        body.button === "right" || body.button === "middle" || body.button === "left"
          ? body.button
          : "left";
      await browser.dispatchMouse({
        action: action as "move" | "down" | "up" | "click" | "dblclick" | "wheel",
        x: typeof body.x === "number" ? body.x : Number(body.x),
        y: typeof body.y === "number" ? body.y : Number(body.y),
        button,
        deltaX: typeof body.deltaX === "number" ? body.deltaX : Number(body.deltaX) || 0,
        deltaY: typeof body.deltaY === "number" ? body.deltaY : Number(body.deltaY) || 0,
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (kind === "keyboard") {
      const action = typeof body.action === "string" ? body.action : "";
      if (!["press", "down", "up", "insertText"].includes(action)) {
        sendJson(res, 400, { ok: false, error: `无效键盘动作: ${action}` });
        return;
      }
      await browser.dispatchKeyboard({
        action: action as "press" | "down" | "up" | "insertText",
        key: typeof body.key === "string" ? body.key : undefined,
        text: typeof body.text === "string" ? body.text : undefined,
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 400, { ok: false, error: `未知输入类型: ${String(kind)}` });
  }

  private collectKnownSecretEnvNames(hato: HatoConfig, registry: ModelRegistry): string[] {
    const envMap = readEnvMap(this.envPath);
    const consoleCfg = resolveWebConsoleConfig(hato);
    const keys = new Set<string>([
      hato.gateway.telegram.bot_token_env,
      hato.gateway.qq.client_secret_env,
      resolveTavilySearchConfig(hato).apiKeyEnv,
      resolveMemoryEchoConfig(hato).apiKeyEnv,
      ...registry.listProviders().map((p) => p.apiKeyEnv),
      ...(consoleCfg.authTokenEnv ? [consoleCfg.authTokenEnv] : []),
      ...Object.keys(envMap),
    ]);
    return [...keys].filter((k) => k.trim().length > 0).sort();
  }

  private serveStaticAsset(pathname: string, res: ServerResponse, headOnly: boolean): void {
    const indexPath = resolve(this.staticDir, "index.html");
    if (!existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (!headOnly) {
        res.end(
          `<!doctype html><html><body style="font-family:sans-serif;padding:32px;line-height:1.6">` +
            `<h2>Hato Web 控制台后端已运行</h2>` +
            `<p>前端静态产物尚未构建，请运行 <code>npm run build:web</code> 后刷新页面。</p>` +
            `</body></html>`,
        );
      } else {
        res.end();
      }
      return;
    }

    const cleanRel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = resolve(this.staticDir, cleanRel);
    const safeCandidate =
      candidate === this.staticDir || candidate.startsWith(`${this.staticDir}${sep}`)
        ? candidate
        : indexPath;

    const targetPath =
      existsSync(safeCandidate) && statSync(safeCandidate).isFile() ? safeCandidate : indexPath;

    const ext = extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const bytes = readFileSync(targetPath);

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": bytes.byteLength,
    });
    if (headOnly) {
      res.end();
      return;
    }
    res.end(bytes);
  }
}

function maskSecretPreview(secret: string): string {
  const clean = secret.trim();
  if (clean.length <= 8) return "***";
  return `${clean.slice(0, 4)}***${clean.slice(-4)}`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error("Request body exceeds 16MB limit");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}
