import { test } from "node:test";
import assert from "node:assert/strict";
import { Budget, costOf, priceFor } from "../../src/core/budget";
import { Store } from "../../src/core/store";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("цена по usage: вход, выход, кэш, поиск", () => {
  const c = costOf(
    {
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 4_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 3_000 },
      server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 },
    },
    "claude-opus-5-5"
  );
  // 10k*4 + 2k*20 + 50k*0.2 + 1k*5 + 3k*8 = 40000+40000+10000+5000+24000 = 119000 / 1e6 = 0.119; + 3*0.01
  near(c.usd, 0.119 + 0.03);
  assert.equal(c.webSearches, 3);
  assert.equal(c.webFetches, 2);
});

test("server-side fallback: итерации считаются по цене своей модели", () => {
  const c = costOf(
    {
      input_tokens: 2_000,
      output_tokens: 1_000,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 1_000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1_000, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        { type: "compaction", input_tokens: 999_999, output_tokens: 999_999 },
      ],
    },
    "claude-opus-5-5"
  );
  near(c.usd, (1000 * 4 + 100 * 20 + 1000 * 5 + 900 * 25) / 1e6);
  assert.deepEqual(c.models.sort(), ["claude-opus-4-8", "claude-opus-5-5"]);
});

test("неизвестная модель считается по дорогой цене, снапшот — по базовой", () => {
  assert.equal(priceFor("claude-opus-5-5-20261001").input, 4);
  assert.equal(priceFor("something-new").input, 5);
});

test("потолки: месяц, сутки, человек; владелец без личного и дневного лимита", () => {
  const store = new Store(":memory:");
  let now = Date.parse("2026-10-10T12:00:00Z");
  const b = new Budget(store, { monthlyBudgetUsd: 10, dailyBudgetUsd: 3, userDailyQuestions: 2, userDailyUsd: 1 }, () => now);
  const cost = (usd: number) => ({ usd, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0, webFetches: 0, models: ["claude-opus-5-5"] });

  assert.deepEqual(b.check("u1", false), { ok: true });
  b.record("u1", "c", "answer", "claude-opus-5-5", cost(0.1));
  b.record("u1", "c", "answer", "claude-opus-5-5", cost(0.1));
  assert.deepEqual(b.check("u1", false), { ok: false, reason: "user_questions" });
  assert.deepEqual(b.check("owner", true), { ok: true });

  b.record("u2", "c", "answer", "claude-opus-5-5", cost(1.2));
  assert.deepEqual(b.check("u2", false), { ok: false, reason: "user_usd" });

  b.record("owner", "c", "answer", "claude-opus-5-5", cost(1.5));
  assert.deepEqual(b.check("u3", false), { ok: false, reason: "day" }); // 2.9 + запас > 3
  // владельца общий дневной потолок не держит (его могли выбрать чужие вопросы), месячный — держит
  assert.deepEqual(b.check("owner", true), { ok: true });

  now = Date.parse("2026-10-11T12:00:00Z"); // новые сутки
  assert.deepEqual(b.check("u1", false), { ok: true });
  b.record("owner", "c", "answer", "claude-opus-5-5", cost(2.5));
  now = Date.parse("2026-10-12T12:00:00Z");
  b.record("owner", "c", "answer", "claude-opus-5-5", cost(2.5));
  now = Date.parse("2026-10-13T12:00:00Z");
  b.record("owner", "c", "answer", "claude-opus-5-5", cost(2.0));
  assert.deepEqual(b.check("owner", true), { ok: false, reason: "month" }); // 9.9 + запас > 10

  now = Date.parse("2026-11-01T00:00:01Z"); // новый месяц
  assert.deepEqual(b.check("owner", true), { ok: true });
  const s = b.summary();
  assert.equal(s.month, "2026-11");
  assert.equal(s.spentUsd, 0);
});

test("store: привязки — у персонажа один человек, перепривязка заменяет свои", () => {
  const st = new Store(":memory:");
  assert.deepEqual(st.link("a", "Парасюха", { linkedBy: "a", verified: true, replaceOwn: true, force: false }), { ok: true });
  assert.deepEqual(st.link("b", "Парасюха", { linkedBy: "b", verified: true, replaceOwn: true, force: false }), { ok: false, takenBy: "a" });
  assert.deepEqual(st.link("a", "Куралеска", { linkedBy: "a", verified: true, replaceOwn: true, force: false }), { ok: true });
  assert.deepEqual(st.getCharacters("a"), ["Куралеска"]);
  assert.equal(st.getLinkOwner("Парасюха"), null);
  st.link("a", "Парасюха", { linkedBy: "a", verified: true, replaceOwn: false, force: false });
  assert.deepEqual(st.getCharacters("a").sort(), ["Куралеска", "Парасюха"]);
  // владелец отбирает
  assert.deepEqual(st.link("b", "Парасюха", { linkedBy: "owner", verified: true, replaceOwn: false, force: true }), { ok: true });
  assert.equal(st.getLinkOwner("Парасюха"), "b");
  assert.equal(st.unlinkUser("a"), 1);
  assert.deepEqual(st.getCharacters("a"), []);
});

test("store: подтверждение забирается один раз и до срока", () => {
  const st = new Store(":memory:");
  st.createConfirmation({ ownerId: "o", conversationId: "c", botMessageId: "m1", command: "restart", argsJson: "{}", expiresAt: 1000 });
  assert.equal(st.isConfirmationMessage("m1"), true);
  assert.equal(st.takeConfirmation("m1", "intruder", 500), null);
  assert.equal(st.takeConfirmation("m1", "o", 500)?.command, "restart");
  assert.equal(st.takeConfirmation("m1", "o", 600), null);
  st.createConfirmation({ ownerId: "o", conversationId: "c", botMessageId: "m2", command: "restart", argsJson: "{}", expiresAt: 1000 });
  assert.equal(st.takeConfirmation("m2", "o", 1001), null);
});

test("store: noticeOnce", () => {
  const st = new Store(":memory:");
  assert.equal(st.noticeOnce("k", 100, 0), true);
  assert.equal(st.noticeOnce("k", 100, 50), false);
  assert.equal(st.noticeOnce("k", 100, 150), true);
});
