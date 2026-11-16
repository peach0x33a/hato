import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadHatoConfig } from "../config/app.js";
import { openDatabase } from "../db/client.js";
import { HatoRepository } from "../db/repo.js";
import { parseSinceSpec, renderStaticsReport, summarizeTurnTraces } from "../stats/metrics.js";
import { logError } from "../utils/logger.js";

const DEFAULT_HATO_CONFIG_PATH = "config/hato.toml";
const DEFAULT_SQLITE_PATH = "./data/hato.db";

function printHelp(): string {
  return [
    "用法: npm run statics [-- 选项]",
    "",
    "选项:",
    "  -n, --limit <数量>       显示最近 N 轮（默认 20；传 0 或 all 查看全部）",
    "      --user <id>          按 canonical_user_id 筛选",
    "      --slot <slot>        按角色槽位筛选（例如 persona / router / worker）",
    "      --provider <slug>    按 Provider Slug 筛选",
    "      --model <id>         按模型 ID 筛选",
    "      --since <时间>       只看最近一段时间（如 30m, 2h, 7d 或 2026-11-16）",
    "      --db <路径>          指定 SQLite 路径（默认读取 config/hato.toml -> ./data/hato.db）",
    "      --json               以 JSON 格式输出汇总与明细",
    "  -h, --help               显示帮助",
  ].join("\n");
}

function resolveDefaultSqlitePath(): string {
  if (existsSync(resolve(DEFAULT_HATO_CONFIG_PATH))) {
    try {
      return loadHatoConfig(DEFAULT_HATO_CONFIG_PATH).paths.sqlite;
    } catch {
      // Fall back cleanly if hato.toml isn't valid yet.
    }
  }
  return DEFAULT_SQLITE_PATH;
}

export function runStaticsCli(argv: string[] = process.argv.slice(2)): string {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit: { type: "string", short: "n", default: "20" },
      user: { type: "string" },
      slot: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      since: { type: "string" },
      db: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    return printHelp();
  }

  const limitRaw = (values.limit ?? "20").trim().toLowerCase();
  let limit: number | undefined;
  if (limitRaw !== "0" && limitRaw !== "all") {
    const parsedLimit = Number(limitRaw);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 0) {
      throw new Error(`Invalid --limit value "${values.limit}". Expected positive integer, 0, or "all".`);
    }
    limit = parsedLimit;
  }

  const sinceMs = values.since ? parseSinceSpec(values.since) : undefined;
  const dbPathRaw = values.db ?? resolveDefaultSqlitePath();
  const isMemory = dbPathRaw === ":memory:";
  const dbPath = isMemory ? dbPathRaw : resolve(dbPathRaw);

  if (!isMemory && !existsSync(dbPath)) {
    throw new Error(`SQLite database not found at ${dbPath}. Start Hato first or pass --db <path>.`);
  }

  const handle = openDatabase(dbPath);
  try {
    const repo = new HatoRepository(handle.db);
    const rows = repo.listTurnTraces({
      canonicalUserId: values.user,
      slot: values.slot,
      provider: values.provider,
      modelId: values.model,
      sinceMs,
      limit,
    });

    if (values.json) {
      return JSON.stringify(
        {
          dbPath,
          summary: summarizeTurnTraces(rows),
          traces: rows,
        },
        null,
        2,
      );
    }

    const filterParts: string[] = [];
    if (values.user) filterParts.push(`user=${values.user}`);
    if (values.slot) filterParts.push(`slot=${values.slot}`);
    if (values.provider) filterParts.push(`provider=${values.provider}`);
    if (values.model) filterParts.push(`model=${values.model}`);
    if (values.since) filterParts.push(`since=${values.since}`);
    if (limit !== undefined) filterParts.push(`limit=${limit}`);

    return renderStaticsReport(rows, {
      dbPath,
      filtersLabel: filterParts.join(", "),
    });
  } finally {
    handle.close();
  }
}

const isEntrypoint =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntrypoint) {
  try {
    console.log(runStaticsCli(process.argv.slice(2)));
  } catch (err) {
    logError("STATICS", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
