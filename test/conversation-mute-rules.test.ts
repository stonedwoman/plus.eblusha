/**
 * «Без звука» — юнит-тест чистых правил (src/lib/conversationMuteRules.ts). Ни БД, ни Redis, ни сети:
 *   node_modules/.bin/ts-node test/conversation-mute-rules.test.ts
 * Тест-векторы те же, что у клиентов (веб/натив/Android/iOS) — docs/conversation-mute.md, раздел «Правила».
 */
import assert from "node:assert/strict";
import {
  MUTE_FOREVER,
  MUTE_PRESETS,
  effectiveUntil,
  isCallSystemMessage,
  isForever,
  isMutedAt,
  muteView,
  normalizeUntil,
  parseMuteBody,
  resolveMuteRequest,
  shouldAlert,
  untilForPreset,
} from "../src/lib/conversationMuteRules";

const results: { name: string; ok: boolean; err?: string }[] = [];
function step(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message ?? String(e) });
    console.log(`  FAIL ${name}: ${e?.message ?? e}`);
  }
}

const NOW = Date.parse("2026-10-11T15:30:00.000Z");
const at = (ms: number) => new Date(NOW + ms);
const ME = "me";
const OTHER = "other";
const muted = at(3_600_000);

step("isMutedAt: null → нет; now+1ms → да; now → нет (строго); прошлое → нет; мусор → нет", () => {
  assert.equal(isMutedAt(null, NOW), false);
  assert.equal(isMutedAt(undefined, NOW), false);
  assert.equal(isMutedAt(at(1), NOW), true);
  assert.equal(isMutedAt(at(0), NOW), false);
  assert.equal(isMutedAt(at(-1), NOW), false);
  assert.equal(isMutedAt(new Date(NaN), NOW), false);
});

step("FOREVER: заглушено, isForever, ISO 2100-01-01T00:00:00.000Z", () => {
  assert.equal(MUTE_FOREVER.toISOString(), "2100-01-01T00:00:00.000Z");
  assert.equal(isMutedAt(MUTE_FOREVER, NOW), true);
  assert.equal(isForever(MUTE_FOREVER), true);
  assert.equal(isForever(new Date("2099-12-31T00:00:00.000Z")), true, "порог «навсегда» — 2099-12-31");
  assert.equal(isForever(new Date("2099-12-30T23:59:59.999Z")), false);
  assert.equal(isForever(muted), false);
  assert.equal(isForever(null), false);
});

step("normalizeUntil: ≤ now → null; ≤ now+366 сут — как есть; дальше → FOREVER", () => {
  assert.equal(normalizeUntil(null, NOW), null);
  assert.equal(normalizeUntil(at(0), NOW), null);
  assert.equal(normalizeUntil(at(-5_000), NOW), null);
  assert.equal(normalizeUntil(at(1), NOW)?.getTime(), NOW + 1);
  const span = 366 * 86_400_000;
  assert.equal(normalizeUntil(at(span), NOW)?.getTime(), NOW + span);
  assert.equal(normalizeUntil(at(span + 1), NOW)?.toISOString(), MUTE_FOREVER.toISOString());
  assert.equal(normalizeUntil(new Date("2300-01-01T00:00:00Z"), NOW)?.toISOString(), MUTE_FOREVER.toISOString());
  assert.equal(normalizeUntil(new Date(NaN), NOW), null);
});

step("пресеты: 1h/8h/1d/1w от часов сервера; forever → FOREVER", () => {
  assert.equal(untilForPreset("1h", NOW).getTime(), NOW + 3_600_000);
  assert.equal(untilForPreset("8h", NOW).getTime(), NOW + 8 * 3_600_000);
  assert.equal(untilForPreset("1d", NOW).getTime(), NOW + 86_400_000);
  assert.equal(untilForPreset("1w", NOW).getTime(), NOW + 7 * 86_400_000);
  assert.equal(untilForPreset("forever", NOW).toISOString(), "2100-01-01T00:00:00.000Z");
  assert.deepEqual(Object.keys(MUTE_PRESETS), ["1h", "8h", "1d", "1w"]);
});

step("muteView/effectiveUntil: истёкший → null/false; действующий → ISO; FOREVER → mutedForever", () => {
  assert.deepEqual(muteView(null, NOW), { mutedUntil: null, mutedForever: false });
  assert.deepEqual(muteView(at(-1), NOW), { mutedUntil: null, mutedForever: false });
  assert.deepEqual(muteView(at(0), NOW), { mutedUntil: null, mutedForever: false });
  assert.deepEqual(muteView(muted, NOW), { mutedUntil: muted.toISOString(), mutedForever: false });
  assert.deepEqual(muteView(MUTE_FOREVER, NOW), { mutedUntil: "2100-01-01T00:00:00.000Z", mutedForever: true });
  assert.equal(effectiveUntil(at(-1), NOW), null);
  assert.equal(effectiveUntil(muted, NOW)?.getTime(), muted.getTime());
});

step("isCallSystemMessage: SYSTEM + missed/ended — да; started, участники, обычный текст — нет", () => {
  assert.equal(isCallSystemMessage({ type: "SYSTEM", metadata: { missed: true } }), true);
  assert.equal(isCallSystemMessage({ type: "SYSTEM", metadata: { ended: true, duration: 5 } }), true);
  assert.equal(isCallSystemMessage({ type: "SYSTEM", metadata: { started: true } }), false);
  assert.equal(isCallSystemMessage({ type: "SYSTEM", metadata: { action: "participant_left" } }), false);
  assert.equal(isCallSystemMessage({ type: "TEXT", metadata: { missed: true } }), false);
  assert.equal(isCallSystemMessage({ type: "SYSTEM", metadata: null }), false);
  assert.equal(isCallSystemMessage({ type: "SYSTEM", metadata: [1] }), false);
  assert.equal(isCallSystemMessage(null), false);
});

const base = { nowMs: NOW, recipientId: ME };
step("shouldAlert: не заглушено → да (группа, 1:1, любые сообщения)", () => {
  assert.equal(shouldAlert({ ...base, mutedUntil: null, isGroup: true }), true);
  assert.equal(shouldAlert({ ...base, mutedUntil: null, isGroup: false }), true);
  assert.equal(shouldAlert({ ...base, mutedUntil: at(-1), isGroup: true }), true, "истёкший срок = не заглушено");
});
step("shouldAlert: группа + ответ на МОЁ (от человека или бота) → да; на чужое → нет", () => {
  assert.equal(shouldAlert({ ...base, mutedUntil: muted, isGroup: true, replyToSenderId: ME }), true);
  assert.equal(shouldAlert({ ...base, mutedUntil: muted, isGroup: true, replyToSenderId: OTHER }), false);
  assert.equal(shouldAlert({ ...base, mutedUntil: MUTE_FOREVER, isGroup: true, replyToSenderId: ME }), true, "навсегда — тоже");
});
step("shouldAlert: группа + «начал звонок» / «звонок продлился» / обычное → нет", () => {
  assert.equal(shouldAlert({ ...base, mutedUntil: muted, isGroup: true }), false);
  assert.equal(shouldAlert({ ...base, mutedUntil: muted, isGroup: true, callSystem: true }), false);
});
step("shouldAlert: группа + @упоминание меня (на будущее) → да; другого → нет", () => {
  assert.equal(shouldAlert({ ...base, mutedUntil: muted, isGroup: true, mentionedUserIds: [OTHER, ME] }), true);
  assert.equal(shouldAlert({ ...base, mutedUntil: muted, isGroup: true, mentionedUserIds: [OTHER] }), false);
});
step("shouldAlert: 1:1 / «Чат с Еблушей» / секретка + ответ на моё → нет", () => {
  assert.equal(shouldAlert({ ...base, mutedUntil: muted, isGroup: false, replyToSenderId: ME }), false);
  assert.equal(shouldAlert({ ...base, mutedUntil: muted, isGroup: false }), false);
});
step("shouldAlert: 1:1 + SYSTEM missed / ended → да (звонок 1:1 не глушится)", () => {
  assert.equal(
    shouldAlert({ ...base, mutedUntil: muted, isGroup: false, callSystem: isCallSystemMessage({ type: "SYSTEM", metadata: { missed: true } }) }),
    true,
  );
  assert.equal(
    shouldAlert({ ...base, mutedUntil: muted, isGroup: false, callSystem: isCallSystemMessage({ type: "SYSTEM", metadata: { ended: true } }) }),
    true,
  );
});

step("parseMuteBody: пресеты и until (ISO с Z и со смещением, null)", () => {
  for (const p of ["1h", "8h", "1d", "1w", "forever"]) {
    assert.deepEqual(parseMuteBody({ for: p }), { kind: "preset", preset: p });
  }
  assert.deepEqual(parseMuteBody({ until: null }), { kind: "until", until: null });
  const z = parseMuteBody({ until: "2026-10-11T18:30:00Z" });
  assert.equal(z?.kind, "until");
  assert.equal(z && z.kind === "until" ? z.until?.toISOString() : "", "2026-10-11T18:30:00.000Z");
  const off = parseMuteBody({ until: "2026-10-11T21:30:00.000+03:00" });
  assert.equal(off && off.kind === "until" ? off.until?.toISOString() : "", "2026-10-11T18:30:00.000Z");
  assert.deepEqual(parseMuteBody({ for: "1h", deviceId: "x" }), { kind: "preset", preset: "1h" }, "посторонние поля не мешают");
});
step("parseMuteBody: мусор → null (400)", () => {
  const bad: unknown[] = [
    null,
    undefined,
    "1h",
    [],
    {},
    { for: "2d" },
    { for: "" },
    { for: null },
    { for: 1 },
    { for: "1h", until: null },
    { until: "tomorrow" },
    { until: "2026-10-11" },
    { until: "2026-10-11T18:30:00" },
    { until: 1_700_000_000_000 },
    { until: "2026-13-45T99:99:00Z" },
    { until: "x".repeat(100) },
  ];
  for (const b of bad) assert.equal(parseMuteBody(b), null, `должно быть отвергнуто: ${JSON.stringify(b)}`);
});
step("resolveMuteRequest: пресет — от now сервера; until — нормализуется", () => {
  assert.equal(resolveMuteRequest({ kind: "preset", preset: "1h" }, NOW)?.getTime(), NOW + 3_600_000);
  assert.equal(resolveMuteRequest({ kind: "until", until: at(-1) }, NOW), null);
  assert.equal(resolveMuteRequest({ kind: "until", until: null }, NOW), null);
  assert.equal(resolveMuteRequest({ kind: "until", until: at(600_000) }, NOW)?.getTime(), NOW + 600_000);
  assert.equal(resolveMuteRequest({ kind: "until", until: at(400 * 86_400_000) }, NOW)?.toISOString(), MUTE_FOREVER.toISOString());
});

const failed = results.filter((r) => !r.ok);
console.log(`\nconversation-mute-rules: ${results.length - failed.length}/${results.length} ok`);
for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
process.exit(failed.length ? 1 : 0);
