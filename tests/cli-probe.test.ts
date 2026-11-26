import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import {
  parseAgyModelsOutput,
  parseOpenCodeModelsOutput,
  parsePiListModelsOutput,
  probeAllExternalClis,
  probeExternalCliModels,
  readCodexCachedModels,
  readHostCliDefaults,
  verifyExternalCliBackend,
} from "../src/worker/cli-probe.js";

test("model output parsers extract agy, opencode, pi, and codex cached models", () => {
  const agyModels = parseAgyModelsOutput("gemini-4-neon\tGemini 4 Neon\nclaude-sonnet-4\tClaude Sonnet 4\n");
  assert.deepEqual(
    agyModels.map((m) => m.id),
    ["gemini-4-neon", "claude-sonnet-4"],
  );

  const ocModels = parseOpenCodeModelsOutput("anthropic/claude-sonnet-4\nopenai/gpt-5\n");
  assert.deepEqual(
    ocModels.map((m) => m.id),
    ["anthropic/claude-sonnet-4", "openai/gpt-5"],
  );

  const piModels = parsePiListModelsOutput("anthropic  claude-sonnet-4\nopenai  gpt-5\n");
  assert.deepEqual(
    piModels.map((m) => m.id),
    ["anthropic/claude-sonnet-4", "openai/gpt-5"],
  );
});

test("readHostCliDefaults, verifyExternalCliBackend, and probeAllExternalClis work with ACP handshakes", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "hato-cli-probe-home-"));
  try {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    mkdirSync(join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    writeFileSync(
      join(fakeHome, ".codex", "config.toml"),
      'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n',
      "utf8",
    );
    writeFileSync(
      join(fakeHome, ".codex", "models_cache.json"),
      JSON.stringify({
        models: [{ slug: "gpt-5.4", display_name: "GPT 5.4", priority: 1 }],
      }),
      "utf8",
    );
    writeFileSync(
      join(fakeHome, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ agentMode: "auto", model: "gemini-4-neon" }),
      "utf8",
    );

    assert.equal(readHostCliDefaults("codex-cli", fakeHome).summary.model, "gpt-5.4");
    assert.equal(readCodexCachedModels(fakeHome)[0]?.id, "gpt-5.4");

    const config = createDefaultHatoConfig();
    config.worker.external_cli.antigravity_cli = { enabled: true, effort: "high" };

    const verifyOk = await verifyExternalCliBackend("antigravity-cli", config, {
      probeAcp: async ({ command, args }) => {
        assert.equal(command, "agy");
        assert.ok(args.includes("acp"));
        return {
          ok: true,
          installed: true,
          protocolVersion: 1,
          agentInfo: { name: "agy-acp", version: "2.0.0" },
          agentCapabilities: { loadSession: true },
        };
      },
    });
    assert.equal(verifyOk.ok, true);

    const verifyMissing = await verifyExternalCliBackend("claude-code", config, {
      probeAcp: async () => ({
        ok: false,
        installed: false,
        error: "command not found: claude-agent-acp",
      }),
    });
    assert.equal(verifyMissing.ok, false);
    assert.match(verifyMissing.reason ?? "", /claude-agent-acp/);

    const probes = await probeAllExternalClis(config, {
      homeDir: fakeHome,
      exec: async (cmd) => {
        if (cmd === "agy") {
          return { ok: true, stdout: "gemini-4-neon\tGemini 4 Neon\n", stderr: "" };
        }
        if (cmd === "opencode") {
          return { ok: true, stdout: "anthropic/claude-sonnet-4\n", stderr: "" };
        }
        return { ok: true, stdout: "", stderr: "" };
      },
      probeAcp: async ({ command }) => {
        if (command === "pi-acp") {
          return { ok: false, installed: false, error: "ENOENT" };
        }
        return {
          ok: true,
          installed: true,
          protocolVersion: 1,
          agentInfo: { name: `${command}-agent`, version: "1.2.3" },
          agentCapabilities: { loadSession: true },
        };
      },
    });

    assert.equal(probes.length, 5);
    const agyProbe = probes.find((p) => p.backend === "antigravity-cli")!;
    assert.equal(agyProbe.available, true);
    assert.equal(agyProbe.acp?.agentName, "agy-agent");
    assert.equal(agyProbe.acp?.loadSession, true);
    assert.ok(agyProbe.models?.some((m) => m.id === "gemini-4-neon"));

    const piProbe = probes.find((p) => p.backend === "external-pi")!;
    assert.equal(piProbe.installed, false);
    assert.equal(piProbe.available, false);
    assert.match(piProbe.reason ?? "", /pi-acp/);

    const codexModels = await probeExternalCliModels("codex-cli", config, { homeDir: fakeHome });
    assert.ok(codexModels.some((m) => m.id === "gpt-5.4"));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
