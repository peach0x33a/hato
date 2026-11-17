import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isMcpToolPermitted,
  loadMcpConfig,
  resolveMcpHttpHeaders,
  resolveMcpServerEntries,
  resolveMcpServerEnv,
  validateMcpConfigObject,
} from "../src/config/mcp.js";

test("loadMcpConfig returns empty config when missing and validates personal/worker TOML", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-mcp-cfg-"));
  const mcpToml = join(tempDir, "mcp.toml");
  const prevToken = process.env.TEST_HATO_MCP_SECRET;
  const prevBearer = process.env.TEST_HATO_MCP_BEARER;

  try {
    assert.deepEqual(loadMcpConfig(mcpToml), { servers: {} });

    process.env.TEST_HATO_MCP_SECRET = "secret-val-123";
    process.env.TEST_HATO_MCP_BEARER = "bearer-tok-999";

    writeFileSync(
      mcpToml,
      `
[servers.weather]
zone = "personal"
transport = "stdio"
command = "node"
args = ["weather.js"]
allowed_tools = ["get_forecast", "get_alerts"]
disabled_tools = ["get_alerts"]
env = { LOG_LEVEL = "warn" }
env_refs = { API_TOKEN = "TEST_HATO_MCP_SECRET" }

[servers.github]
zone = "worker"
transport = "http"
url = "https://mcp.example.com/github"
bearer_token_env = "TEST_HATO_MCP_BEARER"
confirm_tools = ["create_pr"]
`,
      "utf8",
    );

    const cfg = loadMcpConfig(mcpToml);
    const personal = resolveMcpServerEntries(cfg, "personal");
    const worker = resolveMcpServerEntries(cfg, "worker");

    assert.equal(personal.length, 1);
    assert.equal(personal[0]?.name, "weather");
    assert.equal(personal[0]?.proxyScope, "mcp.weather");
    assert.equal(isMcpToolPermitted(personal[0]!, "get_forecast"), true);
    assert.equal(isMcpToolPermitted(personal[0]!, "get_alerts"), false);
    assert.equal(isMcpToolPermitted(personal[0]!, "write_file"), false);

    const resolvedEnv = resolveMcpServerEnv(personal[0]!);
    assert.deepEqual(resolvedEnv, {
      LOG_LEVEL: "warn",
      API_TOKEN: "secret-val-123",
    });
    assert.equal("PATH" in resolvedEnv, false);

    assert.equal(worker.length, 1);
    assert.equal(worker[0]?.name, "github");
    assert.deepEqual(worker[0]?.confirmTools, ["create_pr"]);
    assert.deepEqual(resolveMcpHttpHeaders(worker[0]!), {
      Authorization: "Bearer bearer-tok-999",
    });

    assert.throws(
      () =>
        validateMcpConfigObject({
          servers: {
            bad: {
              zone: "personal",
              transport: "stdio",
            },
          },
        }),
      /requires "command"/,
    );

    assert.throws(
      () =>
        validateMcpConfigObject({
          servers: {
            badhttp: {
              zone: "worker",
              transport: "http",
              url: "ftp://invalid.example.com",
            },
          },
        }),
      /http or https/,
    );
  } finally {
    if (prevToken === undefined) delete process.env.TEST_HATO_MCP_SECRET;
    else process.env.TEST_HATO_MCP_SECRET = prevToken;
    if (prevBearer === undefined) delete process.env.TEST_HATO_MCP_BEARER;
    else process.env.TEST_HATO_MCP_BEARER = prevBearer;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
