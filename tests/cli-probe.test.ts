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
  verifyOpenCodeV2,
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
  --mode                          Set the agent execution mode for this session (accept-edits, auto, plan)
  --sandbox                       Run in a sandbox with terminal restrictions enabled
`);
  assert.deepEqual(agyParsed.modeChoices, ["accept-edits", "auto", "plan"]);
  assert.equal(agyParsed.supportsSandbox, true);
  assert.equal(agyParsed.supportsSkipPermissions, true);

  const validV2 = verifyOpenCodeV2({
    versionText: "opencode v2.0.32\n",
    rootHelpText: "serve  Start the v2 API and web server\n--standalone  Run with a private server",
    runHelpText: "--standalone  Run with a private server\n--auto  Auto-approve permissions",
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

  const claudeParsed = parseClaudeHelpModes(
    `--permission-mode <mode>  Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "plan")`,
  );
  assert.deepEqual(claudeParsed.permissionModes, [
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "plan",
  ]);
});

test("readHostCliDefaults, resolveEffectiveCliModeArgs (yolo & custom), and probeAllExternalClis work cleanly", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "hato-cli-probe-home-"));
  try {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    mkdirSync(join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });

    writeFileSync(
      join(fakeHome, ".codex", "config.toml"),
      `
model = "gpt-5.4"
model_provider = "relay"
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
      join(fakeHome, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ mode: "accept-edits", sandbox: true }),
      "utf8",
    );
    writeFileSync(
      join(fakeHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({ model: "relay/sonnet", default_agent: "build" }),
      "utf8",
    );

    const codexHost = readHostCliDefaults("codex-cli", fakeHome);
    assert.equal(codexHost.summary.model, "gpt-5.4");
    assert.deepEqual(codexHost.summary.host_mcp_servers, ["personal_notes"]);
    assert.equal(codexHost.defaults.sandbox, "workspace-write");

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
    };
    assert.deepEqual(resolveEffectiveCliModeArgs("antigravity-cli", cfg).args, [
      "--mode",
      "plan",
      "--sandbox",
    ]);

    // Codex danger-full-access implies unrestricted execution without conflicting approve-for-me
    cfg.worker.external_cli.codex_cli = {
      enabled: true,
      sandbox: "danger-full-access",
    };
    assert.deepEqual(resolveEffectiveCliModeArgs("codex-cli", cfg).args, [
      "--dangerously-bypass-approvals-and-sandbox",
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
              "--sandbox <SANDBOX_MODE> [possible values: read-only, workspace-write, danger-full-access]\n--approve-for-me\n--dangerously-bypass-approvals-and-sandbox",
            stderr: "",
          };
        }
        if (cmd === "agy") {
          return {
            ok: true,
            stdout:
              "--mode (accept-edits, auto, plan)\n--sandbox\n--dangerously-skip-permissions",
            stderr: "",
          };
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
    const piProbe = probes.find((p) => p.backend === "external-pi");

    assert.equal(codexProbe?.available, true);
    assert.deepEqual(codexProbe?.effectiveArgsPreview, [
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    assert.equal(agyProbe?.available, true);
    assert.deepEqual(agyProbe?.effectiveArgsPreview, ["--mode", "plan", "--sandbox"]);
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
