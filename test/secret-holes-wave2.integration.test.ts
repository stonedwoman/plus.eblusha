/**
 * Дыры секретных чатов, серверная волна 2 (лог-режим):
 *   S3 — связь отправителя и получателя в POST /secret/send (H01/H03/H06/H07/X2/X4 от посторонних):
 *        по умолчанию ЛОГ-РЕЖИМ (принимаем как раньше, пишем лог + счётчики secret:obs),
 *        SECRET_SEND_ENFORCE=1 — жёсткий режим волны 3 (нарушивший конверт отбрасывается).
 *        Легаси thread_key без threadId в заголовке (Б1) пропускается в ОБОИХ режимах, со счётчиком.
 *   S7 — учёт загрузчика: регистрировать/удалять секретный файл может только загрузивший (X1);
 *        «нет записи-владельца = разрешить» (переходный режим), SECRET_ATTACH_OWNER_STRICT=1 — строгий,
 *        SECRET_ATTACH_OWNER_ENFORCE=0 — аварийный (только лог).
 *   Наблюдение — суточные счётчики secret:obs:YYYY-MM-DD (S2 битые типы, S3, S7).
 *
 * Запускать ТОЛЬКО в изолированной среде (guard.ts не пустит к боевым БД/Redis):
 *   test/secret-env/secret-test.sh run test/secret-holes-wave2.integration.test.ts
 * Тест НЕ импортирует новые модули волны 2 — контрольный прогон «до» на старом коде падает шагами.
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import app from "../src/app";
import env from "../src/config/env";
import logger from "../src/config/logger";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { getPushQueue } from "../src/jobs/queue";
import { getStorageProvider } from "../src/lib/storage/provider";

const RUN = `ebst_w2_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = () => crypto.randomBytes(32).toString("base64");

let baseUrl = "";

// ---- перехват логов приложения (тот же экземпляр pino, что импортируют маршруты)
const captured: Array<{ msg: string; obj: any }> = [];
{
  const orig = (logger as any).warn.bind(logger);
  (logger as any).warn = (...args: any[]) => {
    const obj = typeof args[0] === "object" && args[0] !== null ? args[0] : {};
    const msg = typeof args[0] === "string" ? args[0] : typeof args[1] === "string" ? args[1] : "";
    captured.push({ msg, obj });
    return orig(...args);
  };
}
const logsSince = (mark: number, msg: string) => captured.slice(mark).filter((c) => c.msg === msg);

type Resp = { status: number; body: any };
async function call(
  method: "GET" | "POST" | "DELETE" | "PUT",
  path: string,
  opts: { token?: string; device?: string; body?: unknown } = {}
): Promise<Resp> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.device ? { "X-Device-Id": opts.device } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

type U = { id: string; username: string; token: string; dev: string; devs: string[] };
let userSeq = 0;
async function mkUser(tag: string, extraDevices = 0): Promise<U> {
  userSeq += 1;
  const username = `${RUN}_${tag}_${userSeq}`;
  const user = await prisma.user.create({ data: { username, passwordHash: `x_${crypto.randomUUID()}` } });
  const token = signAccessToken({ sub: user.id, tokenId: crypto.randomUUID() });
  const devs: string[] = [];
  for (let i = 0; i <= extraDevices; i += 1) {
    const dev = `${RUN}-${tag}${userSeq}-d${i}`;
    const r = await call("POST", "/api/devices/register", {
      token,
      device: dev,
      body: {
        deviceId: dev,
        name: `${RUN} ${tag} ${i}`,
        platform: "test",
        publicKey: b64(),
        identityPublicKey: b64(),
        prekeys: [{ keyId: `${dev}-pk`, publicKey: b64(), oneTimePreKeyId: `${dev}-opk`, oneTimePreKeyPublic: b64() }],
      },
    });
    assert.ok(r.status < 300, `register ${dev}: ${r.status} ${JSON.stringify(r.body)}`);
    devs.push(dev);
  }
  return { id: user.id, username, token, dev: devs[0]!, devs };
}

async function createSecretThread(creator: U, peer: U): Promise<string> {
  const r = await call("POST", "/api/threads/secret", { token: creator.token, device: creator.dev, body: { peerUserId: peer.id } });
  assert.ok(r.status === 201 || r.status === 200, `create thread ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.threadId as string;
}

async function accept(peer: U, threadId: string, device = peer.dev) {
  const r = await call("POST", `/api/threads/secret/${threadId}/accept`, { token: peer.token, device });
  assert.equal(r.status, 200, `accept ${JSON.stringify(r.body)}`);
}

async function createCloudDirect(a: U, b: U): Promise<string> {
  const r = await call("POST", "/api/conversations", { token: a.token, body: { participantIds: [b.id] } });
  assert.ok(r.status === 201 || r.status === 200, `create cloud ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.conversation.id as string;
}

function env1(toDeviceId: string, headerJson?: Record<string, unknown>) {
  return {
    toDeviceId,
    msgId: crypto.randomUUID(),
    ciphertext: b64(),
    createdAt: new Date().toISOString(),
    ttlSeconds: 600,
    contentType: "ref",
    schemaVersion: 1,
    ...(headerJson !== undefined ? { headerJson } : {}),
  };
}
const threadKeyHdr = (threadId: string | null, from: string) => ({
  kind: "key_package",
  v: 1,
  packageKind: "thread_key",
  ...(threadId ? { threadId } : {}),
  initiatorDeviceId: from,
  initiatorIdentityKey: b64(),
  prekeyId: "pk",
  handshakeSalt: b64(),
  hkdfInfo: "eblusha:secret_pkg:thread_key",
  nonce: b64(),
  alg: "xsalsa20_poly1305+hkdf_sha256",
});
const linkKeysHdr = (from: string) => ({ ...threadKeyHdr(null, from), packageKind: "device_link_keys" });
const controlHdr = (threadId: string, type: string, extra: Record<string, unknown> = {}) => ({
  kind: "control",
  v: 1,
  type,
  threadId,
  ts: Date.now(),
  ...extra,
});

async function send(u: U, envelopes: any[], device = u.dev) {
  return call("POST", "/api/secret/send", { token: u.token, device, body: { messages: envelopes } });
}

/** msgId'ы во входящих устройства (pull без ack — конверты остаются). */
async function inboxIds(u: U, device: string): Promise<Set<string>> {
  const r = await call("GET", "/api/secret/inbox/pull?limit=200", { token: u.token, device });
  assert.equal(r.status, 200, `pull ${JSON.stringify(r.body)}`);
  return new Set(((r.body.messages ?? []) as any[]).map((m) => String(m.msgId)));
}
async function delivered(u: U, device: string, msgId: string) {
  return (await inboxIds(u, device)).has(msgId);
}

function today() {
  return `secret:obs:${new Date().toISOString().slice(0, 10)}`;
}
async function obs(): Promise<Record<string, number>> {
  const redis = await getRedisClient();
  const raw = await redis.hGetAll(today());
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw ?? {})) out[k] = Number(v);
  return out;
}
/** Счётчики bumpSecretObs пишутся fire-and-forget — ждём, пока поле дорастёт. */
async function obsDelta(before: Record<string, number>, field: string, min = 1, ms = 3000): Promise<number> {
  const t0 = Date.now();
  let d = 0;
  while (Date.now() - t0 < ms) {
    d = ((await obs())[field] ?? 0) - (before[field] ?? 0);
    if (d >= min) return d;
    await sleep(50);
  }
  return d;
}

async function uploadFile(u: U): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([crypto.randomBytes(96)], { type: "application/octet-stream" }), "secret.bin");
  const res = await fetch(`${baseUrl}/api/upload`, { method: "POST", headers: { Authorization: `Bearer ${u.token}` }, body: fd });
  const body: any = await res.json();
  assert.equal(res.status, 200, `upload ${JSON.stringify(body)}`);
  assert.ok(body.path, "upload path");
  return String(body.path);
}
async function uploadChunked(u: U): Promise<string> {
  const data = crypto.randomBytes(70);
  const init = await call("POST", "/api/upload/init", {
    token: u.token,
    body: { filename: "secret.bin", contentType: "application/octet-stream", size: data.length },
  });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  const part = await fetch(`${baseUrl}/api/upload/${init.body.uploadId}/part/0`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${u.token}`, "Content-Type": "application/octet-stream" },
    body: data,
  });
  assert.equal(part.status, 200);
  const done = await call("POST", `/api/upload/${init.body.uploadId}/complete`, { token: u.token });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return String(done.body.path);
}
async function uploaderOf(objectKey: string): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM "upload_owners" WHERE "objectKey" = ${objectKey}`;
    return rows[0]?.userId ?? null;
  } catch {
    return null; // таблицы нет (контрольный прогон на коде до волны 2)
  }
}
const liveRef = (threadId: string, objectKey: string) =>
  prisma.secretAttachmentRef.findFirst({ where: { threadId, objectKey, deletedAt: null } });

type StepResult = { name: string; ok: boolean; err?: string };
const results: StepResult[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message ?? String(e) });
    console.log(`  FAIL ${name}: ${e?.message ?? e}`);
  }
}
function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

async function main() {
  console.log(`[wave2] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[wave2] isolated backends: ${JSON.stringify(identity)}`);
  delete process.env.SECRET_SEND_ENFORCE;
  delete process.env.SECRET_ATTACH_OWNER_ENFORCE;
  delete process.env.SECRET_ATTACH_OWNER_STRICT;

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // A — создатель, B — собеседник (2 устройства), C — посторонний, A имеет 2-е устройство.
    const A = await mkUser("a", 2);
    const B = await mkUser("b", 1);
    const C = await mkUser("c");
    const T = await createSecretThread(A, B); // ACTIVE после accept
    await accept(B, T);
    const D = await mkUser("d");
    const TP = await createSecretThread(A, D); // PENDING
    const CL = await createCloudDirect(A, C); // облачная A↔C
    const [A1, A2, A3] = A.devs as [string, string, string];
    // Устройство A3 отзываем — получатель-мертвец.
    const rev = await call("DELETE", `/api/devices/${A3}`, { token: A.token, device: A1 });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));

    // ================================================================ S3 лог-режим (по умолчанию)
    console.log("S3 — лог-режим (SECRET_SEND_ENFORCE не задан)");
    await step("S3/log: посторонний C шлёт thread_key в чужой тред → ПРИНЯТ (как раньше), лог secret-send-reject, счётчик would_reject", async () => {
      const before = await obs();
      const mark = captured.length;
      const e = env1(B.dev, threadKeyHdr(T, C.dev));
      const r = await send(C, [e]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(await delivered(B, B.dev, e.msgId), "в лог-режиме конверт доставлен");
      const log = logsSince(mark, "secret-send-reject");
      assert.equal(log.length, 1, "лог secret-send-reject");
      assert.equal(log[0]!.obj.enforce, false);
      assert.equal(log[0]!.obj.byReason?.sender_not_participant, 1, JSON.stringify(log[0]!.obj));
      assert.ok((await obsDelta(before, "s3.would_reject.sender_not_participant.key_package")) >= 1, "счётчик would_reject");
    });
    await step("S3/log: честный поток (A→B thread_key в ACTIVE, B→A key_receipt) — без лога отказа", async () => {
      const mark = captured.length;
      const e1 = env1(B.dev, threadKeyHdr(T, A1));
      const e2 = env1(A1, controlHdr(T, "key_receipt", { fromDeviceId: B.dev }));
      assert.equal((await send(A, [e1], A1)).status, 200);
      assert.equal((await send(B, [e2])).status, 200);
      assert.ok(await delivered(B, B.dev, e1.msgId));
      assert.ok(await delivered(A, A1, e2.msgId));
      assert.equal(logsSince(mark, "secret-send-reject").length, 0, JSON.stringify(logsSince(mark, "secret-send-reject")));
    });

    // ================================================================ S3 жёсткий режим (волна 3)
    console.log("S3 — жёсткий режим (SECRET_SEND_ENFORCE=1)");
    await withEnv("SECRET_SEND_ENFORCE", "1", async () => {
      await step("S3/enforce: посторонний C → B: thread_key / key_request / key_resend_request / prekeys_needed в тред A↔B → отброшены (200 + rejected), не доставлены", async () => {
        const before = await obs();
        const envs = [
          env1(B.dev, threadKeyHdr(T, C.dev)),
          env1(B.dev, controlHdr(T, "key_request", { requesterDeviceId: C.dev })),
          env1(B.dev, { kind: "key_resend_request", v: 1, threadId: T, requesterUserId: A.id, requesterDeviceId: C.dev, ts: Date.now() }),
          env1(B.dev, { kind: "prekeys_needed", v: 1, threadId: T, ts: Date.now() }),
        ];
        const r = await send(C, envs);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.code, "SECRET_SEND_REJECTED");
        assert.equal(r.body.rejected, 4);
        assert.equal((r.body.results ?? []).filter((x: any) => x.rejected && x.reason === "sender_not_participant").length, 4);
        const box = await inboxIds(B, B.dev);
        for (const e of envs) assert.ok(!box.has(e.msgId), `не доставлен ${e.msgId}`);
        assert.equal(await prisma.secretMessage.count({ where: { msgId: { in: envs.map((e) => e.msgId) } } }), 0, "в БД не записан");
        assert.ok((await obsDelta(before, "s3.rejected.sender_not_participant.control")) >= 1);
      });
      await step("S3/enforce: участник A → B thread_key в PENDING-тред (A↔D) → thread_not_active; себе (A→A2) в PENDING — можно", async () => {
        const toPeer = env1(D.dev, threadKeyHdr(TP, A1));
        const toSelf = env1(A2, threadKeyHdr(TP, A1));
        const r = await send(A, [toPeer, toSelf], A1);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const rej = (r.body.results as any[]).find((x) => x.msgId === toPeer.msgId);
        assert.equal(rej?.rejected, true);
        assert.equal(rej?.reason, "thread_not_active");
        assert.ok(!(await delivered(D, D.dev, toPeer.msgId)), "собеседнику в PENDING — нет");
        assert.ok(await delivered(A, A2, toSelf.msgId), "своему устройству — да");
      });
      await step("S3/enforce: честный поток в ACTIVE: thread_key A→B, key_receipt B→A, key_request B→A, prekeys_needed A→B, синхронизация A→A2 — всё доставлено", async () => {
        const envA = [env1(B.dev, threadKeyHdr(T, A1)), env1(B.devs[1]!, { kind: "prekeys_needed", v: 1, threadId: T, ts: Date.now() }), env1(A2, threadKeyHdr(T, A1))];
        const rA = await send(A, envA, A1);
        assert.equal(rA.status, 200, JSON.stringify(rA.body));
        assert.ok(!(rA.body.results as any[]).some((x) => x.rejected), JSON.stringify(rA.body.results));
        const envB = [env1(A1, controlHdr(T, "key_receipt", { fromDeviceId: B.dev })), env1(A1, controlHdr(T, "key_request", { requesterDeviceId: B.dev, fromDeviceId: B.dev }))];
        const rB = await send(B, envB);
        assert.equal(rB.status, 200, JSON.stringify(rB.body));
        assert.ok(await delivered(B, B.dev, envA[0]!.msgId));
        assert.ok(await delivered(B, B.devs[1]!, envA[1]!.msgId));
        assert.ok(await delivered(A, A2, envA[2]!.msgId));
        assert.ok(await delivered(A, A1, envB[0]!.msgId));
        assert.ok(await delivered(A, A1, envB[1]!.msgId));
      });
      await step("S3/enforce: связывание только своим: device_link_keys A→C и link_device_join C→A → cross_user_link; A→A2 и A2→A1 — доставлены", async () => {
        const bad1 = env1(C.dev, linkKeysHdr(A1));
        const r1 = await send(A, [bad1], A1);
        assert.equal(r1.status, 200, JSON.stringify(r1.body));
        assert.equal(r1.body.results?.[0]?.rejected, true);
        assert.equal(r1.body.results?.[0]?.reason, "cross_user_link");
        const bad2 = env1(A1, { kind: "link_device_join", v: 1, requesterDeviceId: C.dev, token: "t", code: "12345678" });
        const r2 = await send(C, [bad2]);
        assert.equal(r2.status, 200, JSON.stringify(r2.body));
        assert.equal(r2.body.results?.[0]?.reason, "cross_user_link");
        assert.ok(!(await delivered(A, A1, bad2.msgId)));
        const ok1 = env1(A2, linkKeysHdr(A1));
        const ok2 = env1(A1, { kind: "link_device_join", v: 1, requesterDeviceId: A2, token: "t", code: "12345678" });
        assert.equal((await send(A, [ok1], A1)).status, 200);
        assert.equal((await send(A, [ok2], A2)).status, 200);
        assert.ok(await delivered(A, A2, ok1.msgId));
        assert.ok(await delivered(A, A1, ok2.msgId));
      });
      await step("S3/enforce: получатель — несуществующий или отозванный id → отброшен; пачка [годный, мёртвый] доставляет годный", async () => {
        const dead1 = env1(`${RUN}-no-such-device`, { kind: "self_check", v: 1 });
        const dead2 = env1(A3, { kind: "self_check", v: 1 });
        const good = env1(A2, { kind: "self_check", v: 1 });
        const r = await send(A, [good, dead1, dead2], A1);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const res = r.body.results as any[];
        assert.equal(res.find((x) => x.msgId === dead1.msgId)?.reason, "recipient_unknown");
        assert.equal(res.find((x) => x.msgId === dead2.msgId)?.reason, "recipient_revoked");
        assert.ok(!res.find((x) => x.msgId === good.msgId)?.rejected);
        assert.ok(await delivered(A, A2, good.msgId));
        assert.equal(await prisma.secretDelivery.count({ where: { msgId: { in: [dead1.msgId, dead2.msgId] } } }), 0, "сирот-доставок нет");
      });
      await step("S3/enforce: threadId облачной беседы → thread_not_secret; несуществующий тред → thread_not_found; получатель не участник → recipient_not_participant", async () => {
        const r1 = await send(A, [env1(C.dev, controlHdr(CL, "key_request", { requesterDeviceId: A1 }))], A1);
        assert.equal(r1.status, 200);
        assert.equal(r1.body.results?.[0]?.reason, "thread_not_secret");
        const r2 = await send(A, [env1(B.dev, controlHdr(`${RUN}_nothread`, "key_receipt"))], A1);
        assert.equal(r2.body.results?.[0]?.reason, "thread_not_found");
        const r3 = await send(A, [env1(C.dev, controlHdr(T, "key_receipt"))], A1);
        assert.equal(r3.body.results?.[0]?.reason, "recipient_not_participant");
      });
      await step("S3/enforce: легаси thread_key БЕЗ threadId в заголовке пропускается (Б1) — со счётчиком по отношению (self/shared_secret/stranger)", async () => {
        const before = await obs();
        const mark = captured.length;
        const toSelf = env1(A2, threadKeyHdr(null, A1));
        const toPeer = env1(B.dev, threadKeyHdr(null, A1));
        const fromStranger = env1(B.dev, threadKeyHdr(null, C.dev));
        assert.equal((await send(A, [toSelf, toPeer], A1)).status, 200);
        assert.equal((await send(C, [fromStranger])).status, 200);
        assert.ok(await delivered(A, A2, toSelf.msgId));
        assert.ok(await delivered(B, B.dev, toPeer.msgId));
        assert.ok(await delivered(B, B.dev, fromStranger.msgId));
        assert.ok((await obsDelta(before, "s3.legacy_no_threadid.key_package.self")) >= 1);
        assert.ok((await obsDelta(before, "s3.legacy_no_threadid.key_package.shared_secret")) >= 1);
        assert.ok((await obsDelta(before, "s3.legacy_no_threadid.key_package.stranger")) >= 1);
        assert.ok(logsSince(mark, "secret-send-legacy-no-threadid").length >= 2);
      });
      await step("S3/enforce: прочие kind (msg, self_check, без headerJson, неизвестный) живому устройству — без правил по содержимому", async () => {
        const envs = [env1(B.dev, { kind: "self_check", v: 1 }), env1(B.dev), env1(B.dev, { kind: "brand_new_kind", v: 1 })];
        const r = await send(C, envs);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        for (const e of envs) assert.ok(await delivered(B, B.dev, e.msgId));
      });
    });

    await step("S3/log: после возврата в лог-режим посторонний снова проходит (флаг читается на каждый запрос)", async () => {
      const e = env1(B.dev, controlHdr(T, "key_request", { requesterDeviceId: C.dev }));
      const r = await send(C, [e]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(await delivered(B, B.dev, e.msgId));
    });

    // ================================================================ S2 счётчик битых типов
    await step("S2: заголовок неверной формы → 400 (жёстко с волны 1) и счётчик s2.invalid.send.enforce", async () => {
      const before = await obs();
      const r = await send(A, [env1(A2, { kind: "self_check", v: 1, ts: 1.5 })], A1);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.ok((await obsDelta(before, "s2.invalid.send.enforce")) >= 1);
    });

    // ================================================================ S7 учёт загрузчика
    console.log("S7 — регистрировать/удалять секретный файл может только загрузивший");
    const kA1 = await uploadFile(A);
    const kA2 = await uploadFile(A);
    const kA3 = await uploadFile(A);
    const kB1 = await uploadFile(B);
    const kChunk = await uploadChunked(B);
    const storage = getStorageProvider();
    const kLegacy = `${RUN}/legacy-${crypto.randomUUID()}.eblusha`;
    await storage.putObject(kLegacy, crypto.randomBytes(32), { contentType: "application/octet-stream" });

    await step("S7: /api/upload и chunk-complete пишут загрузчика в upload_owners", async () => {
      assert.equal(await uploaderOf(kA1), A.id);
      assert.equal(await uploaderOf(kB1), B.id);
      assert.equal(await uploaderOf(kChunk), B.id);
      assert.equal(await uploaderOf(kLegacy), null);
    });
    await step("S7: B регистрирует ЧУЖОЙ объект A в своей секретке → 403 SECRET_ATTACHMENT_NOT_OWNER, рефа нет", async () => {
      const before = await obs();
      const r = await call("POST", "/api/secret/attachments/ref", { token: B.token, body: { threadId: T, objectKey: kA1 } });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.code, "SECRET_ATTACHMENT_NOT_OWNER");
      assert.equal(await liveRef(T, kA1), null);
      assert.ok((await obsDelta(before, "s7.ref.rejected.other_owner")) >= 1);
    });
    await step("S7: загрузивший A регистрирует свой объект → 201; B свой chunk-объект → 201", async () => {
      const r = await call("POST", "/api/secret/attachments/ref", { token: A.token, body: { threadId: T, objectKey: kA1 } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const r2 = await call("POST", "/api/secret/attachments/ref", { token: B.token, body: { threadId: T, objectKey: kChunk } });
      assert.equal(r2.status, 201, JSON.stringify(r2.body));
      assert.equal((await liveRef(T, kA1))?.ownerUserId, A.id);
    });
    await step("S7: push B с чужим objectKey A в заголовке → сообщение доставлено (201), но реф НЕ заведён", async () => {
      const before = await obs();
      const msgId = crypto.randomUUID();
      const r = await call("POST", "/api/secret/messages/push", {
        token: B.token,
        device: B.dev,
        body: {
          threadId: T,
          msgId,
          createdAt: new Date().toISOString(),
          headerJson: { v: 1, kind: "msg", nonce: b64(), attachment: { objectKey: kA2, size: 96 } },
          ciphertext: b64(),
          contentType: "attachment",
          receiverDeviceIds: [A1],
        },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(await delivered(A, A1, msgId), "сообщение доставлено");
      assert.equal(await liveRef(T, kA2), null, "чужой объект не присвоен");
      assert.ok((await obsDelta(before, "s7.push.rejected.other_owner")) >= 1);
    });
    await step("S7: push A со своим objectKey → реф заведён (ownerUserId=A)", async () => {
      const r = await call("POST", "/api/secret/messages/push", {
        token: A.token,
        device: A1,
        body: {
          threadId: T,
          msgId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          headerJson: { v: 1, kind: "msg", nonce: b64(), attachment: { objectKey: kA3, size: 96 } },
          ciphertext: b64(),
          contentType: "attachment",
          receiverDeviceIds: [B.dev],
        },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await liveRef(T, kA3))?.ownerUserId, A.id);
    });
    await step("S7: объект без записи о загрузчике (до волны 2) — переходный режим: реф разрешён, счётчик no_owner", async () => {
      const before = await obs();
      const r = await call("POST", "/api/secret/attachments/ref", { token: B.token, body: { threadId: T, objectKey: kLegacy } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok((await obsDelta(before, "s7.ref.allowed.no_owner")) >= 1);
      // повторная регистрация другим участником не перехватывает ownerUserId рефа (Б7)
      const r2 = await call("POST", "/api/secret/attachments/ref", { token: A.token, body: { threadId: T, objectKey: kLegacy } });
      assert.equal(r2.status, 201);
      assert.equal((await liveRef(T, kLegacy))?.ownerUserId, B.id);
    });
    await step("S7: SECRET_ATTACH_OWNER_STRICT=1 (волна 3) — объект без записи → 403", async () => {
      await withEnv("SECRET_ATTACH_OWNER_STRICT", "1", async () => {
        const k = `${RUN}/legacy2-${crypto.randomUUID()}.eblusha`;
        const r = await call("POST", "/api/secret/attachments/ref", { token: B.token, body: { threadId: T, objectKey: k } });
        assert.equal(r.status, 403, JSON.stringify(r.body));
        const own = await call("POST", "/api/secret/attachments/ref", { token: B.token, body: { threadId: T, objectKey: kB1 } });
        assert.equal(own.status, 201, "свой объект и в строгом режиме");
      });
    });
    await step("S7: аварийный SECRET_ATTACH_OWNER_ENFORCE=0 — чужой объект пропускается, но в счётчике would_reject", async () => {
      await withEnv("SECRET_ATTACH_OWNER_ENFORCE", "0", async () => {
        const before = await obs();
        const T2 = await createSecretThread(B, C);
        const r = await call("POST", "/api/secret/attachments/ref", { token: B.token, body: { threadId: T2, objectKey: kA2 } });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.ok((await obsDelta(before, "s7.ref.would_reject.other_owner")) >= 1);
        await prisma.secretAttachmentRef.deleteMany({ where: { threadId: T2 } });
      });
    });
    await step("S7: B удаляет объект A по ключу → пропущен (skippedNotOwner=1), объект и реф живы", async () => {
      const r = await call("POST", "/api/secret/attachments/delete", { token: B.token, body: { threadId: T, objectKeys: [kA1] } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.affectedRefs, 0);
      assert.equal(r.body.skippedNotOwner, 1);
      assert.ok(await liveRef(T, kA1));
      assert.ok(await storage.headObject(kA1), "объект A на месте");
    });
    await step("S7: deleteAllThread от B сносит только своё (kChunk, kB1) и объект без записи (переходный режим); объекты A живы", async () => {
      const r = await call("POST", "/api/secret/attachments/delete", { token: B.token, body: { threadId: T, deleteAllThread: true } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.skippedNotOwner >= 2, JSON.stringify(r.body));
      assert.equal(await liveRef(T, kChunk), null);
      assert.equal(await liveRef(T, kLegacy), null);
      assert.ok(await liveRef(T, kA1));
      assert.ok(await liveRef(T, kA3));
      assert.ok(await storage.headObject(kA1));
      assert.ok(await storage.headObject(kA3));
      assert.equal(await storage.headObject(kChunk), null, "свой объект B удалён");
    });
    await step("S7: загрузивший A удаляет свой объект → реф снят, объект удалён", async () => {
      const r = await call("POST", "/api/secret/attachments/delete", { token: A.token, body: { threadId: T, objectKeys: [kA1] } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.affectedRefs, 1);
      assert.equal(await liveRef(T, kA1), null);
      assert.equal(await storage.headObject(kA1), null);
    });
    await step("S7: облачная загрузка и обычные вложения не затронуты (upload отвечает как раньше: url/path/publicUrl)", async () => {
      const fd = new FormData();
      fd.append("file", new Blob([crypto.randomBytes(10)], { type: "text/plain" }), "a.txt");
      const res = await fetch(`${baseUrl}/api/upload`, { method: "POST", headers: { Authorization: `Bearer ${C.token}` }, body: fd });
      const body: any = await res.json();
      assert.equal(res.status, 200);
      assert.ok(body.url && body.path && body.publicUrl, JSON.stringify(body));
    });
  } finally {
    io.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().then(
  async () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nsecret-holes-wave2: ${results.length - failed.length}/${results.length} ok`);
    for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
    await getPushQueue().close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(failed.length ? 1 : 0);
  },
  async (err) => {
    console.error("secret-holes-wave2: CRASHED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
