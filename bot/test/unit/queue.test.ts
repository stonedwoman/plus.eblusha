import { test } from "node:test";
import assert from "node:assert/strict";
import { redisConnection } from "../../src/api/queue";
import { parseBotJob } from "../../src/api/types";

const good = {
  v: 1,
  kind: "message",
  enqueuedAt: 1_700_000_000_000,
  grant: "g".repeat(32),
  grantExpiresAt: 1_700_000_001_000,
  via: "name",
  conversation: { id: "c1", kind: "group", title: "Кобаны", participantIds: ["u1", "u2", 7] },
  author: { id: "u1", displayName: "Алиса" },
  message: {
    id: "m2",
    senderId: "u1",
    senderName: "Алиса",
    isBot: false,
    type: "TEXT",
    content: "Еблуша, привет",
    createdAt: "2026-10-10T12:00:00.000Z",
    replyToId: "m1",
    attachments: [{ url: "/api/files/a.eblusha", type: "IMAGE", size: 10, metadata: { width: 1 } }, { url: "", type: "IMAGE" }],
  },
  chain: [{ id: "m1", senderId: "b", senderName: "Еблуша", isBot: true, type: "TEXT", content: "привет", createdAt: "2026-10-10T11:59:00.000Z", replyToId: null, attachments: [] }, { junk: true }],
};

test("задача из очереди: форма проверяется, мусор отбрасывается поэлементно", () => {
  const j = parseBotJob(good)!;
  assert.ok(j);
  assert.deepEqual(j.conversation.participantIds, ["u1", "u2"]);
  assert.equal(j.message.attachments.length, 1, "вложение без url отброшено");
  assert.equal(j.chain.length, 1, "битый элемент цепочки отброшен");
  assert.equal(j.chain[0]!.isBot, true);
  assert.equal(parseBotJob({ ...good, v: 2 }), null, "чужая версия контракта");
  assert.equal(parseBotJob({ ...good, via: "socket" }), null);
  assert.equal(parseBotJob({ ...good, conversation: { ...good.conversation, kind: "secret" } }), null, "секретных бесед в контракте нет");
  assert.equal(parseBotJob({ ...good, grant: "" }), null);
  assert.equal(parseBotJob({ ...good, message: { ...good.message, type: "SYSTEM" } }), null);
  assert.equal(parseBotJob(null), null);
});

test("BOT_REDIS_URL → параметры BullMQ", () => {
  assert.deepEqual(redisConnection("redis://127.0.0.1:6379/0"), { host: "127.0.0.1", port: 6379, db: 0, maxRetriesPerRequest: null });
  assert.deepEqual(redisConnection("redis://:p%40ss@redis:6380/2"), { host: "redis", port: 6380, db: 2, password: "p@ss", maxRetriesPerRequest: null });
  assert.throws(() => redisConnection("http://x"), /redis:\/\//);
});
