import type { MemorySyncBank, MemorySyncStatus } from "../db/repo.js";

export type MemoryRetainRole = "user" | "assistant";

export interface MemoryRetainInput {
  bank: MemorySyncBank;
  role: MemoryRetainRole;
  content: string;
}

export interface MemoryRetainResult {
  ok: boolean;
  vaultId?: string;
  externalMemoryId?: string;
  status: Exclude<MemorySyncStatus, "erased">;
  errorCode?: string;
  errorMessage?: string;
}

export interface MemoryRecallItem {
  id: string;
  bank: MemorySyncBank;
  content: string;
  role?: string;
  score?: number;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryRecallResult {
  ok: boolean;
  bank: MemorySyncBank;
  items: MemoryRecallItem[];
  degraded: boolean;
  fallbackMessages?: MemoryRecallItem[];
  errorCode?: string;
  errorMessage?: string;
}

export interface MemoryEraseResult {
  ok: boolean;
  erased: string[];
  alreadyErased: string[];
  missing: string[];
  unmapped: string[];
  derivedCleanupFailed: boolean;
  errorMessage?: string;
}

export interface MemoryVaultInfo {
  id: string;
  name: string;
  description: string | null;
  vaultType: string;
  memoryCount: number;
  storageBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryUsageSummary {
  vaultCount: number;
  periodKind: string;
  periodStart: string;
  periodEnd: string;
  unitsPerCredit: number;
  createCredits: number;
  createCount: number;
  queryCredits: number;
  queryCount: number;
  userPaidCredits: number;
}

export interface MemoryStore {
  readonly providerName: string;
  isConfigured(): boolean;
  resolveVaultId(
    canonicalUserId: string,
    bank: MemorySyncBank,
    opts?: { createIfMissing?: boolean },
  ): Promise<string | null>;
  retain(canonicalUserId: string, input: MemoryRetainInput): Promise<MemoryRetainResult>;
  recall(
    canonicalUserId: string,
    params: { bank: MemorySyncBank; query: string; limit?: number },
  ): Promise<MemoryRecallResult>;
  erase(
    canonicalUserId: string,
    params: { bank: MemorySyncBank; memoryIds: string[] },
  ): Promise<MemoryEraseResult>;
  listVaults?(): Promise<MemoryVaultInfo[]>;
  getUsage?(): Promise<MemoryUsageSummary | null>;
}

const PHATIC_ONLY_RE =
  /^(?:嗯+|哦+|啊+|哈+|嘿+|唔+|噢+|好(?:的|呀|啊|嘛|吧)?|行(?:吧|啊)?|可以|收到|明白|知道(?:了|啦)?|了解|谢谢(?:你|啦)?|多谢|不客气|早(?:安|上好)?|晚安|拜拜|再见|ok|okay|yes|no|yep|nope|thx|thanks|lol|haha+|👍+|👌+|❤️+|😂+|😊+|😭+|🙏+|[?？!！。.~～、,，\s]+)$/i;

/**
 * Lightweight gate for automatic pre-turn memory recall so short phatic acks
 * do not waste quota or add latency.
 */
export function shouldAutoRecall(text: string, minQueryChars: number): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (cleaned.startsWith("/")) return false;
  if (cleaned.length < Math.max(1, minQueryChars)) return false;
  if (PHATIC_ONLY_RE.test(cleaned)) return false;
  return true;
}

/**
 * Format recalled memory items deterministically for Layer 4 ephemeral tail injection.
 */
export function formatRecalledMemoriesBlock(items: readonly MemoryRecallItem[]): string {
  if (items.length === 0) return "";
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const lines = sorted.map((item) => {
    const stamp = item.createdAt ? ` (${item.createdAt.slice(0, 10)})` : "";
    const cleanedLines = item.content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (cleanedLines.length <= 1) {
      return `- [${item.bank}:${item.id}${stamp}] ${cleanedLines[0] ?? ""}`;
    }
    return `- [${item.bank}:${item.id}${stamp}]\n  ${cleanedLines.join("\n  ")}`;
  });
  return `<recalled_memories>\n${lines.join("\n")}\n</recalled_memories>`;
}
