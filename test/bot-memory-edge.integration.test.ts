/**
 * Бот «Еблуша», память — краевые случаи (ревью 2-го круга, 2026-10-11) против настоящего сервера и настоящего
 * сервиса бота (поддельная модель с «задвижкой»: тест действует, пока модель «думает»). Без сети и без денег.
 *
 *   test/secret-env/secret-test.sh run test/bot-memory-edge.integration.test.ts
 *
 *  (a) человек поправил СВОЙ вопрос, пока бот думал, — ответ приходит (раньше: «спроси ещё раз»);
 *  (b) другой участник удалил свой давний вопрос, который модель видела, — ответ не публикуется (мог пересказать);
 *      а новое обращение, которого модель не видела, удалили — ответ приходит;
 *  (c) «Чат с Еблушей»: уведомление бота до первого сообщения человека модель видит, и заметка не говорит
 *      «раньше вы не говорили»;
 *  (d) сжатие сломалось — модель знает, что память неполная («не утверждай, что этого не было»);
 *  (e) сжатие выключено (BOT_MEMORY_MODEL=off) — давнее забывается, курсор двигается, модель знает до какого момента.
 * В конце — строка EB_PROOF для `secret-test.sh prod-proof`.
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import type { AnswerRequest, AnswerResult, LlmEngine, SummarizeRequest, SummarizeResult } from "../bot/src/llm/types";

const RUN = `ebst_me_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
let baseUrl = "";

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`не дождались: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function call(method: string, p: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

class GatedLlm implements LlmEngine {
  readonly model = "claude-opus-5-5";
  calls: AnswerRequest[] = [];
  summaries: SummarizeRequest[] = [];
  gate: Promise<void> | null = null;
  entered: (() => void) | null = null;
  refuseSummaries = false;
  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.calls.push(req);
    this.entered?.();
    if (this.gate) await this.gate;
    return { text: "НастоящийОтвет", sources: [], cost: { ...ZERO_COST, usd: 0.001, models: [this.model] }, stop: "end_turn", servedBy: this.model };
  }
  async matchCharacter() {
    return { character: null, cost: ZERO_COST };
  }
  async summarize(req: SummarizeRequest): Promise<SummarizeResult> {
    this.summaries.push(req);
    if (this.refuseSummaries) return { text: "", cost: { ...ZERO_COST, usd: 0.001, models: ["claude-sonnet-5-5"] }, model: "claude-sonnet-5-5", stop: "refusal" };
    return { text: `${req.previous}\n${req.transcript}`, cost: { ...ZERO_COST, usd: 0.001, models: ["claude-sonnet-5-5"] }, model: "claude-sonnet-5-5", stop: "end_turn" };
  }
}

async function main() {
  console.log(`[mem-edge] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  console.log(`[mem-edge] backends: ${JSON.stringify(await assertIsolatedBackends(prisma, redis))}`);
  const proofKey = `eb-mem-edge:${RUN}`;
  await redis.set(proofKey, "1", { EX: 3600 });
  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await getBotQueue().drain(true);
  let handle: Awaited<ReturnType<typeof startBot>> | null = null;
  let botId = "";
  const userIds: string[] = [];
  const usernames: string[] = [];
  const logLines: string[] = [];
  let threadId = "";
  try {
    await prisma.user.updateMany({ where: { isBot: true }, data: { isBot: false } });
    const botPassword = crypto.randomBytes(18).toString("base64url");
    botId = (await ensureBotUser(prisma, { username: `${RUN}_bot`, password: botPassword, forcePassword: false })).id;
    resetSystemBotCache();
    const tok = (id: string) => signAccessToken({ sub: id, tokenId: crypto.randomUUID() });
    const botToken = tok(botId);
    const idOf = new Map<string, string>();
    const mk = async (suffix: string, displayName: string) => {
      const u = await prisma.user.create({ data: { username: `${RUN}_${suffix}`, displayName, passwordHash: `x_${crypto.randomUUID()}` } });
      userIds.push(u.id);
      usernames.push(u.username);
      const token = tok(u.id);
      idOf.set(token, u.id);
      return { ...u, token };
    };
    const A = await mk("alice", "Алиса");
    const B = await mk("bob", "Боб");
    const O = await mk("owner", "Стон");
    const group = async (title: string) =>
      prisma.conversation.create({ data: { isGroup: true, title: `${RUN} ${title}`, createdById: A.id, participants: { create: [A.id, B.id, O.id].map((userId) => ({ userId })) } } });
    const g = await group("г");
    threadId = g.id;
    const send = async (token: string, conversationId: string, content: string) => {
      await redis.del(`bot:rate:${idOf.get(token)}`);
      const r = await call("POST", "/api/conversations/send", token, { conversationId, type: "TEXT", content });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.message as { id: string; createdAt: string };
    };
    const botReplyTo = (msgId: string) => waitFor(`ответ бота на ${msgId}`, () => prisma.message.findFirst({ where: { senderId: botId, replyToId: msgId } }));
    const llm = new GatedLlm();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-mem-edge-"));
    const log = createLogger("debug", { svc: "eblusha-bot-mem-edge" }, (l) => logLines.push(l));
    const start = (extra: Record<string, string> = {}) =>
      startBot(
        loadConfig({
          BOT_API_URL: baseUrl,
          BOT_REDIS_URL: env.REDIS_URL,
          BOT_USERNAME: `${RUN}_bot`,
          BOT_PASSWORD: botPassword,
          BOT_OWNER_USER_ID: O.id,
          BOT_DATA_DIR: dataDir,
          BOT_USER_DAILY_QUESTIONS: "1000",
          ...extra,
        } as NodeJS.ProcessEnv),
        log,
        { llm, assetsDir: path.resolve(__dirname, "../bot/assets") }
      );
    handle = await start();
    const gated = () => {
      let release!: () => void;
      llm.gate = new Promise<void>((r) => (release = r));
      const entered = new Promise<void>((r) => (llm.entered = r));
      return {
        entered,
        release: () => {
          llm.gate = null;
          release();
        },
      };
    };

    const old = await send(B.token, g.id, "Еблуша, давний вопрос Боба");
    await botReplyTo(old.id);

    // (a) Алиса правит опечатку в своём вопросе, пока бот думает
    let gt = gated();
    const qa = await send(A.token, g.id, "Еблуша, сколько будет 2+2? опечтака");
    await gt.entered;
    assert.equal((await call("POST", "/api/messages/update", A.token, { messageId: qa.id, content: "Еблуша, сколько будет 2+2? опечатка" })).status, 200);
    gt.release();
    assert.equal((await botReplyTo(qa.id)).content, "НастоящийОтвет", "правка своего вопроса ответ не отменяет");
    console.log("[mem-edge] ok: (a) правка своего вопроса, пока бот думал, — ответ пришёл");

    // (b1) пока бот думает над вопросом Алисы, Боб пишет новое обращение и тут же удаляет — модель его не видела
    gt = gated();
    const qb1 = await send(A.token, g.id, "Еблуша, какая столица Италии?");
    await gt.entered;
    const oops = await send(B.token, g.id, "Еблуша, ой не то");
    assert.equal((await call("POST", "/api/messages/delete", B.token, { messageId: oops.id })).status, 200);
    gt.release();
    assert.equal((await botReplyTo(qb1.id)).content, "НастоящийОтвет", "удаление того, чего модель не видела, ответ не отменяет");
    // (b2) Боб удаляет свой давний вопрос, который модель видела в памяти, — ответ не публикуется
    gt = gated();
    const qb = await send(A.token, g.id, "Еблуша, какая столица Франции?");
    await gt.entered;
    assert.ok(JSON.stringify(llm.calls.at(-1)!.turns).includes("давний вопрос Боба"), "модель его видела");
    assert.equal((await call("POST", "/api/messages/delete", B.token, { messageId: old.id })).status, 200);
    gt.release();
    assert.match((await botReplyTo(qb.id)).content ?? "", /из нашего разговора удалили сообщение/);
    console.log("[mem-edge] ok: (b) удаление невиденного — ответ пришёл; удаление виденного — ответ не опубликован");

    // (c) «Чат с Еблушей»: уведомление бота до первого сообщения человека
    const on = await call("PUT", "/api/bot/settings", O.token, { botChatEnabled: true });
    assert.equal(on.status, 200);
    const chat: string = on.body.conversationId;
    const n = await call("POST", "/api/bot/messages", botToken, { userId: O.id, type: "TEXT", content: "Уведомление: сервер Valheim перезапущен в 03:00 #n1#", kind: "notice" });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    const qc = await send(O.token, chat, "что за уведомление ты мне прислал?");
    await botReplyTo(qc.id);
    const lc = llm.calls.at(-1)!;
    assert.ok(JSON.stringify(lc.turns).includes("#n1#"), "модель видит уведомление");
    assert.equal(lc.turns[0]!.role, "user");
    assert.doesNotMatch(lc.contextNote, /начало твоего разговора/);
    console.log("[mem-edge] ok: (c) уведомление до первого вопроса — модель его видит, «начала разговора» нет");

    // (d) сжатие сломалось — память неполная, модель об этом знает
    await handle.stop();
    handle = await start({ BOT_MEMORY_TAIL_TOKENS: "300", BOT_MEMORY_TAIL_KEEP_TOKENS: "150" });
    llm.refuseSummaries = true;
    const g2 = await group("г2");
    for (let i = 1; i <= 14; i++) await botReplyTo((await send(B.token, g2.id, `Еблуша, вопрос номер ${i} про рейд`)).id);
    const ld = llm.calls.at(-1)!;
    assert.match(ld.contextNote, /Память сейчас неполная/);
    assert.match(ld.contextNote, /не утверждай, что этого не было/);
    console.log("[mem-edge] ok: (d) сжатие не прошло — модель знает, что память неполная");

    // (e) сжатие выключено: давнее забывается, курсор двигается
    await handle.stop();
    llm.refuseSummaries = false;
    handle = await start({ BOT_MEMORY_TAIL_TOKENS: "300", BOT_MEMORY_TAIL_KEEP_TOKENS: "150", BOT_MEMORY_MODEL: "off" });
    const g3 = await group("г3");
    const sumBefore = llm.summaries.length;
    await botReplyTo((await send(A.token, g3.id, "Еблуша, самое первое #first#")).id);
    for (let i = 1; i <= 14; i++) await botReplyTo((await send(B.token, g3.id, `Еблуша, вопрос ${i}`)).id);
    assert.equal(llm.summaries.length, sumBefore, "модель сжатия не звали");
    const le = llm.calls.at(-1)!;
    assert.ok(!JSON.stringify(le.turns).includes("#first#"), "давнее забыто");
    assert.match(le.contextNote, /ты помнишь не полностью/);
    await handle.stop();
    handle = null;
    const db = new DatabaseSync(path.join(dataDir, "bot.sqlite"));
    const row = db.prepare("SELECT summary, forgotten, cursor_id FROM memory WHERE conversation_id = ?").get(g3.id) as { summary: string; forgotten: number; cursor_id: string };
    db.close();
    assert.equal(row.summary, "");
    assert.ok(row.forgotten > 0 && row.cursor_id, "курсор сдвинут, забытое посчитано");
    assert.ok(logLines.some((l) => l.includes('"evt":"memory.forgot"')));
    console.log(`[mem-edge] ok: (e) BOT_MEMORY_MODEL=off — давнее забыто (${row.forgotten} сообщений), курсор двигается, модель это знает`);

    for (const w of ["давний вопрос Боба", "#n1#", "#first#", "опечатка"]) assert.ok(!logLines.some((l) => l.includes(w)), `в журнале бота нет «${w}»`);
    const proof = { run: RUN, userIds: [botId, ...userIds], usernames: [`${RUN}_bot`, ...usernames], deviceIds: [`${RUN}-nodevice`], threadId, msgId: crypto.randomUUID(), redisKeys: [proofKey] };
    console.log(`EB_PROOF ${JSON.stringify(proof)}`);
  } catch (e) {
    console.error("[mem-edge] журнал бота:\n" + logLines.slice(-40).join("\n"));
    throw e;
  } finally {
    await handle?.stop().catch(() => undefined);
    await getBotQueue().drain(true).catch(() => undefined);
    if (botId) await prisma.user.update({ where: { id: botId }, data: { isBot: false, deletedAt: new Date() } }).catch(() => undefined);
    io.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().then(
  async () => {
    console.log("bot memory edge integration: ok");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (err) => {
    console.error("bot memory edge integration: FAILED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
