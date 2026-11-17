import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadHatoConfig,
  resolveMemoryCuratorConfig,
  resolveMemoryEchoConfig,
  resolveMemoryProvider,
  resolveMemoryRecallConfig,
  resolvePromptDisabled,
  resolvePromptOrder,
  resolveTavilySearchConfig,
  resolveWebBrowserConfig,
  resolveWebFetchConfig,
  type HatoConfig,
} from "../config/app.js";
import type { ModelRegistry } from "../config/models.js";
import { writeHatoConfig } from "../config/store.js";
import type { HatoRepository } from "../db/repo.js";
import { logInfo } from "../utils/logger.js";
import {
  deletePromptBlock,
  loadLayeredPrompts,
  upsertPromptBlock,
  writeFileWithBackup,
} from "./prompts.js";

/**
 * Explicit allowlist of dot-separated config paths Hato may safely self-edit in `hato.toml`.
 * Security-sensitive paths (paths.*, owner.channels.*, *_env, base_url, network.proxies,
 * worker.*, web.console.*) are intentionally excluded.
 */
const ALLOWED_SELF_CONFIG_PATHS = new Set<string>([
  "prompts.order",
  "prompts.disabled",
  "owner.timezone",
  "owner.proactive_channel",
  "owner.quiet_hours.start",
  "owner.quiet_hours.end",
  "gateway.debounce_ms",
  "gateway.bubbles.enabled",
  "gateway.bubbles.max_per_turn",
  "gateway.bubbles.delay_ms_range",
  "gateway.bubbles.delimiter",
  "gateway.retry.max_retries",
  "gateway.retry.initial_delay_ms",
  "gateway.retry.backoff_multiplier",
  "gateway.retry.max_delay_ms",
  "gateway.retry.jitter",
  "context.hot_messages_high_watermark",
  "context.hot_messages_keep_after_compact",
  "context.min_messages_to_compact",
  "context.pre_compact_after_minutes",
  "context.idle_commit_after_minutes",
  "context.gap_marker_threshold_minutes",
  "context.lookback.max_step_count",
  "context.lookback.max_total_messages",
  "context.lookback.max_hours",
  "memory.provider",
  "memory.recall.mode",
  "memory.recall.max_results",
  "memory.recall.min_query_chars",
  "memory.curator.enabled",
  "memory.curator.idle_retain_after_minutes",
  "memory.curator.batch_message_threshold",
  "memory.curator.max_batch_messages",
  "memory.memoryecho.enabled",
  "memory.memoryecho.timeout_ms",
  "memory.memoryecho.auto_create_vaults",
  "memory.open_loops.defer_after_chat_minutes",
  "memory.open_loops.max_unanswered_streak",
  "web.search.enabled",
  "web.search.max_results",
  "web.search.search_depth",
  "web.fetch.enabled",
  "web.fetch.timeout_ms",
  "web.fetch.max_chars",
  "web.browser.enabled",
  "web.browser.max_steps",
  "web.browser.action_timeout_ms",
  "web.browser.idle_timeout_minutes",
  "web.browser.model_slot",
]);

export interface SelfConfigDeps {
  hatoConfigPath: string;
  getHatoConfig: () => HatoConfig;
  getModelRegistry: () => ModelRegistry;
  repo: HatoRepository;
  onReloadRuntime: () => Promise<void>;
}

export type SelfConfigAction =
  | "inspect"
  | "patch_hato"
  | "set_model_slot"
  | "edit_soul"
  | "upsert_prompt_block"
  | "delete_prompt_block"
  | "set_relationship_fact"
  | "delete_relationship_fact";

export interface SelfConfigInput {
  action: SelfConfigAction;
  config_patch?: Record<string, unknown>;
  slot?: string;
  target?: string;
  content?: string;
  append_note?: string;
  block_name?: string;
  fact_key?: string;
  fact_value?: string;
}

export interface SelfConfigOutput {
  ok: boolean;
  summary: string;
  details: Record<string, unknown>;
}

/**
 * Execute a schema-validated, allowlist-guarded self-configuration inspection or edit.
 */
export async function runSelfConfigAction(
  deps: SelfConfigDeps,
  input: SelfConfigInput,
): Promise<SelfConfigOutput> {
  const cfg = deps.getHatoConfig();
  const registry = deps.getModelRegistry();

  if (input.action === "inspect") {
    const prompts = loadLayeredPrompts(
      cfg.paths.prompts_dir,
      resolvePromptOrder(cfg),
      resolvePromptDisabled(cfg),
    );
    const snapshot = {
      tunable_hato_config: buildSanitizedTunableSnapshot(cfg),
      editable_config_paths: [...ALLOWED_SELF_CONFIG_PATHS].sort(),
      model_slots: registry.listSlots().map((s) => ({
        slot: s.slot,
        target: s.target,
        api: String(s.model.api),
      })),
      available_models: registry.listTargets(),
      prompts: {
        mode: prompts.mode,
        order: prompts.order,
        disabled: prompts.disabled,
        blocks: prompts.blocks.map((b) => ({ name: b.name, chars: b.content.length, content: b.content })),
        system_chars: prompts.systemText.length,
        soul_path: prompts.soulPath,
        soul: prompts.soulText,
      },
      relationship_facts: deps.repo.listRelationshipFacts(),
    };

    return {
      ok: true,
      summary: JSON.stringify(snapshot, null, 2),
      details: snapshot,
    };
  }

  if (input.action === "patch_hato") {
    if (!input.config_patch || typeof input.config_patch !== "object" || Array.isArray(input.config_patch)) {
      return {
        ok: false,
        summary: "patch_hato 必须提供对象格式的 config_patch。",
        details: { ok: false },
      };
    }

    const leafPaths = collectPatchLeafPaths(input.config_patch);
    if (leafPaths.length === 0) {
      return {
        ok: false,
        summary: "config_patch 为空，未执行任何修改。",
        details: { ok: false },
      };
    }

    const disallowed = leafPaths.filter((p) => !ALLOWED_SELF_CONFIG_PATHS.has(p));
    if (disallowed.length > 0) {
      return {
        ok: false,
        summary: `拒绝修改受保护配置路径: ${disallowed.join(", ")}。仅允许调整白名单内的运行参数（可通过 action="inspect" 查看可改路径）。`,
        details: { ok: false, disallowed },
      };
    }

    const baseCfg = existsSync(resolve(deps.hatoConfigPath))
      ? loadHatoConfig(deps.hatoConfigPath)
      : cfg;
    const merged = deepMergeAllowedConfig(baseCfg, input.config_patch) as HatoConfig;
    const writeRes = writeHatoConfig(deps.hatoConfigPath, merged, { backup: true });
    await deps.onReloadRuntime();

    logInfo("SELF_CONFIG", `patched hato.toml (${leafPaths.join(", ")}) -> ${writeRes.path}`);
    return {
      ok: true,
      summary: `已更新并热重载配置项: ${leafPaths.join(", ")}（原配置已备份）。`,
      details: { ok: true, updatedPaths: leafPaths, backupPath: writeRes.backupPath },
    };
  }

  if (input.action === "set_model_slot") {
    const slot = input.slot?.trim() ?? "";
    const target = input.target?.trim() ?? "";
    if (!slot || !target) {
      return {
        ok: false,
        summary: "set_model_slot 需要同时提供 slot 与 target（格式: <provider>/<model_id>）。",
        details: { ok: false },
      };
    }
    const updated = registry.setSlotOverride(slot, target);
    logInfo("SELF_CONFIG", `switched model slot ${updated.slot} -> ${updated.target}`);
    return {
      ok: true,
      summary: `已热切换槽位 ${updated.slot} -> ${updated.target} (${String(updated.model.api)})。`,
      details: { ok: true, slot: updated.slot, target: updated.target },
    };
  }

  if (input.action === "edit_soul") {
    const layered = loadLayeredPrompts(
      cfg.paths.prompts_dir,
      resolvePromptOrder(cfg),
      resolvePromptDisabled(cfg),
    );
    const targetPath = resolve(cfg.paths.prompts_dir, "soul.md");

    let nextContent: string;
    if (typeof input.content === "string" && input.content.trim().length > 0) {
      nextContent = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
    } else if (typeof input.append_note === "string" && input.append_note.trim().length > 0) {
      const note = input.append_note.trim();
      const base = layered.soulText.trim();
      nextContent = base ? `${base}\n- ${note}\n` : `- ${note}\n`;
    } else {
      return {
        ok: false,
        summary: "edit_soul 需要提供 content（完整替换）或 append_note（追加一条设定）。",
        details: { ok: false },
      };
    }

    const writeRes = writeFileWithBackup(targetPath, nextContent);
    await deps.onReloadRuntime();
    logInfo("SELF_CONFIG", `updated soul.md (${nextContent.length} chars)`);
    return {
      ok: true,
      summary: `已更新人设 soul.md（${nextContent.length} 字符，原文件已备份）并立即生效。`,
      details: { ok: true, path: writeRes.path, backupPath: writeRes.backupPath },
    };
  }

  if (input.action === "upsert_prompt_block") {
    const blockName = input.block_name?.trim() ?? "";
    const content = input.content?.trim() ?? "";
    if (!blockName || !content) {
      return {
        ok: false,
        summary: "upsert_prompt_block 需要提供 block_name 与非空 content。",
        details: { ok: false },
      };
    }

    const res = upsertPromptBlock(cfg.paths.prompts_dir, blockName, content);
    await deps.onReloadRuntime();
    logInfo("SELF_CONFIG", `upserted prompt block blocks/${res.name} (${content.length} chars)`);
    return {
      ok: true,
      summary: `已写入提示词块 blocks/${res.name} 并立即生效。`,
      details: { ok: true, ...res },
    };
  }

  if (input.action === "delete_prompt_block") {
    const blockName = input.block_name?.trim() ?? "";
    if (!blockName) {
      return {
        ok: false,
        summary: "delete_prompt_block 需要提供 block_name。",
        details: { ok: false },
      };
    }

    const res = deletePromptBlock(cfg.paths.prompts_dir, blockName);
    if (!res.deleted) {
      return {
        ok: false,
        summary: `提示词块 blocks/${res.name} 不存在。`,
        details: { ok: false, ...res },
      };
    }
    await deps.onReloadRuntime();
    logInfo("SELF_CONFIG", `deleted prompt block blocks/${res.name}`);
    return {
      ok: true,
      summary: `已删除提示词块 blocks/${res.name}（原文件已备份为 .bak）并热重载。`,
      details: { ok: true, ...res },
    };
  }

  if (input.action === "set_relationship_fact") {
    const key = input.fact_key?.trim() ?? "";
    const value = input.fact_value?.trim() ?? "";
    if (!key || !value) {
      return {
        ok: false,
        summary: "set_relationship_fact 需要提供 fact_key 与 fact_value。",
        details: { ok: false },
      };
    }
    deps.repo.upsertRelationshipFact(key, value);
    await deps.onReloadRuntime();
    logInfo("SELF_CONFIG", `upserted relationship fact "${key}"`);
    return {
      ok: true,
      summary: `已写入固定关系约定 "${key}: ${value}" 并热重载。`,
      details: { ok: true, key, value },
    };
  }

  if (input.action === "delete_relationship_fact") {
    const key = input.fact_key?.trim() ?? "";
    if (!key) {
      return {
        ok: false,
        summary: "delete_relationship_fact 需要提供 fact_key。",
        details: { ok: false },
      };
    }
    const deleted = deps.repo.deleteRelationshipFact(key);
    if (!deleted) {
      return {
        ok: false,
        summary: `未找到固定关系约定 "${key}"。`,
        details: { ok: false, key },
      };
    }
    await deps.onReloadRuntime();
    logInfo("SELF_CONFIG", `deleted relationship fact "${key}"`);
    return {
      ok: true,
      summary: `已移除固定关系约定 "${key}" 并热重载。`,
      details: { ok: true, key },
    };
  }

  return {
    ok: false,
    summary: `未知 self_config 动作: ${String(input.action)}`,
    details: { ok: false },
  };
}

function buildSanitizedTunableSnapshot(cfg: HatoConfig): Record<string, unknown> {
  const me = resolveMemoryEchoConfig(cfg);
  const recall = resolveMemoryRecallConfig(cfg);
  const curator = resolveMemoryCuratorConfig(cfg);
  const search = resolveTavilySearchConfig(cfg);
  const fetchCfg = resolveWebFetchConfig(cfg);
  const browser = resolveWebBrowserConfig(cfg);

  return {
    prompts: {
      order: resolvePromptOrder(cfg),
      disabled: resolvePromptDisabled(cfg),
    },
    owner: {
      timezone: cfg.owner.timezone,
      proactive_channel: cfg.owner.proactive_channel,
      quiet_hours: cfg.owner.quiet_hours,
    },
    gateway: {
      debounce_ms: cfg.gateway.debounce_ms,
      bubbles: cfg.gateway.bubbles,
      retry: cfg.gateway.retry,
    },
    context: cfg.context,
    memory: {
      provider: resolveMemoryProvider(cfg),
      recall: {
        mode: recall.mode,
        max_results: recall.maxResults,
        min_query_chars: recall.minQueryChars,
      },
      curator: {
        enabled: curator.enabled,
        idle_retain_after_minutes: curator.idleRetainAfterMinutes,
        batch_message_threshold: curator.batchMessageThreshold,
        max_batch_messages: curator.maxBatchMessages,
      },
      memoryecho: {
        enabled: me.enabled,
        timeout_ms: me.timeoutMs,
        auto_create_vaults: me.autoCreateVaults,
      },
      open_loops: cfg.memory.open_loops,
    },
    web: {
      search: {
        enabled: search.enabled,
        max_results: search.maxResults,
        search_depth: search.searchDepth,
      },
      fetch: {
        enabled: fetchCfg.enabled,
        timeout_ms: fetchCfg.timeoutMs,
        max_chars: fetchCfg.maxChars,
      },
      browser: {
        enabled: browser.enabled,
        max_steps: browser.maxSteps,
        action_timeout_ms: browser.actionTimeoutMs,
        idle_timeout_minutes: browser.idleTimeoutMinutes,
        model_slot: browser.modelSlot,
      },
    },
  };
}

function collectPatchLeafPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (isPlainRecord(val)) {
      paths.push(...collectPatchLeafPaths(val, fullPath));
    } else {
      paths.push(fullPath);
    }
  }
  return paths;
}

function deepMergeAllowedConfig(base: unknown, patch: unknown): unknown {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) {
    return patch;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(patch)) {
    if (isPlainRecord(val) && isPlainRecord(out[key])) {
      out[key] = deepMergeAllowedConfig(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}
