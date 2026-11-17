import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
 * Ensure `~/.hato/` exists and migrate any legacy `config/*.toml` and `.env` files into it
 * when the target file does not yet exist.
 */
export function ensureHatoHomeConfig(): HatoConfigPaths {
  const homeDir = resolveHatoHomeDir();
  mkdirSync(homeDir, { recursive: true });

  const hatoConfigPath = join(homeDir, "hato.toml");
  const modelsConfigPath = join(homeDir, "models.toml");
  const mcpConfigPath = join(homeDir, "mcp.toml");
  const envPath = join(homeDir, ".env");

  const migrations: Array<[string, string]> = [
    ["config/hato.toml", hatoConfigPath],
    ["config/models.toml", modelsConfigPath],
    ["config/mcp.toml", mcpConfigPath],
    [".env", envPath],
  ];

  for (const [legacyRel, targetAbs] of migrations) {
    const legacyAbs = resolve(legacyRel);
    if (!existsSync(targetAbs) && existsSync(legacyAbs)) {
      copyFileSync(legacyAbs, targetAbs);
    }
  }

  return {
    homeDir,
    hatoConfigPath,
    modelsConfigPath,
    mcpConfigPath,
    envPath,
  };
}
