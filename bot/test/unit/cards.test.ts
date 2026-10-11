/**
 * Карточки бота и «Подумай лучше» — юнит без сети (docs/bot-cards.md):
 *   - детерминированные формы (cardIntents): таймер, «забудь переписку», текстовый выбор, «подумай лучше»;
 *   - копия разбора времени (core/promiseTime.ts) на общих векторах сервера;
 *   - «поделиться»: цена вариантов, гашение, согласие в цепочке, кэш (уборка, стирание);
 *   - пунктуальность шаблоном; наблюдатель Valheim (since, до обещания — нет, без since — по переходу);
 *   - ClaudeEngine: другая модель и усилие верхним уровнем, без поиска, переписка перед цепочкой (точка кэша),
 *     endTurn инструмента, картинка в результате, жёсткий потолок, проба глубокой модели и её отказы.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { isDeepRequest, isShareForget, parsePromiseIntent, parseShareChoice, pickCandidate } from "../../src/core/cardIntents";
import { parsePromiseText, resolveDeadline } from "../../src/core/promiseTime";
import { estimateShareTokens, estimateShareUsd, ShareCache, shareInChain, shareOptions } from "../../src/core/share";
import { punctualityText } from "../../src/core/promises";
import { PromiseWatch } from "../../src/modules/valheim/promiseWatch";
import { ClaudeEngine, deepUnavailable, isToolTypeError, partialCostOf, turnsToMessages } from "../../src/llm/claude";
import { silentLogger } from "../../src/log";
import type { BotJob, ShareEstimate, ShareInfo, ShareMessage, SharePeriod } from "../../src/api/types";
import type { ShareApi } from "../../src/api/eblusha";
import type { CoreServices } from "../../src/modules/api";
import { ALICE, BOB, GROUP, harness, msg } from "./fakes";

// ───────────────────────────── формы ─────────────────────────────

test("«подумай лучше» и похожие — да; прочее — нет", () => {
  for (const t of ["подумай лучше", "Подумай лучше!", "подумай ещё", "подумай еще раз", "подумай как следует", "глубже", "ну подумай получше", "подумай-ка хорошенько", "подумай лучше 🧠"]) {
    assert.ok(isDeepRequest(t), t);
  }
  for (const t of ["подумай о погоде", "лучше бы ты подумал", "что думаешь", "подумай лучше о том, как пройти босса"]) assert.ok(!isDeepRequest(t), t);
});

test("«забудь переписку» и текстовый выбор на карточке", () => {
  for (const t of ["забудь переписку", "Забудь чат!", "не читай переписку", "хватит читать", "сотри нашу переписку"]) assert.ok(isShareForget(t), t);
  assert.ok(!isShareForget("забудь"));
  assert.deepEqual(parseShareChoice("сегодня"), { decline: false, period: "today", photos: false });
  assert.deepEqual(parseShareChoice("за неделю с фото"), { decline: false, period: "week", photos: true });
  assert.deepEqual(parseShareChoice("Всё время + фото"), { decline: false, period: "all", photos: true });
  assert.deepEqual(parseShareChoice("да, за сегодня"), { decline: false, period: "today", photos: false });
  assert.deepEqual(parseShareChoice("не надо"), { decline: true });
  assert.deepEqual(parseShareChoice("нет"), { decline: true });
  assert.equal(parseShareChoice("а это что?"), null);
});

test("таймер: формы намерений", () => {
  assert.deepEqual(parsePromiseIntent("проконтролируй"), { kind: "set", rest: "" });
  assert.deepEqual(parsePromiseIntent("засеки его, пожалуйста"), { kind: "set", rest: "" });
  assert.deepEqual(parsePromiseIntent("время пошло!"), { kind: "set", rest: "" });
  assert.deepEqual(parsePromiseIntent("засеки 15 минут"), { kind: "set", rest: "15 минут" });
  assert.deepEqual(parsePromiseIntent("я буду через 15 минут, засеки"), { kind: "set", rest: "я буду через 15 минут" });
  assert.deepEqual(parsePromiseIntent("я в 21:30, проконтролируй"), { kind: "set", rest: "я в 21:30" });
  assert.equal(parsePromiseIntent("проследи, чтобы Вася был к девяти"), null, "про другого — модель");
  assert.deepEqual(parsePromiseIntent("запомни"), { kind: "remember" });
  assert.deepEqual(parsePromiseIntent("он тут"), { kind: "arrived", self: false });
  assert.deepEqual(parsePromiseIntent("я тут"), { kind: "arrived", self: true });
  assert.deepEqual(parsePromiseIntent("всё, пришёл"), { kind: "arrived", self: false });
  assert.deepEqual(parsePromiseIntent("стоп"), { kind: "arrived", self: false });
  assert.deepEqual(parsePromiseIntent("ещё 10 минут"), { kind: "extend", text: "еще 10 минут" });
  assert.deepEqual(parsePromiseIntent("+10"), { kind: "extend", text: "+10" });
  assert.deepEqual(parsePromiseIntent("дай ещё 5"), { kind: "extend", text: "дай еще 5" });
  assert.deepEqual(parsePromiseIntent("буду в 15:00"), { kind: "extend", text: "буду в 15:00" });
  assert.equal(parsePromiseIntent("ещё вопрос"), null);
  assert.deepEqual(parsePromiseIntent("отмени таймер"), { kind: "cancel" });
  assert.deepEqual(parsePromiseIntent("отбой"), { kind: "cancel" });
  assert.deepEqual(parsePromiseIntent("как у Васи с пунктуальностью?"), { kind: "punctuality", name: "васи", self: false });
  assert.deepEqual(parsePromiseIntent("Вася часто опаздывает?"), { kind: "punctuality", name: "вася", self: false });
  assert.deepEqual(parsePromiseIntent("как у меня с пунктуальностью"), { kind: "punctuality", name: null, self: true });
  assert.deepEqual(parsePromiseIntent("кто у нас самый пунктуальный?"), { kind: "board" });
  assert.equal(parsePromiseIntent("какая погода в Сиднее?"), null);
  assert.equal(pickCandidate("2", ["Петя", "Вася"]), 1);
  assert.equal(pickCandidate("вася", ["Петя", "Козёл Ебаный", "Вася"]), 2);
  assert.equal(pickCandidate("первого", ["Петя", "Вася"]), 0);
  assert.equal(pickCandidate("кто-нибудь", ["Петя", "Вася"]), null);
});

test("копия разбора времени совпадает с сервером на общих векторах", () => {
  const file = path.resolve(__dirname, "../../../../test/fixtures/promise-time-vectors.json");
  if (!fs.existsSync(file)) {
    console.log("векторы сервера не найдены (сборка бота отдельно) — пропуск");
    return;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { cases: Array<{ text: string; base: string; now?: string; zone: string; expect: Record<string, unknown> }> };
  let n = 0;
  for (const v of data.cases) {
    const r = resolveDeadline(parsePromiseText(v.text).spec, { base: new Date(v.base), zone: v.zone, now: new Date(v.now ?? v.base) });
    if (v.expect.error) assert.ok(!r.ok && r.code === v.expect.error, v.text);
    else assert.ok(r.ok && r.deadlineAt.toISOString() === v.expect.deadlineAt && r.label === v.expect.label, `${v.text}: ${JSON.stringify(r)}`);
    n++;
  }
  assert.ok(n >= 80);
});

// ───────────────────────────── «поделиться» ─────────────────────────────

test("цена вариантов и гашение: слишком много / лимит / пусто", () => {
  const cfg = { shareDirectTokens: 100_000, shareMaxTokens: 1_500_000, shareMaxUsd: 1, shareMaxPhotos: 60 };
  assert.equal(estimateShareTokens({ chars: 2299, messages: 10, botMessages: 0, photos: 3 }, true, 60), 1000 + 120 + 120);
  assert.ok(Math.abs(estimateShareUsd(40_000, 0, cfg) - 0.2) < 1e-9, "40 тыс. токенов прямо ≈ $0.20");
  assert.ok(estimateShareUsd(1_000_000, 0, cfg) < 0.35, "1 млн токенов кусками ≈ $0.35");
  const est: ShareEstimate = {
    conversationKind: "group",
    zone: "Europe/Moscow",
    periods: [
      { period: "today", from: null, messages: 34, botMessages: 2, chars: 1530, photos: 3 },
      { period: "week", from: null, messages: 0, botMessages: 0, chars: 0, photos: 0 },
      { period: "all", from: null, messages: 2_000_000, botMessages: 0, chars: 90_000_000, photos: 337 },
    ],
    active: null,
    declinedAt: null,
  };
  const o = shareOptions(est, cfg, 5);
  assert.deepEqual(o.today, { enabled: true, off: null });
  assert.deepEqual(o.week, { enabled: false, off: null });
  assert.deepEqual(o.all, { enabled: false, off: "too_big" });
  assert.deepEqual(shareOptions(est, cfg, 0.000001).today, { enabled: false, off: "budget" });
});

test("согласие в цепочке: ответ по согласию или выданная карточка", () => {
  const base = { senderId: "b", senderName: "Еблуша", type: "TEXT" as const, content: "x", createdAt: "2026-10-11T00:00:00Z", replyToId: null, attachments: [] };
  const job = (chain: BotJob["chain"]) => ({ chain }) as unknown as BotJob;
  assert.equal(shareInChain(job([{ ...base, id: "a", isBot: true, bot: { kind: "answer", shareId: "s1" } }])), "s1");
  assert.equal(shareInChain(job([{ ...base, id: "c", isBot: true, bot: { kind: "card", card: { type: "share", id: "s2", state: "granted" } } }])), "s2");
  assert.equal(shareInChain(job([{ ...base, id: "c", isBot: true, bot: { kind: "card", card: { type: "share", id: "s3", state: "pending" } } }])), null);
  assert.equal(shareInChain(job([{ ...base, id: "h", isBot: false }])), null);
});

test("кэш переписки: конец окна, стирание по сигналу и по беседе, предел памяти", () => {
  let now = 1000;
  const c = new ShareCache(() => now);
  c.open("s1", "c1", 5000);
  c.open("s2", "c1", 9000);
  c.open("s3", "c2", 9000);
  assert.equal(c.size(), 3);
  now = 6000;
  assert.equal(c.get("s1"), null, "окно закончилось — нет");
  assert.ok(c.evict("s3"));
  assert.equal(c.evictConversation("c1"), 1);
  assert.equal(c.size(), 0);
  const big = c.open("b1", "c3", 99_000);
  big.bytes = 150 * 1024 * 1024;
  now = 6001;
  const big2 = c.open("b2", "c3", 99_000);
  big2.bytes = 150 * 1024 * 1024;
  c.trim();
  assert.equal(c.size(), 1, "давно не нужное вытеснено");
  assert.ok(c.get("b2"));
  // Новый выбор того же согласия (после «слишком много» — период поменьше): прочитанное раньше не годится.
  const a = c.open("r1", "c4", 99_000, "all||0");
  a.messages.set("m1", { id: "m1" } as never);
  a.cursor = { at: "2026-10-11T10:00:00.000Z", id: "m1" };
  assert.equal(c.open("r1", "c4", 99_000, "all||0").messages.size, 1, "те же условия — тот же кэш (уточнения)");
  const b = c.open("r1", "c4", 99_000, "today|2026-10-11T02:00:00.000Z|0");
  assert.equal(b.messages.size, 0);
  assert.equal(b.cursor, null, "читать с начала нового периода");
});

// ───────────────────────────── пунктуальность, Valheim ─────────────────────────────

test("пунктуальность шаблоном", () => {
  const t = punctualityText(
    {
      userId: "v",
      displayName: "Козёл Ебаный",
      total: 12,
      onTime: 3,
      late: 8,
      unresolved: 1,
      cancelled: 1,
      onTimeRate: 0.27,
      avgDeltaSec: 840,
      avgLateSec: 840,
      medianDeltaSec: 600,
      worst: { deltaSec: 4320, at: "2026-10-03T12:00:00Z" },
      best: { deltaSec: -240, at: "2026-10-05T12:00:00Z" },
      extensions: 9,
      timersExtended: 5,
      streakOnTime: 0,
    },
    "Europe/Moscow"
  );
  assert.equal(t, "**Козёл Ебаный**: 12 обещаний — вовремя 3 из 11 (27 %). В среднем опаздывает на 14 мин, рекорд — 1 ч 12 мин (3 окт.). Продлевал 9 раз. Лучшее: пришёл за 4 мин до срока. Не отмечено: 1.");
  assert.equal(punctualityText({ userId: "v", displayName: "Вася", total: 0, onTime: 0, late: 0, unresolved: 0, cancelled: 0, onTimeRate: null, avgDeltaSec: null, avgLateSec: null, medianDeltaSec: null, worst: null, best: null, extensions: 0, timersExtended: 0, streakOnTime: 0 }, "Europe/Moscow"), "Пока ни одного таймера на **Вася**.");
});

test("Valheim: вход после обещания (since) — пришёл; раньше — нет; без since — по переходу между опросами", async () => {
  let now = Date.parse("2026-10-11T12:00:00Z");
  const marked: Array<{ id: string; at: string; detail: string }> = [];
  const timers = [{ id: "p1", conversationId: "c", promiserId: "vasya", startAt: "2026-10-11T11:50:00Z", deadlineAt: "2026-10-11T12:05:00Z" }];
  const core = {
    log: silentLogger,
    links: { charactersOf: (u: string) => (u === "vasya" ? ["IiApaCiOxa"] : []), userOf: () => null, all: () => [] },
    promises: {
      active: async () => timers,
      arrived: async (id: string, o: { at: string; detail: string }) => {
        marked.push({ id, ...o });
        return true;
      },
    },
  } as unknown as CoreServices;
  let online: Array<{ name: string; since: number | null }> = [{ name: "IiApaCiOxa", since: Date.parse("2026-10-11T11:00:00Z") }];
  const w = new PromiseWatch(core, async () => online, { activeEveryMs: 0, now: () => now });
  assert.equal(await w.tick(), 0, "был в игре до обещания");
  online = [{ name: "IiApaCiOxa", since: Date.parse("2026-10-11T12:01:00Z") }];
  now = Date.parse("2026-10-11T12:01:30Z");
  assert.equal(await w.tick(), 1);
  assert.deepEqual(marked[0], { id: "p1", at: "2026-10-11T12:01:00.000Z", detail: "IiApaCiOxa" });
  assert.equal(await w.tick(), 0, "второй раз не отмечает");
  // без since (данные карты): был — не считается; вышел и зашёл после обещания — пришёл
  timers[0] = { ...timers[0]!, id: "p2" };
  const w2 = new PromiseWatch(core, async () => online, { activeEveryMs: 0, now: () => now });
  online = [{ name: "IiApaCiOxa", since: null }];
  assert.equal(await w2.tick(), 0);
  online = [];
  now += 15_000;
  assert.equal(await w2.tick(), 0);
  online = [{ name: "IiApaCiOxa", since: null }];
  now += 15_000;
  assert.equal(await w2.tick(), 1);
  // людей с привязанными персонажами нет — мод не опрашиваем
  let polled = 0;
  const w3 = new PromiseWatch({ ...core, links: { ...core.links, charactersOf: () => [] } } as CoreServices, async () => {
    polled++;
    return [];
  }, { activeEveryMs: 0 });
  await w3.tick();
  assert.equal(polled, 0);
});

// ───────────────────────────── ClaudeEngine ─────────────────────────────

type Params = Record<string, any>;
const usage = (input = 1000, output = 100) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, iterations: null });
const cfg = { anthropicApiKey: "k", anthropicWorkspaceId: null, model: "claude-opus-5-5", maxTokens: 16000, maxToolIterations: 6, webSearchMaxUses: 5, webFetchMaxUses: 4, webFetchMaxContentTokens: 15000, memoryModel: "claude-sonnet-5-5" };

function fakeClient(responses: Array<Record<string, unknown> | Error>, counts: Array<Error | null> = []) {
  const calls: Params[] = [];
  const countCalls: Params[] = [];
  const next = () => {
    const r = responses.shift();
    if (!r) throw new Error("лишний вызов модели");
    if (r instanceof Error) throw r;
    return r;
  };
  const client = {
    beta: {
      messages: {
        stream(params: Params) {
          calls.push(structuredClone(params));
          return { finalMessage: async () => next() };
        },
        async create(params: Params) {
          calls.push(structuredClone(params));
          return next();
        },
        async countTokens(params: Params) {
          countCalls.push(structuredClone(params));
          const e = counts.shift();
          if (e) throw e;
          return { input_tokens: 10 };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls, countCalls };
}

const apiErr = (status: number, message: string) => new Anthropic.APIError(status, { type: "error", error: { type: "x", message } }, message, new Headers());

test("глубокий ответ: другая модель, усилие верхним уровнем, свой max_tokens, 5-мин кэш системы", async () => {
  const { client, calls } = fakeClient([{ model: "claude-fable-5-1", stop_reason: "end_turn", content: [{ type: "text", text: "Глубоко", citations: null }], usage: usage() }]);
  const eng = new ClaudeEngine(cfg, "СИСТЕМА", silentLogger, client);
  const r = await eng.answer({
    turns: [{ role: "user", text: "вопрос" }],
    contextNote: "x",
    effort: "low",
    userKey: "k",
    tools: { defs: [], run: async () => ({ content: "", isError: false }) },
    signal: new AbortController().signal,
    maxUsd: 2,
    model: "claude-fable-5-1",
    topEffort: "high",
    maxTokens: 32000,
    maxIterations: 6,
    hardCap: true,
    systemTtl: "5m",
  });
  assert.equal(r.text, "Глубоко");
  assert.equal(r.servedBy, "claude-fable-5-1");
  const p = calls[0]!;
  assert.equal(p.model, "claude-fable-5-1");
  assert.equal(p.max_tokens, 32000);
  assert.deepEqual(p.output_config, { effort: "high" });
  assert.deepEqual(p.thinking, { type: "adaptive" }, "мышление — adaptive (у Fable 5.1 иное — 400)");
  assert.equal(p.temperature, undefined);
  assert.ok(!p.messages.some((m: any) => m.role === "system" && Array.isArray(m.content) && m.content.length === 0), "без сообщения усилия");
  assert.deepEqual(p.system[0].cache_control, { type: "ephemeral" });
  assert.ok(p.tools.some((t: any) => t.type === "web_search_20260209"));
  assert.equal(p.fallbacks, "default");
});

test("ответ по переписке: без поиска, переписка первой репликой с точкой кэша", async () => {
  const { client, calls } = fakeClient([{ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok", citations: null }], usage: usage() }]);
  const eng = new ClaudeEngine(cfg, "С", silentLogger, client);
  await eng.answer({
    turns: [{ role: "user", text: "о чём договорились?" }],
    contextNote: "x",
    effort: "medium",
    userKey: "k",
    tools: { defs: [], run: async () => ({ content: "", isError: false }) },
    signal: new AbortController().signal,
    maxUsd: 1,
    web: false,
    preamble: "<chat_transcript>…</chat_transcript>",
  });
  const p = calls[0]!;
  assert.deepEqual(p.tools, []);
  assert.equal(p.messages[0].role, "user");
  assert.equal(p.messages[0].content[0].text, "<chat_transcript>…</chat_transcript>");
  assert.deepEqual(p.messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.equal(p.messages[1].role, "assistant");
  assert.equal(p.messages[2].role, "user");
  // и без переписки — как раньше
  assert.equal(turnsToMessages([{ role: "user", text: "q" }], "")[0]!.role, "user");
});

test("инструмент ответил сам (endTurn) — модель больше не зовём; картинка в результате; жёсткий потолок", async () => {
  const toolUse = (id: string, name: string) => ({ model: "claude-opus-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input: {} }], usage: usage(1000, 100) });
  {
    const { client, calls } = fakeClient([toolUse("t1", "read_chat")]);
    const eng = new ClaudeEngine(cfg, "С", silentLogger, client);
    const r = await eng.answer({
      turns: [{ role: "user", text: "q" }],
      contextNote: "",
      effort: "medium",
      userKey: "k",
      tools: { defs: [{ name: "read_chat", description: "d", input_schema: { type: "object" } }], run: async () => ({ content: "карточка", isError: false, endTurn: true }) },
      signal: new AbortController().signal,
      maxUsd: 1,
    });
    assert.equal(r.suppressed, true);
    assert.equal(r.text, "");
    assert.equal(calls.length, 1);
  }
  {
    const img = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { client, calls } = fakeClient([toolUse("t2", "view_photo"), { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Схема", citations: null }], usage: usage() }]);
    const eng = new ClaudeEngine(cfg, "С", silentLogger, client);
    await eng.answer({
      turns: [{ role: "user", text: "q" }],
      contextNote: "",
      effort: "medium",
      userKey: "k",
      tools: { defs: [{ name: "view_photo", description: "d", input_schema: { type: "object" } }], run: async () => ({ content: "Фото #1:", images: [{ mime: "image/png", data: img }], isError: false }) },
      signal: new AbortController().signal,
      maxUsd: 1,
    });
    const res = calls[1]!.messages.at(-1).content[0];
    assert.equal(res.type, "tool_result");
    assert.equal(res.content[0].text, "Фото #1:");
    assert.equal(res.content[1].type, "image");
    assert.equal(res.content[1].source.data, img.toString("base64"));
  }
  {
    // Потолок $0.06 без поиска: первый шаг — max_tokens урезан до ≤ 1200 (весь вывод ≤ $0.06); шаг стоит ≈ $0.015
    // (1000 вх. + 100 вых.); на второй остатка меньше 1024 токенов вывода — не начинается.
    const { client, calls } = fakeClient([{ ...toolUse("t3", "valheim_status"), model: "claude-fable-5-1" }, { model: "claude-fable-5-1", stop_reason: "end_turn", content: [], usage: usage() }]);
    const eng = new ClaudeEngine(cfg, "С", silentLogger, client);
    const r = await eng.answer({
      turns: [{ role: "user", text: "q" }],
      contextNote: "",
      effort: "medium",
      userKey: "k",
      tools: { defs: [{ name: "valheim_status", description: "d", input_schema: { type: "object" } }], run: async () => ({ content: "ok", isError: false }) },
      signal: new AbortController().signal,
      maxUsd: 0.06,
      model: "claude-fable-5-1",
      hardCap: true,
      web: false,
      maxTokens: 32000,
    });
    assert.equal(r.stop, "budget");
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.max_tokens <= 1200 && calls[0]!.max_tokens >= 1024, `max_tokens ${calls[0]!.max_tokens}`);
  }
  {
    // Находка ревью: шаг 1 — 1000 вх. + 19000 вых. ($0.96); раньше шаг 2 шёл с max_tokens 32000 (до $1.6) и ответ
    // стоил $2.57 при потолке $2. Теперь max_tokens второго шага — от остатка: даже весь его вывод в потолок влезает.
    const { client, calls } = fakeClient([
      { ...toolUse("t4", "valheim_status"), model: "claude-fable-5-1", usage: usage(1000, 19000) },
      { model: "claude-fable-5-1", stop_reason: "end_turn", content: [{ type: "text", text: "итог", citations: null }], usage: usage(21000, 500) },
    ]);
    const eng = new ClaudeEngine(cfg, "С", silentLogger, client);
    await eng.answer({
      turns: [{ role: "user", text: "q" }],
      contextNote: "",
      effort: "medium",
      userKey: "k",
      tools: { defs: [{ name: "valheim_status", description: "d", input_schema: { type: "object" } }], run: async () => ({ content: "ok", isError: false }) },
      signal: new AbortController().signal,
      maxUsd: 2,
      model: "claude-fable-5-1",
      hardCap: true,
      maxTokens: 32000,
    });
    assert.equal(calls.length, 2);
    const step1 = 1000 * 10e-6 + 19000 * 50e-6;
    const worst2 = 20000 * 1.1 * 10e-6 + calls[1]!.max_tokens * 50e-6;
    assert.ok(step1 + worst2 <= 2, `худший случай ${step1 + worst2}`);
    assert.ok(calls[1]!.max_tokens < 32000);
  }
});

test("ответ: исключение несёт потраченное; 400 на тип серверного инструмента — следующий набор", async () => {
  {
    const { client } = fakeClient([
      { model: "claude-fable-5-1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }], usage: usage(1000, 1000) },
      apiErr(529, "Overloaded"),
    ]);
    const eng = new ClaudeEngine(cfg, "С", silentLogger, client);
    let caught: unknown = null;
    try {
      await eng.answer({
        turns: [{ role: "user", text: "q" }],
        contextNote: "",
        effort: "medium",
        userKey: "k",
        tools: { defs: [{ name: "x", description: "d", input_schema: { type: "object" } }], run: async () => ({ content: "ok", isError: false }) },
        signal: new AbortController().signal,
        maxUsd: 2,
        model: "claude-fable-5-1",
        hardCap: true,
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Anthropic.APIError);
    const c = partialCostOf(caught);
    assert.ok(c && Math.abs(c.usd - (1000 * 10e-6 + 1000 * 50e-6)) < 1e-9, "первый шаг учтён");
    assert.equal(deepUnavailable(caught), "temporary");
  }
  {
    const msg = "tools.1.type: web_fetch_20260318 is not supported for this model";
    const { client, calls } = fakeClient([
      new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: msg } }, msg, new Headers()),
      { model: "claude-fable-5-1", stop_reason: "end_turn", content: [{ type: "text", text: "ok", citations: null }], usage: usage() },
    ]);
    const eng = new ClaudeEngine(cfg, "С", silentLogger, client);
    const r = await eng.answer({
      turns: [{ role: "user", text: "q" }],
      contextNote: "",
      effort: "medium",
      userKey: "k",
      tools: { defs: [], run: async () => ({ content: "", isError: false }) },
      signal: new AbortController().signal,
      maxUsd: 2,
      model: "claude-fable-5-1",
    });
    assert.equal(r.text, "ok");
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.tools.some((t: any) => t.type === "web_fetch_20260318"));
    assert.ok(calls[1]!.tools.some((t: any) => t.type === "web_fetch_20260209"), "следующий набор");
  }
  const bad = (m: string) => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: m } }, m, new Headers());
  assert.ok(isToolTypeError(bad("tools.0: web_search_20260209 not supported")));
  assert.ok(!isToolTypeError(bad("tools.3.input_schema: invalid type")), "своя схема — не повод");
  assert.equal(deepUnavailable(new Anthropic.APIConnectionError({ message: "socket hang up" })), "temporary");
  assert.equal(deepUnavailable(new Anthropic.APIUserAbortError()), null, "свой обрыв по времени — не недоступность");
});

test("проба глубокой модели: инструменты, доступ, запасная, выключение", async () => {
  {
    const { client, countCalls, calls } = fakeClient([{ model: "claude-fable-5-1", stop_reason: "end_turn", content: [], usage: usage(10, 5) }]);
    const r = await new ClaudeEngine(cfg, "С", silentLogger, client).deepProbe("claude-fable-5-1", "claude-opus-5-5");
    assert.equal(r.model, "claude-fable-5-1");
    assert.equal(r.tools, "web_fetch_20260318", "у Fable загрузка с фильтрацией — web_fetch_20260318");
    assert.equal(countCalls[0]!.model, "claude-fable-5-1");
    assert.ok(calls[0]!.tools.some((t: any) => t.type === "web_fetch_20260318"), "настоящий запрос пробы — с этими инструментами");
    assert.ok(r.cost.usd > 0);
  }
  {
    // count_tokens отверг набор — следующий
    const { client } = fakeClient([{ model: "claude-fable-5-1", stop_reason: "end_turn", content: [], usage: usage(10, 5) }], [apiErr(400, "tools.1: web_fetch_20260318 is not supported")]);
    const r = await new ClaudeEngine(cfg, "С", silentLogger, client).deepProbe("claude-fable-5-1", "claude-opus-5-5");
    assert.equal(r.tools, "web_20260209");
  }
  {
    // count_tokens принял, а настоящий запрос отверг тип инструмента (находка ревью) — следующий набор, не «зелёная» проба
    const { client, calls } = fakeClient([
      apiErr(400, "tools.1.type: web_fetch_20260318 is not supported for this model"),
      { model: "claude-fable-5-1", stop_reason: "end_turn", content: [], usage: usage(10, 5) },
    ]);
    const r = await new ClaudeEngine(cfg, "С", silentLogger, client).deepProbe("claude-fable-5-1", "claude-opus-5-5");
    assert.equal(r.model, "claude-fable-5-1");
    assert.equal(r.tools, "web_20260209");
    assert.equal(calls.length, 2);
  }
  {
    // хранение данных — запасная модель
    const { client } = fakeClient([apiErr(400, "In order to access this model, your organization or workspace must have data retention enabled."), { model: "claude-opus-5-5", stop_reason: "end_turn", content: [], usage: usage(10, 5) }]);
    const r = await new ClaudeEngine(cfg, "С", silentLogger, client).deepProbe("claude-fable-5-1", "claude-opus-5-5");
    assert.equal(r.model, "claude-opus-5-5");
    assert.ok(r.note);
  }
  {
    // обе недоступны — выключено
    const { client } = fakeClient([], [apiErr(404, "model not found"), apiErr(403, "no access")]);
    const r = await new ClaudeEngine(cfg, "С", silentLogger, client).deepProbe("claude-fable-5-1", "claude-opus-5-5");
    assert.equal(r.model, null);
  }
  assert.equal(deepUnavailable(apiErr(529, "Overloaded")), "temporary");
  assert.equal(deepUnavailable(apiErr(400, "messages.0: bad role")), null, "ошибка запроса — не недоступность модели");
  assert.equal(deepUnavailable(new Error("x")), null);
});

// ───────────────────────────── «поделиться»: новый выбор после «слишком много» ─────────────────────────────

test("слишком много → карточка к выбору; новый выбор той же карточки читается заново и не теряется как повтор", async () => {
  // «Сервер»: согласие на всё время — 40 длинных сообщений (неподъёмно при пределе 1000 токенов), на сегодня — 2.
  const state: { period: SharePeriod; reopened: number; reads: Array<{ period: SharePeriod; after: boolean }>; answered: number } = { period: "all", reopened: 0, reads: [], answered: 0 };
  const info = (until: string): ShareInfo => ({ id: "sh1", status: "granted", period: state.period, photos: false, from: null, until, cardMessageId: "card1", triggerMessageId: "q", answers: state.answered });
  const old: ShareMessage[] = Array.from({ length: 40 }, (_, i) => ({ id: `old${i}`, at: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString(), senderId: BOB, senderName: "Боб", isBot: false, kind: "text", text: `давнее-${i} ${"слово ".repeat(60)}`, replyTo: null, reactions: [], edited: false, forwarded: false }) as unknown as ShareMessage);
  const fresh: ShareMessage[] = ["сегодня-1 встречаемся в семь", "сегодня-2 беру пиццу"].map((t, i) => ({ id: `new${i}`, at: new Date(Date.UTC(2026, 9, 11, 10, i)).toISOString(), senderId: BOB, senderName: "Боб", isBot: false, kind: "text", text: t, replyTo: null, reactions: [], edited: false, forwarded: false }) as unknown as ShareMessage);
  let until = new Date(Date.now() + 3600_000).toISOString();
  const share: ShareApi = {
    estimate: async () => { throw new Error("не нужно"); },
    request: async () => { throw new Error("не нужно"); },
    messages: async (_id, input) => {
      state.reads.push({ period: state.period, after: !!input.after });
      const all = state.period === "all" ? old : fresh;
      return { share: info(until), messages: input.after ? [] : all, next: null, changes: { deleted: [], edited: [] }, checkedAt: Date.now() };
    },
    status: async () => info(until),
    answered: async () => { state.answered++; return info(until); },
    reopen: async () => { state.reopened++; return { ...info(until), status: "pending" }; },
    revoke: async () => 0,
    choose: async () => info(until),
  };
  const h = await harness({ cfg: { shareMaxTokens: 1000, shareDirectTokens: 1000 } });
  (h.api as { share?: ShareApi }).share = share;
  const q = msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, о чём мы договорились?" });
  const job1 = { rev: 4, share: { id: "sh1", period: "all" as const, photos: false, from: null, until } };
  await h.deliver(q, job1);
  assert.equal(state.reopened, 1, "неподъёмно — вернул карточку к выбору");
  assert.equal(h.llm.calls.length, 0);
  // Повтор той же задачи (та же выдача согласия) — не работа.
  await h.deliver(q, job1);
  assert.equal(state.reopened, 1);
  // Спросившая выбрала «сегодня»: то же согласие, новое окно.
  state.period = "today";
  until = new Date(Date.now() + 3600_000 + 5_000).toISOString();
  await h.deliver(q, { rev: 4, share: { id: "sh1", period: "today", photos: false, from: "2026-10-11T02:00:00.000Z", until } });
  assert.equal(h.llm.calls.length, 1, "новый выбор — ответ, а не «повтор»");
  const pre = h.llm.calls[0]!.preamble ?? "";
  assert.match(pre, /сегодня-1 встречаемся в семь/);
  assert.doesNotMatch(pre, /давнее-/, "прочитанное за «всё время» в ответ по «сегодня» не попало");
  assert.deepEqual(state.reads.at(-1), { period: "today", after: false }, "читал новый период с начала");
  assert.equal(state.answered, 1);
});
