import { createHash } from "node:crypto";
import type { HatoConfig, ProxyRuleConfig } from "./app.js";

export interface ReloadSlotSnapshot {
  slot: string;
  target: string;
  api: string;
  baseUrl: string;
  reasoning?: boolean;
  thinkingLevel?: string;
  input?: readonly string[];
}

export interface ReloadSnapshot {
  hatoConfig: HatoConfig;
  slots: readonly ReloadSlotSnapshot[];
  availableTargets: readonly string[];
  promptText?: string;
  secretFingerprints?: Readonly<Record<string, string>>;
}

/**
 * Computes a short non-reversible fingerprint for a secret value so /reload
 * can report secret updates without ever exposing raw key material.
 */
export function fingerprintSecret(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}

/**
 * Diffs two runtime configuration snapshots and returns human-readable change lines.
 */
export function collectReloadDiff(prev: ReloadSnapshot, next: ReloadSnapshot): string[] {
  const changes: string[] = [];

  diffSlots(prev.slots, next.slots, changes);
  diffAvailableTargets(prev.availableTargets, next.availableTargets, changes);
  diffProxies(prev.hatoConfig.network?.proxies ?? [], next.hatoConfig.network?.proxies ?? [], changes);
  diffConfigTree(
    stripNetworkSection(prev.hatoConfig),
    stripNetworkSection(next.hatoConfig),
    "",
    changes,
  );

  if (prev.promptText !== undefined && next.promptText !== undefined && prev.promptText !== next.promptText) {
    changes.push(`人设提示词: 已更新（${prev.promptText.length} -> ${next.promptText.length} 字符）`);
  }

  if (prev.secretFingerprints && next.secretFingerprints) {
    diffSecrets(prev.secretFingerprints, next.secretFingerprints, changes);
  }

  return changes;
}

function diffSlots(
  prevSlots: readonly ReloadSlotSnapshot[],
  nextSlots: readonly ReloadSlotSnapshot[],
  out: string[],
): void {
  const prevBySlot = new Map(prevSlots.map((s) => [s.slot, s]));
  for (const nextSlot of nextSlots) {
    const prevSlot = prevBySlot.get(nextSlot.slot);
    if (!prevSlot) {
      out.push(`槽位 ${nextSlot.slot}: 新增 -> ${nextSlot.target} (${nextSlot.api})`);
      continue;
    }

    const prevSig = formatSlotSignature(prevSlot);
    const nextSig = formatSlotSignature(nextSlot);
    if (prevSig !== nextSig) {
      out.push(`槽位 ${nextSlot.slot}: ${prevSig} -> ${nextSig}`);
    }
  }
}

function formatSlotSignature(slot: ReloadSlotSnapshot): string {
  const flags: string[] = [slot.api];
  if (slot.reasoning !== undefined) flags.push(`reasoning=${slot.reasoning}`);
  if (slot.thinkingLevel !== undefined) flags.push(`thinking=${slot.thinkingLevel}`);
  if (slot.input && slot.input.length > 0) flags.push(`input=[${slot.input.join(",")}]`);
  return `${slot.target} (${flags.join(", ")}, ${slot.baseUrl})`;
}

function diffAvailableTargets(
  prevTargets: readonly string[],
  nextTargets: readonly string[],
  out: string[],
): void {
  const prevSet = new Set(prevTargets);
  const nextSet = new Set(nextTargets);
  const added = nextTargets.filter((t) => !prevSet.has(t));
  const removed = prevTargets.filter((t) => !nextSet.has(t));
  if (added.length > 0) {
    out.push(`新增模型: ${added.join(", ")}`);
  }
  if (removed.length > 0) {
    out.push(`移除模型: ${removed.join(", ")}`);
  }
}

function diffProxies(
  prevProxies: readonly ProxyRuleConfig[],
  nextProxies: readonly ProxyRuleConfig[],
  out: string[],
): void {
  const prevFormatted = prevProxies.map(formatProxyRule);
  const nextFormatted = nextProxies.map(formatProxyRule);
  if (JSON.stringify(prevFormatted) === JSON.stringify(nextFormatted)) return;

  const prevLabel = prevFormatted.length > 0 ? prevFormatted.join("; ") : "(全部直连)";
  const nextLabel = nextFormatted.length > 0 ? nextFormatted.join("; ") : "(全部直连)";
  out.push(`network.proxies: ${prevLabel} -> ${nextLabel}`);
}

function formatProxyRule(rule: ProxyRuleConfig): string {
  let safeUrl = rule.url;
  try {
    const parsed = new URL(rule.url);
    if (parsed.password) {
      parsed.password = "***";
      safeUrl = parsed.toString();
    }
  } catch {
    safeUrl = rule.url;
  }
  return `${rule.name} (${safeUrl} -> [${rule.scope.join(", ")}])`;
}

function stripNetworkSection(config: HatoConfig): Record<string, unknown> {
  const { network: _network, ...rest } = config;
  return rest;
}

function diffConfigTree(prev: unknown, next: unknown, path: string, out: string[]): void {
  if (Object.is(prev, next)) return;

  if (Array.isArray(prev) && Array.isArray(next)) {
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      out.push(`${path}: ${formatLeafValue(prev)} -> ${formatLeafValue(next)}`);
    }
    return;
  }

  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const key of [...keys].sort()) {
      const childPath = path ? `${path}.${key}` : key;
      diffConfigTree(prev[key], next[key], childPath, out);
    }
    return;
  }

  if (prev === undefined && isPlainObject(next)) {
    for (const key of Object.keys(next).sort()) {
      const childPath = path ? `${path}.${key}` : key;
      diffConfigTree(undefined, next[key], childPath, out);
    }
    return;
  }

  if (isPlainObject(prev) && next === undefined) {
    for (const key of Object.keys(prev).sort()) {
      const childPath = path ? `${path}.${key}` : key;
      diffConfigTree(prev[key], undefined, childPath, out);
    }
    return;
  }

  out.push(`${path}: ${formatLeafValue(prev)} -> ${formatLeafValue(next)}`);
}

function diffSecrets(
  prev: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
  out: string[],
): void {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of [...keys].sort()) {
    const p = prev[key] ?? "";
    const n = next[key] ?? "";
    if (p === n) continue;
    if (!p && n) {
      out.push(`密钥 ${key}: 未设置 -> 已配置`);
    } else if (p && !n) {
      out.push(`密钥 ${key}: 已配置 -> 已清空`);
    } else {
      out.push(`密钥 ${key}: 已更新（已隐藏原值）`);
    }
  }
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function formatLeafValue(val: unknown): string {
  if (val === undefined) return "(未设置)";
  return JSON.stringify(val);
}
