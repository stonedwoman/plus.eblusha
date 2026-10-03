/**
 * «Пустой» прогон тестовой среды eb-secret-test: ни одной проверки дыр, только доказательство,
 * что приложение пишет туда, куда надо.
 *
 *   test/secret-env/secret-test.sh run test/secret-env/env-proof.test.ts
 *
 * Что делает: поднимает app + Socket.IO (Redis-adapter) на 127.0.0.1:<random>, спрашивает у
 * клиентов приложения, куда они подключены (guard.assertIsolatedBackends), затем проходит
 * самый «опасный» путь записи — пользователи, устройства, секретный тред, push в messages_secret,
 * inbox pull/ack — и печатает строку EB_PROOF {...} с id созданного, чтобы secret-test.sh
 * prod-proof проверил, что в боевой БД/Redis этих id нет.
 */
import { assertIsolatedBackends, describeUrl } from "./guard";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import app from "../../src/app";
import env from "../../src/config/env";
import prisma from "../../src/lib/prisma";
import { getRedisClient } from "../../src/lib/redis";
import { initSocket } from "../../src/realtime/socket";
import { signAccessToken } from "../../src/utils/jwt";
import { SECRET_INBOX_LIST_KEY_PREFIX, SECRET_MESSAGE_KEY_PREFIX } from "../../src/lib/secretInbox";

const RUN = `ebst_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;

async function apiJson<T>(
  baseUrl: string,
  urlPath: string,
  method: "GET" | "POST",
  body?: unknown,
  token?: string,
  headers?: Record<string, string>
): Promise<T> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${urlPath}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const b64 = () => crypto.randomBytes(32).toString("base64");

async function registerDevice(baseUrl: string, token: string, deviceId: string) {
  await apiJson(
    baseUrl,
    "/api/devices/register",
    "POST",
    {
      deviceId,
      name: `${RUN} device`,
      platform: "test",
      publicKey: b64(),
      identityPublicKey: b64(),
      prekeys: Array.from({ length: 3 }).map((_, i) => ({
        keyId: `${deviceId}-pk-${i}`,
        publicKey: b64(),
        oneTimePreKeyId: `${deviceId}-opk-${i}`,
        oneTimePreKeyPublic: b64(),
      })),
    },
    token,
    { "X-Device-Id": deviceId }
  );
}

async function countSecretRows(): Promise<number> {
  return prisma.secretMessage.count();
}

async function main() {
  console.log(`[env-proof] run=${RUN} cwd=${process.cwd()} node=${process.version}`);
  console.log(`[env-proof] app env: NODE_ENV=${env.NODE_ENV} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);

  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[env-proof] live identity (asked through the app's own clients): ${JSON.stringify(identity)}`);

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[env-proof] app listening on ${baseUrl}`);

  const before = await countSecretRows();
  try {
    const alice = await prisma.user.create({ data: { username: `${RUN}_a`, passwordHash: `x_${crypto.randomUUID()}` } });
    const bob = await prisma.user.create({ data: { username: `${RUN}_b`, passwordHash: `x_${crypto.randomUUID()}` } });
    const tA = signAccessToken({ sub: alice.id, tokenId: crypto.randomUUID() });
    const tB = signAccessToken({ sub: bob.id, tokenId: crypto.randomUUID() });
    const A1 = `${RUN}-devA1`;
    const B1 = `${RUN}-devB1`;
    await registerDevice(baseUrl, tA, A1);
    await registerDevice(baseUrl, tB, B1);

    const created = await apiJson<{ threadId: string }>(baseUrl, "/api/threads/secret", "POST", { peerUserId: bob.id }, tA, {
      "X-Device-Id": A1,
    });
    assert.ok(created.threadId, "threadId");

    const msgId = crypto.randomUUID();
    await apiJson(
      baseUrl,
      "/api/secret/messages/push",
      "POST",
      {
        threadId: created.threadId,
        msgId,
        createdAt: new Date().toISOString(),
        headerJson: { kind: "msg", v: 1, nonce: b64() },
        ciphertext: b64(),
        contentType: "text",
        schemaVersion: 1,
        receiverDeviceIds: [A1, B1],
      },
      tA,
      { "X-Device-Id": A1 }
    );

    const pull = await apiJson<{ messages: Array<{ msgId: string }> }>(baseUrl, "/api/secret/inbox/pull", "GET", undefined, tB, {
      "X-Device-Id": B1,
    });
    assert.ok(pull.messages.some((m) => m.msgId === msgId), "B1 должен получить msgId из инбокса");
    const inboxKeyB1 = `${SECRET_INBOX_LIST_KEY_PREFIX}${B1}`;
    const inboxLenBeforeAck = await redis.lLen(inboxKeyB1);
    const msgKeyExists = await redis.exists(`${SECRET_MESSAGE_KEY_PREFIX}${msgId}`);
    await apiJson(baseUrl, "/api/secret/inbox/ack", "POST", { msgIds: [msgId] }, tB, { "X-Device-Id": B1 });

    const after = await countSecretRows();
    assert.equal(after, before + 1, "в ТЕСТОВОЙ messages_secret должна появиться ровно одна строка");

    const proof = {
      run: RUN,
      userIds: [alice.id, bob.id],
      usernames: [alice.username, bob.username],
      deviceIds: [A1, B1],
      threadId: created.threadId,
      msgId,
      redisKeys: [inboxKeyB1, `${SECRET_INBOX_LIST_KEY_PREFIX}${A1}`, `${SECRET_MESSAGE_KEY_PREFIX}${msgId}`],
      testDb: { messages_secret_before: before, messages_secret_after: after },
      testRedis: { inboxLenB1BeforeAck: inboxLenBeforeAck, msgKeyExists },
    };
    console.log(`EB_PROOF ${JSON.stringify(proof)}`);
  } finally {
    io.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().then(
  async () => {
    console.log("env-proof: ok");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (err) => {
    console.error("env-proof: FAILED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
