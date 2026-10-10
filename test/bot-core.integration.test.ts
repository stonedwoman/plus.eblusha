/**
 * Бот «Еблуша» целиком: настоящий backend (app + Socket.IO в процессе, тестовые Postgres/Redis
 * изолированной среды) + настоящий сервис бота (bot/src/main.ts startBot, потребитель очереди BullMQ
 * `bot` в тестовом Redis) с поддельной моделью — без сети и без денег.
 * Файл лежит в корневом test/, а не в bot/: ts-node ищет tsconfig рядом со скриптом, а backend
 * собирается только с корневым (типы src/types).
 *
 *   test/secret-env/secret-test.sh run test/bot-core.integration.test.ts
 *
 * Путь сообщения по-настоящему: человек шлёт POST /api/conversations/send → сервер замечает обращение
 * и ставит задачу → бот забирает её из очереди → отвечает через /api/bot/* по разрешению → сообщение
 * с isBot в беседе, где бот НЕ участник. Плюс: продолжение ответом, 👍 на «спасибо», вложение через
 * /api/upload, «Чат с Еблушей» (включение, привязка ника без обращения, уведомление владельцу),
 * команда владельца с «да» только в его чате с ботом, typing бота, журнал без текста сообщений.
 * В конце — строка EB_PROOF для `secret-test.sh prod-proof` (в боевых БД/Redis этих id нет).
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { io as ioClient } from "socket.io-client";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { getBotQueue } from "../src/jobs/queue";
import { resetSystemBotCache } from "../src/lib/systemBot";
import { ensureBotUser } from "../src/scripts/seedBotUser";
import { loadConfig } from "../bot/src/config";
import { createLogger } from "../bot/src/log";
import { startBot } from "../bot/src/main";
import { ZERO_COST } from "../bot/src/core/budget";
import type { AnswerRequest, AnswerResult, LlmEngine } from "../bot/src/llm/types";
import type { BotModule } from "../bot/src/modules/api";

const RUN = `ebst_bc_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
const SECRET_WORDS = ["Как дела у паука", "подробнее про лапки", "ОтветМодели42", "покажи карточку", "рассуди нас"];

function pngBuffer(w: number, h: number): Buffer {
  // минимальный валидный PNG w×h (серый), собранный вручную — без sharp
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`не дождались: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

class ScriptedLlm implements LlmEngine {
  readonly model = "claude-opus-5-5";
  calls: AnswerRequest[] = [];
  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.calls.push(req);
    const last = req.turns[req.turns.length - 1]!.text;
    let text = "ОтветМодели42: **всё хорошо**.";
    if (last.includes("покажи карточку")) {
      const r = await req.tools.run("it_card", { title: "тест" });
      assert.equal(r.isError, false, r.content);
      text = "Вот карточка.";
    }
    // чуть подержать «печатает…», чтобы событие успело дойти до сокета
    await new Promise((r) => setTimeout(r, 150));
    return { text, sources: [], cost: { ...ZERO_COST, usd: 0.01, inputTokens: 100, outputTokens: 10, models: [this.model] }, stop: "end_turn", servedBy: this.model };
  }
  async matchCharacter() {
    return { character: null, cost: ZERO_COST };
  }
}

async function api<T>(baseUrl: string, token: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T };
}

async function main() {
  console.log(`[bot-it] run=${RUN} cwd=${process.cwd()} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[bot-it] backends: ${JSON.stringify(identity)}`);
  const proofKey = `eb-bot-it:${RUN}`;
  await redis.set(proofKey, "1");
  await redis.expire(proofKey, 3600);

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  // Хвосты прошлых прогонов в очереди бота не нужны: новый бот ответил бы в чужие беседы.
  await getBotQueue().drain(true);

  const logLines: string[] = [];
  let handle: Awaited<ReturnType<typeof startBot>> | null = null;
  let aliceSock: ReturnType<typeof ioClient> | null = null;
  let botId = "";
  try {
    // ---------- учётки ----------
    // Тестовая БД общая для прогонов: «системный бот» — только наш (getSystemBot берёт самого раннего).
    await prisma.user.updateMany({ where: { isBot: true }, data: { isBot: false } });
    const botPassword = crypto.randomBytes(18).toString("base64url");
    const seeded = await ensureBotUser(prisma, { username: `${RUN}_bot`, password: botPassword, forcePassword: false });
    assert.equal(seeded.created, true);
    const again = await ensureBotUser(prisma, { username: `${RUN}_bot`, password: botPassword, forcePassword: false });
    assert.deepEqual(again, { id: seeded.id, created: false, passwordChanged: false }, "сид идемпотентен");
    botId = seeded.id;
    resetSystemBotCache();
    const mk = (suffix: string, displayName: string) =>
      prisma.user.create({ data: { username: `${RUN}_${suffix}`, displayName, passwordHash: `x_${crypto.randomUUID()}` } });
    const alice = await mk("alice", "Алиса");
    const bob = await mk("bob", "Боб");
    const owner = await mk("owner", "Стон");
    const tok = (id: string) => signAccessToken({ sub: id, tokenId: crypto.randomUUID() });
    const [tA, tB, tO] = [tok(alice.id), tok(bob.id), tok(owner.id)];
    const conv = (isGroup: boolean, ids: string[], title?: string) =>
      prisma.conversation.create({ data: { isGroup, ...(title ? { title } : {}), createdById: ids[0]!, participants: { create: ids.map((userId) => ({ userId })) } } });
    const group = await conv(true, [alice.id, bob.id, owner.id], `${RUN} группа`);
    const direct = await conv(false, [alice.id, bob.id]);

    // ---------- бот ----------
    let restarts = 0;
    const itModule: BotModule = {
      name: "it",
      characters: { listKnownCharacters: async () => ["IiApaCiOxa", "РомаH"] },
      tools: [
        {
          name: "it_card",
          description: "тестовая карточка",
          access: "anyone",
          inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
          run: async (_i, ctx) => {
            ctx.attachImage({ data: pngBuffer(40, 30), mime: "image/png", width: 40, height: 30, name: "card.png" });
            return "карточка готова";
          },
        },
      ],
      commands: [
        {
          name: "it_restart",
          access: "owner",
          confirm: true,
          match: (t) => (t === "ит-рестарт" ? true : null),
          prepare: async () => ({ question: "Точно перезапустить тестовый сервер?" }),
          run: async () => {
            restarts++;
            return { text: "Готово (ит)." };
          },
        },
      ],
    };
    const llm = new ScriptedLlm();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-bot-it-"));
    const cfg = loadConfig({
      BOT_API_URL: baseUrl,
      BOT_REDIS_URL: env.REDIS_URL,
      BOT_USERNAME: `${RUN}_bot`,
      BOT_PASSWORD: botPassword,
      BOT_OWNER_USER_ID: owner.id,
      BOT_DATA_DIR: dataDir,
    } as NodeJS.ProcessEnv);
    const log = createLogger("debug", { svc: "eblusha-bot-it" }, (l) => logLines.push(l));
    handle = await startBot(cfg, log, { llm, extraModules: [itModule], assetsDir: path.resolve(__dirname, "../bot/assets") });
    const h = handle;

    // профиль: имя, описание, аватар из assets, EBLID; бот — системный, не участник
    const botRow = await prisma.user.findUniqueOrThrow({ where: { id: botId } });
    assert.equal(botRow.displayName, "Еблуша");
    assert.equal(botRow.isBot, true);
    assert.match(botRow.avatarUrl ?? "", /^\/api\/files\/.+/);
    assert.match(botRow.eblid ?? "", /^\d{4}$/);
    console.log("[bot-it] ok: профиль бота (имя, аватар «Б», EBLID, isBot)");

    aliceSock = ioClient(baseUrl, { path: "/socket.io/", transports: ["websocket"], auth: { token: tA } });
    const sock = aliceSock;
    const sockEvents: Array<{ event: string; payload: any }> = [];
    sock.onAny((event: string, payload: any) => sockEvents.push({ event, payload }));
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("connect_error", rej);
    });
    sock.emit("conversation:join", group.id);
    await new Promise((r) => setTimeout(r, 200));

    const send = async (token: string, body: Record<string, unknown>) => {
      const r = await api<{ message: { id: string } }>(baseUrl, token, "POST", "/api/conversations/send", { type: "TEXT", ...body });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json.message.id;
    };
    const botReplyTo = (msgId: string) =>
      waitFor(`ответ бота на ${msgId}`, () => prisma.message.findFirst({ where: { senderId: botId, replyToId: msgId }, include: { attachments: true } }));

    // ---------- группа: бот не участник, отвечает по обращению ----------
    const q1 = await send(tA, { conversationId: group.id, content: "Еблуша, Как дела у паука?" });
    const a1 = await botReplyTo(q1);
    assert.equal(a1.content, "ОтветМодели42: **всё хорошо**.");
    assert.equal(a1.conversationId, group.id);
    assert.equal(a1.isBot, true);
    assert.equal(llm.calls[0]!.turns.length, 1);
    assert.match(llm.calls[0]!.turns[0]!.text, /^⟦Алиса · \d\d\.\d\d\.\d\d \d\d:\d\d⟧\nКак дела у паука\?$/);
    assert.match(llm.calls[0]!.contextNote, /группа «.+ группа», участников: 3/);
    assert.equal(await prisma.conversationParticipant.count({ where: { conversationId: group.id, userId: botId } }), 0);
    const typing = sockEvents.filter((e) => e.event === "conversation:typing_update" && e.payload?.userId === botId && e.payload?.conversationId === group.id);
    assert.ok(typing.some((e) => e.payload.isTyping === true && e.payload.isBot === true), "«Еблуша печатает…» пришло в комнату беседы");
    await waitFor("typing снят", async () =>
      sockEvents.some((e) => e.event === "conversation:typing_update" && e.payload?.userId === botId && e.payload?.isTyping === false)
    );
    assert.ok(sockEvents.some((e) => e.event === "message:new" && e.payload?.message?.id === a1.id && e.payload.message.isBot === true));
    console.log("[bot-it] ok: «Еблуша, …» в группе без бота-участника → ответ ответом (isBot), typing от бота");

    // ---------- продолжение ответом ----------
    const q2 = await send(tB, { conversationId: group.id, content: "подробнее про лапки", replyToId: a1.id });
    await botReplyTo(q2);
    assert.deepEqual(llm.calls[1]!.turns.map((t) => t.role), ["user", "assistant", "user"]);
    assert.match(llm.calls[1]!.turns[2]!.text, /^⟦Боб · [^⟧]*, в ответ на твоё сообщение от [^⟧]*⟧\nподробнее про лапки$/);
    console.log("[bot-it] ok: продолжение ответом на сообщение бота — с историей (память беседы + цепочка)");

    // ---------- «спасибо» → 👍 ----------
    const thanks = await send(tA, { conversationId: group.id, content: "спасибо!", replyToId: a1.id });
    await waitFor("реакция 👍", () => prisma.messageReaction.findFirst({ where: { messageId: thanks, userId: botId, emoji: "👍" } }));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(await prisma.message.count({ where: { senderId: botId, replyToId: thanks } }), 0);
    assert.equal(llm.calls.length, 2);
    console.log("[bot-it] ok: «спасибо» → реакция 👍 без текста и без модели");

    // ---------- не к боту — молчим; к боту — с картинкой ----------
    const before = await prisma.message.count({ where: { senderId: botId, conversationId: group.id } });
    await send(tB, { conversationId: group.id, content: "просто болтаем, Еблуша тут ни при чём" });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await prisma.message.count({ where: { senderId: botId, conversationId: group.id } }), before);
    const q3 = await send(tB, { conversationId: group.id, content: "/eb покажи карточку" });
    await botReplyTo(q3);
    const img = await waitFor("сообщение с картинкой", () =>
      prisma.message.findFirst({ where: { senderId: botId, conversationId: group.id, type: "IMAGE" }, include: { attachments: true } })
    );
    assert.equal(img.isBot, true);
    const att = img.attachments[0]!;
    assert.equal(att.type, "IMAGE");
    const meta = att.metadata as Record<string, unknown>;
    assert.equal(meta.width, 40);
    assert.equal(meta.height, 30);
    assert.equal(meta.mime, "image/png");
    const file = await fetch(`${baseUrl}${att.url}`);
    assert.equal(file.status, 200);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString("hex"), "89504e47", "отдаётся расшифрованный PNG");
    console.log("[bot-it] ok: группа — молчит без обращения; /eb → текст + IMAGE через /api/upload");

    // ---------- личка двух людей ----------
    const q4 = await send(tB, { conversationId: direct.id, content: "Еблуша, рассуди нас" });
    const a4 = await botReplyTo(q4);
    assert.equal(a4.conversationId, direct.id);
    assert.match(llm.calls.at(-1)!.contextNote, /личная переписка двух людей/);
    console.log("[bot-it] ok: личка двух людей — ответ туда же, бот не участник");

    // ---------- «Чат с Еблушей»: включение, привязка без обращения, уведомление владельцу ----------
    const onO = await api<{ conversationId: string }>(baseUrl, tO, "PUT", "/api/bot/settings", { botChatEnabled: true });
    const onA = await api<{ conversationId: string }>(baseUrl, tA, "PUT", "/api/bot/settings", { botChatEnabled: true });
    assert.equal(onO.status, 200);
    const chatO = onO.json.conversationId;
    const chatA = onA.json.conversationId;
    const q5 = await send(tA, { conversationId: chatA, content: "мой ник в игре Парасюха" });
    const a5 = await botReplyTo(q5);
    assert.match(a5.content ?? "", /IiApaCiOxa/);
    assert.deepEqual(h.bot.coreServices().links.charactersOf(alice.id), ["IiApaCiOxa"]);
    await waitFor("уведомление владельцу в его чат с ботом", () =>
      prisma.message.findFirst({ where: { senderId: botId, conversationId: chatO, content: { contains: "Новая привязка" } } })
    );
    console.log("[bot-it] ok: «Чат с Еблушей» — без обращения; привязка ника; владельцу уведомление в его чат");

    // ---------- команда владельца с подтверждением ----------
    // Команды — молчаливые синонимы (решение владельца 2026-10-10): вне его чата и не владельцу — не отказ
    // «только владелец», а свободная форма — ответ модели; команда при этом не выполняется.
    const llmBeforeCmd = llm.calls.length;
    const denyGroup = await send(tO, { conversationId: group.id, content: "/eb ит-рестарт" });
    assert.match((await botReplyTo(denyGroup)).content ?? "", /ОтветМодели42/);
    const deny = await send(tA, { conversationId: chatA, content: "/eb ит-рестарт" });
    assert.match((await botReplyTo(deny)).content ?? "", /ОтветМодели42/);
    assert.equal(llm.calls.length, llmBeforeCmd + 2);
    assert.equal(restarts, 0);
    const c1 = await send(tO, { conversationId: chatO, content: "ит-рестарт" });
    const question = await botReplyTo(c1);
    assert.match(question.content ?? "", /Точно перезапустить/);
    assert.equal(restarts, 0);
    const yes1 = await send(tO, { conversationId: chatO, content: "да", replyToId: question.id });
    assert.equal((await botReplyTo(yes1)).content, "Готово (ит).");
    const yes2 = await send(tO, { conversationId: chatO, content: "да", replyToId: question.id });
    assert.match((await botReplyTo(yes2)).content ?? "", /истёк или это уже выполнено/);
    assert.equal(restarts, 1);
    assert.equal(llm.calls.length, llmBeforeCmd + 2, "команда владельца в его чате — без модели");
    console.log("[bot-it] ok: команда владельца — молчаливый синоним только в его «Чате с Еблушей», «да» срабатывает один раз; в остальных местах — свободная форма");

    // ---------- бот нигде не участник, кроме личных чатов с ботом ----------
    const memberships = await prisma.conversationParticipant.findMany({ where: { userId: botId }, select: { conversationId: true } });
    assert.deepEqual(memberships.map((m) => m.conversationId).sort(), [chatA, chatO].sort());
    console.log("[bot-it] ok: бот — участник только «Чатов с Еблушей»");

    // ---------- журнал без текста сообщений ----------
    assert.ok(logLines.some((l) => l.includes('"evt":"answer.sent"')), "ответы журналируются");
    for (const w of SECRET_WORDS) {
      assert.ok(!logLines.some((l) => l.includes(w)), `в журнале нет текста «${w}»`);
    }
    console.log(`[bot-it] ok: журнал (${logLines.length} строк) без текста сообщений`);

    const proof = {
      run: RUN,
      userIds: [botId, alice.id, bob.id, owner.id],
      usernames: [`${RUN}_bot`, alice.username, bob.username, owner.username],
      deviceIds: [`${RUN}-nodevice`],
      threadId: group.id,
      // prod-proof сверяет msgId с messages_secret (uuid); секретных сообщений тест не создаёт
      msgId: crypto.randomUUID(),
      redisKeys: [proofKey],
    };
    console.log(`EB_PROOF ${JSON.stringify(proof)}`);
  } catch (e) {
    console.error("[bot-it] журнал бота (последние 40 строк):\n" + logLines.slice(-40).join("\n"));
    throw e;
  } finally {
    aliceSock?.close();
    await handle?.stop().catch(() => undefined);
    await getBotQueue().drain(true).catch(() => undefined);
    if (botId) await prisma.user.update({ where: { id: botId }, data: { isBot: false, deletedAt: new Date() } }).catch(() => undefined);
    io.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().then(
  async () => {
    console.log("bot core integration: ok");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (err) => {
    console.error("bot core integration: FAILED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
