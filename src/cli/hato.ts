#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logError } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(): string {
  return [
    `hato v${readVersion()} - Personal companion & delegated task agent`,
    "",
    "用法:",
    "  hato [start]           启动 Hato 服务（Telegram 网关 + Web Console）",
    "  hato setup [选项]      运行交互式配置向导",
    "  hato statics [选项]    查看运行与 Token 用量统计（别名: stats）",
    "  hato -v, --version     显示版本号",
    "  hato -h, --help        显示帮助信息",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "start";
  const rest = args.slice(1);

  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(printHelp());
    return;
  }

  if (cmd === "-v" || cmd === "--version" || cmd === "version") {
    console.log(`hato v${readVersion()}`);
    return;
  }

  process.chdir(PACKAGE_ROOT);

  if (cmd === "start") {
    await import("../main.js");
    return;
  }

  if (cmd === "setup") {
    const { runSetupWizard } = await import("../setup/wizard.js");
    await runSetupWizard(rest);
    return;
  }

  if (cmd === "statics" || cmd === "stats") {
    const { runStaticsCli } = await import("./statics.js");
    console.log(runStaticsCli(rest));
    return;
  }

  logError("CLI", `未知子命令: ${cmd}`);
  console.error("");
  console.error(printHelp());
  process.exit(1);
}

main().catch((err) => {
  logError("CLI", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
