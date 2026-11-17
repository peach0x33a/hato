import { createHash } from "node:crypto";
import type { ResolvedMemoryEchoConfig } from "../config/app.js";
import type { ScopedProxyRouter } from "../config/proxy.js";
import { getOptionalSecret } from "../config/secrets.js";
import type { HatoRepository, MemorySyncBank } from "../db/repo.js";
import { logInfo, logWarn } from "../utils/logger.js";
import type {
  MemoryEraseResult,
  MemoryRecallItem,
  MemoryRecallResult,
  MemoryRetainInput,
  MemoryRetainResult,
  MemoryStore,
  MemoryUsageSummary,
  MemoryVaultInfo,
} from "./store.js";

const MEMORYECHO_PROXY_SCOPE = "memory.memoryecho";
const MAX_ERASE_BATCH = 50;

interface MemoryEchoErrorPayload {
  error?: unknown;
  error_code?: unknown;
  memory_id?: unknown;
  pipeline?: unknown;
  detail?: unknown;
}

interface RawVaultPayload {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  vault_type?: unknown;
  memory_count?: unknown;
  storage_bytes?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

/**
 * MemoryEcho (https://docs.artific.social/MemoryEcho/) REST API provider.
 * Uses `query-readonly` for non-polluting semantic recall, `append-*-message`
 * for retention, and `/messages/erase` for cascading deletion.
 */
export class MemoryEchoStore implements MemoryStore {
  readonly providerName = "memoryecho";
  private readonly vaultResolveLocks = new Map<string, Promise<string | null>>();

  constructor(
    private config: ResolvedMemoryEchoConfig,
    private readonly proxyRouter: ScopedProxyRouter,
    private readonly repo: HatoRepository,
    private readonly apiKeyOverride?: string,
  ) {}

  updateConfig(nextConfig: ResolvedMemoryEchoConfig): void {
    this.config = nextConfig;
  }

  isConfigured(): boolean {
    return this.config.enabled && Boolean(this.resolveApiKey());
  }

  async resolveVaultId(
    canonicalUserId: string,
    bank: MemorySyncBank,
    opts?: { createIfMissing?: boolean },
  ): Promise<string | null> {
    const configured = this.config.vaults[bank]?.trim();
    if (configured) return configured;

    const settingKey = vaultSettingKey(canonicalUserId, bank);
    const cached = this.repo.getRuntimeSetting<{ vaultId?: string }>(settingKey);
    if (cached?.vaultId && typeof cached.vaultId === "string" && cached.vaultId.trim()) {
      return cached.vaultId.trim();
    }

    const lockKey = `${canonicalUserId}:${bank}`;
    const inflight = this.vaultResolveLocks.get(lockKey);
    if (inflight) return inflight;

    const promise = this.discoverOrCreateVault(canonicalUserId, bank, settingKey, opts?.createIfMissing ?? false);
    this.vaultResolveLocks.set(lockKey, promise);
    try {
      return await promise;
    } finally {
      if (this.vaultResolveLocks.get(lockKey) === promise) {
        this.vaultResolveLocks.delete(lockKey);
      }
    }
  }

  async retain(canonicalUserId: string, input: MemoryRetainInput): Promise<MemoryRetainResult> {
    const apiKey = this.resolveApiKey();
    if (!this.config.enabled || !apiKey) {
      return {
        ok: false,
        status: "error",
        errorMessage: `MemoryEcho 未启用或缺少密钥环境变量 ${this.config.apiKeyEnv}`,
      };
    }

    const text = input.content.trim();
    if (!text) {
      return { ok: false, status: "error", errorMessage: "写入内容不能为空" };
    }

    let vaultId: string | null = null;
    try {
      vaultId = await this.resolveVaultId(canonicalUserId, input.bank, {
        createIfMissing: this.config.autoCreateVaults,
      });
    } catch (err) {
      if (err instanceof MemoryEchoBillingError) {
        return {
          ok: false,
          status: "denied",
          errorCode: err.errorCode,
          errorMessage: err.message,
        };
      }
      return {
        ok: false,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    if (!vaultId) {
      return {
        ok: false,
        status: "error",
        errorMessage: `未找到或未配置 MemoryEcho ${input.bank} 记忆库（Vault）`,
      };
    }

    const path =
      input.role === "assistant"
        ? "/api/v1/memory/append-assistant-message"
        : "/api/v1/memory/append-user-message";

    const res = await this.requestJson<{
      status?: unknown;
      memory_id?: unknown;
      pipeline?: unknown;
    }>(path, {
      method: "POST",
      body: { library_id: vaultId, message: text },
      apiKey,
    });

    if (res.statusCode === 402) {
      const errorCode = readString(res.data?.error_code) ?? "BILLING_DENIED";
      const errMsg = readString(res.data?.error) ?? `MemoryEcho 配额受限 (${errorCode})`;
      const externalMemoryId = readString(res.data?.memory_id) ?? undefined;
      logWarn("MEMORY", `MemoryEcho retain denied (${errorCode}): ${errMsg}`);
      return {
        ok: false,
        vaultId,
        externalMemoryId,
        status: "denied",
        errorCode,
        errorMessage: errMsg,
      };
    }

    if (!res.ok) {
      logWarn("MEMORY", `MemoryEcho retain failed (HTTP ${res.statusCode}): ${res.errorMessage}`);
      return {
        ok: false,
        vaultId,
        status: "error",
        errorMessage: res.errorMessage ?? `HTTP ${res.statusCode}`,
      };
    }

    const externalMemoryId = readString(res.data?.memory_id) ?? undefined;
    const pipeline = readString(res.data?.pipeline) ?? "ok";
    if (pipeline === "degraded") {
      logWarn(
        "MEMORY",
        `MemoryEcho retain returned pipeline=degraded (bank=${input.bank}, memory_id=${externalMemoryId ?? "-"})`,
      );
      return {
        ok: false,
        vaultId,
        externalMemoryId,
        status: "degraded",
        errorMessage: "记忆引擎暂时降级，消息未进入语义管线",
      };
    }

    return {
      ok: true,
      vaultId,
      externalMemoryId,
      status: "synced",
    };
  }

  async recall(
    canonicalUserId: string,
    params: { bank: MemorySyncBank; query: string; limit?: number },
  ): Promise<MemoryRecallResult> {
    const apiKey = this.resolveApiKey();
    if (!this.config.enabled || !apiKey) {
      return {
        ok: false,
        bank: params.bank,
        items: [],
        degraded: false,
        errorMessage: `MemoryEcho 未启用或缺少密钥 ${this.config.apiKeyEnv}`,
      };
    }

    const query = params.query.trim();
    if (!query) {
      return { ok: true, bank: params.bank, items: [], degraded: false };
    }

    const vaultId = await this.resolveVaultId(canonicalUserId, params.bank, {
      createIfMissing: false,
    });
    if (!vaultId) {
      return { ok: true, bank: params.bank, items: [], degraded: false };
    }

    const res = await this.requestJson<{
      results?: unknown;
      messages?: unknown;
      degraded?: unknown;
    }>("/api/v1/memory/query-readonly", {
      method: "POST",
      body: { library_id: vaultId, message: query },
      apiKey,
    });

    if (res.statusCode === 402) {
      const errorCode = readString(res.data?.error_code) ?? "BILLING_DENIED";
      const errMsg = readString(res.data?.error) ?? `MemoryEcho 查询配额受限 (${errorCode})`;
      logWarn("MEMORY", `MemoryEcho recall denied (${errorCode}): ${errMsg}`);
      return {
        ok: false,
        bank: params.bank,
        items: [],
        degraded: false,
        errorCode,
        errorMessage: errMsg,
      };
    }

    if (!res.ok) {
      logWarn("MEMORY", `MemoryEcho recall failed (HTTP ${res.statusCode}): ${res.errorMessage}`);
      return {
        ok: false,
        bank: params.bank,
        items: [],
        degraded: true,
        errorMessage: res.errorMessage ?? `HTTP ${res.statusCode}`,
      };
    }

    const limit = Math.max(1, Math.min(20, params.limit ?? 6));
    const degraded = res.data?.degraded === true;
    const items = normalizeRecallEntries(res.data?.results, params.bank, query).slice(0, limit);
    const fallbackMessages = normalizeRecallEntries(res.data?.messages, params.bank, query).slice(0, limit);

    return {
      ok: true,
      bank: params.bank,
      items,
      degraded,
      ...(fallbackMessages.length > 0 ? { fallbackMessages } : {}),
    };
  }

  async erase(
    canonicalUserId: string,
    params: { bank: MemorySyncBank; memoryIds: string[] },
  ): Promise<MemoryEraseResult> {
    const cleanIds = [...new Set(params.memoryIds.map((id) => id.trim()).filter(Boolean))];
    if (cleanIds.length === 0) {
      return {
        ok: true,
        erased: [],
        alreadyErased: [],
        missing: [],
        unmapped: [],
        derivedCleanupFailed: false,
      };
    }

    const apiKey = this.resolveApiKey();
    if (!this.config.enabled || !apiKey) {
      return {
        ok: false,
        erased: [],
        alreadyErased: [],
        missing: [],
        unmapped: [],
        derivedCleanupFailed: false,
        errorMessage: `MemoryEcho 未启用或缺少密钥 ${this.config.apiKeyEnv}`,
      };
    }

    const vaultId = await this.resolveVaultId(canonicalUserId, params.bank, {
      createIfMissing: false,
    });
    if (!vaultId) {
      return {
        ok: false,
        erased: [],
        alreadyErased: [],
        missing: cleanIds,
        unmapped: [],
        derivedCleanupFailed: false,
        errorMessage: `未找到 ${params.bank} 记忆库（Vault）`,
      };
    }

    const agg: MemoryEraseResult = {
      ok: true,
      erased: [],
      alreadyErased: [],
      missing: [],
      unmapped: [],
      derivedCleanupFailed: false,
    };

    for (let i = 0; i < cleanIds.length; i += MAX_ERASE_BATCH) {
      const chunk = cleanIds.slice(i, i + MAX_ERASE_BATCH);
      const res = await this.requestJson<{
        erased?: unknown;
        already_erased?: unknown;
        missing?: unknown;
        unmapped?: unknown;
        derived_cleanup_failed?: unknown;
      }>(`/api/v1/memory/vaults/${encodeURIComponent(vaultId)}/messages/erase`, {
        method: "POST",
        body: { memory_ids: chunk },
        apiKey,
      });

      if (!res.ok) {
        return {
          ...agg,
          ok: false,
          errorMessage: res.errorMessage ?? `HTTP ${res.statusCode}`,
        };
      }

      agg.erased.push(...readStringArray(res.data?.erased));
      agg.alreadyErased.push(...readStringArray(res.data?.already_erased));
      agg.missing.push(...readStringArray(res.data?.missing));
      agg.unmapped.push(...readStringArray(res.data?.unmapped));
      if (res.data?.derived_cleanup_failed === true) {
        agg.derivedCleanupFailed = true;
      }
    }

    return agg;
  }

  async listVaults(): Promise<MemoryVaultInfo[]> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) return [];

    const res = await this.requestJson<RawVaultPayload[]>("/api/v1/memory/vaults", {
      method: "GET",
      apiKey,
    });
    if (!res.ok || !Array.isArray(res.data)) {
      throw new Error(res.errorMessage ?? `列出记忆库失败 (HTTP ${res.statusCode})`);
    }
    return res.data.map(normalizeVault).filter((v): v is MemoryVaultInfo => v !== null);
  }

  async getUsage(): Promise<MemoryUsageSummary | null> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) return null;

    const res = await this.requestJson<{
      vault_count?: unknown;
      period?: { kind?: unknown; start?: unknown; end?: unknown };
      units_per_credit?: unknown;
      memory_create?: { units?: unknown; user_paid_units?: unknown; count?: unknown };
      memory_query?: { units?: unknown; user_paid_units?: unknown; count?: unknown };
    }>("/api/v1/memory/usage", {
      method: "GET",
      apiKey,
    });

    if (!res.ok || !res.data) return null;
    const unitsPerCredit = Math.max(1, Number(res.data.units_per_credit ?? 100_000_000));
    const createUnits = Number(res.data.memory_create?.units ?? 0);
    const queryUnits = Number(res.data.memory_query?.units ?? 0);
    const userPaidUnits =
      Number(res.data.memory_create?.user_paid_units ?? 0) +
      Number(res.data.memory_query?.user_paid_units ?? 0);

    return {
      vaultCount: Number(res.data.vault_count ?? 0),
      periodKind: readString(res.data.period?.kind) ?? "calendar_month",
      periodStart: readString(res.data.period?.start) ?? "",
      periodEnd: readString(res.data.period?.end) ?? "",
      unitsPerCredit,
      createCredits: createUnits / unitsPerCredit,
      createCount: Number(res.data.memory_create?.count ?? 0),
      queryCredits: queryUnits / unitsPerCredit,
      queryCount: Number(res.data.memory_query?.count ?? 0),
      userPaidCredits: userPaidUnits / unitsPerCredit,
    };
  }

  private async discoverOrCreateVault(
    canonicalUserId: string,
    bank: MemorySyncBank,
    settingKey: string,
    createIfMissing: boolean,
  ): Promise<string | null> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) return null;

    const targetName = canonicalVaultName(canonicalUserId, bank);
    const existingListRes = await this.requestJson<RawVaultPayload[]>("/api/v1/memory/vaults", {
      method: "GET",
      apiKey,
    });

    if (existingListRes.ok && Array.isArray(existingListRes.data)) {
      const matched = existingListRes.data
        .map(normalizeVault)
        .find((v) => v && v.name === targetName);
      if (matched) {
        this.repo.setRuntimeSetting(settingKey, {
          vaultId: matched.id,
          name: matched.name,
          updatedAt: Date.now(),
        });
        return matched.id;
      }
    }

    if (!createIfMissing) {
      return null;
    }

    const description =
      bank === "persona"
        ? `Hato persona companion memory vault for ${canonicalUserId}`
        : `Hato technical environment memory vault for ${canonicalUserId}`;

    const createRes = await this.requestJson<RawVaultPayload>("/api/v1/memory/vaults", {
      method: "POST",
      body: {
        name: targetName,
        description,
        vault_type: "normal",
      },
      apiKey,
    });

    if (createRes.statusCode === 402) {
      const code = readString(createRes.data?.error_code) ?? "BILLING_DENIED";
      const msg = readString(createRes.data?.error) ?? `创建 MemoryEcho Vault 被拒 (${code})`;
      throw new MemoryEchoBillingError(code, msg);
    }

    if (!createRes.ok) {
      throw new Error(createRes.errorMessage ?? `创建记忆库失败 (HTTP ${createRes.statusCode})`);
    }

    const created = normalizeVault(createRes.data);
    if (!created) {
      throw new Error("MemoryEcho 创建记忆库响应缺少 id");
    }

    this.repo.setRuntimeSetting(settingKey, {
      vaultId: created.id,
      name: created.name,
      updatedAt: Date.now(),
    });
    logInfo("MEMORY", `created MemoryEcho vault "${created.name}" (${created.id}) for ${bank}`);
    return created.id;
  }

  private resolveApiKey(): string | undefined {
    const override = this.apiKeyOverride?.trim();
    if (override) return override;
    return getOptionalSecret(this.config.apiKeyEnv);
  }

  private async requestJson<T>(
    path: string,
    opts: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; apiKey: string },
  ): Promise<{
    ok: boolean;
    statusCode: number;
    data: (T & MemoryEchoErrorPayload) | null;
    errorMessage?: string;
  }> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const response = await this.proxyRouter.runWithScope(MEMORYECHO_PROXY_SCOPE, () =>
        this.proxyRouter.scopedFetch(
          url,
          {
            method: opts.method,
            headers,
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
            signal: AbortSignal.timeout(this.config.timeoutMs),
          },
          MEMORYECHO_PROXY_SCOPE,
        ),
      );

      const rawText = await response.text();
      let parsed: (T & MemoryEchoErrorPayload) | null = null;
      if (rawText.trim()) {
        try {
          parsed = JSON.parse(rawText) as T & MemoryEchoErrorPayload;
        } catch {
          parsed = null;
        }
      }

      if (!response.ok) {
        const errDetail =
          readString(parsed?.error) ??
          readString((parsed?.detail as { message?: unknown } | undefined)?.message) ??
          (rawText.trim().slice(0, 240) || `HTTP ${response.status}`);
        return {
          ok: false,
          statusCode: response.status,
          data: parsed,
          errorMessage: errDetail,
        };
      }

      return {
        ok: true,
        statusCode: response.status,
        data: parsed,
      };
    } catch (err) {
      return {
        ok: false,
        statusCode: 0,
        data: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

class MemoryEchoBillingError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

function vaultSettingKey(canonicalUserId: string, bank: MemorySyncBank): string {
  return `memoryecho_vault:${canonicalUserId}:${bank}`;
}

function canonicalVaultName(canonicalUserId: string, bank: MemorySyncBank): string {
  const safeUser = canonicalUserId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `hato-${safeUser}-${bank}`;
}

function normalizeVault(raw: RawVaultPayload | null | undefined): MemoryVaultInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const id = readString(raw.id);
  const name = readString(raw.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    description: readString(raw.description),
    vaultType: readString(raw.vault_type) ?? "normal",
    memoryCount: Number(raw.memory_count ?? 0),
    storageBytes: Number(raw.storage_bytes ?? 0),
    createdAt: readString(raw.created_at) ?? "",
    updatedAt: readString(raw.updated_at) ?? "",
  };
}

export function normalizeRecallEntries(
  raw: unknown,
  bank: MemorySyncBank,
  query?: string,
): MemoryRecallItem[] {
  if (!Array.isArray(raw)) return [];
  const items: MemoryRecallItem[] = [];
  const normalizedQuery = query?.trim() ?? "";

  for (const entry of raw) {
    if (typeof entry === "string") {
      const content = entry.trim();
      if (!content || isSyntheticRecallWrapper(content, normalizedQuery)) continue;
      items.push({
        id: shortContentHash(content),
        bank,
        content,
      });
      continue;
    }

    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;

    const nestedMsg =
      rec.message && typeof rec.message === "object"
        ? (rec.message as Record<string, unknown>)
        : null;

    const rawContent =
      extractTextContent(rec.content) ??
      readString(rec.text) ??
      readString(rec.memory) ??
      readString(rec.summary) ??
      readString(rec.fact) ??
      (nestedMsg ? extractTextContent(nestedMsg.content) : null) ??
      "";

    const content = sanitizeRecallContent(rawContent);
    if (!content || isSyntheticRecallWrapper(content, normalizedQuery)) continue;

    const id =
      readString(rec.id) ??
      readString(rec.memory_id) ??
      readString(rec.source_id) ??
      (nestedMsg ? readString(nestedMsg.id) : null) ??
      shortContentHash(content);

    items.push({
      id,
      bank,
      content,
      role: readString(rec.role) ?? (nestedMsg ? readString(nestedMsg.role) : null) ?? undefined,
      score: typeof rec.score === "number" ? rec.score : undefined,
      createdAt:
        readString(rec.created_at) ??
        readString(rec.timestamp) ??
        (nestedMsg ? readString(nestedMsg.iso_time) : null) ??
        undefined,
      metadata:
        rec.metadata && typeof rec.metadata === "object"
          ? (rec.metadata as Record<string, unknown>)
          : null,
    });
  }

  return items;
}

function extractTextContent(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const block of raw) {
      if (typeof block === "string") {
        if (block.trim()) parts.push(block.trim());
        continue;
      }
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const text = readString(b.text) ?? readString(b.content);
      if (text) parts.push(text);
    }
    const joined = parts.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function sanitizeRecallContent(content: string): string {
  return content
    .replace(
      /^请你把以下信息在回答用户的消息后附加到本轮你输出的结尾[:：]\s*/u,
      "近期提醒线索:\n",
    )
    .trim();
}

function isSyntheticRecallWrapper(content: string, normalizedQuery: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (normalizedQuery && trimmed === normalizedQuery) return true;
  if (
    trimmed.includes("以上为Prompt与用户记忆和提示有关内容") &&
    trimmed.includes("以下为用户本轮消息")
  ) {
    return true;
  }
  // Header-only empty blocks emitted by litemem (e.g. "与用户对话的长期记忆:\n")
  if (/^(?:与用户对话的长期记忆|与用户近期的对话记忆|用户的长期指令)\s*[:：]\s*$/u.test(trimmed)) {
    return true;
  }
  return false;
}

function shortContentHash(text: string): string {
  return `rec_${createHash("sha256").update(text).digest("hex").slice(0, 10)}`;
}

function readString(val: unknown): string | null {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
}

function readStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}
