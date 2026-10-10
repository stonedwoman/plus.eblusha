import { test } from "node:test";
import assert from "node:assert/strict";
import { hasHttpsLink, safeUrl, sanitizeMarkdown, splitMessage } from "../../src/core/markup";

test("таблица → плоский список", () => {
  const md = "| Броня | Защита | Где |\n|---|---|---|\n| Бронзовая | 8 | Чёрный лес |\n| Железная | 20 | Болота |";
  const { text } = sanitizeMarkdown(md);
  assert.ok(!text.includes("|"), text);
  assert.match(text, /^- \*\*Бронзовая\*\* — Защита: 8, Где: Чёрный лес$/m);
  assert.match(text, /^- \*\*Железная\*\* — Защита: 20, Где: Болота$/m);
});

test("__жирный__ → **жирный**, _курсив_ → *курсив*, ~~зачёркнутый~~ → текст", () => {
  const { text } = sanitizeMarkdown("Это __важно__ и _тихо_, а ~~неправда~~ правда.");
  assert.equal(text, "Это **важно** и *тихо*, а неправда правда.");
});

test("подчёркивания в адресах и коде не трогаем", () => {
  const md = "См. [вики](https://en.wikipedia.org/wiki/Foo_bar_baz) и https://x.org/a_b_c, код `snake_case_name`.";
  const { text } = sanitizeMarkdown(md);
  assert.ok(text.includes("(https://en.wikipedia.org/wiki/Foo_bar_baz)"), text);
  assert.ok(text.includes("https://x.org/a_b_c"), text);
  assert.ok(text.includes("`snake_case_name`"), text);
});

test("заголовки до ### остаются, глубже — жирная строка; линии убираются", () => {
  const { text } = sanitizeMarkdown("# Один\n### Три\n#### Четыре\n---\n***\nтекст");
  assert.equal(text, "# Один\n### Три\n**Четыре**\n\ntext".replace("text", "текст"));
});

test("вложенные списки → плоские, маркеры * и + → -", () => {
  const { text } = sanitizeMarkdown("* раз\n  * два\n    + три\n   1. четыре");
  assert.equal(text, "- раз\n- два\n- три\n1. четыре");
});

test("блок кода: язык убирается, внутри ничего не меняется", () => {
  const { text } = sanitizeMarkdown("```js\nconst __x__ = a_b_c | 1;\n```");
  assert.equal(text, "```\nconst __x__ = a_b_c | 1;\n```");
});

test("ссылки: только https, скобки в адресе кодируются, http — просто текст", () => {
  const { text } = sanitizeMarkdown("[раз](https://ru.wikipedia.org/wiki/Valheim_(игра)) [два](http://evil.example) [три](javascript:alert(1))");
  assert.ok(text.includes("[раз](https://ru.wikipedia.org/wiki/Valheim_%28"), text);
  assert.ok(!text.includes("http://evil"), text);
  assert.ok(text.includes("два"), text);
  assert.ok(!text.includes("javascript"), text);
  assert.equal(safeUrl("http://a.b"), null);
  assert.equal(safeUrl("https://a.b/x(1)"), "https://a.b/x%281%29");
});

test("![картинки] вынимаются во вложения", () => {
  const r = sanitizeMarkdown("Вот: ![карта](https://valheim.fandom.com/img/map.png) и всё. ![x](http://no.png)");
  assert.deepEqual(r.images, [{ url: "https://valheim.fandom.com/img/map.png", alt: "карта" }]);
  assert.ok(!r.text.includes("!["), r.text);
});

test("цитата получает пробел после >, HTML-теги снимаются", () => {
  const { text } = sanitizeMarkdown(">цитата<br>дальше\n<b>жирно</b>");
  assert.equal(text, "> цитата дальше\nжирно");
});

test("длинный ответ делится по абзацам, блок кода не разрывается", () => {
  const para = "слово ".repeat(150).trim();
  const code = "```\n" + "x\n".repeat(50) + "```";
  const parts = splitMessage([para, para, code, para].join("\n\n"), 1000);
  assert.ok(parts.length >= 3, String(parts.length));
  for (const p of parts) {
    assert.ok(p.length <= 1000, String(p.length));
    assert.equal((p.match(/```/g) ?? []).length % 2, 0, "код не разорван");
  }
  assert.deepEqual(splitMessage("коротко"), ["коротко"]);
});

test("слишком длинный ответ обрезается до maxParts с пометкой", () => {
  const parts = splitMessage("абв ".repeat(5000), 500, 3);
  assert.equal(parts.length, 3);
  assert.match(parts[2]!, /ответ обрезан/);
});

test("hasHttpsLink", () => {
  assert.equal(hasHttpsLink("см. https://a.b"), true);
  assert.equal(hasHttpsLink("нет ссылок"), false);
});
