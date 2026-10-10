/**
 * «Прочитано» только от участника беседы: POST /messages/receipts и POST /messages/mark-conversation-read.
 *
 * До правки обе ручки не проверяли членство в обычных беседах: посторонний (или вышедший из группы)
 * мог поставить квитанции READ/DELIVERED на сообщения чужой беседы, и сервер рассылал её участникам
 * receipts:update — у отправителя появлялось «прочитано» от чужого человека. Теперь:
 *   - mark-conversation-read: не участник (обычная / секретная / несуществующая беседа, вышедший из
 *     группы) → 200 {success:true} без действий — одинаково для всех, по ответу не узнать ни
 *     существование беседы, ни секретная ли она; квитанций нет, receipts:update и read-self нет;
 *   - receipts: чужие и несуществующие id молча отбрасываются (раньше несуществующий id ронял запрос
 *     в 500 на внешнем ключе), свои — как прежде; смешанный запрос пишет только свои;
 *   - участник — всё как раньше (квитанции, receipts:update в комнату беседы, read-self себе).
 *
 * Запускать ТОЛЬКО в изолированной среде (guard.ts не пустит к боевым БД/Redis):
 *   test/secret-env/secret-test.sh run test/receipts-membership.integration.test.ts
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
import { io as ioClient } from "socket.io-client";

const RUN = `ebst_rm_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let baseUrl = "";

type Resp = { status: number; body: any };
async function call(method: "GET" | "POST", path: string, opts: { token: string; body?: unknown }): Promise<Resp> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
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
async function mkConv(members: U[], opts: { secret?: boolean; group?: boolean } = {}): Promise<string> {
  const c = await prisma.conversation.create({
    data: {
      isGroup: Boolean(opts.group),
      isSecret: Boolean(opts.secret),
      ...(opts.secret ? { type: "SECRET" } : {}),
      createdById: members[0]!.id,
      participants: { create: members.map((m) => ({ userId: m.id })) },
    } as any,
  });
  return c.id;
}
const mkMsg = async (conversationId: string, senderId: string) =>
  (await prisma.message.create({ data: { conversationId, senderId, content: "x" } })).id;
const receiptsOf = (userId: string, messageIds: string[]) =>
  prisma.messageReceipt.findMany({ where: { userId, messageId: { in: messageIds } }, select: { messageId: true, status: true } });

const markRead = (u: U, conversationId: string) =>
  call("POST", "/api/messages/mark-conversation-read", { token: u.token, body: { conversationId } });
const receipts = (u: U, messageIds: string[], status: string) =>
  call("POST", "/api/messages/receipts", { token: u.token, body: { messageIds, status } });

// Сокеты: участник беседы входит в её комнату (conversation:join) — как настоящий клиент с открытой беседой.
type Sock = { s: ReturnType<typeof ioClient>; events: Array<{ event: string; payload: any }>; label: string };
const openSockets: Sock[] = [];
async function connectSock(u: U, label: string, joinConversations: string[] = []): Promise<Sock> {
  const token = signAccessToken({ sub: u.id, tokenId: crypto.randomUUID() });
  const s = ioClient(baseUrl, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
  const sock: Sock = { s, events: [], label };
  s.onAny((event: string, payload: any) => sock.events.push({ event, payload }));
  await new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("connect_error", reject);
  });
  for (const c of joinConversations) s.emit("conversation:join", c);
  await sleep(200);
  openSockets.push(sock);
  return sock;
}
const eventsOf = (sock: Sock, event: string, conversationId: string) =>
  sock.events.filter((e) => e.event === event && e.payload?.conversationId === conversationId);

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
  console.log(`[receipts-membership] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[receipts-membership] isolated backends: ${JSON.stringify(identity)}`);

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const A = await mkUser("a"); // участник
    const B = await mkUser("b"); // участник, пишет
    const X = await mkUser("x"); // посторонний
    const L = await mkUser("l"); // вышел из группы

    const direct = await mkConv([A, B]);
    const group = await mkConv([A, B, L], { group: true });
    const secret = await mkConv([A, B], { secret: true });
    const directMsgs = [await mkMsg(direct, B.id), await mkMsg(direct, B.id)];
    const groupMsgs = [await mkMsg(group, B.id), await mkMsg(group, A.id)];
    // L вышел из группы: участие удалено, как в DELETE /conversations/:id/participants/me.
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: group, userId: L.id } });

    const sA = await connectSock(A, "A (участник, в комнатах бесед)", [direct, group, secret]);
    const sB = await connectSock(B, "B (участник, в комнатах бесед)", [direct, group, secret]);
    const sX = await connectSock(X, "X (посторонний)");
    const sL = await connectSock(L, "L (вышел из группы)");

    console.log("mark-conversation-read");
    await step("посторонний, обычная беседа → 200 {success:true}, квитанций нет, receipts:update и read-self нет", async () => {
      const r = await markRead(X, direct);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true });
      await sleep(600);
      assert.equal((await receiptsOf(X.id, directMsgs)).length, 0, "посторонний не должен получить квитанции");
      for (const s of [sA, sB]) assert.equal(eventsOf(s, "receipts:update", direct).length, 0, `${s.label}: receipts:update`);
      assert.equal(eventsOf(sX, "conversation:read-self", direct).length, 0, "read-self постороннему");
    });
    await step("посторонний, секретная беседа → тот же ответ, read-self нет", async () => {
      const r = await markRead(X, secret);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true });
      await sleep(400);
      assert.equal(eventsOf(sX, "conversation:read-self", secret).length, 0);
    });
    await step("несуществующая беседа → тот же ответ (по ответу не отличить)", async () => {
      const r = await markRead(X, "cm0nonexistentconversation1");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true });
    });
    await step("вышедший из группы → 200 без действий: квитанций нет, участникам receipts:update нет", async () => {
      const r = await markRead(L, group);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true });
      await sleep(600);
      assert.equal((await receiptsOf(L.id, groupMsgs)).length, 0);
      for (const s of [sA, sB]) assert.equal(eventsOf(s, "receipts:update", group).length, 0, `${s.label}: receipts:update`);
      assert.equal(eventsOf(sL, "conversation:read-self", group).length, 0);
    });
    await step("участник → квитанции READ на чужие сообщения, receipts:update в комнату, read-self себе (как раньше)", async () => {
      const r = await markRead(A, direct);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true });
      const t0 = Date.now();
      while (eventsOf(sA, "conversation:read-self", direct).length < 1 && Date.now() - t0 < 2500) await sleep(30);
      const rec = await receiptsOf(A.id, directMsgs);
      assert.equal(rec.length, directMsgs.length);
      assert.ok(rec.every((x) => x.status === "READ"));
      assert.equal(eventsOf(sB, "receipts:update", direct).length, 1, "B видит, что A прочитал");
      assert.equal(eventsOf(sA, "conversation:read-self", direct).length, 1, "read-self своим сокетам");
    });
    await step("участник секретной беседы → read-self себе (как раньше)", async () => {
      const r = await markRead(A, secret);
      assert.equal(r.status, 200);
      const t0 = Date.now();
      while (eventsOf(sA, "conversation:read-self", secret).length < 1 && Date.now() - t0 < 2500) await sleep(30);
      assert.equal(eventsOf(sA, "conversation:read-self", secret).length, 1);
    });

    console.log("receipts");
    await step("посторонний: id чужой беседы → 200 {receipts:[]}, ничего не записано, receipts:update нет", async () => {
      const before = sB.events.length;
      const r = await receipts(X, directMsgs, "READ");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { receipts: [] });
      await sleep(600);
      assert.equal((await receiptsOf(X.id, directMsgs)).length, 0);
      assert.equal(sB.events.slice(before).filter((e) => e.event === "receipts:update").length, 0);
      assert.equal(eventsOf(sX, "conversation:read-self", direct).length, 0);
    });
    await step("посторонний: DELIVERED тоже отбрасывается", async () => {
      const r = await receipts(X, [groupMsgs[0]!], "DELIVERED");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { receipts: [] });
      assert.equal((await receiptsOf(X.id, groupMsgs)).length, 0);
    });
    await step("вышедший из группы: квитанции на сообщения группы отбрасываются", async () => {
      const r = await receipts(L, groupMsgs, "READ");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { receipts: [] });
      assert.equal((await receiptsOf(L.id, groupMsgs)).length, 0);
    });
    await step("несуществующий id → 200 (раньше 500 на внешнем ключе)", async () => {
      const r = await receipts(A, ["cm0nonexistentmessage00001"], "READ");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { receipts: [] });
    });
    await step("смешанный запрос участника: свои записаны, чужие и несуществующие отброшены, событие только по своей беседе", async () => {
      const C = await mkUser("c");
      const foreign = await mkConv([B, C]);
      const foreignMsg = await mkMsg(foreign, C.id);
      const sC = await connectSock(C, "C (чужая беседа B–C)", [foreign]);
      const g1 = groupMsgs[0]!;
      const r = await receipts(A, [g1, g1, foreignMsg, "cm0nonexistentmessage00002"], "READ");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.receipts.length, 1, "одна квитанция (дубль id схлопнут)");
      assert.equal(r.body.receipts[0].messageId, g1);
      assert.equal(r.body.receipts[0].status, "READ");
      const t0 = Date.now();
      while (eventsOf(sB, "receipts:update", group).length < 1 && Date.now() - t0 < 2500) await sleep(30);
      assert.equal(eventsOf(sB, "receipts:update", group).length, 1);
      await sleep(300);
      assert.equal((await receiptsOf(A.id, [foreignMsg])).length, 0, "в чужой беседе квитанции нет");
      assert.equal(eventsOf(sC, "receipts:update", foreign).length, 0, "участники чужой беседы ничего не получают");
      assert.equal(eventsOf(sA, "conversation:read-self", foreign).length, 0);
      // read-self по группе: сообщение B стало прочитанным впервые
      while (eventsOf(sA, "conversation:read-self", group).length < 1 && Date.now() - t0 < 2500) await sleep(30);
      assert.equal(eventsOf(sA, "conversation:read-self", group).length, 1);
    });
    await step("участник: DELIVERED на сообщения своей беседы — как раньше", async () => {
      const m = await mkMsg(direct, B.id);
      const r = await receipts(A, [m], "DELIVERED");
      assert.equal(r.status, 200);
      assert.equal(r.body.receipts.length, 1);
      assert.equal(r.body.receipts[0].status, "DELIVERED");
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
    console.log(`\nreceipts-membership: ${results.length - failed.length}/${results.length} ok`);
    for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
    await getPushQueue().close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(failed.length ? 1 : 0);
  },
  async (err) => {
    console.error("receipts-membership: CRASHED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  },
);
