import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanNick, fuzzyCharacter, matchCharacter, parseLinkIntent, sameCharacter, shapeSkeleton, translitSkeleton } from "../../src/core/nick";

test("похожие буквы: IiApaCiOxa = ПАРАСЮХА", () => {
  assert.equal(shapeSkeleton("IiApaCiOxa"), "ПАРАСЮХА");
  assert.equal(shapeSkeleton("Парасюха"), "ПАРАСЮХА");
  assert.equal(sameCharacter("парасюха", "IiApaCiOxa"), true);
  assert.equal(sameCharacter("ПАРАСЮХА", "IiApaCiOxa"), true);
});

test("смешанная запись и транслит", () => {
  assert.equal(shapeSkeleton("РомаH"), "РОМАН");
  assert.equal(sameCharacter("Роман", "РомаH"), true);
  assert.equal(translitSkeleton("Kurolesska"), "КУРОЛЕССКА");
  assert.equal(sameCharacter("Куролесска", "Kurolesska"), true);
  assert.equal(sameCharacter("куралеска", "Куралеска"), true);
  assert.equal(sameCharacter("Ёжик", "ежик"), true);
  assert.equal(sameCharacter("Парасюха", "Куралеска"), false);
});

test("сопоставление со списком персонажей сервера", () => {
  const known = ["РомаH", "Куралеска", "IiApaCiOxa"];
  assert.deepEqual(matchCharacter("парасюха", known), { kind: "exact", character: "IiApaCiOxa" });
  assert.deepEqual(matchCharacter("Роман", known), { kind: "exact", character: "РомаH" });
  assert.deepEqual(matchCharacter("Вася", known), { kind: "none" });
  // «JI» = Л: два персонажа читаются одинаково — переспрашиваем
  assert.deepEqual(matchCharacter("Куралеска", [...known, "KYPAJIECKA"]), { kind: "ambiguous", candidates: ["Куралеска", "KYPAJIECKA"] });
  // без модели: одна правка в скелете (≥5 букв)
  assert.equal(fuzzyCharacter("Куролеска", known), "Куралеска");
  assert.equal(fuzzyCharacter("Рома", known), null); // коротко — только модель
});

test("фразы привязки", () => {
  const cases: Array<[string, unknown]> = [
    ["мой ник в игре Парасюха", { kind: "link_self", nick: "Парасюха" }],
    ["Мой ник в игре — «IiApaCiOxa».", { kind: "link_self", nick: "IiApaCiOxa" }],
    ["мой персонаж: Куралеска", { kind: "link_self", nick: "Куралеска" }],
    ["я — парасюха", { kind: "link_self", nick: "парасюха" }],
    ["я - РомаH", { kind: "link_self", nick: "РомаH" }],
    ["я в игре Куралеска", { kind: "link_self", nick: "Куралеска" }],
    ["в игре меня зовут Роман", { kind: "link_self", nick: "Роман" }],
    ["привяжи меня к Парасюха", { kind: "link_self", nick: "Парасюха" }],
    ["его ник в игре Парасюха", { kind: "link_other", nick: "Парасюха" }],
    ["она — Куралеска", { kind: "link_other", nick: "Куралеска" }],
    ["отвяжи меня", { kind: "unlink_self" }],
    ["кто я", { kind: "whoami" }],
  ];
  for (const [input, want] of cases) assert.deepEqual(parseLinkIntent(input), want, input);
});

test("обычные фразы — не привязка", () => {
  for (const s of ["я голоден", "я тут", "мой ник в игре", "что такое ник", "я — это длинная фраза про то как я провёл лето в деревне", "сколько стоит броня"]) {
    assert.equal(parseLinkIntent(s), null, s);
  }
});

test("cleanNick", () => {
  assert.equal(cleanNick(" «Парасюха»! "), "Парасюха");
  assert.equal(cleanNick("x"), null);
  assert.equal(cleanNick("https://evil"), null);
  assert.equal(cleanNick("один два три четыре"), null);
});
