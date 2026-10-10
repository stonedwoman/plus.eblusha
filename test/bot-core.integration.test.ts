/**
 * Ядро бота (bot/) против НАСТОЯЩЕГО backend Еблуши в изолированной среде eb-secret-test.
 * Файл лежит в корневом test/, а не в bot/: ts-node ищет tsconfig рядом со скриптом, а backend
 * собирается только с корневым (типы src/types).
 *
 *   test/secret-env/secret-test.sh run test/bot-core.integration.test.ts
 *
 * Поднимает app + Socket.IO в процессе (тестовые Postgres/Redis, см. test/secret-env), заводит
 * учётку бота тем же кодом, что и боевой сид (src/scripts/seedBotUser.ts), запускает бота тем же
 * startBot(), что и сервис, но с поддельной моделью (без сети и без денег), и проходит путь
 * сообщений по-настоящему: HTTP-отправка человеком → message:notify боту → ответ ботом через
 * /api/conversations/send (replyToId), реакции, вложения через /api/upload, отказ в секретном
 * треде, принятие контакта, отклонение звонка, команда владельца с «да».
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
import { ensureBotUser } from "../src/scripts/seedBotUser";
import { loadConfig } from "../bot/src/config";
import { createLogger } from "../bot/src/log";
import { startBot } from "../bot/src/main";
import { ZERO_COST } from "../bot/src/core/budget";
import type { AnswerRequest, AnswerResult, LlmEngine } from "../bot/src/llm/types";
import type { BotModule } from "../bot/src/modules/api";

const RUN = `ebbot_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
const SECRET_WORDS = ["Как дела у паука", "подробнее про лапки", "ОтветМодели42", "покажи карточку"];

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

  const logLines: string[] = [];
  let handle: Awaited<ReturnType<typeof startBot>> | null = null;
  let aliceSock: ReturnType<typeof ioClient> | null = null;
  try {
    // ---------- учётки ----------
    const botPassword = crypto.randomBytes(18).toString("base64url");
    const seeded = await ensureBotUser(prisma, { username: `${RUN}_bot`, password: botPassword, forcePassword: false });
    assert.equal(seeded.created, true);
    const again = await ensureBotUser(prisma, { username: `${RUN}_bot`, password: botPassword, forcePassword: false });
    assert.deepEqual(again, { id: seeded.id, created: false, passwordChanged: false }, "сид идемпотентен");
    const botId = seeded.id;
    const mk = (suffix: string, displayName: string) =>
      prisma.user.create({ data: { username: `${RUN}_${suffix}`, displayName, passwordHash: `x_${crypto.randomUUID()}` } });
    const alice = await mk("alice", "Алиса");
    const bob = await mk("bob", "Боб");
    const owner = await mk("owner", "Стон");
    const carol = await mk("carol", "Кэрол");
    const tok = (id: string) => signAccessToken({ sub: id, tokenId: crypto.randomUUID() });
    const [tA, tB, tO, tC] = [tok(alice.id), tok(bob.id), tok(owner.id), tok(carol.id)];
    const conv = (isGroup: boolean, ids: string[], title?: string) =>
      prisma.conversation.create({ data: { isGroup, ...(title ? { title } : {}), participants: { create: ids.map((userId) => ({ userId })) } } });
    const dmAlice = await conv(false, [alice.id, botId]);
    const dmOwner = await conv(false, [owner.id, botId]);
    const group = await conv(true, [alice.id, bob.id, botId], `${RUN} группа`);

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
      BOT_USERNAME: `${RUN}_bot`,
      BOT_PASSWORD: botPassword,
      BOT_OWNER_USER_ID: owner.id,
      BOT_DATA_DIR: dataDir,
    } as NodeJS.ProcessEnv);
    const log = createLogger("debug", { svc: "eblusha-bot-it" }, (l) => logLines.push(l));
    handle = await startBot(cfg, log, { llm, extraModules: [itModule], assetsDir: path.resolve(__dirname, "../bot/assets") });
    const h = handle;
    await waitFor("сокет бота подключён", async () => h.rt.connected);

    // профиль: имя, описание, аватар из assets, EBLID
    const botRow = await prisma.user.findUniqueOrThrow({ where: { id: botId } });
    assert.equal(botRow.displayName, "Еблуша");
    assert.match(botRow.avatarUrl ?? "", /^\/api\/files\/.+/);
    assert.match(botRow.eblid ?? "", /^\d{4}$/);
    console.log("[bot-it] ok: профиль бота (имя, аватар «Б», EBLID)");

    const send = async (token: string, body: Record<string, unknown>) => {
      const r = await api<{ message: { id: string } }>(baseUrl, token, "POST", "/api/conversations/send", { type: "TEXT", ...body });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json.message.id;
    };
    const botReplyTo = (msgId: string) =>
      waitFor(`ответ бота на ${msgId}`, () =>
        prisma.message.findFirst({ where: { senderId: botId, replyToId: msgId }, include: { attachments: true } })
      );

    // ---------- вызов в личке ----------
    const q1 = await send(tA, { conversationId: dmAlice.id, content: "Еблуша, Как дела у паука?" });
    const a1 = await botReplyTo(q1);
    assert.equal(a1.content, "ОтветМодели42: **всё хорошо**.");
    assert.equal(a1.conversationId, dmAlice.id);
    assert.deepEqual(llm.calls[0]!.turns, [{ role: "user", text: "Алиса: Как дела у паука?" }]);
    assert.match(llm.calls[0]!.contextNote, /личные сообщения/);
    console.log("[bot-it] ok: «Еблуша, …» в личке → ответ ответом (replyToId)");

    // ---------- продолжение ответом ----------
    const q2 = await send(tA, { conversationId: dmAlice.id, content: "подробнее про лапки", replyToId: a1.id });
    await botReplyTo(q2);
    assert.equal(llm.calls[1]!.turns.length, 3);
    assert.deepEqual(llm.calls[1]!.turns.map((t) => t.role), ["user", "assistant", "user"]);
    console.log("[bot-it] ok: продолжение ответом на сообщение бота — с историей цепочки");

    // ---------- «спасибо» → 👍 ----------
    const thanks = await send(tA, { conversationId: dmAlice.id, content: "спасибо!", replyToId: a1.id });
    await waitFor("реакция 👍", () => prisma.messageReaction.findFirst({ where: { messageId: thanks, userId: botId, emoji: "👍" } }));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(await prisma.message.count({ where: { senderId: botId, replyToId: thanks } }), 0);
    assert.equal(llm.calls.length, 2);
    console.log("[bot-it] ok: «спасибо» → реакция 👍 без текста и без модели");

    // ---------- группа: не к боту — молчим; к боту — с картинкой ----------
    const before = await prisma.message.count({ where: { senderId: botId, conversationId: group.id } });
    await send(tB, { conversationId: group.id, content: "просто болтаем, Еблуша тут ни при чём" });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await prisma.message.count({ where: { senderId: botId, conversationId: group.id } }), before);
    const q3 = await send(tB, { conversationId: group.id, content: "/eb покажи карточку" });
    await botReplyTo(q3);
    const img = await waitFor("сообщение с картинкой", () =>
      prisma.message.findFirst({ where: { senderId: botId, conversationId: group.id, type: "IMAGE" }, include: { attachments: true } })
    );
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

    // ---------- привязка ника ----------
    const q4 = await send(tA, { conversationId: dmAlice.id, content: "Еблуша, мой ник в игре Парасюха" });
    const a4 = await botReplyTo(q4);
    assert.match(a4.content ?? "", /IiApaCiOxa/);
    assert.deepEqual(h.bot.coreServices().links.charactersOf(alice.id), ["IiApaCiOxa"]);
    console.log("[bot-it] ok: привязка ника фразой (IiApaCiOxa = Парасюха)");

    // ---------- команда владельца с подтверждением ----------
    const deny = await send(tA, { conversationId: dmAlice.id, content: "/eb ит-рестарт" });
    assert.match((await botReplyTo(deny)).content ?? "", /только владелец/);
    const c1 = await send(tO, { conversationId: dmOwner.id, content: "/eb ит-рестарт" });
    const question = await botReplyTo(c1);
    assert.match(question.content ?? "", /Точно перезапустить/);
    assert.equal(restarts, 0);
    const yes1 = await send(tO, { conversationId: dmOwner.id, content: "да", replyToId: question.id });
    assert.equal((await botReplyTo(yes1)).content, "Готово (ит).");
    const yes2 = await send(tO, { conversationId: dmOwner.id, content: "да", replyToId: question.id });
    assert.match((await botReplyTo(yes2)).content ?? "", /истёк или команда уже выполнена/);
    assert.equal(restarts, 1);
    console.log("[bot-it] ok: команда владельца — только в его личке, «да» срабатывает один раз");

    // ---------- секретный тред ----------
    const st = await api<{ threadId: string }>(baseUrl, tA, "POST", "/api/threads/secret", { peerUserId: botId });
    assert.ok(st.status === 201 || st.status === 200, JSON.stringify(st.json));
    const threadId = st.json.threadId;
    await waitFor("тред отклонён ботом", async () => (await prisma.conversation.findUnique({ where: { id: threadId } }))?.secretStatus === "CANCELLED");
    await waitFor("записка в обычную личку", () =>
      prisma.message.findFirst({ where: { senderId: botId, conversationId: dmAlice.id, content: { contains: "секретных чатах я не работаю" } } })
    );
    assert.equal(await prisma.message.count({ where: { conversationId: threadId } }), 0, "в секретный тред бот не писал");
    console.log("[bot-it] ok: секретный тред отклонён, в него ни строки; объяснение — в обычной личке");

    // ---------- контакт ----------
    const add = await api<{ contact: { id: string } }>(baseUrl, tC, "POST", "/api/contacts/add", { userId: botId });
    assert.equal(add.status, 201);
    await waitFor("контакт принят", async () => (await prisma.contact.findUnique({ where: { id: add.json.contact.id } }))?.status === "ACCEPTED");
    console.log("[bot-it] ok: запрос в контакты принят автоматически");

    // ---------- звонок ----------
    aliceSock = ioClient(baseUrl, { path: "/socket.io/", transports: ["websocket"], auth: { token: tA } });
    const sock = aliceSock;
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("connect_error", rej);
    });
    const declined = new Promise<{ conversationId: string; by: { id: string } }>((res) => sock.on("call:declined", res));
    sock.emit("call:invite", { conversationId: dmAlice.id, video: false });
    const d = await Promise.race([declined, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("нет call:declined")), 8000))]);
    assert.equal(d.by.id, botId);
    console.log("[bot-it] ok: входящий звонок в личке отклонён ботом");

    // ---------- журнал без текста сообщений ----------
    assert.ok(logLines.some((l) => l.includes('"evt":"answer.sent"')), "ответы журналируются");
    for (const w of SECRET_WORDS) {
      assert.ok(!logLines.some((l) => l.includes(w)), `в журнале нет текста «${w}»`);
    }
    console.log(`[bot-it] ok: журнал (${logLines.length} строк) без текста сообщений`);

    // ---------- в секретные беседы бот не пишет даже по прямой просьбе ядра ----------
    assert.equal(await h.bot.sendReply(threadId, null, "тест"), null);

    const proof = {
      run: RUN,
      userIds: [botId, alice.id, bob.id, owner.id, carol.id],
      usernames: [`${RUN}_bot`, alice.username, bob.username, owner.username, carol.username],
      deviceIds: [`${RUN}-nodevice`],
      threadId,
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
