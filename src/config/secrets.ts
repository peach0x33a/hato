import dotenv from "dotenv";
import { resolveDefaultEnvPath } from "./paths.js";

let envLoaded = false;

/**
 * Load .env into process.env once. Only secrets (API keys / bot tokens) should live in .env.
 */
export function loadSecretEnv(envPath = resolveDefaultEnvPath()): void {
  if (envLoaded) return;
  dotenv.config({ path: envPath, quiet: true });
  envLoaded = true;
}

/**
 * Force-reload .env into process.env (used by /reload after secret edits).
 */
export function reloadSecretEnv(envPath = resolveDefaultEnvPath()): void {
  dotenv.config({ path: envPath, override: true, quiet: true });
  envLoaded = true;
}

/**
 * Resolve a required secret from an environment variable name referenced in TOML config.
 */
export function requireSecret(envName: string, contextLabel: string): string {
  loadSecretEnv();
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(`Missing required secret environment variable "${envName}" for ${contextLabel}`);
  }
  return value;
}

/**
 * Resolve an optional secret from an environment variable name; returns undefined when unset.
 */
export function getOptionalSecret(envName: string | undefined): string | undefined {
  if (!envName) return undefined;
  loadSecretEnv();
  const value = process.env[envName]?.trim();
  return value && value.length > 0 ? value : undefined;
}
