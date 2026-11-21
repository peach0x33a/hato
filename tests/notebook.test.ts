import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorLock } from "../src/bus/actor-bus.js";
import { ModelRegistry } from "../src/config/models.js";
import { ScopedProxyRouter } from "../src/config/proxy.js";
import { writeHatoConfig } from "../src/config/store.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository, type MemorySyncBank } from "../src/db/repo.js";
import { CompactionManager } from "../src/memory/compaction.js";
import { HindsightStore } from "../src/memory/hindsight.js";
import { MemoryEchoStore } from "../src/memory/memoryecho.js";
import type { MemoryRecallItem, MemoryStore } from "../src/memory/store.js";
import { NotebookService, extractNotebookIdsFromText, formatNotebookIndexText } from "../src/notebook/service.js";
import { NotebookStore } from "../src/notebook/store.js";
import { PersonaRuntime } from "../src/persona/agent.js";
import { selectToolsForTurn } from "../src/persona/tool-disclosure.js";
import { createPersonaReadOnlyTools } from "../src/persona/tools.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import { WebConsoleServer } from "../src/web-console/server.js";

const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SAMPLE_PNG_DATA_URL = `data:image/png;base64,${SAMPLE_PNG_BASE64}`;

function createTempEnv() {
  const dir = mkdtempSync(join(tmpdir(), "hato-notebook-test-"));
  const cfg = createDefaultHatoConfig();
  cfg.paths.sqlite = join(dir, "hato.db");
  const dbHandle = openDatabase(cfg.paths.sqlite);
  const repo = new HatoRepository(dbHandle.db);
  const store = new NotebookStore(dbHandle.db);
  return {
    dir,
    cfg,
    dbHandle,
    repo,
    store,
    cleanup: () => {
      dbHandle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createFakeMemoryStore() {
  const retained: Array<{ bank: MemorySyncBank; content: string; id: string }> = [];
  const erased: Array<{ bank: MemorySyncBank; memoryIds: string[] }> = [];
  let recallHandler: ((query: string) => MemoryRecallItem[]) | null = null;
  let seq = 0;

  const store: MemoryStore = {
    providerName: "fake-memory",
    isConfigured: () => true,
    resolveVaultId: async (_uid, bank) => `vault_${bank}`,
    retain: async (_uid, input) => {
      seq += 1;
      const id = `ext_mem_${seq}`;
      retained.push({ bank: input.bank, content: input.content, id });
      return {
        ok: true,
        vaultId: `vault_${input.bank}`,
        externalMemoryId: id,
        status: "synced",
      };
    },
    recall: async (_uid, params) => {
      const items = recallHandler
        ? recallHandler(params.query)
        : retained
            .filter((r) => r.bank === params.bank)
            .map((r) => ({ id: r.id, bank: params.bank, content: r.content }));
      return {
        ok: true,
        bank: params.bank,
        items,
        degraded: false,
      };
    },
    erase: async (_uid, params) => {
      erased.push({ bank: params.bank, memoryIds: [...params.memoryIds] });
      return {
        ok: true,
        erased: [...params.memoryIds],
        alreadyErased: [],
        missing: [],
        unmapped: [],
        derivedCleanupFailed: false,
      };
    },
  };

  return {
    store,
    retained,
    erased,
    setRecallHandler: (fn: (query: string) => MemoryRecallItem[]) => {
      recallHandler = fn;
    },
  };
}

describe("Hato Notebook (小本本)", () => {
  it("supports text, image, and mixed CRUD with safe managed image copying and cleanup", async () => {
    const env = createTempEnv();
    try {
      const svc = new NotebookService({
        store: env.store,
        getHatoConfig: () => env.cfg,
        getMemoryStore: () => null,
      });

      // Pure text entry
      const textEntry = await svc.saveEntry("u1", {
        title: "部署命令",
        summary: "本地测试与构建命令",
        reason: "每次发版前都要跑一遍",
        tags: ["cli", "build"],
        content: "bun run typecheck && bun run build:web",
      });
      expect(textEntry.id.startsWith("nb_")).toBe(true);
      expect(textEntry.kind).toBe("text");
      expect(textEntry.indexStatus).toBe("local_only");
      expect(textEntry.hasText).toBe(true);
      expect(textEntry.hasImage).toBe(false);

      // Pure image entry from local file (verifies copy & source preservation)
      const sourceImg = join(env.dir, "source-ref.png");
      writeFileSync(sourceImg, Buffer.from(SAMPLE_PNG_BASE64, "base64"));
      const imgEntry = await svc.saveEntry("u1", {
        title: "Hato 三视图",
        summary: "Hato 角色三视图参考",
        reason: "以后画同人图时作为 reference_image_paths",
        imagePath: sourceImg,
      });
      expect(imgEntry.kind).toBe("image");
      expect(imgEntry.imagePath).toBeTruthy();
      expect(imgEntry.imagePath).not.toBe(sourceImg);
      expect(existsSync(imgEntry.imagePath!)).toBe(true);

      // Mixed entry via Data URL
      const mixedEntry = await svc.saveEntry("u1", {
        summary: "配色方案与色卡",
        reason: "UI 设计参考",
        content: "Primary: #3B82F6, Surface: #0F172A",
        imageDataUrl: SAMPLE_PNG_DATA_URL,
      });
      expect(mixedEntry.kind).toBe("mixed");
      expect(mixedEntry.hasText).toBe(true);
      expect(mixedEntry.hasImage).toBe(true);

      // Stats
      const stats = env.store.getStats("u1");
      expect(stats.total).toBe(3);
      expect(stats.textCount).toBe(1);
      expect(stats.imageCount).toBe(1);
      expect(stats.mixedCount).toBe(1);

      // Delete image entry: managed copy removed, original source file untouched
      const deleted = await svc.deleteEntry("u1", imgEntry.id);
      expect(deleted).toBe(true);
      expect(existsSync(imgEntry.imagePath!)).toBe(false);
      expect(existsSync(sourceImg)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("validates required summary, reason, content/image, and rejects sensitive .env paths", async () => {
    const env = createTempEnv();
    try {
      const svc = new NotebookService({
        store: env.store,
        getHatoConfig: () => env.cfg,
        getMemoryStore: () => null,
      });

      await expect(
        svc.saveEntry("u1", { summary: "  ", reason: "r", content: "x" }),
      ).rejects.toThrow("概要");
      await expect(
        svc.saveEntry("u1", { summary: "s", reason: "  ", content: "x" }),
      ).rejects.toThrow("存入原因");
      await expect(
        svc.saveEntry("u1", { summary: "s", reason: "r" }),
      ).rejects.toThrow("不能同时为空");

      const envFile = join(env.dir, ".env");
      writeFileSync(envFile, "SECRET=123\n");
      await expect(
        svc.saveEntry("u1", { summary: "s", reason: "r", imagePath: envFile }),
      ).rejects.toThrow("敏感");
    } finally {
      env.cleanup();
    }
  });

  it("indexes entries into memory bank 'notebook', resolves semantic + local search, updates, erases, and reindexes", async () => {
    const env = createTempEnv();
    try {
      const fakeMem = createFakeMemoryStore();
      let activeMem: MemoryStore | null = fakeMem.store;

      const svc = new NotebookService({
        store: env.store,
        getHatoConfig: () => env.cfg,
        getMemoryStore: () => activeMem,
      });

      const entry1 = await svc.saveEntry("u1", {
        title: "咖啡偏好",
        summary: "冰美式少冰无糖",
        reason: "点单复用",
        tags: ["饮品"],
        content: "大杯冰美式，少冰，不要糖浆",
      });
      expect(entry1.indexStatus).toBe("synced");
      expect(entry1.externalMemoryId).toBe("ext_mem_1");
      expect(fakeMem.retained[0]?.bank).toBe("notebook");
      expect(formatNotebookIndexText(entry1)).toContain(entry1.id);

      // Save a second entry while memory is offline -> local_only, then reindex
      activeMem = null;
      const entry2 = await svc.saveEntry("u1", {
        title: "SSH 端口",
        summary: "测试机 SSH 端口 2222",
        reason: "运维连接复用",
        content: "ssh -p 2222 dev@example.local",
      });
      expect(entry2.indexStatus).toBe("local_only");

      activeMem = fakeMem.store;
      const reindexRes = await svc.reindexAll("u1");
      expect(reindexRes.ok).toBe(true);
      expect(reindexRes.total).toBe(1);
      expect(reindexRes.synced).toBe(1);
      expect(env.store.getById("u1", entry2.id)?.indexStatus).toBe("synced");

      // Semantic search: 1st item matched by externalMemoryId, 2nd matched via [nb_xxx] in rewritten text
      fakeMem.setRecallHandler(() => [
        { id: "ext_mem_1", bank: "notebook", content: "rewritten summary without id" },
        { id: "unrelated_id", bank: "notebook", content: `mention [${entry2.id}] inside note` },
      ]);
      const searchRes = await svc.searchEntries("u1", { query: "点单", limit: 10 });
      expect(searchRes.usedSemanticIndex).toBe(true);
      expect(searchRes.entries.map((e) => e.id)).toEqual([entry1.id, entry2.id]);
      expect(extractNotebookIdsFromText(`ref [${entry2.id}]`)).toEqual([entry2.id]);

      // Update entry1 -> erases ext_mem_1 and retains new index
      const updated = await svc.updateEntry("u1", entry1.id, {
        summary: "热美式不加糖",
        content: "换季改喝热美式",
      });
      expect(updated?.summary).toBe("热美式不加糖");
      expect(fakeMem.erased.some((e) => e.bank === "notebook" && e.memoryIds.includes("ext_mem_1"))).toBe(
        true,
      );

      // Delete entry1 -> erases latest externalMemoryId
      const latestExtId = updated!.externalMemoryId!;
      await svc.deleteEntry("u1", entry1.id);
      expect(fakeMem.erased.some((e) => e.bank === "notebook" && e.memoryIds.includes(latestExtId))).toBe(
        true,
      );
      expect(env.store.getById("u1", entry1.id)).toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it("supports bank='notebook' in HindsightStore and MemoryEchoStore", async () => {
    const env = createTempEnv();
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
        calls.push({ method: req.method, path: url.pathname, body });
        if (url.pathname.startsWith("/v1/default/banks/")) {
          if (url.pathname.endsWith("/memories") && req.method === "POST") {
            return Response.json({ success: true, item_ids: ["hs_nb_1"] });
          }
          return Response.json({ ok: true });
        }
        if (url.pathname === "/api/v1/memory/vaults" && req.method === "GET") {
          return Response.json([]);
        }
        if (url.pathname === "/api/v1/memory/vaults" && req.method === "POST") {
          return Response.json({
            id: "v_nb_1",
            name: (body as Record<string, unknown>)?.name ?? "hato-u1-notebook",
            description: "notebook",
            vault_type: "normal",
            memory_count: 0,
            storage_bytes: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
        if (url.pathname === "/api/v1/memory/append-assistant-message" && req.method === "POST") {
          return Response.json({ id: "me_nb_1", pipeline: { status: "ok" } });
        }
        return Response.json({}, { status: 404 });
      },
    });

    try {
      process.env.HINDSIGHT_API_KEY = "hs-test-key";
      process.env.MEMORYECHO_API_KEY = "me-test-key";

      const hs = new HindsightStore(
        {
          enabled: true,
          baseUrl: `http://127.0.0.1:${server.port}`,
          apiKeyEnv: "HINDSIGHT_API_KEY",
          timeoutMs: 5000,
          embeddingDimensions: 1024,
          banks: { persona: "persona", tech: "tech", notebook: "notebook" },
        },
        new ScopedProxyRouter([]),
        env.repo,
      );
      const hsRet = await hs.retain("u1", {
        bank: "notebook",
        role: "assistant",
        content: "[nb_1] test",
      });
      expect(hsRet.ok).toBe(true);
      expect(hsRet.vaultId).toBe("notebook_u1");

      const me = new MemoryEchoStore(
        {
          enabled: true,
          baseUrl: `http://127.0.0.1:${server.port}`,
          apiKeyEnv: "MEMORYECHO_API_KEY",
          timeoutMs: 5000,
          autoCreateVaults: true,
          vaults: { persona: "", tech: "", notebook: "" },
        },
        new ScopedProxyRouter([]),
        env.repo,
      );
      const meRet = await me.retain("u1", {
        bank: "notebook",
        role: "assistant",
        content: "[nb_2] test",
      });
      expect(meRet.ok).toBe(true);
      expect(meRet.vaultId).toBe("v_nb_1");
      expect(calls.some((c) => c.path === "/api/v1/memory/vaults" && c.method === "POST")).toBe(true);
    } finally {
      server.stop(true);
      env.cleanup();
    }
  });

  it("exposes notebook tools, returns ImageContent on notebook_read, and discloses tools on notebook prompts", async () => {
    const env = createTempEnv();
    try {
      const svc = new NotebookService({
        store: env.store,
        getHatoConfig: () => env.cfg,
        getMemoryStore: () => null,
      });

      const imgFile = join(env.dir, "ref.png");
      writeFileSync(imgFile, Buffer.from(SAMPLE_PNG_BASE64, "base64"));

      const tools = createPersonaReadOnlyTools({
        repo: env.repo,
        canonicalUserId: "u1",
        getTimezone: () => "Asia/Shanghai",
        getHatoConfig: () => env.cfg,
        proxyRouter: new ScopedProxyRouter([]),
        onNotebookSave: async (input) => {
          const saved = await svc.saveEntry("u1", input);
          return { ok: true, entryId: saved.id, message: `saved ${saved.id}` };
        },
        onNotebookSearch: async (input) => {
          const res = await svc.searchEntries("u1", input);
          return res.entries.map((e) => e.id).join(",");
        },
        onNotebookRead: async ({ entryId }) => {
          const found = svc.readEntry("u1", entryId);
          if (!found) return { ok: false, text: "missing" };
          return {
            ok: true,
            text: `image_path: ${found.imagePath}\n${found.content}`,
            imagePath: found.imagePath,
          };
        },
        onNotebookManage: async (input) => {
          if (input.action === "delete") {
            const ok = await svc.deleteEntry("u1", input.entryId);
            return { ok, message: ok ? "deleted" : "missing" };
          }
          const updated = await svc.updateEntry("u1", input.entryId, input);
          return { ok: Boolean(updated), message: updated ? "updated" : "missing" };
        },
      });

      const disclosed = selectToolsForTurn({
        allTools: tools,
        userText: "帮我记到小本本里，以后画画当参考图",
      }).map((t) => t.name);
      expect(disclosed).toContain("notebook_save");
      expect(disclosed).toContain("notebook_search");
      expect(disclosed).toContain("notebook_read");
      expect(disclosed).toContain("notebook_manage");

      const saveTool = tools.find((t) => t.name === "notebook_save")!;
      const saveRes = await saveTool.execute("c1", {
        summary: "角色参考图",
        reason: "画画复用",
        content: "白发蓝瞳",
        image_path: imgFile,
      });
      const entryId = (saveRes.details as { entryId: string }).entryId;
      expect(entryId).toBeTruthy();

      const readTool = tools.find((t) => t.name === "notebook_read")!;
      const readRes = await readTool.execute("c2", { entry_id: entryId });
      expect(readRes.content.some((c) => c.type === "text" && c.text.includes("image_path:"))).toBe(true);
      expect(readRes.content.some((c) => c.type === "image")).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("serves Web Console /api/notebook CRUD, image with ?token= auth, and reindex", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hato-notebook-web-"));
    const hatoTomlPath = join(dir, "hato.toml");
    const modelsTomlPath = join(dir, "models.toml");
    const promptsDir = join(dir, "prompts");
    const staticDir = join(dir, "static");
    mkdirSync(promptsDir, { recursive: true });
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(promptsDir, "soul.md"), "测试人设");
    writeFileSync(join(staticDir, "index.html"), "<html></html>");

    const tokenEnv = "HATO_NOTEBOOK_TEST_TOKEN";
    const token = "nb-test-secret-token";
    process.env[tokenEnv] = token;

    const cfg = createDefaultHatoConfig();
    cfg.paths.sqlite = join(dir, "hato.db");
    cfg.paths.prompts_dir = promptsDir;
    cfg.web = {
      ...cfg.web,
      console: { enabled: true, host: "127.0.0.1", port: 0, auth_token_env: tokenEnv },
    };
    writeHatoConfig(hatoTomlPath, cfg, { backup: false });
    writeFileSync(
      modelsTomlPath,
      `[slots]
persona = "p/m"
router = "p/m"
curator = "p/m"
worker = "p/m"
hindsight_llm = "p/m"

[providers.p]
api = "openai-completions"
base_url = "http://127.0.0.1:1"
api_key_env = "DUMMY"

[[providers.p.models]]
id = "m"
name = "M"
`,
    );

    const dbHandle = openDatabase(cfg.paths.sqlite);
    const repo = new HatoRepository(dbHandle.db);
    const proxyRouter = new ScopedProxyRouter([]);
    const modelRegistry = new ModelRegistry(modelsTomlPath);
    const personaRuntime = new PersonaRuntime(cfg, modelRegistry, proxyRouter, repo, undefined, null, hatoTomlPath);
    const compactionManager = new CompactionManager(cfg, modelRegistry, proxyRouter, repo, null);
    const nbStore = new NotebookStore(dbHandle.db);
    const fakeMem = createFakeMemoryStore();
    const nbService = new NotebookService({
      store: nbStore,
      getHatoConfig: () => cfg,
      getMemoryStore: () => fakeMem.store,
    });

    const server = new WebConsoleServer({
      hatoConfigPath: hatoTomlPath,
      modelsConfigPath: modelsTomlPath,
      staticDir,
      getConfig: () => cfg,
      getModelRegistry: () => modelRegistry,
      getProxyRouter: () => proxyRouter,
      getNotebookService: () => nbService,
      getRepo: () => repo,
      getPersonaRuntime: () => personaRuntime,
      getBrowserRuntime: () => ({ getInteractiveStatus: async () => ({ running: false }) }) as any,
      getCompactionManager: () => compactionManager,
      getActorLock: () => new ActorLock(),
      getSlashDeps: () => ({}) as any,
      reloadAll: async () => ({ slots: [], proxyCount: 0 }),
    });

    try {
      const started = await server.start();
      const base = `http://127.0.0.1:${started!.port}`;
      const authHeaders = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };

      // Create mixed entry via POST /api/notebook
      const createRes = await fetch(`${base}/api/notebook`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          title: "Web 条目",
          summary: "从控制台新建的图文条目",
          reason: "测试 Web UI 后端接口",
          tags: ["web", "test"],
          content: "hello notebook",
          imageDataUrl: SAMPLE_PNG_DATA_URL,
        }),
      });
      expect(createRes.status).toBe(201);
      const createdJson = (await createRes.json()) as { ok: boolean; entry: { id: string; kind: string } };
      expect(createdJson.ok).toBe(true);
      expect(createdJson.entry.kind).toBe("mixed");
      const entryId = createdJson.entry.id;

      // List via GET /api/notebook
      const listRes = await fetch(`${base}/api/notebook?kind=mixed`, { headers: authHeaders });
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as {
        ok: boolean;
        entries: Array<{ id: string }>;
        stats: { total: number };
      };
      expect(listJson.entries.some((e) => e.id === entryId)).toBe(true);
      expect(listJson.stats.total).toBe(1);

      // Image endpoint with ?token= query auth (for <img> tags)
      const unauthImgRes = await fetch(`${base}/api/notebook/${entryId}/image`);
      expect(unauthImgRes.status).toBe(401);
      const imgRes = await fetch(`${base}/api/notebook/${entryId}/image?token=${token}`);
      expect(imgRes.status).toBe(200);
      expect(imgRes.headers.get("content-type")).toBe("image/png");

      // Patch entry
      const patchRes = await fetch(`${base}/api/notebook/${entryId}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ summary: "更新后的概要", removeImage: true }),
      });
      expect(patchRes.status).toBe(200);
      const patchJson = (await patchRes.json()) as { ok: boolean; entry: { kind: string; summary: string } };
      expect(patchJson.entry.kind).toBe("text");
      expect(patchJson.entry.summary).toBe("更新后的概要");

      // Reindex endpoint (not captured by :id route)
      const reindexRes = await fetch(`${base}/api/notebook/reindex`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ force: true }),
      });
      expect(reindexRes.status).toBe(200);
      const reindexJson = (await reindexRes.json()) as { ok: boolean; synced: number };
      expect(reindexJson.ok).toBe(true);
      expect(reindexJson.synced).toBe(1);

      // Delete entry
      const delRes = await fetch(`${base}/api/notebook/${entryId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      expect(delRes.status).toBe(200);
      const afterGet = await fetch(`${base}/api/notebook/${entryId}`, { headers: authHeaders });
      expect(afterGet.status).toBe(404);
    } finally {
      await server.stop();
      dbHandle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
