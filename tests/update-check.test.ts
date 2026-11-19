import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveUpdatesConfig } from "../src/config/app.js";
import { createDefaultHatoConfig } from "../src/setup/presets.js";
import {
  buildUpdateNotificationKey,
  checkForUpdates,
  compareSemver,
  detectDefaultReleaseChannel,
  getCachedUpdateStatus,
} from "../src/utils/update-check.js";

test("compareSemver and detectDefaultReleaseChannel handle stable and nightly versions", () => {
  assert.equal(compareSemver("v0.1.2", "0.1.1"), 1);
  assert.equal(compareSemver("0.1.1", "v0.1.1"), 0);
  assert.equal(compareSemver("0.1.0", "0.1.1"), -1);
  assert.equal(compareSemver("0.1.2-nightly.1", "0.1.2"), -1);

  assert.equal(detectDefaultReleaseChannel("0.1.1"), "stable");
  assert.equal(detectDefaultReleaseChannel("0.1.1-nightly.20261119"), "nightly");
});

test("resolveUpdatesConfig defaults IM update notification to disabled", () => {
  const cfg = createDefaultHatoConfig();
  assert.deepEqual(resolveUpdatesConfig(cfg), {
    checkEnabled: true,
    channel: "stable",
    imNotifyEnabled: false,
    checkIntervalHours: 24,
  });
});

test("checkForUpdates supports channel-aware stable/nightly checks, caching, and deduplication keys", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-update-test-"));
  const pkgRoot = join(tempDir, "pkg");
  const cachePath = join(tempDir, "update-cache.json");
  try {
    const fs = await import("node:fs");
    fs.mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ version: "0.1.1" }), "utf8");

    const requestedUrls: string[] = [];
    const mockFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.endsWith("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.1.2",
            html_url: "https://github.com/peach0x33a/hato/releases/tag/v0.1.2",
            published_at: "2026-11-20T00:00:00Z",
            body: "## Changes\n- Added /render2img\n- Added domain packs",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          tag_name: "nightly",
          html_url: "https://github.com/peach0x33a/hato/releases/tag/nightly",
          published_at: new Date(Date.now() + 3600_000).toISOString(),
          body: "Nightly build",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const stable1 = await checkForUpdates({
      channel: "stable",
      packageRoot: pkgRoot,
      cacheFilePath: cachePath,
      fetchFn: mockFetch,
    });
    assert.equal(stable1.hasUpdate, true);
    assert.equal(stable1.latestTag, "v0.1.2");
    assert.equal(stable1.fromCache, false);
    assert.equal(buildUpdateNotificationKey(stable1), "stable:v0.1.2");
    assert.equal(requestedUrls.length, 1);

    // Second call hits TTL cache
    const stable2 = await checkForUpdates({
      channel: "stable",
      packageRoot: pkgRoot,
      cacheFilePath: cachePath,
      fetchFn: mockFetch,
    });
    assert.equal(stable2.fromCache, true);
    assert.equal(requestedUrls.length, 1);
    assert.equal(getCachedUpdateStatus({ channel: "stable", cacheFilePath: cachePath, packageRoot: pkgRoot })?.latestTag, "v0.1.2");

    // Nightly channel queries /releases/tags/nightly
    const nightly = await checkForUpdates({
      channel: "nightly",
      packageRoot: pkgRoot,
      cacheFilePath: cachePath,
      fetchFn: mockFetch,
      force: true,
    });
    assert.equal(nightly.channel, "nightly");
    assert.equal(nightly.latestTag, "nightly");
    assert.equal(nightly.hasUpdate, true);
    assert.ok(buildUpdateNotificationKey(nightly)?.startsWith("nightly:nightly:"));
    assert.ok(requestedUrls[1]?.endsWith("/releases/tags/nightly"));

    // Disabled skips network
    const disabled = await checkForUpdates({
      enabled: false,
      packageRoot: pkgRoot,
      cacheFilePath: cachePath,
      fetchFn: mockFetch,
    });
    assert.equal(disabled.hasUpdate, false);
    assert.equal(requestedUrls.length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
