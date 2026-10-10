/**
 * read-sync: «беседу прочитали на одном устройстве» → остальные устройства того же человека снимают
 * уведомления: сокет-событие conversation:read-self в комнату пользователя + тихий пуш
 * {kind:"read", conversationId, readAt} на iOS (APNs) и Android (FCM).
 *
 * Что проверяется:
 *   A. Полезная нагрузка APNs (buildRequest, без сети): background, priority 5, collapse-id read-<C>,
 *      aps = только content-available, в теле только kind+conversationId (ни текста, ни имён);
 *      на VoIP-токен read не уходит; collapse-id не длиннее 64 байт.
 *   A2. Полезная нагрузка FCM (buildFcmMessage, без сети): только data (без notification), все значения —
 *      строки, readAt строкой; priority NORMAL, ttl 3600s, collapse_key read-<C>; message/call не изменились.
 *   B. Выбор получателей (sendPushToUsers с подменёнными sendApns/sendFcm): iOS-alert-токены и Android
 *      (FCM), без VoIP, без отозванных устройств, без excludeDeviceIds.
 *   C. Маршруты на настоящих Redis/BullMQ (воркера пушей в тестовой среде нет — задачи лежат в очереди):
 *      mark-conversation-read и receipts(READ) ставят ровно одну задачу, исключая устройство-читатель;
 *      нет push-токенов / читатель — единственное push-устройство / ничего не изменилось / DELIVERED /
 *      уже прочитано / свои сообщения / посторонний в секретке — задач нет и окно дребезга не занято;
 *      дребезг: 1-е событие сразу, 2-е — одна отложенная задача на конец окна, 3-е — ничего,
 *      после окна — снова сразу; хвост сам занимает следующее окно; секретная беседа — так же, без записи в БД.
 *   D. Сокет-событие conversation:read-self (настоящие socket.io-клиенты, в комнаты бесед НЕ входят):
 *      приходит на все сокеты читающего человека (и на само читающее устройство, byDeviceId), ни одного —
 *      собеседнику и постороннему; без дребезга; при «нечего читать» / DELIVERED / постороннем в секретке —
 *      нет; без push-токенов — есть. И сквозной путь задача → воркер (attachReadAt) → sendPushToUsers:
 *      readAt в пуше РОВНО тот же, что в сокет-событии; FCM уходит на Android, APNs на iPhone, кроме читателя.
 *   E. Ревью матрицы (читатель × устройство): исключение из пуша решает воркер — устройство ПОСЛЕДНЕГО
 *      прочтения (хвост, свернувший айфон и Android, доходит до айфона); ничья в одну мс / неизвестный
 *      читатель — никого не исключать; догон при подключении сокета (replay: true, без byDeviceId, только
 *      свои беседы, обычные и секретные, readAt не откатывается); пуш о сообщении несёт sentAt = createdAt.
 *
 * Запускать ТОЛЬКО в изолированной среде (guard.ts не пустит к боевым БД/Redis):
 *   test/secret-env/secret-test.sh run test/read-sync.integration.test.ts
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { getPushQueue } from "../src/jobs/queue";
import { buildRequest, type ApnsConfig } from "../src/push/apns";
import { buildFcmMessage } from "../src/push/fcm";
import { sendPushToUsers } from "../src/push";
import {
  READ_SYNC_WINDOW_MS,
  attachReadAt,
  notifyConversationRead,
  resolveReadExclusion,
} from "../src/push/readSync";
import { io as ioClient } from "socket.io-client";

// Подмена экспортов: index.ts зовёт apns_1.sendApns(...)/fcm_1.sendFcm(...) в момент вызова. `import * as` в CJS
// даёт копию, а не живые экспорты — берём настоящий объект через require.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const apnsExports = require("../src/push/apns") as { sendApns: (...a: any[]) => Promise<any> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fcmExports = require("../src/push/fcm") as { sendFcm: (...a: any[]) => Promise<any> };

const RUN = `ebst_rs_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (t: number) => sleep(Math.max(0, t - Date.now()));

let baseUrl = "";

type Resp = { status: number; body: any };
async function call(method: "GET" | "POST", path: string, opts: { token: string; device?: string; body?: unknown }): Promise<Resp> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
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

type U = { id: string; token: string };
let seq = 0;
async function mkUser(tag: string): Promise<U> {
  seq += 1;
  const user = await prisma.user.create({ data: { username: `${RUN}_${tag}_${seq}`, passwordHash: `x_${crypto.randomUUID()}` } });
  return { id: user.id, token: signAccessToken({ sub: user.id, tokenId: crypto.randomUUID() }) };
}
async function mkDevice(
  u: U,
  tag: string,
  push: { token?: string; provider?: string; voip?: string; revoked?: boolean } = {},
): Promise<string> {
  const id = `${RUN}-${tag}`;
  await prisma.userDevice.create({
    data: {
      id,
      userId: u.id,
      name: `${RUN} ${tag}`,
      platform: "test",
      publicKey: crypto.randomBytes(32).toString("base64"),
      ...(push.token ? { pushToken: push.token, pushProvider: push.provider ?? "apns" } : {}),
      ...(push.voip ? { pushVoipToken: push.voip } : {}),
      ...(push.revoked ? { revokedAt: new Date() } : {}),
    },
  });
  return id;
}
const tok = () => crypto.randomBytes(32).toString("hex");

async function mkConv(a: U, b: U, opts: { secret?: boolean } = {}): Promise<string> {
  const c = await prisma.conversation.create({
    data: {
      isGroup: false,
      isSecret: Boolean(opts.secret),
      createdById: a.id,
      participants: { create: [{ userId: a.id }, { userId: b.id }] },
    } as any,
  });
  return c.id;
}
const mkMsg = async (conversationId: string, senderId: string) =>
  (await prisma.message.create({ data: { conversationId, senderId, content: "x" } })).id;

/** Задачи read-sync по беседе (воркера нет — лежат в очереди; delayed — отложенные «хвосты»). */
async function readJobs(conversationId: string) {
  const jobs = await getPushQueue().getJobs(["waiting", "delayed", "active", "completed", "failed", "prioritized", "paused"]);
  return jobs
    .filter((j: any) => j?.data?.payload?.kind === "read" && j?.data?.payload?.conversationId === conversationId)
    .sort((a: any, b: any) => a.timestamp - b.timestamp);
}
/** Ждём ровно n задач (enqueuePush ставит их fire-and-forget после ответа маршрута). */
async function expectJobs(conversationId: string, n: number, ms = 2500) {
  const t0 = Date.now();
  let jobs = await readJobs(conversationId);
  while (jobs.length < n && Date.now() - t0 < ms) {
    await sleep(60);
    jobs = await readJobs(conversationId);
  }
  assert.equal(jobs.length, n, `ждали ${n} задач read-sync по ${conversationId}, в очереди ${jobs.length}`);
  return jobs;
}
/** Задач нет и не появится: ждём, чтобы отложенная работа маршрута успела бы отработать. */
async function expectNoJobs(conversationId: string) {
  await sleep(700);
  assert.equal((await readJobs(conversationId)).length, 0, `в очереди не должно быть read-sync по ${conversationId}`);
}
const redisHas = async (key: string) => (await (await getRedisClient()).exists(key)) === 1;
const lastKey = (u: string, c: string) => `readsync:last:${u}:${c}`;

const markRead = (u: U, device: string | undefined, conversationId: string) =>
  call("POST", "/api/messages/mark-conversation-read", { token: u.token, ...(device ? { device } : {}), body: { conversationId } });
const receipts = (u: U, device: string | undefined, messageIds: string[], status: string) =>
  call("POST", "/api/messages/receipts", { token: u.token, ...(device ? { device } : {}), body: { messageIds, status } });

function assertCleanPayload(job: any, conversationId: string, userId: string) {
  assert.deepEqual(job.data.payload, { kind: "read", conversationId }, "в payload только kind и conversationId");
  assert.deepEqual(job.data.userIds, [userId]);
}

// ---------------------------------------------------------------- сокеты (настоящие socket.io-клиенты)
type Sock = { s: ReturnType<typeof ioClient>; events: any[]; label: string };
const openSockets: Sock[] = [];
/** Сокет человека u; deviceId — как у настоящего клиента, через did в токене. В комнаты бесед НЕ входит. */
async function connectSock(u: U, label: string, deviceId?: string): Promise<Sock> {
  const token = signAccessToken({ sub: u.id, tokenId: crypto.randomUUID(), ...(deviceId ? { did: deviceId } : {}) });
  const s = ioClient(baseUrl, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
  // Слушатель — ДО подключения: догон (replay) сервер шлёт сразу после connect.
  const sock: Sock = { s, events: [], label };
  s.on("conversation:read-self", (e: any) => sock.events.push(e));
  await new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("connect_error", reject);
  });
  openSockets.push(sock);
  return sock;
}
const evFor = (sock: Sock, conversationId: string) => sock.events.filter((e) => e?.conversationId === conversationId);
/** Ждём, пока на сокет придёт ровно n событий read-self по беседе. */
async function waitEvents(sock: Sock, conversationId: string, n: number, ms = 2500): Promise<any[]> {
  const t0 = Date.now();
  while (evFor(sock, conversationId).length < n && Date.now() - t0 < ms) await sleep(20);
  await sleep(50); // лишнее (дубль) тоже должно успеть прийти, чтобы equal его поймал
  const got = evFor(sock, conversationId);
  assert.equal(got.length, n, `${sock.label}: ждали ${n} событий read-self по ${conversationId}, пришло ${got.length}`);
  return got;
}
async function expectNoEvents(socks: Sock[], conversationId: string, waitMs = 700) {
  await sleep(waitMs);
  for (const s of socks) assert.equal(evFor(s, conversationId).length, 0, `${s.label}: не должно быть read-self по ${conversationId}`);
}

// ---------------------------------------------------------------- «воркер» с подменёнными провайдерами
type Delivered = {
  apns: string[];
  fcm: string[];
  apnsPayload: any;
  fcmPayload: any;
  fcmTargets: any[];
  apnsProviders: string[];
  exclude: string[] | undefined;
};
/** Ровно то, что делает push.worker.ts с задачей (attachReadAt → resolveReadExclusion → sendPushToUsers), но без сети. */
async function deliver(job: any): Promise<Delivered> {
  const origApns = apnsExports.sendApns;
  const origFcm = fcmExports.sendFcm;
  const out: Delivered = { apns: [], fcm: [], apnsPayload: null, fcmPayload: null, fcmTargets: [], apnsProviders: [], exclude: undefined };
  apnsExports.sendApns = async (targets: any[], payload: any) => {
    out.apns = targets.map((t) => t.deviceId).sort();
    out.apnsProviders = targets.map((t) => t.provider);
    out.apnsPayload = payload;
    return { sent: targets.length, dead: [] };
  };
  fcmExports.sendFcm = async (targets: any[], payload: any) => {
    out.fcm = targets.map((t) => t.deviceId).sort();
    out.fcmTargets = targets;
    out.fcmPayload = payload;
    return { sent: targets.length, dead: [] };
  };
  try {
    const payload = await attachReadAt(job.data.userIds, job.data.payload, job.timestamp ?? Date.now());
    out.exclude = await resolveReadExclusion(job.data.userIds, payload, job.data.excludeDeviceIds);
    await sendPushToUsers(job.data.userIds, payload, { excludeDeviceIds: out.exclude });
  } finally {
    apnsExports.sendApns = origApns;
    fcmExports.sendFcm = origFcm;
  }
  return out;
}

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

async function main() {
  console.log(`[read-sync] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[read-sync] isolated backends: ${JSON.stringify(identity)}`);

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // U — читающий человек: два iPhone (у первого ещё и VoIP-токен), Android, отозванный iPhone, устройство без токенов.
    const U = await mkUser("u");
    const V = await mkUser("v"); // собеседник, пишет сообщения, устройств нет
    const iA = await mkDevice(U, "iA", { token: tok(), voip: tok() });
    const iB = await mkDevice(U, "iB", { token: tok() });
    const aC = await mkDevice(U, "aC", { token: tok(), provider: "fcm" });
    const iD = await mkDevice(U, "iD", { token: tok(), revoked: true });
    const eE = await mkDevice(U, "eE"); // ПК (натив) без push-токенов
    // W — только Android (+ ПК без токенов); X — единственный iPhone (он же читатель); Y — iPhone, но посторонний
    // для беседы; Z — устройства без push-токенов вовсе (только ПК/веб).
    const W = await mkUser("w");
    const wA = await mkDevice(W, "wA", { token: tok(), provider: "fcm" });
    const wB = await mkDevice(W, "wB");
    const Z = await mkUser("z");
    const zA = await mkDevice(Z, "zA");
    const X = await mkUser("x");
    const xA = await mkDevice(X, "xA", { token: tok() });
    const Y = await mkUser("y");
    const yA = await mkDevice(Y, "yA", { token: tok() });

    // ================================================================ A. полезная нагрузка APNs
    console.log("A — полезная нагрузка APNs");
    const cfg: ApnsConfig = { key: "", keyId: "K", teamId: "T", bundleId: "org.eblusha.test", primaryHost: "h", fallbackHost: null };
    const tgt = (provider: "apns" | "apns-voip") => ({ userId: U.id, deviceId: iA, token: tok(), provider });
    await step("read → background, priority 5, collapse-id read-<C>, aps только content-available", async () => {
      const C = "cm0abcdefghijklmnopqrstuv";
      const req = buildRequest(cfg, tgt("apns"), { kind: "read", conversationId: C });
      assert.ok(req);
      assert.equal(req.headers["apns-push-type"], "background");
      assert.equal(req.headers["apns-priority"], "5");
      assert.equal(req.headers["apns-topic"], "org.eblusha.test");
      assert.equal(req.headers["apns-collapse-id"], `read-${C}`);
      const exp = Number(req.headers["apns-expiration"]) - Math.floor(Date.now() / 1000);
      assert.ok(exp > 600 && exp <= 3600, `apns-expiration через ${exp} с`);
      const body = JSON.parse(req.body);
      assert.deepEqual(body, { aps: { "content-available": 1 }, kind: "read", conversationId: C });
    });
    await step("readAt (число, мс) едет в теле рядом с kind/conversationId; остальное без изменений", async () => {
      const C = "cm0abcdefghijklmnopqrstuv";
      const req = buildRequest(cfg, tgt("apns"), { kind: "read", conversationId: C, readAt: 1_700_000_000_123 });
      assert.ok(req);
      assert.deepEqual(JSON.parse(req.body), {
        aps: { "content-available": 1 },
        kind: "read",
        conversationId: C,
        readAt: 1_700_000_000_123,
      });
      assert.equal(req.headers["apns-push-type"], "background");
    });
    await step("в теле нет ни alert/sound/badge, ни текста", async () => {
      const req = buildRequest(cfg, tgt("apns"), { kind: "read", conversationId: "cm0abcdefghijklmnopqrstuv" });
      assert.ok(req);
      for (const bad of ["alert", "sound", "badge", "body", "title", "senderName", "preview", "messageId"]) {
        assert.ok(!req.body.includes(`"${bad}"`), `в теле не должно быть ${bad}`);
      }
    });
    await step("read не уходит на VoIP-токен", async () => {
      assert.equal(buildRequest(cfg, tgt("apns-voip"), { kind: "read", conversationId: "cm0abcdefghijklmnopqrstuv" }), null);
    });
    await step("collapse-id не длиннее 64 байт, даже при длинном conversationId", async () => {
      const req = buildRequest(cfg, tgt("apns"), { kind: "read", conversationId: "x".repeat(200) });
      assert.ok(req);
      assert.ok(Buffer.byteLength(req.headers["apns-collapse-id"] ?? "") <= 64);
    });

    // ================================================================ A2. полезная нагрузка FCM
    console.log("A2 — полезная нагрузка FCM");
    const fcmTgt = { userId: U.id, deviceId: aC, token: "fcm-token-1", provider: "fcm" as const };
    await step("read → только data {kind, conversationId, readAt-строкой}; NORMAL, ttl 3600s, collapse_key read-<C>", async () => {
      const C = "cm0abcdefghijklmnopqrstuv";
      const msg = buildFcmMessage(fcmTgt, { kind: "read", conversationId: C, readAt: 1_700_000_000_123 });
      assert.deepEqual(msg, {
        token: "fcm-token-1",
        data: { kind: "read", conversationId: C, readAt: "1700000000123" },
        android: { priority: "NORMAL", ttl: "3600s", collapse_key: `read-${C}` },
      });
      // ни notification-блока (ни на верхнем уровне, ни в android), ни текста/имён
      const raw = JSON.stringify({ message: msg });
      for (const bad of ["notification", "title", "body", "senderName", "preview", "messageId", "sound"]) {
        assert.ok(!raw.includes(`"${bad}"`), `в FCM-сообщении не должно быть ${bad}`);
      }
      for (const v of Object.values(msg.data)) assert.equal(typeof v, "string", "FCM data — только строки");
    });
    await step("read без readAt (старый путь) → в data только kind+conversationId", async () => {
      const msg = buildFcmMessage(fcmTgt, { kind: "read", conversationId: "cm0abcdefghijklmnopqrstuv" });
      assert.deepEqual(msg.data, { kind: "read", conversationId: "cm0abcdefghijklmnopqrstuv" });
    });
    await step("контроль: message — NORMAL/86400s без collapse_key, call — HIGH/60s (как было)", async () => {
      const m = buildFcmMessage(fcmTgt, { kind: "message", conversationId: "c", messageId: "m", senderId: "s", senderName: "n" });
      assert.deepEqual(m.android, { priority: "NORMAL", ttl: "86400s" });
      assert.deepEqual(m.data, { kind: "message", conversationId: "c", messageId: "m", senderId: "s", senderName: "n" });
      const c = buildFcmMessage(fcmTgt, { kind: "call", conversationId: "c", callerId: "s", callerName: "n", video: true });
      assert.deepEqual(c.android, { priority: "HIGH", ttl: "60s" });
      assert.equal(c.data.video, "true");
      const cc = buildFcmMessage(fcmTgt, { kind: "call-cancel", conversationId: "c" });
      assert.deepEqual(cc.android, { priority: "HIGH", ttl: "60s" });
    });
    await step("message с sentAt (часы сервера) → в FCM data строкой, в APNs числом рядом с aps; alert тот же", async () => {
      const p = { kind: "message", conversationId: "c", messageId: "m", senderId: "s", senderName: "n", sentAt: 1_700_000_000_456 } as const;
      const m = buildFcmMessage(fcmTgt, p);
      assert.equal(m.data.sentAt, "1700000000456");
      assert.deepEqual(m.android, { priority: "NORMAL", ttl: "86400s" });
      const req = buildRequest(cfg, tgt("apns"), p);
      assert.ok(req);
      const body = JSON.parse(req.body);
      assert.equal(body.sentAt, 1_700_000_000_456);
      assert.equal(body.aps.alert.title, "n");
      assert.equal(req.headers["apns-push-type"], "alert");
    });

    // ================================================================ B. выбор получателей
    console.log("B — выбор получателей в sendPushToUsers");
    const origApns = apnsExports.sendApns;
    const origFcm = fcmExports.sendFcm;
    try {
      let apnsSeen: any[] = [];
      let fcmSeen: any[] = [];
      apnsExports.sendApns = async (targets: any[]) => {
        apnsSeen = targets;
        return { sent: targets.length, dead: [] };
      };
      fcmExports.sendFcm = async (targets: any[]) => {
        fcmSeen = targets;
        return { sent: targets.length, dead: [] };
      };
      const pick = async (exclude?: string[]) => {
        apnsSeen = [];
        fcmSeen = [];
        await sendPushToUsers([U.id], { kind: "read", conversationId: "cm0abcdefghijklmnopqrstuv" }, { excludeDeviceIds: exclude });
        return {
          apns: apnsSeen.map((t) => `${t.deviceId}:${t.provider}`).sort(),
          fcm: fcmSeen.map((t) => `${t.deviceId}:${t.provider}`).sort(),
        };
      };
      await step("read уходит на alert-токены: оба iPhone (APNs) и Android (FCM); без VoIP, без отозванного", async () => {
        const r = await pick();
        assert.deepEqual(r.apns, [`${iA}:apns`, `${iB}:apns`].sort());
        assert.deepEqual(r.fcm, [`${aC}:fcm`]);
        assert.ok(![...r.apns, ...r.fcm].some((x) => x.startsWith(iD)));
        assert.ok(!r.apns.some((x) => x.includes("apns-voip")));
      });
      await step("excludeDeviceIds убирает читающее устройство (iPhone или Android)", async () => {
        const r = await pick([iA]);
        assert.deepEqual(r.apns, [`${iB}:apns`]);
        assert.deepEqual(r.fcm, [`${aC}:fcm`]);
        const r2 = await pick([aC]);
        assert.deepEqual(r2.apns, [`${iA}:apns`, `${iB}:apns`].sort());
        assert.deepEqual(r2.fcm, []);
      });
      await step("контроль: message по-прежнему идёт и на Android, call — на VoIP", async () => {
        apnsSeen = [];
        fcmSeen = [];
        await sendPushToUsers([U.id], { kind: "message", conversationId: "c", messageId: "m", senderId: "s", senderName: "n" });
        assert.equal(fcmSeen.length, 1);
        assert.equal(apnsSeen.length, 2);
        apnsSeen = [];
        await sendPushToUsers([U.id], { kind: "call", conversationId: "c", callerId: "s", callerName: "n", video: false });
        assert.ok(apnsSeen.some((t) => t.provider === "apns-voip"));
      });
    } finally {
      apnsExports.sendApns = origApns;
      fcmExports.sendFcm = origFcm;
    }

    // ================================================================ C. маршруты, Redis, очередь
    console.log("C — mark-conversation-read / receipts, дребезг");
    const C1 = await mkConv(U, V); // основная временная шкала
    const C1b = await mkConv(U, V); // «хвост занимает следующее окно»
    let t0 = 0;
    await step("1-е «прочитано» → сразу одна задача: только kind+conversationId, читатель iA исключён", async () => {
      await mkMsg(C1, V.id);
      await mkMsg(C1b, V.id);
      t0 = Date.now();
      const [r1, r1b] = await Promise.all([markRead(U, iA, C1), markRead(U, iA, C1b)]);
      assert.equal(r1.status, 200);
      assert.equal(r1b.status, 200);
      const jobs = await expectJobs(C1, 1);
      assertCleanPayload(jobs[0], C1, U.id);
      assert.deepEqual(jobs[0]!.data.excludeDeviceIds, [iA]);
      assert.ok(!jobs[0]!.opts.delay, "первый пуш уходит без задержки");
      await expectJobs(C1b, 1);
    });
    let tEvent2 = 0;
    await step("воркер подставляет readAt = момент прочтения (а не момент отправки)", async () => {
      const at = (await attachReadAt([U.id], { kind: "read", conversationId: C1 }, 1)) as { readAt?: number };
      assert.ok(typeof at.readAt === "number" && at.readAt >= t0 && at.readAt <= Date.now(), `readAt=${at.readAt}, t0=${t0}`);
      // чужие виды пушей не трогаем, уже проставленный readAt не перезаписываем
      const msg = { kind: "message", conversationId: C1, messageId: "m", senderId: "s", senderName: "n" } as const;
      assert.equal(await attachReadAt([U.id], msg, 1), msg);
      const fixed = { kind: "read", conversationId: C1, readAt: 42 } as const;
      assert.equal(await attachReadAt([U.id], fixed, 1), fixed);
      // нет записи в Redis → время постановки задачи, а не «сейчас»
      const none = (await attachReadAt([U.id], { kind: "read", conversationId: "cm0nosuchconversation00000" }, 777)) as { readAt?: number };
      assert.equal(none.readAt, 777);
    });
    await step("2-е внутри окна → одна ОТЛОЖЕННАЯ задача на конец окна, 3-е → ничего", async () => {
      for (const c of [C1, C1b]) await mkMsg(c, V.id);
      tEvent2 = Date.now();
      await Promise.all([markRead(U, iA, C1), markRead(U, iA, C1b)]);
      const jobs = await expectJobs(C1, 2);
      const tail = jobs[1]!;
      assertCleanPayload(tail, C1, U.id);
      const delay = tail.opts.delay ?? 0;
      assert.ok(delay > 3000 && delay <= READ_SYNC_WINDOW_MS + 100, `задержка хвоста ${delay} мс — должна упасть на конец 5-секундного окна`);
      assert.equal(await tail.getState(), "delayed");
      assert.deepEqual(tail.data.excludeDeviceIds, [iA]);
      await expectJobs(C1b, 2);
      for (const c of [C1, C1b]) await mkMsg(c, V.id);
      await Promise.all([markRead(U, iA, C1), markRead(U, iA, C1b)]);
      await sleep(700);
      assert.equal((await readJobs(C1)).length, 2, "3-е событие внутри окна не добавляет задач");
      assert.equal((await readJobs(C1b)).length, 2);
      // Хвост уйдёт позже, но readAt в нём — время ПОСЛЕДНЕГО прочтения (3-го, свёрнутого), не 1-го и не отправки:
      // сообщения, пришедшие после него, ещё не прочитаны, их баннеры приложение не тронет.
      const at = (await attachReadAt([U.id], { kind: "read", conversationId: C1 }, 1)) as { readAt?: number };
      assert.ok(typeof at.readAt === "number" && at.readAt >= tEvent2 && at.readAt <= Date.now(), `readAt=${at.readAt}`);
    });
    await step("хвост сам занимает следующее окно: событие после конца 1-го окна НЕ бьёт пушем впритык", async () => {
      await sleepUntil(t0 + 5600);
      await mkMsg(C1b, V.id);
      await markRead(U, iA, C1b);
      const jobs = await expectJobs(C1b, 3);
      const delay = jobs[2]!.opts.delay ?? 0;
      assert.ok(delay > 3000 && delay <= READ_SYNC_WINDOW_MS + 100, `задержка ${delay} мс`);
    });
    await step("после окна — снова сразу (без задержки)", async () => {
      await sleepUntil(t0 + 10400); // окно C1 (с продлением хвостом) закончилось к ~t0+10 с
      await mkMsg(C1, V.id);
      await markRead(U, iA, C1);
      const jobs = await expectJobs(C1, 3);
      assert.ok(!jobs[2]!.opts.delay, "после окна пуш уходит сразу");
    });

    await step("повторный mark без новых непрочитанных → задач нет", async () => {
      const C = await mkConv(U, V); // сообщений нет — менять нечего
      assert.equal((await markRead(U, iA, C)).status, 200);
      await expectNoJobs(C);
      assert.equal(await redisHas(lastKey(U.id, C)), false, "окно дребезга не занято");
    });
    await step("у человека нет push-токенов вовсе → задач нет, окно не занято", async () => {
      const C = await mkConv(Z, V);
      await mkMsg(C, V.id);
      assert.equal((await markRead(Z, zA, C)).status, 200);
      await expectNoJobs(C);
      assert.equal(await redisHas(lastKey(Z.id, C)), false);
    });
    await step("только Android (читают на другом устройстве) → задача, уходит на FCM", async () => {
      const C = await mkConv(W, V);
      await mkMsg(C, V.id);
      assert.equal((await markRead(W, wB, C)).status, 200);
      const jobs = await expectJobs(C, 1);
      assertCleanPayload(jobs[0], C, W.id);
      assert.deepEqual(jobs[0]!.data.excludeDeviceIds, [wB]);
      const d = await deliver(jobs[0]);
      assert.deepEqual(d.fcm, [wA]);
      assert.deepEqual(d.apns, []);
    });
    await step("читатель — единственное push-устройство (Android) → задач нет, окно не занято", async () => {
      const C = await mkConv(W, V);
      await mkMsg(C, V.id);
      assert.equal((await markRead(W, wA, C)).status, 200);
      await expectNoJobs(C);
      assert.equal(await redisHas(lastKey(W.id, C)), false);
    });
    await step("читатель — единственный iPhone → задач нет, окно не занято", async () => {
      const C = await mkConv(X, V);
      await mkMsg(C, V.id);
      assert.equal((await markRead(X, xA, C)).status, 200);
      await expectNoJobs(C);
      assert.equal(await redisHas(lastKey(X.id, C)), false);
    });
    await step("то же без определённого устройства (нет X-Device-Id) → пуш уходит, исключений нет", async () => {
      const C = await mkConv(X, V);
      await mkMsg(C, V.id);
      assert.equal((await markRead(X, undefined, C)).status, 200);
      const jobs = await expectJobs(C, 1);
      assertCleanPayload(jobs[0], C, X.id);
      assert.equal(jobs[0]!.data.excludeDeviceIds, undefined);
    });

    await step("receipts DELIVERED → задач нет; READ чужого сообщения → задача; повтор READ уже прочитанного → нет", async () => {
      const C = await mkConv(U, V);
      const m = await mkMsg(C, V.id);
      assert.equal((await receipts(U, iA, [m], "DELIVERED")).status, 200);
      await expectNoJobs(C);
      assert.equal((await receipts(U, iA, [m], "READ")).status, 200);
      const jobs = await expectJobs(C, 1);
      assertCleanPayload(jobs[0], C, U.id);
      assert.deepEqual(jobs[0]!.data.excludeDeviceIds, [iA]);

      const C2 = await mkConv(U, V);
      const m2 = await mkMsg(C2, V.id);
      await prisma.messageReceipt.create({ data: { messageId: m2, userId: U.id, status: "READ" } });
      assert.equal((await receipts(U, iA, [m2], "READ")).status, 200);
      await expectNoJobs(C2);
      assert.equal(await redisHas(lastKey(U.id, C2)), false);
    });
    await step("receipts READ на СВОЁ сообщение → задач нет", async () => {
      const C = await mkConv(U, V);
      const own = await mkMsg(C, U.id);
      assert.equal((await receipts(U, iA, [own], "READ")).status, 200);
      await expectNoJobs(C);
    });

    await step("секретная беседа: участник → задача, в БД ничего (ни Message, ни квитанций)", async () => {
      const S = await mkConv(U, V, { secret: true });
      assert.equal((await markRead(U, iA, S)).status, 200);
      const jobs = await expectJobs(S, 1);
      assertCleanPayload(jobs[0], S, U.id);
      assert.deepEqual(jobs[0]!.data.excludeDeviceIds, [iA]);
      assert.equal(await prisma.message.count({ where: { conversationId: S } }), 0);
      assert.equal(await prisma.messageReceipt.count({ where: { message: { conversationId: S } } }), 0);
    });
    await step("секретная беседа: не участник (с iPhone) → 200, но задач нет и окно не занято", async () => {
      const S = await mkConv(U, V, { secret: true });
      assert.equal((await markRead(Y, yA, S)).status, 200);
      await expectNoJobs(S);
      assert.equal(await redisHas(lastKey(Y.id, S)), false);
    });
    await step("секретная беседа: дребезг тот же (2-е событие → один отложенный хвост)", async () => {
      const S = await mkConv(U, V, { secret: true });
      await markRead(U, iB, S);
      await markRead(U, iB, S);
      await markRead(U, iB, S);
      const jobs = await expectJobs(S, 2);
      assert.ok(!jobs[0]!.opts.delay);
      assert.ok((jobs[1]!.opts.delay ?? 0) > 3000);
      assert.deepEqual(jobs[1]!.data.excludeDeviceIds, [iB]);
    });

    // ================================================================ D. сокет + сквозной путь до провайдеров
    console.log("D — сокет conversation:read-self и путь задача → воркер → провайдеры");
    // Ни один сокет не входит в комнату беседы (conversation:join не шлём): событие обязано дойти
    // через комнату пользователя, где бы клиент ни «сидел».
    const sUi = await connectSock(U, "U/iPhone iA", iA);
    const sUa = await connectSock(U, "U/Android aC", aC);
    const sUpc = await connectSock(U, "U/ПК eE", eE);
    const sUweb = await connectSock(U, "U/веб без устройства");
    const sV = await connectSock(V, "V (собеседник)");
    const sY = await connectSock(Y, "Y (посторонний)", yA);
    const sZ = await connectSock(Z, "Z (без push)", zA);
    const allU = [sUi, sUa, sUpc, sUweb];

    await step("ПК читает → событие на ВСЕ сокеты U (и на сам ПК), больше никому; readAt = момент запроса; byDeviceId = ПК", async () => {
      const C = await mkConv(U, V);
      await mkMsg(C, V.id);
      const before = Date.now();
      assert.equal((await markRead(U, eE, C)).status, 200);
      const after = Date.now();
      const evs: any[] = [];
      for (const s of allU) evs.push((await waitEvents(s, C, 1))[0]);
      for (const e of evs) {
        assert.deepEqual(Object.keys(e).sort(), ["byDeviceId", "conversationId", "readAt"], "в событии ровно три поля");
        assert.equal(e.conversationId, C);
        assert.equal(e.byDeviceId, eE);
        assert.equal(typeof e.readAt, "number");
        assert.ok(e.readAt >= before && e.readAt <= after, `readAt=${e.readAt} вне [${before}, ${after}]`);
        assert.equal(e.readAt, evs[0].readAt, "один readAt на всех");
      }
      await expectNoEvents([sV, sY, sZ], C, 300);

      // Тот же readAt — в пуше: Android (FCM) и оба iPhone (APNs alert, не VoIP); у ПК токена нет.
      const jobs = await expectJobs(C, 1);
      assert.deepEqual(jobs[0]!.data.excludeDeviceIds, [eE]);
      const d = await deliver(jobs[0]);
      assert.deepEqual(d.fcm, [aC]);
      assert.deepEqual(d.apns, [iA, iB].sort());
      assert.ok(d.apnsProviders.every((p) => p === "apns"), `APNs-провайдеры: ${d.apnsProviders}`);
      assert.deepEqual(d.fcmPayload, { kind: "read", conversationId: C, readAt: evs[0].readAt });
      assert.deepEqual(d.apnsPayload, d.fcmPayload);
      // (as any: deepEqual выше сузил тип до {kind: string}, а здесь нужен PushPayload — это тот же объект)
      assert.deepEqual(buildFcmMessage(d.fcmTargets[0], d.fcmPayload as any).data, {
        kind: "read",
        conversationId: C,
        readAt: String(evs[0].readAt),
      });
    });
    await step("iPhone читает → FCM на Android, APNs только второму iPhone; byDeviceId = iA", async () => {
      const C = await mkConv(U, V);
      await mkMsg(C, V.id);
      await markRead(U, iA, C);
      for (const s of allU) assert.equal((await waitEvents(s, C, 1))[0].byDeviceId, iA);
      const d = await deliver((await expectJobs(C, 1))[0]);
      assert.deepEqual(d.fcm, [aC]);
      assert.deepEqual(d.apns, [iB]);
    });
    await step("Android читает → FCM никому (Android один), APNs обоим iPhone; byDeviceId = aC", async () => {
      const C = await mkConv(U, V);
      await mkMsg(C, V.id);
      await markRead(U, aC, C);
      for (const s of allU) assert.equal((await waitEvents(s, C, 1))[0].byDeviceId, aC);
      const d = await deliver((await expectJobs(C, 1))[0]);
      assert.deepEqual(d.fcm, []);
      assert.deepEqual(d.apns, [iA, iB].sort());
    });
    await step("читатель не определён (нет X-Device-Id) → в событии нет byDeviceId; пуш всем трём", async () => {
      const C = await mkConv(U, V);
      await mkMsg(C, V.id);
      await markRead(U, undefined, C);
      for (const s of allU) {
        const [e] = await waitEvents(s, C, 1);
        assert.deepEqual(Object.keys(e).sort(), ["conversationId", "readAt"]);
      }
      const d = await deliver((await expectJobs(C, 1))[0]);
      assert.deepEqual(d.fcm, [aC]);
      assert.deepEqual(d.apns, [iA, iB].sort());
    });
    await step("без дребезга: 2-е прочтение внутри окна → 2-е событие сразу, readAt растёт; хвост-пуш несёт readAt 2-го", async () => {
      const C = await mkConv(U, V);
      await mkMsg(C, V.id);
      await markRead(U, eE, C);
      const [e1] = await waitEvents(sUa, C, 1);
      await sleep(30);
      await mkMsg(C, V.id);
      await markRead(U, eE, C);
      const evs = await waitEvents(sUa, C, 2, 1000); // окно пуша 5 с — событие его не ждёт
      const e2 = evs[1];
      assert.ok(e2.readAt > e1.readAt, `readAt не вырос: ${e1.readAt} → ${e2.readAt}`);
      const jobs = await expectJobs(C, 2);
      assert.ok((jobs[1]!.opts.delay ?? 0) > 3000, "пуш-хвост отложен на конец окна");
      const d = await deliver(jobs[1]);
      assert.equal(d.fcmPayload.readAt, e2.readAt);
      assert.equal(d.apnsPayload.readAt, e2.readAt);
    });
    await step("receipts: READ чужих → по событию на беседу (две беседы одним запросом); DELIVERED/повтор/SEEN прочитанного/своё → нет", async () => {
      const C = await mkConv(U, V);
      const C2 = await mkConv(U, V);
      const m = await mkMsg(C, V.id);
      const m2 = await mkMsg(C2, V.id);
      await receipts(U, iA, [m, m2], "DELIVERED");
      await expectNoEvents(allU, C, 500);
      await receipts(U, iA, [m, m2], "READ");
      for (const s of allU) {
        assert.equal((await waitEvents(s, C, 1))[0].byDeviceId, iA);
        assert.equal((await waitEvents(s, C2, 1))[0].byDeviceId, iA);
      }
      await receipts(U, iA, [m], "READ");
      await receipts(U, iA, [m], "SEEN");
      await receipts(U, iA, [await mkMsg(C, U.id)], "READ");
      await sleep(600);
      for (const s of allU) assert.equal(evFor(s, C).length, 1, `${s.label}: повтор/своё не дают событий`);
      await expectNoEvents([sV, sY, sZ], C, 0);
    });
    await step("mark-conversation-read без новых непрочитанных → события нет", async () => {
      const C = await mkConv(U, V);
      await markRead(U, eE, C);
      await expectNoEvents(allU, C);
    });
    await step("секретка: участник → событие на все сокеты U + пуш FCM/APNs; посторонний → ни у кого ничего", async () => {
      const S = await mkConv(U, V, { secret: true });
      assert.equal((await markRead(U, eE, S)).status, 200);
      for (const s of allU) assert.equal((await waitEvents(s, S, 1))[0].byDeviceId, eE);
      await expectNoEvents([sV, sY, sZ], S, 0);
      const d = await deliver((await expectJobs(S, 1))[0]);
      assert.deepEqual(d.fcm, [aC]);
      assert.deepEqual(d.apns, [iA, iB].sort());
      const S2 = await mkConv(U, V, { secret: true });
      assert.equal((await markRead(Y, yA, S2)).status, 200);
      await expectNoEvents([...allU, sV, sY, sZ], S2);
    });
    await step("у человека нет push-токенов → сокет-событие всё равно приходит, задач нет", async () => {
      const C = await mkConv(Z, V);
      await mkMsg(C, V.id);
      await markRead(Z, zA, C);
      assert.equal((await waitEvents(sZ, C, 1))[0].byDeviceId, zA);
      await expectNoJobs(C);
    });
    await step("readAt в Redis только растёт: более раннее прочтение не затирает позднее", async () => {
      const C = await mkConv(U, V);
      const T = Date.now();
      const readAtNow = async () => ((await attachReadAt([U.id], { kind: "read", conversationId: C }, 1)) as { readAt?: number }).readAt;
      await notifyConversationRead({ userId: U.id, conversationId: C, readerDeviceId: eE, readAt: T });
      assert.equal(await readAtNow(), T);
      await notifyConversationRead({ userId: U.id, conversationId: C, readerDeviceId: eE, readAt: T - 1000 });
      assert.equal(await readAtNow(), T, "раннее не затёрло позднее");
      await notifyConversationRead({ userId: U.id, conversationId: C, readerDeviceId: eE, readAt: T + 7 });
      assert.equal(await readAtNow(), T + 7);
      const ttl = await (await getRedisClient()).pTTL(`readsync:at:${U.id}:${C}`);
      assert.ok(ttl > 3_500_000 && ttl <= 3_600_000, `TTL readAt ${ttl} мс — час`);
    });

    // ================================================================ E. ревью матрицы
    console.log("E — исключение по последнему читателю, догон при подключении, sentAt");
    await step("хвост свернул прочтения айфона и Android → пуш получает айфон, исключён только последний (Android)", async () => {
      const C = await mkConv(U, V);
      await mkMsg(C, V.id);
      await markRead(U, iA, C); // передний пуш
      await expectJobs(C, 1);
      await mkMsg(C, V.id);
      await markRead(U, iB, C); // хвост поставил iB
      const jobs = await expectJobs(C, 2);
      assert.deepEqual(jobs[1]!.data.excludeDeviceIds, [iB], "маршрут исключил того, кто поставил хвост");
      await mkMsg(C, V.id); // сообщение, пришедшее айфону iB между его прочтением и прочтением на Android
      await markRead(U, aC, C); // свёрнуто в тот же хвост
      const evs = await waitEvents(sUpc, C, 3);
      const d = await deliver(jobs[1]);
      assert.deepEqual(d.exclude, [aC], "воркер исключает устройство ПОСЛЕДНЕГО прочтения");
      assert.deepEqual(d.apns, [iA, iB].sort(), "iB получает хвост: после него прочитали на Android");
      assert.deepEqual(d.fcm, [], "Android прочитал последним — ему пуш не нужен");
      assert.equal(d.apnsPayload.readAt, evs[2].readAt, "readAt хвоста — последнего прочтения");
    });
    await step("исключение: ничья в одну мс разными устройствами / читатель неизвестен → никого; раннее не перебивает", async () => {
      const C = await mkConv(U, V);
      const rd = { kind: "read", conversationId: C } as const;
      const T = Date.now();
      await notifyConversationRead({ userId: U.id, conversationId: C, readerDeviceId: iA, readAt: T });
      assert.deepEqual(await resolveReadExclusion([U.id], rd, ["job"]), [iA]);
      await notifyConversationRead({ userId: U.id, conversationId: C, readerDeviceId: iA, readAt: T });
      assert.deepEqual(await resolveReadExclusion([U.id], rd, ["job"]), [iA], "повтор того же устройства — по-прежнему оно");
      await notifyConversationRead({ userId: U.id, conversationId: C, readerDeviceId: aC, readAt: T });
      assert.equal(await resolveReadExclusion([U.id], rd, ["job"]), undefined, "ничья — исключать некого");
      await notifyConversationRead({ userId: U.id, conversationId: C, readerDeviceId: aC, readAt: T + 5 });
      assert.deepEqual(await resolveReadExclusion([U.id], rd, ["job"]), [aC]);
      await notifyConversationRead({ userId: U.id, conversationId: C, readerDeviceId: iB, readAt: T + 1 });
      assert.deepEqual(await resolveReadExclusion([U.id], rd, ["job"]), [aC], "более раннее прочтение читателя не меняет");
      await notifyConversationRead({ userId: U.id, conversationId: C, readerDeviceId: null, readAt: T + 9 });
      assert.equal(await resolveReadExclusion([U.id], rd, ["job"]), undefined, "неизвестный читатель — никого");
      assert.deepEqual(
        await resolveReadExclusion([U.id], { kind: "read", conversationId: "cm0nosuchconversation00000" }, ["job"]),
        ["job"],
        "записи нет — как решил маршрут",
      );
      const msg = { kind: "message", conversationId: C, messageId: "m", senderId: "s", senderName: "n" } as const;
      assert.deepEqual(await resolveReadExclusion([U.id], msg, ["job"]), ["job"], "не read — не трогаем");
    });
    await step("догон: новый сокет получает прочтения (обычное и секретку) с replay:true без byDeviceId; живые — нет; чужой — ничего", async () => {
      const C = await mkConv(U, V);
      await mkMsg(C, V.id);
      await markRead(U, iA, C);
      const [live] = await waitEvents(sUa, C, 1);
      const S = await mkConv(U, V, { secret: true });
      await markRead(U, eE, S);
      const [liveS] = await waitEvents(sUa, S, 1);
      const fresh = await connectSock(U, "U/ПК после сна", eE);
      const [r] = await waitEvents(fresh, C, 1);
      assert.deepEqual(r, { conversationId: C, readAt: live.readAt, replay: true });
      const [rs] = await waitEvents(fresh, S, 1);
      assert.deepEqual(rs, { conversationId: S, readAt: liveS.readAt, replay: true });
      await sleep(150);
      assert.equal(evFor(sUa, C).length, 1, "уже подключённым догон не шлётся");
      const freshV = await connectSock(V, "V после сна");
      await expectNoEvents([freshV], C, 400);
      await expectNoEvents([freshV], S, 0);
    });
    await step("догон: readAt беседы — самого позднего прочтения (не откатывается), старше суток — нет", async () => {
      const C = await mkConv(U, V);
      await mkMsg(C, V.id);
      await markRead(U, iA, C);
      await sleep(20);
      await mkMsg(C, V.id);
      await markRead(U, aC, C);
      const live = await waitEvents(sUa, C, 2);
      // Старое (25 ч назад) прочтение другой беседы — в догон не попадает.
      const Old = await mkConv(U, V);
      await (await getRedisClient()).zAdd(`readsync:recent:${U.id}`, { score: Date.now() - 25 * 3_600_000, value: Old });
      const fresh = await connectSock(U, "U/телефон после смены сети", aC);
      const [r] = await waitEvents(fresh, C, 1);
      assert.equal(r.readAt, Math.max(live[0].readAt, live[1].readAt));
      await expectNoEvents([fresh], Old, 300);
    });
    await step("пуш о сообщении несёт sentAt = createdAt сообщения (часы сервера)", async () => {
      const C = await mkConv(U, V);
      const r = await call("POST", "/api/conversations/send", { token: V.token, body: { conversationId: C, type: "TEXT", content: "hi" } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const msg = r.body.message;
      let job: any = null;
      const t0 = Date.now();
      while (!job && Date.now() - t0 < 2500) {
        job = await getPushQueue().getJob(`msg-${msg.id}`);
        if (!job) await sleep(60);
      }
      assert.ok(job, "задача пуша о сообщении в очереди");
      assert.equal(job.data.payload.kind, "message");
      assert.equal(job.data.payload.sentAt, new Date(msg.createdAt).getTime());
      assert.deepEqual(job.data.userIds, [U.id]);
    });
  } finally {
    for (const s of openSockets) s.s.close();
    io.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().then(
  async () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nread-sync: ${results.length - failed.length}/${results.length} ok`);
    for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
    await getPushQueue().close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(failed.length ? 1 : 0);
  },
  async (err) => {
    console.error("read-sync: CRASHED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  },
);
