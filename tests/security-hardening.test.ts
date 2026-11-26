import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ActorLock, EventBus } from "../src/bus/actor-bus.js";
import type { BrowserRuntime } from "../src/browser/runtime.js";
import { loadHatoConfig } from "../src/config/app.js";
import { loadMcpConfig } from "../src/config/mcp.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import {
  bindQqHomeChannel,
  bindTelegramHomeChannel,
  mergeEnvFile,
  resolvePlatformHomeBinding,
  unbindHomeChannel,
  writeHatoConfig,
} from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { ConfirmationService } from "../src/gateway/confirmation.js";
import { TicketCoordinator } from "../src/dispatch/coordinator.js";
import { NeutralRouter } from "../src/dispatch/router.js";
import { buildSanitizedScriptEnv } from "../src/dispatch/script-scheduler.js";
import { McpClientPool } from "../src/mcp/pool.js";
import { CompactionManager } from "../src/memory/compaction.js";
import { HindsightStore } from "../src/memory/hindsight.js";
import { PersonaRuntime } from "../src/persona/agent.js";
import { createPersonaReadOnlyTools, isSensitiveEnvFilePath } from "../src/persona/tools.js";
import { buildMarkdownDocumentHtml } from "../src/render/markdown-image.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { WebConsoleServer } from "../src/web-console/server.js";
import { WorkerDispatcher } from "../src/worker/backend.js";
import { BuiltinPiRunner } from "../src/worker/builtin-pi.js";
import { buildContextMcpSpec, ExternalCliRunner } from "../src/worker/external-cli.js";

test("WebConsoleServer blocks CSRF, secret exfiltration, non-loopback unauthenticated bind, and authenticates sticker ?token=", async () => {
  const faux = fauxProvider({
    api: "hato-faux-api",
    provider: "faux-provider",
    models: [{ id: "faux-persona-1", name: "Faux Persona" }],
  });

  const tempDir = mkdtempSync(join(tmpdir(), "hato-sec-console-"));
  const hatoTomlPath = join(tempDir, "hato.toml");
  const modelsTomlPath = join(tempDir, "models.toml");
  const promptsDir = join(tempDir, "prompts");
  const envPath = join(tempDir, ".env");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, "soul.md"), "test", "utf8");

  const tokenEnvName = "HATO_SEC_CONSOLE_TOKEN";
  const secretToken = "sec-token-abcdef123456";
  process.env[tokenEnvName] = secretToken;
  process.env.HATO_SEC_EXFIL_SECRET = "super-secret-value";
  mergeEnvFile(envPath, {
    [tokenEnvName]: secretToken,
    HATO_SEC_EXFIL_SECRET: "super-secret-value",
  });

  // Verify .env permissions are 0600 on POSIX
  if (process.platform !== "win32") {
    const mode = statSync(envPath).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  const cfg = createDefaultHatoConfig();
  cfg.paths.prompts_dir = promptsDir;
  cfg.owner.channels.tg.user_ids = [10001];
  cfg.web = {
    ...cfg.web,
    console: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      auth_token_env: tokenEnvName,
    },
  };
  writeHatoConfig(hatoTomlPath, cfg, { backup: false });
  writeFileSync(
    modelsTomlPath,
    `
[slots]
persona = "faux-provider/faux-persona-1"
router = "faux-provider/faux-persona-1"
curator = "faux-provider/faux-persona-1"
worker = "faux-provider/faux-persona-1"
hindsight_llm = "faux-provider/faux-persona-1"

[providers]
`,
    "utf8",
  );

  const dbHandle = openDatabase(":memory:");
  let currentConfig = loadHatoConfig(hatoTomlPath);
  const repo = new HatoRepository(dbHandle.db);
  const modelRegistry = new ModelRegistry(modelsTomlPath, repo, { extraProviders: [faux.provider] });
  const proxyRouter = new ScopedProxyRouter([]);
  const actorLock = new ActorLock();
  const runtime = new PersonaRuntime(currentConfig, modelRegistry, proxyRouter, repo);
  const compaction = new CompactionManager(
    {
      hotMessagesHighWatermark: 60,
      hotMessagesKeepAfterCompact: 10,
      minMessagesToCompact: 10,
      preCompactAfterMinutes: 50,
      idleCommitAfterMinutes: 60,
    },
    repo,
    actorLock,
    { summarizeBlock: async () => "summary" },
  );

  const fakeBrowserRuntime = {
    isPendingTakeover: () => false,
    isBusy: () => false,
  } as unknown as BrowserRuntime;

  const reloadAll = async () => {
    currentConfig = loadHatoConfig(hatoTomlPath);
    return { slots: [], proxyCount: 0, changes: [] };
  };

  // Non-loopback bind without auth token starts with warning & exposes unauthenticatedPublicBind in /api/health
  const publicCfg = createDefaultHatoConfig();
  publicCfg.web = {
    ...publicCfg.web,
    console: { enabled: true, host: "0.0.0.0", port: 0, auth_token_env: "HATO_UNSET_TOKEN_XYZ" },
  };
  const publicServer = new WebConsoleServer({
    hatoConfigPath: hatoTomlPath,
    modelsConfigPath: modelsTomlPath,
    envPath,
    getConfig: () => publicCfg,
    getModelRegistry: () => modelRegistry,
    getProxyRouter: () => proxyRouter,
    getRepo: () => repo,
    getPersonaRuntime: () => runtime,
    getBrowserRuntime: () => fakeBrowserRuntime,
    getCompactionManager: () => compaction,
    getActorLock: () => actorLock,
    getSlashDeps: () => ({
      repo,
      listModelSlots: () => [],
      listAvailableModels: () => [],
      setModelSlot: () => ({ slot: "persona", target: "", api: "", baseUrl: "" }),
      reloadAll,
      forceCompact: async () => false,
    }),
    reloadAll,
  });
  const pubAddr = await publicServer.start();
  assert.ok(pubAddr && pubAddr.port > 0);
  const pubHealth = (await (
    await fetch(`http://127.0.0.1:${pubAddr.port}/api/health`)
  ).json()) as { unauthenticatedPublicBind?: boolean };
  assert.equal(pubHealth.unauthenticatedPublicBind, true);
  await publicServer.stop();

  const server = new WebConsoleServer({
    hatoConfigPath: hatoTomlPath,
    modelsConfigPath: modelsTomlPath,
    envPath,
    getConfig: () => currentConfig,
    getModelRegistry: () => modelRegistry,
    getProxyRouter: () => proxyRouter,
    getRepo: () => repo,
    getPersonaRuntime: () => runtime,
    getBrowserRuntime: () => fakeBrowserRuntime,
    getCompactionManager: () => compaction,
    getActorLock: () => actorLock,
    getSlashDeps: () => ({
      repo,
      listModelSlots: () => [],
      listAvailableModels: () => [],
      setModelSlot: () => ({ slot: "persona", target: "", api: "", baseUrl: "" }),
      reloadAll,
      forceCompact: async () => false,
    }),
    reloadAll,
  });

  try {
    const addr = await server.start();
    assert.ok(addr && addr.port > 0);
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const authHeaders = { Authorization: `Bearer ${secretToken}` };

    // 1. CSRF cross-origin POST rejected with 403
    const csrfOriginRes = await fetch(`${baseUrl}/api/config/reload`, {
      method: "POST",
      headers: { ...authHeaders, Origin: "https://evil.example" },
    });
    assert.equal(csrfOriginRes.status, 403);

    // 2. Simple POST with text/plain rejected with 403
    const textPlainRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "text/plain" },
      body: JSON.stringify({ text: "pwn" }),
    });
    assert.equal(textPlainRes.status, 403);

    // 3. Invalid JSON returns 400 (not 500)
    const badJsonRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: "{not-json",
    });
    assert.equal(badJsonRes.status, 400);

    // 4. /api/config/models/test rejects arbitrary apiKeyEnv exfil to attacker baseUrl
    const exfilRes = await fetch(`${baseUrl}/api/config/models/test`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        providerSlug: "attacker",
        api: "openai-completions",
        baseUrl: "https://attacker.invalid/v1",
        apiKeyEnv: "HATO_SEC_EXFIL_SECRET",
        model: { id: "gpt-4o" },
      }),
    });
    assert.equal(exfilRes.status, 403);

    // 5. Per-platform Home bindings: TG bound (pairing=null), QQ unbound (pairing available)
    const boundPairingRes = await fetch(`${baseUrl}/api/pairing-code`, { headers: authHeaders });
    const boundPairingJson = (await boundPairingRes.json()) as {
      ok: boolean;
      proactiveChannel: string;
      platforms: {
        tg: { bound: boolean; targetId: string | null; pairing: { code: string } | null };
        qq: { bound: boolean; targetId: string | null; pairing: { code: string } | null };
      };
    };
    assert.equal(boundPairingJson.ok, true);
    assert.equal(boundPairingJson.platforms.tg.bound, true);
    assert.equal(boundPairingJson.platforms.tg.targetId, "10001");
    assert.equal(boundPairingJson.platforms.tg.pairing, null);
    assert.equal(boundPairingJson.platforms.qq.bound, false);
    assert.ok(boundPairingJson.platforms.qq.pairing?.code.startsWith("HATO-"));

    // Unbinding TG only unbinds TG, unlocks TG pairing, and leaves QQ untouched
    const unbindRes = await fetch(`${baseUrl}/api/home/unbind`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "tg", clearChannelWhitelist: true }),
    });
    const unbindJson = (await unbindRes.json()) as {
      ok: boolean;
      channel: string;
      clearedWhitelist: boolean;
      platforms: {
        tg: { bound: boolean; pairing: { code: string; command: string } | null };
        qq: { bound: boolean; pairing: { code: string } | null };
      };
    };
    assert.equal(unbindJson.ok, true);
    assert.equal(unbindJson.channel, "tg");
    assert.equal(unbindJson.platforms.tg.bound, false);
    assert.equal(unbindJson.clearedWhitelist, true);
    assert.ok(unbindJson.platforms.tg.pairing?.code.startsWith("HATO-"));
    assert.equal(unbindJson.platforms.qq.bound, false);
    assert.equal(currentConfig.owner.channels.tg.user_ids.length, 0);

    // PUT /api/home/proactive-channel validates & updates default proactive channel
    const badProactiveRes = await fetch(`${baseUrl}/api/home/proactive-channel`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ proactiveChannel: "web" }),
    });
    assert.equal(badProactiveRes.status, 400);

    const okProactiveRes = await fetch(`${baseUrl}/api/home/proactive-channel`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ proactiveChannel: "last_active" }),
    });
    assert.equal(okProactiveRes.status, 200);
    const okProactiveJson = (await okProactiveRes.json()) as {
      ok: boolean;
      proactiveChannel: string;
    };
    assert.equal(okProactiveJson.ok, true);
    assert.equal(okProactiveJson.proactiveChannel, "last_active");
    assert.equal(currentConfig.owner.proactive_channel, "last_active");

    // 6. Sticker image accepts ?token= when auth is enabled (returns 404 for missing sticker, NOT 401)
    const stickerUnauth = await fetch(`${baseUrl}/api/stickers/stk_missing/image`);
    assert.equal(stickerUnauth.status, 401);
    const stickerQueryAuth = await fetch(
      `${baseUrl}/api/stickers/stk_missing/image?token=${encodeURIComponent(secretToken)}`,
    );
    assert.equal(stickerQueryAuth.status, 404);
  } finally {
    delete process.env[tokenEnvName];
    delete process.env.HATO_SEC_EXFIL_SECRET;
    await server.stop();
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Persona send_file allows normal host files but requires extra confirmation for .env and symlinks to .env", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-env-confirm-"));
  const normalFile = join(tempDir, "notes.txt");
  const envFile = join(tempDir, ".env");
  const envLink = join(tempDir, "innocent.txt");
  writeFileSync(normalFile, "hello host file", "utf8");
  writeFileSync(envFile, "SECRET=1234", "utf8");
  symlinkSync(envFile, envLink);

  const dbHandle = openDatabase(":memory:");
  try {
    assert.equal(isSensitiveEnvFilePath(normalFile), false);
    assert.equal(isSensitiveEnvFilePath(envFile), true);
    assert.equal(isSensitiveEnvFilePath(envLink), true);

    const repo = new HatoRepository(dbHandle.db);
    const cfg = createDefaultHatoConfig();
    const proxyRouter = new ScopedProxyRouter([]);
    const bus = new EventBus();
    const confirmEvents: Array<{ ticketId: string; promptText: string }> = [];
    bus.on("ticket_confirm_required", (ev) => {
      confirmEvents.push({ ticketId: ev.ticketId, promptText: ev.promptText });
    });

    const delivered: string[] = [];
    const confirmService = new ConfirmationService({ repo, bus });
    confirmService.registerHandler<{ path: string }>("send_env_file", async (_uid, payload) => {
      delivered.push(payload.path);
      return { ok: true, message: `sent ${payload.path}` };
    });

    const directSent: string[] = [];
    const tools = createPersonaReadOnlyTools({
      repo,
      canonicalUserId: "owner",
      getTimezone: () => "Asia/Shanghai",
      getHatoConfig: () => cfg,
      proxyRouter,
      onSendFile: async ({ path }) => {
        directSent.push(path);
        return { ok: true, message: `direct ${path}` };
      },
      onRequestSensitiveFileConfirm: async (input) => {
        const ch = input.channel === "current" ? "tg" : input.channel;
        return confirmService.requestConfirm({
          canonicalUserId: "owner",
          channel: ch,
          kind: "send_env_file",
          briefTitle: `确认发送敏感文件: ${input.path}`,
          progressNote: "等待主人确认外发敏感 .env 文件",
          promptText: `请求外发敏感凭据文件：${input.path}`,
          payload: {
            kind: "send_env_file",
            channel: ch,
            path: input.path,
            caption: input.caption,
            text: input.text,
          },
        });
      },
    });

    const sendFileTool = tools.find((t) => t.name === "send_file")!;

    // Normal host file sends directly
    await sendFileTool.execute("c1", { path: normalFile });
    assert.deepEqual(directSent, [normalFile]);

    // .env file (and symlink to .env) requires confirmation and is NOT sent directly
    await sendFileTool.execute("c2", { path: envLink });
    assert.deepEqual(directSent, [normalFile]);
    assert.equal(confirmEvents.length, 1);
    assert.equal(delivered.length, 0);

    // Owner confirms via text reply ("确认 <ticketId>") -> now delivered!
    const confirmReply = await confirmService.tryHandleConfirmText(
      "owner",
      `确认 ${confirmEvents[0]!.ticketId}`,
    );
    assert.equal(confirmReply.handled, true);
    assert.deepEqual(delivered, [envLink]);
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildContextMcpSpec runs TypeScript directly under Bun without --import tsx", () => {
  const cfg = createDefaultHatoConfig();
  const spec = buildContextMcpSpec({
    hatoConfig: cfg,
    ticketId: "t_bun_ctx",
    contextId: "ctx_t_bun_ctx",
  });
  assert.equal(spec.args.includes("--import"), false);
  assert.equal(spec.args.includes("tsx"), false);
  assert.equal(spec.args.length, 1);
  assert.ok(spec.args[0]!.endsWith("context-server.ts") || spec.args[0]!.endsWith("context-server.js"));
});

test("Home binding requires Console unbind before /sethome, and pairing code locks out after 5 wrong tries", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-home-lock-"));
  const hatoPath = join(tempDir, "hato.toml");
  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    const cfg = createDefaultHatoConfig();
    cfg.owner.channels.tg.user_ids = [];
    cfg.owner.channels.qq.open_ids = [];
    writeHatoConfig(hatoPath, cfg, { backup: false });

    assert.equal(resolvePlatformHomeBinding("tg", cfg, repo).bound, false);
    assert.equal(resolvePlatformHomeBinding("qq", cfg, repo).bound, false);

    // Pairing code rate-limit lockout after 5 failures is scoped per platform
    const tgCode = repo.getOrCreateHomePairingCode("tg");
    const qqCode = repo.getOrCreateHomePairingCode("qq");
    assert.equal(tgCode.length, "HATO-".length + 10);
    for (let i = 0; i < 5; i++) {
      assert.equal(repo.verifyAndConsumeHomePairingCode("tg", "HATO-WRONG00000"), false);
    }
    // Even real TG code is locked out during lockout window, while QQ remains unaffected
    assert.equal(repo.verifyAndConsumeHomePairingCode("tg", tgCode), false);
    assert.equal(repo.verifyAndConsumeHomePairingCode("qq", qqCode), true);

    // Binding TG does not mark QQ bound; unbinding TG does not unbind QQ
    const boundTg = bindTelegramHomeChannel({
      hatoConfigPath: hatoPath,
      repo,
      canonicalUserId: "owner",
      tgUserId: "123456",
      currentConfig: cfg,
    });
    const boundBoth = bindQqHomeChannel({
      hatoConfigPath: hatoPath,
      repo,
      canonicalUserId: "owner",
      qqOpenId: "QQ_OPEN_99",
      currentConfig: boundTg.updatedConfig,
    });
    assert.equal(resolvePlatformHomeBinding("tg", boundBoth.updatedConfig, repo).bound, true);
    assert.equal(resolvePlatformHomeBinding("qq", boundBoth.updatedConfig, repo).bound, true);

    const unboundTg = unbindHomeChannel({
      channel: "tg",
      hatoConfigPath: hatoPath,
      repo,
      canonicalUserId: "owner",
      currentConfig: boundBoth.updatedConfig,
      clearChannelWhitelist: false,
    });
    assert.equal(resolvePlatformHomeBinding("tg", unboundTg.updatedConfig, repo).bound, false);
    assert.equal(resolvePlatformHomeBinding("qq", unboundTg.updatedConfig, repo).bound, true);

    // getLastActiveImChannel ignores web/assistant messages and picks latest IM user message
    assert.equal(repo.getLastActiveImChannel("owner"), null);
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "user",
      content: "hi from tg",
      createdAt: 1000,
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "web",
      role: "user",
      content: "hi from web",
      createdAt: 2000,
    });
    assert.equal(repo.getLastActiveImChannel("owner"), "tg");
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "qq",
      role: "user",
      content: "hi from qq",
      createdAt: 3000,
    });
    repo.appendRawMessage({
      canonicalUserId: "owner",
      channel: "tg",
      role: "assistant",
      content: "assistant reply",
      createdAt: 4000,
    });
    assert.equal(repo.getLastActiveImChannel("owner"), "qq");
  } finally {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Markdown HTML strips scripts/iframes with CSP, ScriptScheduler sanitizes env, and Hindsight fallback tokenizes Chinese", async () => {
  const html = buildMarkdownDocumentHtml(
    '# Title\n\n<script>fetch("http://127.0.0.1:3820")</script><iframe src="http://169.254.169.254"></iframe><img src="x" onerror="alert(1)">',
  );
  assert.ok(html.includes("Content-Security-Policy"));
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("<iframe"), false);
  assert.equal(html.includes("onerror="), false);

  const sanitizedEnv = buildSanitizedScriptEnv(["RSS_API_KEY"], {
    PATH: "/usr/bin",
    TG_BOT_TOKEN: "must-not-leak",
    OPENAI_API_KEY: "must-not-leak",
    RSS_API_KEY: "allowed-secret",
  });
  assert.equal(sanitizedEnv.RSS_API_KEY, "allowed-secret");
  assert.equal("TG_BOT_TOKEN" in sanitizedEnv, false);
  assert.equal("OPENAI_API_KEY" in sanitizedEnv, false);

  // Hindsight local fallback matches Chinese substrings without spaces
  const dbHandle = openDatabase(":memory:");
  try {
    const repo = new HatoRepository(dbHandle.db);
    repo.insertMemorySyncRecord({
      canonicalUserId: "u1",
      provider: "hindsight",
      bank: "persona",
      sourceMsgIds: ["m1"],
      content: "用户最喜欢在周末喝冰美式咖啡",
      status: "synced",
    });
    const store = new HindsightStore(
      {
        enabled: false,
        baseUrl: "",
        apiKeyEnv: "HINDSIGHT_API_KEY",
        timeoutMs: 1000,
        embeddingDimensions: 1024,
        banks: { persona: "persona", tech: "tech" },
      },
      new ScopedProxyRouter([]),
      repo,
    );
    const res = await store.recall("u1", {
      bank: "persona",
      query: "用户周末喜欢喝冰美式吗",
      limit: 5,
    });
    assert.equal(res.degraded, true);
    assert.equal(res.fallbackMessages?.length, 1);

    // Stale ticket recovery on startup
    repo.createTicket({
      id: "t_stale_1",
      canonicalUserId: "u1",
      status: "running",
      backend: "builtin-pi",
      briefTitle: "stale",
      originChannel: "tg",
    });
    assert.equal(repo.failStaleInFlightTickets(), 1);
    assert.equal(repo.getTicket("t_stale_1")?.status, "failed");
  } finally {
    dbHandle.close();
  }
});

test("McpClientPool confirm_tools fails closed when onConfirmRequired is omitted", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-mcp-failclosed-"));
  const serverScript = join(tempDir, "mock-mcp.mjs");
  const sdkServerIndex = join(process.cwd(), "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js");
  const sdkServerStdio = join(process.cwd(), "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js");
  const sdkTypes = join(process.cwd(), "node_modules/@modelcontextprotocol/sdk/dist/esm/types.js");
  writeFileSync(
    serverScript,
    `
import { Server } from ${JSON.stringify(sdkServerIndex)};
import { StdioServerTransport } from ${JSON.stringify(sdkServerStdio)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkTypes)};
const s = new Server({ name: "mock-fc", version: "1.0.0" }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "danger", description: "danger", inputSchema: { type: "object", properties: {} } }]
}));
s.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "RAN" }] }));
await s.connect(new StdioServerTransport());
`,
    "utf8",
  );
  const mcpToml = join(tempDir, "mcp.toml");
  writeFileSync(
    mcpToml,
    `
[servers.danger_srv]
zone = "worker"
transport = "stdio"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(serverScript)}]
confirm_tools = ["danger"]
`,
    "utf8",
  );

  const pool = new McpClientPool();
  try {
    await pool.syncConfig(loadMcpConfig(mcpToml), { eagerZones: [] });
    const tools = await pool.getToolsForWorker(["danger_srv"]);
    assert.equal(tools.length, 1);
    await assert.rejects(() => tools[0]!.execute("c1", {}), /未接入确认流程/);
  } finally {
    await pool.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
