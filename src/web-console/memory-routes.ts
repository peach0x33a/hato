import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveMemoryProvider, type HatoConfig } from "../config/app.js";
import type { HatoRepository, MemorySyncBank, MemorySyncStatus } from "../db/repo.js";
import type { MemoryCurator } from "../memory/curator.js";
import type { MemoryStore } from "../memory/store.js";
import { readJsonBody, sendJson } from "./http-utils.js";

export interface MemoryRoutesDeps {
  getConfig(): HatoConfig;
  getRepo(): HatoRepository;
  getMemoryStore?(): MemoryStore | null;
  getMemoryCurator?(): MemoryCurator | null;
}

export async function handleMemoryOverview(
  deps: MemoryRoutesDeps,
  res: ServerResponse,
): Promise<void> {
  const hato = deps.getConfig();
  const uid = hato.owner.canonical_user_id;
  const repo = deps.getRepo();
  const provider = resolveMemoryProvider(hato);
  const store = deps.getMemoryStore?.() ?? null;
  const configured = Boolean(store?.isConfigured());
  const stats = repo.getMemorySyncStats(uid);
  const workingMemory = repo.getWorkingMemory(uid);

  const [vaults, usage] = configured && store
    ? await Promise.all([
        store.listVaults?.().catch(() => []) ?? Promise.resolve([]),
        store.getUsage?.().catch(() => null) ?? Promise.resolve(null),
      ])
    : [[], null];

  sendJson(res, 200, {
    ok: true,
    provider,
    configured,
    stats,
    vaults,
    usage,
    workingMemory,
  });
}

export async function handleMemoryRecords(
  deps: MemoryRoutesDeps,
  parsedUrl: URL,
  res: ServerResponse,
): Promise<void> {
  const hato = deps.getConfig();
  const uid = hato.owner.canonical_user_id;
  const repo = deps.getRepo();

  const rawBank = parsedUrl.searchParams.get("bank")?.trim() ?? "";
  const bank: MemorySyncBank | undefined =
    rawBank === "persona" || rawBank === "tech" || rawBank === "notebook"
      ? rawBank
      : undefined;

  const rawStatus = parsedUrl.searchParams.get("status")?.trim() ?? "";
  const validStatuses: ReadonlySet<string> = new Set([
    "synced",
    "degraded",
    "denied",
    "error",
    "erased",
  ]);
  const status: MemorySyncStatus | undefined = validStatuses.has(rawStatus)
    ? (rawStatus as MemorySyncStatus)
    : undefined;

  const includeErasedParam = parsedUrl.searchParams.get("includeErased");
  const includeErased = includeErasedParam === "1" || includeErasedParam === "true";
  const q = parsedUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const rawLimit = Number(parsedUrl.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 100;

  let records = repo.listMemorySyncRecords(uid, {
    bank,
    status,
    includeErased,
    limit: q ? 200 : limit,
  });

  if (q) {
    records = records
      .filter(
        (r) =>
          r.content.toLowerCase().includes(q) ||
          (r.externalMemoryId ?? "").toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q),
      )
      .slice(0, limit);
  }

  sendJson(res, 200, { ok: true, records });
}

export async function handleMemoryRecall(
  deps: MemoryRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    query?: unknown;
    bank?: unknown;
    limit?: unknown;
  };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    sendJson(res, 400, { ok: false, error: "请输入要检索的记忆关键词或问题" });
    return;
  }

  const store = deps.getMemoryStore?.() ?? null;
  if (!store || !store.isConfigured()) {
    sendJson(res, 400, { ok: false, error: "当前记忆提供商未启用或未配置密钥" });
    return;
  }

  const rawBank = typeof body.bank === "string" ? body.bank.trim() : "";
  const bank: MemorySyncBank =
    rawBank === "tech" || rawBank === "notebook" ? rawBank : "persona";
  const rawLimit = typeof body.limit === "number" ? body.limit : 8;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, Math.floor(rawLimit))) : 8;

  const uid = deps.getConfig().owner.canonical_user_id;
  const result = await store.recall(uid, { bank, query, limit });
  sendJson(res, 200, { ok: true, result });
}

export async function handleMemorySync(
  deps: MemoryRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const curator = deps.getMemoryCurator?.();
  if (!curator) {
    sendJson(res, 503, { ok: false, error: "当前运行时未挂载 MemoryCurator" });
    return;
  }
  const body = (await readJsonBody(req)) as { includeDenied?: unknown };
  const uid = deps.getConfig().owner.canonical_user_id;
  const summary = await curator.retainPending(uid, {
    includeDeniedRetries: Boolean(body.includeDenied),
  });
  sendJson(res, 200, { ok: true, summary });
}

export async function handleMemoryForget(
  deps: MemoryRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const curator = deps.getMemoryCurator?.();
  if (!curator) {
    sendJson(res, 503, { ok: false, error: "当前运行时未挂载 MemoryCurator" });
    return;
  }
  const body = (await readJsonBody(req)) as { recordIds?: unknown; query?: unknown };
  const uid = deps.getConfig().owner.canonical_user_id;

  if (Array.isArray(body.recordIds) && body.recordIds.length > 0) {
    const recordIds = body.recordIds.filter((id): id is string => typeof id === "string");
    if (recordIds.length === 0) {
      sendJson(res, 400, { ok: false, error: "请提供有效的记忆记录 ID" });
      return;
    }
    const summary = await curator.forgetByRecordIds(uid, recordIds);
    sendJson(res, 200, { ok: true, summary });
    return;
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    sendJson(res, 400, { ok: false, error: "请提供 recordIds 或搜索关键词 query" });
    return;
  }
  const summary = await curator.forgetByQuery(uid, query);
  sendJson(res, 200, { ok: true, summary });
}
