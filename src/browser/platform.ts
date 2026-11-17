import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { ResolvedWebBrowserConfig } from "../config/app.js";
import type { ProxyResolution } from "../config/proxy.js";
import { logWarn } from "../utils/logger.js";

export interface PlaywrightProxyOption {
  server: string;
  username?: string;
  password?: string;
}

export interface BrowserLaunchCandidate {
  label: string;
  channel?: string;
  executablePath?: string;
}

export interface XvfbSession {
  display: string;
  dispose: () => Promise<void>;
}

/**
 * Converts Hato's resolved ScopedProxyRouter entry into Playwright's proxy launch option.
 */
export function parsePlaywrightProxy(resolution: ProxyResolution): PlaywrightProxyOption | undefined {
  if (resolution.mode !== "proxy") return undefined;
  try {
    const parsed = new URL(resolution.url);
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    const server = `${parsed.protocol}//${parsed.host}`;
    return {
      server,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch {
    return { server: resolution.url };
  }
}

/**
 * Builds ordered browser executable/channel candidates across macOS, Windows, and Linux.
 */
export function resolveBrowserLaunchCandidates(params: {
  config: Pick<ResolvedWebBrowserConfig, "channel" | "executablePath">;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsFn?: (filePath: string) => boolean;
  findCommandFn?: (cmd: string) => string | null;
}): BrowserLaunchCandidate[] {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  const existsFn = params.existsFn ?? existsSync;
  const findCommandFn = params.findCommandFn ?? findExecutableInPath;

  const candidates: BrowserLaunchCandidate[] = [];
  const seenKeys = new Set<string>();
  const pushCandidate = (cand: BrowserLaunchCandidate) => {
    const key = cand.executablePath ? `exe:${cand.executablePath}` : `chan:${cand.channel ?? ""}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      candidates.push(cand);
    }
  };

  if (params.config.executablePath?.trim()) {
    const custom = params.config.executablePath.trim();
    pushCandidate({ label: `custom:${custom}`, executablePath: custom });
  }

  const configuredChannel = params.config.channel.trim() || "chrome";

  if (platform === "win32") {
    pushCandidate({ label: `channel:${configuredChannel}`, channel: configuredChannel });

    const programFiles = env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localAppData = env.LOCALAPPDATA ?? "";

    const winChromePaths = [
      win32.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      win32.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      ...(localAppData ? [win32.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")] : []),
    ];
    for (const p of winChromePaths) {
      if (existsFn(p)) {
        pushCandidate({ label: `exe:${p}`, executablePath: p });
      }
    }
    return candidates;
  }

  if (platform === "darwin") {
    pushCandidate({ label: `channel:${configuredChannel}`, channel: configuredChannel });
    const macPaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const p of macPaths) {
      if (existsFn(p)) {
        pushCandidate({ label: `exe:${p}`, executablePath: p });
      }
    }
    return candidates;
  }

  // Linux / VPS
  pushCandidate({ label: `channel:${configuredChannel}`, channel: configuredChannel });
  for (const binName of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const resolvedBin = findCommandFn(binName);
    if (resolvedBin) {
      pushCandidate({ label: `bin:${resolvedBin}`, executablePath: resolvedBin });
    }
  }
  return candidates;
}

/**
 * Resolves headed/headless mode and display environment across macOS, Windows, and headless Linux VPS (Xvfb).
 */
export async function prepareDisplayAndHeadless(params: {
  config: Pick<ResolvedWebBrowserConfig, "headless" | "xvfb" | "display">;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  headless: boolean;
  displayEnv?: string;
  xvfbSession?: XvfbSession;
}> {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;

  if (params.config.headless === true) {
    return { headless: true };
  }

  // macOS and Windows natively render headed browser windows without needing X11/Xvfb.
  if (platform === "darwin" || platform === "win32") {
    return { headless: false };
  }

  // Linux: prefer explicit display config or existing X11/Wayland session.
  if (params.config.display?.trim()) {
    return { headless: false, displayEnv: params.config.display.trim() };
  }
  if (env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim()) {
    return { headless: false, displayEnv: env.DISPLAY?.trim() };
  }

  // Headless Linux VPS without DISPLAY: start virtual Xvfb when enabled & installed.
  if (params.config.xvfb !== false) {
    const xvfbBin = findExecutableInPath("Xvfb");
    if (xvfbBin) {
      const xvfbSession = await startXvfbSession(xvfbBin);
      return {
        headless: false,
        displayEnv: xvfbSession.display,
        xvfbSession,
      };
    }
  }

  if (params.config.headless === false) {
    throw new Error(
      "Linux 无图形界面（DISPLAY 为空）且未检测到 Xvfb；请安装 xvfb（如 apt install xvfb）或将 web.browser.headless 设为 \"auto\"。",
    );
  }

  logWarn("BROWSER", "Linux DISPLAY 与 Xvfb 均不可用，web.browser.headless=\"auto\" 自动回退至无头模式");
  return { headless: true };
}

/**
 * Standard Chromium flags that use the real desktop profile cleanly without automation banners.
 */
export function buildBrowserLaunchArgs(platform: NodeJS.Platform = process.platform): string[] {
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (platform === "linux") {
    args.push("--disable-dev-shm-usage");
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      args.push("--no-sandbox");
    }
  }
  return args;
}

function findExecutableInPath(cmd: string): string | null {
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(locator, [cmd], { encoding: "utf8", timeout: 2_000 }).trim();
    const firstLine = out.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

async function startXvfbSession(xvfbBin: string): Promise<XvfbSession> {
  const displayNum = pickFreeXDisplayNumber();
  const display = `:${displayNum}`;

  const child: ChildProcess = spawn(
    xvfbBin,
    [display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
    {
      stdio: "ignore",
      detached: false,
    },
  );

  let exitedEarly = false;
  child.once("exit", () => {
    exitedEarly = true;
  });

  const socketPath = `/tmp/.X11-unix/X${displayNum}`;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !exitedEarly) {
    if (existsSync(socketPath)) {
      return {
        display,
        dispose: async () => stopChildProcess(child),
      };
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  if (exitedEarly) {
    throw new Error(`Xvfb (${display}) 启动后立即退出`);
  }

  return {
    display,
    dispose: async () => stopChildProcess(child),
  };
}

function pickFreeXDisplayNumber(): number {
  for (let n = 99; n <= 125; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`)) {
      return n;
    }
  }
  return 99;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        // Ignore cleanup errors.
      }
      resolveStop();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}
