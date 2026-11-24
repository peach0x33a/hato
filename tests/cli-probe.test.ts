import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import {
  parseAgyHelpModes,
  parseAgyModelsOutput,
  parseClaudeHelpModes,
  parseCodexHelpModes,
  parseOpenCodeModelsOutput,
  probeAllExternalClis,
  probeExternalCliModels,
  readCodexCachedModels,
  readHostCliDefaults,
  resolveEffectiveCliModeArgs,
  verifyAgyCapabilities,
  verifyClaudeCapabilities,
  verifyCodexCapabilities,
  verifyOpenCodeV2,
  verifyPiCapabilities,
} from "../src/worker/cli-probe.js";

test("CLI help parsers extract dynamic mode options and enforce OpenCode V2 gate", () => {
  const codexParsed = parseCodexHelpModes(`
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
      --approve-for-me
      --dangerously-bypass-approvals-and-sandbox
`);
  assert.deepEqual(codexParsed.sandboxChoices, [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]);
  assert.equal(codexParsed.supportsApproveForMe, true);
  assert.equal(codexParsed.supportsBypass, true);

  const agyParsed = parseAgyHelpModes(`
  --dangerously-skip-permissions  Auto-approve all tool permission requests
  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  --mode                          Set the agent execution mode for this session (accept-edits, auto, plan)
  --sandbox                       Run in a sandbox with terminal restrictions enabled
`);
  assert.deepEqual(agyParsed.modeChoices, ["accept-edits", "auto", "plan"]);
  assert.deepEqual(agyParsed.effortChoices, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(agyParsed.supportsSandbox, true);
  assert.equal(agyParsed.supportsSkipPermissions, true);

  const validV2 = verifyOpenCodeV2({
    versionText: "opencode v2.0.32\n",
    rootHelpText: "serve  Start the v2 API and web server\n--standalone  Run with a private server",
    runHelpText:
      "--standalone  Run with a private server\n--auto  Auto-approve permissions\n--format  Output format",
  });
  assert.equal(validV2.v2Verified, true);
  assert.equal(validV2.version, "v2.0.32");
  assert.equal(validV2.supportsAuto, true);

  const legacyV1 = verifyOpenCodeV2({
    versionText: "opencode v1.4.8\n",
    rootHelpText: "opencode CLI",
    runHelpText: "opencode run",
  });
  assert.equal(legacyV1.v2Verified, false);
  assert.match(legacyV1.reason ?? "", /OpenCode V2/);

  assert.equal(
    verifyCodexCapabilities("--json\n--skip-git-repo-check\n--output-schema").verified,
    true,
  );
  const oldCodexCap = verifyCodexCapabilities("--json");
  assert.equal(oldCodexCap.verified, false);
  assert.deepEqual(oldCodexCap.missing, ["--skip-git-repo-check", "--output-schema"]);

  assert.equal(
    verifyAgyCapabilities(
      "--output-format (text, json, stream-json)\n--conversation\n--json-schema\n--settings",
    ).verified,
    true,
  );
  const oldAgyCap = verifyAgyCapabilities("--output-format text");
  assert.equal(oldAgyCap.verified, false);
  assert.ok(oldAgyCap.missing.includes("stream-json"));
  assert.ok(oldAgyCap.missing.includes("--settings"));

  assert.equal(
    verifyClaudeCapabilities(
      "--print\n--output-format stream-json\n--resume\n--mcp-config\n--strict-mcp-config\n--json-schema",
    ).verified,
    true,
  );
  assert.equal(verifyClaudeCapabilities("--print\n--resume").verified, false);

  assert.equal(verifyPiCapabilities("--mode json\n--session").verified, true);
  assert.equal(verifyPiCapabilities("--help").verified, false);

  const claudeParsed = parseClaudeHelpModes(
    `--permission-mode <mode>  Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "plan")\n  --effort <level>  Effort level (low, medium, high, xhigh, max)`,
  );
  assert.deepEqual(claudeParsed.permissionModes, [
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "plan",
  ]);
  assert.deepEqual(claudeParsed.effortChoices, ["low", "medium", "high", "xhigh", "max"]);
});

test("readHostCliDefaults, resolveEffectiveCliModeArgs (yolo & custom), and probeAllExternalClis work cleanly", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "hato-cli-probe-home-"));
  try {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    mkdirSync(join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    mkdirSync(join(fakeHome, ".gemini", "config"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    writeFileSync(
      join(fakeHome, ".codex", "config.toml"),
      `
model = "gpt-5.4"
model_provider = "relay"
model_reasoning_effort = "max"
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[model_providers.relay]
base_url = "https://relay.example.com/v1"

[mcp_servers.personal_notes]
command = "node"
args = ["notes.js"]
`,
      "utf8",
    );
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ model: "opus", effortLevel: "high" }),
      "utf8",
    );
    writeFileSync(
      join(fakeHome, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({
        agentMode: "accept-edits",
        enableTerminalSandbox: true,
        toolPermission: "proceed-in-sandbox",
        model: "gemini-4-carbon-medium",
      }),
      "utf8",
    );
    writeFileSync(
      join(fakeHome, ".gemini", "config", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          personal_gcal: { command: "node", args: ["gcal.js"] },
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(fakeHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({ model: "relay/sonnet", default_agent: "build" }),
      "utf8",
    );

    const codexHost = readHostCliDefaults("codex-cli", fakeHome);
    assert.equal(codexHost.summary.model, "gpt-5.4");
    assert.equal(codexHost.defaults.effort, "max");
    assert.deepEqual(codexHost.summary.host_mcp_servers, ["personal_notes"]);
    assert.equal(codexHost.defaults.sandbox, "workspace-write");

    const claudeHost = readHostCliDefaults("claude-code", fakeHome);
    assert.equal(claudeHost.summary.model, "opus");
    assert.equal(claudeHost.defaults.effort, "high");

    const agyHost = readHostCliDefaults("antigravity-cli", fakeHome);
    assert.equal(agyHost.defaults.mode, "accept-edits");
    assert.equal(agyHost.defaults.sandbox, true);
    assert.equal(agyHost.summary.toolPermission, "proceed-in-sandbox");
    assert.equal(agyHost.summary.model, "gemini-4-carbon-medium");
    assert.deepEqual(agyHost.summary.host_mcp_servers, ["personal_gcal"]);

    const cfg = createDefaultHatoConfig();
    cfg.worker.external_cli.permission_preset = "yolo";

    assert.deepEqual(resolveEffectiveCliModeArgs("codex-cli", cfg).args, [
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    assert.deepEqual(resolveEffectiveCliModeArgs("antigravity-cli", cfg).args, [
      "--mode",
      "auto",
      "--dangerously-skip-permissions",
    ]);
    assert.deepEqual(resolveEffectiveCliModeArgs("opencode-v2", cfg).args, [
      "--standalone",
      "--auto",
    ]);

    // Per-backend override supersedes preset
    cfg.worker.external_cli.antigravity_cli = {
      enabled: true,
      mode: "plan",
      skip_permissions: false,
      sandbox: true,
      effort: "high",
    };
    assert.deepEqual(resolveEffectiveCliModeArgs("antigravity-cli", cfg).args, [
      "--mode",
      "plan",
      "--sandbox",
      "--effort",
      "high",
    ]);

    // Tier-suffixed agy model IDs (e.g. gemini-3.8-flash-low) suppress --effort so agy does not error
    const suffixedCfg = structuredClone(cfg);
    suffixedCfg.worker.external_cli.antigravity_cli = {
      enabled: true,
      mode: "auto",
      skip_permissions: true,
      effort: "high",
      model: "gemini-3.8-flash-low",
    };
    assert.deepEqual(resolveEffectiveCliModeArgs("antigravity-cli", suffixedCfg).args, [
      "--mode",
      "auto",
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3.8-flash-low",
    ]);

    // Codex danger-full-access implies unrestricted execution without conflicting approve-for-me
    cfg.worker.external_cli.codex_cli = {
      enabled: true,
      sandbox: "danger-full-access",
      effort: "xhigh",
    };
    assert.deepEqual(resolveEffectiveCliModeArgs("codex-cli", cfg).args, [
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);

    // Claude Code, OpenCode V2, and External Pi effort flag wiring
    const effortCfg = structuredClone(cfg);
    effortCfg.worker.external_cli.claude_code = {
      enabled: true,
      effort: "max",
      model: "opus",
    };
    assert.deepEqual(resolveEffectiveCliModeArgs("claude-code", effortCfg).args, [
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions",
      "--effort",
      "max",
      "--model",
      "opus",
    ]);

    effortCfg.worker.external_cli.opencode_v2 = {
      enabled: true,
      effort: "high",
      model: "opencode/sonnet",
    };
    assert.deepEqual(resolveEffectiveCliModeArgs("opencode-v2", effortCfg).args, [
      "--standalone",
      "--auto",
      "-m",
      "opencode/sonnet#high",
    ]);

    effortCfg.worker.external_cli.external_pi = {
      enabled: true,
      effort: "medium",
      model: "anthropic/claude-sonnet",
    };
    assert.deepEqual(resolveEffectiveCliModeArgs("external-pi", effortCfg).args, [
      "--thinking",
      "medium",
      "--model",
      "anthropic/claude-sonnet",
    ]);

    const probes = await probeAllExternalClis(cfg, {
      homeDir: fakeHome,
      exec: async (cmd, args) => {
        if (cmd === "codex" && args[0] === "--version") {
          return { ok: true, stdout: "codex-cli 0.99.0\n", stderr: "" };
        }
        if (cmd === "codex" && args[0] === "exec") {
          return {
            ok: true,
            stdout:
              "--json\n--skip-git-repo-check\n--output-schema <FILE>\n--sandbox <SANDBOX_MODE> [possible values: read-only, workspace-write, danger-full-access]\n--approve-for-me\n--dangerously-bypass-approvals-and-sandbox",
            stderr: "",
          };
        }
        if (cmd === "agy") {
          return {
            ok: true,
            stdout:
              "--output-format (text, json, stream-json)\n--conversation\n--json-schema\n--settings\n--effort (low|medium|high|xhigh|max)\n--mode (accept-edits, auto, plan)\n--sandbox\n--dangerously-skip-permissions",
            stderr: "",
          };
        }
        if (cmd === "claude" && args[0] === "--version") {
          return { ok: true, stdout: "claude 0.1.0\n", stderr: "" };
        }
        if (cmd === "claude") {
          return { ok: true, stdout: "--print\n--resume", stderr: "" };
        }
        if (cmd === "opencode" && args[0] === "--version") {
          return { ok: true, stdout: "opencode v1.0.9\n", stderr: "" };
        }
        if (cmd === "opencode") {
          return { ok: true, stdout: "opencode legacy", stderr: "" };
        }
        return { ok: false, stdout: "", stderr: "", error: `command not found: ${cmd}` };
      },
    });

    const codexProbe = probes.find((p) => p.backend === "codex-cli");
    const agyProbe = probes.find((p) => p.backend === "antigravity-cli");
    const ocProbe = probes.find((p) => p.backend === "opencode-v2");
    const claudeProbe = probes.find((p) => p.backend === "claude-code");
    const piProbe = probes.find((p) => p.backend === "external-pi");

    assert.equal(codexProbe?.available, true);
    assert.equal(claudeProbe?.installed, true);
    assert.equal(claudeProbe?.available, false);
    assert.match(claudeProbe?.reason ?? "", /--strict-mcp-config/);
    assert.deepEqual(codexProbe?.effectiveArgsPreview, [
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
    assert.ok(
      codexProbe?.options.some(
        (o) =>
          o.key === "effort" &&
          o.hostDefault === "max" &&
          o.effectiveHatoValue === "xhigh" &&
          o.choices?.includes("max"),
      ),
    );
    assert.equal(agyProbe?.available, true);
    assert.deepEqual(agyProbe?.effectiveArgsPreview, [
      "--mode",
      "plan",
      "--sandbox",
      "--effort",
      "high",
    ]);
    assert.ok(agyProbe?.options.some((o) => o.key === "effort" && o.effectiveHatoValue === "high"));
    assert.equal(ocProbe?.installed, true);
    assert.equal(ocProbe?.v2Verified, false);
    assert.equal(ocProbe?.available, false);
    assert.match(ocProbe?.reason ?? "", /OpenCode V2/);
    assert.equal(piProbe?.installed, false);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("CLI model catalog parsers and probeExternalCliModels extract live models cleanly", async () => {
  const agyModels = parseAgyModelsOutput(`
Fetching available models...
gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
`);
  assert.deepEqual(agyModels, [
    { id: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (Medium)" },
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  ]);

  const ocModels = parseOpenCodeModelsOutput(`
opencode/beam-free
opencode/deepseek-v4.1-flash-free
opencode/beam-free
`);
  assert.deepEqual(ocModels, [
    { id: "opencode/beam-free" },
    { id: "opencode/deepseek-v4.1-flash-free" },
  ]);

  const fakeHome = mkdtempSync(join(tmpdir(), "hato-codex-models-"));
  try {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".codex", "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", priority: 1 },
          { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", priority: 2 },
          { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", priority: 1 },
        ],
      }),
      "utf8",
    );
    const codexModels = readCodexCachedModels(fakeHome);
    assert.deepEqual(codexModels, [
      { id: "gpt-6-astra", label: "GPT-6-Astra" },
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
    ]);

    const cfg = createDefaultHatoConfig();
    const probedAgy = await probeExternalCliModels("antigravity-cli", cfg, {
      homeDir: fakeHome,
      exec: async (_cmd, args) => {
        if (args[0] === "models") {
          return {
            ok: true,
            stdout: "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\n",
            stderr: "",
          };
        }
        return { ok: false, stdout: "", stderr: "" };
      },
    });
    assert.equal(probedAgy[0]?.id, "gemini-4-hydrogen-medium");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
