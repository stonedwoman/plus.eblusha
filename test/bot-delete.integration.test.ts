/**
 * Удаление ответа бота «Еблуша» (POST /api/messages/delete): ответ может удалить ТОТ, КТО СПРОСИЛ
 * (автор обращения), а в «Чате с Еблушей» — его владелец; удаление для всех, как у своего сообщения.
 *
 *   - ответ по разрешению несёт metadata.bot.askerId = автор обращения (grant.authorId);
 *   - группа: два человека спросили — каждый удаляет только свой ответ (все части ответа), чужой — 403;
 *   - постороннему (не участнику) нельзя ничего, даже уже удалённое; повторное удаление участником — 200;
 *   - старый ответ без askerId — по автору обращения metadata.bot.triggerMessageId в ТОЙ ЖЕ беседе
 *     (обращение из другой беседы не годится);
 *   - отчёт по «продолжению» (followup) идёт по разрешению «да» — удаляет подтвердивший, не просивший;
 *   - «Чат с Еблушей»: любое сообщение бота (и приветствие) удаляет владелец, посторонний — 403;
 *   - чужие сообщения людей по-прежнему 403, своё — 200; сообщение, лишь помеченное isBot у человека
 *     (подделка), чужим не удаляется.
 *
 *   test/secret-env/secret-test.sh run test/bot-delete.integration.test.ts
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
import { getBotQueue } from "../src/jobs/queue";
import { ensureBotUser } from "../src/scripts/seedBotUser";
import { botAskerOf, resetSystemBotCache } from "../src/lib/systemBot";
import type { BotJob } from "../src/lib/botContract";

const RUN = `ebst_bd_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let baseUrl = "";

type Resp = { status: number; body: any };
async function call(method: "GET" | "POST" | "PUT", path: string, token: string, body?: unknown): Promise<Resp> {
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
  console.log(`[bot-delete] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[bot-delete] isolated backends: ${JSON.stringify(identity)}`);
  const proofKey = `eb-bot-delete:${RUN}`;
  await redis.set(proofKey, "1", { EX: 3600 });

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const queue = getBotQueue();
  await queue.drain(true);
  const jobOf = async (messageId: string): Promise<BotJob> => {
    const j = await queue.getJob(`msg-${messageId}`);
    assert.ok(j, `нет задачи для ${messageId}`);
    return j.data as BotJob;
  };

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
    const group = await mkConv([A, B, C], { group: true, title: `${RUN} группа` });
    const other = await mkConv([A, C]);
    const sB = await connectSock(B, [direct, group]);

    const send = async (u: U, conversationId: string, content: string, extra: Record<string, unknown> = {}) => {
      const r = await call("POST", "/api/conversations/send", u.token, { conversationId, type: "TEXT", content, ...extra });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.message as any;
    };
    const botPost = async (body: Record<string, unknown>) => {
      const r = await call("POST", "/api/bot/messages", BOT.token, { type: "TEXT", ...body });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.message as any;
    };
    const del = (u: U, messageId: string) => call("POST", "/api/messages/delete", u.token, { messageId });
    const isDeleted = async (id: string) => Boolean((await prisma.message.findUniqueOrThrow({ where: { id } })).deletedAt);

    console.log("ответ несёт askerId");
    let qA: any;
    let ans1: any;
    await step("ответ по разрешению: metadata.bot.askerId = автор обращения, triggerMessageId — обращение; botAskerOf читает", async () => {
      qA = await send(A, direct, "Еблуша, как дела?");
      const j = await jobOf(qA.id);
      ans1 = await botPost({ grant: j.grant, content: "Ответ для Алисы", replyToId: qA.id });
      assert.deepEqual(ans1.metadata.bot, { v: 1, kind: "answer", triggerMessageId: qA.id, askerId: A.id });
      assert.equal(botAskerOf(ans1.metadata), A.id);
      assert.equal(botAskerOf({}), null);
      assert.equal(botAskerOf({ bot: { askerId: 5 } }), null);
    });

    console.log("кто может удалить");
    await step("личка: собеседник (не спрашивавший) → 403, ответ цел; посторонний → 403", async () => {
      const r = await del(B, ans1.id);
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(await isDeleted(ans1.id), false);
      const c = await del(C, ans1.id);
      assert.equal(c.status, 403);
      assert.equal(await isDeleted(ans1.id), false);
    });
    await step("личка: спрашивавший удаляет → 200, мягкое удаление, message:update {reason: deleted} собеседнику", async () => {
      const r = await del(A, ans1.id);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await prisma.message.findUniqueOrThrow({ where: { id: ans1.id } });
      assert.ok(row.deletedAt);
      assert.equal(row.content, null);
      assert.equal(row.metadata, null);
      await sleep(300);
      const ev = sB.events.filter((e) => e.event === "message:update" && e.payload.messageId === ans1.id && e.payload.reason === "deleted");
      assert.equal(ev.length, 1, "собеседнику ушло message:update deleted");
    });
    await step("повторное удаление: участнику — 200 (два устройства), постороннему — 403", async () => {
      assert.equal((await del(A, ans1.id)).status, 200);
      assert.equal((await del(B, ans1.id)).status, 200, "участнику беседы — идемпотентно");
      assert.equal((await del(C, ans1.id)).status, 403);
    });

    let gA: any, gB: any;
    const partsA: any[] = [];
    await step("группа: Алиса и Боб спросили — ответ из нескольких частей; каждый удаляет только свой", async () => {
      const q1 = await send(A, group, "Еблуша, расскажи про пауков");
      const q2 = await send(B, group, "Еблуша, а про жуков?");
      const j1 = await jobOf(q1.id);
      const j2 = await jobOf(q2.id);
      gA = await botPost({ grant: j1.grant, content: "Часть 1 для Алисы", replyToId: q1.id });
      partsA.push(gA, await botPost({ grant: j1.grant, content: "Часть 2 для Алисы" }));
      gB = await botPost({ grant: j2.grant, content: "Для Боба", replyToId: q2.id });
      assert.equal(partsA[1].metadata.bot.askerId, A.id, "askerId у всех частей");
      assert.equal((await del(B, gA.id)).status, 403, "Боб чужой ответ не удаляет");
      assert.equal((await del(C, gA.id)).status, 403, "третий участник тоже");
      assert.equal((await del(A, gB.id)).status, 403, "Алиса — ответ Бобу");
      assert.equal((await del(A, partsA[1].id)).status, 200, "Алиса — вторую часть своего ответа");
      assert.equal(await isDeleted(partsA[1].id), true);
      assert.equal(await isDeleted(gA.id), false, "первая часть цела");
      assert.equal((await del(A, gA.id)).status, 200);
      assert.equal((await del(B, gB.id)).status, 200);
      assert.equal(await isDeleted(gB.id), true);
    });
    await step("вышел из группы — удалять ответы бота нельзя", async () => {
      const q = await send(C, group, "Еблуша, а я скоро уйду");
      const a = await botPost({ grant: (await jobOf(q.id)).grant, content: "Ответ Кэрол", replyToId: q.id });
      await prisma.conversationParticipant.deleteMany({ where: { conversationId: group, userId: C.id } });
      const r = await del(C, a.id);
      assert.equal(r.status, 403, "не участник — 403");
      assert.equal(await isDeleted(a.id), false);
      await prisma.conversationParticipant.create({ data: { conversationId: group, userId: C.id } });
      assert.equal((await del(C, a.id)).status, 200, "вернулся — снова может");
    });
    await step("старый ответ без askerId: решает автор обращения в ЭТОЙ беседе (по triggerMessageId)", async () => {
      const q = await send(B, direct, "Еблуша, старый вопрос");
      const old = await prisma.message.create({
        data: {
          conversationId: direct,
          senderId: BOT.id,
          isBot: true,
          type: "TEXT",
          content: "старый ответ",
          replyToId: q.id,
          metadata: { bot: { v: 1, kind: "answer", triggerMessageId: q.id } },
        },
      });
      assert.equal((await del(A, old.id)).status, 403, "не автор обращения");
      assert.equal(await isDeleted(old.id), false);
      assert.equal((await del(B, old.id)).status, 200, "автор обращения");
      assert.equal(await isDeleted(old.id), true);
    });
    await step("обращение из ДРУГОЙ беседы не годится; без triggerMessageId и без askerId — нельзя", async () => {
      const foreignQ = await send(A, other, "обращение в другой беседе");
      const bad = await prisma.message.create({
        data: { conversationId: direct, senderId: BOT.id, isBot: true, type: "TEXT", content: "x", metadata: { bot: { v: 1, kind: "answer", triggerMessageId: foreignQ.id } } },
      });
      assert.equal((await del(A, bad.id)).status, 403, "обращение в чужой беседе — не основание");
      const noTrig = await prisma.message.create({
        data: { conversationId: direct, senderId: BOT.id, isBot: true, type: "TEXT", content: "y", metadata: { bot: { v: 1, kind: "notice" } } },
      });
      assert.equal((await del(A, noTrig.id)).status, 403);
      assert.equal((await del(B, noTrig.id)).status, 403);
    });
    await step("askerId главнее triggerMessageId (если askerId есть — решает только он)", async () => {
      const q = await send(A, direct, "Еблуша, проверка приоритета");
      const m = await prisma.message.create({
        data: { conversationId: direct, senderId: BOT.id, isBot: true, type: "TEXT", content: "z", metadata: { bot: { v: 1, kind: "answer", triggerMessageId: q.id, askerId: B.id } } },
      });
      assert.equal((await del(A, m.id)).status, 403, "автор обращения, но askerId — Боб");
      assert.equal((await del(B, m.id)).status, 200);
    });
    await step("обращение удалили — ответ всё равно удаляет тот, кто спрашивал (senderId обращения остаётся)", async () => {
      const q = await send(A, direct, "Еблуша, спрошу и сотру");
      const a = await botPost({ grant: (await jobOf(q.id)).grant, content: "ответ на сотранное", replyToId: q.id });
      assert.equal((await del(A, q.id)).status, 200);
      // старый вид без askerId — через удалённое обращение
      const old = await prisma.message.create({
        data: { conversationId: direct, senderId: BOT.id, isBot: true, type: "TEXT", content: "o", metadata: { bot: { v: 1, kind: "answer", triggerMessageId: q.id } } },
      });
      assert.equal((await del(B, old.id)).status, 403);
      assert.equal((await del(A, old.id)).status, 200);
      assert.equal((await del(A, a.id)).status, 200, "ответ с askerId — спрашивавшему, хоть обращение и стёрто");
    });

    console.log("отчёт по продолжению — удаляет подтвердивший");
    await step("followup по разрешению «да»: askerId = подтвердивший (Боб), просивший (Алиса) отчёт не удаляет", async () => {
      const plan = await botPost({ grant: (await jobOf((await send(A, direct, "Еблуша, включи бесплатный крафт")).id)).grant, content: "План. Ответьте «да».", kind: "confirm" });
      const yes = await send(B, direct, "да", { replyToId: plan.id });
      const jy = await jobOf(yes.id);
      assert.equal(jy.author.id, B.id);
      const fu = await call("POST", "/api/bot/followup", BOT.token, { grant: jy.grant });
      assert.equal(fu.status, 201, JSON.stringify(fu.body));
      const report = await botPost({ grant: fu.body.grant, content: "Готово.", replyToId: yes.id, kind: "command" });
      assert.equal(report.metadata.bot.askerId, B.id);
      assert.equal((await del(A, report.id)).status, 403, "просивший отчёт не удаляет (удалит подтвердивший)");
      assert.equal((await del(A, plan.id)).status, 200, "а план — тот, кто просил");
      assert.equal((await del(B, report.id)).status, 200);
    });

    console.log("«Чат с Еблушей»");
    await step("включённый чат: владелец удаляет любое сообщение бота (приветствие, ответ без обращения); посторонний — 403", async () => {
      const on = await call("PUT", "/api/bot/settings", A.token, { botChatEnabled: true });
      assert.equal(on.status, 200, JSON.stringify(on.body));
      const chatId: string = on.body.conversationId;
      assert.ok(chatId);
      const welcome = await prisma.message.findFirstOrThrow({ where: { conversationId: chatId, isBot: true, deletedAt: null } });
      assert.equal(botAskerOf(welcome.metadata), null, "у приветствия asker нет");
      assert.equal((await del(B, welcome.id)).status, 403, "посторонний (даже участник другой беседы)");
      assert.equal((await del(C, welcome.id)).status, 403);
      const q = await send(A, chatId, "просто пишу боту");
      const a = await botPost({ grant: (await jobOf(q.id)).grant, content: "ответ в личном чате", replyToId: q.id });
      const notice = await botPost({ userId: A.id, content: "служебное уведомление", kind: "notice" });
      assert.equal(botAskerOf(notice.metadata), null);
      assert.equal((await del(A, welcome.id)).status, 200, "владелец — приветствие");
      assert.equal((await del(A, a.id)).status, 200, "владелец — ответ");
      assert.equal((await del(A, notice.id)).status, 200, "владелец — уведомление без обращения");
      assert.equal((await del(B, a.id)).status, 403, "Боб не участник чата Алисы с ботом");
      // Выключил чат — не участник, удалять больше нельзя.
      const left = await botPost({ userId: A.id, content: "ещё одно", kind: "notice" });
      assert.equal(left.conversationId, chatId);
      await call("PUT", "/api/bot/settings", A.token, { botChatEnabled: false });
      assert.equal((await del(A, left.id)).status, 403, "вышел из чата — удалять нельзя");
      await call("PUT", "/api/bot/settings", A.token, { botChatEnabled: true });
      assert.equal((await del(A, left.id)).status, 200, "вернулся — владелец");
    });

    console.log("люди и подделки");
    await step("сообщения людей — по-прежнему только автор (чужое 403, своё 200)", async () => {
      const m = await send(A, direct, "обычное сообщение");
      assert.equal((await del(B, m.id)).status, 403);
      assert.equal((await del(A, m.id)).status, 200);
      const chat = (await call("GET", "/api/bot/settings", A.token)).body.conversationId as string;
      const mine = await send(A, chat, "моё в чате с ботом");
      assert.equal((await del(A, mine.id)).status, 200);
      assert.equal((await del(B, mine.id)).status, 403, "посторонний не стирает чужое сообщение человека (уже удалённое тоже)");
    });
    await step("сообщение человека, помеченное isBot, чужим не удаляется (удаляют только сообщения системного бота)", async () => {
      const fake = await prisma.message.create({
        data: { conversationId: direct, senderId: B.id, isBot: true, type: "TEXT", content: "подделка", metadata: { bot: { v: 1, kind: "answer", askerId: A.id } } },
      });
      assert.equal((await del(A, fake.id)).status, 403, "отправитель — не бот, askerId не помогает");
      assert.equal((await del(B, fake.id)).status, 200, "своё — как всегда");
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
  console.log(`\n[bot-delete] ${results.length - failed.length}/${results.length} ok`);
  if (failed.length) throw new Error(`провалено: ${failed.map((f) => f.name).join("; ")}`);
}

main().then(
  async () => {
    console.log("bot delete integration: ok");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (err) => {
    console.error("bot delete integration: FAILED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  },
);
