/**
 * Бот «Еблуша»: контекст без цитирования и привязка персонажей владельцем (решения владельца 2026-10-10).
 * Настоящий backend (app + Socket.IO в процессе, тестовые Postgres/Redis изолированной среды) и настоящий
 * сервис бота (bot/src/main.ts startBot) с поддельной моделью — без сети и без денег.
 *
 *   test/secret-env/secret-test.sh run test/bot-context.integration.test.ts
 *
 * Часть 1 — сервер без бота (задачи читаем прямо из BullMQ):
 *   - задача rev 2: в обычной беседе history "recent" — ТОЛЬКО обращения к боту и его ответы за 30 минут
 *     (без болтовни людей, удалённых, истёкших, системных, ответов на удалённое; с обращением к позднему
 *     отчёту); в «Чате с Еблушей» — "botchat" без приветствия; старый бот (замороженный разбор rev 1)
 *     и новый разбирают её;
 *   - POST /api/bot/people: только бот, только по живому обычному разрешению, без логинов, лимит.
 * Часть 2 — с ботом: «Еблуша, а в Мельбурне?» понимается без цитирования; удалённое и старше 30 минут —
 *   не уходит; «Чат с Еблушей» — история чата; посторонняя переписка — нет.
 * Часть 3 — привязка: владелец «Парасюха — это Саня» (участник), «РомаH — это Ксенофонт» (среди всех),
 *   неоднозначность → варианты → уточнение, перепривязка (у кого забрали), отвязка; не владелец — отказ.
 * В конце — строка EB_PROOF для `secret-test.sh prod-proof`.
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { getBotQueue } from "../src/jobs/queue";
import { BOT_GRANT_MAX_LOOKUPS, resetSystemBotCache } from "../src/lib/systemBot";
import type { BotJob } from "../src/lib/botContract";
import { ensureBotUser } from "../src/scripts/seedBotUser";
import { loadConfig } from "../bot/src/config";
import { createLogger } from "../bot/src/log";
import { startBot } from "../bot/src/main";
import { ZERO_COST } from "../bot/src/core/budget";
import { parseBotJob } from "../bot/src/api/types";
import { parseBotJob as parseBotJobRev1 } from "../bot/test/unit/legacy/types-rev1";
import type { AnswerRequest, AnswerResult, LlmEngine } from "../bot/src/llm/types";
import type { BotModule } from "../bot/src/modules/api";

const RUN = `ebst_bx_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
/** Уникальная «фамилия» прогона кириллицей (тестовая БД общая для прогонов). */
const TAG = Array.from(crypto.randomBytes(5), (b) => "БВГДЖЗКЛМНПРСТФХЦЧШ"[b % 20]).join("");
const SECRET_WORDS = ["Ананас777", "погода в Сиднее", "вопрос-на-удаление", "кстати пароль"];
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

function unwrap(content: string): Record<string, any> {
  const m = /<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/.exec(content);
  return JSON.parse(m ? m[1]! : content) as Record<string, any>;
}

class ScriptedLlm implements LlmEngine {
  readonly model = "claude-opus-5-5";
  calls: AnswerRequest[] = [];
  toolResults: Array<Record<string, any>> = [];
  plan: (req: AnswerRequest) => Promise<string> = async () => "ОтветМодели";
  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.calls.push(req);
    const text = await this.plan(req);
    return { text, sources: [], cost: { ...ZERO_COST, usd: 0.01, inputTokens: 100, outputTokens: 10, models: [this.model] }, stop: "end_turn", servedBy: this.model };
  }
  async matchCharacter() {
    return { character: null, cost: ZERO_COST };
  }
  /** Модель «поняла» просьбу о привязке: зовёт character_link и пересказывает итог. */
  link(input: { action: "link" | "unlink"; character: string; person: string }) {
    this.plan = async (req) => {
      const r = await req.tools.run("character_link", input);
      const res = unwrap(r.content);
      this.toolResults.push(res);
      if (typeof res.say === "string") return res.say;
      const list = (res.candidates ?? res.known ?? res.participants ?? []) as string[];
      return `Уточни, пожалуйста: ${list.join("; ")}`;
    };
  }
}

async function main() {
  console.log(`[bot-ctx] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[bot-ctx] backends: ${JSON.stringify(identity)}`);
  const proofKey = `eb-bot-ctx:${RUN}`;
  await redis.set(proofKey, "1", { EX: 3600 });

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const queue = getBotQueue();
  await queue.drain(true);
  const jobOf = async (messageId: string) => waitFor(`задача ${messageId}`, async () => ((await queue.getJob(`msg-${messageId}`))?.data as BotJob | undefined) ?? null);

  const logLines: string[] = [];
  let handle: Awaited<ReturnType<typeof startBot>> | null = null;
  let botId = "";
  const userIds: string[] = [];
  const usernames: string[] = [];
  try {
    // ---------- учётки и беседы ----------
    await prisma.user.updateMany({ where: { isBot: true }, data: { isBot: false } });
    const botPassword = crypto.randomBytes(18).toString("base64url");
    const seeded = await ensureBotUser(prisma, { username: `${RUN}_bot`, password: botPassword, forcePassword: false });
    botId = seeded.id;
    resetSystemBotCache();
    const tok = (id: string) => signAccessToken({ sub: id, tokenId: crypto.randomUUID() });
    const botToken = tok(botId);
    const mk = async (suffix: string, displayName: string, withEblid = false) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const eblid = withEblid ? String(1000 + crypto.randomInt(9000)) : undefined;
          const u = await prisma.user.create({
            data: { username: `${RUN}_${suffix}`, displayName, passwordHash: `x_${crypto.randomUUID()}`, ...(eblid ? { eblid } : {}) },
          });
          userIds.push(u.id);
          usernames.push(u.username);
          return { ...u, token: tok(u.id) };
        } catch (e) {
          if (attempt > 20) throw e; // занятый EBLID — ещё раз
        }
      }
    };
    const A = await mk("alice", "Алиса");
    const B = await mk("bob", "Боб");
    const O = await mk("owner", "Стон");
    const S = await mk("sanya", "Саня", true);
    const K = await mk("kseno", `Ксенофонт ${TAG}`, true);
    const T1 = await mk("tikhon1", `Тихон ${TAG} Первый`, true);
    const T2 = await mk("tikhon2", `Тихон ${TAG} Второй`, true);
    const conv = (isGroup: boolean, ids: string[], title?: string) =>
      prisma.conversation.create({ data: { isGroup, ...(title ? { title } : {}), createdById: ids[0]!, participants: { create: ids.map((userId) => ({ userId })) } } });
    const send = async (token: string, conversationId: string, content: string, extra: Record<string, unknown> = {}) => {
      const r = await call("POST", "/api/conversations/send", token, { conversationId, type: "TEXT", content, ...extra });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.message as { id: string; createdAt: string };
    };

    // =====================================================================================
    // Часть 1. Сервер: что уходит в задачу (бота нет — задачи ждут в очереди)
    // =====================================================================================
    const g1 = await conv(true, [A.id, B.id, O.id], `${RUN} г1`);
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    const put = (data: Record<string, unknown>) => prisma.message.create({ data: { conversationId: g1.id, type: "TEXT", ...data } as any });
    const ans = (trigger: string) => ({ bot: { v: 1, kind: "answer", triggerMessageId: trigger, askerId: A.id } });
    const m0 = await put({ senderId: A.id, content: "Еблуша, давний вопрос с поздним отчётом", metadata: { botAsk: true }, createdAt: ago(50) });
    const m1 = await put({ senderId: A.id, content: "Еблуша, старый вопрос", metadata: { botAsk: true }, createdAt: ago(40) });
    await put({ senderId: botId, isBot: true, content: "старый ответ", metadata: ans(m1.id), createdAt: ago(39) });
    const m2 = await put({ senderId: A.id, content: "Еблуша, какая погода в Сиднее?", metadata: { botAsk: true }, createdAt: ago(10) });
    const b2 = await put({ senderId: botId, isBot: true, content: "В Сиднее +18.", metadata: ans(m2.id), createdAt: ago(9) });
    await put({ senderId: B.id, content: "кстати пароль Ананас777", createdAt: ago(8) });
    const m3 = await put({ senderId: B.id, content: "Еблуша, вопрос-на-удаление", metadata: { botAsk: true }, createdAt: ago(7), deletedAt: new Date() });
    await put({ senderId: botId, isBot: true, content: "ответ на удалённое", metadata: ans(m3.id), createdAt: ago(6) });
    await put({ senderId: A.id, content: "Еблуша, истёкший вопрос", metadata: { botAsk: true }, createdAt: ago(5), expiresAt: ago(1) });
    const b5 = await put({ senderId: botId, isBot: true, content: "поздний отчёт о давнем", metadata: ans(m0.id), createdAt: ago(4) });
    await put({ senderId: A.id, type: "SYSTEM", content: "звонок завершён", createdAt: ago(3) });

    const q1 = await send(B.token, g1.id, "Еблуша, а в Мельбурне?");
    const job1 = await jobOf(q1.id);
    assert.equal(job1.v, 1, "v не поднят: старый бот принимает");
    assert.equal(job1.rev, 2);
    assert.equal(job1.history?.mode, "recent");
    assert.equal(job1.history?.windowMs, 30 * 60_000);
    assert.deepEqual(
      job1.history?.messages.map((m) => m.id),
      [m0.id, m2.id, b2.id, b5.id],
      "только обращения и ответы бота за 30 мин; без болтовни, удалённого, ответа на удалённое, истёкшего, системного; давнее обращение — к позднему отчёту"
    );
    assert.deepEqual(job1.history?.messages.map((m) => [m.isBot, m.senderName]), [[false, "Алиса"], [false, "Алиса"], [true, "Еблуша"], [true, "Еблуша"]]);
    assert.ok(!JSON.stringify(job1).includes("Ананас777"), "посторонняя переписка в задачу не попадает");
    assert.ok(!JSON.stringify(job1).includes("вопрос-на-удаление") && !JSON.stringify(job1).includes("ответ на удалённое"));
    assert.deepEqual(job1.chain, []);
    console.log("[bot-ctx] ok: задача rev 2 — «recent»: свои разговоры за 30 мин, без чужой переписки, удалённого и истёкшего");

    const { rev: _rev, history: _history, ...asV1 } = job1;
    const legacy = parseBotJobRev1(job1);
    assert.ok(legacy, "старый бот (разбор rev 1) принимает задачу нового сервера");
    assert.deepEqual(legacy, parseBotJobRev1(asV1), "для старого бота — та же задача, что от старого сервера");
    const fresh = parseBotJob(job1)!;
    assert.equal(fresh.history?.messages.length, 4);
    assert.equal(parseBotJob(asV1)!.history, undefined, "новый бот со старым сервером — без истории");
    console.log("[bot-ctx] ok: совместимость контракта: старый бот ↔ новый сервер, новый бот ↔ старый сервер");

    // ---------- POST /api/bot/people ----------
    const grant = job1.grant;
    assert.equal((await call("POST", "/api/bot/people", A.token, { grant, query: "Саня" })).status, 403, "не бот — нельзя");
    assert.equal((await call("POST", "/api/bot/people", botToken, { grant: "x".repeat(32), query: "Саня" })).status, 410);
    assert.equal((await call("POST", "/api/bot/people", botToken, { grant, query: "Саня", junk: 1 })).status, 400);
    const p1 = await call("POST", "/api/bot/people", botToken, { grant, query: "Саня" });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.deepEqual(p1.body.participants.map((p: any) => p.id).sort(), [A.id, B.id, O.id].sort(), "участники беседы, без бота");
    assert.ok(p1.body.participants.every((p: any) => p.inConversation === true));
    const sRow = p1.body.matches.find((p: any) => p.id === S.id);
    assert.deepEqual(sRow, { id: S.id, displayName: "Саня", eblid: S.eblid, inConversation: false });
    assert.ok(!JSON.stringify(p1.body).includes(RUN), "логины (username) не отдаются");
    const p2 = await call("POST", "/api/bot/people", botToken, { grant, query: `Ксенофонту ${TAG}` });
    assert.ok(p2.body.matches.some((p: any) => p.id === K.id), "по основе слова в падеже");
    const p3 = await call("POST", "/api/bot/people", botToken, { grant, query: K.eblid });
    assert.deepEqual(p3.body.matches.map((p: any) => p.id), [K.id], "по EBLID");
    const p4 = await call("POST", "/api/bot/people", botToken, { grant, query: K.username });
    assert.deepEqual(p4.body.matches.map((p: any) => p.id), [K.id], "по точному логину (сам логин не возвращается)");
    const p5 = await call("POST", "/api/bot/people", botToken, { grant, ids: [S.id, K.id] });
    assert.deepEqual(p5.body.users.map((p: any) => p.displayName).sort(), ["Саня", `Ксенофонт ${TAG}`].sort());
    const fu = await call("POST", "/api/bot/followup", botToken, { grant });
    assert.equal(fu.status, 201);
    assert.equal((await call("POST", "/api/bot/people", botToken, { grant: fu.body.grant, query: "Саня" })).status, 400, "по продолжению — нет");
    let last = 0;
    for (let i = 0; i < BOT_GRANT_MAX_LOOKUPS; i++) last = (await call("POST", "/api/bot/people", botToken, { grant, query: "Боб" })).status;
    assert.equal(last, 429, "лимит поисков на обращение");
    console.log("[bot-ctx] ok: POST /api/bot/people — только бот, по живому разрешению, без логинов, с лимитом");

    // ---------- «Чат с Еблушей»: history "botchat" без приветствия ----------
    const onO = await call("PUT", "/api/bot/settings", O.token, { botChatEnabled: true });
    assert.equal(onO.status, 200);
    const chatO: string = onO.body.conversationId;
    const raz = await send(O.token, chatO, "раз");
    const jr = await jobOf(raz.id);
    assert.equal(jr.via, "botchat");
    assert.deepEqual(jr.history, { mode: "botchat", windowMs: null, messages: [] }, "приветствие бота в историю не идёт");
    const dva = await send(O.token, chatO, "два");
    const jd = await jobOf(dva.id);
    assert.deepEqual(jd.history?.messages.map((m) => m.id), [raz.id]);
    console.log("[bot-ctx] ok: «Чат с Еблушей» — history «botchat» (без приветствия, без триггера)");
    await queue.drain(true);

    // =====================================================================================
    // Часть 2. С ботом: контекст без цитирования
    // =====================================================================================
    const vh: BotModule = { name: "it_vh", characters: { listKnownCharacters: async () => ["IiApaCiOxa", "РомаH", "Куралеска"] } };
    const llm = new ScriptedLlm();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-bot-ctx-"));
    const cfg = loadConfig({
      BOT_API_URL: baseUrl,
      BOT_REDIS_URL: env.REDIS_URL,
      BOT_USERNAME: `${RUN}_bot`,
      BOT_PASSWORD: botPassword,
      BOT_OWNER_USER_ID: O.id,
      BOT_DATA_DIR: dataDir,
    } as NodeJS.ProcessEnv);
    const log = createLogger("debug", { svc: "eblusha-bot-ctx" }, (l) => logLines.push(l));
    handle = await startBot(cfg, log, { llm, extraModules: [vh], assetsDir: path.resolve(__dirname, "../bot/assets") });
    const h = handle;
    const botReplyTo = (msgId: string) => waitFor(`ответ бота на ${msgId}`, () => prisma.message.findFirst({ where: { senderId: botId, replyToId: msgId } }));
    const lastCall = () => llm.calls.at(-1)!;

    const g2 = await conv(true, [A.id, B.id, O.id], `${RUN} г2`);
    llm.plan = async (req) => (req.turns.at(-1)!.text.includes("Сидне") ? "В Сиднее +18." : req.turns.at(-1)!.text.includes("Мельбурн") ? "В Мельбурне +15." : "ОтветМодели");
    const s1 = await send(A.token, g2.id, "Еблуша, какая погода в Сиднее?");
    const s1a = await botReplyTo(s1.id);
    await send(B.token, g2.id, "кстати пароль Ананас777");
    const callsBefore = llm.calls.length;
    const s2 = await send(B.token, g2.id, "Еблуша, а в Мельбурне?");
    assert.equal((await botReplyTo(s2.id)).content, "В Мельбурне +15.");
    assert.equal(llm.calls.length, callsBefore + 1, "болтовня людей боту не уходила");
    assert.deepEqual(lastCall().turns, [
      { role: "user", text: "Алиса: какая погода в Сиднее?" },
      { role: "assistant", text: "В Сиднее +18." },
      { role: "user", text: "Боб: а в Мельбурне?" },
    ]);
    assert.equal(lastCall().cacheAt, 1);
    assert.match(lastCall().contextNote, /твои недавние разговоры в этой беседе/);
    assert.ok(!JSON.stringify(lastCall().turns).includes("Ананас777"));
    console.log("[bot-ctx] ok: «Еблуша, а в Мельбурне?» — без цитирования, с чужим вопросом и ответом; болтовни людей нет");

    llm.plan = async () => "ответ-на-удаление";
    const d1 = await send(A.token, g2.id, "Еблуша, вопрос-на-удаление");
    const d1a = await botReplyTo(d1.id);
    assert.equal(d1a.content, "ответ-на-удаление");
    assert.equal((await call("POST", "/api/messages/delete", A.token, { messageId: d1.id })).status, 200);
    llm.plan = async () => "ОтветМодели";
    const s3 = await send(B.token, g2.id, "Еблуша, ещё вопрос");
    await botReplyTo(s3.id);
    const t3 = JSON.stringify(lastCall().turns);
    assert.ok(!t3.includes("вопрос-на-удаление") && !t3.includes("ответ-на-удаление"), "удалённое обращение и ответ на него — не уходят");
    assert.ok(t3.includes("какая погода в Сиднее?"));
    // старше 30 минут — не уходит
    await prisma.message.updateMany({ where: { id: { in: [s1.id, s1a.id] } }, data: { createdAt: ago(31) } });
    const s4 = await send(B.token, g2.id, "Еблуша, и последний");
    await botReplyTo(s4.id);
    assert.ok(!JSON.stringify(lastCall().turns).includes("Сидне"), "старше 30 минут — не уходит");
    assert.ok(JSON.stringify(lastCall().turns).includes("ещё вопрос"));
    console.log("[bot-ctx] ok: удалённое и старше 30 минут — боту не уходят");

    const f1 = await send(O.token, chatO, "первый вопрос");
    await botReplyTo(f1.id);
    const f2 = await send(O.token, chatO, "второй вопрос");
    await botReplyTo(f2.id);
    assert.deepEqual(lastCall().turns, [
      { role: "user", text: "Стон: раз" },
      { role: "user", text: "Стон: два" },
      { role: "user", text: "Стон: первый вопрос" },
      { role: "assistant", text: "ОтветМодели" },
      { role: "user", text: "Стон: второй вопрос" },
    ]);
    assert.equal(lastCall().cacheAt, 3);
    assert.match(lastCall().contextNote, /недавняя история этого чата/);
    console.log("[bot-ctx] ok: «Чат с Еблушей» — разговор продолжается без ответа на сообщение");

    // =====================================================================================
    // Часть 3. Привязка персонажей владельцем свободной фразой
    // =====================================================================================
    const links = h.bot.coreServices().links;
    const g3 = await conv(true, [O.id, A.id, S.id], `${RUN} г3`);
    llm.link({ action: "link", character: "Парасюха", person: "Саня" });
    const l1 = await send(O.token, g3.id, "Еблуша, Парасюха — это Саня");
    assert.equal((await botReplyTo(l1.id)).content, "Привязал: Саня — **IiApaCiOxa** (Парасюха).");
    assert.deepEqual(links.charactersOf(S.id), ["IiApaCiOxa"]);
    console.log("[bot-ctx] ok: владелец в группе: «Парасюха — это Саня» → «Привязал: Саня — IiApaCiOxa (Парасюха)»");

    llm.link({ action: "link", character: "РомаH", person: `Ксенофонт ${TAG}` });
    const l2 = await send(O.token, chatO, `РомаH — это Ксенофонт ${TAG}`);
    assert.match((await botReplyTo(l2.id)).content ?? "", /^Привязал: Ксенофонт .+ — \*\*РомаH\*\* \(Роман\)\.$/);
    assert.deepEqual(links.charactersOf(K.id), ["РомаH"]);
    console.log("[bot-ctx] ok: владелец в своём чате: человек найден среди всех (не участник)");

    llm.link({ action: "link", character: "Куралеска", person: `Тихон ${TAG}` });
    const l3 = await send(O.token, chatO, `Куралеска — это Тихон ${TAG}`);
    const amb = (await botReplyTo(l3.id)).content ?? "";
    assert.equal(llm.toolResults.at(-1)!.result, "ambiguous_person");
    assert.ok(amb.includes(`Тихон ${TAG} Первый (EBLID ${T1.eblid})`) && amb.includes(`Тихон ${TAG} Второй (EBLID ${T2.eblid})`), amb);
    assert.equal(links.userOf("Куралеска"), null);
    llm.link({ action: "link", character: "Куралеска", person: T2.eblid! });
    const l4 = await send(O.token, chatO, `второй, ${T2.eblid}`);
    await botReplyTo(l4.id);
    assert.equal(links.userOf("Куралеска"), T2.id);
    // уточнение понято без цитирования: предыдущий вопрос с вариантами — в истории чата
    assert.ok(JSON.stringify(lastCall().turns).includes(`Тихон ${TAG} Первый`));
    console.log("[bot-ctx] ok: неоднозначно → варианты с EBLID → уточнение (без цитирования) → привязано");

    llm.link({ action: "link", character: "IiApaCiOxa", person: "Алиса" });
    const l5 = await send(O.token, g3.id, "Еблуша, IiApaCiOxa — это Алиса");
    assert.equal((await botReplyTo(l5.id)).content, "Привязал: Алиса — **IiApaCiOxa** (Парасюха). Раньше этот персонаж был за «Саня» — у него отвязал.");
    assert.deepEqual(links.charactersOf(S.id), []);
    llm.link({ action: "unlink", character: "Парасюху", person: "" });
    const l6 = await send(O.token, g3.id, "Еблуша, отвяжи Парасюху");
    assert.equal((await botReplyTo(l6.id)).content, "Отвязал: **IiApaCiOxa** (Парасюха) больше ни за кем не числится (был за «Алиса»).");
    assert.equal(links.userOf("IiApaCiOxa"), null);
    console.log("[bot-ctx] ok: перепривязка (у кого забрали) и отвязка");

    const peopleBefore = logLines.filter((l) => l.includes("link.people_failed")).length;
    llm.link({ action: "link", character: "РомаH", person: "Саня" });
    const l7 = await send(A.token, g3.id, "Еблуша, РомаH — это Саня");
    assert.match((await botReplyTo(l7.id)).content ?? "", /Других людей привязывает только владелец/);
    assert.equal(links.userOf("РомаH"), K.id, "не владелец чужое не перепривязал");
    assert.equal(logLines.filter((l) => l.includes("link.people_failed")).length, peopleBefore);
    console.log("[bot-ctx] ok: не владелец не может привязать другого (вежливый отказ)");

    // ---------- журнал без текста сообщений ----------
    for (const w of SECRET_WORDS) assert.ok(!logLines.some((l) => l.includes(w)), `в журнале бота нет «${w}»`);
    assert.ok(logLines.some((l) => l.includes('"evt":"answer.sent"') && l.includes('"hist":')), "в журнале — сколько истории ушло");
    console.log(`[bot-ctx] ok: журнал бота (${logLines.length} строк) без текста сообщений`);

    const proof = {
      run: RUN,
      userIds: [botId, ...userIds],
      usernames: [`${RUN}_bot`, ...usernames],
      deviceIds: [`${RUN}-nodevice`],
      threadId: g1.id,
      msgId: crypto.randomUUID(),
      redisKeys: [proofKey],
    };
    console.log(`EB_PROOF ${JSON.stringify(proof)}`);
  } catch (e) {
    console.error("[bot-ctx] журнал бота (последние 40 строк):\n" + logLines.slice(-40).join("\n"));
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
    console.log("bot context integration: ok");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (err) => {
    console.error("bot context integration: FAILED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
