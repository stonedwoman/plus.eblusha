import { test } from "node:test";
import assert from "node:assert/strict";
import { invocationText, isThanksOrLaugh, stripCommandPrefix, stripNamePrefix } from "../../src/core/invoke";

test("вызов по имени: запятая, двоеточие, восклицательный знак; регистр и ё не важны", () => {
  for (const [input, rest] of [
    ["Еблуша, какая погода?", "какая погода?"],
    ["еблуша: привет", "привет"],
    ["ЕБЛУША! помоги", "помоги"],
    ["Ёблуша, тест", "тест"],
    ["  Еблуша ,  с пробелом", "с пробелом"],
    ["@Еблуша, с собакой", "с собакой"],
    ["Eблуша, латинская E", "латинская E"],
    ["EBLUSHA, нет", null],
    ["Еблуша,\nс новой строки", "с новой строки"],
  ] as const) {
    assert.equal(stripNamePrefix(input), rest, input);
  }
});

test("без знака после имени или имя не в начале — не вызов", () => {
  for (const s of ["Еблуша привет", "Еблушаа, привет", "Привет, Еблуша!", "а еблуша, ты тут?", ""]) {
    assert.equal(stripNamePrefix(s), null, s);
    assert.equal(stripCommandPrefix(s), null, s);
  }
});

test("команда /eb и /еб (любой регистр — как на сервере)", () => {
  assert.equal(stripCommandPrefix("/eb расход"), "расход");
  assert.equal(stripCommandPrefix("/еб помощь"), "помощь");
  assert.equal(stripCommandPrefix("/EB кто"), "кто");
  assert.equal(stripCommandPrefix("/Еб кто"), "кто");
  assert.equal(stripCommandPrefix("/eb"), "");
  assert.equal(stripCommandPrefix("/ebx что-то"), null);
  assert.equal(stripCommandPrefix("текст /eb"), null);
});

test("текст вопроса: обращение срезается, остальное — как есть (ответ боту, «Чат с Еблушей»)", () => {
  assert.equal(invocationText("Еблуша, кто в игре?"), "кто в игре?");
  assert.equal(invocationText("/eb кто в игре"), "кто в игре");
  assert.equal(invocationText("  а подробнее?  "), "а подробнее?");
  assert.equal(invocationText(null), "");
});

test("спасибо/смех → реакция", () => {
  for (const s of ["Спасибо!", "спс", "спасибо большое 🙏", "ахахах", "ХАХАХА", "😂😂", "👍", "лол", "пасиб бро", "Thanks!", "ору", "красава, спасибо"]) {
    assert.equal(isThanksOrLaugh(s), true, s);
  }
});

test("вопрос или просьба — не благодарность", () => {
  for (const s of ["спасибо, а сколько стоит?", "спасибо, теперь расскажи про репу", "ок", "понятно", "а почему так", "", "хорошо, давай дальше про броню", "спасибо".repeat(10)]) {
    assert.equal(isThanksOrLaugh(s), false, s);
  }
});
