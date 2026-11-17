import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { HatoRepository } from "../db/repo.js";
import { loadHatoConfig, validateHatoConfigObject, type HatoConfig } from "./app.js";
import { validateModelsConfigObject, type ModelsFileConfig } from "./models.js";

const DEFAULT_HATO_TOML_HEADER = [
  "# ==========================================",
  "# Hato 系统与运行时配置文件（由配置向导 / 运行时管理）",
  "# 仅 API Key / Bot Token 存放在 .env；其余运行参数统一在此维护，支持 /reload 热重载。",
  "# ==========================================",
].join("\n");

const DEFAULT_MODELS_TOML_HEADER = [
  "# ==========================================",
  "# Hato 全协议动态模型配置（由配置向导管理）",
  "# Provider API Key 默认按 <UPPER_SNAKE(slug)>_API_KEY 从 .env 自动读取。",
  "# ==========================================",
].join("\n");

/**
 * Parse a .env file into key -> value pairs; returns {} when missing.
 */
export function readEnvMap(envPath = ".env"): Record<string, string> {
  const absPath = resolve(envPath);
  if (!existsSync(absPath)) {
    return {};
  }
  const raw = readFileSync(absPath, "utf8");
  return dotenv.parse(raw);
}

/**
 * Safely merge non-undefined entries into a .env file while preserving existing comments,
 * blank lines, and untouched keys. Values set to undefined are left unchanged.
 */
export function mergeEnvFile(
  envPath: string,
  updates: Record<string, string | undefined>,
): { path: string; writtenKeys: string[] } {
  const absPath = resolve(envPath);
  mkdirSync(dirname(absPath), { recursive: true });

  const entriesToWrite = new Map<string, string>();
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const trimmedKey = key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
      throw new Error(`Invalid environment variable name "${key}"`);
    }
    entriesToWrite.set(trimmedKey, value);
  }

  const existingRaw = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
  const lines = existingRaw ? existingRaw.split(/\r?\n/) : ["# Hato 敏感凭据（仅存放 API Key 与 Bot Token）"];
  const handled = new Set<string>();
  const writtenKeys: string[] = [];

  const nextLines = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1]!;
    if (!entriesToWrite.has(key)) return line;
    handled.add(key);
    writtenKeys.push(key);
    return `${key}=${formatEnvValue(entriesToWrite.get(key)!)}`;
  });

  // Remove trailing empty line before appending new keys, then ensure single trailing newline.
  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "" && entriesToWrite.size > handled.size) {
    nextLines.pop();
  }

  for (const [key, value] of entriesToWrite) {
    if (handled.has(key)) continue;
    writtenKeys.push(key);
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  const content = `${nextLines.join("\n").replace(/\n+$/, "")}\n`;
  writeFileSync(absPath, content, "utf8");
  return { path: absPath, writtenKeys };
}

/**
 * Validate and persist config/hato.toml, creating a .bak backup before replacing an existing file.
 */
export function writeHatoConfig(
  configPath: string,
  config: HatoConfig,
  options?: { backup?: boolean; headerComment?: string },
): { path: string; backupPath?: string } {
  const cleanConfig = stripUndefined(config) as HatoConfig;
  validateHatoConfigObject(cleanConfig, configPath);
  const serialized = serializeValidatedToml(
    cleanConfig,
    options?.headerComment ?? DEFAULT_HATO_TOML_HEADER,
    (parsed) => validateHatoConfigObject(parsed, configPath),
  );
  return writeTomlFileWithBackup(configPath, serialized, options?.backup ?? true);
}

/**
 * Validate and persist config/models.toml, creating a .bak backup before replacing an existing file.
 */
export function writeModelsConfig(
  configPath: string,
  config: ModelsFileConfig,
  options?: { backup?: boolean; headerComment?: string },
): { path: string; backupPath?: string } {
  const cleanConfig = stripUndefined(config) as ModelsFileConfig;
  validateModelsConfigObject(cleanConfig, configPath);
  const serialized = serializeValidatedToml(
    cleanConfig,
    options?.headerComment ?? DEFAULT_MODELS_TOML_HEADER,
    (parsed) => validateModelsConfigObject(parsed, configPath),
  );
  return writeTomlFileWithBackup(configPath, serialized, options?.backup ?? true);
}

/**
 * Bind a Telegram private DM as the owner's Home Channel (Hermes-style /sethome):
 * - Ensures tgUserId is present in owner.channels.tg.user_ids
 * - Sets owner.proactive_channel = "tg"
 * - Updates config/hato.toml (with .bak backup when present) and SQLite owner/home state
 */
export function bindTelegramHomeChannel(params: {
  hatoConfigPath: string;
  repo: HatoRepository;
  canonicalUserId: string;
  tgUserId: string;
  currentConfig: HatoConfig;
}): {
  updatedConfig: HatoConfig;
  addedToWhitelist: boolean;
  savedToConfig: boolean;
  backupPath?: string;
} {
  const absConfigPath = resolve(params.hatoConfigPath);
  const baseConfig = existsSync(absConfigPath) ? loadHatoConfig(absConfigPath) : params.currentConfig;

  const existingIds = baseConfig.owner.channels.tg.user_ids;
  const alreadyAllowed = existingIds.some((id) => String(id) === params.tgUserId);
  const parsedNumeric = /^\d+$/.test(params.tgUserId) ? Number(params.tgUserId) : params.tgUserId;
  const nextUserIds = alreadyAllowed
    ? [...existingIds]
    : [...existingIds, Number.isSafeInteger(parsedNumeric) ? parsedNumeric : params.tgUserId];

  const updatedConfig: HatoConfig = {
    ...baseConfig,
    owner: {
      ...baseConfig.owner,
      proactive_channel: "tg",
      channels: {
        ...baseConfig.owner.channels,
        tg: {
          ...baseConfig.owner.channels.tg,
          user_ids: nextUserIds,
        },
      },
    },
  };

  let savedToConfig = false;
  let backupPath: string | undefined;
  if (existsSync(absConfigPath)) {
    const written = writeHatoConfig(absConfigPath, updatedConfig, { backup: true });
    savedToConfig = true;
    backupPath = written.backupPath;
  }

  params.repo.setHomeChannel({
    canonicalUserId: params.canonicalUserId,
    channel: "tg",
    targetId: params.tgUserId,
  });

  return {
    updatedConfig,
    addedToWhitelist: !alreadyAllowed,
    savedToConfig,
    backupPath,
  };
}

/**
 * Bind QQ private chat as Hato's Home Channel:
 * - Ensures qqOpenId is present in owner.channels.qq.open_ids
 * - Sets owner.proactive_channel = "qq"
 * - Updates config/hato.toml (with .bak backup when present) and SQLite owner/home state
 */
export function bindQqHomeChannel(params: {
  hatoConfigPath: string;
  repo: HatoRepository;
  canonicalUserId: string;
  qqOpenId: string;
  currentConfig: HatoConfig;
}): {
  updatedConfig: HatoConfig;
  addedToWhitelist: boolean;
  savedToConfig: boolean;
  backupPath?: string;
} {
  const absConfigPath = resolve(params.hatoConfigPath);
  const baseConfig = existsSync(absConfigPath) ? loadHatoConfig(absConfigPath) : params.currentConfig;

  const existingIds = baseConfig.owner.channels.qq.open_ids;
  const alreadyAllowed = existingIds.includes(params.qqOpenId);
  const nextOpenIds = alreadyAllowed ? [...existingIds] : [...existingIds, params.qqOpenId];

  const updatedConfig: HatoConfig = {
    ...baseConfig,
    owner: {
      ...baseConfig.owner,
      proactive_channel: "qq",
      channels: {
        ...baseConfig.owner.channels,
        qq: {
          ...baseConfig.owner.channels.qq,
          open_ids: nextOpenIds,
        },
      },
    },
  };

  let savedToConfig = false;
  let backupPath: string | undefined;
  if (existsSync(absConfigPath)) {
    const written = writeHatoConfig(absConfigPath, updatedConfig, { backup: true });
    savedToConfig = true;
    backupPath = written.backupPath;
  }

  params.repo.setHomeChannel({
    canonicalUserId: params.canonicalUserId,
    channel: "qq",
    targetId: params.qqOpenId,
  });

  return {
    updatedConfig,
    addedToWhitelist: !alreadyAllowed,
    savedToConfig,
    backupPath,
  };
}

function writeTomlFileWithBackup(
  configPath: string,
  tomlContent: string,
  backup: boolean,
): { path: string; backupPath?: string } {
  const absPath = resolve(configPath);
  mkdirSync(dirname(absPath), { recursive: true });

  let backupPath: string | undefined;
  if (backup && existsSync(absPath)) {
    backupPath = `${absPath}.bak`;
    copyFileSync(absPath, backupPath);
  }

  writeFileSync(absPath, tomlContent, "utf8");
  return { path: absPath, backupPath };
}

function serializeValidatedToml(
  data: Record<string, unknown>,
  headerComment: string,
  validate: (parsed: unknown) => unknown,
): string {
  const body = stringifyToml(data);
  const full = headerComment ? `${headerComment}\n\n${body}` : body;
  validate(parseToml(full));
  return full;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => stripUndefined(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

function formatEnvValue(raw: string): string {
  if (raw === "") return "";
  if (/[\s#"'\n\r]/.test(raw)) {
    return JSON.stringify(raw);
  }
  return raw;
}
