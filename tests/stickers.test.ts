import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRegistry } from "../src/config/models.js";
import { openDatabase } from "../src/db/client.js";
import { HatoRepository } from "../src/db/repo.js";
import { parseQqForwardPayload } from "../src/gateway/qq.js";
import { extractStickerSetName } from "../src/stickers/service.js";
import { StickerStore } from "../src/stickers/store.js";

test("parseQqForwardPayload parses JSON multimsg and XML forward cards", () => {
  const jsonPayload = JSON.stringify({
    app: "com.tencent.multimsg",
    meta: {
      detail: {
        source: "群聊聊天记录",
        news: [{ text: "Alice: 今晚吃什么" }, { text: "Bob: 火锅" }],
      },
    },
  });
  const parsedJson = parseQqForwardPayload(jsonPayload);
  assert.ok(parsedJson);
  assert.ok(parsedJson.includes("群聊聊天记录"));
  assert.ok(parsedJson.includes("Alice: 今晚吃什么"));

  const xmlPayload = `<msg serviceID="35"><item><title>小鸠和主人的聊天记录</title><summary>共3条转发消息</summary></item></msg>`;
  const parsedXml = parseQqForwardPayload(xmlPayload);
  assert.ok(parsedXml);
  assert.ok(parsedXml.includes("小鸠和主人的聊天记录"));
  assert.ok(parsedXml.includes("共3条转发消息"));
});

test("StickerStore supports create, deduplication, semantic search, usage tracking, and delete", () => {
  const dbHandle = openDatabase(":memory:");
  try {
    const store = new StickerStore(dbHandle.db);
    const s1 = store.create({
      canonicalUserId: "owner",
      source: "user_send",
      localPath: "/tmp/a.webp",
      mimeType: "image/webp",
      sha256: "hash_a",
      tgFileId: "tg_1",
      tgFileUniqueId: "uniq_1",
      caption: "白发女孩比耶微笑，配字「稳稳地接住你」",
      emotions: ["自信", "安慰"],
      scenes: ["接下委托", "鼓励对方"],
      style: "二次元萌系",
      status: "ready",
    });

    const s2 = store.create({
      canonicalUserId: "owner",
      source: "tg_pack",
      setName: "cat_memes",
      localPath: "/tmp/b.webp",
      mimeType: "image/webp",
      sha256: "hash_b",
      caption: "猫猫躺平叹气",
      emotions: ["摆烂", "无语"],
      scenes: ["吐槽", "摸鱼"],
      style: "猫猫",
      status: "ready",
    });

    assert.equal(store.findBySha256("owner", "hash_a")?.id, s1.id);
    assert.equal(store.findByTgUniqueId("owner", "uniq_1")?.id, s1.id);

    const hits = store.search("owner", "安慰 鼓励");
    assert.equal(hits[0]?.id, s1.id);

    const catHits = store.search("owner", "吐槽");
    assert.equal(catHits[0]?.id, s2.id);

    store.recordUsed("owner", s1.id);
    assert.equal(store.getById("owner", s1.id)?.useCount, 1);

    assert.equal(store.delete("owner", s2.id), true);
    assert.equal(store.list("owner").length, 1);
  } finally {
    dbHandle.sqlite.close();
  }
});

test("extractStickerSetName parses t.me/addstickers URLs and raw names", () => {
  assert.equal(extractStickerSetName("https://t.me/addstickers/peach_hato_pack"), "peach_hato_pack");
  assert.equal(extractStickerSetName("t.me/addstickers/test_pack_2"), "test_pack_2");
  assert.equal(extractStickerSetName("my_pack"), "my_pack");
});

test("ModelRegistry resolves vision slot by falling back to persona when vision is unset", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hato-vision-slot-"));
  const modelsPath = join(tempDir, "models.toml");
  const dbHandle = openDatabase(":memory:");
  try {
    writeFileSync(
      modelsPath,
      `
[slots]
persona = "demo/chat-vision"
router = "demo/chat-vision"
curator = "demo/chat-vision"
worker = "demo/chat-vision"
hindsight_llm = "demo/chat-vision"

[providers.demo]
api = "openai-completions"
base_url = "https://example.com/v1"
api_key_env = "DEMO_API_KEY"

[[providers.demo.models]]
id = "chat-vision"
name = "Chat Vision"
input = ["text", "image"]
`,
      "utf8",
    );
    const repo = new HatoRepository(dbHandle.db);
    const registry = new ModelRegistry(modelsPath, repo);
    const resolved = registry.resolveSlot("vision");
    assert.equal(resolved.target, "demo/chat-vision");
  } finally {
    dbHandle.sqlite.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
