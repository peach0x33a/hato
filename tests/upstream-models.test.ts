import assert from "node:assert/strict";
import test from "node:test";
import { fetchUpstreamModels, inferModelGroup } from "../src/config/upstream-models.js";

test("inferModelGroup classifies common model families and slashes", () => {
  assert.equal(inferModelGroup("anthropic/claude-sonnet-4.5"), "anthropic");
  assert.equal(inferModelGroup("gpt-4.1-mini"), "openai");
  assert.equal(inferModelGroup("o3-mini"), "openai");
  assert.equal(inferModelGroup("claude-3-7-sonnet-20250219"), "claude");
  assert.equal(inferModelGroup("gemini-2.5-pro"), "gemini");
  assert.equal(inferModelGroup("deepseek-chat"), "deepseek");
  assert.equal(inferModelGroup("qwen2.5:14b"), "qwen");
  assert.equal(inferModelGroup("custom-model", "acme"), "custom");
  assert.equal(inferModelGroup("solo", "acme"), "acme");
});

test("fetchUpstreamModels parses OpenAI-compatible /models response", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  const result = await fetchUpstreamModels({
    providerSlug: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1/",
    apiKey: "sk-test",
    fetcher: async (url, init) => {
      capturedUrl = url;
      const headers = init?.headers as Record<string, string>;
      capturedAuth = headers?.Authorization ?? "";
      return new Response(
        JSON.stringify({
          data: [
            { id: "gpt-4o", owned_by: "openai" },
            { id: "o3-mini", owned_by: "openai" },
            { id: "gpt-4o", owned_by: "openai" }, // duplicate should be deduped
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(capturedUrl, "https://api.openai.com/v1/models");
  assert.equal(capturedAuth, "Bearer sk-test");
  assert.equal(result.models.length, 2);
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["gpt-4o", "o3-mini"],
  );
  assert.equal(result.models[0]?.group, "openai");
});

test("fetchUpstreamModels parses Anthropic /v1/models response with x-api-key", async () => {
  let capturedUrl = "";
  let capturedKey = "";
  let capturedVersion = "";
  const result = await fetchUpstreamModels({
    providerSlug: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    apiKey: "ant-key",
    fetcher: async (url, init) => {
      capturedUrl = url;
      const headers = init?.headers as Record<string, string>;
      capturedKey = headers?.["x-api-key"] ?? "";
      capturedVersion = headers?.["anthropic-version"] ?? "";
      return new Response(
        JSON.stringify({
          data: [
            { id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5" },
          ],
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(capturedUrl, "https://api.anthropic.com/v1/models");
  assert.equal(capturedKey, "ant-key");
  assert.equal(capturedVersion, "2023-06-01");
  assert.equal(result.models[0]?.id, "claude-sonnet-4-5-20250929");
  assert.equal(result.models[0]?.name, "Claude Sonnet 4.5");
  assert.equal(result.models[0]?.group, "claude");
});

test("fetchUpstreamModels parses Google Gemini models and strips models/ prefix", async () => {
  let capturedUrl = "";
  let capturedKey = "";
  const result = await fetchUpstreamModels({
    providerSlug: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "gem-key",
    fetcher: async (url, init) => {
      capturedUrl = url;
      const headers = init?.headers as Record<string, string>;
      capturedKey = headers?.["x-goog-api-key"] ?? "";
      return new Response(
        JSON.stringify({
          models: [
            { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
          ],
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(
    capturedUrl,
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
  );
  assert.equal(capturedKey, "gem-key");
  assert.equal(result.models[0]?.id, "gemini-2.5-pro");
  assert.equal(result.models[0]?.name, "Gemini 2.5 Pro");
  assert.equal(result.models[0]?.group, "gemini");
});

test("fetchUpstreamModels rejects faux provider and HTTP error status", async () => {
  await assert.rejects(
    () =>
      fetchUpstreamModels({
        providerSlug: "faux",
        api: "hato-faux-api",
        baseUrl: "http://localhost:9999",
      }),
    /Faux/,
  );

  await assert.rejects(
    () =>
      fetchUpstreamModels({
        providerSlug: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        fetcher: async () => new Response("unauthorized", { status: 401 }),
      }),
    /HTTP 401/,
  );
});
