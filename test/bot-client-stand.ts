/**
 * Живой стенд для клиентов: бот «Еблуша» — часть системы (docs/bot-system.md), БЕЗ модели.
 *
 * Поднимает настоящий backend (app + Socket.IO) на 127.0.0.1:$STAND_PORT (по умолчанию 55491) в
 * изолированной среде secret-test.sh и «поддельного бота» — BullMQ-воркер очереди `bot`, который
 * отвечает через настоящие /api/bot/messages|typing|react по разрешению (grant) из задачи:
 *   - «спасибо»                      → реакция 👍 на обращение;
 *   - «подтверди» / «рестарт»        → вопрос-подтверждение (kind confirm);
 *   - «карт…»                        → текст + картинка-карточка карты «karta-valheim.png»;
 *   - «длинн…» / «част…»             → ответ из двух частей (один triggerMessageId);
 *   - остальное                      → ответ с разметкой из безопасного подмножества.
 * Сид: Алиса, Боб, Кэрол (учётки stand_alice/…; пароль — в $HOME/stand-creds.json, 600, HOME =
 * EB_TEST_HOME), личка Алиса↔Боб, группа «Вальхейм-тусовка», секретный тред Алиса↔Боб,
 * у Боба включён «Чат с Еблушей» (приветствие), у Алисы — выключен.
 *
 * Запуск (держит стенд до таймаута или до файла $HOME/stand.stop):
 *   EB_REPO=<дерево> EB_TEST_HOME=/DATA/eb-secret-test-<имя> EB_TEST_PROJECT=eb-secret-test-<имя> \
 *   EB_TEST_PG_PORT=… EB_TEST_REDIS_PORT=… test/secret-env/secret-test.sh run --timeout 7200 test/bot-client-stand.ts
 * Клиент — vite dev с прокси /api и /socket.io на 127.0.0.1:$STAND_PORT (НЕ на боевой :4000):
 * frontend/vite.stand.config.ts (там же — как открыть с ПК через туннель). Нативные клиенты могут
 * ходить на 127.0.0.1:$STAND_PORT напрямую (ssh -L), сертификатов и nginx у стенда нет.
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { hashPassword } from "../src/utils/password";
import { BOT_QUEUE_NAME } from "../src/jobs/queue";
import { ensureBotUser } from "../src/scripts/seedBotUser";
import { resetSystemBotCache, setBotChatEnabled } from "../src/lib/systemBot";
import type { BotJob } from "../src/lib/botContract";

const PORT = Number(process.env.STAND_PORT || 55491);
const DURATION_MS = Number(process.env.STAND_MINUTES || 110) * 60_000;
const HOME = process.env.HOME || "/tmp";
const STOP_FILE = path.join(HOME, "stand.stop");
const CREDS_FILE = path.join(HOME, "stand-creds.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let baseUrl = "";

const tokenFor = (id: string) => signAccessToken({ sub: id, tokenId: crypto.randomUUID() });

async function call(method: string, p: string, userId: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(userId)}` },
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

/** Простая PNG «карточка карты» (градиент + рамка), чтобы не тащить sharp. */
function makeCardPng(w: number, h: number): Buffer {
  const crcTable = (zlib as any).crc32 as (b: Buffer) => number;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcTable(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const border = x < 6 || y < 6 || x >= w - 6 || y >= h - 6;
      const river = Math.abs(y - h / 2 - 40 * Math.sin(x / 40)) < 8;
      raw[o] = border ? 226 : river ? 40 : 40 + Math.round((x / w) * 60);
      raw[o + 1] = border ? 92 : river ? 90 : 70 + Math.round((y / h) * 80);
      raw[o + 2] = border ? 42 : river ? 160 : 40;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function upsertHuman(username: string, displayName: string, passwordHash: string) {
  return prisma.user.upsert({
    where: { username },
    update: { displayName, passwordHash, deletedAt: null, bannedAt: null },
    create: { username, displayName, passwordHash },
  });
}

async function main() {
  console.log(`[stand] DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  console.log(`[stand] isolated: ${JSON.stringify(await assertIsolatedBackends(prisma, redis))}`);
  try {
    fs.unlinkSync(STOP_FILE);
  } catch {}

  const server = http.createServer(app);
  await initSocket(server);
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${PORT}`;
  console.log(`[stand] backend ${baseUrl}`);

  // Системный бот — только наш (getSystemBot берёт самого раннего с isBot).
  await prisma.user.updateMany({ where: { isBot: true, NOT: { username: "stand_bot" } }, data: { isBot: false } });
  const bot = await ensureBotUser(prisma, { username: "stand_bot", password: crypto.randomBytes(18).toString("base64url"), forcePassword: false });
  resetSystemBotCache();
  const BOT = bot.id;

  const password = crypto.randomBytes(12).toString("base64url");
  const ph = await hashPassword(password);
  const A = await upsertHuman("stand_alice", "Алиса", ph);
  const B = await upsertHuman("stand_bob", "Боб", ph);
  const C = await upsertHuman("stand_carol", "Кэрол", ph);
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ baseUrl, users: ["stand_alice", "stand_bob", "stand_carol"], password }, null, 2), { mode: 0o600 });
  console.log(`[stand] логины: stand_alice / stand_bob / stand_carol, пароль — в ${CREDS_FILE}`);

  // Бот-«воркер»: отвечает на задачи очереди через настоящие /api/bot/*.
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const card = makeCardPng(560, 340);
  const worker = new Worker(
    BOT_QUEUE_NAME,
    async (job) => {
      const j = job.data as BotJob;
      const text = String(j.message.content ?? "");
      const grant = j.grant;
      console.log(`[stand-bot] job via=${j.via} kind=${j.conversation.kind} msg=${j.message.id} chain=${j.chain.length}`);
      if (/спасибо/i.test(text)) {
        await call("POST", "/api/bot/react", BOT, { grant, messageId: j.message.id, emoji: "👍" });
        return;
      }
      await call("POST", "/api/bot/typing", BOT, { grant, typing: true });
      await sleep(2500);
      await call("POST", "/api/bot/typing", BOT, { grant, typing: true });
      await sleep(1500);
      const post = (body: Record<string, unknown>) => call("POST", "/api/bot/messages", BOT, { grant, type: "TEXT", ...body });
      if (/подтверд|рестарт/i.test(text)) {
        const r = await post({ kind: "confirm", replyToId: j.message.id, content: "Перезапустить сервер Valheim, когда все выйдут? Ответь **да** на это сообщение (2 минуты)." });
        console.log(`[stand-bot] confirm → ${r.status}`);
        return;
      }
      const ctx = j.chain.length ? `\n\n> в цепочке ${j.chain.length} сообщ., последнее: «${String(j.chain[j.chain.length - 1]?.content ?? "").slice(0, 60)}»` : "";
      const first = await post({
        kind: "answer",
        replyToId: j.message.id,
        content: `**Ответ** на «${text.slice(0, 80)}»${ctx}\n\n- пункт _первый_\n- пункт \`второй\`\n\n[живая карта](https://v.koban.uk/map/)`,
      });
      console.log(`[stand-bot] answer → ${first.status}`);
      if (/длинн|част/i.test(text)) {
        await sleep(400);
        await post({ kind: "answer", content: "### Часть 2\nПродолжение длинного ответа:\n\n```\nкод без языка\n  с отступом\n```" });
      }
      if (/карт/i.test(text)) {
        const fd = new FormData();
        fd.append("file", new Blob([new Uint8Array(card)], { type: "image/png" }), "karta-valheim.png");
        const up = await fetch(`${baseUrl}/api/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenFor(BOT)}` }, body: fd });
        const u = (await up.json()) as any;
        const r = await call("POST", "/api/bot/messages", BOT, {
          grant,
          type: "IMAGE",
          kind: "answer",
          attachments: [{ url: u.url, type: "IMAGE", size: card.length, metadata: { width: 560, height: 340, mime: "image/png", originalName: "karta-valheim.png", size: card.length } }],
        });
        console.log(`[stand-bot] map card upload=${up.status} msg=${r.status}`);
      }
      await call("POST", "/api/bot/typing", BOT, { grant, typing: false });
    },
    { connection: conn, concurrency: 4 },
  );
  worker.on("failed", (job, err) => console.log(`[stand-bot] job ${job?.id} failed: ${err?.message}`));

  // Беседы и сообщения.
  const direct = await prisma.conversation.create({
    data: { isGroup: false, createdById: A.id, participants: { create: [{ userId: A.id }, { userId: B.id }] } },
  });
  const group = await prisma.conversation.create({
    data: { isGroup: true, title: "Вальхейм-тусовка", createdById: A.id, participants: { create: [A, B, C].map((u) => ({ userId: u.id })) } },
  });
  await prisma.conversation.create({
    data: {
      isGroup: false,
      type: "SECRET",
      isSecret: true,
      secretStatus: "ACTIVE",
      createdById: A.id,
      participants: { create: [{ userId: A.id }, { userId: B.id }] },
    } as any,
  });
  const send = async (uid: string, conversationId: string, content: string, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/conversations/send", uid, { conversationId, type: "TEXT", content, ...extra });
    if (r.status !== 201) console.log(`[stand] send ${r.status} ${JSON.stringify(r.body)}`);
    return r.body?.message;
  };
  await send(B.id, direct.id, "привет! как дела?");
  await send(A.id, direct.id, "Еблуша, покажи карту и кто где");
  await sleep(6000);
  await send(C.id, group.id, "Ребята, кто сегодня играет?");
  await send(B.id, group.id, "/eb длинный ответ про рецепты, по частям");
  await sleep(6000);
  await setBotChatEnabled(B.id, true);
  console.log(`[stand] беседы: личка ${direct.id}, группа ${group.id}; у Боба «Чат с Еблушей» включён`);

  const started = Date.now();
  while (Date.now() - started < DURATION_MS && !fs.existsSync(STOP_FILE)) await sleep(2000);
  console.log("[stand] стоп");
  await worker.close();
  await conn.quit().catch(() => {});
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("[stand] FAIL", e);
  process.exit(1);
});
