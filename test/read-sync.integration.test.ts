/**
 * read-sync: «беседу прочитали на другом устройстве» → тихий пуш {kind:"read", conversationId} на iOS.
 *
 * Что проверяется:
 *   A. Полезная нагрузка APNs (buildRequest, без сети): background, priority 5, collapse-id read-<C>,
 *      aps = только content-available, в теле только kind+conversationId (ни текста, ни имён);
 *      на VoIP-токен read не уходит; collapse-id не длиннее 64 байт.
 *   B. Выбор получателей (sendPushToUsers с подменёнными sendApns/sendFcm): только iOS-alert-токены,
 *      без VoIP, без FCM, без отозванных устройств, без excludeDeviceIds.
 *   C. Маршруты на настоящих Redis/BullMQ (воркера пушей в тестовой среде нет — задачи лежат в очереди):
 *      mark-conversation-read и receipts(READ) ставят ровно одну задачу, исключая устройство-читатель;
 *      нет iOS-токенов / читатель — единственный iOS / ничего не изменилось / DELIVERED / уже прочитано /
 *      свои сообщения / посторонний в секретке — задач нет и окно дребезга не занято;
 *      дребезг: 1-е событие сразу, 2-е — одна отложенная задача на конец окна, 3-е — ничего,
 *      после окна — снова сразу; хвост сам занимает следующее окно; секретная беседа — так же, без записи в БД.
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
import { sendPushToUsers } from "../src/push";
import { READ_SYNC_WINDOW_MS } from "../src/push/readSync";

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
    await mkDevice(U, "eE");
    // W — только Android; X — единственный iPhone (он же читатель); Y — iPhone, но посторонний для беседы.
    const W = await mkUser("w");
    await mkDevice(W, "wA", { token: tok(), provider: "fcm" });
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
        return { apns: apnsSeen.map((t) => `${t.deviceId}:${t.provider}`).sort(), fcm: fcmSeen.length };
      };
      await step("read уходит на iOS-alert-токены обоих iPhone; без VoIP, без Android, без отозванного", async () => {
        const r = await pick();
        assert.deepEqual(r.apns, [`${iA}:apns`, `${iB}:apns`].sort());
        assert.equal(r.fcm, 0);
        assert.ok(!r.apns.some((x) => x.startsWith(iD)));
        assert.ok(!r.apns.some((x) => x.includes("apns-voip")));
      });
      await step("excludeDeviceIds убирает читающее устройство", async () => {
        const r = await pick([iA]);
        assert.deepEqual(r.apns, [`${iB}:apns`]);
        assert.equal(r.fcm, 0);
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
    await step("2-е внутри окна → одна ОТЛОЖЕННАЯ задача на конец окна, 3-е → ничего", async () => {
      for (const c of [C1, C1b]) await mkMsg(c, V.id);
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
    await step("у человека нет iOS-токенов (только Android) → задач нет, окно не занято", async () => {
      const C = await mkConv(W, V);
      await mkMsg(C, V.id);
      assert.equal((await markRead(W, undefined, C)).status, 200);
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
  } finally {
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
