import { describe, expect, test } from "bun:test";
import type { lookup } from "node:dns/promises";
import type { ResolvedWebFetchConfig } from "../src/config/app.js";
import type { ScopedProxyRouter } from "../src/config/proxy.js";
import { assertSafeResolvedHost, isBlockedIpAddress, runWebFetch } from "../src/persona/web-fetch.js";

const DEFAULT_CONFIG: ResolvedWebFetchConfig = {
  enabled: true,
  timeoutMs: 5000,
  maxChars: 8000,
};

function createMockProxyRouter(onFetch?: () => Response): ScopedProxyRouter {
  return {
    resolveScope: () => ({ mode: "direct" }),
    runWithScope: async (_scope: string, fn: () => Promise<Response>) => fn(),
    scopedFetch: async () => {
      if (onFetch) return onFetch();
      return new Response("<html><title>OK</title><body>hello</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  } as unknown as ScopedProxyRouter;
}

describe("web-fetch SSRF & DNS rebinding protection", () => {
  test("isBlockedIpAddress detects private, loopback, link-local, CGNAT, and ULA", () => {
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("10.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("172.16.0.1")).toBe(true);
    expect(isBlockedIpAddress("192.168.1.1")).toBe(true);
    expect(isBlockedIpAddress("100.64.0.1")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedIpAddress("[::1]")).toBe(true);
    expect(isBlockedIpAddress("fe80::1")).toBe(true);
    expect(isBlockedIpAddress("fc00::1")).toBe(true);
    expect(isBlockedIpAddress("93.184.216.34")).toBe(false);
  });

  test("runWebFetch blocks DNS-rebound hostname resolving to 127.0.0.1", async () => {
    const fakeLookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup;
    let fetched = false;
    const res = await runWebFetch({
      config: DEFAULT_CONFIG,
      proxyRouter: createMockProxyRouter(() => {
        fetched = true;
        return new Response("should not reach");
      }),
      input: { url: "https://rebind.example.com/secret" },
      lookupFn: fakeLookup,
    });
    expect(res.ok).toBe(false);
    expect(fetched).toBe(false);
    expect(res.error).toContain("127.0.0.1");
  });

  test("runWebFetch blocks DNS-rebound hostname resolving to 169.254.169.254", async () => {
    const fakeLookup = (async () => [{ address: "169.254.169.254", family: 4 }]) as unknown as typeof lookup;
    let fetched = false;
    const res = await runWebFetch({
      config: DEFAULT_CONFIG,
      proxyRouter: createMockProxyRouter(() => {
        fetched = true;
        return new Response("should not reach");
      }),
      input: { url: "https://metadata-rebind.example.com/latest/meta-data/" },
      lookupFn: fakeLookup,
    });
    expect(res.ok).toBe(false);
    expect(fetched).toBe(false);
    expect(res.error).toContain("169.254.169.254");
  });

  test("runWebFetch allows public IP resolution (93.184.216.34)", async () => {
    const fakeLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof lookup;
    const res = await runWebFetch({
      config: DEFAULT_CONFIG,
      proxyRouter: createMockProxyRouter(),
      input: { url: "https://example.com/" },
      lookupFn: fakeLookup,
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("hello");
  });

  test("runWebFetch allows private networks when allowPrivateNetworks is true", async () => {
    const fakeLookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup;
    const res = await runWebFetch({
      config: DEFAULT_CONFIG,
      proxyRouter: createMockProxyRouter(),
      input: { url: "http://127.0.0.1:8080/health" },
      allowPrivateNetworks: true,
      lookupFn: fakeLookup,
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("hello");
  });

  test("assertSafeResolvedHost rejects empty DNS results", async () => {
    const emptyLookup = (async () => []) as unknown as typeof lookup;
    await expect(assertSafeResolvedHost("empty.example.com", emptyLookup)).rejects.toThrow();
  });
});
