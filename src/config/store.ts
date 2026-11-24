import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import dotenv from "dotenv";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { HatoRepository } from "../db/repo.js";
import type { HomeChannelPlatform, ProactiveChannelOption } from "../gateway/types.js";
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

export const FORBIDDEN_SECRET_ENV_NAMES = new Set<string>([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HATO_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

export function isForbiddenSecretEnvName(name: string): boolean {
  return FORBIDDEN_SECRET_ENV_NAMES.has(name.trim().toUpperCase());
}

/**
 * Safely merge non-undefined entries into a .env file while preserving existing comments,
 * blank lines, and untouched keys. Values set to undefined are left unchanged; values set
 * to null are deleted from the .env file.
 */
export function mergeEnvFile(
  envPath: string,
  updates: Record<string, string | null | undefined>,
): { path: string; writtenKeys: string[]; deletedKeys: string[] } {
  const absPath = resolve(envPath);
  mkdirSync(dirname(absPath), { recursive: true });

  const entriesToWrite = new Map<string, string>();
  const keysToDelete = new Set<string>();
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const trimmedKey = key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
      throw new Error(`Invalid environment variable name "${key}"`);
    }
    if (isForbiddenSecretEnvName(trimmedKey)) {
      throw new Error(`Forbidden environment variable name "${trimmedKey}"`);
    }
    if (value === null) {
      keysToDelete.add(trimmedKey);
      entriesToWrite.delete(trimmedKey);
    } else {
      entriesToWrite.set(trimmedKey, value);
      keysToDelete.delete(trimmedKey);
    }
  }

  const existingRaw = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
  const lines = existingRaw ? existingRaw.split(/\r?\n/) : ["# Hato 敏感凭据（仅存放 API Key 与 Bot Token）"];
  const handled = new Set<string>();
  const writtenKeys: string[] = [];

  const nextLines: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) {
      nextLines.push(line);
      continue;
    }
    const key = match[1]!;
    if (keysToDelete.has(key)) {
      handled.add(key);
      continue;
    }
    if (!entriesToWrite.has(key)) {
      nextLines.push(line);
      continue;
    }
    handled.add(key);
    writtenKeys.push(key);
    nextLines.push(`${key}=${formatEnvValue(entriesToWrite.get(key)!)}`);
  }

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
  writeFileAtomic(absPath, content, { mode: 0o600 });
  try {
    chmodSync(absPath, 0o600);
  } catch {
    // Windows or restricted FS may ignore chmod
  }
  return { path: absPath, writtenKeys, deletedKeys: Array.from(keysToDelete) };
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
 * Bind a Telegram private DM as Telegram's Home Channel (Hermes-style per-platform /sethome):
 * - Ensures tgUserId is present in owner.channels.tg.user_ids
 * - Updates config/hato.toml (with .bak backup when present) and SQLite per-platform home state
 * - Does NOT overwrite owner.proactive_channel
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
    defaultProactiveChannel: updatedConfig.owner.proactive_channel,
  });

  return {
    updatedConfig,
    addedToWhitelist: !alreadyAllowed,
    savedToConfig,
    backupPath,
  };
}

/**
 * Bind QQ private chat as QQ's Home Channel (per-platform):
 * - Ensures qqOpenId is present in owner.channels.qq.open_ids
 * - Updates config/hato.toml (with .bak backup when present) and SQLite per-platform home state
 * - Does NOT overwrite owner.proactive_channel
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
    defaultProactiveChannel: updatedConfig.owner.proactive_channel,
  });

  return {
    updatedConfig,
    addedToWhitelist: !alreadyAllowed,
    savedToConfig,
    backupPath,
  };
}

/**
 * Update the global default proactive push channel (`owner.proactive_channel`)
 * independently from per-platform Home Channel bindings.
 */
export function updateProactiveChannel(params: {
  hatoConfigPath: string;
  repo: HatoRepository;
  canonicalUserId: string;
  proactiveChannel: ProactiveChannelOption;
  currentConfig: HatoConfig;
}): {
  updatedConfig: HatoConfig;
  savedToConfig: boolean;
  backupPath?: string;
} {
  const absConfigPath = resolve(params.hatoConfigPath);
  const baseConfig = existsSync(absConfigPath) ? loadHatoConfig(absConfigPath) : params.currentConfig;

  const updatedConfig: HatoConfig = {
    ...baseConfig,
    owner: {
      ...baseConfig.owner,
      proactive_channel: params.proactiveChannel,
    },
  };

  let savedToConfig = false;
  let backupPath: string | undefined;
  if (existsSync(absConfigPath)) {
    const written = writeHatoConfig(absConfigPath, updatedConfig, { backup: true });
    savedToConfig = true;
    backupPath = written.backupPath;
  }

  params.repo.setProactiveChannel(params.canonicalUserId, params.proactiveChannel);

  return {
    updatedConfig,
    savedToConfig,
    backupPath,
  };
}

export interface PlatformHomeBinding {
  bound: boolean;
  channel: HomeChannelPlatform;
  targetId: string | null;
  source: "runtime" | "config" | null;
}

export interface HomeChannelsState {
  tg: PlatformHomeBinding;
  qq: PlatformHomeBinding;
  proactiveChannel: ProactiveChannelOption;
}

/**
 * Determine whether a specific platform's Home Channel is currently bound
 * (either explicitly recorded in SQLite or configured via `hato.toml` owner whitelist,
 * unless explicitly unbound via Web Console).
 */
export function resolvePlatformHomeBinding(
  channel: HomeChannelPlatform,
  config: HatoConfig,
  repo: HatoRepository,
): PlatformHomeBinding {
  const runtimeHome = repo.getHomeChannel(channel);
  if (runtimeHome && runtimeHome.channel === channel && runtimeHome.targetId) {
    return {
      bound: true,
      channel,
      targetId: runtimeHome.targetId,
      source: "runtime",
    };
  }
  if (repo.isHomeExplicitlyUnbound(channel)) {
    return { bound: false, channel, targetId: null, source: null };
  }

  if (channel === "tg") {
    const firstTg = config.owner.channels.tg.user_ids[0];
    if (firstTg !== undefined) {
      return { bound: true, channel: "tg", targetId: String(firstTg), source: "config" };
    }
    return { bound: false, channel: "tg", targetId: null, source: null };
  }

  const firstQq = config.owner.channels.qq.open_ids[0];
  if (firstQq) {
    return { bound: true, channel: "qq", targetId: String(firstQq), source: "config" };
  }
  return { bound: false, channel: "qq", targetId: null, source: null };
}

export function resolveAllHomeBindings(
  config: HatoConfig,
  repo: HatoRepository,
): HomeChannelsState {
  return {
    tg: resolvePlatformHomeBinding("tg", config, repo),
    qq: resolvePlatformHomeBinding("qq", config, repo),
    proactiveChannel: config.owner.proactive_channel,
  };
}

/**
 * Unbind a single platform's Home Channel from Web Console so a subsequent `/sethome` on that
 * platform can take effect without affecting other platforms.
 * Optionally clears that platform's owner whitelist in `hato.toml` to allow pairing a new account.
 */
export function unbindHomeChannel(params: {
  channel: HomeChannelPlatform;
  hatoConfigPath: string;
  repo: HatoRepository;
  canonicalUserId: string;
  currentConfig: HatoConfig;
  clearChannelWhitelist?: boolean;
}): {
  previousHome: PlatformHomeBinding;
  updatedConfig: HatoConfig;
  clearedWhitelist: boolean;
  savedToConfig: boolean;
  backupPath?: string;
} {
  const previousHome = resolvePlatformHomeBinding(params.channel, params.currentConfig, params.repo);
  const absConfigPath = resolve(params.hatoConfigPath);
  const baseConfig = existsSync(absConfigPath) ? loadHatoConfig(absConfigPath) : params.currentConfig;

  let updatedConfig: HatoConfig = baseConfig;
  let clearedWhitelist = false;
  let savedToConfig = false;
  let backupPath: string | undefined;

  const shouldClearWhitelist = Boolean(params.clearChannelWhitelist);
  if (shouldClearWhitelist && params.channel === "tg") {
    updatedConfig = {
      ...baseConfig,
      owner: {
        ...baseConfig.owner,
        channels: {
          ...baseConfig.owner.channels,
          tg: { ...baseConfig.owner.channels.tg, user_ids: [] },
        },
      },
    };
    clearedWhitelist = true;
  } else if (shouldClearWhitelist && params.channel === "qq") {
    updatedConfig = {
      ...baseConfig,
      owner: {
        ...baseConfig.owner,
        channels: {
          ...baseConfig.owner.channels,
          qq: { ...baseConfig.owner.channels.qq, open_ids: [] },
        },
      },
    };
    clearedWhitelist = true;
  }

  if (clearedWhitelist && existsSync(absConfigPath)) {
    const written = writeHatoConfig(absConfigPath, updatedConfig, { backup: true });
    savedToConfig = true;
    backupPath = written.backupPath;
  }

  params.repo.clearHomeChannel({
    channel: params.channel,
    canonicalUserId: params.canonicalUserId,
    clearWhitelist: clearedWhitelist,
  });

  return {
    previousHome,
    updatedConfig,
    clearedWhitelist,
    savedToConfig,
    backupPath,
  };
}

function writeFileAtomic(absPath: string, content: string, options?: { mode?: number }): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, content, {
    encoding: "utf8",
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
  renameSync(tmpPath, absPath);
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

  writeFileAtomic(absPath, tomlContent);
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
