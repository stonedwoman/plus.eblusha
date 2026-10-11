/**
 * Юнит (без БД и сети, но с окружением изолированной среды — модули тянут env): карточки бота (docs/bot-cards.md).
 *   test/secret-env/secret-test.sh run test/bot-cards.unit.test.ts
 * Конверт таймера по состояниям, действия и права (canActOn), запасные тексты, напоминания, периоды «поделиться
 * перепиской» в поясах (с переводом часов), вид карточки «поделиться» по состояниям.
 */
import assert from "node:assert/strict";
import type { BotShare, PromiseTimer } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { canActOn } from "../src/lib/botCards";
import { buildPromiseCard } from "../src/lib/promiseTimer";
import { durationRu, promiseFallbackText, quoteShort, reminderText } from "../src/lib/promiseTexts";
import { buildShareCard, periodStarts, shareFallbackText } from "../src/lib/botShare";

const T0 = new Date("2026-10-11T11:00:00.000Z"); // 14:00 МСК
const names = new Map([
  ["vasya", "Козёл Ебаный"],
  ["roma", "Рома"],
  ["petya", "Петя"],
  ["owner", "Стон"],
]);
const people = { names, avatar: "/api/files/a.eblusha", promiserZone: null as string | null };

function timer(over: Partial<PromiseTimer> = {}): PromiseTimer {
  return {
    id: "pt1",
    createdAt: T0,
    updatedAt: T0,
    conversationId: "c1",
    cardMessageId: "m1",
    promiseMessageId: "pm1",
    triggerMessageId: "tr1",
    promiserId: "vasya",
    requesterId: "roma",
    cancelAllowedIds: ["roma", "owner"],
    quote: "15мин",
    quoteById: null,
    quoteAt: T0,
    label: "15 мин",
    upperBound: false,
    parseSource: "code",
    zone: "Europe/Moscow",
    zoneSource: "promiser",
    startAt: T0,
    deadlineAt: new Date(T0.getTime() + 15 * 60_000),
    originalDeadlineAt: new Date(T0.getTime() + 15 * 60_000),
    extensions: [] as unknown as Prisma.JsonValue,
    extensionCount: 0,
    status: "RUNNING",
    closedAt: null,
    closeReason: null,
    arrivedAt: null,
    arrivedVia: null,
    arrivedById: null,
    arrivedDetail: null,
    cancelledById: null,
    lateSec: null,
    lateVsOriginalSec: null,
    remindersSent: [],
    remindersTotal: 0,
    createdLate: false,
    reopenUntil: null,
    reopenBy: [],
    reopenPrev: null,
    rev: 1,
    ...over,
  } as PromiseTimer;
}

// ---------- таймер: конверт ----------
{
  const c = buildPromiseCard(timer(), people, T0);
  assert.equal(c.v, 1);
  assert.equal(c.type, "promise");
  assert.equal(c.state, "running");
  assert.equal(c.closed, false);
  assert.deepEqual(c.actions.map((a) => a.id), ["arrived", "cancel"]);
  assert.deepEqual(c.actions[0]!.who, { any: true });
  assert.deepEqual(c.actions[1]!.who, { ids: ["roma", "owner"] });
  const d = c.data as Record<string, any>;
  assert.equal(d.promiser.displayName, "Козёл Ебаный");
  assert.equal(d.promiser.avatarUrl, "/api/files/a.eblusha");
  assert.equal(d.requester.displayName, "Рома");
  assert.deepEqual(d.quote, { messageId: "pm1", text: "15мин", at: T0.toISOString(), by: null, deleted: false });
  assert.equal(d.label, "15 мин");
  assert.equal(d.deadlineAt, "2026-10-11T11:15:00.000Z");
  assert.equal(d.outcome, null);
  assert.deepEqual(d.cancelBy, ["roma", "owner"]);
  // права
  assert.equal(canActOn(c, "arrived", "petya", T0.getTime()), "ok");
  assert.equal(canActOn(c, "cancel", "petya", T0.getTime()), "forbidden");
  assert.equal(canActOn(c, "cancel", "roma", T0.getTime()), "ok");
  assert.equal(canActOn(c, "reopen", "roma", T0.getTime()), "closed");
}
{
  // пришёл с опозданием кнопкой Пети, 2 минуты «Вернуть»
  const at = new Date(T0.getTime() + 22 * 60_000);
  const t = timer({
    status: "ARRIVED",
    arrivedAt: at,
    arrivedVia: "button",
    arrivedById: "petya",
    lateSec: 420,
    lateVsOriginalSec: 420,
    closedAt: at,
    reopenUntil: new Date(at.getTime() + 120_000),
    reopenBy: ["petya", "roma", "owner"],
    rev: 3,
  });
  const c = buildPromiseCard(t, people, at);
  assert.equal(c.state, "arrived");
  assert.equal(c.closed, true);
  assert.equal(c.rev, 3);
  assert.deepEqual(c.actions.map((a) => a.id), ["reopen"]);
  const d = c.data as Record<string, any>;
  assert.equal(d.outcome.kind, "late");
  assert.equal(d.outcome.deltaSec, 420);
  assert.equal(d.outcome.via, "button");
  assert.deepEqual(d.outcome.by, { id: "petya", displayName: "Петя" });
  assert.equal(canActOn(c, "reopen", "petya", at.getTime() + 60_000), "ok");
  assert.equal(canActOn(c, "reopen", "vasya", at.getTime() + 60_000), "forbidden");
  assert.equal(canActOn(c, "reopen", "petya", at.getTime() + 121_000), "expired");
  assert.match(promiseFallbackText({ status: "ARRIVED", promiserName: "Козёл Ебаный", quote: "15мин", deadlineAt: t.deadlineAt, extensionCount: 1, arrivedAt: at, lateSec: 420, now: at }), /^⌛ \*\*Козёл Ебаный\*\* опоздал на 7 мин — пришёл в 14:22 МСК \(срок 14:15\)\. Продлевал 1 раз\.$/);
}
{
  // вошёл в звонок вовремя — «Вернуть» нет, by нет
  const at = new Date(T0.getTime() + 12 * 60_000);
  const c = buildPromiseCard(timer({ status: "ARRIVED", arrivedAt: at, arrivedVia: "call", lateSec: -180, lateVsOriginalSec: -180, closedAt: at }), people, at);
  assert.deepEqual(c.actions, []);
  const d = c.data as Record<string, any>;
  assert.equal(d.outcome.kind, "onTime");
  assert.equal(d.outcome.by, null);
  assert.equal(
    promiseFallbackText({ status: "ARRIVED", promiserName: "Козёл Ебаный", quote: "15мин", deadlineAt: new Date(T0.getTime() + 15 * 60_000), extensionCount: 0, arrivedAt: at, lateSec: -180, now: at }),
    "✅ **Козёл Ебаный** пришёл вовремя — 14:12 МСК, запас 3 мин. Обещал «15мин»."
  );
}
{
  // отменён, цитата удалена, слова спросившего, пояс обещавшего
  const c = buildPromiseCard(
    timer({ status: "CANCELLED", cancelledById: "roma", closedAt: T0, quote: null, quoteById: "roma", reopenUntil: new Date(T0.getTime() + 120_000), reopenBy: ["roma"] }),
    { ...people, promiserZone: "Asia/Krasnoyarsk" },
    T0
  );
  const d = c.data as Record<string, any>;
  assert.equal(c.state, "cancelled");
  assert.deepEqual(d.cancelledBy, { id: "roma", displayName: "Рома" });
  assert.equal(d.quote.deleted, true);
  assert.deepEqual(d.quote.by, { id: "roma", displayName: "Рома" });
  assert.equal(d.promiserZone, "Asia/Krasnoyarsk");
  assert.deepEqual(d.reopen.by, ["roma"]);
}
// запасные тексты
{
  const base = { promiserName: "Козёл Ебаный", quote: "15мин", deadlineAt: new Date(T0.getTime() + 15 * 60_000), extensionCount: 0, arrivedAt: null, lateSec: null };
  assert.equal(promiseFallbackText({ ...base, status: "RUNNING", now: T0 }), "⏱ Таймер: **Козёл Ебаный** обещал «15мин» — жду до 14:15 МСК.\nЖивой таймер — в новой версии Еблуши.");
  assert.equal(promiseFallbackText({ ...base, status: "RUNNING", extensionCount: 1, deadlineAt: new Date(T0.getTime() + 25 * 60_000), now: T0 }), "⏱ Таймер: **Козёл Ебаный** — жду до 14:25 МСК (продлевал 1 раз). Обещал «15мин».");
  assert.equal(promiseFallbackText({ ...base, status: "RUNNING", now: new Date(T0.getTime() + 16 * 60_000) }), "⏰ **Козёл Ебаный** опаздывает — срок был 14:15 МСК. Обещал «15мин».");
  assert.equal(promiseFallbackText({ ...base, status: "CANCELLED", now: T0 }), "Таймер для **Козёл Ебаный** отменён.");
  assert.equal(promiseFallbackText({ ...base, status: "UNRESOLVED", now: T0 }), "Таймер для **Козёл Ебаный** остановлен: никто не отметил приход (срок был 14:15 МСК).");
  assert.equal(quoteShort(null), "(сообщение удалено)");
  assert.equal(quoteShort("а".repeat(80)).length, 62);
  assert.equal(durationRu(42), "42 с");
  assert.equal(durationRu(72 * 60), "1 ч 12 мин");
  // напоминания по кругу, имя жирным, без грубостей
  const r0 = [0, 1, 2, 3].map((i) => reminderText(0, i, "Вася", "15 мин"));
  assert.equal(r0[0], "**Вася**, время вышло ⏰ Ждём!");
  assert.equal(r0[3], r0[0]);
  assert.notEqual(r0[0], r0[1]);
  assert.match(reminderText(15, 0, "Вася", "15 мин"), /\+15/);
  assert.match(reminderText(30, 2, "Вася", "15 мин"), /Больше не напоминаю/);
}
console.log("ok: таймер — конверт, права, тексты, напоминания");

// ---------- «поделиться»: периоды ----------
{
  const iso = (d: Date) => d.toISOString();
  let p = periodStarts(new Date("2026-10-11T10:40:00Z"), "Europe/Moscow"); // вс 13:40 МСК
  assert.equal(iso(p.today), "2026-10-11T02:00:00.000Z");
  assert.equal(iso(p.week), "2026-10-05T02:00:00.000Z");
  p = periodStarts(new Date("2026-10-11T01:00:00Z"), "Europe/Moscow"); // вс 04:00 МСК — ещё «вчера»
  assert.equal(iso(p.today), "2026-10-10T02:00:00.000Z");
  assert.equal(iso(p.week), "2026-10-05T02:00:00.000Z");
  p = periodStarts(new Date("2026-10-12T01:00:00Z"), "Europe/Moscow"); // пн 04:00 МСК — неделя прошлая
  assert.equal(iso(p.today), "2026-10-11T02:00:00.000Z");
  assert.equal(iso(p.week), "2026-10-05T02:00:00.000Z");
  p = periodStarts(new Date("2026-10-12T03:00:00Z"), "Europe/Moscow"); // пн 06:00 МСК — новая неделя
  assert.equal(iso(p.today), "2026-10-12T02:00:00.000Z");
  assert.equal(iso(p.week), "2026-10-12T02:00:00.000Z");
  p = periodStarts(new Date("2026-10-11T10:40:00Z"), "Asia/Krasnoyarsk"); // 17:40 KRAT
  assert.equal(iso(p.today), "2026-10-10T22:00:00.000Z");
  assert.equal(iso(p.week), "2026-10-04T22:00:00.000Z");
  p = periodStarts(new Date("2026-10-25T10:00:00Z"), "Europe/Bucharest"); // после перевода на зимнее (EET)
  assert.equal(iso(p.today), "2026-10-25T03:00:00.000Z");
  assert.equal(iso(p.week), "2026-10-19T02:00:00.000Z");
  p = periodStarts(new Date("2026-10-11T10:40:00Z"), "Bad/Zone");
  assert.equal(iso(p.today), "2026-10-11T02:00:00.000Z", "неизвестный пояс — МСК");
}
console.log("ok: «поделиться» — периоды в поясах (5 утра, понедельник, перевод часов)");

// ---------- «поделиться»: карточка и тексты ----------
function share(over: Partial<BotShare> = {}): BotShare {
  return {
    id: "s1",
    createdAt: T0,
    updatedAt: T0,
    conversationId: "c1",
    cardMessageId: "m2",
    triggerMessageId: "q1",
    askerId: "roma",
    status: "PENDING",
    zone: "Europe/Moscow",
    options: [
      { period: "today", from: "2026-10-11T02:00:00.000Z", messages: 34, photos: 3, photosUsed: 3, enabled: true, off: null, capped: false },
      { period: "week", from: "2026-10-05T02:00:00.000Z", messages: 128, photos: 18, photosUsed: 18, enabled: true, off: null, capped: false },
      { period: "all", from: null, messages: 1738, photos: 337, photosUsed: 60, enabled: false, off: "too_big", capped: false },
    ] as unknown as Prisma.JsonValue,
    suggestPeriod: "today",
    suggestPhotos: false,
    note: null,
    period: null,
    includePhotos: false,
    periodFrom: null,
    pendingUntil: new Date(T0.getTime() + 30 * 60_000),
    decidedAt: null,
    decidedById: null,
    until: null,
    endedAt: null,
    endReason: null,
    endedById: null,
    answerMessageIds: [],
    answers: 0,
    readMessages: null,
    readPhotos: null,
    usd: null,
    rev: 1,
    ...over,
  } as BotShare;
}
{
  const c = buildShareCard(share(), names);
  assert.equal(c.type, "share");
  assert.equal(c.state, "pending");
  assert.deepEqual(c.actions.map((a) => [a.id, a.who, a.until]), [
    ["share", { ids: ["roma"] }, "2026-10-11T11:30:00.000Z"],
    ["decline", { ids: ["roma"] }, "2026-10-11T11:30:00.000Z"],
  ]);
  const d = c.data as Record<string, any>;
  assert.deepEqual(d.asker, { id: "roma", displayName: "Рома" });
  assert.deepEqual(d.suggest, { period: "today", photos: false });
  assert.equal(d.options.length, 3);
  assert.equal(d.options[2].enabled, false);
  assert.equal(d.options[2].off, "too_big");
  assert.equal(d.options[2].photosUsed, 60);
  assert.equal(canActOn(c, "share", "petya", T0.getTime()), "forbidden");
  assert.equal(canActOn(c, "share", "roma", T0.getTime() + 31 * 60_000), "expired");
  assert.match(shareFallbackText(share(), names), /^🔒 Чтобы ответить, мне нужно почитать переписку этой беседы\. \*\*Рома\*\*, поделиться\?\nОтветь на это сообщение/);
  const until = new Date(T0.getTime() + 60 * 60_000);
  const g = share({ status: "GRANTED", period: "today", includePhotos: true, decidedAt: T0, decidedById: "roma", until, rev: 2 });
  const gc = buildShareCard(g, names);
  assert.equal(gc.state, "granted");
  assert.deepEqual(gc.actions.map((a) => [a.id, a.who]), [["forget", { any: true }]]);
  assert.deepEqual((gc.data as any).choice, { period: "today", photos: true, by: { id: "roma", displayName: "Рома" }, at: T0.toISOString() });
  assert.equal(shareFallbackText(g, names), "🔒 **Рома** поделился перепиской за сегодня, с фото. Читаю…");
  const a = share({ ...g, answerMessageIds: ["ans1"], readMessages: 34, readPhotos: 3 });
  assert.equal((buildShareCard(a, names).data as any).answerMessageId, "ans1");
  assert.deepEqual((buildShareCard(a, names).data as any).read, { messages: 34, photos: 3 });
  assert.equal(shareFallbackText(a, names), "🔒 **Рома** поделился перепиской за сегодня, с фото. Доступ до 15:00 МСК.");
  const ended = share({ ...g, status: "ENDED", endedAt: until, endReason: "ended" });
  const ec = buildShareCard(ended, names);
  assert.equal(ec.closed, true);
  assert.deepEqual(ec.actions, []);
  assert.equal(shareFallbackText(ended, names), "🔒 **Рома** делился перепиской за сегодня, с фото. Доступ закончился в 15:00 МСК.");
  assert.equal(shareFallbackText(share({ status: "DECLINED", endReason: "declined", endedById: "roma" }), names), "🔒 **Рома** не стал делиться перепиской.");
  assert.equal(shareFallbackText(share({ status: "EXPIRED", endReason: "expired" }), names), "🔒 **Рома** не ответил — переписку не читаю.");
  assert.equal(shareFallbackText(share({ status: "EXPIRED", endReason: "question_deleted" }), names), "🔒 Вопрос удалили — переписку не читаю.");
  assert.equal(shareFallbackText(share({ status: "EXPIRED", endReason: "replaced" }), names), "🔒 Вопрос сменился — по этой карточке переписку не читаю.");
  assert.equal(shareFallbackText(share({ status: "REVOKED", endReason: "revoked", endedById: "petya" }), names), "🔒 Переписка забыта · попросил **Петя**.");
  assert.equal(shareFallbackText(share({ status: "REVOKED", endReason: "revoked", endedById: "roma" }), names), "🔒 **Рома** забрал разрешение.");
  const rev = buildShareCard(share({ status: "REVOKED", endReason: "revoked", endedById: "petya", endedAt: T0 }), names);
  assert.deepEqual((rev.data as any).endedBy, { reason: "revoked", by: { id: "petya", displayName: "Петя" }, at: T0.toISOString() });
  assert.match(shareFallbackText(share({ note: "too_big" }), names), /слишком много для моего лимита/);
}
console.log("ok: «поделиться» — карточка по состояниям, права, запасной текст");
console.log("bot cards unit: ok");
process.exit(0);
