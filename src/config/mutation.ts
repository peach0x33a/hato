import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadHatoConfig, type HatoConfig } from "./app.js";
import { reloadSecretEnv } from "./secrets.js";
import { writeHatoConfig } from "./store.js";

export interface ConfigMutationServiceDeps<TReload = unknown> {
  hatoConfigPath: string;
  envPath?: string;
  getFallbackConfig?: () => HatoConfig;
  onReload: () => Promise<TReload>;
}

/**
 * Serializes all runtime configuration / secret mutations and reloads so upper layers
 * (`persona`, `web-console`) never race on `hato.toml` writes or `.env` reloads.
 */
export class ConfigMutationService<TReload = unknown> {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ConfigMutationServiceDeps<TReload>) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async writeHatoConfigAndReload(
    config: HatoConfig,
    opts?: { backup?: boolean },
  ): Promise<{ path: string; backupPath?: string; reload: TReload }> {
    return this.enqueue(async () => {
      const writeRes = writeHatoConfig(this.deps.hatoConfigPath, config, {
        backup: opts?.backup ?? true,
      });
      const reload = await this.deps.onReload();
      return { ...writeRes, reload };
    });
  }

  async patchHatoConfigAndReload(
    patcher: (base: HatoConfig) => HatoConfig,
    opts?: { backup?: boolean },
  ): Promise<{ path: string; backupPath?: string; config: HatoConfig; reload: TReload }> {
    return this.enqueue(async () => {
      const absPath = resolve(this.deps.hatoConfigPath);
      const base = existsSync(absPath)
        ? loadHatoConfig(this.deps.hatoConfigPath)
        : this.deps.getFallbackConfig
          ? this.deps.getFallbackConfig()
          : loadHatoConfig(this.deps.hatoConfigPath);
      const next = patcher(base);
      const writeRes = writeHatoConfig(this.deps.hatoConfigPath, next, {
        backup: opts?.backup ?? true,
      });
      const reload = await this.deps.onReload();
      return { ...writeRes, config: next, reload };
    });
  }

  async reloadSecretsAndRuntime(deletedKeys?: string[]): Promise<TReload> {
    return this.enqueue(async () => {
      reloadSecretEnv(this.deps.envPath ?? ".env", deletedKeys);
      return this.deps.onReload();
    });
  }

  async reloadRuntime(): Promise<TReload> {
    return this.enqueue(() => this.deps.onReload());
  }

  async runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    return this.enqueue(async () => await task());
  }
}
