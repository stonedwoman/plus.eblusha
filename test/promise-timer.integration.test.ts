/**
 * Таймер обещания «Еблуша, проконтролируй» (docs/bot-cards.md §2). Настоящий backend (app + Socket.IO в процессе,
 * тестовые Postgres/Redis изолированной среды), воркер очереди `cards` с ускоренным временем
 * (CARDS_TEST_TIME_SCALE), настоящий сервис бота (bot/src/main.ts startBot) с поддельной моделью и поддельным
 * Valheim — без сети и без денег.
 *
 *   test/secret-env/secret-test.sh run test/promise-timer.integration.test.ts
 *
 * Часть 1 — сервер (бот ходит в /api/bot/promises* своим токеном, разрешения — из задач очереди `bot`):
 *   создание ответом на обещание (карточка, конверт, запасной текст, message:new, rev 4 в задаче), кандидаты за
 *   час (чужие, свежие, не взятые), «уже следим», права кнопок (участник/не участник/спросивший/владелец), «Вернуть»,
 *   гонка «Пришёл» + звонок, вход в звонок сокетом и подписанным вебхуком LiveKit, продление (только обещавший,
 *   «не позже»), поправка, напоминания в срок/+15/+30 и авто-закрытие на ускоренном времени, таймер «уже опоздал»,
 *   перезапуск воркера (отложенные задачи в Redis), удаления (карточка, обещание), выход обещавшего, пределы,
 *   ошибки разбора, пунктуальность только по общим беседам, выключатель PROMISE_TIMERS=off.
 * Часть 2 — с ботом: «проконтролируй» ответом, «ещё 10 минут» ответом на карточку (👍), «он тут», «кого
 *   контролируем?» → перезапуск бота → «2», «засеки 15 минут» о себе, запасной разбор моделью, «проследи, чтобы
 *   Петя…» инструментом модели, «отмени», пунктуальность, вход в Valheim (since; до обещания — не считается;
 *   после перезапуска наблюдателя — тоже).
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
import { io as ioClient, type Socket } from "socket.io-client";
import { AccessToken } from "livekit-server-sdk";
// Ускорение очереди карточек включаем только там, где ждём напоминаний (иначе они пришли бы посреди проверок кнопок).
process.env.CARDS_TEST_TIME_SCALE = "1";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { publishMessageUpdate } from "../src/realtime/events";
import { signAccessToken } from "../src/utils/jwt";
import { getBotQueue, getCardsQueue } from "../src/jobs/queue";
import { startCardsWorker } from "../src/jobs/workers/cards.worker";
import { resetSystemBotCache } from "../src/lib/systemBot";
import { promiseOnCallJoin, sweepPromises } from "../src/lib/promiseTimer";
import { resolveDeadline } from "../src/lib/promiseTime";
import type { BotJob } from "../src/lib/botContract";
import { ensureBotUser } from "../src/scripts/seedBotUser";
import { loadConfig } from "../bot/src/config";
import { createLogger } from "../bot/src/log";
import { startBot } from "../bot/src/main";
import { ZERO_COST } from "../bot/src/core/budget";
import { PromiseWatch } from "../bot/src/modules/valheim/promiseWatch";
import type { AnswerRequest, AnswerResult, AuxRequest, AuxResult, LlmEngine } from "../bot/src/llm/types";
import type { BotModule } from "../bot/src/modules/api";

const RUN = `ebst_pt_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
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

async function connect(token: string, convs: string[]): Promise<{ s: Socket; events: any[] }> {
  const s = ioClient(baseUrl, { auth: { token }, transports: ["websocket"], forceNew: true });
  await new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("connect_error", reject);
  });
  const events: any[] = [];
  s.on("message:update", (p) => events.push({ ev: "message:update", ...p }));
  s.on("message:new", (p) => events.push({ ev: "message:new", ...p }));
  for (const c of convs) s.emit("conversation:join", c);
  await new Promise((r) => setTimeout(r, 150));
  return { s, events };
}

class ScriptedLlm implements LlmEngine {
  readonly model = "claude-opus-5-5";
  calls: AnswerRequest[] = [];
  auxCalls: AuxRequest[] = [];
  plan: (req: AnswerRequest) => Promise<string> = async () => "ОтветМодели";
  auxPlan: (req: AuxRequest) => string = () => "{}";
  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.calls.push(req);
    let suppressed = false;
    const tools = { ...req.tools, run: async (n: string, i: unknown) => {
      const r = await req.tools.run(n, i);
      if (r.endTurn) suppressed = true;
      return r;
    } };
    const text = await this.plan({ ...req, tools });
    const cost = { ...ZERO_COST, usd: 0.01, inputTokens: 100, outputTokens: 10, models: [this.model] };
    return suppressed ? { text: "", sources: [], cost, stop: "end_turn", servedBy: this.model, suppressed: true } : { text, sources: [], cost, stop: "end_turn", servedBy: this.model };
  }
  async matchCharacter() {
    return { character: null, cost: ZERO_COST };
  }
  async aux(req: AuxRequest): Promise<AuxResult> {
    this.auxCalls.push(req);
    return { text: this.auxPlan(req), cost: { ...ZERO_COST, usd: 0.0005, inputTokens: 50, outputTokens: 20, models: [req.model] }, model: req.model, stop: "end_turn" };
  }
}

/** Подписанный вебхук LiveKit (как шлёт сам LiveKit: JWT ключом API + sha256 тела). */
async function livekitWebhook(body: Record<string, unknown>): Promise<number> {
  const raw = JSON.stringify(body);
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  (at as unknown as { sha256: string }).sha256 = crypto.createHash("sha256").update(raw).digest("base64");
  const jwt = await at.toJwt();
  const res = await fetch(`${baseUrl}/api/livekit/webhook`, { method: "POST", headers: { "Content-Type": "application/webhook+json", Authorization: jwt }, body: raw });
  return res.status;
}

async function main() {
  console.log(`[promise] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[promise] backends: ${JSON.stringify(identity)}`);
  const proofKey = `eb-promise:${RUN}`;
  await redis.set(proofKey, "1", { EX: 3600 });

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const queue = getBotQueue();
  await queue.drain(true);
  await getCardsQueue().obliterate({ force: true }).catch(() => undefined);
  let worker = startCardsWorker();
  const jobOf = async (messageId: string) => waitFor(`задача ${messageId}`, async () => ((await queue.getJob(`msg-${messageId}`))?.data as BotJob | undefined) ?? null);
  const ownerBefore = env.BOT_OWNER_USER_ID;
  const sockets: Socket[] = [];
  const logLines: string[] = [];
  let handle: Awaited<ReturnType<typeof startBot>> | null = null;
  let botId = "";
  const userIds: string[] = [];
  const usernames: string[] = [];
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
    const V = await mk("vasya", "Козёл Ебаный");
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
      return { m, job: await jobOf(m.id) };
    };
    const botCall = (p: string, body: unknown) => call("POST", p, botToken, body);
    const timerRow = (id: string) => prisma.promiseTimer.findUniqueOrThrow({ where: { id } });
    const cardOf = async (messageId: string) => {
      const m = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
      return { m, card: (m.metadata as any).card };
    };

    // =====================================================================================
    // Часть 1. Сервер
    // =====================================================================================
    const g1 = await conv([R.id, V.id, P.id, O.id], "Кобан");
    const pSock = await connect(P.token, [g1.id]);
    sockets.push(pSock.s);

    const v15 = await send(V.token, g1.id, "15мин");
    const { m: t1, job: j1 } = await ask(R.token, g1.id, "Еблуша, проконтролируй", { replyToId: v15.id });
    assert.equal(j1.rev, 4, "задача — ревизия 4");
    assert.equal(j1.chain.at(-1)!.id, v15.id);
    const created = await botCall("/api/bot/promises", { grant: j1.grant, promiserId: V.id, promiseMessageId: v15.id, cancelAllowedIds: [R.id] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const p1 = created.body.promise;
    assert.equal(p1.label, "15 мин");
    assert.equal(p1.deadlineAt, new Date(Date.parse(v15.createdAt) + 15 * 60_000).toISOString(), "срок — от времени обещания, секунды сохраняются");
    assert.equal(p1.zoneSource, "default");
    const card1 = created.body.cardMessageId as string;
    const { m: cm1, card: c1 } = await cardOf(card1);
    assert.equal(cm1.isBot, true);
    assert.equal(cm1.senderId, botId);
    assert.equal(cm1.replyToId, t1.id, "карточка — ответом на обращение");
    assert.deepEqual((cm1.metadata as any).bot, { v: 1, kind: "card", triggerMessageId: t1.id, askerId: R.id });
    assert.equal(c1.v, 1);
    assert.equal(c1.type, "promise");
    assert.equal(c1.state, "running");
    assert.equal(c1.rev, 1);
    assert.deepEqual(c1.actions.map((a: any) => a.id), ["arrived", "cancel"]);
    assert.deepEqual(c1.actions[1].who.ids.sort(), [R.id, O.id].sort(), "отменить — спросивший и владелец бота");
    assert.equal(c1.data.promiser.displayName, "Козёл Ебаный");
    assert.equal(c1.data.quote.text, "15мин");
    assert.match(cm1.content!, /^⏱ Таймер: \*\*Козёл Ебаный\*\* обещал «15мин» — жду до \d\d:\d\d МСК\.\nЖивой таймер — в новой версии Еблуши\.$/);
    await waitFor("message:new карточки у Пети", async () => pSock.events.find((e) => e.ev === "message:new" && e.messageId === card1));
    console.log("[promise] ok: ответом на «15мин» — карточка (конверт v1, запасной текст, message:new)");

    // задача в этой беседе несёт идущие таймеры (rev 4)
    const { job: jx } = await ask(P.token, g1.id, "Еблуша, просто вопрос");
    assert.equal(jx.promises?.length, 1);
    assert.equal(jx.promises![0]!.id, p1.id);
    assert.equal(jx.promises![0]!.promiserName, "Козёл Ебаный");
    // сообщение бота в цепочке несёт пометки карточки
    const { job: jc } = await ask(P.token, g1.id, "Еблуша, а это что?", { replyToId: card1 });
    const inChain = jc.chain.find((x) => x.id === card1)!;
    assert.deepEqual(inChain.bot?.card, { type: "promise", id: p1.id, state: "running" });
    console.log("[promise] ok: в задаче — идущие таймеры и пометки карточки в цепочке");

    // уже следим
    const again = await botCall("/api/bot/promises", { grant: jx.grant, promiserId: V.id, text: "через 20 минут" });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "PROMISE_EXISTS");
    assert.equal(again.body.promise.id, p1.id);

    // смотреть: участник да, чужой — 404
    assert.equal((await call("GET", `/api/cards/${card1}`, P.token)).status, 200);
    const foreign = await call("GET", `/api/cards/${card1}`, X.token);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.code, "CARD_NOT_FOUND");
    assert.equal((await call("POST", `/api/cards/${card1}/act`, X.token, { action: "arrived" })).status, 404);

    // права кнопок
    const pc = await call("POST", `/api/cards/${card1}/act`, P.token, { action: "cancel" });
    assert.equal(pc.status, 403);
    assert.equal(pc.body.code, "CARD_FORBIDDEN");
    assert.equal(pc.body.card.state, "running");
    const bad = await call("POST", `/api/cards/${card1}/act`, P.token, { action: "explode" });
    assert.equal(bad.status, 400, "неизвестное действие");
    assert.equal(bad.body.code, "CARD_BAD_INPUT");
    pSock.events.length = 0;
    const pa = await call("POST", `/api/cards/${card1}/act`, P.token, { action: "arrived" });
    assert.equal(pa.status, 200, JSON.stringify(pa.body));
    assert.equal(pa.body.card.state, "arrived");
    assert.equal(pa.body.card.data.outcome.via, "button");
    assert.equal(pa.body.card.data.outcome.kind, "onTime");
    assert.deepEqual(pa.body.card.data.outcome.by, { id: P.id, displayName: "Петя" });
    assert.deepEqual(pa.body.card.actions.map((a: any) => a.id), ["reopen"]);
    assert.ok(typeof pa.body.serverNow === "string");
    const ev = await waitFor("message:update карточки", async () => pSock.events.find((e) => e.ev === "message:update" && e.messageId === card1));
    assert.equal(ev.reason, "card");
    assert.equal(ev.cardType, "promise");
    assert.equal(ev.card.rev, 2);
    assert.equal(ev.card.state, "arrived");
    assert.ok(ev.serverNow && ev.message?.id === card1);
    assert.match(ev.message.content, /^✅ \*\*Козёл Ебаный\*\* пришёл вовремя/);
    // повторное «Пришёл» — 409 с текущей карточкой
    const pa2 = await call("POST", `/api/cards/${card1}/act`, R.token, { action: "arrived" });
    assert.equal(pa2.status, 409);
    assert.equal(pa2.body.code, "CARD_CLOSED");
    assert.equal(pa2.body.card.state, "arrived");
    // «Вернуть»: нажавший — да; обещавший — нет
    const vr = await call("POST", `/api/cards/${card1}/act`, V.token, { action: "reopen" });
    assert.equal(vr.status, 403);
    const pr = await call("POST", `/api/cards/${card1}/act`, P.token, { action: "reopen" });
    assert.equal(pr.status, 200);
    assert.equal(pr.body.card.state, "running");
    assert.equal(pr.body.card.rev, 3);
    // отменить — спросивший; «Вернуть» после истечения — 409
    const rc = await call("POST", `/api/cards/${card1}/act`, R.token, { action: "cancel" });
    assert.equal(rc.body.card.state, "cancelled");
    assert.deepEqual(rc.body.card.data.cancelledBy, { id: R.id, displayName: "Рома" });
    assert.match(rc.body.message.content, /^Таймер для \*\*Козёл Ебаный\*\* отменён\.$/);
    await prisma.promiseTimer.update({ where: { id: p1.id }, data: { reopenUntil: new Date(Date.now() - 1000) } });
    const late = await call("POST", `/api/cards/${card1}/act`, R.token, { action: "reopen" });
    assert.equal(late.status, 409);
    assert.ok(late.body.code === "CARD_ACTION_EXPIRED" || late.body.code === "CARD_CLOSED");
    // владелец бота может «Вернуть» (окно открываем заново) и отменить
    await prisma.promiseTimer.update({ where: { id: p1.id }, data: { reopenUntil: new Date(Date.now() + 60_000) } });
    assert.equal((await call("POST", `/api/cards/${card1}/act`, O.token, { action: "reopen" })).status, 200);
    console.log("[promise] ok: кнопки — права, rev, «Вернуть», 409 с текущим видом, событие message:update {reason:card}");

    // мост событий из других процессов (Redis realtime:message:update) передаёт карточку, тип и время сервера
    pSock.events.length = 0;
    await publishMessageUpdate({ conversationId: g1.id, messageId: card1, reason: "card", cardType: "promise", card: { v: 1, type: "promise", id: p1.id, rev: 99 }, serverNow: "2026-10-11T00:00:00.000Z", message: { id: card1 } });
    const bridged = await waitFor("событие через мост", async () => pSock.events.find((e) => e.ev === "message:update" && e.card?.rev === 99));
    assert.equal(bridged.cardType, "promise");
    assert.equal(bridged.serverNow, "2026-10-11T00:00:00.000Z");
    console.log("[promise] ok: мост событий из воркера передаёт cardType, card, serverNow");

    // гонка: «Пришёл» Пети и звонок Васи одновременно — один итог
    const [ra] = await Promise.all([call("POST", `/api/cards/${card1}/act`, P.token, { action: "arrived" }), promiseOnCallJoin(g1.id, V.id, new Date())]);
    const afterRace = await timerRow(p1.id);
    assert.equal(afterRace.status, "ARRIVED");
    assert.ok(ra.status === 200 || ra.status === 409, `гонка: ${ra.status}`);
    assert.ok(afterRace.arrivedVia === "button" || afterRace.arrivedVia === "call");
    console.log(`[promise] ok: гонка «Пришёл» + звонок — один итог (${afterRace.arrivedVia})`);

    // ---------- кандидаты без ответа, вход в звонок сокетом ----------
    const g2 = await conv([R.id, V.id, P.id], "Кандидаты");
    await prisma.message.create({ data: { conversationId: g2.id, senderId: V.id, type: "TEXT", content: "буду через 10 минут", createdAt: new Date(Date.now() - 2 * 3600_000) } });
    await send(P.token, g2.id, "кто играет сегодня?");
    const vHalf = await send(V.token, g2.id, "через полчаса");
    await send(R.token, g2.id, "я через 5 минут"); // автор обращения — не кандидат
    const { job: j2 } = await ask(R.token, g2.id, "Еблуша, проконтролируй");
    const cands = await botCall("/api/bot/promises/candidates", { grant: j2.grant });
    assert.equal(cands.status, 200);
    assert.deepEqual(cands.body.candidates.map((c: any) => c.messageId), [vHalf.id], "только свежие обещания других участников");
    assert.equal(cands.body.candidates[0].parsed.label, "30 мин");
    const c2 = await botCall("/api/bot/promises", { grant: j2.grant, promiserId: V.id, promiseMessageId: vHalf.id });
    assert.equal(c2.status, 201);
    const vSock = await connect(V.token, [g2.id]);
    sockets.push(vSock.s);
    vSock.s.emit("call:room:join", { conversationId: g2.id, video: false });
    const viaCall = await waitFor("вход в звонок → пришёл", async () => {
      const r = await timerRow(c2.body.promise.id);
      return r.status === "ARRIVED" ? r : null;
    });
    assert.equal(viaCall.arrivedVia, "call");
    assert.equal(viaCall.reopenUntil, null, "авто-закрытие «Вернуть» не даёт");
    // взятое в таймер — больше не кандидат
    const { job: j2b } = await ask(R.token, g2.id, "Еблуша, проконтролируй");
    assert.deepEqual((await botCall("/api/bot/promises/candidates", { grant: j2b.grant })).body.candidates, []);
    // уже в звонке — засекать нечего
    const vNow = await send(V.token, g2.id, "буду через 40 минут");
    const { job: j2c } = await ask(R.token, g2.id, "Еблуша, засеки", { replyToId: vNow.id });
    const here = await botCall("/api/bot/promises", { grant: j2c.grant, promiserId: V.id, promiseMessageId: vNow.id });
    assert.equal(here.status, 409);
    assert.equal(here.body.code, "PROMISE_ALREADY_HERE");
    vSock.s.emit("call:room:leave", { conversationId: g2.id });
    console.log("[promise] ok: кандидаты за час (только чужие, свежие, не взятые), вход в звонок сокетом, «уже в звонке»");

    // ---------- вебхук LiveKit ----------
    const g3 = await conv([R.id, V.id], "Вебхук");
    const v3 = await send(V.token, g3.id, "через 25 минут");
    const { job: j3 } = await ask(R.token, g3.id, "Еблуша, следи", { replyToId: v3.id });
    const c3 = await botCall("/api/bot/promises", { grant: j3.grant, promiserId: V.id, promiseMessageId: v3.id });
    assert.equal(c3.status, 201);
    const joinedAt = Math.floor(Date.now() / 1000);
    const st = await livekitWebhook({ id: `EV_${RUN}_1`, event: "participant_joined", room: { name: `conv-${g3.id}` }, participant: { identity: `${V.id}#dev1` }, createdAt: String(joinedAt) });
    assert.equal(st, 200);
    const viaHook = await waitFor("вебхук → пришёл", async () => {
      const r = await timerRow(c3.body.promise.id);
      return r.status === "ARRIVED" ? r : null;
    });
    assert.equal(viaHook.arrivedVia, "call");
    assert.equal(Math.floor(viaHook.arrivedAt!.getTime() / 1000), joinedAt, "время входа — из события");
    console.log("[promise] ok: подписанный вебхук LiveKit participant_joined (conv-<id>) → пришёл");

    // ---------- продление и поправка ----------
    const g4 = await conv([R.id, V.id, P.id], "Продление");
    const v4 = await send(V.token, g4.id, "10 мин");
    const { job: j4 } = await ask(R.token, g4.id, "Еблуша, засеки", { replyToId: v4.id });
    const c4 = await botCall("/api/bot/promises", { grant: j4.grant, promiserId: V.id, promiseMessageId: v4.id });
    const card4 = c4.body.cardMessageId as string;
    // поправка спросившего (в первые 5 минут): «не 10, а 5 минут» — от времени обещания, без счёта продлений
    const { job: j4c } = await ask(R.token, g4.id, "Еблуша, не 10, а 5 минут", { replyToId: card4 });
    const corr = await botCall(`/api/bot/promises/${c4.body.promise.id}/correct`, { grant: j4c.grant, text: "5 минут" });
    assert.equal(corr.status, 200, JSON.stringify(corr.body));
    assert.equal(corr.body.promise.deadlineAt, new Date(Date.parse(v4.createdAt) + 5 * 60_000).toISOString());
    assert.equal(corr.body.promise.extensionCount, 0);
    // продление — только обещавший
    const { m: e1, job: j4e } = await ask(V.token, g4.id, "ещё 10 минут", { replyToId: card4 });
    assert.equal(j4e.via, "reply", "ответ на карточку — обращение к боту");
    const ext = await botCall(`/api/bot/promises/${c4.body.promise.id}/extend`, { grant: j4e.grant, text: "ещё 10 минут" });
    assert.equal(ext.status, 200, JSON.stringify(ext.body));
    assert.equal(ext.body.promise.deadlineAt, new Date(Date.parse(e1.createdAt) + 10 * 60_000).toISOString(), "новый срок — от времени продления");
    assert.equal(ext.body.promise.extensionCount, 1);
    const { card: c4card } = await cardOf(card4);
    assert.equal(c4card.data.extensionCount, 1);
    assert.equal(c4card.data.extensions.length, 1);
    const { job: j4p } = await ask(P.token, g4.id, "ещё 10 минут", { replyToId: card4 });
    const extP = await botCall(`/api/bot/promises/${c4.body.promise.id}/extend`, { grant: j4p.grant, text: "ещё 10 минут" });
    assert.equal(extP.status, 403);
    assert.equal(extP.body.code, "PROMISE_EXTEND_FORBIDDEN");
    const { job: j4n } = await ask(V.token, g4.id, "ещё 1 минуту", { replyToId: card4 });
    const notLater = await botCall(`/api/bot/promises/${c4.body.promise.id}/extend`, { grant: j4n.grant, text: "ещё 1 минуту" });
    assert.equal(notLater.status, 409);
    assert.equal(notLater.body.code, "PROMISE_NOT_LATER");
    // поправка не спросившим — нельзя
    const { job: j4v } = await ask(V.token, g4.id, "Еблуша, не 10, а 50 минут", { replyToId: card4 });
    assert.equal((await botCall(`/api/bot/promises/${c4.body.promise.id}/correct`, { grant: j4v.grant, text: "50 минут" })).body.code, "PROMISE_CORRECT_FORBIDDEN");
    console.log("[promise] ok: продление только обещавшим (от времени его сообщения, «не позже» — 409), поправка спросившего");

    // ---------- напоминания на ускоренном времени, авто-закрытие ----------
    process.env.CARDS_TEST_TIME_SCALE = "1200"; // минута — за 50 мс, 6 часов — за 18 с
    const g5 = await conv([R.id, V.id, P.id], "Напоминания");
    const v5 = await send(V.token, g5.id, "1 мин");
    const { job: j5 } = await ask(R.token, g5.id, "Еблуша, засеки", { replyToId: v5.id });
    const c5 = await botCall("/api/bot/promises", { grant: j5.grant, promiserId: V.id, promiseMessageId: v5.id });
    const p5 = c5.body.promise.id as string;
    const reminders = await waitFor(
      "три напоминания (в срок, +15, +30)",
      async () => {
        const rows = await prisma.message.findMany({ where: { conversationId: g5.id, isBot: true, metadata: { path: ["bot", "promiseId"], equals: p5 } }, orderBy: { createdAt: "asc" } });
        return rows.length >= 3 ? rows : null;
      },
      20_000
    );
    assert.equal(reminders.length, 3);
    for (const r of reminders) {
      assert.equal(r.replyToId, v5.id, "напоминание — ответом на само обещание");
      assert.equal((r.metadata as any).bot.kind, "notice");
      assert.deepEqual((r.metadata as any).bot.mentions, [V.id]);
      assert.equal((r.metadata as any).bot.askerId, R.id);
      assert.match(r.content!, /\*\*Козёл Ебаный\*\*/);
    }
    assert.match(reminders[1]!.content!, /15|четверть/);
    const r5 = await timerRow(p5);
    assert.deepEqual([...r5.remindersSent].sort((a, b) => a - b), [0, 15, 30]);
    assert.equal(r5.remindersTotal, 3);
    const unresolved = await waitFor("авто-закрытие через 6 ч (ускорено)", async () => {
      const r = await timerRow(p5);
      return r.status === "UNRESOLVED" ? r : null;
    }, 40_000);
    assert.equal(unresolved.closeReason, "unresolved");
    assert.match((await cardOf(c5.body.cardMessageId)).m.content!, /никто не отметил приход/);
    console.log("[promise] ok: напоминания в срок / +15 / +30 (ответом на обещание, mentions), авто-закрытие «никто не отметил»");

    // уже опоздавший: «время вышло» не пишется, +15 — по расписанию
    const g6 = await conv([R.id, V.id], "Опоздание");
    const vOld = await prisma.message.create({ data: { conversationId: g6.id, senderId: V.id, type: "TEXT", content: "15 минут", createdAt: new Date(Date.now() - 30 * 60_000) } });
    const { job: j6 } = await ask(R.token, g6.id, "Еблуша, проконтролируй", { replyToId: vOld.id });
    const c6 = await botCall("/api/bot/promises", { grant: j6.grant, promiserId: V.id, promiseMessageId: vOld.id });
    assert.equal(c6.status, 201);
    assert.match((await cardOf(c6.body.cardMessageId)).m.content!, /^⏰ \*\*Козёл Ебаный\*\* опаздывает/);
    const late15 = await waitFor("+15 у опоздавшего", async () => {
      const rows = await prisma.message.findMany({ where: { conversationId: g6.id, isBot: true, metadata: { path: ["bot", "promiseId"], equals: c6.body.promise.id } } });
      return rows.length >= 2 ? rows : null;
    }, 20_000);
    assert.ok(!late15.some((r) => /время вышло|Тик-так|срок!/.test(r.content ?? "")), "«время вышло» таймеру, созданному опоздавшим, не пишется");
    assert.ok((await timerRow(c6.body.promise.id)).remindersSent.includes(0));
    console.log("[promise] ok: таймер «уже опоздал» — сразу «опаздывает», без «время вышло», +15/+30 по расписанию");

    // перезапуск воркера: отложенные задачи лежат в Redis и выполняются новым воркером
    await worker.close();
    const g7 = await conv([R.id, V.id], "Перезапуск");
    const v7 = await send(V.token, g7.id, "2 мин");
    const { job: j7 } = await ask(R.token, g7.id, "Еблуша, засеки", { replyToId: v7.id });
    const c7 = await botCall("/api/bot/promises", { grant: j7.grant, promiserId: V.id, promiseMessageId: v7.id });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await timerRow(c7.body.promise.id)).remindersSent.length, 0, "без воркера напоминаний нет");
    assert.ok((await getCardsQueue().getDelayedCount()) + (await getCardsQueue().getWaitingCount()) > 0, "задачи ждут в Redis");
    worker = startCardsWorker();
    await waitFor("напоминание после перезапуска воркера", async () => ((await timerRow(c7.body.promise.id)).remindersSent.includes(0) ? true : null), 20_000);
    // sweep догоняет: потерянное напоминание (> 5 мин опоздания) — только отметка
    await prisma.promiseTimer.update({ where: { id: c7.body.promise.id }, data: { remindersSent: [0] } });
    const swept = await sweepPromises(new Date(Date.now() + 3 * 3600_000));
    assert.ok(swept.reminded === 0, "опоздавшие больше чем на 5 мин напоминания sweep не шлёт");
    console.log("[promise] ok: перезапуск воркера — отложенные задачи из Redis выполняются; sweep не шлёт сильно опоздавшее");

    process.env.CARDS_TEST_TIME_SCALE = "1";
    // ---------- удаления и выход ----------
    const g8 = await conv([R.id, V.id, P.id], "Удаления");
    const v8 = await send(V.token, g8.id, "20 минут");
    const { job: j8 } = await ask(R.token, g8.id, "Еблуша, засеки", { replyToId: v8.id });
    const c8 = await botCall("/api/bot/promises", { grant: j8.grant, promiserId: V.id, promiseMessageId: v8.id });
    assert.equal((await call("POST", "/api/messages/delete", V.token, { messageId: v8.id })).status, 200);
    await waitFor("цитата убрана", async () => ((await timerRow(c8.body.promise.id)).quote === null ? true : null));
    const { card: c8card, m: c8m } = await cardOf(c8.body.cardMessageId);
    assert.equal(c8card.data.quote.deleted, true);
    assert.match(c8m.content!, /\(сообщение удалено\)/);
    assert.equal((await timerRow(c8.body.promise.id)).status, "RUNNING", "таймер идёт и без слов");
    assert.equal((await call("POST", "/api/messages/delete", R.token, { messageId: c8.body.cardMessageId })).status, 200, "спросивший удаляет карточку");
    await waitFor("карточка удалена → отменён", async () => ((await timerRow(c8.body.promise.id)).status === "CANCELLED" ? true : null));
    assert.equal((await timerRow(c8.body.promise.id)).closeReason, "card_deleted");
    // обещавший вышел из беседы
    const v8b = await send(V.token, g8.id, "через 30 минут");
    const { job: j8b } = await ask(R.token, g8.id, "Еблуша, засеки", { replyToId: v8b.id });
    const c8b = await botCall("/api/bot/promises", { grant: j8b.grant, promiserId: V.id, promiseMessageId: v8b.id });
    assert.equal((await call("DELETE", `/api/conversations/${g8.id}/participants/me`, V.token)).status, 200);
    await waitFor("обещавший вышел → отменён", async () => ((await timerRow(c8b.body.promise.id)).status === "CANCELLED" ? true : null));
    assert.equal((await timerRow(c8b.body.promise.id)).closeReason, "promiser_left");
    console.log("[promise] ok: удалили обещание — цитата убрана; удалили карточку — отменён; обещавший вышел — отменён");

    // ---------- пределы и ошибки разбора ----------
    const g9 = await conv([R.id, V.id, P.id, O.id], "Пределы");
    // Рома за сутки уже поставил 9 таймеров (выше): десятый — можно, одиннадцатый — предел на спросившего
    const g9x = await conv([R.id, V.id, O.id], "Пределы Ромы");
    const g9r = await send(V.token, g9x.id, "через 39 минут");
    const { job: j9r } = await ask(R.token, g9x.id, "Еблуша, засеки", { replyToId: g9r.id });
    assert.equal((await botCall("/api/bot/promises", { grant: j9r.grant, promiserId: V.id, promiseMessageId: g9r.id })).status, 201);
    const g9o = await send(O.token, g9x.id, "через 38 минут");
    const { job: j9o } = await ask(R.token, g9x.id, "Еблуша, засеки", { replyToId: g9o.id });
    const perDay = await botCall("/api/bot/promises", { grant: j9o.grant, promiserId: O.id, promiseMessageId: g9o.id });
    assert.equal(perDay.status, 409, JSON.stringify(perDay.body));
    assert.equal(perDay.body.code, "PROMISE_LIMIT");
    assert.equal(perDay.body.scope, "requester");
    const mkTimer = async (who: { id: string; token: string }, text: string) => {
      const pm = await send(who.token, g9.id, text);
      const { job } = await ask(P.token, g9.id, "Еблуша, засеки", { replyToId: pm.id });
      return botCall("/api/bot/promises", { grant: job.grant, promiserId: who.id, promiseMessageId: pm.id });
    };
    const t9a = await mkTimer(V, "через 40 минут");
    assert.equal(t9a.status, 201, JSON.stringify(t9a.body));
    assert.equal((await mkTimer(R, "через 41 минуту")).status, 201);
    assert.equal((await mkTimer(O, "через 42 минуты")).status, 201);
    const fourth = await mkTimer(P, "через 43 минуты");
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.code, "PROMISE_LIMIT");
    assert.equal(fourth.body.scope, "conversation");
    const { job: je } = await ask(R.token, g9.id, "Еблуша, засеки");
    const noTime = await botCall("/api/bot/promises", { grant: je.grant, promiserId: R.id, text: "как смогу", dryRun: true });
    assert.equal(noTime.body.code, "PROMISE_NO_TIME");
    const tooFar = await botCall("/api/bot/promises", { grant: je.grant, promiserId: R.id, text: "послезавтра в 2", dryRun: true });
    assert.equal(tooFar.body.code, "PROMISE_TOO_FAR");
    // двусмысленное: подбираем час, ближайшее будущее которого дальше 8 ч от «сейчас»
    let ambHour = 0;
    for (let h = 1; h <= 12 && !ambHour; h++) {
      const r = resolveDeadline({ kind: "at", hour: h, minute: 0, half: "unknown", day: "nearest" }, { base: new Date(), zone: "Europe/Moscow", now: new Date() });
      if (!r.ok && r.code === "AMBIGUOUS") ambHour = h;
    }
    const amb = await botCall("/api/bot/promises", { grant: je.grant, promiserId: R.id, spec: { kind: "at", hour: ambHour, minute: 0, half: "unknown", day: "nearest" }, dryRun: true });
    assert.equal(amb.body.code, "PROMISE_AMBIGUOUS", `час ${ambHour}`);
    assert.ok(amb.body.deadlineAt && amb.body.label);
    const ambOk = await botCall("/api/bot/promises", { grant: je.grant, promiserId: R.id, spec: { kind: "at", hour: ambHour, minute: 0, half: "unknown", day: "nearest" }, confirmAmbiguous: true, dryRun: true });
    assert.equal(ambOk.status, 200);
    assert.equal(ambOk.body.promise.deadlineAt, amb.body.deadlineAt, "«да» — то самое ближайшее время");
    const named = await botCall("/api/bot/promises", { grant: je.grant, promiserName: "Козёл", text: "к 9 вечера", dryRun: true });
    assert.equal(named.status, 200, "участник по имени");
    assert.equal((await botCall("/api/bot/promises", { grant: je.grant, promiserName: "Никто Такой", text: "через 5 минут", dryRun: true })).body.code, "PROMISE_NAME_UNKNOWN");
    assert.equal((await botCall("/api/bot/promises", { grant: je.grant, promiserId: X.id, text: "через 5 минут", dryRun: true })).body.code, "PROMISE_NOT_PARTICIPANT");
    console.log("[promise] ok: пределы (3 на беседу), нет времени / слишком далеко / двусмысленно (+ «да»), имя участника");

    // ---------- пунктуальность ----------
    const { job: js } = await ask(R.token, g1.id, "Еблуша, как у Васи с пунктуальностью?");
    const stats = await botCall("/api/bot/promises/stats", { grant: js.grant, userId: V.id });
    assert.equal(stats.status, 200);
    assert.ok(stats.body.stats.onTime + stats.body.stats.late >= 3, JSON.stringify(stats.body.stats));
    assert.ok(stats.body.stats.unresolved >= 1);
    assert.equal(stats.body.stats.displayName, "Козёл Ебаный");
    const byName = await botCall("/api/bot/promises/stats", { grant: js.grant, name: "Козёл Ебаный" });
    assert.equal(byName.body.stats.userId, V.id);
    const board = await botCall("/api/bot/promises/stats", { grant: js.grant, board: true });
    assert.ok(board.body.board.some((s: any) => s.userId === V.id));
    // чужой — нет общих бесед со спрашивающим
    const gx = await conv([X.id, P.id], "Чужая");
    const { job: jxs } = await ask(X.token, gx.id, "Еблуша, как у Васи?");
    assert.equal((await botCall("/api/bot/promises/stats", { grant: jxs.grant, userId: V.id })).status, 404);
    console.log("[promise] ok: пунктуальность — по общим беседам, по имени, таблица; чужим — 404");

    // ---------- выключатель ----------
    process.env.PROMISE_TIMERS = "off";
    const off = await botCall("/api/bot/promises/candidates", { grant: js.grant });
    assert.equal(off.status, 404);
    assert.equal(off.body.code, "PROMISE_DISABLED");
    const runningCard = (await prisma.promiseTimer.findFirstOrThrow({ where: { conversationId: g9.id, status: "RUNNING" } })).cardMessageId!;
    assert.equal((await call("POST", `/api/cards/${runningCard}/act`, P.token, { action: "arrived" })).status, 200, "закрыть идущие можно и выключенным");
    delete process.env.PROMISE_TIMERS;
    console.log("[promise] ok: PROMISE_TIMERS=off — бот получает 404, кнопки работают");
    await queue.drain(true);

    // =====================================================================================
    // Часть 2. С ботом
    // =====================================================================================
    const llm = new ScriptedLlm();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-promise-"));
    let online: Array<{ name: string; since: number | null }> = [];
    const vh: BotModule = { name: "it_vh", characters: { listKnownCharacters: async () => ["IiApaCiOxa", "РомаH"], online: async () => online } };
    const botEnv = loadConfig({
      BOT_API_URL: baseUrl,
      BOT_REDIS_URL: env.REDIS_URL,
      BOT_USERNAME: `${RUN}_bot`,
      BOT_PASSWORD: botPassword,
      BOT_OWNER_USER_ID: O.id,
      BOT_DATA_DIR: dataDir,
      BOT_USER_DAILY_QUESTIONS: "1000",
      BOT_DEEP: "off",
    } as NodeJS.ProcessEnv);
    const log = createLogger("debug", { svc: "eblusha-bot-promise" }, (l) => logLines.push(l));
    const start = () => startBot(botEnv, log, { llm, extraModules: [vh], assetsDir: path.resolve(__dirname, "../bot/assets") });
    handle = await start();
    const R2 = await mk("roma2", "Рома");
    const botMsgs = (convId: string) => prisma.message.findMany({ where: { conversationId: convId, senderId: botId, deletedAt: null }, orderBy: { createdAt: "asc" } });
    const reactionOn = (msgId: string) => waitFor(`👍 на ${msgId}`, () => prisma.messageReaction.findFirst({ where: { messageId: msgId, userId: botId, emoji: "👍" } }));
    const timerIn = (convId: string, status: "RUNNING" | "ARRIVED" | "CANCELLED" = "RUNNING") =>
      waitFor(`таймер ${status} в ${convId}`, () => prisma.promiseTimer.findFirst({ where: { conversationId: convId, status }, orderBy: { createdAt: "desc" } }));

    const b1 = await conv([R2.id, V.id, P.id, O.id], "Бот");
    // а. «проконтролируй» ответом
    const bv = await send(V.token, b1.id, "буду через 2 минуты");
    const bt = await send(R2.token, b1.id, "Еблуша, проконтролируй", { replyToId: bv.id });
    const bTimer = await timerIn(b1.id);
    assert.equal(bTimer.promiseMessageId, bv.id);
    assert.equal(bTimer.triggerMessageId, bt.id);
    assert.equal((await botMsgs(b1.id)).length, 1, "бот ничего не пишет — карточка и есть ответ");
    // б. «ещё 10 минут» ответом на карточку — 👍
    const ext10 = await send(V.token, b1.id, "ещё 10 минут", { replyToId: bTimer.cardMessageId! });
    await reactionOn(ext10.id);
    const bExt = await prisma.promiseTimer.findUniqueOrThrow({ where: { id: bTimer.id } });
    assert.equal(bExt.extensionCount, 1);
    // чужое «ещё 10 минут» — вежливый отказ
    const extP2 = await send(P.token, b1.id, "ещё 10 минут", { replyToId: bTimer.cardMessageId! });
    const refuse = await waitFor("отказ продлить", () => prisma.message.findFirst({ where: { senderId: botId, replyToId: extP2.id } }));
    assert.match(refuse.content!, /Продлить может только сам \*\*Козёл Ебаный\*\*/);
    // в. «он тут» — единственный таймер в беседе
    const here2 = await send(P.token, b1.id, "Еблуша, он тут");
    await reactionOn(here2.id);
    const bArr = await prisma.promiseTimer.findUniqueOrThrow({ where: { id: bTimer.id } });
    assert.equal(bArr.status, "ARRIVED");
    assert.equal(bArr.arrivedVia, "phrase");
    assert.equal(bArr.arrivedById, P.id);
    console.log("[promise] ok: бот — «проконтролируй» ответом, «ещё 10 минут» (👍, чужому — отказ), «он тут»");

    // г. «кого контролируем?» → перезапуск бота → «2»
    const b2 = await conv([R2.id, V.id, P.id], "Бот кандидаты");
    await send(V.token, b2.id, "буду через 15 минут");
    await send(P.token, b2.id, "я через полчаса");
    const who = await send(R2.token, b2.id, "Еблуша, проконтролируй");
    const q = await waitFor("«Кого контролируем?»", () => prisma.message.findFirst({ where: { senderId: botId, replyToId: who.id } }));
    assert.match(q.content!, /^Кого контролируем\?\n1\. \*\*Петя\*\*: «я через полчаса»\n2\. \*\*Козёл Ебаный\*\*: «буду через 15 минут»/);
    await handle.stop();
    handle = await start();
    await send(R2.token, b2.id, "2", { replyToId: q.id });
    const bChosen = await timerIn(b2.id);
    assert.equal(bChosen.promiserId, V.id, "ожидание пережило перезапуск бота");
    console.log("[promise] ok: несколько обещавших — «Кого контролируем?», ответ «2» после перезапуска бота");

    // д. о себе
    const b3 = await conv([R2.id, P.id], "Бот о себе");
    await send(R2.token, b3.id, "Еблуша, засеки 15 минут");
    const self = await timerIn(b3.id);
    assert.equal(self.promiserId, R2.id);
    assert.equal(self.label, "15 мин");
    // е. запасной разбор моделью
    llm.auxPlan = () => JSON.stringify({ kind: "in", minutes: 40, maxMinutes: 40, hour: 0, minute: 0, half: "unknown", day: "nearest", reason: "no_time" });
    const vGame = await send(P.token, b3.id, "буду минут через 20 после игры");
    await send(R2.token, b3.id, "Еблуша, следи", { replyToId: vGame.id });
    const bModel = await waitFor("таймер по разбору модели", () => prisma.promiseTimer.findFirst({ where: { conversationId: b3.id, promiserId: P.id } }));
    assert.equal(bModel.parseSource, "model");
    assert.equal(bModel.deadlineAt.getTime(), bModel.startAt.getTime() + 40 * 60_000);
    assert.ok(llm.auxCalls.some((c) => c.schema), "строгая схема ответа модели");
    // ж. «проследи, чтобы Петя…» — инструментом модели (текст модели не публикуется)
    const b4 = await conv([R2.id, V.id, P.id], "Бот модель");
    llm.plan = async (req) => {
      await req.tools.run("promise_timer", { who: "named", name: "Петя", time_text: "к 9 вечера" });
      return "Готово, засёк!";
    };
    const said = await send(R2.token, b4.id, "Еблуша, проследи, чтобы Петя был к 9 вечера");
    const bNamed = await timerIn(b4.id);
    assert.equal(bNamed.promiserId, P.id);
    assert.equal(bNamed.quoteById, R2.id, "слова спросившего — «со слов Ромы»");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!(await prisma.message.findFirst({ where: { senderId: botId, content: "Готово, засёк!" } })), "текст модели после карточки не публикуется");
    assert.ok(said.id);
    // з. «отмени» ответом на карточку
    const cancelMsg = await send(R2.token, b4.id, "Еблуша, отмени", { replyToId: bNamed.cardMessageId! });
    await reactionOn(cancelMsg.id);
    assert.equal((await prisma.promiseTimer.findUniqueOrThrow({ where: { id: bNamed.id } })).status, "CANCELLED");
    llm.plan = async () => "ОтветМодели";
    // и. пунктуальность шаблоном
    const pq = await send(R2.token, b1.id, "Еблуша, как у Козёл Ебаный с пунктуальностью?");
    const pa3 = await waitFor("ответ о пунктуальности", () => prisma.message.findFirst({ where: { senderId: botId, replyToId: pq.id } }));
    assert.match(pa3.content!, /\*\*Козёл Ебаный\*\*: \d+ обещани/);
    assert.match(pa3.content!, /вовремя \d+ из \d+/);
    console.log("[promise] ok: о себе, запасной разбор моделью, «проследи, чтобы Петя…» инструментом, «отмени», пунктуальность");

    // к. Valheim: вход привязанного персонажа после обещания
    const db = new DatabaseSync(path.join(dataDir, "bot.sqlite"));
    db.prepare("INSERT INTO char_links (character, user_id, linked_by, verified, linked_at) VALUES (?, ?, ?, 1, ?)").run("IiApaCiOxa", V.id, O.id, Date.now());
    db.close();
    const b5 = await conv([R2.id, V.id], "Бот Valheim");
    const vv = await send(V.token, b5.id, "через 15 минут в игре");
    // уже в игре с момента после обещания — засекать нечего
    online = [{ name: "IiApaCiOxa", since: Date.now() + 1000 }];
    const vq = await send(R2.token, b5.id, "Еблуша, проконтролируй", { replyToId: vv.id });
    const already = await waitFor("«уже в Valheim»", () => prisma.message.findFirst({ where: { senderId: botId, replyToId: vq.id } }));
    assert.match(already.content!, /уже в Valheim — засекать нечего/);
    online = [{ name: "IiApaCiOxa", since: Date.now() - 3600_000 }]; // в игре с давних пор — не мешает
    await send(R2.token, b5.id, "Еблуша, проконтролируй", { replyToId: vv.id });
    const vt = await timerIn(b5.id);
    const core = handle.bot.coreServices();
    const watch1 = new PromiseWatch(core, async () => online, { activeEveryMs: 0 });
    assert.equal(await watch1.tick(), 0, "в игре раньше обещания — не считается");
    // «перезапуск бота»: новый наблюдатель, вход после обещания — по since
    const joined = Date.now();
    online = [{ name: "IiApaCiOxa", since: joined }];
    const watch2 = new PromiseWatch(core, async () => online, { activeEveryMs: 0 });
    assert.ok((await watch2.tick()) >= 1, "вход засчитан (всем идущим таймерам этого человека)");
    const vArr = await prisma.promiseTimer.findUniqueOrThrow({ where: { id: vt.id } });
    assert.equal(vArr.status, "ARRIVED");
    assert.equal(vArr.arrivedVia, "valheim");
    assert.equal(vArr.arrivedDetail, "IiApaCiOxa");
    assert.equal(vArr.arrivedAt!.getTime(), joined);
    console.log("[promise] ok: Valheim — «уже в игре», до обещания не считается, вход после — по since (и после перезапуска)");

    // журнал без текстов
    for (const w of ["буду через 2 минуты", "через полчаса", "после игры"]) assert.ok(!logLines.some((l) => l.includes(w)), `в журнале бота нет «${w}»`);
    assert.ok(logLines.some((l) => l.includes('"evt":"promise.created"')));

    const proof = { run: RUN, userIds: [botId, ...userIds], usernames: [`${RUN}_bot`, ...usernames], deviceIds: [`${RUN}-nodevice`], threadId: g1.id, msgId: crypto.randomUUID(), redisKeys: [proofKey] };
    console.log(`EB_PROOF ${JSON.stringify(proof)}`);
  } catch (e) {
    console.error("[promise] журнал бота (последние 40 строк):\n" + logLines.slice(-40).join("\n"));
    throw e;
  } finally {
    (env as { BOT_OWNER_USER_ID?: string | undefined }).BOT_OWNER_USER_ID = ownerBefore;
    for (const s of sockets) s.disconnect();
    await handle?.stop().catch(() => undefined);
    await worker.close().catch(() => undefined);
    await getBotQueue().drain(true).catch(() => undefined);
    await getCardsQueue().obliterate({ force: true }).catch(() => undefined);
    if (botId) await prisma.user.update({ where: { id: botId }, data: { isBot: false, deletedAt: new Date() } }).catch(() => undefined);
    io.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().then(
  async () => {
    console.log("promise timer integration: ok");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (err) => {
    console.error("promise timer integration: FAILED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
