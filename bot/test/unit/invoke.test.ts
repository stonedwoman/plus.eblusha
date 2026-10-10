import { test } from "node:test";
import assert from "node:assert/strict";
import { isThanksOrLaugh, parseInvocation, stripCommandPrefix, stripNamePrefix } from "../../src/core/invoke";

const BOT = "bot1";
const base = { botId: BOT, isDm: false, dmWithoutPrefix: false };

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
    assert.equal(parseInvocation(s, base).kind, "none", s);
  }
});

test("команда /eb и /еб", () => {
  assert.equal(stripCommandPrefix("/eb расход"), "расход");
  assert.equal(stripCommandPrefix("/еб помощь"), "помощь");
  assert.equal(stripCommandPrefix("/eb"), "");
  assert.equal(stripCommandPrefix("/ebx что-то"), null);
  assert.equal(stripCommandPrefix("текст /eb"), null);
  const inv = parseInvocation("/eb кто в игре", base);
  assert.deepEqual(inv, { kind: "invoke", text: "кто в игре", via: "command" });
});

test("продолжение — только ответом на сообщение бота", () => {
  assert.deepEqual(parseInvocation("а подробнее?", { ...base, replyToSenderId: BOT }), { kind: "continue", text: "а подробнее?" });
  assert.equal(parseInvocation("а подробнее?", { ...base, replyToSenderId: "someone" }).kind, "none");
  assert.equal(parseInvocation("а подробнее?", base).kind, "none");
  // ответ боту с префиксом — это вызов (текст без префикса)
  assert.deepEqual(parseInvocation("Еблуша, а ещё?", { ...base, replyToSenderId: BOT }), { kind: "invoke", text: "а ещё?", via: "name" });
});

test("в личке без префикса молчим (если не включено BOT_DM_WITHOUT_PREFIX)", () => {
  assert.equal(parseInvocation("привет", { ...base, isDm: true }).kind, "none");
  assert.deepEqual(parseInvocation("привет", { ...base, isDm: true, dmWithoutPrefix: true }), { kind: "invoke", text: "привет", via: "dm" });
  assert.equal(parseInvocation("привет", { ...base, isDm: false, dmWithoutPrefix: true }).kind, "none");
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
