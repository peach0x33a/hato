#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logError } from "../utils/logger.js";
import {
  checkForUpdates,
  getCachedUpdateStatus,
  readCurrentHatoVersion,
  type ReleaseChannel,
} from "../utils/update-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");

function readVersion(): string {
  return readCurrentHatoVersion(PACKAGE_ROOT);
}

function printHelp(): string {
  return [
    `hato v${readVersion()} - Personal companion & delegated task agent`,
    "",
    "用法:",
    "  hato [start]           启动 Hato 服务（Telegram 网关 + Web Console）",
    "  hato setup [子命令]    运行交互式配置向导（quick 简易模式 / full 全量模式 / provider / slots / proxy / check）",
    "  hato statics [选项]    查看运行与 Token 用量统计（别名: stats）",
    "  hato check-update      检查 GitHub Release 新版本（可选: --channel stable|nightly）",
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
    const version = readVersion();
    console.log(`hato v${version}`);
    const cached = getCachedUpdateStatus({ packageRoot: PACKAGE_ROOT });
    if (cached?.hasUpdate && cached.latestTag) {
      console.log(`发现新版本 ${cached.latestTag} (${cached.channel}): ${cached.releaseUrl}`);
    }
    return;
  }

  if (cmd === "check-update" || cmd === "update-check") {
    const chanIdx = rest.indexOf("--channel");
    const rawChan = chanIdx >= 0 ? rest[chanIdx + 1] : undefined;
    const channel: ReleaseChannel | undefined =
      rawChan === "nightly" || rawChan === "stable" ? rawChan : undefined;
    const res = await checkForUpdates({
      packageRoot: PACKAGE_ROOT,
      channel,
      force: true,
    });
    console.log(`当前版本: v${res.currentVersion} (渠道: ${res.channel})`);
    if (res.error) {
      console.log(`检查更新失败: ${res.error}`);
      return;
    }
    if (res.hasUpdate && res.latestTag) {
      console.log(`发现新版本: ${res.latestTag}`);
      console.log(`发布地址: ${res.releaseUrl}`);
      if (res.notesPreview) {
        console.log(`更新摘要:\n${res.notesPreview}`);
      }
      console.log(
        `升级命令: bash <(curl -fsSL https://raw.githubusercontent.com/peach0x33a/hato/main/scripts/install.sh) --version ${res.latestTag}`,
      );
    } else {
      console.log(`已是最新版本（${res.latestTag ?? `v${res.currentVersion}`}）。`);
    }
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
