import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { SECRET_MESSAGE_KEY_PREFIX, SECRET_INBOX_LIST_KEY_PREFIX } from "../src/lib/secretInbox";

type TestContext = { baseUrl: string; server: http.Server };

async function startServer(): Promise<TestContext> {
  const server = http.createServer(app);
  await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start server");
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function apiJson<T>(
  baseUrl: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  token?: string,
  headers?: Record<string, string>
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text}`);
  return json as T;
}

function randomKeyB64(): string {
  return crypto.randomBytes(32).toString("base64");
}

async function createUser(username: string) {
  return prisma.user.create({
    data: { username, passwordHash: `hash_${username}_${crypto.randomUUID()}` },
  });
}

async function registerDevice(baseUrl: string, token: string, deviceId: string, name: string, prekeyCount = 10) {
  const prekeys = Array.from({ length: prekeyCount }).map((_, i) => ({
    keyId: `${deviceId}-pk-${i}-${crypto.randomUUID()}`,
    publicKey: randomKeyB64(),
    oneTimePreKeyId: `${deviceId}-opk-${i}`,
    oneTimePreKeyPublic: randomKeyB64(),
  }));
  await apiJson(
    baseUrl,
    "/api/devices/register",
    "POST",
    {
      deviceId,
      name,
      platform: "test",
      publicKey: randomKeyB64(),
      identityPublicKey: randomKeyB64(),
      prekeys,
    },
    token
  );
}

async function main() {
  const ctx = await startServer();
  const redis = await getRedisClient();
  try {
    const alice = await createUser(`st_a_${Date.now()}`);
    const bob = await createUser(`st_b_${Date.now()}`);
    const tokenAlice = signAccessToken({ sub: alice.id, tokenId: crypto.randomUUID() });
    const tokenBob = signAccessToken({ sub: bob.id, tokenId: crypto.randomUUID() });

    const A1 = `devA1-${crypto.randomUUID()}`;
    const A2 = `devA2-${crypto.randomUUID()}`;
    const B1 = `devB1-${crypto.randomUUID()}`;
    const B2 = `devB2-${crypto.randomUUID()}`;
    await registerDevice(ctx.baseUrl, tokenAlice, A1, "Alice Phone", 15);
    await registerDevice(ctx.baseUrl, tokenAlice, A2, "Alice Laptop", 15);
    await registerDevice(ctx.baseUrl, tokenBob, B1, "Bob Phone", 15);
    await registerDevice(ctx.baseUrl, tokenBob, B2, "Bob Laptop", 15);

    // 1) Concurrent OPK claim must be atomic (no duplicates).
    const CLAIMS = 20;
    const claimResults = await Promise.allSettled(
      Array.from({ length: CLAIMS }).map(() =>
        apiJson<any>(ctx.baseUrl, "/api/e2ee/prekeys/claim", "POST", { deviceId: B1 }, tokenAlice)
      )
    );
    const ok = claimResults.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const ids = ok.map((r) => r.value?.prekey?.keyId).filter(Boolean);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, "claimed OPKs must be unique");
    assert.ok(ids.length > 0, "should claim at least one OPK");

    // 2) Create secret thread idempotently.
    const created1 = await apiJson<any>(ctx.baseUrl, "/api/threads/secret", "POST", { peerUserId: bob.id }, tokenAlice);
    const created2 = await apiJson<any>(ctx.baseUrl, "/api/threads/secret", "POST", { peerUserId: bob.id }, tokenAlice);
    assert.ok(created1.threadId);
    assert.equal(created1.threadId, created2.threadId, "secret thread must be idempotent");
    const threadId = created1.threadId as string;

    // 3) Push one ciphertext message and ensure per-device delivery + inbox pull works.
    const msgId = crypto.randomUUID();
    const receiverDeviceIds = [A1, A2, B1, B2];
    await apiJson<any>(
      ctx.baseUrl,
      "/api/secret/messages/push",
      "POST",
      {
        threadId,
        msgId,
        createdAt: new Date().toISOString(),
        headerJson: { v: 1, nonce: randomKeyB64() },
        ciphertext: randomKeyB64(),
        contentType: "text",
        schemaVersion: 1,
        receiverDeviceIds,
      },
      tokenAlice
    );

    // Delete cached payload to force DB fallback on pull for B1.
    await redis.del(`${SECRET_MESSAGE_KEY_PREFIX}${msgId}`);
    const pull1 = await apiJson<any>(
      ctx.baseUrl,
      "/api/secret/inbox/pull",
      "GET",
      undefined,
      tokenBob,
      { "X-Device-Id": B1 }
    );
    assert.ok(Array.isArray(pull1.messages));
    assert.ok(pull1.messages.some((m: any) => m.msgId === msgId), "pull should return msgId via DB fallback");

    await apiJson<any>(ctx.baseUrl, "/api/secret/inbox/ack", "POST", { msgIds: [msgId] }, tokenBob, { "X-Device-Id": B1 });
    const pull2 = await apiJson<any>(ctx.baseUrl, "/api/secret/inbox/pull?limit=50", "GET", undefined, tokenBob, { "X-Device-Id": B1 });
    assert.ok(!pull2.messages.some((m: any) => m.msgId === msgId), "acked msgId should be removed from inbox list");

    // 4) History pagination
    const msg2 = crypto.randomUUID();
    const msg3 = crypto.randomUUID();
    await apiJson<any>(
      ctx.baseUrl,
      "/api/secret/messages/push",
      "POST",
      {
        threadId,
        msgId: msg2,
        createdAt: new Date(Date.now() + 1).toISOString(),
        headerJson: { v: 1, nonce: randomKeyB64() },
        ciphertext: randomKeyB64(),
        contentType: "text",
        schemaVersion: 1,
        receiverDeviceIds,
      },
      tokenAlice
    );
    await apiJson<any>(
      ctx.baseUrl,
      "/api/secret/messages/push",
      "POST",
      {
        threadId,
        msgId: msg3,
        createdAt: new Date(Date.now() + 2).toISOString(),
        headerJson: { v: 1, nonce: randomKeyB64() },
        ciphertext: randomKeyB64(),
        contentType: "text",
        schemaVersion: 1,
        receiverDeviceIds,
      },
      tokenAlice
    );

    const h1 = await apiJson<any>(ctx.baseUrl, `/api/secret/history?threadId=${encodeURIComponent(threadId)}&limit=2`, "GET", undefined, tokenAlice);
    assert.equal(h1.items.length, 2);
    if (h1.nextCursor) {
      const h2 = await apiJson<any>(ctx.baseUrl, `/api/secret/history?threadId=${encodeURIComponent(threadId)}&limit=2&cursor=${encodeURIComponent(h1.nextCursor)}`, "GET", undefined, tokenAlice);
      assert.ok(h2.items.length >= 1);
    }

    // basic Redis inbox presence for A2 as fanout check (best-effort)
    const inboxA2 = await redis.lRange(`${SECRET_INBOX_LIST_KEY_PREFIX}${A2}`, 0, -1);
    assert.ok(inboxA2.includes(msgId) || inboxA2.includes(msg2) || inboxA2.includes(msg3), "self-fanout should enqueue to A2");
  } finally {
    await stopServer(ctx.server);
  }
}

void main().then(
  () => console.log("secret-threads.integration: ok"),
  (err) => {
    console.error("secret-threads.integration: failed", err);
    process.exit(1);
  }
);

