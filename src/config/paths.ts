import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HatoConfigPaths {
  homeDir: string;
  hatoConfigPath: string;
  modelsConfigPath: string;
  mcpConfigPath: string;
  envPath: string;
}

/**
 * Resolve the user's Hato home directory (defaults to `~/.hato`, overridable via `HATO_HOME`).
 */
export function resolveHatoHomeDir(): string {
  const override = process.env.HATO_HOME?.trim();
  if (override) {
    return resolve(override.startsWith("~") ? join(homedir(), override.slice(1)) : override);
  }
  return join(homedir(), ".hato");
}

/**
 * Resolve the default `.env` path, preferring `~/.hato/.env` when present and falling back to `.env`.
 */
export function resolveDefaultEnvPath(): string {
  const homeEnv = join(resolveHatoHomeDir(), ".env");
  if (existsSync(homeEnv)) return homeEnv;
  return ".env";
}

/**
 * Ensure `~/.hato/` exists and return resolved config/env paths.
 */
export function ensureHatoHomeConfig(): HatoConfigPaths {
  const homeDir = resolveHatoHomeDir();
  mkdirSync(homeDir, { recursive: true });

  return {
    homeDir,
    hatoConfigPath: join(homeDir, "hato.toml"),
    modelsConfigPath: join(homeDir, "models.toml"),
    mcpConfigPath: join(homeDir, "mcp.toml"),
    envPath: join(homeDir, ".env"),
  };
}
