/**
 * «Поделиться перепиской» и «Подумай лучше» (docs/bot-cards.md §3, §4). Настоящий backend (app + Socket.IO в
 * процессе, тестовые Postgres/Redis изолированной среды) и настоящий сервис бота с поддельной моделью — без сети и
 * без денег.
 *
 *   test/secret-env/secret-test.sh run test/bot-share.integration.test.ts
 *
 * Часть 1 — сервер (бот ходит в /api/bot/share* своим токеном, разрешения — из задач очереди `bot`):
 *   оценка по периодам (сегодня с 5 утра, неделя с понедельника, всё время; фото), «Чат с Еблушей» — 409, карточка
 *   (конверт, пуш только спросившему), права (спросивший / участник / чужой), «Поделиться» → продолжение в очереди
 *   (job.share, новый grant на тот же вопрос), страницы (только период, без удалённых/истёкших/SYSTEM, фото только
 *   с галкой и не больше 60, курсор), журнал изменений в окне, область согласия (уточнение — да, другой вопрос —
 *   403), «ответ ниже» (metadata.bot.shareId), возврат к выбору (неподъёмно), «забыть» любым участником + сигнал
 *   боту, отказ и 30 минут тишины, истечение ожидания, удаление вопроса, выход спросившего, текстовый выбор не
 *   спросившим — 403, выключатель BOT_SHARE=off.
 * Часть 2 — с ботом: вопрос → read_chat → карточка (текст модели не публикуется) → «Поделиться» → ответ по переписке
 *   (без поиска, переписка перед вопросом, удалённого нет) → уточнение без карточки → удалили сообщение → его больше
 *   нет → «забудь переписку» (кэш стёрт) → отказ и «недавно отказался» → текстовый выбор «сегодня с фото» (👍) →
 *   «Чат с Еблушей» без карточки → всё неподъёмно — честный ответ без карточки → окно закончилось — кэш стёрт.
 * Часть 3 — «Подумай лучше»: ответ → «подумай лучше» ответом (самая мощная модель, effort high, жёсткий потолок,
 *   depth: "deep", пометка) → над «глубоким» — отказ → без ответа — над последним ответом этому человеку → лимит в
 *   сутки → модель недоступна (400 «нужно хранение данных») — запасная, effort max.
 * В конце — строка EB_PROOF для `secret-test.sh prod-proof`.
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import Anthropic from "../bot/node_modules/@anthropic-ai/sdk";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { getBotQueue, getCardsQueue, getPushQueue } from "../src/jobs/queue";
import { resetSystemBotCache } from "../src/lib/systemBot";
import { periodStarts, processShareEnd, processSharePending } from "../src/lib/botShare";
import type { BotJob } from "../src/lib/botContract";
import { ensureBotUser } from "../src/scripts/seedBotUser";
import { loadConfig } from "../bot/src/config";
import { createLogger } from "../bot/src/log";
import { startBot } from "../bot/src/main";
import { ZERO_COST } from "../bot/src/core/budget";
import type { AnswerRequest, AnswerResult, AuxRequest, AuxResult, LlmEngine } from "../bot/src/llm/types";

const RUN = `ebst_sh_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
let baseUrl = "";

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
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

class ScriptedLlm implements LlmEngine {
  readonly model = "claude-opus-5-5";
  calls: AnswerRequest[] = [];
  auxCalls: AuxRequest[] = [];
  plan: (req: AnswerRequest) => Promise<string> = async () => "ОтветМодели";
  /** Ошибка API для модели (проверка запасной модели «подумай лучше»). */
  failModel: { model: string; error: Error } | null = null;
  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.calls.push(req);
    if (this.failModel && req.model === this.failModel.model) throw this.failModel.error;
    let suppressed = false;
    const tools = {
      ...req.tools,
      run: async (n: string, i: unknown) => {
        const r = await req.tools.run(n, i);
        if (r.endTurn) suppressed = true;
        return r;
      },
    };
    const text = await this.plan({ ...req, tools });
    const cost = { ...ZERO_COST, usd: 0.01, inputTokens: 100, outputTokens: 10, models: [req.model ?? this.model] };
    const servedBy = req.model ?? this.model;
    return suppressed ? { text: "", sources: [], cost, stop: "end_turn", servedBy, suppressed: true } : { text, sources: [], cost, stop: "end_turn", servedBy };
  }
  async matchCharacter() {
    return { character: null, cost: ZERO_COST };
  }
  async aux(req: AuxRequest): Promise<AuxResult> {
    this.auxCalls.push(req);
    // описания фото: «Фото #n:» перед каждой картинкой
    const ns = req.content.filter((b) => b.type === "text").map((b) => /Фото #(\d+)/.exec((b as { text: string }).text)?.[1]).filter(Boolean).map(Number);
    const text = req.schema ? JSON.stringify({ items: ns.map((n) => ({ n, caption: `красный квадрат ${n}`, text: n === 1 ? "склад" : "" })) }) : "НИЧЕГО";
    return { text, cost: { ...ZERO_COST, usd: 0.0002, inputTokens: 1300, outputTokens: 40, models: [req.model] }, model: req.model, stop: "end_turn" };
  }
}

async function main() {
  console.log(`[share] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[share] backends: ${JSON.stringify(identity)}`);
  const proofKey = `eb-share:${RUN}`;
  await redis.set(proofKey, "1", { EX: 3600 });

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const queue = getBotQueue();
  await queue.drain(true);
  await getPushQueue().drain(true);
  const jobOf = async (jobId: string) => waitFor(`задача ${jobId}`, async () => ((await queue.getJob(jobId))?.data as BotJob | undefined) ?? null);
  const ownerBefore = env.BOT_OWNER_USER_ID;
  const logLines: string[] = [];
  let handle: Awaited<ReturnType<typeof startBot>> | null = null;
  let botId = "";
  const userIds: string[] = [];
  const usernames: string[] = [];
  const SECRET_WORDS = ["шашлыки на даче", "удалю это сообщение", "истёкшее сообщение", "пароль Барсик", "договорились на субботу в 12"];
  try {
    await prisma.user.updateMany({ where: { isBot: true }, data: { isBot: false } });
    const botPassword = crypto.randomBytes(18).toString("base64url");
    botId = (await ensureBotUser(prisma, { username: `${RUN}_bot`, password: botPassword, forcePassword: false })).id;
    resetSystemBotCache();
    const tok = (id: string) => signAccessToken({ sub: id, tokenId: crypto.randomUUID() });
    const botToken = tok(botId);
    const idOfToken = new Map<string, string>();
    const mk = async (suffix: string, displayName: string) => {
      const u = await prisma.user.create({ data: { username: `${RUN}_${suffix}`, displayName, passwordHash: `x_${crypto.randomUUID()}` } });
      userIds.push(u.id);
      usernames.push(u.username);
      const token = tok(u.id);
      idOfToken.set(token, u.id);
      return { ...u, token };
    };
    const R = await mk("roma", "Рома");
    const V = await mk("vasya", "Вася");
    const P = await mk("petya", "Петя");
    const O = await mk("owner", "Стон");
    const X = await mk("outsider", "Чужой");
    (env as { BOT_OWNER_USER_ID?: string | undefined }).BOT_OWNER_USER_ID = O.id;
    const conv = (ids: string[], title: string) =>
      prisma.conversation.create({ data: { isGroup: true, title: `${RUN} ${title}`, createdById: ids[0]!, participants: { create: ids.map((userId) => ({ userId })) } } });
    const send = async (token: string, conversationId: string, content: string, extra: Record<string, unknown> = {}) => {
      await redis.del(`bot:rate:${idOfToken.get(token)}`);
      const r = await call("POST", "/api/conversations/send", token, { conversationId, type: "TEXT", content, ...extra });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.message as { id: string; createdAt: string };
    };
    const ask = async (token: string, conversationId: string, content: string, extra: Record<string, unknown> = {}) => {
      const m = await send(token, conversationId, content, extra);
      return { m, job: await jobOf(`msg-${m.id}`) };
    };
    const botCall = (p: string, body: unknown) => call("POST", p, botToken, body);
    const shareRow = (id: string) => prisma.botShare.findUniqueOrThrow({ where: { id } });

    // ---------- беседа с перепиской за разные периоды ----------
    const g = await conv([R.id, V.id, P.id, O.id], "Кобан");
    const now = new Date();
    const { today, week } = periodStarts(now, "Europe/Moscow");
    const mid = (a: Date, b: Date) => new Date(a.getTime() + Math.floor((b.getTime() - a.getTime()) / 2));
    const put = (senderId: string, content: string, createdAt: Date, extra: Record<string, unknown> = {}) =>
      prisma.message.create({ data: { conversationId: g.id, senderId, type: "TEXT", content, createdAt, ...extra } });
    await put(V.id, "старое: шашлыки на даче в мае", new Date(week.getTime() - 3 * 86_400_000));
    const hasWeekOnly = today.getTime() > week.getTime();
    if (hasWeekOnly) await put(P.id, "на неделе: договорились на субботу в 12", mid(week, today));
    const tMid = mid(today, now);
    const todayMsg = await put(V.id, "сегодня: беру уголь и мясо", tMid);
    await put(P.id, "сегодня: пароль Барсик от вайфая", new Date(tMid.getTime() + 1000));
    await put(V.id, "удалю это сообщение", new Date(tMid.getTime() + 2000), { deletedAt: new Date() });
    await put(V.id, "истёкшее сообщение", new Date(tMid.getTime() + 3000), { expiresAt: new Date(Date.now() - 1000) });
    await put(V.id, "Вася покинул(а) беседу", new Date(tMid.getTime() + 4000), { type: "SYSTEM" });
    // три фото сегодня (настоящие PNG через /api/upload)
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const photoUrls: string[] = [];
    for (let i = 0; i < 3; i++) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), `p${i}.png`);
      const up = await fetch(`${baseUrl}/api/upload`, { method: "POST", headers: { Authorization: `Bearer ${V.token}` }, body: form });
      const uj = (await up.json()) as { url: string };
      assert.ok(uj.url, `загрузка фото ${i}`);
      photoUrls.push(uj.url);
      await prisma.message.create({
        data: { conversationId: g.id, senderId: V.id, type: "IMAGE", createdAt: new Date(tMid.getTime() + 5000 + i), attachments: { create: [{ url: uj.url, type: "IMAGE", size: png.length, metadata: { width: 8, height: 8 } }] } },
      });
    }

    // =====================================================================================
    // Часть 1. Сервер
    // =====================================================================================
    const { m: q1, job: j1 } = await ask(R.token, g.id, "Еблуша, о чём мы тут договорились?");
    assert.equal(j1.rev, 4);
    const est = await botCall("/api/bot/share/estimate", { grant: j1.grant });
    assert.equal(est.status, 200, JSON.stringify(est.body));
    const per = (p: string) => est.body.periods.find((x: any) => x.period === p);
    assert.equal(est.body.conversationKind, "group");
    assert.equal(est.body.zone, "Europe/Moscow");
    assert.equal(per("today").messages, 2 + 3 + 1, "сегодня: 2 текста + 3 фото + сам вопрос (без удалённого, истёкшего, SYSTEM)");
    assert.equal(per("today").photos, 3);
    assert.equal(per("week").messages, per("today").messages + (hasWeekOnly ? 1 : 0));
    assert.equal(per("all").messages, per("week").messages + 1);
    assert.equal(per("today").from, today.toISOString());
    assert.equal(est.body.active, null);
    assert.equal(est.body.declinedAt, null);
    console.log(`[share] ok: оценка — сегодня ${per("today").messages}, неделя ${per("week").messages}, всё ${per("all").messages}, фото ${per("today").photos}`);

    await getPushQueue().drain(true);
    const req1 = await botCall("/api/bot/share/request", { grant: j1.grant, suggest: { period: "today", photos: false }, options: { all: { enabled: false, off: "budget" } } });
    assert.equal(req1.status, 201, JSON.stringify(req1.body));
    const s1 = req1.body.share.id as string;
    const card1 = req1.body.cardMessageId as string;
    const cm1 = await prisma.message.findUniqueOrThrow({ where: { id: card1 } });
    const c1 = (cm1.metadata as any).card;
    assert.equal(cm1.replyToId, q1.id, "карточка — ответом на вопрос");
    assert.equal((cm1.metadata as any).bot.kind, "card");
    assert.equal(c1.type, "share");
    assert.equal(c1.state, "pending");
    assert.deepEqual(c1.actions.map((a: any) => [a.id, a.who.ids]), [["share", [R.id]], ["decline", [R.id]]]);
    assert.deepEqual(c1.data.options.map((o: any) => [o.period, o.enabled, o.off]), [["today", true, null], ["week", true, null], ["all", false, "budget"]]);
    assert.match(cm1.content!, /^🔒 Чтобы ответить, мне нужно почитать переписку этой беседы\. \*\*Рома\*\*, поделиться\?/);
    const pushes = await waitFor("пуш о карточке", async () => {
      const jobs = await getPushQueue().getJobs(["waiting", "delayed", "prioritized"]);
      return jobs.find((j) => (j.data as any).payload?.messageId === card1) ?? null;
    });
    assert.deepEqual((pushes.data as any).userIds, [R.id], "пуш — только спросившему");
    // права
    assert.equal((await call("POST", `/api/cards/${card1}/act`, P.token, { action: "share", input: { period: "today", photos: false } })).body.code, "CARD_FORBIDDEN");
    assert.equal((await call("POST", `/api/cards/${card1}/act`, X.token, { action: "share", input: { period: "today", photos: false } })).status, 404);
    assert.equal((await call("POST", `/api/cards/${card1}/act`, R.token, { action: "share", input: { period: "all", photos: false } })).body.code, "CARD_BAD_INPUT", "погашенный вариант не выбрать");
    assert.equal((await botCall(`/api/bot/share/${s1}/choose`, { grant: (await ask(P.token, g.id, "сегодня", { replyToId: card1 })).job.grant, period: "today" })).body.code, "SHARE_NOT_ASKER");
    console.log("[share] ok: карточка (конверт, погашенный вариант, пуш только спросившему), права");

    // «Поделиться» → продолжение
    const granted = await call("POST", `/api/cards/${card1}/act`, R.token, { action: "share", input: { period: "today", photos: true } });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.card.state, "granted");
    assert.deepEqual(granted.body.card.actions.map((a: any) => [a.id, a.who]), [["forget", { any: true }]]);
    assert.equal(granted.body.card.data.choice.period, "today");
    assert.equal(granted.body.card.data.choice.photos, true);
    const resume = await jobOf(`share-${s1}-${(await shareRow(s1)).rev}`);
    assert.equal(resume.message.id, q1.id, "продолжение — на тот же вопрос");
    assert.notEqual(resume.grant, j1.grant, "новый grant");
    assert.deepEqual({ ...resume.share, until: undefined }, { id: s1, period: "today", photos: true, from: today.toISOString(), until: undefined });
    console.log("[share] ok: «Поделиться» → granted, продолжение в очереди (job.share, новый grant на исходный вопрос)");

    // страницы
    const pg = await botCall(`/api/bot/share/${s1}/messages`, { grant: resume.grant, limit: 500 });
    assert.equal(pg.status, 200, JSON.stringify(pg.body));
    const texts = pg.body.messages.map((m: any) => m.text);
    assert.ok(texts.includes("сегодня: беру уголь и мясо"));
    for (const t of ["старое: шашлыки на даче в мае", "удалю это сообщение", "истёкшее сообщение", "Вася покинул(а) беседу"]) assert.ok(!texts.includes(t), `нет «${t}»`);
    if (hasWeekOnly) assert.ok(!texts.includes("на неделе: договорились на субботу в 12"), "вне периода");
    const photoMsgs = pg.body.messages.filter((m: any) => m.kind === "photo");
    assert.equal(photoMsgs.length, 3);
    assert.ok(photoMsgs.every((m: any) => m.photos?.length === 1 && photoUrls.includes(m.photos[0].url)));
    assert.equal(pg.body.next, null);
    // курсор
    const p1 = await botCall(`/api/bot/share/${s1}/messages`, { grant: resume.grant, limit: 2 });
    assert.equal(p1.body.messages.length, 2);
    assert.ok(p1.body.next);
    const p2 = await botCall(`/api/bot/share/${s1}/messages`, { grant: resume.grant, limit: 500, after: p1.body.next });
    assert.equal(p1.body.messages.length + p2.body.messages.length, pg.body.messages.length);
    // журнал изменений в окне
    const checked = pg.body.checkedAt as number;
    const ed = await call("POST", "/api/messages/update", V.token, { messageId: todayMsg.id, content: "сегодня: беру уголь, мясо и пиво" });
    assert.equal(ed.status, 200);
    const delMe = await send(P.token, g.id, "сейчас удалю");
    assert.equal((await call("POST", "/api/messages/delete", P.token, { messageId: delMe.id })).status, 200);
    const ch = await botCall(`/api/bot/share/${s1}/messages`, { grant: resume.grant, limit: 0, changesSince: checked });
    assert.ok(ch.body.changes.edited.includes(todayMsg.id));
    assert.ok(ch.body.changes.deleted.includes(delMe.id));
    const byIds = await botCall(`/api/bot/share/${s1}/messages`, { grant: resume.grant, ids: [todayMsg.id] });
    assert.equal(byIds.body.messages[0].text, "сегодня: беру уголь, мясо и пиво");
    assert.equal(byIds.body.messages[0].edited, true);
    console.log("[share] ok: страницы — только период, без удалённого/истёкшего/SYSTEM, фото с галкой, курсор, журнал правок/удалений");

    // область согласия: другой вопрос — 403; ответ по согласию → уточнение — да
    const { job: jOther } = await ask(P.token, g.id, "Еблуша, а какая погода?");
    assert.equal((await botCall(`/api/bot/share/${s1}/messages`, { grant: jOther.grant, limit: 1 })).body.code, "SHARE_SCOPE");
    const ans = await botCall("/api/bot/messages", { grant: resume.grant, type: "TEXT", content: "Договорились: Вася берёт уголь.", replyToId: q1.id });
    assert.equal(ans.status, 201);
    const answered = await botCall(`/api/bot/share/${s1}/answered`, { grant: resume.grant, messageIds: [ans.body.message.id], read: { messages: 5, photos: 3 }, usd: 0.02 });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const ansRow = await prisma.message.findUniqueOrThrow({ where: { id: ans.body.message.id } });
    assert.equal((ansRow.metadata as any).bot.shareId, s1);
    const cAfter = (await prisma.message.findUniqueOrThrow({ where: { id: card1 } })).metadata as any;
    assert.equal(cAfter.card.data.answerMessageId, ans.body.message.id);
    assert.deepEqual(cAfter.card.data.read, { messages: 5, photos: 3 });
    const { job: jFollow } = await ask(P.token, g.id, "Еблуша, а кто был против?", { replyToId: ans.body.message.id });
    assert.equal(jFollow.chain.find((x) => x.id === ans.body.message.id)?.bot?.shareId, s1, "в цепочке — пометка согласия");
    assert.equal((await botCall(`/api/bot/share/${s1}/messages`, { grant: jFollow.grant, limit: 1 })).status, 200, "уточнение — в области согласия");
    const reqAgain = await botCall("/api/bot/share/request", { grant: jFollow.grant, suggest: { period: "today", photos: false } });
    assert.equal(reqAgain.body.status, "granted", "уточнение — без новой карточки");
    // вернуть к выбору нельзя: ответ уже был
    assert.equal((await botCall(`/api/bot/share/${s1}/reopen`, { grant: resume.grant, off: { period: "today", reason: "too_big" } })).body.code, "SHARE_REOPEN_EXPIRED");
    console.log("[share] ok: область согласия (другой вопрос — 403, уточнение — да, без новой карточки), «ответ ниже» (shareId)");

    // «забыть» — любой участник; сигнал боту
    const sigBefore = (await queue.getJobs(["waiting"])).filter((j) => j.name === "signal").length;
    const forget = await call("POST", `/api/cards/${card1}/act`, V.token, { action: "forget" });
    assert.equal(forget.body.card.state, "revoked");
    assert.deepEqual(forget.body.card.data.endedBy.by, { id: V.id, displayName: "Вася" });
    assert.match(forget.body.message.content, /Переписка забыта · попросил \*\*Вася\*\*/);
    const sig = await waitFor("сигнал боту", async () => {
      const jobs = (await queue.getJobs(["waiting"])).filter((j) => j.name === "signal");
      return jobs.length > sigBefore ? jobs.find((j) => (j.data as any).signal.shareId === s1) ?? null : null;
    });
    assert.deepEqual((sig.data as any).signal, { type: "share.ended", shareId: s1, conversationId: g.id, reason: "revoked" });
    assert.equal((await botCall(`/api/bot/share/${s1}/messages`, { grant: resume.grant, limit: 1 })).body.code, "SHARE_REVOKED");
    console.log("[share] ok: «Забыть переписку» любым участником → revoked, сигнал боту, чтение — 410");

    // возврат к выбору (неподъёмно) — первые 2 минуты, без ответа
    const { job: j2 } = await ask(R.token, g.id, "Еблуша, подведи итог дня");
    const r2 = await botCall("/api/bot/share/request", { grant: j2.grant, suggest: { period: "week", photos: false } });
    const s2 = r2.body.share.id as string;
    await call("POST", `/api/cards/${r2.body.cardMessageId}/act`, R.token, { action: "share", input: { period: "week", photos: false } });
    const resume2 = await jobOf(`share-${s2}-${(await shareRow(s2)).rev}`);
    const re = await botCall(`/api/bot/share/${s2}/reopen`, { grant: resume2.grant, off: { period: "week", reason: "too_big" } });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    const c2 = ((await prisma.message.findUniqueOrThrow({ where: { id: r2.body.cardMessageId } })).metadata as any).card;
    assert.equal(c2.state, "pending");
    assert.equal(c2.data.note, "too_big");
    assert.deepEqual(c2.data.options.find((o: any) => o.period === "week"), { ...c2.data.options.find((o: any) => o.period === "week"), enabled: false, off: "too_big" });
    // новая карточка того же спросившего заменяет ожидающую
    const { job: j3 } = await ask(R.token, g.id, "Еблуша, кто что должен купить?");
    const r3 = await botCall("/api/bot/share/request", { grant: j3.grant, suggest: { period: "today", photos: false } });
    assert.equal(r3.status, 201);
    assert.equal((await shareRow(s2)).endReason, "replaced");
    // отказ → 30 минут тишины
    await call("POST", `/api/cards/${r3.body.cardMessageId}/act`, R.token, { action: "decline" });
    assert.equal((await shareRow(r3.body.share.id)).status, "DECLINED");
    const { job: j4 } = await ask(R.token, g.id, "Еблуша, что я пропустил?");
    const quiet = await botCall("/api/bot/share/request", { grant: j4.grant, suggest: { period: "today", photos: false } });
    assert.equal(quiet.body.code, "SHARE_DECLINED_RECENTLY");
    assert.ok((await botCall("/api/bot/share/estimate", { grant: j4.grant })).body.declinedAt);
    console.log("[share] ok: возврат к выбору (погашен вариант, note), замена ожидающей, отказ и 30 минут тишины");

    // ожидание истекло; вопрос удалён; спросивший вышел
    const { job: j5 } = await ask(P.token, g.id, "Еблуша, о чём спорили?");
    const r5 = await botCall("/api/bot/share/request", { grant: j5.grant, suggest: { period: "today", photos: false } });
    assert.equal(await processSharePending(r5.body.share.id, true), true);
    assert.equal((await shareRow(r5.body.share.id)).status, "EXPIRED");
    const { m: q6, job: j6 } = await ask(O.token, g.id, "Еблуша, кто прав?");
    const r6 = await botCall("/api/bot/share/request", { grant: j6.grant, suggest: { period: "today", photos: false } });
    assert.equal((await call("POST", "/api/messages/delete", O.token, { messageId: q6.id })).status, 200);
    await waitFor("вопрос удалён → expired", async () => ((await shareRow(r6.body.share.id)).endReason === "question_deleted" ? true : null));
    const g2 = await conv([R.id, V.id, X.id], "Выход");
    await put(V.id, "что-то", new Date());
    await prisma.message.create({ data: { conversationId: g2.id, senderId: V.id, type: "TEXT", content: "привет" } });
    const { job: j7 } = await ask(X.token, g2.id, "Еблуша, что тут было?");
    const r7 = await botCall("/api/bot/share/request", { grant: j7.grant, suggest: { period: "today", photos: false } });
    assert.equal((await call("DELETE", `/api/conversations/${g2.id}/participants/me`, X.token)).status, 200);
    await waitFor("спросивший вышел", async () => ((await shareRow(r7.body.share.id)).endReason === "asker_left" ? true : null));
    console.log("[share] ok: ожидание истекло, вопрос удалён, спросивший вышел");

    // фото: не больше 60 самых новых
    const g3 = await conv([R.id, V.id], "Фото");
    for (let i = 0; i < 62; i++) {
      await prisma.message.create({ data: { conversationId: g3.id, senderId: V.id, type: "IMAGE", createdAt: new Date(Date.now() - (62 - i) * 1000), attachments: { create: [{ url: photoUrls[0]!, type: "IMAGE", size: png.length }] } } });
    }
    const { job: j8 } = await ask(R.token, g3.id, "Еблуша, найди схему");
    const r8 = await botCall("/api/bot/share/request", { grant: j8.grant, suggest: { period: "all", photos: true } });
    assert.equal(((await prisma.message.findUniqueOrThrow({ where: { id: r8.body.cardMessageId } })).metadata as any).card.data.options.find((o: any) => o.period === "all").photosUsed, 60);
    await call("POST", `/api/cards/${r8.body.cardMessageId}/act`, R.token, { action: "share", input: { period: "all", photos: true } });
    const resume8 = await jobOf(`share-${r8.body.share.id}-${(await shareRow(r8.body.share.id)).rev}`);
    const pg8 = await botCall(`/api/bot/share/${r8.body.share.id}/messages`, { grant: resume8.grant, limit: 500 });
    assert.equal(pg8.body.messages.reduce((a: number, m: any) => a + (m.photos?.length ?? 0), 0), 60, "не больше 60 фото на согласие");
    assert.equal(pg8.body.messages.filter((m: any) => m.kind === "photo" && !m.photos).length, 2, "старые фото — строкой без картинки");
    // «слишком много» → к выбору → новый выбор той же карточки: новая задача боту (jobId по ревизии), не тихий повтор
    const id8 = r8.body.share.id as string;
    const rev8 = (await shareRow(id8)).rev;
    const re8 = await botCall(`/api/bot/share/${id8}/reopen`, { grant: resume8.grant, off: { period: "all", reason: "too_big" } });
    assert.equal(re8.status, 200, JSON.stringify(re8.body));
    const ch8 = await call("POST", `/api/cards/${r8.body.cardMessageId}/act`, R.token, { action: "share", input: { period: "today", photos: false } });
    assert.equal(ch8.status, 200, JSON.stringify(ch8.body));
    const rev8b = (await shareRow(id8)).rev;
    assert.ok(rev8b > rev8 + 1, `ревизия выросла: ${rev8} → ${rev8b}`);
    const resume8b = await jobOf(`share-${id8}-${rev8b}`);
    assert.equal(resume8b.share?.period, "today");
    assert.equal(resume8b.share?.photos, false);
    assert.notEqual(resume8b.share?.until, resume8.share?.until, "новое окно — бот не примет её за повтор");
    // без галки — фото строкой
    await call("POST", `/api/cards/${r8.body.cardMessageId}/act`, R.token, { action: "forget" });
    console.log("[share] ok: фото — не больше 60 самых новых, остальные строкой; новый выбор после «слишком много» — новая задача");

    // «Чат с Еблушей» — 409; выключатель
    const bc = await call("PUT", "/api/bot/settings", X.token, { botChatEnabled: true });
    const botChatId = bc.body.conversationId as string;
    const { job: jb } = await ask(X.token, botChatId, "о чём мы договорились?");
    assert.equal(jb.conversation.kind, "bot");
    assert.equal((await botCall("/api/bot/share/estimate", { grant: jb.grant })).body.code, "SHARE_NOT_NEEDED");
    process.env.BOT_SHARE = "off";
    assert.equal((await botCall("/api/bot/share/estimate", { grant: j4.grant })).body.code, "SHARE_DISABLED");
    delete process.env.BOT_SHARE;
    console.log("[share] ok: «Чат с Еблушей» — 409 SHARE_NOT_NEEDED; BOT_SHARE=off — 404");
    await queue.drain(true);

    // =====================================================================================
    // Часть 2. С ботом
    // =====================================================================================
    const llm = new ScriptedLlm();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-share-"));
    const botEnv = (extra: Record<string, string> = {}) =>
      loadConfig({
        BOT_API_URL: baseUrl,
        BOT_REDIS_URL: env.REDIS_URL,
        BOT_USERNAME: `${RUN}_bot`,
        BOT_PASSWORD: botPassword,
        BOT_OWNER_USER_ID: O.id,
        BOT_DATA_DIR: dataDir,
        BOT_USER_DAILY_QUESTIONS: "1000",
        BOT_DEEP_USER_DAILY: "2",
        ...extra,
      } as NodeJS.ProcessEnv);
    const log = createLogger("debug", { svc: "eblusha-bot-share" }, (l) => logLines.push(l));
    const start = (extra: Record<string, string> = {}) => startBot(botEnv(extra), log, { llm, assetsDir: path.resolve(__dirname, "../bot/assets") });
    handle = await start();
    const botReplyTo = (msgId: string) => waitFor(`ответ бота на ${msgId}`, () => prisma.message.findFirst({ where: { senderId: botId, replyToId: msgId, deletedAt: null }, orderBy: { createdAt: "desc" } }));
    const cardFor = (msgId: string) => waitFor(`карточка на ${msgId}`, () => prisma.botShare.findFirst({ where: { triggerMessageId: msgId } }));
    const lastCall = () => llm.calls.at(-1)!;
    // модель: без переписки — просит её; с перепиской — отвечает по ней
    llm.plan = async (req) => {
      if (req.preamble) return `По переписке: ${/уголь/.test(req.preamble) ? "Вася берёт уголь" : "нет"}`;
      const r = await req.tools.run("read_chat", { period: "today", photos: true });
      return r.endTurn ? "НЕ ДОЛЖНО ПУБЛИКОВАТЬСЯ" : `Без переписки: ${r.content}`;
    };
    const ga = await conv([R.id, V.id, P.id, O.id], "Бот");
    await prisma.message.create({ data: { conversationId: ga.id, senderId: V.id, type: "TEXT", content: "беру уголь и мясо", createdAt: new Date(Date.now() - 60_000) } });
    const mDel = await prisma.message.create({ data: { conversationId: ga.id, senderId: P.id, type: "TEXT", content: "пароль Барсик от вайфая", createdAt: new Date(Date.now() - 50_000) } });
    const bq = await send(R.token, ga.id, "Еблуша, о чём мы тут договорились?");
    const bs = await cardFor(bq.id);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!(await prisma.message.findFirst({ where: { senderId: botId, content: "НЕ ДОЛЖНО ПУБЛИКОВАТЬСЯ" } })), "после карточки текст модели не публикуется");
    const callsBefore = llm.calls.length;
    await call("POST", `/api/cards/${bs.cardMessageId}/act`, R.token, { action: "share", input: { period: "today", photos: false } });
    const bAns = await waitFor("ответ по переписке (с пометкой согласия)", () =>
      prisma.message.findFirst({ where: { senderId: botId, replyToId: bq.id, content: { startsWith: "По переписке" }, metadata: { path: ["bot", "shareId"], equals: bs.id } } })
    );
    assert.equal(bAns.content, "По переписке: Вася берёт уголь");
    assert.equal((bAns.metadata as any).bot.shareId, bs.id);
    const ansCall = llm.calls.slice(callsBefore).find((c) => c.preamble)!;
    assert.equal(ansCall.web, false, "без поиска и чтения страниц");
    assert.deepEqual(ansCall.tools.defs.map((d) => d.name), [], "без фото — без инструментов");
    assert.match(ansCall.preamble!, /<chat_transcript>/);
    assert.match(ansCall.preamble!, /Вася: беру уголь и мясо/);
    assert.match(ansCall.contextNote, /с разрешения Рома/);
    const bsAfter = await shareRow(bs.id);
    assert.equal(bsAfter.answerMessageIds[0], bAns.id);
    assert.equal(bsAfter.readMessages, 3, "прочитал 3 сообщения людей (вопрос тоже)");
    assert.equal(handle.bot.shareCache.size(), 1);
    // удалили сообщение в окне → уточнение без карточки, удалённого нет
    assert.equal((await call("POST", "/api/messages/delete", P.token, { messageId: mDel.id })).status, 200);
    const bf = await send(P.token, ga.id, "Еблуша, а что там с паролем?", { replyToId: bAns.id });
    await waitFor("ответ на уточнение", () => prisma.message.findFirst({ where: { senderId: botId, replyToId: bf.id } }));
    const fCall = lastCall();
    assert.ok(fCall.preamble, "уточнение — с перепиской");
    assert.ok(!fCall.preamble!.includes("Барсик"), "удалённое в окне — выкинуто из кэша");
    assert.equal(await prisma.botShare.count({ where: { conversationId: ga.id } }), 1, "без новой карточки");
    console.log("[share] ok: бот — read_chat → карточка → «Поделиться» → ответ по переписке без поиска → уточнение без карточки, удалённого нет");

    // «забудь переписку» — кэш стёрт
    const fg = await send(V.token, ga.id, "Еблуша, забудь переписку");
    assert.equal((await botReplyTo(fg.id)).content, "Готово, переписку забыл.");
    assert.equal((await shareRow(bs.id)).status, "REVOKED");
    await waitFor("кэш стёрт", async () => (handle!.bot.shareCache.size() === 0 ? true : null));
    const fg2 = await send(V.token, ga.id, "Еблуша, забудь переписку");
    assert.equal((await botReplyTo(fg2.id)).content, "Я сейчас ничего не держу 🙂");
    // отказ → «недавно отказался» без новой карточки
    const dq = await send(R.token, ga.id, "Еблуша, что Вася говорил про субботу?");
    const ds = await cardFor(dq.id);
    await call("POST", `/api/cards/${ds.cardMessageId}/act`, R.token, { action: "decline" });
    const dq2 = await send(R.token, ga.id, "Еблуша, подведи итог дня");
    const dAns = await botReplyTo(dq2.id);
    assert.match(dAns.content!, /^Без переписки: Спросивший недавно/);
    assert.equal(await prisma.botShare.count({ where: { triggerMessageId: dq2.id } }), 0);
    // текстовый выбор ответом на карточку (старый клиент)
    const tq = await send(P.token, ga.id, "Еблуша, что я пропустил?");
    const ts = await cardFor(tq.id);
    const tReply = await send(P.token, ga.id, "сегодня с фото", { replyToId: ts.cardMessageId! });
    await waitFor("👍 на выбор", () => prisma.messageReaction.findFirst({ where: { messageId: tReply.id, userId: botId } }));
    const tsAfter = await shareRow(ts.id);
    assert.equal(tsAfter.status, "GRANTED");
    assert.equal(tsAfter.period, "today");
    await waitFor("ответ после текстового выбора", () => prisma.message.findFirst({ where: { senderId: botId, replyToId: tq.id, content: { startsWith: "По переписке" } } }));
    // окно закончилось — кэш стёрт
    assert.equal(await processShareEnd(ts.id, null, true), true);
    await waitFor("кэш стёрт по концу окна", async () => (handle!.bot.shareCache.size() === 0 ? true : null));
    assert.match((await prisma.message.findUniqueOrThrow({ where: { id: ts.cardMessageId! } })).content!, /Доступ закончился в/);
    console.log("[share] ok: «забудь переписку», отказ → «недавно отказался», текстовый выбор «сегодня с фото» (👍), конец окна — кэш стёрт");

    // «Чат с Еблушей» — без карточки
    const xq = await send(X.token, botChatId, "о чём мы договорились?");
    assert.match((await botReplyTo(xq.id)).content!, /Чат с Еблушей/);
    // всё неподъёмно — честно и без карточки
    await handle.stop();
    handle = await start({ BOT_SHARE_MAX_USD: "0.0000001" });
    const bigQ = await send(P.token, ga.id, "Еблуша, о чём спорили вчера?");
    assert.equal((await botReplyTo(bigQ.id)).content, "Переписки здесь слишком много для моего лимита — даже за сегодня.");
    assert.equal(await prisma.botShare.count({ where: { triggerMessageId: bigQ.id } }), 0);
    await handle.stop();
    handle = await start();
    console.log("[share] ok: «Чат с Еблушей» — без карточки; всё неподъёмно — честный ответ без карточки");

    // =====================================================================================
    // Часть 3. «Подумай лучше»
    // =====================================================================================
    const gd = await conv([R.id, P.id], "Подумай");
    llm.plan = async (req) => (req.model ? `Глубоко (${req.model}, ${req.topEffort})` : "Обычный ответ: 4");
    const d1 = await send(R.token, gd.id, "Еблуша, сколько будет 2+2?");
    const a1 = await botReplyTo(d1.id);
    assert.equal(a1.content, "Обычный ответ: 4");
    const deep1 = await send(R.token, gd.id, "Еблуша, подумай лучше", { replyToId: a1.id });
    const da1 = await botReplyTo(deep1.id);
    assert.equal(da1.content, "🧠 **Подумал лучше**\n\nГлубоко (claude-fable-5-1, high)");
    assert.equal((da1.metadata as any).bot.depth, "deep");
    assert.equal((da1.metadata as any).bot.model, "claude-fable-5-1");
    const dc = lastCall();
    assert.equal(dc.model, "claude-fable-5-1");
    assert.equal(dc.hardCap, true);
    assert.equal(dc.maxUsd, 2);
    assert.equal(dc.maxIterations, 6);
    assert.equal(dc.systemTtl, "5m");
    assert.equal(dc.maxTokens, 32000, "80 % от $2 по цене вывода Fable ($50/млн)");
    assert.match(dc.contextNote, /подумай лучше/);
    assert.ok(dc.turns.some((t) => t.text.includes("Обычный ответ: 4")), "модель видит прошлый ответ");
    // над «глубоким» — отказ
    const deep2 = await send(R.token, gd.id, "Еблуша, подумай лучше", { replyToId: da1.id });
    assert.match((await botReplyTo(deep2.id)).content!, /уже мой самый обдуманный ответ/);
    // без ответа — над последним ответом этому человеку; запасная модель при 400 «нужно хранение данных»
    llm.failModel = {
      model: "claude-fable-5-1",
      error: new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "In order to access this model, your organization or workspace must have data retention enabled." } }, "In order to access this model, your organization or workspace must have data retention enabled.", new Headers()),
    };
    const d3 = await send(R.token, gd.id, "Еблуша, подумай ещё");
    const da3 = await botReplyTo(d3.id);
    assert.equal(da3.content, "🧠 **Подумал лучше**\n\nГлубоко (claude-opus-5-5, max)");
    assert.equal((da3.metadata as any).bot.model, "claude-opus-5-5");
    assert.match(lastCall().contextNote, /последним ответом ему/);
    // лимит в сутки (BOT_DEEP_USER_DAILY=2)
    const d4 = await send(R.token, gd.id, "Еблуша, подумай как следует", { replyToId: a1.id });
    assert.match((await botReplyTo(d4.id)).content!, /На сегодня «подумай лучше» закончилось \(2 в день\) — обновится в \d\d:\d\d по Москве/);
    assert.ok(logLines.some((l) => l.includes('"evt":"deep.fallback"')));
    console.log("[share] ok: «Подумай лучше» — Fable 5.1 (high, потолок $2, 5-мин кэш), depth=deep + пометка, над глубоким — нет, без ответа — по памяти, 400 «хранение данных» → Opus 5.5 max, лимит в сутки");

    for (const w of SECRET_WORDS) assert.ok(!logLines.some((l) => l.includes(w)), `в журнале бота нет «${w}»`);
    assert.ok(logLines.some((l) => l.includes('"evt":"share.asked"')));
    const proof = { run: RUN, userIds: [botId, ...userIds], usernames: [`${RUN}_bot`, ...usernames], deviceIds: [`${RUN}-nodevice`], threadId: g.id, msgId: crypto.randomUUID(), redisKeys: [proofKey] };
    console.log(`EB_PROOF ${JSON.stringify(proof)}`);
  } catch (e) {
    console.error("[share] журнал бота (последние 40 строк):\n" + logLines.slice(-40).join("\n"));
    throw e;
  } finally {
    (env as { BOT_OWNER_USER_ID?: string | undefined }).BOT_OWNER_USER_ID = ownerBefore;
    await handle?.stop().catch(() => undefined);
    await getBotQueue().drain(true).catch(() => undefined);
    await getCardsQueue().obliterate({ force: true }).catch(() => undefined);
    if (botId) await prisma.user.update({ where: { id: botId }, data: { isBot: false, deletedAt: new Date() } }).catch(() => undefined);
    io.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().then(
  async () => {
    console.log("bot share integration: ok");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (err) => {
    console.error("bot share integration: FAILED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
