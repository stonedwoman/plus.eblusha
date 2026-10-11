/**
 * Справочник по приложению (bot/knowledge/eblusha-app.md) в системном тексте модели: загрузка при старте
 * (src/main.ts loadKnowledge), блок с заголовком (src/llm/prompt.ts buildKnowledgeBlock), второй блок system с точкой
 * кэша только на последнем (src/llm/claude.ts), выключатель BOT_KNOWLEDGE_FILE=off — и форма самого справочника
 * (MAINTAIN.md: без таблиц, путей к коду и служебных синонимов; новые функции выпуска 2026-10-11 на месте).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../../src/config";
import { ClaudeEngine } from "../../src/llm/claude";
import { buildKnowledgeBlock, buildSystemPrompt } from "../../src/llm/prompt";
import { createLogger, silentLogger } from "../../src/log";
import { loadKnowledge } from "../../src/main";

const FILE = path.resolve(process.cwd(), "knowledge/eblusha-app.md");
const md = fs.readFileSync(FILE, "utf8");

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  return { log: createLogger("debug", {}, (l) => lines.push(JSON.parse(l))), lines };
}

test("справочник: загрузка при старте — блок с заголовком, в журнале размер и дата сверки", () => {
  const { log, lines } = capture();
  const block = loadKnowledge("knowledge/eblusha-app.md", log);
  assert.ok(block);
  assert.match(block!, /^# Справочник по самой Еблуше/);
  assert.match(block!, /Не говори «как это сделано в Еблуше, я точно не знаю»/);
  assert.ok(block!.endsWith(md.trim()), "справочник целиком, без правок");
  const ev = lines.find((l) => l.evt === "knowledge.loaded");
  assert.ok(ev, JSON.stringify(lines));
  assert.equal(ev!.checked, "2026-10-11");
  assert.ok((ev!.chars as number) > 20_000);
});

test("справочник: нет файла, пустой файл, выключатель — бот работает без него", () => {
  const { log, lines } = capture();
  assert.equal(loadKnowledge("/nowhere/eblusha-app.md", log), null);
  assert.ok(lines.some((l) => l.evt === "knowledge.missing"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  try {
    const empty = path.join(dir, "e.md");
    fs.writeFileSync(empty, "﻿  \n");
    assert.equal(loadKnowledge(empty, silentLogger), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(loadKnowledge(null, silentLogger), null);
  assert.equal(buildKnowledgeBlock(""), null);
  assert.equal(buildKnowledgeBlock("﻿# x")!.endsWith("\n\n# x"), true, "BOM срезается");
  const base = { BOT_USERNAME: "b", BOT_PASSWORD: "p" } as NodeJS.ProcessEnv;
  assert.equal(loadConfig(base).knowledgeFile, "knowledge/eblusha-app.md");
  assert.equal(loadConfig({ ...base, BOT_KNOWLEDGE_FILE: "off" }).knowledgeFile, null);
  assert.equal(loadConfig({ ...base, BOT_KNOWLEDGE_FILE: "/x/k.md" }).knowledgeFile, "/x/k.md");
});

test("справочник в запросе: второй блок system, точка кэша (1 ч) только на последнем, основной текст первым", async () => {
  const calls: Array<Record<string, any>> = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, any>) {
          calls.push(structuredClone(params));
          return {
            finalMessage: async () => ({
              model: "claude-opus-5-5",
              stop_reason: "end_turn",
              content: [{ type: "text", text: "ок", citations: null }],
              usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, iterations: null },
            }),
          };
        },
      },
    },
  } as unknown as Anthropic;
  const cfg = {
    anthropicApiKey: "k",
    anthropicWorkspaceId: null,
    model: "claude-opus-5-5",
    maxTokens: 16000,
    maxToolIterations: 6,
    webSearchMaxUses: 5,
    webFetchMaxUses: 4,
    webFetchMaxContentTokens: 15000,
    memoryModel: "claude-sonnet-5-5",
  };
  const base = buildSystemPrompt([]);
  const kb = buildKnowledgeBlock(md)!;
  const eng = new ClaudeEngine(cfg, [base, kb], silentLogger, client);
  await eng.answer({
    turns: [{ role: "user", text: "как заглушить группу?" }],
    contextNote: "Сейчас: суббота.",
    effort: "medium",
    userKey: "u",
    tools: { defs: [], run: async () => ({ content: "", isError: false }) },
    signal: new AbortController().signal,
    maxUsd: 1,
  });
  const sys = calls[0]!.system as Array<Record<string, unknown>>;
  assert.equal(sys.length, 2);
  assert.equal(sys[0]!.text, base);
  assert.equal(sys[0]!.cache_control, undefined);
  assert.equal(sys[1]!.text, kb);
  assert.deepEqual(sys[1]!.cache_control, { type: "ephemeral", ttl: "1h" });
  // точек кэша в запросе не больше 4 (API)
  const n = JSON.stringify(calls[0]).split('"cache_control"').length - 1;
  assert.ok(n <= 4, String(n));
  // одна строка — как раньше
  calls.length = 0;
  await new ClaudeEngine(cfg, "СИСТЕМА", silentLogger, client).answer({
    turns: [{ role: "user", text: "?" }],
    contextNote: "",
    effort: "medium",
    userKey: "u",
    tools: { defs: [], run: async () => ({ content: "", isError: false }) },
    signal: new AbortController().signal,
    maxUsd: 1,
  });
  assert.deepEqual(calls[0]!.system, [{ type: "text", text: "СИСТЕМА", cache_control: { type: "ephemeral", ttl: "1h" } }]);
});

test("форма справочника: без таблиц, путей к коду, служебных синонимов и «не умею»; размер в пределах", () => {
  assert.ok(md.length > 25_000 && md.length < 48_000, `знаков: ${md.length} (MAINTAIN: 6–15 тыс. токенов)`);
  assert.doesNotMatch(md, /^\s*\|.*\|\s*$/m, "таблиц нет — бот перенимает разметку");
  assert.doesNotMatch(md, /\b(src|frontend|ios|Eblusha\.Desktop)\/|\.(tsx?|kt|swift|cs|xaml)\b/, "путей к коду нет");
  assert.doesNotMatch(md, /(^|\s)\/eb\b/m, "служебных синонимов нет");
  assert.doesNotMatch(md, /не умею|не помню/i);
  assert.doesNotMatch(md, /В работе/, "вышедшее перенесено в основные разделы");
  assert.doesNotMatch(md, /sk-ant|token|пароль\s*[:=]/i);
});

test("справочник знает функции выпуска 2026-10-11 с подписями из клиентов", () => {
  for (const s of [
    "«Без звука»",
    "«Без звука на…»",
    "«1 час», «8 часов», «1 день», «1 неделю», «Навсегда»",
    "«Включить звук»",
    "«Звук включён»",
    "«Не удалось изменить звук беседы»",
    "«Подумай лучше»",
    "«🧠 Подумал лучше»",
    "«Еблуша, проконтролируй»",
    "«⏱ ТАЙМЕР»",
    "«Пришёл»",
    "«Отменить»",
    "«Вернуть»",
    "«🔒 ПЕРЕПИСКА»",
    "«Сегодня», «Эта неделя» или «Всё время»",
    "«Включать фото»",
    "«Поделиться» или «Не делиться»",
    "«Еблуша, забудь переписку»",
    "«Еблуша, мой ник в игре …»",
    "«Ответ ниже ↓»",
  ]) {
    assert.ok(md.includes(s), `нет ${s}`);
  }
  assert.match(md, /ПК — 2\.0\.11/);
  assert.match(md, /помнит свои разговоры/);
  assert.match(md, /летопис/);
});
