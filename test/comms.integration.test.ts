import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { io as ioClient } from "socket.io-client";
import { AccessToken } from "livekit-server-sdk";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { SECRET_INBOX_LIST_KEY_PREFIX, SECRET_MESSAGE_KEY_PREFIX } from "../src/lib/secretInbox";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import env from "../src/config/env";

type TestContext = {
  baseUrl: string;
  server: http.Server;
};

function sha256Base64(payload: string): string {
  return createHash("sha256").update(payload).digest("base64");
}

async function startServer(): Promise<TestContext> {
  const server = http.createServer(app);
  await initSocket(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
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
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${JSON.stringify(json)}`);
  }
  return json as T;
}

async function apiRaw(
  baseUrl: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  token?: string,
  headers?: Record<string, string>
) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function postLivekitWebhook(baseUrl: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  token.sha256 = sha256Base64(body);
  const jwt = await token.toJwt();
  return apiJson<{ ok: boolean; duplicate?: boolean }>(
    baseUrl,
    "/api/livekit/webhook",
    "POST",
    payload,
    undefined,
    { Authorization: jwt }
  );
}

async function createUser(username: string) {
  return prisma.user.create({
    data: {
      username,
      passwordHash: `hash_${username}_${randomUUID()}`,
    },
  });
}

async function runCallsWebhookTest(baseUrl: string) {
  const roomId = `call-room-${randomUUID()}`;
  const alice = await createUser(`calls_a_${Date.now()}`);
  const bob = await createUser(`calls_b_${Date.now()}`);
  await prisma.conversation.create({
    data: {
      id: roomId,
      isGroup: false,
      createdById: alice.id,
      participants: {
        create: [{ userId: alice.id }, { userId: bob.id }],
      },
    },
  });

  const startedTs = Math.floor(Date.now() / 1000);
  const joinedTs = startedTs + 5;
  const leftTs = joinedTs + 12;
  const endedTs = leftTs + 2;

  const baseEvent = {
    room: { name: roomId },
    participant: { identity: bob.id },
  };

  const invalidWebhook = await apiRaw(
    baseUrl,
    "/api/livekit/webhook",
    "POST",
    {
      id: `evt-invalid-${randomUUID()}`,
      event: "room_started",
      createdAt: startedTs,
      ...baseEvent,
    },
    undefined,
    { Authorization: "Bearer invalid-signature" }
  );
  assert.ok(
    invalidWebhook.status === 401 || invalidWebhook.status === 403,
    `invalid signature should be rejected, got ${invalidWebhook.status}`
  );

  await postLivekitWebhook(baseUrl, {
    id: `evt-room-started-${randomUUID()}`,
    event: "room_started",
    createdAt: startedTs,
    ...baseEvent,
  });
  await postLivekitWebhook(baseUrl, {
    id: `evt-participant-joined-${randomUUID()}`,
    event: "participant_joined",
    createdAt: joinedTs,
    ...baseEvent,
  });
  const duplicateId = `evt-participant-joined-dup-${randomUUID()}`;
  await postLivekitWebhook(baseUrl, {
    id: duplicateId,
    event: "participant_joined",
    createdAt: joinedTs,
    ...baseEvent,
  });
  const duplicateResponse = await postLivekitWebhook(baseUrl, {
    id: duplicateId,
    event: "participant_joined",
    createdAt: joinedTs,
    ...baseEvent,
  });
  assert.equal(duplicateResponse.duplicate, true);

  await postLivekitWebhook(baseUrl, {
    id: `evt-participant-left-${randomUUID()}`,
    event: "participant_left",
    createdAt: leftTs,
    ...baseEvent,
  });
  await postLivekitWebhook(baseUrl, {
    id: `evt-room-finished-${randomUUID()}`,
    event: "room_finished",
    createdAt: endedTs,
    ...baseEvent,
  });

  const session = await prisma.callSession.findFirst({
    where: { roomName: roomId },
    include: { participants: true },
  });
  assert.ok(session, "CallSession should be created from webhook facts");
  assert.equal(session!.conversationId, roomId);
  assert.equal(Math.floor(session!.startedAt.getTime() / 1000), startedTs);
  assert.equal(Math.floor((session!.endedAt ?? new Date(0)).getTime() / 1000), endedTs);
  assert.equal(session!.participants.length, 1, "Duplicate participant_joined should stay idempotent");
  const participant = session!.participants[0]!;
  assert.equal(participant.userId, bob.id);
  assert.equal(Math.floor(participant.joinedAt.getTime() / 1000), joinedTs);
  assert.equal(Math.floor((participant.leftAt ?? new Date(0)).getTime() / 1000), leftTs);
}

async function runConcurrentPrekeyClaimTest(baseUrl: string) {
  const owner = await createUser(`prekey_owner_${Date.now()}`);
  const deviceId = `claim-device-${randomUUID()}`;
  const ownerToken = signAccessToken({
    sub: owner.id,
    tokenId: `tok-${randomUUID()}`,
    did: deviceId,
  });

  await prisma.userDevice.create({
    data: {
      id: deviceId,
      userId: owner.id,
      name: "claim-device",
      publicKey: `pk-${randomUUID()}`,
      identityPublicKey: `ipk-${randomUUID()}`,
    },
  });

  const prekeyCount = 4;
  await prisma.devicePrekey.createMany({
    data: Array.from({ length: prekeyCount }).map((_, idx) => ({
      deviceId,
      keyId: `k-${idx}-${randomUUID()}`,
      publicKey: `pk-${idx}-${randomUUID()}`,
      oneTimePreKeyId: `otk-${idx}-${randomUUID()}`,
      oneTimePreKeyPublic: `otpk-${idx}-${randomUUID()}`,
    })),
  });

  const claims = await Promise.all(
    Array.from({ length: 10 }).map(() =>
      apiRaw(baseUrl, "/api/devices/prekeys/claim", "POST", { deviceId }, ownerToken)
    )
  );

  const successfulPayloads: Array<{ prekey: { keyId: string } }> = [];
  for (const resp of claims) {
    if (resp.status === 200) {
      successfulPayloads.push((await resp.json()) as { prekey: { keyId: string } });
    } else {
      assert.equal(resp.status, 404, `unexpected status for concurrent claim: ${resp.status}`);
    }
  }

  assert.equal(successfulPayloads.length, prekeyCount, "must claim exactly available prekeys");
  const claimedIds = successfulPayloads.map((p) => p.prekey.keyId);
  assert.equal(new Set(claimedIds).size, prekeyCount, "claimed prekeys must be unique");
}

async function runSecretRelayTest(baseUrl: string) {
  const sender = await createUser(`sec_s_${Date.now()}`);
  const recipient = await createUser(`sec_r_${Date.now()}`);
  const senderDeviceId = `device-s-${randomUUID()}`;
  const recipientDeviceId = `device-r-${randomUUID()}`;

  await prisma.userDevice.createMany({
    data: [
      {
        id: senderDeviceId,
        userId: sender.id,
        name: "sender-device",
        publicKey: `pk-${randomUUID()}`,
        identityPublicKey: `ipk-${randomUUID()}`,
      },
      {
        id: recipientDeviceId,
        userId: recipient.id,
        name: "recipient-device",
        publicKey: `pk-${randomUUID()}`,
        identityPublicKey: `ipk-${randomUUID()}`,
      },
    ],
  });

  const senderToken = signAccessToken({
    sub: sender.id,
    tokenId: `tok-${randomUUID()}`,
    did: senderDeviceId,
  });
  const recipientToken = signAccessToken({
    sub: recipient.id,
    tokenId: `tok-${randomUUID()}`,
    did: recipientDeviceId,
  });

  const socket = ioClient(baseUrl, {
    auth: { token: recipientToken },
    transports: ["websocket"],
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });

  const notifyPromise = new Promise<{ toDeviceId: string; msgId: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("secret:notify timeout")), 8_000);
    socket.once("secret:notify", (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });

  const msgId = randomUUID();
  await apiJson<{ results: Array<{ inserted: boolean }> }>(
    baseUrl,
    "/api/secret/send",
    "POST",
    {
      messages: [
        {
          toDeviceId: recipientDeviceId,
          msgId,
          ciphertext: "ciphertext-blob",
          createdAt: new Date().toISOString(),
          ttlSeconds: 120,
          attachment: {
            objectKey: `secret/${randomUUID()}`,
            size: 1024,
            hash: "sha256:abc",
            wrappedContentKeysByDevice: {
              [recipientDeviceId]: "wrapped-key",
            },
          },
        },
      ],
    },
    senderToken
  );

  const redis = await getRedisClient();
  const inboxEntries = await redis.lRange(`${SECRET_INBOX_LIST_KEY_PREFIX}${recipientDeviceId}`, 0, -1);
  assert.ok(inboxEntries.includes(msgId), "inbox list should contain inserted msgId");
  const rawPayload = await redis.get(`${SECRET_MESSAGE_KEY_PREFIX}${msgId}`);
  assert.ok(!!rawPayload, "message payload key should exist after enqueue");

  const notify = await notifyPromise;
  assert.equal(notify.toDeviceId, recipientDeviceId);
  assert.equal(notify.msgId, msgId);

  const pull = await apiJson<{
    messages: Array<{ msgId: string; attachment?: { objectKey: string }; expiresAt: string }>;
  }>(baseUrl, "/api/secret/inbox/pull", "POST", { limit: 50 }, recipientToken, { "X-Device-Id": recipientDeviceId });
  assert.equal(pull.messages.length, 1);
  assert.equal(pull.messages[0]?.msgId, msgId);
  assert.equal(pull.messages[0]?.attachment?.objectKey?.startsWith("secret/"), true);
  assert.ok(new Date(pull.messages[0]!.expiresAt).getTime() > Date.now(), "expiresAt should be in future");

  const firstAck = await apiJson<{ acked: Array<{ msgId: string; removedFromListCount: number }> }>(
    baseUrl,
    "/api/secret/inbox/ack",
    "POST",
    { msgIds: [msgId] },
    recipientToken,
    { "X-Device-Id": recipientDeviceId }
  );
  assert.equal(firstAck.acked[0]?.removedFromListCount, 1);

  const secondAck = await apiJson<{ acked: Array<{ msgId: string; removedFromListCount: number }> }>(
    baseUrl,
    "/api/secret/inbox/ack",
    "POST",
    { msgIds: [msgId] },
    recipientToken,
    { "X-Device-Id": recipientDeviceId }
  );
  assert.equal(secondAck.acked[0]?.removedFromListCount, 0, "Repeated ack should be safe");

  const pullAfterAck = await apiJson<{ messages: Array<{ msgId: string }> }>(
    baseUrl,
    "/api/secret/inbox/pull",
    "POST",
    { limit: 50 },
    recipientToken
  );
  assert.equal(pullAfterAck.messages.length, 0);
  socket.disconnect();
}

async function main() {
  const { baseUrl, server } = await startServer();
  try {
    await runCallsWebhookTest(baseUrl);
    await runConcurrentPrekeyClaimTest(baseUrl);
    await runSecretRelayTest(baseUrl);
  } finally {
    await stopServer(server);
    await prisma.$disconnect();
  }
}

void main().then(
  () => {
    // eslint-disable-next-line no-console
    console.log("comms.integration: ok");
    process.exit(0);
  },
  (err) => {
    // eslint-disable-next-line no-console
    console.error("comms.integration: failed", err);
    process.exit(1);
  }
);
