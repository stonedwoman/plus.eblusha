/**
 * «Без звука» для бесед (docs/conversation-mute.md, src/lib/conversationMute.ts) — интеграционный тест.
 *
 * Что проверяется:
 *   A. REST POST /api/conversations/:id/mute: пресеты 1h/8h/1d/1w (часы сервера) и forever, until (ISO со
 *      смещением; прошлое → снять; дальше 366 сут → «Навсегда»; null → снять), значение в БД; мусор → 400
 *      MUTE_BAD_BODY; не участник / нет беседы → 404 NOT_A_PARTICIPANT; 31-й запрос за минуту → 429;
 *      любая беседа: секретная (до и после принятия), «Чат с Еблушей».
 *   B. Сокет: conversation:mute во ВСЕ сокеты человека (at = serverNow ответа, byDeviceId — устройство
 *      запроса) и ни одному чужому; conversation:mute:snapshot при подключении — только заглушённые сейчас,
 *      замена целиком (снятое и истёкшее не попадают), у чужого — пусто.
 *   C. GET /api/conversations: свой mutedUntil/mutedForever (истёкший → null), serverNow, totalUnread без
 *      заглушённых.
 *   D. Приватность (глобальный omit): ни в одном ответе и событии нет participants[].mutedUntil — список бесед,
 *      создание беседы, PATCH, добавление участников (+conversations:updated), секретный тред; у человека,
 *      который ничего не глушил, поля нет вовсе, кроме своих строк списка.
 *   E. Пуши (задачи BullMQ в тестовом Redis, воркера нет) и message:notify.muted:
 *      группа: обычное → нет пуша, muted:true (остальным — пуш, muted:false); ответ на МОЁ → пуш; ответ на
 *      чужое → нет; ответ бота на мой вопрос → пуш, на чужой → нет; «начал звонок» → нет пуша, muted:true;
 *      «звонок продлился» → muted:true; системная «пригласил(а)» → muted:true.
 *      1:1: ответ на моё → нет; входящий 1:1 (kind:"call") → есть; «Пропущенный звонок» → пуш есть;
 *      «Звонок продлился» → muted:false. «Чат с Еблушей»: ответ бота → нет. Секретка: пуша нет, но
 *      secret:notify есть; после «Включить звук» — пуш есть.
 *      Истечение: until = now+1,5 с → пуша нет; после срока → есть, muted:false.
 *      У пуша «Групповой звонок» есть sentAt (момент записи, часы сервера).
 *   F. Значок APNs (число ведёт сервер, только устройствам с caps "badge"): buildRequest — badge в alert-пуше
 *      о сообщении, badge-only пуш (alert без alert/sound, collapse-id badge), read — никогда; регистрация
 *      токена с caps → {badge:true} при APNS_BADGE=on, без caps — объявление снято, DELETE снимает, VoIP и FCM
 *      без поля; sendPushToUsers: message — число только устройству с caps (= totalUnread списка), kind badge —
 *      только ему, read — следом badge-only пуш ему же; при off — ни числа, ни badge-пушей; POST mute ставит
 *      badge-задачу сразу и к истечению срока («навсегда» и «Включить звук» — только сразу), при off — ничего.
 *
 * Запускать ТОЛЬКО в изолированной среде (guard.ts не пустит к боевым БД/Redis):
 *   test/secret-env/secret-test.sh run test/conversation-mute.integration.test.ts
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
import { unreadTotalExcludingMuted } from "../src/push/badge";
import { createBotMessage } from "../src/lib/systemBot";
import { MUTE_FOREVER, mutedRecipients } from "../src/lib/conversationMute";
import { io as ioClient } from "socket.io-client";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const apnsExports = require("../src/push/apns") as { sendApns: (...a: any[]) => Promise<any> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fcmExports = require("../src/push/fcm") as { sendFcm: (...a: any[]) => Promise<any> };

const RUN = `ebst_mute_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (n = 32) => crypto.randomBytes(n).toString("base64");
const HOUR = 3_600_000;
const FOREVER_ISO = "2100-01-01T00:00:00.000Z";

let baseUrl = "";

type Resp = { status: number; body: any };
async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { token: string; device?: string; body?: unknown },
): Promise<Resp> {
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

type U = { id: string; username: string; token: string; dev: string; devs: string[] };
let seq = 0;
/** Человек + зарегистрированные устройства (через /api/devices/register — как настоящий клиент; нужно секреткам). */
async function mkUser(tag: string, devices = 1): Promise<U> {
  seq += 1;
  const username = `${RUN}_${tag}_${seq}`;
  const user = await prisma.user.create({ data: { username, passwordHash: `x_${crypto.randomUUID()}` } });
  const token = signAccessToken({ sub: user.id, tokenId: crypto.randomUUID() });
  const devs: string[] = [];
  for (let i = 0; i < devices; i += 1) {
    const dev = `${RUN}-${tag}${seq}-d${i}`;
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
  return { id: user.id, username, token, dev: devs[0] ?? "", devs };
}

/** Ещё одно устройство человека (как mkUser). */
async function addDevice(u: U, tag: string): Promise<string> {
  const dev = `${RUN}-${tag}-${crypto.randomBytes(3).toString("hex")}`;
  const r = await call("POST", "/api/devices/register", {
    token: u.token,
    device: dev,
    body: {
      deviceId: dev,
      name: `${RUN} ${tag}`,
      platform: "test",
      publicKey: b64(),
      identityPublicKey: b64(),
      prekeys: [{ keyId: `${dev}-pk`, publicKey: b64(), oneTimePreKeyId: `${dev}-opk`, oneTimePreKeyPublic: b64() }],
    },
  });
  assert.ok(r.status < 300, `register ${dev}: ${r.status} ${JSON.stringify(r.body)}`);
  return dev;
}

const mute = (u: U, conversationId: string, body: unknown, device?: string) =>
  call("POST", `/api/conversations/${conversationId}/mute`, { token: u.token, ...(device ? { device } : {}), body });
const send = (u: U, conversationId: string, content: string, replyToId?: string) =>
  call("POST", "/api/conversations/send", {
    token: u.token,
    body: { conversationId, type: "TEXT", content, ...(replyToId ? { replyToId } : {}) },
  });
async function sent(u: U, conversationId: string, content: string, replyToId?: string): Promise<string> {
  const r = await send(u, conversationId, content, replyToId);
  assert.equal(r.status, 201, `send: ${JSON.stringify(r.body)}`);
  return r.body.message.id as string;
}
async function dbUntil(userId: string, conversationId: string): Promise<Date | null> {
  const row = await prisma.conversationParticipant.findFirst({
    where: { userId, conversationId },
    select: { mutedUntil: true },
  });
  return row?.mutedUntil ?? null;
}

// ---------------------------------------------------------------- очередь пушей (воркера нет)
async function jobById(id: string, ms = 2500): Promise<any | null> {
  const t0 = Date.now();
  for (;;) {
    const job = await getPushQueue().getJob(id);
    if (job) return job;
    if (Date.now() - t0 > ms) return null;
    await sleep(60);
  }
}
/** Пуш о сообщении: ждём задачу и сверяем получателей. null — задачи не должно быть. */
async function expectMessagePush(messageId: string, userIds: string[] | null, prefix = "msg-") {
  if (userIds === null) {
    await sleep(700); // enqueuePush — fire-and-forget после ответа маршрута
    const job = await getPushQueue().getJob(`${prefix}${messageId}`);
    assert.ok(!job, `пуша о ${messageId} быть не должно, а он ушёл: ${JSON.stringify(job?.data?.userIds)}`);
    return;
  }
  const job = await jobById(`${prefix}${messageId}`);
  assert.ok(job, `ждали пуш о ${messageId}`);
  assert.equal(job.data.payload.kind, "message");
  assert.deepEqual([...job.data.userIds].sort(), [...userIds].sort(), "получатели пуша");
}
async function jobsWhere(pred: (j: any) => boolean) {
  const jobs = await getPushQueue().getJobs(["waiting", "delayed", "active", "completed", "failed", "prioritized", "paused"]);
  return jobs.filter((j: any) => j && pred(j));
}

// ---------------------------------------------------------------- сокеты
type Ev = { ev: string; payload: any };
type Sock = { s: ReturnType<typeof ioClient>; events: Ev[]; label: string };
const openSockets: Sock[] = [];
async function connectSock(u: U, label: string, deviceId?: string): Promise<Sock> {
  const token = signAccessToken({ sub: u.id, tokenId: crypto.randomUUID(), ...(deviceId ? { did: deviceId } : {}) });
  const s = ioClient(baseUrl, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
  const sock: Sock = { s, events: [], label };
  // Слушатель — ДО подключения: снапшот сервер шлёт сразу после connect.
  s.onAny((ev: string, payload: any) => sock.events.push({ ev, payload }));
  await new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("connect_error", reject);
  });
  openSockets.push(sock);
  return sock;
}
const evs = (sock: Sock, ev: string, pred: (p: any) => boolean = () => true) =>
  sock.events.filter((e) => e.ev === ev && pred(e.payload)).map((e) => e.payload);
async function waitEv(sock: Sock, ev: string, pred: (p: any) => boolean = () => true, ms = 2500): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const got = evs(sock, ev, pred);
    if (got.length > 0) return got[got.length - 1];
    if (Date.now() - t0 > ms) throw new Error(`${sock.label}: не дождались ${ev}`);
    await sleep(20);
  }
}
/** Ждём, пока событий ev станет больше, чем было (before). */
async function waitMore(sock: Sock, ev: string, before: number, ms = 2500): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const got = evs(sock, ev);
    if (got.length > before) return got[got.length - 1];
    if (Date.now() - t0 > ms) throw new Error(`${sock.label}: не дождались нового ${ev}`);
    await sleep(20);
  }
}
/** Лимит conv_mute (30 в минуту на человека) — сброс в ТЕСТОВОМ Redis между разделами. */
async function resetMuteRate(u: U) {
  const r = await getRedisClient();
  const keys = await r.keys(`rl:conv_mute:user:${u.id}:*`);
  if (keys.length) await r.del(keys);
}
const notifyOf = (sock: Sock, messageId: string) => waitEv(sock, "message:notify", (p) => p?.messageId === messageId);

/** Все пути, где в объекте встречается ключ key (глубоко). */
function keyPaths(obj: unknown, key: string, path = "$", out: string[] = []): string[] {
  if (Array.isArray(obj)) obj.forEach((v, i) => keyPaths(v, key, `${path}[${i}]`, out));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === key) out.push(`${path}.${k}`);
      keyPaths(v, key, `${path}.${k}`, out);
    }
  }
  return out;
}
const participantLeaks = (obj: unknown) => keyPaths(obj, "mutedUntil").filter((p) => /participants\[\d+\]/.test(p));

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
  console.log(`[mute] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[mute] isolated backends: ${JSON.stringify(identity)}`);

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // U глушит (телефон + ПК), V пишет, W — третий в группе, X — посторонний, Y — добавляется в группу позже.
    const U = await mkUser("u", 2);
    const V = await mkUser("v");
    const W = await mkUser("w");
    const X = await mkUser("x");
    const Y = await mkUser("y");
    const [uPhone, uPc] = [U.devs[0]!, U.devs[1]!];
    // У телефона U — APNs-токен (для значка, F).
    await prisma.userDevice.update({ where: { id: uPhone }, data: { pushToken: crypto.randomBytes(32).toString("hex"), pushProvider: "apns" } });
    const bot = await prisma.user.create({
      data: { username: `${RUN}_bot`, passwordHash: `x_${crypto.randomUUID()}`, isBot: true, displayName: "Еблуша" },
    });

    const sU1 = await connectSock(U, "U/телефон", uPhone);
    const sU2 = await connectSock(U, "U/ПК", uPc);
    const sV = await connectSock(V, "V", V.dev);
    const sW = await connectSock(W, "W", W.dev);

    // Беседы: G — группа U,V,W (создаёт V); D — 1:1 U–V; B — «Чат с Еблушей» U; S — секретный тред V→U.
    const created = await call("POST", "/api/conversations", {
      token: V.token,
      body: { participantIds: [U.id, W.id], isGroup: true, title: `${RUN} группа` },
    });
    assert.ok(created.status === 201 || created.status === 200, `create G: ${JSON.stringify(created.body)}`);
    const G = created.body.conversation.id as string;
    const dm = await call("POST", "/api/conversations", { token: V.token, body: { participantIds: [U.id] } });
    assert.ok(dm.status === 201 || dm.status === 200, `create D: ${JSON.stringify(dm.body)}`);
    const D = dm.body.conversation.id as string;
    const B = (
      await prisma.conversation.create({
        data: { isGroup: false, createdById: U.id, participants: { create: [{ userId: U.id }, { userId: bot.id }] } } as any,
      })
    ).id;
    const th = await call("POST", "/api/threads/secret", { token: V.token, device: V.dev, body: { peerUserId: U.id } });
    assert.ok(th.status === 201 || th.status === 200, `create S: ${JSON.stringify(th.body)}`);
    const S = th.body.threadId as string;
    const leaksAtCreate = [...participantLeaks(created.body), ...participantLeaks(dm.body), ...participantLeaks(th.body)];

    // ================================================================ A. REST
    console.log("A — REST POST /api/conversations/:id/mute");
    await step("пресеты 1h/8h/1d/1w: срок = часы сервера + длительность; ответ {conversationId, mutedUntil, mutedForever, serverNow}", async () => {
      for (const [preset, span] of [["1h", HOUR], ["8h", 8 * HOUR], ["1d", 24 * HOUR], ["1w", 7 * 24 * HOUR]] as const) {
        const t0 = Date.now();
        const r = await mute(U, G, { for: preset });
        const t1 = Date.now();
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(Object.keys(r.body).sort(), ["conversationId", "mutedForever", "mutedUntil", "serverNow"]);
        assert.equal(r.body.conversationId, G);
        assert.equal(r.body.mutedForever, false);
        const until = Date.parse(r.body.mutedUntil);
        const now = Date.parse(r.body.serverNow);
        assert.ok(now >= t0 - 5 && now <= t1 + 5, "serverNow — момент запроса");
        assert.ok(until >= t0 + span && until <= t1 + span, `${preset}: срок ${r.body.mutedUntil}`);
        assert.ok(until - now <= span && until - now > span - 2000, `${preset}: до срока ${until - now} мс`);
        assert.equal((await dbUntil(U.id, G))?.toISOString(), r.body.mutedUntil, "в БД то же");
      }
    });
    await step("forever → 2100-01-01T00:00:00.000Z, mutedForever: true", async () => {
      const r = await mute(U, G, { for: "forever" });
      assert.equal(r.status, 200);
      assert.equal(r.body.mutedUntil, FOREVER_ISO);
      assert.equal(r.body.mutedForever, true);
      assert.equal((await dbUntil(U.id, G))?.toISOString(), MUTE_FOREVER.toISOString());
    });
    await step("until: ISO со смещением — точно; прошлое → снять; через 2 года → «Навсегда»; null → снять", async () => {
      const target = new Date(Math.floor((Date.now() + 10 * 60_000) / 1000) * 1000);
      const plus3 = new Date(target.getTime() + 3 * HOUR).toISOString().replace("Z", "+03:00");
      let r = await mute(U, G, { until: plus3 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.mutedUntil, target.toISOString());
      assert.equal(r.body.mutedForever, false);
      r = await mute(U, G, { until: new Date(Date.now() - 1000).toISOString() });
      assert.equal(r.status, 200);
      assert.equal(r.body.mutedUntil, null);
      assert.equal(r.body.mutedForever, false);
      assert.equal(await dbUntil(U.id, G), null);
      r = await mute(U, G, { until: new Date(Date.now() + 2 * 365 * 24 * HOUR).toISOString() });
      assert.equal(r.body.mutedUntil, FOREVER_ISO);
      assert.equal(r.body.mutedForever, true);
      r = await mute(U, G, { until: null });
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.mutedUntil, r.body.mutedForever], [null, false]);
      assert.equal(await dbUntil(U.id, G), null);
    });
    await step("мусор в теле → 400 MUTE_BAD_BODY, значение не меняется", async () => {
      await mute(U, G, { for: "1h" });
      const before = (await dbUntil(U.id, G))?.toISOString();
      for (const body of [{}, { for: "2d" }, { for: "1h", until: null }, { until: "tomorrow" }, { until: 1_700_000_000_000 }, []]) {
        const r = await mute(U, G, body);
        assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
        assert.equal(r.body.code, "MUTE_BAD_BODY");
      }
      assert.equal((await dbUntil(U.id, G))?.toISOString(), before);
    });
    await step("чужая беседа и несуществующая → 404 NOT_A_PARTICIPANT (одинаково), чужое значение не тронуто", async () => {
      let r = await mute(X, G, { for: "1h" });
      assert.equal(r.status, 404);
      assert.equal(r.body.code, "NOT_A_PARTICIPANT");
      r = await mute(X, "cm0nosuchconversation0000", { for: "1h" });
      assert.equal(r.status, 404);
      assert.equal(r.body.code, "NOT_A_PARTICIPANT");
      assert.equal(await prisma.conversationParticipant.count({ where: { conversationId: G, userId: X.id } }), 0);
      assert.equal(await dbUntil(V.id, G), null, "у V ничего не появилось");
    });
    await step("любая беседа: секретная (до и после принятия), «Чат с Еблушей», 1:1", async () => {
      let r = await mute(U, S, { for: "1h" });
      assert.equal(r.status, 200, `секретка до принятия: ${JSON.stringify(r.body)}`);
      const acc = await call("POST", `/api/threads/secret/${S}/accept`, { token: U.token, device: uPhone });
      assert.equal(acc.status, 200, `accept: ${JSON.stringify(acc.body)}`);
      leaksAtCreate.push(...participantLeaks(acc.body));
      r = await mute(U, S, { for: "forever" });
      assert.equal(r.status, 200);
      assert.equal(r.body.mutedForever, true);
      r = await mute(U, B, { for: "8h" });
      assert.equal(r.status, 200, `бот-чат: ${JSON.stringify(r.body)}`);
      r = await mute(U, D, { for: "forever" });
      assert.equal(r.status, 200);
    });
    await step("31-й запрос за минуту → 429 RATE_LIMITED", async () => {
      const R = await mkUser("r", 0);
      for (let i = 0; i < 30; i += 1) {
        const r = await mute(R, "cm0nosuchconversation0000", { for: "1h" });
        assert.equal(r.status, 404, `запрос ${i + 1}`);
      }
      const r = await mute(R, "cm0nosuchconversation0000", { for: "1h" });
      assert.equal(r.status, 429);
      assert.equal(r.body.code, "RATE_LIMITED");
    });

    // ================================================================ B. сокет
    console.log("B — conversation:mute и снапшот");
    await resetMuteRate(U);
    await step("conversation:mute → во все сокеты U (at = serverNow, byDeviceId), ни одного V/W", async () => {
      const mark = { u1: sU1.events.length, u2: sU2.events.length, v: sV.events.length, w: sW.events.length };
      const r = await mute(U, G, { for: "1h" }, uPhone);
      assert.equal(r.status, 200);
      const want = { conversationId: G, mutedUntil: r.body.mutedUntil, mutedForever: false, at: r.body.serverNow, byDeviceId: uPhone };
      for (const s of [sU1, sU2]) {
        const e = await waitEv(s, "conversation:mute", (p) => p.at === r.body.serverNow);
        assert.deepEqual(e, want, s.label);
      }
      await sleep(200);
      assert.equal(sU1.events.slice(mark.u1).filter((e) => e.ev === "conversation:mute").length, 1, "одно событие на сокет");
      assert.equal(sU2.events.slice(mark.u2).filter((e) => e.ev === "conversation:mute").length, 1);
      assert.equal(sV.events.slice(mark.v).filter((e) => e.ev === "conversation:mute").length, 0, "V не узнаёт");
      assert.equal(sW.events.slice(mark.w).filter((e) => e.ev === "conversation:mute").length, 0, "W не узнаёт");
    });
    await step("без устройства в запросе — без byDeviceId; «Включить звук» — mutedUntil: null", async () => {
      const r = await mute(U, G, { until: null });
      const e = await waitEv(sU2, "conversation:mute", (p) => p.at === r.body.serverNow);
      assert.deepEqual(e, { conversationId: G, mutedUntil: null, mutedForever: false, at: r.body.serverNow });
    });
    await step("снапшот при подключении: только заглушённые сейчас, замена целиком; у V пусто", async () => {
      const rg = await mute(U, G, { for: "1h" });
      await mute(U, D, { for: "forever" });
      // B — истёкший срок прямо в БД: в снапшот не попадает.
      await prisma.conversationParticipant.updateMany({ where: { conversationId: B, userId: U.id }, data: { mutedUntil: new Date(Date.now() - 1000) } });
      const t0 = Date.now();
      const s3 = await connectSock(U, "U/новый сокет", uPc);
      const snap = await waitEv(s3, "conversation:mute:snapshot");
      assert.deepEqual(Object.keys(snap).sort(), ["items", "serverNow"]);
      const sn = Date.parse(snap.serverNow);
      assert.ok(sn >= t0 - 5 && sn <= Date.now() + 5, "serverNow снапшота");
      const byId = new Map(snap.items.map((i: any) => [i.conversationId, i]));
      assert.deepEqual(byId.get(G), { conversationId: G, mutedUntil: rg.body.mutedUntil, mutedForever: false });
      assert.deepEqual(byId.get(D), { conversationId: D, mutedUntil: FOREVER_ISO, mutedForever: true });
      assert.ok(byId.has(S), "секретка «навсегда» в снапшоте");
      assert.ok(!byId.has(B), "истёкший срок не попадает");
      assert.equal(snap.items.length, 3);
      await mute(U, D, { until: null });
      const s4 = await connectSock(U, "U/после «Включить звук»", uPhone);
      const snap2 = await waitEv(s4, "conversation:mute:snapshot");
      assert.ok(!snap2.items.some((i: any) => i.conversationId === D), "снятое — пропадает из снапшота (замена)");
      const sv2 = await connectSock(V, "V/новый сокет");
      const snapV = await waitEv(sv2, "conversation:mute:snapshot");
      assert.deepEqual(snapV.items, []);
      const map = await mutedRecipients(G);
      assert.deepEqual([...map.keys()], [U.id], "mutedRecipients(G) — только U");
    });

    // ================================================================ C. список бесед
    console.log("C — GET /api/conversations");
    await resetMuteRate(U);
    await step("свой mutedUntil/mutedForever (истёкший → null), serverNow, totalUnread без заглушённых", async () => {
      await mute(U, D, { for: "forever" });
      await sent(V, D, "1:1 непрочитанное"); // в заглушённой D
      await sent(V, G, "группа непрочитанное"); // в заглушённой G
      await mute(U, S, { until: null });
      const t0 = Date.now();
      const r = await call("GET", "/api/conversations", { token: U.token });
      assert.equal(r.status, 200);
      const sn = Date.parse(r.body.serverNow);
      assert.ok(sn >= t0 - 5 && sn <= Date.now() + 5, "serverNow");
      const row = (id: string) => r.body.conversations.find((c: any) => c.conversation?.id === id);
      assert.equal(row(G).mutedForever, false);
      assert.equal(row(G).mutedUntil, (await dbUntil(U.id, G))?.toISOString());
      assert.deepEqual([row(D).mutedUntil, row(D).mutedForever], [FOREVER_ISO, true]);
      assert.deepEqual([row(B).mutedUntil, row(B).mutedForever], [null, false], "истёкший → null");
      assert.deepEqual([row(S).mutedUntil, row(S).mutedForever], [null, false]);
      assert.ok(row(D).unreadCount >= 1 && row(G).unreadCount >= 1);
      const expected = r.body.conversations.reduce((s: number, c: any) => s + (c.mutedUntil ? 0 : c.unreadCount), 0);
      assert.equal(r.body.totalUnread, expected);
      assert.ok(r.body.totalUnread < r.body.conversations.reduce((s: number, c: any) => s + c.unreadCount, 0), "заглушённые не считаются");
      assert.equal(await unreadTotalExcludingMuted(U.id), r.body.totalUnread, "тот же подсчёт, что у значка");
    });

    // ================================================================ D. приватность
    console.log("D — чужой mutedUntil никому не уходит");
    await step("список бесед: ни у V, ни у U нет participants[].mutedUntil; у V свои строки — null", async () => {
      const rv = await call("GET", "/api/conversations", { token: V.token });
      assert.deepEqual(participantLeaks(rv.body), [], "в participants[] у V");
      for (const c of rv.body.conversations) assert.equal(c.mutedUntil, null);
      const ru = await call("GET", "/api/conversations", { token: U.token });
      assert.deepEqual(participantLeaks(ru.body), [], "в participants[] у U");
      assert.deepEqual(leaksAtCreate, [], "создание беседы, треда, принятие");
    });
    await step("PATCH беседы и добавление участника (+conversations:updated): поля нет; «пригласил(а)» — muted для U", async () => {
      const p = await call("PATCH", `/api/conversations/${G}`, { token: W.token, body: { title: `${RUN} группа 2` } });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.deepEqual(keyPaths(p.body, "mutedUntil"), []);
      const markU = sU1.events.length;
      const a = await call("POST", `/api/conversations/${G}/participants`, { token: W.token, body: { participantIds: [Y.id] } });
      assert.ok(a.status < 300, JSON.stringify(a.body));
      assert.deepEqual(keyPaths(a.body, "mutedUntil"), []);
      const upd = await waitEv(sU1, "conversations:updated", (x) => x.conversationId === G && !!x.conversation);
      assert.deepEqual(keyPaths(upd, "mutedUntil"), [], "conversations:updated без mutedUntil");
      const sys = await waitEv(sU1, "message:notify", (x) => x.conversationId === G && x.senderId === W.id);
      assert.equal(sys.muted, true, "системная запись в заглушённой группе — muted");
      const sysV = await waitEv(sV, "message:notify", (x) => x.messageId === sys.messageId);
      assert.equal(sysV.muted, false);
      assert.ok(sU1.events.length > markU);
    });

    // ================================================================ E. пуши и message:notify
    console.log("E — пуши и message:notify.muted");
    await resetMuteRate(U);
    // G заглушена у U на час, D — навсегда, S — звук включён. В G после раздела D — ещё и Y.
    await mute(U, G, { for: "1h" });
    const GO = [W.id, Y.id]; // остальные участники G, кроме U и отправителя V
    await step("группа: обычное → U без пуша, muted:true; W — пуш, muted:false", async () => {
      const m = await sent(V, G, "обычное");
      await expectMessagePush(m, GO);
      assert.equal((await notifyOf(sU1, m)).muted, true);
      assert.equal((await notifyOf(sU2, m)).muted, true, "на всех сокетах U");
      assert.equal((await notifyOf(sW, m)).muted, false);
    });
    const mU = await sent(U, G, "вопрос от U");
    const mW = await sent(W, G, "вопрос от W");
    await step("группа: ответ на МОЁ → пуш U, muted:false", async () => {
      const r1 = await sent(V, G, "ответ U", mU);
      await expectMessagePush(r1, [U.id, ...GO]);
      assert.equal((await notifyOf(sU1, r1)).muted, false);
      assert.equal((await notifyOf(sU2, r1)).muted, false);
    });
    await step("группа: ответ на чужое → U без пуша, muted:true (W — пуш)", async () => {
      const r2 = await sent(V, G, "ответ W", mW);
      await expectMessagePush(r2, GO);
      assert.equal((await notifyOf(sU1, r2)).muted, true);
      assert.equal((await notifyOf(sW, r2)).muted, false);
    });
    await step("группа: ответ бота на МОЙ вопрос → пуш U; на чужой → нет", async () => {
      const b1 = await createBotMessage({ botId: bot.id, conversationId: G, type: "TEXT", content: "бот U", replyToId: mU, kind: "answer" });
      await expectMessagePush(b1.id, [U.id, V.id, ...GO]);
      assert.equal((await notifyOf(sU1, b1.id)).muted, false);
      const b2 = await createBotMessage({ botId: bot.id, conversationId: G, type: "TEXT", content: "бот W", replyToId: mW, kind: "answer" });
      await expectMessagePush(b2.id, [V.id, ...GO]);
      assert.equal((await notifyOf(sU1, b2.id)).muted, true);
    });
    await step("1:1 заглушена: ответ на моё → пуша нет, muted:true", async () => {
      const mine = await sent(U, D, "моё в личке");
      const rep = await sent(V, D, "ответ в личке", mine);
      await expectMessagePush(rep, null);
      assert.equal((await notifyOf(sU1, rep)).muted, true);
    });
    await step("«Чат с Еблушей» заглушён: ответ бота на моё → пуша нет, muted:true", async () => {
      await mute(U, B, { for: "1d" });
      const mine = await sent(U, B, "вопрос боту");
      const ans = await createBotMessage({ botId: bot.id, conversationId: B, type: "TEXT", content: "ответ", replyToId: mine, kind: "answer" });
      await expectMessagePush(ans.id, null);
      assert.equal((await notifyOf(sU1, ans.id)).muted, true);
    });
    await step("1:1 заглушена: входящий звонок (kind:call) уходит; «Пропущенный звонок» — пуш есть", async () => {
      const markU = sU1.events.length;
      sV.s.emit("call:invite", { conversationId: D, video: false });
      await waitEv(sU1, "call:incoming", (p) => p.conversationId === D);
      const callJobs = await (async () => {
        const t0 = Date.now();
        for (;;) {
          const j = await jobsWhere((x) => x.data?.payload?.kind === "call" && x.data?.payload?.conversationId === D);
          if (j.length || Date.now() - t0 > 2500) return j;
          await sleep(60);
        }
      })();
      assert.equal(callJobs.length, 1, "пуш о входящем 1:1");
      assert.deepEqual(callJobs[0]!.data.userIds, [U.id]);
      sV.s.emit("call:end", { conversationId: D });
      await waitEv(sU1, "call:ended", (p) => p.conversationId === D);
      let missed: { id: string } | null = null;
      const t0 = Date.now();
      while (!missed && Date.now() - t0 < 2500) {
        missed = await prisma.message.findFirst({
          where: { conversationId: D, type: "SYSTEM", metadata: { path: ["missed"], equals: true } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (!missed) await sleep(60);
      }
      assert.ok(missed, "запись «Пропущенный звонок»");
      await expectMessagePush(missed.id, [U.id]);
      assert.ok(sU1.events.length > markU);
    });
    await step("1:1 заглушена: «Звонок продлился» → muted:false", async () => {
      await sleep(2100); // call:invite не чаще раза в 2 с на (человек, беседа)
      const before = evs(sU1, "call:incoming").length;
      sV.s.emit("call:invite", { conversationId: D, video: false });
      await waitMore(sU1, "call:incoming", before);
      sU1.s.emit("call:accept", { conversationId: D, video: false });
      await waitEv(sV, "call:accepted", (p) => p.conversationId === D);
      sV.s.emit("call:end", { conversationId: D });
      const n = await waitEv(sU1, "message:notify", (p) => p.conversationId === D && p.message?.metadata?.ended === true);
      assert.equal(n.muted, false);
    });
    await step("группа заглушена: «начал звонок» — пуша U нет, muted:true; W — пуш; «продлился» — muted:true", async () => {
      sV.s.emit("call:invite", { conversationId: G, video: true });
      const nw = await waitEv(sW, "message:notify", (p) => p.conversationId === G && p.message?.metadata?.started === true);
      assert.equal(nw.muted, false);
      const nu = await notifyOf(sU1, nw.messageId);
      assert.equal(nu.muted, true);
      await expectMessagePush(nw.messageId, GO);
      // sentAt — момент записи (часы сервера): по нему клиенты ловят гонку «заглушили сразу после постановки пуша».
      const callJob = await jobById(`msg-${nw.messageId}`);
      assert.equal(callJob.data.payload.sentAt, new Date(nw.message.createdAt).getTime(), "sentAt пуша «Групповой звонок»");
      sV.s.emit("call:end", { conversationId: G });
      const endU = await waitEv(sU1, "message:notify", (p) => p.conversationId === G && p.message?.metadata?.ended === true);
      assert.equal(endU.muted, true);
      const endW = await notifyOf(sW, endU.messageId);
      assert.equal(endW.muted, false);
    });
    await step("секретка заглушена: пуша нет, secret:notify есть; после «Включить звук» — пуш есть", async () => {
      await mute(U, S, { for: "1w" });
      const push = async () => {
        const msgId = crypto.randomUUID();
        const r = await call("POST", "/api/secret/messages/push", {
          token: V.token,
          device: V.dev,
          body: {
            threadId: S,
            msgId,
            createdAt: new Date().toISOString(),
            headerJson: { v: 1, kind: "msg", nonce: b64() },
            ciphertext: b64(),
            contentType: "text",
            receiverDeviceIds: [uPhone],
          },
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        return msgId;
      };
      const m1 = await push();
      await waitEv(sU1, "secret:notify", (p) => p.msgId === m1);
      await expectMessagePush(m1, null, "secret-");
      await mute(U, S, { until: null });
      const m2 = await push();
      await waitEv(sU1, "secret:notify", (p) => p.msgId === m2);
      await expectMessagePush(m2, [U.id], "secret-");
    });
    await step("истечение: until = now+1,5 с → пуша нет; после срока — есть, muted:false (без уборки в БД)", async () => {
      const until = new Date(Date.now() + 1500);
      const r = await mute(U, G, { until: until.toISOString() });
      assert.equal(r.body.mutedUntil, until.toISOString());
      const m1 = await sent(V, G, "до срока");
      await expectMessagePush(m1, GO);
      assert.equal((await notifyOf(sU1, m1)).muted, true);
      await sleep(Math.max(0, until.getTime() - Date.now()) + 250);
      const m2 = await sent(V, G, "после срока");
      await expectMessagePush(m2, [U.id, ...GO]);
      assert.equal((await notifyOf(sU1, m2)).muted, false);
      assert.equal((await dbUntil(U.id, G))?.toISOString(), until.toISOString(), "в БД значение осталось — истекло сравнением");
      const list = await call("GET", "/api/conversations", { token: U.token });
      const row = list.body.conversations.find((c: any) => c.conversation?.id === G);
      assert.deepEqual([row.mutedUntil, row.mutedForever], [null, false]);
    });
    await step("message:notify несёт muted всегда (boolean), даже без «Без звука»", async () => {
      const m = await sent(U, G, "от U");
      const n = await notifyOf(sV, m);
      assert.equal(typeof n.muted, "boolean");
      assert.equal(n.muted, false);
    });

    // ================================================================ F. значок APNs
    console.log("F — значок APNs");
    await resetMuteRate(U);
    const cfg: ApnsConfig = { key: "", keyId: "K", teamId: "T", bundleId: "org.eblusha.test", primaryHost: "h", fallbackHost: null };
    const tgt = { userId: U.id, deviceId: uPhone, token: "t", provider: "apns" as const };
    const msgPayload = { kind: "message", conversationId: G, messageId: "m", senderId: V.id, senderName: "V" } as const;
    await step("buildRequest: badge — в aps alert-пуша о сообщении; без него — ключа нет; read — никогда", async () => {
      const withBadge = JSON.parse(buildRequest(cfg, tgt, msgPayload, { badge: 7 })!.body);
      assert.equal(withBadge.aps.badge, 7);
      assert.equal(withBadge.badge, undefined, "не в кастомных данных");
      const noBadge = buildRequest(cfg, tgt, msgPayload)!.body;
      assert.ok(!noBadge.includes('"badge"'));
      const read = buildRequest(cfg, tgt, { kind: "read", conversationId: G }, { badge: 3 })!.body;
      assert.ok(!read.includes('"badge"'), "в тихий read-пуш значок не кладём");
    });
    await step("buildRequest kind badge: alert без alert/sound, только aps.badge, priority 10, collapse-id badge; без числа и на VoIP — нет", async () => {
      const req = buildRequest(cfg, tgt, { kind: "badge" }, { badge: 4 })!;
      assert.equal(req.headers["apns-push-type"], "alert");
      assert.equal(req.headers["apns-priority"], "10");
      assert.equal(req.headers["apns-collapse-id"], "badge");
      assert.equal(req.headers["apns-topic"], cfg.bundleId);
      assert.deepEqual(JSON.parse(req.body), { aps: { badge: 4 }, kind: "badge" });
      assert.equal(buildRequest(cfg, tgt, { kind: "badge" }), null, "без числа слать нечего");
      assert.equal(buildRequest(cfg, tgt, { kind: "badge" }, { badge: -1 }), null);
      assert.equal(buildRequest(cfg, { ...tgt, provider: "apns-voip" }, { kind: "badge" }, { badge: 4 }), null, "VoIP — нет");
    });

    // Устройства U для значка: uNew — сборка с поддержкой (caps badge), uOld — старая сборка (без caps); у uPhone
    // токен вписан прямо в БД (тоже без caps — как у всех, кто ещё на 995). uPc получит FCM-токен.
    const uNew = await addDevice(U, "inew");
    const uOld = await addDevice(U, "iold");
    const capKey = `push:badge:${U.id}`;
    const regPush = (dev: string, body: unknown) => call("POST", `/api/devices/${dev}/push`, { token: U.token, device: dev, body });
    const tokNew = crypto.randomBytes(32).toString("hex");
    const tokOld = crypto.randomBytes(32).toString("hex");
    const flag0 = (env as any).APNS_BADGE;
    await step("регистрация токена: caps badge → {badge:true} при on; без caps — false и объявление снято; off — false; DELETE снимает; VoIP/FCM — без поля", async () => {
      const redis = await getRedisClient();
      try {
        (env as any).APNS_BADGE = "on";
        const a = await regPush(uNew, { token: tokNew, provider: "apns", caps: ["badge", "что-то-новое"] });
        assert.equal(a.status, 200, JSON.stringify(a.body));
        assert.deepEqual(a.body, { ok: true, badge: true });
        assert.ok(await redis.hExists(capKey, uNew), "объявление в Redis");
        assert.ok((await redis.pTTL(capKey)) > 100 * 24 * HOUR, "живёт долго (обновляется при каждой регистрации)");
        const b = await regPush(uOld, { token: tokOld, provider: "apns" });
        assert.deepEqual(b.body, { ok: true, badge: false }, "старая сборка — без значка");
        assert.ok(!(await redis.hExists(capKey, uOld)));
        // Откат на старую сборку: та же регистрация без caps снимает объявление.
        const c = await regPush(uNew, { token: tokNew, provider: "apns" });
        assert.deepEqual(c.body, { ok: true, badge: false });
        assert.ok(!(await redis.hExists(capKey, uNew)), "без caps — объявление снято");
        // off: объявление запоминается, но «число ведёт сервер» не обещаем.
        (env as any).APNS_BADGE = "off";
        const d = await regPush(uNew, { token: tokNew, provider: "apns", caps: ["badge"] });
        assert.deepEqual(d.body, { ok: true, badge: false });
        assert.ok(await redis.hExists(capKey, uNew));
        // Выход: DELETE снимает токены и объявление.
        const del = await call("DELETE", `/api/devices/${uNew}/push`, { token: U.token, device: uNew });
        assert.equal(del.status, 200);
        assert.ok(!(await redis.hExists(capKey, uNew)), "DELETE снимает объявление");
        // VoIP и FCM — без поля badge; VoIP-регистрация объявление не ставит.
        const voip = await regPush(uNew, { token: crypto.randomBytes(32).toString("hex"), provider: "apns-voip", caps: ["badge"] });
        assert.deepEqual(voip.body, { ok: true });
        assert.ok(!(await redis.hExists(capKey, uNew)), "VoIP-регистрация объявление не ставит");
        const fcm = await call("POST", `/api/devices/${uPc}/push`, { token: U.token, device: uPc, body: { token: `fcm_${b64()}`, provider: "fcm" } });
        assert.deepEqual(fcm.body, { ok: true });
        // Итог для следующих шагов: uNew — с caps, uOld — без.
        (env as any).APNS_BADGE = "on";
        const e = await regPush(uNew, { token: tokNew, provider: "apns", caps: ["badge"] });
        assert.deepEqual(e.body, { ok: true, badge: true });
      } finally {
        (env as any).APNS_BADGE = flag0;
      }
    });

    /** Заглушки транспортов: записываем вызовы, никуда не шлём. */
    async function withTransports(fn: (calls: { apns: any[][]; fcm: any[][] }) => Promise<void>) {
      const orig = { apns: apnsExports.sendApns, fcm: fcmExports.sendFcm, flag: (env as any).APNS_BADGE };
      const calls = { apns: [] as any[][], fcm: [] as any[][] };
      apnsExports.sendApns = async (...args: any[]) => {
        calls.apns.push(args);
        return { sent: args[0].length, dead: [] };
      };
      fcmExports.sendFcm = async (...args: any[]) => {
        calls.fcm.push(args);
        return { sent: args[0].length, dead: [] };
      };
      try {
        await fn(calls);
      } finally {
        apnsExports.sendApns = orig.apns;
        fcmExports.sendFcm = orig.fcm;
        (env as any).APNS_BADGE = orig.flag;
      }
    }
    const ids = (targets: any[]) => targets.map((t: any) => t.deviceId).sort();
    const nonEmpty = (cs: any[][]) => cs.filter((c) => c[0].length > 0);

    await step("sendPushToUsers message: APNS_BADGE=on — число (без заглушённых, = totalUnread) только устройству с caps; off — ни у кого", async () => {
      await withTransports(async (calls) => {
        await mute(U, D, { until: null });
        const all = await unreadTotalExcludingMuted(U.id);
        await mute(U, D, { for: "forever" });
        const withoutD = await unreadTotalExcludingMuted(U.id);
        assert.ok(withoutD < all, `заглушённая D не считается (${withoutD} < ${all})`);
        (env as any).APNS_BADGE = "on";
        await sendPushToUsers([U.id], msgPayload);
        assert.equal(calls.apns.length, 1);
        assert.deepEqual(ids(calls.apns[0]![0]), [uNew, uOld, uPhone].sort(), "пуш о сообщении — всем iOS");
        const byDev: ReadonlyMap<string, number> = calls.apns[0]![2]?.badgeByDevice;
        assert.deepEqual([...byDev.keys()], [uNew], "число — только сборке с caps badge");
        assert.equal(byDev.get(uNew), withoutD);
        const list = await call("GET", "/api/conversations", { token: U.token });
        assert.equal(list.body.totalUnread, withoutD, "значок = totalUnread списка");
        (env as any).APNS_BADGE = "off";
        await sendPushToUsers([U.id], msgPayload);
        assert.equal(calls.apns.length, 2);
        assert.equal(calls.apns[1]![2], undefined, "off — без badge");
      });
    });
    await step("sendPushToUsers kind badge: только устройству с caps (FCM и старым сборкам — нет); off — никому", async () => {
      await withTransports(async (calls) => {
        (env as any).APNS_BADGE = "on";
        const expected = await unreadTotalExcludingMuted(U.id);
        const r = await sendPushToUsers([U.id], { kind: "badge" });
        assert.equal(r.sent, 1);
        assert.equal(nonEmpty(calls.fcm).length, 0, "FCM badge-пуш не получает");
        assert.equal(calls.apns.length, 1);
        assert.deepEqual(ids(calls.apns[0]![0]), [uNew]);
        assert.equal(calls.apns[0]![1].kind, "badge");
        assert.equal(calls.apns[0]![2]?.badgeByDevice?.get(uNew), expected);
        (env as any).APNS_BADGE = "off";
        const r2 = await sendPushToUsers([U.id], { kind: "badge" });
        assert.equal(r2.sent, 0);
        assert.equal(nonEmpty(calls.apns).length, 1, "off — badge-пушей нет");
      });
    });
    await step("sendPushToUsers read: read-пуш всем (iOS и Android) + следом badge-only пуш устройству с caps; off — без него", async () => {
      await withTransports(async (calls) => {
        (env as any).APNS_BADGE = "on";
        await sendPushToUsers([U.id], { kind: "read", conversationId: G, readAt: Date.now() });
        assert.equal(calls.fcm.length, 1);
        assert.deepEqual(ids(calls.fcm[0]![0]), [uPc], "read — Android");
        const apns = nonEmpty(calls.apns);
        assert.equal(apns.length, 2, "read-пуш и следом badge-пуш");
        assert.equal(apns[0]![1].kind, "read");
        assert.deepEqual(ids(apns[0]![0]), [uNew, uOld, uPhone].sort());
        assert.equal(apns[0]![2], undefined, "в read-пуше числа нет");
        assert.equal(apns[1]![1].kind, "badge");
        assert.deepEqual(ids(apns[1]![0]), [uNew]);
        assert.equal(apns[1]![2]?.badgeByDevice?.get(uNew), await unreadTotalExcludingMuted(U.id));
        // Устройство, которое само прочитало (исключено из read-пуша), badge-пуш тоже не получает: оно на экране.
        calls.apns.length = 0;
        await sendPushToUsers([U.id], { kind: "read", conversationId: G }, { excludeDeviceIds: [uNew] });
        assert.deepEqual(nonEmpty(calls.apns).map((c) => c[1].kind), ["read"]);
        calls.apns.length = 0;
        (env as any).APNS_BADGE = "off";
        await sendPushToUsers([U.id], { kind: "read", conversationId: G });
        assert.deepEqual(nonEmpty(calls.apns).map((c) => c[1].kind), ["read"], "off — без badge-пуша");
      });
    });
    await step("POST mute (on): badge-задача сразу и к истечению срока; «навсегда»/«Включить звук» — только сразу; off — ничего", async () => {
      await resetMuteRate(U);
      const badgeJobs = async () => jobsWhere((j) => j.data?.payload?.kind === "badge" && j.data.userIds?.[0] === U.id);
      try {
        (env as any).APNS_BADGE = "on";
        const before = (await badgeJobs()).map((j: any) => j.id);
        const r = await mute(U, G, { for: "1h" });
        assert.equal(r.status, 200);
        await sleep(400); // enqueuePush — fire-and-forget
        const fresh = (await badgeJobs()).filter((j: any) => !before.includes(j.id));
        const untilMs = Date.parse(r.body.mutedUntil);
        const exp = fresh.find((j: any) => j.id === `badge-exp-${U.id}-${G}-${untilMs}`);
        assert.ok(exp, `задача к истечению: ${JSON.stringify(fresh.map((j: any) => j.id))}`);
        const delay = Number(exp.opts?.delay ?? exp.delay);
        assert.ok(Math.abs(delay - (untilMs - Date.parse(r.body.serverNow) + 1000)) < 50, `delay ${delay}`);
        assert.equal(fresh.filter((j: any) => !String(j.id).startsWith("badge-exp-")).length, 1, "и одна — сразу");
        const before2 = (await badgeJobs()).map((j: any) => j.id);
        await mute(U, G, { for: "forever" });
        await mute(U, G, { until: null });
        await sleep(400);
        const fresh2 = (await badgeJobs()).filter((j: any) => !before2.includes(j.id));
        assert.equal(fresh2.length, 2, `две немедленные: ${JSON.stringify(fresh2.map((j: any) => [j.id, j.opts?.delay]))}`);
        assert.ok(fresh2.every((j: any) => !String(j.id).startsWith("badge-exp-")), "без задачи к истечению");
        (env as any).APNS_BADGE = "off";
        const before3 = (await badgeJobs()).length;
        await mute(U, G, { for: "8h" });
        await sleep(400);
        assert.equal((await badgeJobs()).length, before3, "off — badge-задач нет");
      } finally {
        (env as any).APNS_BADGE = flag0;
      }
    });

    await step("за весь прогон: у V/W (ничего не глушили) ни в одном событии нет mutedUntil, кроме снапшота", async () => {
      for (const s of [sV, sW]) {
        const leaks = s.events.filter((e) => e.ev !== "conversation:mute:snapshot" && keyPaths(e.payload, "mutedUntil").length > 0);
        assert.deepEqual(leaks.map((e) => e.ev), [], `${s.label}`);
      }
      for (const s of [sU1, sU2]) {
        const leaks = s.events.flatMap((e) => participantLeaks(e.payload).map((p) => `${e.ev}:${p}`));
        assert.deepEqual(leaks, [], `${s.label}: participants[].mutedUntil в событиях`);
      }
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
    console.log(`\nconversation-mute: ${results.length - failed.length}/${results.length} ok`);
    for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
    await getPushQueue().close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(failed.length ? 1 : 0);
  },
  async (err) => {
    console.error("conversation-mute: CRASHED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  },
);
