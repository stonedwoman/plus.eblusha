/**
 * Юнит: разбор времени обещания (src/lib/promiseTime.ts) на общих векторах test/fixtures/promise-time-vectors.json
 * + отдельные проверки (модельный spec, пояса, перевод часов). Без БД и сети:
 *   npx ts-node test/promise-time.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  durationLabel,
  normalizePromiseText,
  parsePromiseText,
  resolveDeadline,
  sanitizeSpec,
  zonedToUtc,
  zoneOffsetMin,
} from "../src/lib/promiseTime";

type Vector = {
  text: string;
  base: string;
  now?: string;
  zone: string;
  note?: string;
  expect: { deadlineAt?: string; label?: string; upperBound?: boolean; error?: string; zoneFromText?: boolean };
};

const file = path.join(__dirname, "fixtures", "promise-time-vectors.json");
const data = JSON.parse(fs.readFileSync(file, "utf8")) as { cases: Vector[] };
let failed = 0;
let passed = 0;
for (const v of data.cases) {
  const parsed = parsePromiseText(v.text);
  const r = resolveDeadline(parsed.spec, { base: new Date(v.base), zone: v.zone, now: new Date(v.now ?? v.base) });
  const got: Record<string, unknown> = r.ok
    ? { deadlineAt: r.deadlineAt.toISOString(), label: r.label, upperBound: r.upperBound, zoneFromText: r.zoneFromText }
    : { error: r.code, ...(r.deadlineAt ? { deadlineAt: r.deadlineAt.toISOString() } : {}) };
  const want: Record<string, unknown> = { ...v.expect };
  const mism: string[] = [];
  for (const [k, val] of Object.entries(want)) if (got[k] !== val) mism.push(`${k}: ждали ${JSON.stringify(val)}, получили ${JSON.stringify(got[k])}`);
  if (!r.ok && !want.error) mism.push(`ошибка ${r.code}`);
  if (r.ok && want.error) mism.push(`ждали ошибку ${want.error}`);
  if (mism.length) {
    failed++;
    console.log(`✗ «${v.text}» (${v.zone}, база ${v.base}) [${normalizePromiseText(v.text)}] spec=${JSON.stringify(parsed.spec)}\n    ${mism.join("\n    ")}`);
  } else passed++;
}
console.log(`векторы: ${passed} из ${data.cases.length}`);
assert.ok(data.cases.length >= 80, "векторов меньше 80");

// ---- отдельные проверки ----
const B = new Date("2026-10-11T10:40:00.000Z");
// модельный spec → тот же расчёт
const s1 = sanitizeSpec({ kind: "at", hour: 14, minute: 10, half: "unknown", day: "nearest" });
assert.ok(s1);
const r1 = resolveDeadline(s1!, { base: B, zone: "Europe/Moscow", now: B });
assert.ok(r1.ok && r1.deadlineAt.toISOString() === "2026-10-11T11:10:00.000Z", "в начале третьего → модель: 14:10");
assert.equal(sanitizeSpec({ kind: "in", minSec: -5, maxSec: 10 }), null);
assert.equal(sanitizeSpec({ kind: "at", hour: 25, minute: 0 }), null);
assert.equal(sanitizeSpec("x"), null);
// модель пишет час «как сказано» с частью суток (схема бота): 8 + pm = 20:00, 3 + pm завтра = 15:00, 12 + am = 00:00
{
  const at = (raw: Record<string, unknown>) => {
    const s = sanitizeSpec({ kind: "at", minute: 0, day: "nearest", ...raw });
    assert.ok(s);
    const r = resolveDeadline(s!, { base: B, zone: "Europe/Moscow", now: B });
    assert.ok(r.ok, JSON.stringify(raw));
    return r.ok ? r.deadlineAt.toISOString() : "";
  };
  assert.equal(at({ hour: 8, half: "pm" }), "2026-10-11T17:00:00.000Z", "«8 вечера» → 20:00 сегодня, а не завтра 08:00");
  assert.equal(at({ hour: 3, half: "pm", day: "tomorrow" }), "2026-10-12T12:00:00.000Z", "«завтра в 3 дня» → 15:00");
  assert.equal(at({ hour: 12, half: "am" }), "2026-10-11T21:00:00.000Z", "«12 ночи» → 00:00");
  assert.equal(at({ hour: 20, half: "pm" }), "2026-10-11T17:00:00.000Z", "уже 24-часовой час не трогаем");
  assert.equal(at({ hour: 12, half: "pm" }), "2026-10-12T09:00:00.000Z", "«12 дня» → полдень (сегодня прошёл — завтра)");
}
const s2 = sanitizeSpec({ kind: "in", minSec: 600, maxSec: 900 });
const r2 = resolveDeadline(s2!, { base: B, zone: "Europe/Moscow", now: B });
assert.ok(r2.ok && r2.upperBound && r2.deadlineAt.toISOString() === "2026-10-11T10:55:00.000Z");
// двусмысленное с подтверждением — ближайшее будущее
const amb = parsePromiseText("в два часа давай");
const r3 = resolveDeadline(amb.spec, { base: new Date("2026-10-11T12:10:00.000Z"), zone: "Europe/Moscow", now: new Date("2026-10-11T12:10:00.000Z"), confirmAmbiguous: true });
assert.ok(r3.ok && r3.deadlineAt.toISOString() === "2026-10-11T23:00:00.000Z", "«да, это 02:00» → 02:00");
// неизвестный пояс → МСК
const r4 = resolveDeadline(parsePromiseText("в 21:30").spec, { base: B, zone: "Mars/Olympus", now: B });
assert.ok(r4.ok && r4.deadlineAt.toISOString() === "2026-10-11T18:30:00.000Z");
// перевод часов: двойное 03:00 — первое, несуществующее 03:30 — вперёд
assert.equal(new Date(zonedToUtc(2026, 10, 25, 3, 0, "Europe/Bucharest")).toISOString(), "2026-10-25T00:00:00.000Z");
assert.equal(new Date(zonedToUtc(2026, 3, 29, 3, 30, "Europe/Bucharest")).toISOString(), "2026-03-29T01:30:00.000Z");
assert.equal(zoneOffsetMin(Date.parse("2026-10-11T10:40:00Z"), "Asia/Calcutta"), 330);
assert.equal(durationLabel(90 * 60), "1,5 ч");
assert.equal(durationLabel(150 * 60), "2 ч 30 мин");
assert.equal(durationLabel(45 * 60), "45 мин");

if (failed) {
  console.log(`ПРОВАЛ: ${failed} векторов`);
  process.exit(1);
}
console.log("ok promise-time");
