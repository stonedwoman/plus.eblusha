/**
 * Контекст без цитирования (решение владельца 2026-10-10): история из задачи (контракт rev 2).
 * «Чат с Еблушей» — история чата; обычная беседа — только свои разговоры за 30 минут (обращения + ответы),
 * без остальной переписки людей; без дублей с цепочкой; бюджет и «якоря» окна; старый/новый контракт.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBotJob, type BotJob, type BotJobMessage } from "../../src/api/types";
import { buildContext, estimateTokens, isAnchor, pickHistory, stableStart, type HistoryLimits } from "../../src/core/context";
import { parseBotJob as parseBotJobRev1 } from "./legacy/types-rev1";
import { ALICE, BOB, BOT, DM_ALICE, GROUP, harness, msg, OWNER } from "./fakes";

const LIMITS: HistoryLimits = { maxMessages: 40, maxTokens: 8000, botChars: 1500, userChars: 2000, recentWindowMs: 30 * 60_000 };
const names = (m: BotJobMessage) => m.senderName ?? "Участник";

function m(id: string, p: Partial<BotJobMessage> = {}): BotJobMessage {
  return {
    id,
    senderId: p.isBot ? BOT : ALICE,
    senderName: p.isBot ? "Еблуша" : "Алиса",
    isBot: false,
    type: "TEXT",
    content: `текст ${id}`,
    createdAt: "2026-10-10T12:00:00.000Z",
    replyToId: null,
    attachments: [],
    ...p,
  };
}

function job(over: Partial<BotJob> = {}): BotJob {
  return {
    v: 1,
    kind: "message",
    enqueuedAt: Date.now(),
    grant: "g".repeat(32),
    grantExpiresAt: Date.now() + 20 * 60_000,
    via: "name",
    conversation: { id: GROUP, kind: "group", title: "Кобаны", participantIds: [ALICE, BOB, OWNER] },
    author: { id: BOB, displayName: "Боб" },
    message: m("trigger", { senderId: BOB, senderName: "Боб", content: "Еблуша, а в Мельбурне?", createdAt: "2026-10-10T12:30:00.000Z" }),
    chain: [],
    ...over,
  };
}

test("«Чат с Еблушей»: разговор без цитирования — история чата уходит модели по ролям, точка кэша на её конце", async () => {
  const h = await harness({ history: true });
  h.llm.reply = () => ({ text: `ответ №${h.llm.calls.length}` });
  for (const q of ["какая погода в Бухаресте?", "а завтра?", "а в выходные?"]) {
    await h.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: q, sender: { id: ALICE, displayName: "Алиса" } }));
  }
  assert.equal(h.llm.calls.length, 3);
  const call = h.llm.calls[2]!;
  assert.deepEqual(call.turns, [
    { role: "user", text: "Алиса: какая погода в Бухаресте?" },
    { role: "assistant", text: "ответ №1" },
    { role: "user", text: "Алиса: а завтра?" },
    { role: "assistant", text: "ответ №2" },
    { role: "user", text: "Алиса: а в выходные?" },
  ]);
  assert.equal(call.cacheAt, 3, "точка кэша — последняя реплика истории (перед вопросом)");
  assert.match(call.contextNote, /недавняя история этого чата \(4 сообщ\.\)/);
  // первый вопрос — без истории
  assert.deepEqual(h.llm.calls[0]!.turns, [{ role: "user", text: "Алиса: какая погода в Бухаресте?" }]);
  assert.equal(h.llm.calls[0]!.cacheAt, null);
});

test("обычная беседа: обращение обязательно, но бот помнит свои разговоры (с именами) — и не видит остальную переписку", async () => {
  const h = await harness({ history: true });
  h.llm.reply = (req) => ({ text: req.turns.at(-1)!.text.includes("Сидне") ? "В Сиднее +18." : "В Мельбурне +15." });
  await h.deliver(msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, какая погода в Сиднее?", sender: { id: ALICE, displayName: "Алиса" } }));
  // люди болтают между собой — боту это не уходит
  assert.equal(await h.deliver(msg({ conversationId: GROUP, senderId: BOB, content: "кстати, пароль от вайфая Ананас123", sender: { id: BOB, displayName: "Боб" } })), null);
  assert.equal(await h.deliver(msg({ conversationId: GROUP, senderId: ALICE, content: "ха, ну ок", sender: { id: ALICE, displayName: "Алиса" } })), null);
  const j = await h.deliver(msg({ conversationId: GROUP, senderId: BOB, content: "Еблуша, а в Мельбурне?", sender: { id: BOB, displayName: "Боб" } }));
  assert.equal(j?.history?.mode, "recent");
  const call = h.llm.calls[1]!;
  assert.deepEqual(call.turns, [
    { role: "user", text: "Алиса: какая погода в Сиднее?" },
    { role: "assistant", text: "В Сиднее +18." },
    { role: "user", text: "Боб: а в Мельбурне?" },
  ]);
  const everything = JSON.stringify(call.turns) + call.contextNote;
  assert.ok(!everything.includes("Ананас"), "посторонняя переписка людей боту не уходит");
  assert.ok(!everything.includes("ну ок"));
  assert.match(call.contextNote, /твои недавние разговоры в этой беседе \(за последние 30 мин\)/);
  assert.match(call.contextNote, /от «Боб»/);
  assert.equal(h.api.sent.at(-1)!.content, "В Мельбурне +15.");
});

test("история: удалённое не уходит, окно 30 минут, новее обращения — нет, «спасибо» пропускается", async () => {
  const at = (min: number) => new Date(Date.parse("2026-10-10T12:30:00.000Z") - min * 60_000).toISOString();
  const j = job({
    rev: 2,
    history: {
      mode: "recent",
      windowMs: 30 * 60_000,
      messages: [
        m("old", { content: "Еблуша, древний вопрос", createdAt: at(31) }),
        m("oldA", { isBot: true, content: "древний ответ", createdAt: at(31) }),
        m("q1", { content: "Еблуша, погода в Сиднее?", createdAt: at(10) }),
        m("a1", { isBot: true, content: "В Сиднее +18.", createdAt: at(9) }),
        m("thx", { senderId: BOB, senderName: "Боб", content: "Еблуша, спасибо!", createdAt: at(8) }),
        m("future", { content: "Еблуша, из будущего", createdAt: at(-1) }),
        m("q1", { content: "дубль", createdAt: at(10) }),
      ],
    },
  });
  const h = pickHistory(j, [], LIMITS, names);
  assert.deepEqual(h.messages.map((x) => x.id), ["q1", "a1"]);
  assert.deepEqual(h.turns, [
    { role: "user", text: "Алиса: погода в Сиднее?" },
    { role: "assistant", text: "В Сиднее +18." },
  ]);
  // бот может только сузить окно сервера
  const narrow = pickHistory(j, [], { ...LIMITS, recentWindowMs: 5 * 60_000 }, names);
  assert.deepEqual(narrow.messages, []);
  // «Чат с Еблушей» без окна: старое остаётся
  const botchat = pickHistory({ ...j, history: { ...j.history!, mode: "botchat", windowMs: null } }, [], LIMITS, names);
  assert.deepEqual(botchat.messages.map((x) => x.id), ["old", "oldA", "q1", "a1"]);
});

test("история + цепочка ответов: без дублей, цепочка — последней, перед триггером", async () => {
  const q1 = m("q1", { content: "Еблуша, сколько ног у паука?", createdAt: "2026-10-10T12:10:00.000Z" });
  const a1 = m("a1", { isBot: true, content: "Восемь.", createdAt: "2026-10-10T12:11:00.000Z" });
  const q2 = m("q2", { senderId: OWNER, senderName: "Стон", content: "Еблуша, а у краба?", createdAt: "2026-10-10T12:20:00.000Z" });
  const a2 = m("a2", { isBot: true, content: "Десять.", createdAt: "2026-10-10T12:21:00.000Z" });
  const trigger = m("t", { senderId: BOB, senderName: "Боб", content: "а лапы у паука мохнатые?", replyToId: "a1", createdAt: "2026-10-10T12:29:00.000Z" });
  const j = job({ message: trigger, chain: [q1, a1], rev: 2, history: { mode: "recent", windowMs: 30 * 60_000, messages: [q1, a1, q2, a2] } });
  const ctx = await buildContext(j, { nameOf: names, chainMax: 12, limits: LIMITS });
  assert.deepEqual(ctx.turns, [
    { role: "user", text: "Стон: а у краба?" },
    { role: "assistant", text: "Десять." },
    { role: "user", text: "Алиса: сколько ног у паука?" },
    { role: "assistant", text: "Восемь." },
    { role: "user", text: "Боб: а лапы у паука мохнатые?" },
  ]);
  assert.equal(ctx.cacheAt, 1);
  assert.equal(ctx.historyCount, 2);
  assert.equal(ctx.historyMode, "recent");
});

test("история начинается с ответа бота — он отбрасывается (первая реплика — человека), точка кэша сдвигается", async () => {
  const j = job({
    rev: 2,
    history: {
      mode: "recent",
      windowMs: 30 * 60_000,
      messages: [m("a0", { isBot: true, content: "хвост ответа", createdAt: "2026-10-10T12:05:00.000Z" }), m("q1", { createdAt: "2026-10-10T12:10:00.000Z" }), m("a1", { isBot: true, createdAt: "2026-10-10T12:11:00.000Z" })],
    },
  });
  const ctx = await buildContext(j, { nameOf: names, chainMax: 12, limits: LIMITS });
  assert.equal(ctx.turns[0]!.role, "user");
  assert.equal(ctx.turns.length, 3);
  assert.equal(ctx.cacheAt, 1);
  assert.equal(ctx.historyCount, 2);
});

test("старый сервер (rev 1, без history) и выключенная история — как раньше: только цепочка, без точки кэша", async () => {
  const old = await harness();
  await old.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "раз", sender: { id: ALICE, displayName: "Алиса" } }));
  await old.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "два", sender: { id: ALICE, displayName: "Алиса" } }));
  assert.deepEqual(old.llm.calls[1]!.turns, [{ role: "user", text: "Алиса: два" }]);
  assert.equal(old.llm.calls[1]!.cacheAt, null);
  assert.doesNotMatch(old.llm.calls[1]!.contextNote, /история/);

  const off = await harness({ history: true, cfg: { historyMaxMessages: 0 } });
  await off.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "раз", sender: { id: ALICE, displayName: "Алиса" } }));
  await off.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "два", sender: { id: ALICE, displayName: "Алиса" } }));
  assert.deepEqual(off.llm.calls[1]!.turns, [{ role: "user", text: "Алиса: два" }]);
});

test("бюджет: длинные ответы бота ужимаются, по токенам и числу — отбрасывается старое", () => {
  const long = "Очень длинный ответ. ".repeat(500);
  const msgs: BotJobMessage[] = [];
  for (let i = 0; i < 30; i++) {
    const t = new Date(Date.parse("2026-10-10T12:00:00.000Z") + i * 1000).toISOString();
    msgs.push(m(`q${i}`, { content: `вопрос ${i}`, createdAt: t }), m(`a${i}`, { isBot: true, content: long, createdAt: t }));
  }
  const j = job({ message: m("t", { createdAt: "2026-10-10T12:29:00.000Z" }), rev: 2, history: { mode: "botchat", windowMs: null, messages: msgs } });
  const h = pickHistory(j, [], { ...LIMITS, maxTokens: 3000, botChars: 600 }, names);
  for (const t of h.turns.filter((x) => x.role === "assistant")) {
    assert.ok(t.text.length <= 600, "ответ ужат");
    assert.match(t.text, /…\(сокращено\)$/);
  }
  const total = h.turns.reduce((s, t) => s + estimateTokens(t.text), 0);
  assert.ok(total <= 3000, `бюджет соблюдён (${total})`);
  assert.ok(h.turns.length > 0 && h.turns.length < 60);
  assert.equal(h.messages.at(-1)!.id, "a29", "свежее остаётся");
  const byCount = pickHistory(j, [], { ...LIMITS, maxMessages: 10, botChars: 200 }, names);
  assert.ok(byCount.messages.length <= 10);
  assert.equal(byCount.messages.at(-1)!.id, "a29");
});

test("якоря: начало окна стоит на месте несколько обменов подряд (кэш промпта), перескакивает только на якорь", () => {
  const ids = Array.from({ length: 400 }, (_, i) => `cmsg${String(i).padStart(21, "0")}`);
  const starts: string[] = [];
  // «сервер» каждый раз шлёт последние 60, разговор растёт на 2 сообщения за обмен
  for (let end = 80; end <= 400; end += 2) {
    const window = ids.slice(Math.max(0, end - 60), end);
    const s = stableStart(window, window.map(() => 50), 40, 100_000);
    assert.ok(window.length - s <= 40, "не больше 40");
    starts.push(window[s]!);
  }
  const changes = starts.filter((s, i) => i > 0 && s !== starts[i - 1]).length;
  assert.ok(changes < starts.length / 2, `начало окна меняется редко: ${changes} из ${starts.length}`);
  const anchored = starts.filter((s) => isAnchor(s)).length;
  assert.ok(anchored >= starts.length * 0.9, "почти всегда начало — якорь");
  // всё влезает — с самого начала; пусто/выключено
  assert.equal(stableStart(["a", "b"], [1, 1], 40, 100), 0);
  assert.equal(stableStart([], [], 40, 100), 0);
  assert.equal(stableStart(["a"], [1], 0, 100), 1);
});

test("контракт: задача нового сервера (rev 2) разбирается и СТАРЫМ ботом, и новым; старая задача — новым", () => {
  const trigger = m("t", { createdAt: "2026-10-10T12:30:00.000Z" });
  const base = {
    v: 1,
    kind: "message",
    enqueuedAt: 1_700_000_000_000,
    grant: "g".repeat(32),
    grantExpiresAt: 1_700_000_001_000,
    via: "name",
    conversation: { id: GROUP, kind: "group", title: "Кобаны", participantIds: [ALICE, BOB] },
    author: { id: ALICE, displayName: "Алиса" },
    message: trigger,
    chain: [],
  };
  const rev2 = { ...base, rev: 2, history: { mode: "recent", windowMs: 1_800_000, messages: [m("q1"), m("a1", { isBot: true }), { junk: 1 }] } };

  const old = parseBotJobRev1(rev2);
  assert.ok(old, "старый бот принимает задачу нового сервера (v остался 1)");
  assert.equal((old as unknown as Record<string, unknown>).history, undefined, "лишнее старый бот просто не видит");
  assert.deepEqual(old, parseBotJobRev1(base), "для старого бота задача та же, что от старого сервера");

  const fresh = parseBotJob(rev2)!;
  assert.equal(fresh.rev, 2);
  assert.equal(fresh.history?.mode, "recent");
  assert.deepEqual(fresh.history?.messages.map((x) => x.id), ["q1", "a1"], "битый элемент истории отброшен");

  const fromOldServer = parseBotJob(base)!;
  assert.equal(fromOldServer.rev, 1);
  assert.equal(fromOldServer.history, undefined);

  const junkHistory = parseBotJob({ ...base, rev: 2, history: { mode: "everything", messages: [m("x")] } })!;
  assert.ok(junkHistory, "кривая история не роняет задачу");
  assert.equal(junkHistory.history, undefined);
  assert.equal(parseBotJob({ ...rev2, v: 2 }), null, "чужой v по-прежнему отвергается");
});

test("harness как сервер: в «recent» — только обращения и ответы бота, удалённое не попадает", async () => {
  const h = await harness({ history: true });
  h.llm.reply = () => ({ text: `ответ №${h.llm.calls.length}` });
  const q1 = msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, первый вопрос", sender: { id: ALICE, displayName: "Алиса" } });
  await h.deliver(q1);
  const q2 = msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, второй вопрос", sender: { id: ALICE, displayName: "Алиса" } });
  await h.deliver(q2);
  // Алиса удалила первый вопрос, и ответ на него тоже удалён (сервер не отдаёт ответ на удалённое обращение)
  q1.deletedAt = new Date().toISOString();
  h.api.sentMessages[0]!.deletedAt = new Date().toISOString();
  await h.deliver(msg({ conversationId: GROUP, senderId: BOB, content: "Еблуша, третий", sender: { id: BOB, displayName: "Боб" } }));
  const text = JSON.stringify(h.llm.calls[2]!.turns);
  assert.ok(!text.includes("первый вопрос"));
  assert.ok(!text.includes("ответ №1"));
  assert.ok(text.includes("второй вопрос") && text.includes("ответ №2"));
});
