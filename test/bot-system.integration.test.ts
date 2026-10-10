/**
 * Бот «Еблуша» — часть системы (src/lib/systemBot.ts, src/routes/bot.ts): серверная сторона без
 * сервиса бота. Задачи очереди `bot` читаем прямо из BullMQ (воркера в этом тесте нет), а ответы
 * «бота» шлём его учёткой через /api/bot/*.
 *
 * Что проверяем:
 *   - обращение в личке двух людей и в группе («Еблуша,», /eb, ответ на сообщение бота, режим
 *     «Спросить» metadata.botAsk), и что НЕ обращение (середина фразы, пересылка, правка, botAsk:false,
 *     ответ на сообщение бота из другой беседы) задачи не даёт;
 *   - в задаче — только триггер и цепочка ответов, без остальной переписки;
 *   - ответ бота: только в беседу обращения (разрешение), isBot у сообщения и отправителя, рассылка
 *     участникам (message:new / message:notify / пуш), typing и реакция бота, лимит сообщений на обращение;
 *   - бот не участник и не видит лишнего: не в participants, не читает беседы, не в контактах/поиске,
 *     не добавляется в группы, не создаёт секретный тред; посторонний не видит чужую беседу;
 *   - секретки: облачная отправка 409, задач нет; профиль бота и текст отказа доступны всем;
 *   - «Чат с Еблушей»: по умолчанию выключен; включение (беседа + приветствие + события), там всё —
 *     боту, уведомления в него, выключение/повторное включение (история цела), выход = выключение,
 *     звонок туда — сразу «отклонён»;
 *   - ответ бота частями: ответ на любую часть приносит боту весь ответ и вопрос; удалённое обращение —
 *     ответа нет (409); задачи, которых бот не взял, из очереди выбрасываются;
 *   - лимит обращений в минуту на человека.
 *
 *   test/secret-env/secret-test.sh run test/bot-system.integration.test.ts
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { io as ioClient } from "socket.io-client";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { getBotQueue, pruneStaleBotJobs } from "../src/jobs/queue";
import { ensureBotUser } from "../src/scripts/seedBotUser";
import { BOT_DISPATCH_PER_MINUTE, BOT_GRANT_MAX_MESSAGES, BOT_SECRET_REFUSAL, resetSystemBotCache } from "../src/lib/systemBot";
import type { BotJob } from "../src/lib/botContract";

const RUN = `ebst_sb_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let baseUrl = "";

type Resp = { status: number; body: any };
async function call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, token: string, body?: unknown): Promise<Resp> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

type U = { id: string; token: string; name: string };
let seq = 0;
const createdUsernames: string[] = [];
const createdUserIds: string[] = [];
async function mkUser(tag: string, name: string): Promise<U> {
  seq += 1;
  const user = await prisma.user.create({ data: { username: `${RUN}_${tag}_${seq}`, displayName: name, passwordHash: `x_${crypto.randomUUID()}` } });
  createdUsernames.push(user.username);
  createdUserIds.push(user.id);
  return { id: user.id, name, token: signAccessToken({ sub: user.id, tokenId: crypto.randomUUID() }) };
}
async function mkConv(members: U[], opts: { group?: boolean; title?: string } = {}): Promise<string> {
  const c = await prisma.conversation.create({
    data: {
      isGroup: Boolean(opts.group),
      ...(opts.title ? { title: opts.title } : {}),
      createdById: members[0]!.id,
      participants: { create: members.map((m) => ({ userId: m.id })) },
    },
  });
  return c.id;
}

type Sock = { s: ReturnType<typeof ioClient>; events: Array<{ event: string; payload: any }> };
const openSockets: Sock[] = [];
async function connectSock(u: U, join: string[] = []): Promise<Sock> {
  const s = ioClient(baseUrl, { auth: { token: u.token }, transports: ["websocket"], forceNew: true, reconnection: false });
  const sock: Sock = { s, events: [] };
  s.onAny((event: string, payload: any) => sock.events.push({ event, payload }));
  await new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("connect_error", reject);
  });
  for (const c of join) s.emit("conversation:join", c);
  await sleep(200);
  openSockets.push(sock);
  return sock;
}
const eventsOf = (sock: Sock, event: string, pred: (p: any) => boolean = () => true) => sock.events.filter((e) => e.event === event && pred(e.payload));

const results: Array<{ name: string; ok: boolean; err?: string }> = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.stack ?? String(e) });
    console.log(`  FAIL ${name}: ${e?.stack ?? e}`);
  }
}

async function main() {
  console.log(`[bot-system] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[bot-system] isolated backends: ${JSON.stringify(identity)}`);
  const proofKey = `eb-bot-system:${RUN}`;
  await redis.set(proofKey, "1", { EX: 3600 });

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const queue = getBotQueue();
  await queue.drain(true);
  const jobOf = async (messageId: string): Promise<BotJob | null> => {
    const j = await queue.getJob(`msg-${messageId}`);
    return j ? (j.data as BotJob) : null;
  };
  const waitingCount = () => queue.getWaitingCount();

  // Тестовая БД общая для прогонов: «системный бот» — только наш (getSystemBot берёт самого раннего).
  await prisma.user.updateMany({ where: { isBot: true }, data: { isBot: false } });
  const botPassword = crypto.randomBytes(18).toString("base64url");
  const seeded = await ensureBotUser(prisma, { username: `${RUN}_bot`, password: botPassword, forcePassword: false });
  resetSystemBotCache();
  const BOT: U = { id: seeded.id, name: "Еблуша", token: signAccessToken({ sub: seeded.id, tokenId: crypto.randomUUID() }) };

  try {
    const A = await mkUser("alice", "Алиса");
    const B = await mkUser("bob", "Боб");
    const C = await mkUser("carol", "Кэрол"); // посторонний
    const direct = await mkConv([A, B]);
    const group = await mkConv([A, B], { group: true, title: `${RUN} группа` });
    const other = await mkConv([A, C]);
    const sA = await connectSock(A, [direct, group]);
    const sB = await connectSock(B, []);

    const send = async (u: U, conversationId: string, content: string, extra: Record<string, unknown> = {}) => {
      const r = await call("POST", "/api/conversations/send", u.token, { conversationId, type: "TEXT", content, ...extra });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.message as any;
    };
    const botPost = (body: Record<string, unknown>) => call("POST", "/api/bot/messages", BOT.token, { type: "TEXT", ...body });

    console.log("профиль и учётка");
    await step("ensureBotUser ставит isBot; GET /api/bot — профиль всем, чат с ботом выключен, текст отказа для секреток", async () => {
      const row = await prisma.user.findUniqueOrThrow({ where: { id: BOT.id } });
      assert.equal(row.isBot, true);
      const r = await call("GET", "/api/bot", C.token);
      assert.equal(r.status, 200);
      assert.equal(r.body.bot.id, BOT.id);
      assert.equal(r.body.bot.displayName, "Еблуша");
      assert.equal(r.body.bot.isBot, true);
      assert.equal(r.body.bot.username, undefined, "логин бота не отдаём");
      assert.deepEqual(r.body.botChat, { botChatEnabled: false, conversationId: null });
      assert.equal(r.body.secretChatRefusal, BOT_SECRET_REFUSAL);
      const u = await call("GET", `/api/users/${BOT.id}`, C.token);
      assert.equal(u.status, 200);
      assert.equal(u.body.user.isBot, true);
    });
    await step("бот пишет только через /api/bot: /conversations/send от бота → 403 BOT_USE_BOT_API; /api/bot/* от человека → 403 BOT_ONLY", async () => {
      const r = await call("POST", "/api/conversations/send", BOT.token, { conversationId: direct, type: "TEXT", content: "x" });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, "BOT_USE_BOT_API");
      const h = await call("POST", "/api/bot/messages", A.token, { userId: A.id, type: "TEXT", content: "x" });
      assert.equal(h.status, 403);
      assert.equal(h.body.code, "BOT_ONLY");
    });

    console.log("обращение и задача");
    let q1: any;
    let job1: BotJob;
    await step("личка двух людей: «Еблуша, …» → задача (via name, kind dm, участники-люди, без цепочки), metadata.botAsk=true", async () => {
      await send(B, direct, "просто болтаем, без бота");
      q1 = await send(A, direct, "Еблуша, Как дела у паука?");
      assert.equal(q1.metadata?.botAsk, true);
      assert.equal(q1.isBot, false);
      assert.equal(q1.sender.isBot, false);
      job1 = (await jobOf(q1.id))!;
      assert.ok(job1, "задача есть");
      assert.equal(job1.v, 1);
      assert.equal(job1.via, "name");
      assert.equal(job1.conversation.id, direct);
      assert.equal(job1.conversation.title, null);
      assert.deepEqual([...job1.conversation.participantIds].sort(), [A.id, B.id].sort());
      assert.equal(job1.conversation.kind, "dm");
      assert.equal(job1.author.id, A.id);
      assert.equal(job1.author.displayName, "Алиса");
      assert.equal(job1.message.content, "Еблуша, Как дела у паука?");
      assert.deepEqual(job1.chain, []);
      assert.ok(job1.grant.length >= 20 && job1.grantExpiresAt > Date.now());
      assert.equal(JSON.stringify(job1).includes("просто болтаем"), false, "остальная переписка боту не уходит");
    });
    await step("не обращение: имя в середине, «Еблуша» без знака, пересылка, правка → задач нет", async () => {
      const before = await waitingCount();
      const m1 = await send(A, direct, "а Еблуша, кстати, умеет искать");
      const m2 = await send(A, direct, "Еблуша привет");
      const fwd = await send(B, direct, "Еблуша, это переслано", { metadata: { forwardFrom: { authorName: "Кто-то" } } });
      assert.equal(await jobOf(m1.id), null);
      assert.equal(await jobOf(m2.id), null);
      assert.equal(await jobOf(fwd.id), null);
      const plain = await send(A, direct, "черновик");
      const up = await call("POST", "/api/messages/update", A.token, { messageId: plain.id, content: "Еблуша, правка" });
      assert.equal(up.status, 200);
      assert.equal(await jobOf(plain.id), null, "правка не считается");
      assert.equal(await waitingCount(), before);
    });
    await step("клиент не может подделать служебные ключи metadata (bot, isBot); botAsk:true — режим «Спросить» → задача", async () => {
      const m = await send(A, group, "вопрос без префикса", { metadata: { botAsk: true, isBot: true, bot: { v: 1, kind: "answer" } } });
      assert.equal(m.metadata.isBot, undefined);
      assert.equal(m.metadata.bot, undefined);
      assert.equal(m.metadata.botAsk, true);
      assert.equal(m.isBot, false);
      const j = await jobOf(m.id);
      assert.equal(j?.via, "explicit");
      assert.equal(j?.conversation.kind, "group");
      assert.equal(j?.conversation.title, `${RUN} группа`);
    });
    await step("/eb в группе → задача via command", async () => {
      const m = await send(B, group, "/eb кто сегодня играет");
      assert.equal((await jobOf(m.id))?.via, "command");
      const m2 = await send(B, group, "/ЕБ кто");
      assert.equal((await jobOf(m2.id))?.via, "command");
    });

    console.log("ответ бота");
    let answer: any;
    await step("ответ по разрешению: в беседу обращения, replyToId, isBot у сообщения и отправителя, рассылка участникам", async () => {
      const r = await botPost({ grant: job1.grant, content: "ОтветБота42: **всё хорошо**.", replyToId: q1.id });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      answer = r.body.message;
      assert.equal(answer.conversationId, direct);
      assert.equal(answer.isBot, true);
      assert.equal(answer.sender.id, BOT.id);
      assert.equal(answer.sender.isBot, true);
      assert.equal(answer.sender.displayName, "Еблуша");
      assert.equal(answer.replyTo.id, q1.id);
      assert.equal(answer.replyTo.isBot, false);
      assert.deepEqual(answer.metadata.bot, { v: 1, kind: "answer", triggerMessageId: q1.id, askerId: A.id });
      await sleep(300);
      const n = eventsOf(sA, "message:new", (p) => p.messageId === answer.id);
      assert.equal(n.length, 1, "в комнату беседы");
      assert.equal(n[0]!.payload.message.isBot, true);
      assert.equal(eventsOf(sB, "message:notify", (p) => p.messageId === answer.id).length, 1, "участнику — message:notify");
      assert.equal(eventsOf(sA, "message:notify", (p) => p.messageId === answer.id).length, 1);
      const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: direct }, select: { lastMessageAt: true } });
      assert.ok(conv.lastMessageAt && conv.lastMessageAt.getTime() >= new Date(answer.createdAt).getTime() - 1000);
      const push = await getPushQueueJob(answer.id);
      assert.ok(push, "пуш поставлен");
      assert.deepEqual([...push.userIds].sort(), [A.id, B.id].sort(), "пуш — участникам, не боту");
      assert.equal(push.payload.senderName, "Еблуша");
    });
    await step("история беседы: сообщение бота с isBot, replyTo.isBot у ответа на него; бот — не участник", async () => {
      const r = await call("GET", `/api/conversations/${direct}/messages?limit=20`, B.token);
      assert.equal(r.status, 200);
      const m = r.body.messages.find((x: any) => x.id === answer.id);
      assert.equal(m.isBot, true);
      assert.equal(m.sender.isBot, true);
      const list = await call("GET", "/api/conversations", A.token);
      const row = list.body.conversations.find((c: any) => c.conversation.id === direct);
      assert.ok(row);
      assert.equal(row.conversation.participants.some((p: any) => p.userId === BOT.id), false, "бота нет в участниках");
      assert.equal(row.conversation.isBotChat, false);
      assert.equal(row.conversation.messages[0].sender.isBot, true, "последнее сообщение в списке — от бота, с признаком");
      assert.equal(row.unreadCount >= 1, true);
    });
    let q2: any;
    await step("продолжение ответом на сообщение бота → задача via reply с цепочкой [вопрос, ответ бота]", async () => {
      q2 = await send(B, direct, "подробнее про лапки", { replyToId: answer.id });
      assert.equal(q2.replyTo.isBot, true);
      const j = (await jobOf(q2.id))!;
      assert.equal(j.via, "reply");
      assert.deepEqual(
        j.chain.map((m) => [m.id, m.isBot, m.senderName]),
        [
          [q1.id, false, "Алиса"],
          [answer.id, true, "Еблуша"],
        ],
      );
      assert.equal(j.author.id, B.id);
    });
    await step("ответ боту с botAsk:false (Backspace по плашке «Спросить») → не обращение", async () => {
      const m = await send(A, direct, "это я Бобу, не боту", { replyToId: answer.id, metadata: { botAsk: false } });
      assert.equal(await jobOf(m.id), null);
      assert.equal(m.metadata?.botAsk, undefined);
    });
    await step("голосовое ответом боту (даже с botAsk:true) вне «Чата с Еблушей» → не обращение", async () => {
      const voice = { type: "AUDIO", replyToId: answer.id, attachments: [{ url: "/api/files/voice-1.eblusha", type: "AUDIO" }] };
      const v1 = await send(B, direct, "", voice);
      assert.equal(await jobOf(v1.id), null);
      const v2 = await send(B, direct, "", { ...voice, metadata: { botAsk: true } });
      assert.equal(await jobOf(v2.id), null, "botAsk:true с голосовым не помогает — решает сервер");
      assert.equal(v2.metadata?.botAsk, undefined);
    });
    await step("ответ на сообщение бота из ДРУГОЙ беседы → не обращение", async () => {
      const m = await send(A, other, "отвечаю на чужое", { replyToId: answer.id });
      assert.equal(await jobOf(m.id), null);
    });
    await step("разрешение: чужой replyToId → 400; неизвестное → 410; лимит сообщений на обращение → 429", async () => {
      const foreign = await send(A, other, "сообщение другой беседы");
      const r1 = await botPost({ grant: job1.grant, content: "x", replyToId: foreign.id });
      assert.equal(r1.status, 400);
      assert.equal(r1.body.code, "BOT_REPLY_FOREIGN");
      const r2 = await botPost({ grant: "nope_nope_nope_nope_nope_nope", content: "x" });
      assert.equal(r2.status, 410);
      const r3 = await botPost({ content: "x", conversationId: other });
      assert.equal(r3.status, 400, "без grant/userId писать некуда");
      const j = (await jobOf(q2.id))!;
      let last = 0;
      for (let i = 0; i < BOT_GRANT_MAX_MESSAGES + 1; i++) last = (await botPost({ grant: j.grant, content: `часть ${i}` })).status;
      assert.equal(last, 429);
      const otherMsgs = await prisma.message.count({ where: { conversationId: other, senderId: BOT.id } });
      assert.equal(otherMsgs, 0, "в чужую беседу бот не написал ни строки");
    });
    await step("typing бота: в комнату беседы, с isBot и именем; реакция 👍 по разрешению", async () => {
      const r = await call("POST", "/api/bot/typing", BOT.token, { grant: job1.grant, typing: true });
      assert.equal(r.status, 204);
      await sleep(200);
      const t = eventsOf(sA, "conversation:typing_update", (p) => p.userId === BOT.id && p.conversationId === direct);
      assert.equal(t.length, 1);
      assert.equal(t[0]!.payload.isTyping, true);
      assert.equal(t[0]!.payload.isBot, true);
      assert.equal(t[0]!.payload.displayName, "Еблуша");
      await call("POST", "/api/bot/typing", BOT.token, { grant: job1.grant, typing: false });
      const thanks = await send(A, direct, "спасибо!", { replyToId: answer.id });
      const tj = (await jobOf(thanks.id))!;
      const rr = await call("POST", "/api/bot/react", BOT.token, { grant: tj.grant, messageId: thanks.id, emoji: "👍" });
      assert.equal(rr.status, 200, JSON.stringify(rr.body));
      const reaction = await prisma.messageReaction.findFirst({ where: { messageId: thanks.id, userId: BOT.id, emoji: "👍" } });
      assert.ok(reaction);
      const foreign = await send(A, other, "чужое");
      const bad = await call("POST", "/api/bot/react", BOT.token, { grant: tj.grant, messageId: foreign.id, emoji: "👍" });
      assert.equal(bad.status, 400);
      const hist = await call("GET", `/api/conversations/${direct}/messages?limit=50`, A.token);
      const th = hist.body.messages.find((x: any) => x.id === thanks.id);
      assert.equal(th.reactions[0].user.isBot, true, "реакция бота — с признаком у пользователя");
    });

    console.log("ответ частями, удалённое обращение, уборка очереди");
    await step("ответ бота частями: ответ человека на ЛЮБУЮ часть (картинку, вторую) → в цепочке вопрос и все части ответа", async () => {
      const q = await send(A, group, "Еблуша, расскажи длинно и с картой");
      const j = (await jobOf(q.id))!;
      const p1 = (await botPost({ grant: j.grant, content: "Часть 1", replyToId: q.id })).body.message;
      const p2 = (await botPost({ grant: j.grant, content: "Часть 2" })).body.message;
      const ir = await botPost({
        grant: j.grant,
        type: "IMAGE",
        attachments: [{ url: "/api/files/karta.eblusha", type: "IMAGE", metadata: { originalName: "karta-valheim.png", link: "https://v.koban.uk/map/" } }],
      });
      assert.equal(ir.status, 201, JSON.stringify(ir.body));
      const img = ir.body.message;
      assert.equal(img.attachments[0].metadata.link, "https://v.koban.uk/map/", "ссылка карточки доходит до клиентов");
      // Чужое обращение рядом по времени — не часть этого ответа.
      const other = await send(B, group, "/eb другое");
      const oj = (await jobOf(other.id))!;
      const otherAns = (await botPost({ grant: oj.grant, content: "Другой ответ", replyToId: other.id })).body.message;
      const whole = [q.id, p1.id, p2.id, img.id];
      const onImage = await send(B, group, "а подробнее?", { replyToId: img.id });
      const fj = (await jobOf(onImage.id))!;
      assert.equal(fj.via, "reply");
      assert.deepEqual(fj.chain.map((m) => m.id), whole, "ответ на картинку");
      const onSecond = await send(B, group, "про вторую часть", { replyToId: p2.id });
      assert.deepEqual((await jobOf(onSecond.id))!.chain.map((m) => m.id), whole, "ответ на вторую часть");
      const onFirst = await send(B, group, "про первую", { replyToId: p1.id });
      assert.deepEqual((await jobOf(onFirst.id))!.chain.map((m) => m.id), whole, "ответ на первую часть");
      const onOther = await send(B, group, "а это?", { replyToId: otherAns.id });
      assert.deepEqual((await jobOf(onOther.id))!.chain.map((m) => m.id), [other.id, otherAns.id], "одночастный ответ — как раньше");
    });
    await step("обращение удалили, пока бот думал → ответ, реакция и «печатает» — 409 BOT_TRIGGER_DELETED, ни строки в беседе", async () => {
      const q = await send(A, group, "Еблуша, ой, это лишнее");
      const j = (await jobOf(q.id))!;
      const del = await call("POST", "/api/messages/delete", A.token, { messageId: q.id });
      assert.equal(del.status, 200, JSON.stringify(del.body));
      const r = await botPost({ grant: j.grant, content: "ОтветНаУдалённое", replyToId: q.id });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "BOT_TRIGGER_DELETED");
      const t = await call("POST", "/api/bot/typing", BOT.token, { grant: j.grant, typing: true });
      assert.equal(t.status, 409);
      const t2 = await call("POST", "/api/bot/typing", BOT.token, { grant: j.grant, typing: false });
      assert.equal(t2.status, 204, "погасить «печатает» можно всегда");
      const rr = await call("POST", "/api/bot/react", BOT.token, { grant: j.grant, messageId: q.id, emoji: "👍" });
      assert.equal(rr.status, 409);
      assert.equal(await prisma.message.count({ where: { conversationId: group, content: "ОтветНаУдалённое" } }), 0);
    });
    await step("задачи, которых бот так и не взял, выбрасываются из очереди (текст обращений не копится в Redis)", async () => {
      const q = await send(A, group, "Еблуша, ты где?");
      assert.ok(await jobOf(q.id), "задача поставлена");
      await sleep(30);
      const removed = await pruneStaleBotJobs(10);
      assert.ok(removed >= 1, `выброшено ${removed}`);
      assert.equal(await jobOf(q.id), null);
      assert.equal(await waitingCount(), 0);
    });

    console.log("бот не участник и не видит лишнего");
    await step("у бота нет бесед: список пуст, история чужих бесед — 403", async () => {
      const list = await call("GET", "/api/conversations", BOT.token);
      assert.equal(list.status, 200);
      assert.equal(list.body.conversations.length, 0);
      const h = await call("GET", `/api/conversations/${direct}/messages`, BOT.token);
      assert.equal(h.status, 403);
      const hc = await call("GET", `/api/conversations/${direct}/messages`, C.token);
      assert.equal(hc.status, 403, "посторонний беседу тоже не видит");
    });
    await step("контакты, поиск, группы, личка, секретный тред — бота туда не пускаем", async () => {
      const row = await prisma.user.findUniqueOrThrow({ where: { id: BOT.id }, select: { eblid: true } });
      if (!row.eblid) await prisma.user.update({ where: { id: BOT.id }, data: { eblid: String(1000 + Math.floor(Math.random() * 9000)) } }).catch(() => undefined);
      const eblid = (await prisma.user.findUniqueOrThrow({ where: { id: BOT.id }, select: { eblid: true } })).eblid;
      const add = await call("POST", "/api/contacts/add", C.token, { userId: BOT.id });
      assert.equal(add.status, 400);
      assert.equal(add.body.code, "BOT_NOT_CONTACT");
      if (eblid) {
        const s = await call("GET", `/api/contacts/search?query=${eblid}`, C.token);
        assert.deepEqual(s.body.results, []);
        const add2 = await call("POST", "/api/contacts/add", C.token, { identifier: eblid });
        assert.equal(add2.status, 400);
      }
      const g = await call("POST", "/api/conversations", A.token, { participantIds: [B.id, BOT.id], isGroup: true, title: "x" });
      assert.equal(g.status, 400);
      assert.equal(g.body.code, "BOT_NOT_PARTICIPANT");
      const d = await call("POST", "/api/conversations", A.token, { participantIds: [BOT.id] });
      assert.equal(d.status, 400);
      assert.equal(d.body.code, "BOT_CHAT_VIA_SETTINGS");
      const p = await call("POST", `/api/conversations/${group}/participants`, A.token, { participantIds: [BOT.id] });
      assert.equal(p.status, 400);
      assert.equal(p.body.code, "BOT_NOT_PARTICIPANT");
      const st = await call("POST", "/api/threads/secret", A.token, { peerUserId: BOT.id });
      assert.equal(st.status, 403);
      assert.equal(st.body.code, "BOT_NO_SECRET");
      assert.equal(await prisma.conversationParticipant.count({ where: { userId: BOT.id } }), 0);
    });

    console.log("секретные чаты");
    await step("секретный тред людей: облачная отправка «Еблуша, …» → 409, задачи нет, облачных строк нет", async () => {
      const st = await call("POST", "/api/threads/secret", A.token, { peerUserId: B.id });
      assert.ok(st.status === 201 || st.status === 200, JSON.stringify(st.body));
      const before = await waitingCount();
      const r = await call("POST", "/api/conversations/send", A.token, { conversationId: st.body.threadId, type: "TEXT", content: "Еблуша, ты тут?" });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "SECRET_E2EE_ONLY");
      assert.equal(await waitingCount(), before);
      assert.equal(await prisma.message.count({ where: { conversationId: st.body.threadId } }), 0);
    });

    console.log("«Чат с Еблушей»");
    let botChat = "";
    await step("включение: беседа 1:1 с ботом, приветствие от бота, bot:settings + conversations:new своим устройствам", async () => {
      const off = await call("GET", "/api/bot/settings", A.token);
      assert.deepEqual(off.body, { botChatEnabled: false, conversationId: null });
      const on = await call("PUT", "/api/bot/settings", A.token, { botChatEnabled: true });
      assert.equal(on.status, 200, JSON.stringify(on.body));
      assert.equal(on.body.botChatEnabled, true);
      botChat = on.body.conversationId;
      assert.ok(botChat);
      const again = await call("PUT", "/api/bot/settings", A.token, { botChatEnabled: true });
      assert.equal(again.body.conversationId, botChat, "идемпотентно");
      await sleep(300);
      assert.equal(eventsOf(sA, "bot:settings", (p) => p.botChatEnabled === true && p.conversationId === botChat).length >= 1, true);
      assert.equal(eventsOf(sA, "conversations:new", (p) => p.conversationId === botChat).length, 1);
      const welcome = await prisma.message.findMany({ where: { conversationId: botChat } });
      assert.equal(welcome.length, 1);
      assert.equal(welcome[0]!.isBot, true);
      assert.equal(welcome[0]!.senderId, BOT.id);
      assert.match(welcome[0]!.content ?? "", /Еблуша/);
      const list = await call("GET", "/api/conversations", A.token);
      const row = list.body.conversations.find((c: any) => c.conversation.id === botChat);
      assert.equal(row.conversation.isGroup, false);
      assert.equal(row.conversation.isBotChat, true, "готовый признак «Чата с Еблушей»");
      const peer = row.conversation.participants.find((p: any) => p.userId === BOT.id);
      assert.equal(peer.user.isBot, true, "собеседник в списке — бот");
      const other = await call("GET", "/api/bot", B.token);
      assert.equal(other.body.botChat.botChatEnabled, false, "у Боба по-прежнему выключен");
    });
    await step("в «Чате с Еблушей» всё адресовано боту: задача via botchat, kind bot, участники — только человек", async () => {
      const m = await send(A, botChat, "привет без обращения");
      const j = (await jobOf(m.id))!;
      assert.equal(j.via, "botchat");
      assert.equal(j.conversation.kind, "bot");
      assert.deepEqual(j.conversation.participantIds, [A.id]);
      const r = await botPost({ grant: j.grant, content: "Привет!", replyToId: m.id });
      assert.equal(r.status, 201);
      const v = await send(A, botChat, "", { type: "AUDIO", attachments: [{ url: "/api/files/voice-2.eblusha", type: "AUDIO" }] });
      assert.equal((await jobOf(v.id))?.via, "botchat", "в «Чате с Еблушей» и голосовое — боту (он ответит «напиши текстом»)");
    });
    await step("уведомление в «Чат с Еблушей» по userId; выключен — 409 BOT_CHAT_DISABLED", async () => {
      const ok = await botPost({ userId: A.id, content: "Новая привязка: …", kind: "notice" });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.message.conversationId, botChat);
      assert.equal(ok.body.message.metadata.bot.kind, "notice");
      const no = await botPost({ userId: B.id, content: "x" });
      assert.equal(no.status, 409);
      assert.equal(no.body.code, "BOT_CHAT_DISABLED");
    });
    await step("звонок в «Чат с Еблушей» → сразу call:declined от бота", async () => {
      const declined = new Promise<any>((resolve) => sA.s.once("call:declined", resolve));
      sA.s.emit("call:invite", { conversationId: botChat, video: false });
      const d = await Promise.race([declined, sleep(4000).then(() => null)]);
      assert.ok(d, "call:declined пришёл");
      assert.equal(d.by.id, BOT.id);
    });
    await step("выключение: участие снято, conversations:deleted; повторное включение — та же беседа с историей, без второго приветствия", async () => {
      const before = await prisma.message.count({ where: { conversationId: botChat } });
      const off = await call("PUT", "/api/bot/settings", A.token, { botChatEnabled: false });
      assert.deepEqual(off.body, { botChatEnabled: false, conversationId: null });
      await sleep(200);
      assert.equal(eventsOf(sA, "conversations:deleted", (p) => p.conversationId === botChat).length, 1);
      const list = await call("GET", "/api/conversations", A.token);
      assert.equal(list.body.conversations.some((c: any) => c.conversation.id === botChat), false);
      const no = await botPost({ userId: A.id, content: "x" });
      assert.equal(no.status, 409);
      const on = await call("PUT", "/api/bot/settings", A.token, { botChatEnabled: true });
      assert.equal(on.body.conversationId, botChat);
      assert.equal(await prisma.message.count({ where: { conversationId: botChat } }), before);
    });
    await step("«покинуть» чат с ботом = выключить настройку, без системной записи", async () => {
      const r = await call("DELETE", `/api/conversations/${botChat}/participants/me`, A.token);
      assert.equal(r.status, 200);
      assert.equal(await prisma.message.count({ where: { conversationId: botChat, type: "SYSTEM" } }), 0);
      const s = await call("GET", "/api/bot/settings", A.token);
      assert.deepEqual(s.body, { botChatEnabled: false, conversationId: null });
    });

    console.log("лимиты");
    await step(`не больше ${BOT_DISPATCH_PER_MINUTE} обращений в минуту от человека — остальные боту не уходят`, async () => {
      const D = await mkUser("dave", "Дэйв");
      const g2 = await mkConv([D, A], { group: true, title: "флуд" });
      let jobs = 0;
      for (let i = 0; i < BOT_DISPATCH_PER_MINUTE + 3; i++) {
        const m = await send(D, g2, `Еблуша, вопрос ${i}`);
        if (await jobOf(m.id)) jobs++;
      }
      assert.equal(jobs, BOT_DISPATCH_PER_MINUTE);
    });

    const proof = {
      run: RUN,
      userIds: [BOT.id, ...createdUserIds],
      usernames: [`${RUN}_bot`, ...createdUsernames],
      deviceIds: [`${RUN}-nodevice`],
      threadId: direct,
      msgId: crypto.randomUUID(),
      redisKeys: [proofKey],
    };
    console.log(`EB_PROOF ${JSON.stringify(proof)}`);
  } finally {
    for (const s of openSockets) s.s.close();
    await queue.drain(true).catch(() => undefined);
    await prisma.user.update({ where: { id: BOT.id }, data: { isBot: false, deletedAt: new Date() } }).catch(() => undefined);
    io.close();
    await new Promise<void>((r) => server.close(() => r()));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[bot-system] ${results.length - failed.length}/${results.length} ok`);
  if (failed.length) throw new Error(`провалено: ${failed.map((f) => f.name).join("; ")}`);
}

async function getPushQueueJob(messageId: string): Promise<any> {
  const { getPushQueue } = await import("../src/jobs/queue");
  const j = await getPushQueue().getJob(`msg-${messageId}`);
  return j?.data ?? null;
}

main().then(
  async () => {
    console.log("bot system integration: ok");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (err) => {
    console.error("bot system integration: FAILED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  },
);
