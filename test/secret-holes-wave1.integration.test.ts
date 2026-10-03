/**
 * Дыры секретных чатов, серверная волна 1: S1 (защёлка открытого текста), S2 (форма headerJson),
 * S4 (атомарный accept + легаси-сокет secret:chat:*), S6 (DELETE секретки чистит шифротекст),
 * S8 (без пуша/notify в CANCELLED) и правки по ревью волны 1 (аварийный режим S2 «принято ⇔
 * отдаётся», порядок событий в гонке accept↔decline, пуш о пропущенном звонке в секретке,
 * availability/PATCH в секретке, 410 на легаси-создание, delete/unreact в секретке разрешены).
 *
 * Запускать ТОЛЬКО в изолированной среде (боевые БД/Redis недоступны предохранителю guard.ts):
 *   test/secret-env/secret-test.sh run test/secret-holes-wave1.integration.test.ts
 *
 * Каждая проверка — отдельный шаг; падение одного не прячет остальные. В конце — сводка и код
 * выхода (0 — все шаги прошли). Ожидание ~65 с: путь «нет ответа 60 с» (scheduleCallRingTimeout)
 * и «обрыв принятого звонка 15 с» (endActiveDirectCall) проверяются вживую.
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import {
  SECRET_INBOX_LIST_KEY_PREFIX,
  SECRET_MESSAGE_KEY_PREFIX,
  enqueueSecretMessages,
} from "../src/lib/secretInbox";
import { getPushQueue } from "../src/jobs/queue";
import { isValidSecretHeader, secretHeaderProblems } from "../src/lib/secretHeader";
// Пространством имён: контрольный прогон этого же теста на коде ДО правок (где функции
// announceSecretThreadAccepted ещё нет) должен падать шагом, а не компиляцией всего файла.
import * as secretThreadState from "../src/lib/secretThreadState";
import { getStorageProvider } from "../src/lib/storage/provider";

const RUN = `ebst_w1_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = () => crypto.randomBytes(32).toString("base64");

let baseUrl = "";
const sockets: ClientSocket[] = [];

type Resp = { status: number; body: any };
async function call(
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH",
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

type U = { id: string; username: string; token: string; dev: string };
let userSeq = 0;
async function mkUser(tag: string, extraDevices = 0): Promise<U & { devs: string[] }> {
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

/** Легаси POST /conversations {isSecret} требует initiatorDeviceId формата uuid/cuid. */
async function registerUuidDevice(u: U): Promise<string> {
  const dev = crypto.randomUUID();
  const r = await call("POST", "/api/devices/register", {
    token: u.token,
    device: dev,
    body: { deviceId: dev, name: `${RUN} legacy`, platform: "test", publicKey: b64(), identityPublicKey: b64(), prekeys: [] },
  });
  assert.ok(r.status < 300, `register uuid device: ${r.status} ${JSON.stringify(r.body)}`);
  return dev;
}

async function connect(u: { token: string }, deviceId: string): Promise<ClientSocket> {
  const s = ioClient(baseUrl, {
    auth: { token: u.token, deviceId },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(s);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("socket connect timeout")), 5000);
    s.once("connect", () => {
      clearTimeout(t);
      resolve();
    });
    s.once("connect_error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  await sleep(300); // сервер дожидается join в user:/device: комнаты асинхронно
  return s;
}

async function createSecretThread(creator: U, peer: U): Promise<string> {
  const r = await call("POST", "/api/threads/secret", { token: creator.token, device: creator.dev, body: { peerUserId: peer.id } });
  assert.ok(r.status === 201 || r.status === 200, `create thread ${r.status}`);
  return r.body.threadId as string;
}

async function createCloudDirect(a: U, b: U): Promise<string> {
  const r = await call("POST", "/api/conversations", { token: a.token, body: { participantIds: [b.id] } });
  assert.ok(r.status === 201 || r.status === 200, `create cloud ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.conversation.id as string;
}

/**
 * Легаси-беседа `isSecret:true` при type=CLOUD (как её создавал старый POST /conversations {isSecret}).
 * Сам маршрут теперь отвечает 410 — строим в БД как «худший случай» (такие могли остаться в базе).
 */
async function mkLegacySecretConv(a: U, b: U, status: "PENDING" | "ACTIVE"): Promise<string> {
  const c = await prisma.conversation.create({
    data: {
      isGroup: false,
      isSecret: true,
      secretStatus: status,
      createdById: a.id,
      participants: { create: [{ userId: a.id }, { userId: b.id }] },
    } as any,
  });
  return c.id;
}

/** Пуш-задачи «Пропущенный звонок» по беседе (в тестовой среде воркера пушей нет — задачи лежат). */
async function missedCallPushJobs(conversationId: string) {
  const jobs = await getPushQueue().getJobs(["waiting", "delayed", "prioritized", "paused", "active", "completed", "failed"]);
  return jobs.filter(
    (j: any) => j?.data?.payload?.conversationId === conversationId && j?.data?.payload?.preview === "Пропущенный звонок"
  );
}

const msgCount = (conversationId: string) => prisma.message.count({ where: { conversationId } });
const convState = async (id: string) =>
  (await prisma.conversation.findUnique({
    where: { id },
    select: { secretStatus: true, secretPeerDeviceId: true },
  })) as { secretStatus: string; secretPeerDeviceId: string | null };

type StepResult = { name: string; ok: boolean; err?: string; ms: number };
const results: StepResult[] = [];
async function step(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ok   ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message ?? String(e), ms: Date.now() - t0 });
    console.log(`  FAIL ${name}: ${e?.message ?? e}`);
  }
}

function waitEvent(s: ClientSocket, event: string, pred: (p: any) => boolean, ms: number): Promise<any | null> {
  return new Promise((resolve) => {
    const h = (p: any) => {
      if (pred(p)) {
        clearTimeout(t);
        s.off(event, h);
        resolve(p);
      }
    };
    const t = setTimeout(() => {
      s.off(event, h);
      resolve(null);
    }, ms);
    s.on(event, h);
  });
}

function secretEnvelope(toDeviceId: string, headerJson?: unknown, extra: Record<string, unknown> = {}) {
  return {
    toDeviceId,
    msgId: crypto.randomUUID(),
    ciphertext: b64(),
    createdAt: new Date().toISOString(),
    ...(headerJson !== undefined ? { headerJson } : {}),
    ...extra,
  };
}

async function main() {
  console.log(`[wave1] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[wave1] isolated backends: ${JSON.stringify(identity)}`);

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // ------------------------------------------------------------------ S1
    console.log("S1 — защёлка открытого текста");
    const A = await mkUser("a");
    const B = await mkUser("b", 1);
    const C = await mkUser("c");
    const T1 = await createSecretThread(A, B); // A↔B, PENDING
    const CL = await createCloudDirect(A, B); // обычный 1:1

    await step("S1 /conversations/send в PENDING-секретку → 409 SECRET_E2EE_ONLY", async () => {
      const r = await call("POST", "/api/conversations/send", { token: A.token, body: { conversationId: T1, type: "TEXT", content: "открытый текст" } });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, "SECRET_E2EE_ONLY");
    });
    await step("S1 /conversations/send в ACTIVE-секретку (оба участника) → 409, Message не создан", async () => {
      const acc = await call("POST", `/api/threads/secret/${T1}/accept`, { token: B.token, device: B.dev });
      assert.equal(acc.status, 200, JSON.stringify(acc.body));
      for (const u of [A, B]) {
        const r = await call("POST", "/api/conversations/send", { token: u.token, body: { conversationId: T1, type: "TEXT", content: "plain" } });
        assert.equal(r.status, 409, JSON.stringify(r.body));
      }
      assert.equal(await msgCount(T1), 0);
    });
    await step("S1 пересылка В секретку (forward-метаданные + вложение) → 409", async () => {
      const r = await call("POST", "/api/conversations/send", {
        token: A.token,
        body: {
          conversationId: T1,
          type: "FILE",
          content: "переслано",
          metadata: { forwardFrom: { authorName: "X" }, forwardOriginalCreatedAt: new Date().toISOString() },
          attachments: [{ url: "/api/files/whatever.eblusha", type: "FILE", size: 10 }],
        },
      });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(await msgCount(T1), 0);
    });
    await step("легаси POST /conversations {isSecret:true} → 410, беседа не создана, offer не разослан", async () => {
      const legacyDev = await registerUuidDevice(A);
      const before = await prisma.conversation.count({ where: { participants: { some: { userId: C.id } } } });
      const sC = await connect(C, C.dev);
      const offer = waitEvent(sC, "secret:chat:offer", () => true, 1200);
      const r0 = await call("POST", "/api/conversations", { token: A.token, body: { participantIds: [C.id], isSecret: true, initiatorDeviceId: legacyDev } });
      assert.equal(r0.status, 410, JSON.stringify(r0.body));
      assert.equal(r0.body.code, "SECRET_LEGACY_CREATE_GONE");
      assert.equal(await offer, null, "secret:chat:offer не должен уходить");
      assert.equal(await prisma.conversation.count({ where: { participants: { some: { userId: C.id } } } }), before);
      // V2-тред A↔B (isSecret:true) раньше находился как existing и получал offer от любого участника
      const sA0 = await connect(A, A.dev);
      const offerToA = waitEvent(sA0, "secret:chat:offer", (p) => p?.conversationId === T1, 1200);
      const legacyDevB = await registerUuidDevice(B);
      const r1 = await call("POST", "/api/conversations", { token: B.token, body: { participantIds: [A.id], isSecret: true, initiatorDeviceId: legacyDevB } });
      assert.equal(r1.status, 410, JSON.stringify(r1.body));
      assert.equal(await offerToA, null, "offer по V2-треду через легаси-ветку не должен уходить");
      sC.disconnect();
      sA0.disconnect();
    });
    await step("S1 легаси isSecret (type=CLOUD, уже лежит в БД) в ACTIVE → 409", async () => {
      const L = await mkLegacySecretConv(A, C, "ACTIVE");
      const row = await prisma.conversation.findUnique({ where: { id: L }, select: { type: true, isSecret: true } });
      assert.equal(row?.type, "CLOUD");
      assert.equal(row?.isSecret, true);
      const r = await call("POST", "/api/conversations/send", { token: A.token, body: { conversationId: L, type: "TEXT", content: "plain" } });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(await msgCount(L), 0);
    });

    let cloudMsgId = "";
    await step("S1 регрессия: облачная 1:1 — send 201, update 200", async () => {
      const r = await call("POST", "/api/conversations/send", { token: A.token, body: { conversationId: CL, type: "TEXT", content: "привет" } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      cloudMsgId = r.body.message.id;
      const u = await call("POST", "/api/messages/update", { token: A.token, body: { messageId: cloudMsgId, content: "привет!" } });
      assert.equal(u.status, 200, JSON.stringify(u.body));
    });
    await step("react/unreact: посторонний → 403, участник → 200", async () => {
      for (const path of ["/api/messages/react", "/api/messages/unreact"]) {
        const r = await call("POST", path, { token: C.token, body: { messageId: cloudMsgId, emoji: "👍" } });
        assert.equal(r.status, 403, `${path} outsider: ${r.status}`);
      }
      assert.equal(await prisma.messageReaction.count({ where: { messageId: cloudMsgId, userId: C.id } }), 0);
      const r1 = await call("POST", "/api/messages/react", { token: B.token, body: { messageId: cloudMsgId, emoji: "👍" } });
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      const r2 = await call("POST", "/api/messages/unreact", { token: B.token, body: { messageId: cloudMsgId, emoji: "👍" } });
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
    });
    await step("S1 регрессия: облачная 1:1 — delete 200", async () => {
      const r = await call("POST", "/api/messages/delete", { token: A.token, body: { messageId: cloudMsgId } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    });

    const T3 = await createSecretThread(A, C); // A↔C — для «уже лежащей» облачной строки
    await step("S1 update/react/preview/thumbnail по облачной строке в секретке → 409, строка не тронута; delete/unreact (стирают) → 200", async () => {
      const injected = await prisma.message.create({
        data: {
          conversationId: T3,
          senderId: A.id,
          type: "TEXT",
          content: "старый открытый текст",
          attachments: { create: [{ url: "/api/files/old.eblusha", type: "VIDEO" }] },
          reactions: { create: [{ userId: C.id, emoji: "eyes" }] },
        },
        include: { attachments: true },
      });
      try {
        const upd = await call("POST", "/api/messages/update", { token: A.token, body: { messageId: injected.id, content: "новый" } });
        assert.equal(upd.status, 409, `update ${upd.status}`);
        const re = await call("POST", "/api/messages/react", { token: C.token, body: { messageId: injected.id, emoji: "fire" } });
        assert.equal(re.status, 409, `react ${re.status}`);
        assert.equal(await prisma.messageReaction.count({ where: { messageId: injected.id, emoji: "fire" } }), 0);
        const th = await call("POST", `/api/attachments/${injected.attachments[0]!.id}/thumbnail`, { token: A.token });
        assert.equal(th.status, 409, `thumbnail ${th.status} ${JSON.stringify(th.body)}`);
        assert.equal((await prisma.messageAttachment.findUnique({ where: { id: injected.attachments[0]!.id } }))?.metadata, null);
        const pv = await call("GET", `/api/messages/${injected.id}/preview`, { token: A.token });
        assert.equal(pv.status, 200);
        assert.equal(pv.body.disabled, true);
        const mid = await prisma.message.findUnique({ where: { id: injected.id } });
        assert.equal(mid?.content, "старый открытый текст");
        assert.equal(mid?.metadata, null, "preview не должен писать metadata");

        // Стирание разрешено: оно только убирает открытые данные.
        const ur = await call("POST", "/api/messages/unreact", { token: C.token, body: { messageId: injected.id, emoji: "eyes" } });
        assert.equal(ur.status, 200, `unreact ${ur.status} ${JSON.stringify(ur.body)}`);
        assert.equal(await prisma.messageReaction.count({ where: { messageId: injected.id } }), 0);
        const delOther = await call("POST", "/api/messages/delete", { token: C.token, body: { messageId: injected.id } });
        assert.equal(delOther.status, 403, "удаляет только отправитель");
        const del = await call("POST", "/api/messages/delete", { token: A.token, body: { messageId: injected.id } });
        assert.equal(del.status, 200, `delete ${del.status} ${JSON.stringify(del.body)}`);
        const after = await prisma.message.findUnique({ where: { id: injected.id } });
        assert.equal(after?.content, null, "открытый текст стёрт");
        assert.ok(after?.deletedAt, "помечено удалённым");
        assert.equal(await prisma.messageAttachment.count({ where: { messageId: injected.id } }), 0);
      } finally {
        await prisma.messageReaction.deleteMany({ where: { messageId: injected.id } });
        await prisma.messageAttachment.deleteMany({ where: { messageId: injected.id } });
        await prisma.message.delete({ where: { id: injected.id } });
      }
    });

    await step("S1 availability (PUT /me, POST proposals) и PATCH в секретке → 409, ничего не записано; облако — 200/201", async () => {
      const now = Date.now();
      const range = { startUtcISO: new Date(now + 3_600_000).toISOString(), endUtcISO: new Date(now + 7_200_000).toISOString() };
      for (const conv of [T1, T3]) {
        const me = await call("PUT", `/api/conversations/${conv}/availability/me`, { token: A.token, body: { intervals: [range] } });
        assert.equal(me.status, 409, `availability/me ${me.status} ${JSON.stringify(me.body)}`);
        assert.equal(me.body.code, "SECRET_E2EE_ONLY");
        const pr = await call("POST", `/api/conversations/${conv}/availability/proposals`, { token: A.token, body: { ranges: [range], note: "открытая заметка" } });
        assert.equal(pr.status, 409, `proposals ${pr.status}`);
        const pa = await call("PATCH", `/api/conversations/${conv}`, { token: A.token, body: { title: "открытое название" } });
        assert.equal(pa.status, 409, `patch ${pa.status}`);
        assert.equal(await prisma.conversationAvailabilityInterval.count({ where: { conversationId: conv } }), 0);
        assert.equal(await prisma.conversationAvailabilityProposal.count({ where: { conversationId: conv } }), 0);
        assert.equal((await prisma.conversation.findUnique({ where: { id: conv }, select: { title: true } }))?.title ?? null, null);
      }
      // посторонний по-прежнему 403, а не 409 (членство проверяется раньше секретности)
      const out = await call("PUT", `/api/conversations/${T1}/availability/me`, { token: C.token, body: { intervals: [range] } });
      assert.equal(out.status, 403);
      // контроль: облачная беседа
      const me = await call("PUT", `/api/conversations/${CL}/availability/me`, { token: A.token, body: { intervals: [range] } });
      assert.equal(me.status, 200, JSON.stringify(me.body));
      const pr = await call("POST", `/api/conversations/${CL}/availability/proposals`, { token: A.token, body: { ranges: [range], note: "ok" } });
      assert.equal(pr.status, 201, JSON.stringify(pr.body));
      const pa = await call("PATCH", `/api/conversations/${CL}`, { token: A.token, body: { title: `${RUN} cloud` } });
      assert.equal(pa.status, 200, JSON.stringify(pa.body));
    });

    // --- S1 сокетные пути: 1:1 звонки в секретке vs облаке
    const sA = await connect(A, A.dev);
    const sB = await connect(B, B.dev);
    const callScenario = async (conversationId: string, kind: "decline" | "end-unanswered" | "end-accepted") => {
      sA.emit("call:invite", { conversationId, video: false });
      await sleep(400);
      if (kind === "decline") sB.emit("call:decline", { conversationId });
      if (kind === "end-unanswered") sA.emit("call:end", { conversationId });
      if (kind === "end-accepted") {
        sB.emit("call:accept", { conversationId, video: false });
        await sleep(400);
        sA.emit("call:end", { conversationId });
      }
      await sleep(800);
    };
    for (const kind of ["decline", "end-unanswered", "end-accepted"] as const) {
      await step(`S1 сокет 1:1 call ${kind}: секретка — 0 записей${kind === "end-unanswered" ? " (но пуш «Пропущенный звонок» есть)" : ""}, облако — запись есть`, async () => {
        const beforeCloud = await msgCount(CL);
        const beforePushIds = new Set((await missedCallPushJobs(T1)).map((j: any) => j.id));
        await callScenario(T1, kind);
        assert.equal(await msgCount(T1), 0, "в секретке не должно появиться облачных Message");
        const fresh = (await missedCallPushJobs(T1)).filter((j: any) => !beforePushIds.has(j.id));
        if (kind === "end-unanswered") {
          assert.equal(fresh.length, 1, `секретка: ровно один пуш о пропущенном (есть ${fresh.length})`);
          const job: any = fresh[0];
          assert.deepEqual(job.data.userIds, [B.id], "пуш — собеседнику, не звонившему");
          assert.equal(job.data.payload.kind, "message");
          assert.ok(String(job.data.payload.messageId).startsWith(`missed-${T1}-`), job.data.payload.messageId);
          assert.equal(job.data.payload.senderId, A.id);
          assert.ok(job.data.payload.senderName);
          assert.equal(job.data.payload.secret, undefined);
        } else {
          assert.equal(fresh.length, 0, `${kind}: пуша о пропущенном быть не должно`);
        }
        await callScenario(CL, kind);
        assert.equal(await msgCount(CL), beforeCloud + 1, "контроль: в облачной беседе запись о звонке пишется");
      });
    }

    // --- S1 групповые сокетные пути (секретка-группа невозможна через API — строим в БД как «худший случай»)
    await step("S1 сокет group call:invite / call:end / call:room:join в SECRET-группе → 0 записей; облачная группа — записи есть", async () => {
      const G = await prisma.conversation.create({
        data: {
          type: "SECRET",
          isSecret: true,
          isGroup: true,
          secretStatus: "ACTIVE",
          createdById: A.id,
          participants: { create: [{ userId: A.id }, { userId: B.id }] },
        } as any,
      });
      const GC = await prisma.conversation.create({
        data: { isGroup: true, title: `${RUN} group`, createdById: A.id, participants: { create: [{ userId: A.id }, { userId: B.id }] } } as any,
      });
      for (const conv of [G.id, GC.id]) {
        sA.emit("call:invite", { conversationId: conv, video: false }); // «X начал звонок»
        await sleep(500);
        sA.emit("call:end", { conversationId: conv }); // finishGroupCall → «Звонок продлился»
        await sleep(600);
        sB.emit("call:room:join", { conversationId: conv, video: false }); // без callState → «начал звонок»
        await sleep(500);
        sB.emit("call:end", { conversationId: conv });
        await sleep(600);
      }
      assert.equal(await msgCount(G.id), 0, "SECRET-группа: облачных записей быть не должно");
      assert.ok((await msgCount(GC.id)) >= 3, `контроль: облачная группа должна получить записи (есть ${await msgCount(GC.id)})`);
    });

    // ------------------------------------------------------------------ S2
    console.log("S2 — форма headerJson");
    await step("S2 unit: прод-формы проходят, кривые — нет", async () => {
      const good = [
        { kind: "self_check", v: 1, ts: 1791040703946, expiresAt: "x" },
        { kind: "key_package", v: 1, packageKind: "thread_key", threadId: "t", alg: "x25519", nonce: "n", reasonCode: "r" },
        { kind: "msg", v: 1, nonce: "n", attachment: { objectKey: "k", size: 0 } },
        { kind: "control", type: null, ts: null, v: null, attachment: null, extra: { any: [1, 2.5] } },
      ];
      for (const h of good) assert.equal(isValidSecretHeader(h), true, JSON.stringify(h));
      const bad: Array<[unknown, string]> = [
        [{ kind: 5 }, "kind"],
        [{ kind: "" }, "kind"],
        [{ v: 1 }, "kind"],
        [{ kind: "x", ts: 1.5 }, "ts"],
        [{ kind: "x", v: "1" }, "v"],
        [{ kind: "x", v: 2 ** 40 }, "v"],
        [{ kind: "x", schemaVersion: 1.2 }, "schemaVersion"],
        [{ kind: "x", attachment: { objectKey: "a" } }, "attachment.size"],
        [{ kind: "x", attachment: { objectKey: "a", size: -1 } }, "attachment.size"],
        [{ kind: "x", attachment: "a" }, "attachment"],
        [{ kind: "x", nonce: 5 }, "nonce"],
        [{ kind: "x", threadId: {} }, "threadId"],
        [[], "headerJson:not_object"],
        ["str", "headerJson:not_object"],
      ];
      for (const [h, field] of bad) assert.ok(secretHeaderProblems(h).includes(field), `${JSON.stringify(h)} → ${field}`);
    });

    const R = await mkUser("r", 3); // получатель: devs[0..3]
    const S = await mkUser("s");
    await step("S2 /secret/send с кривым заголовком → 400 SECRET_HEADER_INVALID, ничего не записано", async () => {
      const cases = [
        { kind: 5 },
        { kind: "x", ts: 1.5 },
        { kind: "x", attachment: { objectKey: "a" } },
        { kind: "" },
        { v: 1, nonce: "n" },
        { kind: "x", nonce: 5 },
        { kind: "x", v: "1" },
      ];
      for (const h of cases) {
        const env1 = secretEnvelope(R.devs[0]!, h);
        const r = await call("POST", "/api/secret/send", { token: S.token, device: S.dev, body: { messages: [env1] } });
        assert.equal(r.status, 400, `${JSON.stringify(h)} → ${r.status}`);
        assert.equal(r.body.code, "SECRET_HEADER_INVALID");
        assert.equal(await prisma.secretMessage.count({ where: { msgId: env1.msgId } }), 0);
      }
    });
    await step("S2 /secret/send: пачка [валидный, кривой] → 400 целиком, валидный не записан", async () => {
      const ok1 = secretEnvelope(R.devs[0]!, { kind: "control", v: 1, type: "key_request", ts: Date.now() });
      const bad1 = secretEnvelope(R.devs[0]!, { kind: 7 });
      const r = await call("POST", "/api/secret/send", { token: S.token, device: S.dev, body: { messages: [ok1, bad1] } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.body.invalid.map((x: any) => x.index), [1]);
      assert.equal(await prisma.secretMessage.count({ where: { msgId: { in: [ok1.msgId, bad1.msgId] } } }), 0);
    });
    await step("S2 /secret/send: прод-формы (self_check, без headerJson, неизвестные ключи, null-поля, attachment) → 200", async () => {
      const envs = [
        secretEnvelope(R.devs[0]!, { kind: "self_check", v: 1, ts: Date.now() }),
        secretEnvelope(R.devs[0]!), // сервер подставит {kind:"direct",v:1}
        secretEnvelope(R.devs[0]!, { kind: "key_package", v: 1, packageKind: "thread_key", threadId: T1, alg: "x25519", reasonCode: "x", extra: { nested: [1, 2] } }),
        secretEnvelope(R.devs[0]!, { kind: "control", v: null, type: null, ts: null, attachment: null }),
        secretEnvelope(R.devs[0]!, { kind: "msg", v: 1 }, {
          contentType: "attachment",
          attachment: { objectKey: "secret/x.enc", size: 123, hash: "h", wrappedContentKeysByDevice: {} },
        }),
      ];
      const r = await call("POST", "/api/secret/send", { token: S.token, device: S.dev, body: { messages: envs } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await prisma.secretMessage.count({ where: { msgId: { in: envs.map((e) => e.msgId) } } }), envs.length);
      const pull = await call("GET", "/api/secret/inbox/pull?limit=50", { token: R.token, device: R.devs[0]! });
      const got = new Set((pull.body.messages as any[]).map((m) => m.msgId));
      for (const e of envs) assert.ok(got.has(e.msgId), `pull должен вернуть ${e.msgId}`);
    });

    const T5 = await createSecretThread(S, R); // S↔R для push/history
    const pushBody = (headerJson: unknown, extra: Record<string, unknown> = {}) => ({
      threadId: T5,
      msgId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...(headerJson !== undefined ? { headerJson } : {}),
      ciphertext: b64(),
      contentType: "text",
      schemaVersion: 1,
      receiverDeviceIds: [S.dev, R.devs[1]!],
      ...extra,
    });
    await step("S2 /secret/messages/push: без headerJson / {} / v:1.5 / size<0 → 400; {kind:msg} → 201", async () => {
      for (const h of [undefined, {}, { kind: "msg", v: 1.5 }, { kind: "msg", attachment: { objectKey: "k", size: -1 } }]) {
        const body = pushBody(h);
        const r = await call("POST", "/api/secret/messages/push", { token: S.token, device: S.dev, body });
        assert.equal(r.status, 400, `${JSON.stringify(h)} → ${r.status}`);
        assert.equal(await prisma.secretMessage.count({ where: { msgId: body.msgId } }), 0);
      }
      const ok = pushBody({ kind: "msg", v: 1, nonce: b64() });
      const r = await call("POST", "/api/secret/messages/push", { token: S.token, device: S.dev, body: ok });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });

    await step("S2 выдача: pull прячет «уже лежащие» кривые записи (кэш и БД-фолбэк) и снимает их с инбокса", async () => {
      const dev = R.devs[2]!;
      const badHeaders = [{ kind: 5 }, { kind: "x", ts: 1.5 }, { kind: "x", attachment: { objectKey: "a" } }, {}];
      const badIds: string[] = [];
      for (const h of badHeaders) {
        const msgId = crypto.randomUUID();
        badIds.push(msgId);
        const createdAt = new Date();
        const ct = crypto.randomBytes(24);
        await prisma.secretMessage.create({
          data: {
            msgId,
            threadId: null,
            senderUserId: S.id,
            senderDeviceId: S.dev,
            createdAt,
            headerJson: h as any,
            ciphertextBlob: ct,
            contentType: "ref",
            schemaVersion: 1,
            deliveries: { create: { receiverDeviceId: dev, status: "PENDING" } },
          } as any,
        });
        await enqueueSecretMessages(redis as any, [
          {
            toDeviceId: dev,
            msgId,
            payload: {
              msgId,
              threadId: null,
              senderUserId: S.id,
              senderDeviceId: S.dev,
              createdAt: createdAt.toISOString(),
              headerJson: h,
              ciphertext: ct.toString("base64"),
              contentType: "ref",
              schemaVersion: 1,
            },
          },
        ]);
      }
      // один — только из БД (кэш истёк)
      await redis.del(`${SECRET_MESSAGE_KEY_PREFIX}${badIds[0]}`);
      const good = secretEnvelope(dev, { kind: "control", v: 1, type: "key_receipt", ts: Date.now() });
      const s1 = await call("POST", "/api/secret/send", { token: S.token, device: S.dev, body: { messages: [good] } });
      assert.equal(s1.status, 200);

      const pull = await call("GET", "/api/secret/inbox/pull?limit=50", { token: R.token, device: dev });
      assert.equal(pull.status, 200);
      const ids = (pull.body.messages as any[]).map((m) => m.msgId);
      assert.deepEqual(ids, [good.msgId], `в выдаче только валидный: ${JSON.stringify(ids)}`);
      for (const m of pull.body.messages as any[]) assert.ok(isValidSecretHeader(m.headerJson));
      await sleep(300);
      const left = await redis.lRange(`${SECRET_INBOX_LIST_KEY_PREFIX}${dev}`, 0, -1);
      for (const id of badIds) assert.ok(!left.includes(id), "кривая запись должна уйти из инбокса");
      assert.ok(left.includes(good.msgId), "валидная ждёт ack клиента");
    });

    await step("S2 выдача: history прячет кривую строку, курсор не сбивается", async () => {
      const t0 = Date.now() + 60_000;
      const valid = pushBody({ kind: "msg", v: 1, nonce: b64() }, { createdAt: new Date(t0).toISOString() });
      const r = await call("POST", "/api/secret/messages/push", { token: S.token, device: S.dev, body: valid });
      assert.equal(r.status, 201);
      const badId = crypto.randomUUID();
      await prisma.secretMessage.create({
        data: {
          msgId: badId,
          threadId: T5,
          senderUserId: S.id,
          senderDeviceId: S.dev,
          createdAt: new Date(t0 + 1000), // новее валидной — первая на странице
          headerJson: { v: 1 } as any, // без kind — то, что раньше давал zod-дефолт `{}`
          ciphertextBlob: crypto.randomBytes(24),
          contentType: "text",
          schemaVersion: 1,
        } as any,
      });
      const p1 = await call("GET", `/api/secret/history?threadId=${T5}&limit=1`, { token: R.token, device: R.devs[1]! });
      assert.equal(p1.status, 200);
      assert.equal(p1.body.items.length, 0, "кривая строка скрыта");
      assert.equal(p1.body.hasMore, true);
      assert.ok(p1.body.nextCursor);
      const p2 = await call("GET", `/api/secret/history?threadId=${T5}&limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`, {
        token: R.token,
        device: R.devs[1]!,
      });
      assert.deepEqual(p2.body.items.map((m: any) => m.msgId), [valid.msgId]);
      const all = await call("GET", `/api/secret/history?threadId=${T5}&limit=50`, { token: R.token, device: R.devs[1]! });
      const allIds = (all.body.items as any[]).map((m) => m.msgId);
      assert.ok(allIds.includes(valid.msgId) && !allIds.includes(badId));
    });

    await step("S2 аварийный режим SECRET_HEADER_ENFORCE=0: «принято ⇔ отдаётся» — вход принимает, pull и history отдают", async () => {
      const dev = R.devs[3]!;
      const bad = secretEnvelope(dev, { kind: 5 });
      const pb = pushBody({});
      process.env.SECRET_HEADER_ENFORCE = "0";
      try {
        const r = await call("POST", "/api/secret/send", { token: S.token, device: S.dev, body: { messages: [bad] } });
        assert.equal(r.status, 200, `log-mode send ${r.status}`);
        assert.equal(await prisma.secretMessage.count({ where: { msgId: bad.msgId } }), 1);
        const pull = await call("GET", "/api/secret/inbox/pull?limit=50", { token: R.token, device: dev });
        assert.ok((pull.body.messages as any[]).some((m) => m.msgId === bad.msgId), "принятая запись должна отдаваться (не теряться молча)");
        await sleep(300);
        assert.ok(
          (await redis.lRange(`${SECRET_INBOX_LIST_KEY_PREFIX}${dev}`, 0, -1)).includes(bad.msgId),
          "в аварийном режиме pull запись с инбокса не снимает — ждёт ack клиента"
        );
        const p = await call("POST", "/api/secret/messages/push", { token: S.token, device: S.dev, body: pb });
        assert.equal(p.status, 201, `log-mode push ${p.status}`);
        const h = await call("GET", `/api/secret/history?threadId=${T5}&limit=50`, { token: R.token, device: R.devs[1]! });
        assert.ok((h.body.items as any[]).some((m) => m.msgId === pb.msgId), "history в аварийном режиме отдаёт строку");
      } finally {
        delete process.env.SECRET_HEADER_ENFORCE;
      }
      // Обратно в обычный режим: те же записи снова прячутся (правило одно на входе и выдаче).
      const pull2 = await call("GET", "/api/secret/inbox/pull?limit=50", { token: R.token, device: dev });
      assert.ok(!(pull2.body.messages as any[]).some((m) => m.msgId === bad.msgId));
      const h2 = await call("GET", `/api/secret/history?threadId=${T5}&limit=50`, { token: R.token, device: R.devs[1]! });
      assert.ok(!(h2.body.items as any[]).some((m) => m.msgId === pb.msgId));
    });

    // ------------------------------------------------------------------ S8
    console.log("S8 — CANCELLED не будит");
    await step("S8 push в PENDING будит (notify + пуш), в CANCELLED — нет (но сообщение принято)", async () => {
      const X = await mkUser("s8x");
      const Y = await mkUser("s8y");
      const T = await createSecretThread(X, Y);
      const sY = await connect(Y, Y.dev);
      const q = getPushQueue();

      const m1 = { threadId: T, msgId: crypto.randomUUID(), createdAt: new Date().toISOString(), headerJson: { kind: "msg", v: 1, nonce: b64() }, ciphertext: b64(), contentType: "text", schemaVersion: 1, receiverDeviceIds: [X.dev, Y.dev] };
      const w1 = waitEvent(sY, "secret:notify", (p) => p?.msgId === m1.msgId, 3000);
      const r1 = await call("POST", "/api/secret/messages/push", { token: X.token, device: X.dev, body: m1 });
      assert.equal(r1.status, 201);
      assert.ok(await w1, "PENDING: secret:notify должен прийти");
      await sleep(400);
      assert.ok(await q.getJob(`secret-${m1.msgId}`), "PENDING: пуш должен встать в очередь");

      const d = await call("POST", `/api/threads/secret/${T}/decline`, { token: Y.token, device: Y.dev });
      assert.equal(d.status, 200);
      const m2 = { ...m1, msgId: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const w2 = waitEvent(sY, "secret:notify", (p) => p?.msgId === m2.msgId, 1500);
      const r2 = await call("POST", "/api/secret/messages/push", { token: X.token, device: X.dev, body: m2 });
      assert.equal(r2.status, 201, "CANCELLED: сообщение принимается (идемпотентность клиентов)");
      assert.equal(await w2, null, "CANCELLED: secret:notify слать нельзя");
      assert.equal(await q.getJob(`secret-${m2.msgId}`), undefined, "CANCELLED: пуша быть не должно");
      assert.equal(await prisma.secretMessage.count({ where: { msgId: m2.msgId } }), 1);
    });

    // ------------------------------------------------------------------ S4
    console.log("S4 — атомарный accept, легаси-сокет");
    await step("S4 гонка двух устройств собеседника: ровно один 200, второй 409; закреплено устройство победителя", async () => {
      for (let i = 0; i < 6; i += 1) {
        const X = await mkUser(`rx${i}`);
        const Y = await mkUser(`ry${i}`, 1);
        const T = await createSecretThread(X, Y);
        const [r1, r2] = await Promise.all(
          Y.devs.map((dev) => call("POST", `/api/threads/secret/${T}/accept`, { token: Y.token, device: dev }))
        );
        const statuses = [r1!.status, r2!.status].sort();
        assert.deepEqual(statuses, [200, 409], `iter ${i}: ${statuses}`);
        const winner = r1!.status === 200 ? Y.devs[0] : Y.devs[1];
        const loser = r1!.status === 200 ? r2! : r1!;
        assert.equal(loser.body.code, "SECRET_ACCEPTED_ON_OTHER_DEVICE");
        const st = await convState(T);
        assert.equal(st.secretStatus, "ACTIVE");
        assert.equal(st.secretPeerDeviceId, winner);
      }
    });
    const recordThreadEvents = (s: ClientSocket, conversationId: string) => {
      const seen: string[] = [];
      for (const ev of ["secret:chat:accepted", "conversations:updated", "conversations:deleted"]) {
        s.on(ev, (p: any) => {
          if (p?.conversationId === conversationId) seen.push(ev);
        });
      }
      return seen;
    };
    await step("S4 гонка accept ↔ decline: CANCELLED не воскресает, последнее событие у обоих — conversations:deleted", async () => {
      const outcomes: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const X = await mkUser(`dx${i}`);
        const Y = await mkUser(`dy${i}`);
        const T = await createSecretThread(X, Y);
        const sX = await connect(X, X.dev);
        const sY = await connect(Y, Y.dev);
        const evX = recordThreadEvents(sX, T);
        const evY = recordThreadEvents(sY, T);
        const [acc, dec] = await Promise.all([
          call("POST", `/api/threads/secret/${T}/accept`, { token: Y.token, device: Y.dev }),
          call("POST", `/api/threads/secret/${T}/decline`, { token: X.token, device: X.dev }),
        ]);
        await sleep(400);
        sX.disconnect();
        sY.disconnect();
        assert.equal(dec.status, 200);
        assert.ok(acc.status === 200 || acc.status === 409, `accept ${acc.status}`);
        assert.equal((await convState(T)).secretStatus, "CANCELLED", `iter ${i}: accept=${acc.status}`);
        assert.equal(evX.at(-1), "conversations:deleted", `iter ${i} creator events: ${evX.join(",")}`);
        assert.equal(evY.at(-1), "conversations:deleted", `iter ${i} peer events: ${evY.join(",")}`);
        outcomes.push(`${acc.status}:${evX.join("+")}`);
      }
      console.log(`       races: ${outcomes.join(" | ")}`);
    });
    await step("S4 гонка accept ↔ decline, худший порядок (decline между коммитом accept и рассылкой): accepted → deleted, 409", async () => {
      const X = await mkUser("wx");
      const Y = await mkUser("wy");
      const T = await createSecretThread(X, Y);
      const sX = await connect(X, X.dev);
      const evX = recordThreadEvents(sX, T);
      // 1) accept закоммитил ACTIVE (без рассылки — её делает announceSecretThreadAccepted)
      const announce = (secretThreadState as any).announceSecretThreadAccepted;
      assert.equal(typeof announce, "function", "нет announceSecretThreadAccepted (код до правки)");
      const res = await secretThreadState.acceptSecretThread({ userId: Y.id, conversationId: T, deviceId: Y.dev });
      assert.ok(res.ok, JSON.stringify(res));
      assert.equal((await convState(T)).secretStatus, "ACTIVE");
      // 2) decline успел до рассылки accept: CANCELLED + conversations:deleted
      const d = await call("POST", `/api/threads/secret/${T}/decline`, { token: X.token });
      assert.equal(d.status, 200);
      await sleep(200);
      assert.deepEqual(evX, ["conversations:deleted"]);
      // 3) рассылка accept: старый код на этом закончил бы «принято/ACTIVE»
      const live = await announce(io, res);
      assert.equal(live, false, "тред уже отменён — accept должен проиграть");
      await sleep(300);
      assert.deepEqual(evX, ["conversations:deleted", "secret:chat:accepted", "conversations:updated", "conversations:deleted"]);
      assert.equal((await convState(T)).secretStatus, "CANCELLED");
      sX.disconnect();
    });
    const X = await mkUser("ax");
    const Y = await mkUser("ay", 1);
    const TX = await createSecretThread(X, Y);
    await step("S4 accept создателем → 409, accept после decline → 409, повтор с того же устройства → 200", async () => {
      const own = await call("POST", `/api/threads/secret/${TX}/accept`, { token: X.token, device: X.dev });
      assert.equal(own.status, 409);
      assert.equal(own.body.message, "The creator cannot accept their own invite");
      assert.equal((await convState(TX)).secretStatus, "PENDING");

      const a1 = await call("POST", `/api/threads/secret/${TX}/accept`, { token: Y.token, device: Y.devs[0]! });
      assert.equal(a1.status, 200);
      const a2 = await call("POST", `/api/threads/secret/${TX}/accept`, { token: Y.token, device: Y.devs[0]! });
      assert.equal(a2.status, 200, "идемпотентный повтор");
      const a3 = await call("POST", `/api/threads/secret/${TX}/accept`, { token: Y.token, device: Y.devs[1]! });
      assert.equal(a3.status, 409);
      assert.equal(a3.body.message, "Already accepted on another device");

      const X2 = await mkUser("ax2");
      const Y2 = await mkUser("ay2");
      const T = await createSecretThread(X2, Y2);
      assert.equal((await call("POST", `/api/threads/secret/${T}/decline`, { token: Y2.token })).status, 200);
      const late = await call("POST", `/api/threads/secret/${T}/accept`, { token: Y2.token, device: Y2.dev });
      assert.equal(late.status, 409);
      assert.equal(late.body.message, "Invite was declined");
      assert.equal((await convState(T)).secretStatus, "CANCELLED");
    });

    await step("S4/H09 легаси-сокет secret:chat:accept: создатель, посторонний, чужое устройство, второе устройство, CLOUD-легаси — без эффекта", async () => {
      const P = await mkUser("px");
      const Q = await mkUser("pq", 1);
      const O = await mkUser("po");
      const T = await createSecretThread(P, Q);
      const sP = await connect(P, P.dev);
      const sQ0 = await connect(Q, Q.devs[0]!);
      const sQ1 = await connect(Q, Q.devs[1]!);
      const sO = await connect(O, O.dev);

      sP.emit("secret:chat:accept", { conversationId: T, deviceId: P.dev }); // создатель «принимает» сам
      sO.emit("secret:chat:accept", { conversationId: T, deviceId: O.dev }); // посторонний
      sQ0.emit("secret:chat:accept", { conversationId: T, deviceId: P.dev }); // устройство не его
      await sleep(700);
      let st = await convState(T);
      assert.equal(st.secretStatus, "PENDING");
      assert.equal(st.secretPeerDeviceId, null);

      // честный путь через сокет работает так же, как HTTP
      const got = waitEvent(sP, "secret:chat:accepted", (p) => p?.conversationId === T, 3000);
      sQ0.emit("secret:chat:accept", { conversationId: T, deviceId: Q.devs[0]! });
      const ev = await got;
      assert.ok(ev, "secret:chat:accepted должен прийти создателю");
      assert.equal(ev.peerDeviceId, Q.devs[0]);
      st = await convState(T);
      assert.equal(st.secretStatus, "ACTIVE");
      assert.equal(st.secretPeerDeviceId, Q.devs[0]);

      // захват ключа вторым устройством / создателем в ACTIVE
      sQ1.emit("secret:chat:accept", { conversationId: T, deviceId: Q.devs[1]! });
      sP.emit("secret:chat:accept", { conversationId: T, deviceId: P.dev });
      await sleep(700);
      st = await convState(T);
      assert.equal(st.secretPeerDeviceId, Q.devs[0], "secretPeerDeviceId не должен переписываться");

      // CLOUD-легаси isSecret — не SECRET-тред, сокет его не трогает (создание теперь 410 — строим в БД)
      const LId = await mkLegacySecretConv(P, O, "PENDING");
      sO.emit("secret:chat:accept", { conversationId: LId, deviceId: O.dev });
      await sleep(600);
      const lst = await convState(LId);
      assert.equal(lst.secretStatus, "PENDING");
      assert.equal(lst.secretPeerDeviceId, null);

      // мусорный payload не роняет обработчик
      sO.emit("secret:chat:accept", { conversationId: 42, deviceId: null } as any);
      sO.emit("secret:chat:accept", null as any);
      await sleep(300);
      assert.ok(sO.connected);
    });

    await step("S4 легаси-сокет secret:chat:decline: посторонний — без эффекта, участник — CANCELLED, accept после — без эффекта", async () => {
      const P = await mkUser("dpx");
      const Q = await mkUser("dpq");
      const O = await mkUser("dpo");
      const T = await createSecretThread(P, Q);
      const sQ = await connect(Q, Q.dev);
      const sO = await connect(O, O.dev);
      sO.emit("secret:chat:decline", { conversationId: T });
      await sleep(600);
      assert.equal((await convState(T)).secretStatus, "PENDING");
      sQ.emit("secret:chat:decline", { conversationId: T });
      await sleep(600);
      assert.equal((await convState(T)).secretStatus, "CANCELLED");
      sQ.emit("secret:chat:accept", { conversationId: T, deviceId: Q.dev });
      await sleep(600);
      assert.equal((await convState(T)).secretStatus, "CANCELLED");
    });

    await step("S4 легаси-сокет secret:chat:offer: только создатель PENDING-треда, не чаще раза в 30 с", async () => {
      const P = await mkUser("opx");
      const Q = await mkUser("opq");
      const T = await createSecretThread(P, Q);
      const sP = await connect(P, P.dev);
      const sQ = await connect(Q, Q.dev);
      // собеседник шлёт offer создателю — не доходит
      const w0 = waitEvent(sP, "secret:chat:offer", (p) => p?.conversationId === T, 1000);
      sQ.emit("secret:chat:offer", { conversationId: T });
      assert.equal(await w0, null);
      // создатель — доходит один раз
      const w1 = waitEvent(sQ, "secret:chat:offer", (p) => p?.conversationId === T, 2000);
      sP.emit("secret:chat:offer", { conversationId: T });
      assert.ok(await w1, "offer создателя должен дойти");
      const w2 = waitEvent(sQ, "secret:chat:offer", (p) => p?.conversationId === T, 1000);
      sP.emit("secret:chat:offer", { conversationId: T });
      assert.equal(await w2, null, "повтор в окне 30 с режется");
    });

    // ------------------------------------------------------------------ S6
    console.log("S6 — DELETE секретки чистит шифротекст");
    await step("S6 DELETE /conversations/:id секретки: messages_secret, deliveries, refs, кэш Redis и .enc удалены; чужое не тронуто", async () => {
      const P6 = await mkUser("s6p");
      const Q6 = await mkUser("s6q", 1);
      const O6 = await mkUser("s6o");
      const T = await createSecretThread(P6, Q6);
      const acc = await call("POST", `/api/threads/secret/${T}/accept`, { token: Q6.token, device: Q6.devs[0]! });
      assert.equal(acc.status, 200, JSON.stringify(acc.body));
      const TO = await createSecretThread(P6, O6); // другой тред того же создателя

      const storage = getStorageProvider();
      const kOwn = `uploads/${RUN}-s6-own.enc`;
      const kShared = `uploads/${RUN}-s6-shared.enc`;
      for (const k of [kOwn, kShared]) await storage.putObject(k, crypto.randomBytes(64));
      assert.ok(await storage.headObject(kOwn));

      const mkPush = (headerJson: Record<string, unknown>, contentType = "text") => ({
        threadId: T,
        msgId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        headerJson,
        ciphertext: b64(),
        contentType,
        schemaVersion: 1,
        receiverDeviceIds: [P6.dev, Q6.devs[0]!, Q6.devs[1]!],
      });
      const m1 = mkPush({ kind: "msg", v: 1, nonce: b64() });
      const m2 = mkPush({ kind: "msg", v: 1, nonce: b64(), attachment: { objectKey: kOwn, size: 64 } }, "attachment");
      for (const m of [m1, m2]) {
        const r = await call("POST", "/api/secret/messages/push", { token: P6.token, device: P6.dev, body: m });
        assert.equal(r.status, 201, JSON.stringify(r.body));
      }
      for (const th of [T, TO]) {
        const r = await call("POST", "/api/secret/attachments/ref", { token: P6.token, device: P6.dev, body: { threadId: th, objectKey: kShared } });
        assert.equal(r.status, 201, JSON.stringify(r.body));
      }
      // конверт ключа через /secret/send: в БД threadId=null — к треду по столбцу не привязан, DELETE его не трогает
      const keyEnv = secretEnvelope(Q6.devs[0]!, { kind: "key_package", v: 1, packageKind: "thread_key", threadId: T });
      assert.equal((await call("POST", "/api/secret/send", { token: P6.token, device: P6.dev, body: { messages: [keyEnv] } })).status, 200);

      const ids = [m1.msgId, m2.msgId];
      assert.equal(await prisma.secretMessage.count({ where: { threadId: T } }), 2);
      assert.equal(await prisma.secretDelivery.count({ where: { msgId: { in: ids } } }), 6);
      assert.equal(await prisma.secretAttachmentRef.count({ where: { threadId: T } }), 2);
      for (const id of ids) assert.equal(await redis.exists(`${SECRET_MESSAGE_KEY_PREFIX}${id}`), 1, "кэш до удаления есть");

      const outsider = await call("DELETE", `/api/conversations/${T}`, { token: O6.token });
      assert.equal(outsider.status, 403);
      const del = await call("DELETE", `/api/conversations/${T}`, { token: Q6.token });
      assert.equal(del.status, 200, JSON.stringify(del.body));

      assert.equal(await prisma.conversation.count({ where: { id: T } }), 0);
      assert.equal(await prisma.secretMessage.count({ where: { threadId: T } }), 0, "messages_secret треда удалены");
      assert.equal(await prisma.secretDelivery.count({ where: { msgId: { in: ids } } }), 0, "deliveries_secret ушли каскадом");
      assert.equal(await prisma.secretAttachmentRef.count({ where: { threadId: T } }), 0, "refs треда удалены");
      for (const id of ids) assert.equal(await redis.exists(`${SECRET_MESSAGE_KEY_PREFIX}${id}`), 0, "кэш secret_msg снят");

      // pull получателей: удалённые конверты не приходят и уходят из инбокса; чужой конверт /send — приходит
      const pull1 = await call("GET", "/api/secret/inbox/pull?limit=50", { token: Q6.token, device: Q6.devs[1]! });
      assert.equal(pull1.status, 200);
      assert.deepEqual((pull1.body.messages as any[]).map((m) => m.msgId), []);
      const pull0 = await call("GET", "/api/secret/inbox/pull?limit=50", { token: Q6.token, device: Q6.devs[0]! });
      assert.deepEqual((pull0.body.messages as any[]).map((m) => m.msgId), [keyEnv.msgId]);
      await sleep(300);
      for (const dev of [Q6.devs[0]!, Q6.devs[1]!]) {
        const left = await redis.lRange(`${SECRET_INBOX_LIST_KEY_PREFIX}${dev}`, 0, -1);
        for (const id of ids) assert.ok(!left.includes(id), `${dev}: удалённый конверт должен уйти из инбокса`);
      }
      assert.equal(await prisma.secretMessage.count({ where: { msgId: keyEnv.msgId } }), 1, "конверт /send не тронут");

      // S3: свой .enc удалён (после коммита, best-effort), общий с живым ref другого треда — на месте
      for (let i = 0; i < 20 && (await storage.headObject(kOwn)); i += 1) await sleep(100);
      assert.equal(await storage.headObject(kOwn), null, ".enc треда удалён");
      assert.ok(await storage.headObject(kShared), "объект с живым ref другого треда не трогаем");
      assert.equal(await prisma.secretAttachmentRef.count({ where: { threadId: TO, objectKey: kShared, deletedAt: null } }), 1);
      await storage.deleteObject(kShared);
    });
    await step("S6 регрессия: DELETE облачной беседы — 200, сообщения и беседа удалены", async () => {
      const a = await mkUser("s6ca");
      const b = await mkUser("s6cb");
      const cid = await createCloudDirect(a, b);
      const s = await call("POST", "/api/conversations/send", { token: a.token, body: { conversationId: cid, type: "TEXT", content: "привет" } });
      assert.equal(s.status, 201, JSON.stringify(s.body));
      const d = await call("DELETE", `/api/conversations/${cid}`, { token: b.token });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.equal(await prisma.conversation.count({ where: { id: cid } }), 0);
      assert.equal(await msgCount(cid), 0);
    });

    // ------------------------------------------------------------------ S1: долгие сокетные пути
    console.log("S1 — долгие пути звонков (таймер «нет ответа» 60 с и обрыв принятого 15 с), ждём ~65 с");
    await step("S1 сокет: ring-timeout и grace-teardown не пишут записей в секретку (облако — пишут)", async () => {
      const mk = async (tag: string) => {
        const a = await mkUser(`${tag}a`);
        const b = await mkUser(`${tag}b`);
        return { a, b, secret: await createSecretThread(a, b), cloud: await createCloudDirect(a, b) };
      };
      // ring timeout: приглашение без ответа
      const ring = await mk("rt");
      const rA = await connect(ring.a, ring.a.dev);
      rA.emit("call:invite", { conversationId: ring.secret, video: false });
      rA.emit("call:invite", { conversationId: ring.cloud, video: false });
      // grace: принятый звонок, у собеседника рвётся сокет
      const grace = await mk("gr");
      const gA = await connect(grace.a, grace.a.dev);
      const gB = await connect(grace.b, grace.b.dev);
      for (const conv of [grace.secret, grace.cloud]) {
        gA.emit("call:invite", { conversationId: conv, video: false });
        await sleep(400);
        gB.emit("call:accept", { conversationId: conv, video: false });
        await sleep(400);
      }
      gB.disconnect();
      await sleep(65_000);
      assert.equal(await msgCount(ring.secret), 0, "ring-timeout: в секретке 0");
      assert.equal(await msgCount(ring.cloud), 1, "ring-timeout: контроль — облако получило «Пропущенный звонок»");
      const ringPushes: any[] = await missedCallPushJobs(ring.secret);
      assert.equal(ringPushes.length, 1, `ring-timeout: в секретке пуш «Пропущенный звонок» без записи (есть ${ringPushes.length})`);
      assert.deepEqual(ringPushes[0].data.userIds, [ring.b.id]);
      assert.ok(String(ringPushes[0].data.payload.messageId).startsWith(`missed-${ring.secret}-`));
      assert.equal((await missedCallPushJobs(ring.cloud)).length, 1, "контроль: облачный пуш по записи");
      assert.equal(await msgCount(grace.secret), 0, "grace: в секретке 0");
      assert.equal(await msgCount(grace.cloud), 1, "grace: контроль — облако получило «Звонок продлился»");
    });

    await step("S1 выход из секретки (DELETE /participants/me): без системной записи", async () => {
      const r = await call("DELETE", `/api/conversations/${T3}/participants/me`, { token: C.token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await msgCount(T3), 0);
    });

    await step("S1 инвариант: облачных Message в SECRET/isSecret беседах этого прогона — 0", async () => {
      // По прогону, а не по всей тестовой БД: в ней могут лежать данные контрольных прогонов
      // на НЕпропатченном коде (там записи в секретках и есть то, что тест ловит).
      const n = await prisma.message.count({
        where: {
          conversation: {
            OR: [{ type: "SECRET" }, { isSecret: true }],
            participants: { some: { user: { username: { startsWith: RUN } } } },
          },
        } as any,
      });
      assert.equal(n, 0);
      const runConvs = await prisma.conversation.count({
        where: { OR: [{ type: "SECRET" }, { isSecret: true }], participants: { some: { user: { username: { startsWith: RUN } } } } } as any,
      });
      assert.ok(runConvs >= 10, `проверка должна видеть секретки прогона (${runConvs})`);
    });
  } finally {
    for (const s of sockets) {
      try {
        s.disconnect();
      } catch {}
    }
    io.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().then(
  async () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nsecret-holes-wave1: ${results.length - failed.length}/${results.length} ok`);
    for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
    await getPushQueue().close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(failed.length ? 1 : 0);
  },
  async (err) => {
    console.error("secret-holes-wave1: CRASHED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
