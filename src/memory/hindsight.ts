import type { ResolvedHindsightConfig } from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { getOptionalSecret } from "../config/secrets.js";
import type { HatoRepository, MemorySyncBank } from "../db/repo.js";
import { logWarn } from "../utils/logger.js";
import type {
  MemoryEraseResult,
  MemoryRecallItem,
  MemoryRecallResult,
  MemoryRetainInput,
  MemoryRetainResult,
  MemoryStore,
  MemoryVaultInfo,
} from "./store.js";

const HINDSIGHT_PROXY_SCOPE = "memory.hindsight";

function sanitizeBankSegment(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9_-]+/g, "_") || "default";
}

/**
 * Hindsight REST API (`http://127.0.0.1:8888`) `MemoryStore` implementation.
 * Uses `/v1/default/banks/{bank_id}/memories` for retain/erase and `/memories/recall`
 * for semantic retrieval, with graceful SQLite fallback when the service is unreachable.
 */
export class HindsightStore implements MemoryStore {
  readonly providerName = "hindsight";
  private readonly ensuredBanks = new Set<string>();

  constructor(
    private config: ResolvedHindsightConfig,
    private readonly proxyRouter: ScopedProxyRouter,
    private readonly repo: HatoRepository,
    private readonly apiKeyOverride?: string,
  ) {}

  updateConfig(nextConfig: ResolvedHindsightConfig): void {
    this.config = nextConfig;
    this.ensuredBanks.clear();
  }

  isConfigured(): boolean {
    return this.config.enabled && Boolean(this.config.baseUrl.trim());
  }

  async resolveVaultId(
    canonicalUserId: string,
    bank: MemorySyncBank,
    opts?: { createIfMissing?: boolean },
  ): Promise<string | null> {
    if (!this.isConfigured()) return null;
    const baseBank = sanitizeBankSegment(this.config.banks[bank] || bank);
    const userSeg = sanitizeBankSegment(canonicalUserId);
    const bankId = `${baseBank}_${userSeg}`;

    if (opts?.createIfMissing && !this.ensuredBanks.has(bankId)) {
      const ok = await this.ensureBankExists(bankId, bank);
      if (ok) {
        this.ensuredBanks.add(bankId);
      }
    }
    return bankId;
  }

  async retain(canonicalUserId: string, input: MemoryRetainInput): Promise<MemoryRetainResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        status: "error",
        errorMessage: "Hindsight 记忆后端未启用",
      };
    }

    const bankId = await this.resolveVaultId(canonicalUserId, input.bank, { createIfMissing: true });
    if (!bankId) {
      return {
        ok: false,
        status: "error",
        errorMessage: "无法解析 Hindsight bank_id",
      };
    }

    const res = await this.requestJson<Record<string, unknown>>(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
      {
        items: [
          {
            content: input.content,
            metadata: {
              role: input.role,
              bank: input.bank,
              canonical_user_id: canonicalUserId,
            },
          },
        ],
        async: false,
      },
    );

    if (!res.ok) {
      return {
        ok: false,
        vaultId: bankId,
        status: res.status === 401 || res.status === 403 ? "denied" : "degraded",
        errorCode: `HTTP_${res.status || "NETWORK"}`,
        errorMessage: res.errorMessage ?? "Hindsight retain failed",
      };
    }

    const data = res.data ?? {};
    const externalId = extractRetainedMemoryId(data);
    return {
      ok: true,
      vaultId: bankId,
      externalMemoryId: externalId ?? undefined,
      status: "synced",
    };
  }

  async recall(
    canonicalUserId: string,
    params: { bank: MemorySyncBank; query: string; limit?: number },
  ): Promise<MemoryRecallResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        bank: params.bank,
        items: [],
        degraded: true,
        fallbackMessages: this.buildLocalFallback(canonicalUserId, params.bank, params.query, params.limit ?? 6),
        errorMessage: "Hindsight 未启用",
      };
    }

    const bankId = await this.resolveVaultId(canonicalUserId, params.bank, { createIfMissing: false });
    if (!bankId) {
      return {
        ok: false,
        bank: params.bank,
        items: [],
        degraded: true,
        fallbackMessages: this.buildLocalFallback(canonicalUserId, params.bank, params.query, params.limit ?? 6),
      };
    }

    const limit = Math.max(1, params.limit ?? 6);
    const res = await this.requestJson<Record<string, unknown>>(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
      {
        query: params.query,
        budget: "mid",
        max_tokens: limit * 256,
        top_k: limit,
      },
    );

    if (!res.ok) {
      logWarn("HINDSIGHT", `recall degraded (${params.bank}): ${res.errorMessage ?? res.status}`);
      return {
        ok: false,
        bank: params.bank,
        items: [],
        degraded: true,
        fallbackMessages: this.buildLocalFallback(canonicalUserId, params.bank, params.query, limit),
        errorCode: `HTTP_${res.status || "NETWORK"}`,
        errorMessage: res.errorMessage,
      };
    }

    const rawResults = Array.isArray(res.data?.results)
      ? res.data.results
      : Array.isArray(res.data?.items)
        ? res.data.items
        : [];
    const items: MemoryRecallItem[] = [];
    for (const raw of rawResults) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const content =
        typeof rec.text === "string"
          ? rec.text.trim()
          : typeof rec.content === "string"
            ? rec.content.trim()
            : "";
      if (!content) continue;
      const id = typeof rec.id === "string" && rec.id ? rec.id : `hs_${items.length}`;
      const score =
        typeof rec.score === "number"
          ? rec.score
          : typeof rec.weight === "number"
            ? rec.weight
            : undefined;
      const createdAt =
        typeof rec.occurred_start === "string"
          ? rec.occurred_start
          : typeof rec.created_at === "string"
            ? rec.created_at
            : undefined;
      const metadata =
        rec.metadata && typeof rec.metadata === "object"
          ? (rec.metadata as Record<string, unknown>)
          : null;
      items.push({
        id,
        bank: params.bank,
        content,
        role: typeof metadata?.role === "string" ? metadata.role : undefined,
        score,
        createdAt,
        metadata,
      });
      if (items.length >= limit) break;
    }

    return {
      ok: true,
      bank: params.bank,
      items,
      degraded: false,
    };
  }

  async erase(
    canonicalUserId: string,
    params: { bank: MemorySyncBank; memoryIds: string[] },
  ): Promise<MemoryEraseResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        erased: [],
        alreadyErased: [],
        missing: [],
        unmapped: params.memoryIds,
        derivedCleanupFailed: false,
        errorMessage: "Hindsight 未启用",
      };
    }

    const bankId = await this.resolveVaultId(canonicalUserId, params.bank, { createIfMissing: false });
    if (!bankId) {
      return {
        ok: false,
        erased: [],
        alreadyErased: [],
        missing: [],
        unmapped: params.memoryIds,
        derivedCleanupFailed: false,
        errorMessage: "Hindsight bank_id 解析失败",
      };
    }

    const erased: string[] = [];
    const alreadyErased: string[] = [];
    const missing: string[] = [];
    const unmapped: string[] = [];

    for (const id of params.memoryIds) {
      const res = await this.requestJson<Record<string, unknown>>(
        "DELETE",
        `/v1/default/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(id)}`,
      );
      if (res.ok) {
        erased.push(id);
      } else if (res.status === 404) {
        alreadyErased.push(id);
      } else {
        missing.push(id);
        unmapped.push(id);
      }
    }

    return {
      ok: unmapped.length === 0,
      erased,
      alreadyErased,
      missing,
      unmapped,
      derivedCleanupFailed: false,
      ...(unmapped.length > 0 ? { errorMessage: "部分 Hindsight 记忆删除失败" } : {}),
    };
  }

  async listVaults(): Promise<MemoryVaultInfo[]> {
    if (!this.isConfigured()) return [];
    const res = await this.requestJson<Record<string, unknown>>("GET", "/v1/default/banks");
    if (!res.ok || !res.data) return [];
    const banks = Array.isArray(res.data.banks)
      ? res.data.banks
      : Array.isArray(res.data)
        ? (res.data as unknown[])
        : [];
    return banks
      .filter((b): b is Record<string, unknown> => Boolean(b && typeof b === "object"))
      .map((b) => ({
        id: String(b.bank_id ?? b.id ?? ""),
        name: String(b.name ?? b.bank_id ?? ""),
        description: typeof b.mission === "string" ? b.mission : null,
        vaultType: "hindsight",
        memoryCount: Number(b.memory_count ?? 0),
        storageBytes: 0,
        createdAt: typeof b.created_at === "string" ? b.created_at : "",
        updatedAt: typeof b.updated_at === "string" ? b.updated_at : "",
      }))
      .filter((v) => v.id);
  }

  private async ensureBankExists(bankId: string, bank: MemorySyncBank): Promise<boolean> {
    const res = await this.requestJson<Record<string, unknown>>(
      "PUT",
      `/v1/default/banks/${encodeURIComponent(bankId)}`,
      {
        name: `hato-${bank}`,
        mission:
          bank === "persona"
            ? "Personal companion facts, preferences, and life events."
            : "Technical environment, workflows, and engineering preferences.",
      },
    );
    return res.ok;
  }

  private buildLocalFallback(
    canonicalUserId: string,
    bank: MemorySyncBank,
    query: string,
    limit: number,
  ): MemoryRecallItem[] {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    const rows = this.repo.listMemorySyncRecords(canonicalUserId, {
      bank,
      includeErased: false,
      limit: 60,
    });
    const scored = rows
      .map((r) => {
        const lower = r.content.toLowerCase();
        const hits = tokens.reduce((acc, tok) => (lower.includes(tok) ? acc + 1 : acc), 0);
        return { row: r, hits };
      })
      .filter((x) => tokens.length === 0 || x.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.row.createdAt - a.row.createdAt)
      .slice(0, limit);

    return scored.map(({ row }) => ({
      id: row.externalMemoryId || row.id,
      bank,
      content: row.content,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
  }

  private resolveApiKey(): string | undefined {
    if (this.apiKeyOverride?.trim()) return this.apiKeyOverride.trim();
    return getOptionalSecret(this.config.apiKeyEnv);
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data?: T; errorMessage?: string }> {
    const base = this.config.baseUrl.trim().replace(/\/+$/, "");
    const url = `${base}${path}`;
    const apiKey = this.resolveApiKey();
    const scopedFetch = this.proxyRouter.createScopedFetch(HINDSIGHT_PROXY_SCOPE);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const res = await this.proxyRouter.runWithScope(HINDSIGHT_PROXY_SCOPE, () =>
          scopedFetch(url, {
            method,
            headers: {
              ...(body !== undefined ? { "content-type": "application/json" } : {}),
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal,
          }),
        );
        const text = await res.text();
        let data: T | undefined;
        try {
          data = text ? (JSON.parse(text) as T) : undefined;
        } catch {
          data = undefined;
        }
        if (!res.ok) {
          const errObj = data as Record<string, unknown> | undefined;
          const msg =
            (typeof errObj?.detail === "string" && errObj.detail) ||
            (typeof errObj?.error === "string" && errObj.error) ||
            text.slice(0, 200) ||
            `HTTP ${res.status}`;
          return { ok: false, status: res.status, data, errorMessage: msg };
        }
        return { ok: true, status: res.status, data };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return {
        ok: false,
        status: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function extractRetainedMemoryId(data: Record<string, unknown>): string | null {
  if (typeof data.memory_id === "string" && data.memory_id) return data.memory_id;
  if (typeof data.id === "string" && data.id) return data.id;
  if (Array.isArray(data.ids) && typeof data.ids[0] === "string") return data.ids[0];
  if (Array.isArray(data.results) && data.results[0] && typeof data.results[0] === "object") {
    const first = data.results[0] as Record<string, unknown>;
    if (typeof first.id === "string" && first.id) return first.id;
  }
  if (typeof data.operation_id === "string" && data.operation_id) return data.operation_id;
  return null;
}
