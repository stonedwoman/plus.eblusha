/**
 * Летопись сервера (src/modules/valheim/history.ts, инструмент valheim_history): разбор выжимки
 * history-bot.json (синтетическая копия формата — test/fixtures/valheim/history-bot.json), темы, «кто это»,
 * вечера по словам, мир Koban по умолчанию и архив по просьбе, приватность как у остальных инструментов
 * Valheim, перечитывание атомарно заменённого файла, подключение к модулю. Сети и модели нет.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateInput } from "../../../src/core/registry";
import { createValheimModule } from "../../../src/modules/valheim";
import { loadValheimConfig } from "../../../src/modules/valheim/config";
import {
  createHistoryTool,
  eveningOf,
  HISTORY_MAX_CHARS,
  historyFile,
  parseEveningDate,
  resolveWho,
  slim,
  type HistoryFile,
} from "../../../src/modules/valheim/history";
import { CFG, fakeServer, makeCtx, makeWorld, text } from "./vhfakes";

const FIXTURE = path.resolve(process.cwd(), "test/fixtures/valheim/history-bot.json");
const fixed: HistoryFile = { load: () => JSON.parse(fs.readFileSync(FIXTURE, "utf8")) };
const tool = createHistoryTool({ file: fixed });

const ROMA = { characters: ["РомаH"] };
const SANYA = { characters: ["IiApaCiOxa"] };

async function run(input: Record<string, unknown>, ctx = makeCtx(ROMA)) {
  const err = validateInput(input, tool.inputSchema);
  assert.equal(err, null, `схема: ${err}`);
  return tool.run(input as never, ctx);
}
function json(r: unknown): any {
  const s = text(r);
  return JSON.parse(s);
}

test("схема: строгая, имя valheim_history, темы и мир — enum", () => {
  assert.equal(tool.name, "valheim_history");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ["topic"]);
  assert.match(tool.description, /Valheim/);
  assert.match(validateInput({ topic: "gossip" }, tool.inputSchema)!, /одно из/);
  assert.match(validateInput({ topic: "world", world: "santonoma" }, tool.inputSchema)!, /одно из/);
  assert.equal(validateInput({ topic: "evening", date: "вчера" }, tool.inputSchema), null);
});

test("игрок «я»: свои цифры Koban, свои персонажи, без архива; результат недоверенный", async () => {
  const r = await run({ topic: "player" });
  assert.equal(typeof r === "object" && r.untrusted, true);
  const o = json(r);
  assert.equal(o.человек, "roma");
  assert.equal(o.koban.sessions, 12);
  assert.deepEqual(
    o.персонажи_подробно.map((c: any) => c.name),
    ["РомаH", "Odev"]
  );
  assert.equal(o.смерти_сводка.deaths, 20);
  assert.match(o.летопись, /Koban/);
  assert.doesNotMatch(text(r), /santonoma|Pomаh/, "архив — только по просьбе");
  // время — местное коротко, без utc и src
  assert.doesNotMatch(text(r), /"utc"|"src"/);
  assert.match(text(r), /2026-10-10 17:52/);
});

test("игрок по имени: похожие буквы, прозвище, начало имени, человек Еблуши; неизвестный — список", async () => {
  assert.equal(json(await run({ topic: "player", who: "Парасюха" })).человек, "Саня Тест");
  assert.equal(json(await run({ topic: "player", who: "IiApaCiOxa" })).человек, "Саня Тест");
  assert.equal(json(await run({ topic: "player", who: "Куралеска" })).человек, "valya");
  assert.equal(json(await run({ topic: "player", who: "Рома" })).человек, "roma");
  assert.equal(json(await run({ topic: "player", who: "valya" })).человек, "valya");
  const unk = text(await run({ topic: "player", who: "Гендальф" }));
  assert.match(unk, /нет такого игрока/);
  assert.match(unk, /«roma»/);
});

test("«я» у непривязанного — подсказка привязки; «я» по имени в Еблуше, если персонаж ещё не в выжимке", async () => {
  const h = fixed.load()!;
  assert.equal(resolveWho("я", makeCtx({}), h).kind, "unlinked");
  const ctx = makeCtx({ characters: ["НовыйПерс"] });
  ctx.requester.displayName = "valya";
  const w = resolveWho("", ctx, h);
  assert.deepEqual(w, { kind: "person", id: "valya", character: null });
  // но непривязанному по одному лишь имени — нет
  const anon = makeCtx({ isOwner: false });
  anon.requester.displayName = "valya";
  assert.equal(resolveWho("я", anon, h).kind, "unlinked");
});

test("смерти: сводка сервера и по человеку — только его персонажи, вечера, серии, места", async () => {
  const all = json(await run({ topic: "deaths" }));
  assert.equal(all.смерти.total, 33);
  const v = json(await run({ topic: "deaths", who: "Куралеска" }));
  assert.equal(v.человек, "valya");
  assert.deepEqual(v.его_персонажи, ["Куралеска"]);
  assert.equal(v.сводка.deaths, 9);
  assert.deepEqual(v.самые_смертельные_вечера, [{ вечер: "2026-10-04", всего: 12, его: 3 }]);
  assert.equal(v.серии.length, 1);
  assert.equal(v.серии[0].character, "Куралеска");
  assert.equal(v.известные_места[0].biome_ru, "Пепельные земли");
  assert.deepEqual(v.по_месяцам["2026-09"], { Куралеска: 8 });
});

test("вечер: по дате, словами относительно «сейчас», последний; набег после полуночи — к тому же вечеру", async () => {
  // makeCtx: now = 2026-10-10T12:00Z (15:00 по Бухаресту) → «сегодня» = 2026-10-10, «вчера» = 2026-10-09
  const now = new Date("2026-10-10T12:00:00Z");
  assert.equal(parseEveningDate("сегодня", now), "2026-10-10");
  assert.equal(parseEveningDate("вчера", now), "2026-10-09");
  assert.equal(parseEveningDate("04.10", now), "2026-10-04");
  assert.equal(parseEveningDate("4.10.2026", now), "2026-10-04");
  assert.equal(parseEveningDate("2026-10-4", now), "2026-10-04");
  assert.equal(parseEveningDate("", now), "last");
  assert.equal(parseEveningDate("последний вечер", now), "last");
  assert.equal(parseEveningDate("в пятницу", now), null);
  // 01:30 по Бухаресту 05.10 — ещё вечер 04.10
  assert.equal(eveningOf(Date.parse("2026-10-04T22:30:00Z")), "2026-10-04");

  const e = json(await run({ topic: "evening", date: "04.10" }));
  assert.equal(e.вечер.date, "2026-10-04");
  assert.equal(e.вечер.deaths, 12);
  assert.deepEqual(Object.keys(e.по_людям).sort(), ["roma", "valya", "Саня Тест"].sort());
  assert.equal(e.по_людям.roma.часы, 5.5);
  assert.deepEqual(
    e.набеги.map((r: any) => r.id),
    ["army_charred"]
  );
  assert.equal(e.смерти_вечера.deaths, 12);
  assert.deepEqual(
    e.боссы_в_окне.map((b: any) => b.босс),
    ["Королева"]
  );
  assert.equal(e.ключи_мира_в_окне[0].что, "Зил и Тангр убиты");

  const last = json(await run({ topic: "evening" }));
  assert.equal(last.вечер.date, "2026-10-10");
  const none = json(await run({ topic: "evening", date: "вчера" }));
  assert.equal(none.вечер, "2026-10-09");
  assert.match(none.нет_данных, /никто не играл/);
  assert.ok(none.ближайшие_вечера.includes("2026-10-10"));
  const bad = json(await run({ topic: "evening", date: "в пятницу" }));
  assert.equal(bad.не_понял_дату, "в пятницу");
});

test("мир Koban по умолчанию; старый мир santonoma — только world=archive", async () => {
  const w = json(await run({ topic: "world" }));
  assert.equal(w.сервер.world_now, "Koban");
  assert.equal(w.набеги.всего, 2);
  assert.doesNotMatch(JSON.stringify(w), /santonoma/);
  const a = json(await run({ topic: "world", world: "archive" }));
  assert.match(a.летопись, /santonoma/);
  assert.equal(a.мир.name, "santonoma");
  const ap = json(await run({ topic: "player", world: "archive" }));
  assert.equal(ap.статистика.sessions, 18);
  assert.equal(ap.за_всё_время_оба_мира.sessions, 30, "«за всё время» — только в архивном ответе");
  assert.deepEqual(
    ap.персонажи_подробно.map((c: any) => c.name),
    ["Pomаh"]
  );
  const sp = json(await run({ topic: "player", who: "Парасюха", world: "archive" }));
  assert.match(sp.нет_данных, /не играл/);
  const f = json(await run({ topic: "facts" }));
  assert.equal(f.факты.length, 2);
  assert.equal(f.факты[1].conf, "medium");
  assert.equal(f.чего_нет_в_данных.length, 2);
  const b = json(await run({ topic: "bosses" }));
  assert.equal(b.боссы[0].босс, "Эйктюр");
  assert.deepEqual(b.боссы[0].не_раньше, { время: "2026-09-11 19:20", основание: "набег" });
  assert.deepEqual(b.боссы[0].не_позже, { время: "2026-09-12 12:40", основание: "снимок мира: ключ уже есть" });
  assert.equal(b.боссы[0].online_in_window.length, 2);
});

test("приватность: непривязанному — только мир и боссы, без людей; игроку в группе с непривязанными — отказ", async () => {
  const anon = makeCtx({});
  for (const topic of ["player", "deaths", "evening", "facts"]) {
    const r = text(await run({ topic }, anon));
    assert.match(r, /Привяжи свой ник/, topic);
  }
  const w = text(await run({ topic: "world" }, anon));
  for (const name of ["РомаH", "Куралеска", "IiApaCiOxa", "roma", "valya", "Саня"]) assert.doesNotMatch(w, new RegExp(name), `мир без «${name}»`);
  assert.match(w, /Koban/);
  const b = text(await run({ topic: "bosses" }, anon));
  assert.match(b, /Эйктюр/);
  for (const name of ["РомаH", "Куралеска", "roma", "valya"]) assert.doesNotMatch(b, new RegExp(name), `боссы без «${name}»`);
  // игрок, но ответ увидят непривязанные
  const grp = makeCtx({ characters: ["РомаH"], kind: "group", playerDataOk: false });
  assert.match(text(await run({ topic: "player" }, grp)), /не привязанные к игровому персонажу/);
  assert.doesNotMatch(text(await run({ topic: "bosses" }, grp)), /РомаH/);
  // в личке двух игроков — можно
  assert.equal(json(await run({ topic: "player" }, makeCtx({ characters: ["РомаH"], kind: "dm", playerDataOk: true }))).человек, "roma");
});

test("slim: {utc,local} → местное коротко, без src; personal=false убирает людей", () => {
  const o = slim({ at: { utc: "2026-10-04T16:16:43Z", local: "2026-10-04T19:16:43+03:00" }, src: ["x"], start_local: "2026-09-12T14:46:33+03:00", by_character: { A: 1 }, sleeps_by_character: { A: 2 }, n: 1 }, false);
  assert.deepEqual(o, { at: "2026-10-04 19:16", start_local: "2026-09-12 14:46", n: 1 });
});

test("файл: нет — честный отказ; атомарная замена — перечитывается; битый — остаётся прежний", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-history-"));
  try {
    const p = path.join(dir, "history-bot.json");
    const src = historyFile(p);
    const t = createHistoryTool({ file: src });
    const r0 = await t.run({ topic: "facts" }, makeCtx(ROMA));
    assert.equal(typeof r0 === "object" && r0.isError, true);
    assert.match(text(r0), /недоступна/);

    const base = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const write = (o: unknown) => {
      fs.writeFileSync(`${p}.new`, JSON.stringify(o));
      fs.renameSync(`${p}.new`, p);
    };
    write(base);
    assert.equal(JSON.parse(text(await t.run({ topic: "facts" }, makeCtx(ROMA)))).факты.length, 2);
    base.facts.push({ id: "new", text: "Новый факт после пересборки", conf: "high" });
    write(base);
    const later = Date.now() / 1000 + 5;
    fs.utimesSync(p, later, later);
    assert.equal(JSON.parse(text(await t.run({ topic: "facts" }, makeCtx(ROMA)))).факты.length, 3);
    // полузаписанный файл — прежние данные, а не падение
    fs.writeFileSync(p, "{\"schema\": \"valheim-history/bot-export v1\", \"facts\": [");
    const later2 = later + 5;
    fs.utimesSync(p, later2, later2);
    assert.equal(JSON.parse(text(await t.run({ topic: "facts" }, makeCtx(ROMA)))).факты.length, 3);
    // чужой формат — не принимаем
    write({ schema: "something-else", facts: [] });
    const later3 = later2 + 5;
    fs.utimesSync(p, later3, later3);
    assert.equal(JSON.parse(text(await t.run({ topic: "facts" }, makeCtx(ROMA)))).факты.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ответ не больше потолка: длинная выжимка обрезается с пометкой", async () => {
  const big = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  big.facts = Array.from({ length: 400 }, (_, i) => ({ id: `f${i}`, text: `Факт номер ${i} `.repeat(5), conf: "high" }));
  const t = createHistoryTool({ file: { load: () => big } });
  const s = text(await t.run({ topic: "facts" }, makeCtx(ROMA)));
  assert.ok(s.length <= HISTORY_MAX_CHARS + 80, String(s.length));
  assert.match(s, /обрезано/);
});

test("модуль: инструмент и строка промпта есть только при VALHEIM_HISTORY_FILE; по умолчанию — путь в контейнере", () => {
  assert.equal(loadValheimConfig({}).historyFile, "/valheim-history/history-bot.json");
  assert.equal(loadValheimConfig({ VALHEIM_HISTORY_FILE: "" }).historyFile, null);
  const off = createValheimModule({ cfg: { ...CFG, agentUrl: null }, world: makeWorld(fakeServer()), agent: null });
  assert.ok(!off.tools!.some((t) => t.name === "valheim_history"));
  assert.doesNotMatch(off.systemPrompt!, /valheim_history/);
  const on = createValheimModule({ cfg: { ...CFG, agentUrl: null, historyFile: "/nowhere.json" }, world: makeWorld(fakeServer()), agent: null, historyFile: fixed });
  assert.ok(on.tools!.some((t) => t.name === "valheim_history"));
  assert.match(on.systemPrompt!, /valheim_history/);
});
