/**
 * Бот «Еблуша» + агент администрирования Valheim (поддельный, по контракту /DATA/valheim-agent/docs/API.md):
 * настоящий backend (app + Socket.IO в процессе, тестовые Postgres/Redis изолированной среды), настоящий
 * сервис бота (startBot, очередь BullMQ `bot`), настоящий HTTP-клиент агента (AgentClient с токеном из
 * файла) против поддельного агента на 127.0.0.1, поддельная модель — без сети и без денег.
 *
 *   test/secret-env/secret-test.sh run test/bot-valheim-agent.integration.test.ts
 *
 * Сначала — серверная часть «продолжения» (POST /api/bot/followup) на задачах, взятых прямо из
 * очереди (сервиса бота ещё нет). Потом — весь путь: просьба словами → план (изменения из
 * description_ru, «Ответьте «да»…») → «да» непривязанного — отказ → «да» другого привязанного игрока →
 * промежуточное сообщение и отчёт (по продолжению) → «верни как было» → отчёт об откате; устаревший план.
 * В конце — строка EB_PROOF для `secret-test.sh prod-proof` (в боевых БД/Redis этих id нет).
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { getBotQueue } from "../src/jobs/queue";
import { BOT_FOLLOWUP_MAX_MESSAGES, BOT_FOLLOWUPS_PER_GRANT, resetSystemBotCache } from "../src/lib/systemBot";
import type { BotJob } from "../src/lib/botContract";
import { ensureBotUser } from "../src/scripts/seedBotUser";
import { loadConfig } from "../bot/src/config";
import { createLogger } from "../bot/src/log";
import { startBot } from "../bot/src/main";
import { ZERO_COST } from "../bot/src/core/budget";
import type { AnswerRequest, AnswerResult, LlmEngine } from "../bot/src/llm/types";
import { createValheimAdminModule } from "../bot/src/modules/valheim";
import { AgentClient, AgentError } from "../bot/src/modules/valheim/agent";
import { FakeAgent, samplePlan } from "../bot/test/unit/valheim/agentfake";

const RUN = `ebst_va_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
const SECRET_WORDS = ["бесплатный крафт", "верни как было", "поставь мод на сон", "сделай бэкап мира"];

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`не дождались: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

class ScriptedLlm implements LlmEngine {
  readonly model = "claude-opus-5-5";
  calls: AnswerRequest[] = [];
  toolResults: Array<{ content: string; isError: boolean }> = [];
  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.calls.push(req);
    const last = req.turns[req.turns.length - 1]!.text.replace(/^⟦[^⟧]*⟧\n?/, "");
    let text = "ОтветМодели42.";
    if (/^(включи|поставь|сделай)/i.test(last)) {
      this.toolResults.push(await req.tools.run("admin_request", { text: last }));
      text = "Сейчас разберусь, что для этого нужно, — пришлю план.";
    }
    return { text, sources: [], cost: { ...ZERO_COST, usd: 0.01, inputTokens: 100, outputTokens: 10, models: [this.model] }, stop: "end_turn", servedBy: this.model };
  }
  async matchCharacter() {
    return { character: null, cost: ZERO_COST };
  }
}

/** Поддельный агент по HTTP: тот же контракт, что у /DATA/valheim-agent (токен X-Agent-Token, коды ошибок). */
function agentServer(agent: FakeAgent, token: string): http.Server {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(obj));
      };
      try {
        if (req.headers["x-agent-token"] !== token) return send(401, { ok: false, error: "unauthorized", message: "нужен заголовок X-Agent-Token" });
        const url = new URL(req.url ?? "/", "http://agent");
        const parts = url.pathname.split("/").filter(Boolean);
        const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
        if (req.method === "GET" && url.pathname === "/health") return send(200, await agent.health());
        if (parts[0] !== "tasks") return send(404, { ok: false, error: "not_found", message: "нет такого адреса" });
        if (parts.length === 1 && req.method === "POST") {
          const t = await agent.createTask(body.requester, body.text);
          return send(t.status === "planning" ? 202 : 200, t);
        }
        if (parts.length === 1 && req.method === "GET") return send(200, { ok: true, tasks: await agent.listTasks(Number(url.searchParams.get("limit") ?? 50)) });
        const id = parts[1]!;
        if (parts.length === 2 && req.method === "GET") return send(200, await agent.getTask(id));
        if (parts.length === 3 && req.method === "POST") {
          if (parts[2] === "confirm") return send(202, await agent.confirm(id, body.confirmer));
          if (parts[2] === "cancel") return send(200, await agent.cancel(id, body.by));
          if (parts[2] === "undo") return send(202, await agent.undo(id, body.requester));
        }
        return send(404, { ok: false, error: "not_found", message: "нет такого действия" });
      } catch (e) {
        if (e instanceof AgentError) return send(e.status, { ok: false, error: e.code, message: e.message });
        send(500, { ok: false, error: "internal", message: String((e as Error).message) });
      }
    });
  });
}

async function api<T = any>(baseUrl: string, token: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T };
}

async function main() {
  console.log(`[va-it] run=${RUN} cwd=${process.cwd()} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[va-it] backends: ${JSON.stringify(identity)}`);
  const proofKey = `eb-va-it:${RUN}`;
  await redis.set(proofKey, "1", { EX: 3600 });

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const queue = getBotQueue();
  await queue.drain(true);

  const fake = new FakeAgent();
  const agentToken = crypto.randomBytes(32).toString("hex");
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-va-it-"));
  const tokenFile = path.join(tokenDir, "api.token");
  fs.writeFileSync(tokenFile, `${agentToken}\n`, { mode: 0o600 });
  const agentHttp = agentServer(fake, agentToken);
  await new Promise<void>((r) => agentHttp.listen(0, "127.0.0.1", () => r()));
  const agentUrl = `http://127.0.0.1:${(agentHttp.address() as { port: number }).port}`;

  const logLines: string[] = [];
  let handle: Awaited<ReturnType<typeof startBot>> | null = null;
  let botId = "";
  try {
    await prisma.user.updateMany({ where: { isBot: true }, data: { isBot: false } });
    const botPassword = crypto.randomBytes(18).toString("base64url");
    const seeded = await ensureBotUser(prisma, { username: `${RUN}_bot`, password: botPassword, forcePassword: false });
    botId = seeded.id;
    resetSystemBotCache();
    const mk = (suffix: string, displayName: string) =>
      prisma.user.create({ data: { username: `${RUN}_${suffix}`, displayName, passwordHash: `x_${crypto.randomUUID()}` } });
    const alice = await mk("alice", "Алиса");
    const bob = await mk("bob", "Боб");
    const owner = await mk("owner", "Стон");
    const tok = (id: string) => signAccessToken({ sub: id, tokenId: crypto.randomUUID() });
    const [tA, tB, tBot] = [tok(alice.id), tok(bob.id), tok(botId)];
    const group = await prisma.conversation.create({
      data: { isGroup: true, title: `${RUN} группа`, createdById: alice.id, participants: { create: [alice.id, bob.id, owner.id].map((userId) => ({ userId })) } },
    });
    const send = async (token: string, body: Record<string, unknown>) => {
      const r = await api<{ message: { id: string } }>(baseUrl, token, "POST", "/api/conversations/send", { type: "TEXT", conversationId: group.id, ...body });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json.message.id;
    };

    // ---------- сервер: продолжение (follow-up) — без сервиса бота, задачи берём из очереди ----------
    const q0 = await send(tA, { content: "Еблуша, проверка продолжения" });
    const job0 = await waitFor("задача в очереди", async () => ((await queue.getJob(`msg-${q0}`))?.data as BotJob | undefined) ?? null);
    const fu = await api<{ grant: string; expiresAt: number }>(baseUrl, tBot, "POST", "/api/bot/followup", { grant: job0.grant });
    assert.equal(fu.status, 201, JSON.stringify(fu.json));
    assert.ok(fu.json.grant.length >= 20 && fu.json.grant !== job0.grant);
    assert.ok(fu.json.expiresAt > Date.now() + 70 * 3600_000, "продолжение живёт ~72 ч");
    const ttl = await redis.ttl(`bot:grant:${fu.json.grant}`);
    assert.ok(ttl > 70 * 3600 && ttl <= 72 * 3600, `TTL продолжения ${ttl}`);
    const nested = await api(baseUrl, tBot, "POST", "/api/bot/followup", { grant: fu.json.grant });
    assert.equal(nested.status, 400);
    assert.equal(nested.json.code, "BOT_FOLLOWUP_NESTED");
    for (let i = 1; i < BOT_FOLLOWUPS_PER_GRANT; i++) assert.equal((await api(baseUrl, tBot, "POST", "/api/bot/followup", { grant: job0.grant })).status, 201);
    const tooMany = await api(baseUrl, tBot, "POST", "/api/bot/followup", { grant: job0.grant });
    assert.equal(tooMany.status, 429);
    assert.equal(tooMany.json.code, "BOT_GRANT_EXHAUSTED");
    const human = await api(baseUrl, tA, "POST", "/api/bot/followup", { grant: job0.grant });
    assert.equal(human.status, 403, "продолжение берёт только бот");
    for (let i = 0; i < BOT_FOLLOWUP_MAX_MESSAGES; i++) {
      const r = await api(baseUrl, tBot, "POST", "/api/bot/messages", { grant: fu.json.grant, type: "TEXT", content: `отчёт ${i}`, kind: "command", ...(i === 0 ? { replyToId: q0 } : {}) });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.message.conversationId, group.id);
      assert.equal(r.json.message.isBot, true);
    }
    const over = await api(baseUrl, tBot, "POST", "/api/bot/messages", { grant: fu.json.grant, type: "TEXT", content: "лишнее" });
    assert.equal(over.status, 429);
    const react = await api(baseUrl, tBot, "POST", "/api/bot/react", { grant: fu.json.grant, messageId: q0, emoji: "👍" });
    assert.equal(react.status, 429, "по продолжению реакций нет");
    // обращение удалили — продолжения не дают, писать по ним нельзя
    const q1 = await send(tA, { content: "Еблуша, ещё проверка" });
    const job1 = await waitFor("задача 2", async () => ((await queue.getJob(`msg-${q1}`))?.data as BotJob | undefined) ?? null);
    const fu1 = await api<{ grant: string }>(baseUrl, tBot, "POST", "/api/bot/followup", { grant: job1.grant });
    assert.equal(fu1.status, 201);
    const del = await api(baseUrl, tA, "POST", "/api/messages/delete", { messageId: q1 });
    assert.equal(del.status, 200, JSON.stringify(del.json));
    const afterDel = await api(baseUrl, tBot, "POST", "/api/bot/followup", { grant: job1.grant });
    assert.equal(afterDel.status, 409);
    assert.equal(afterDel.json.code, "BOT_TRIGGER_DELETED");
    const postDel = await api(baseUrl, tBot, "POST", "/api/bot/messages", { grant: fu1.json.grant, type: "TEXT", content: "x" });
    assert.equal(postDel.status, 409);
    await queue.drain(true);
    console.log("[va-it] ok: POST /api/bot/followup — 72 ч, ≤ 4 сообщений, без реакций, не продлевается, только боту, после удаления обращения — 409");

    // ---------- бот + агент ----------
    const llm = new ScriptedLlm();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eb-va-bot-"));
    const cfg = loadConfig({
      BOT_API_URL: baseUrl,
      BOT_REDIS_URL: env.REDIS_URL,
      BOT_USERNAME: `${RUN}_bot`,
      BOT_PASSWORD: botPassword,
      BOT_OWNER_USER_ID: owner.id,
      BOT_DATA_DIR: dataDir,
    } as NodeJS.ProcessEnv);
    const log = createLogger("debug", { svc: "eblusha-bot-va-it" }, (l) => logLines.push(l));
    const mod = createValheimAdminModule({ agent: new AgentClient(agentUrl, tokenFile), pollMs: 60 });
    handle = await startBot(cfg, log, { llm, extraModules: [mod], assetsDir: path.resolve(__dirname, "../bot/assets") });

    const botMsgs = (where: Record<string, unknown>) =>
      prisma.message.findMany({ where: { senderId: botId, conversationId: group.id, ...where }, orderBy: { createdAt: "asc" } });
    const kindOf = (m: { metadata: unknown }) => ((m.metadata as any)?.bot?.kind as string | undefined) ?? null;

    // привязка: Алиса — игрок, Боб пока нет
    const l1 = await send(tA, { content: "Еблуша, мой ник в игре Парасюха" });
    await waitFor("привязка Алисы", async () => (await botMsgs({ replyToId: l1 })).length > 0);

    // просьба словами → короткий ответ модели → план
    fake.planFor = () => ({
      kind: "plan",
      plan: samplePlan({ restart: "when_empty", risk: "medium", summary_ru: "Включаю бесплатный крафт; нужен перезапуск." }),
    });
    fake.execSteps = ["executing", "waiting_restart", "waiting_restart", "waiting_restart", "done"];
    const q2 = await send(tA, { content: "Еблуша, включи бесплатный крафт" });
    const plan = await waitFor("план", async () => (await botMsgs({ replyToId: q2 })).find((m) => kindOf(m) === "confirm"));
    assert.match(llm.toolResults[0]!.content, /Передал администратору сервера/);
    const answers = await botMsgs({ replyToId: q2 });
    assert.equal(answers.length, 2, "короткий ответ модели и план");
    assert.match(answers[0]!.content ?? "", /пришлю план/);
    assert.equal(plan.isBot, true);
    assert.match(plan.content ?? "", /Настройка мира NoCraftCost \(«Бесплатный крафт»\): включить/);
    assert.match(plan.content ?? "", /\*\*Перезапуск сервера:\*\* нужен — когда на сервере никого не будет/);
    assert.match(plan.content ?? "", /\*\*Риск:\*\* средний/);
    assert.match(plan.content ?? "", /Ответьте «да», чтобы применить, или «нет»\.$/);
    const created = fake.calls.find((c) => c.op === "create")!;
    assert.deepEqual(created.person, { userId: alice.id, character: "Парасюха" });
    console.log("[va-it] ok: просьба словами → план отдельным сообщением (confirm), изменения из description_ru");

    // «да» непривязанного — отказ
    const noLink = await send(tB, { content: "да", replyToId: plan.id });
    const refusal = await waitFor("отказ непривязанному", async () => (await botMsgs({ replyToId: noLink }))[0]);
    assert.match(refusal.content ?? "", /только игроки — люди, привязанные к персонажу/);
    assert.equal(fake.calls.filter((c) => c.op === "confirm").length, 0);

    // Боб привязался — «да» Боба применяет (любой привязанный игрок)
    const l2 = await send(tB, { content: "Еблуша, мой ник в игре РомаH" });
    await waitFor("привязка Боба", async () => (await botMsgs({ replyToId: l2 })).length > 0);
    const yes = await send(tB, { content: "да", replyToId: plan.id });
    const report = await waitFor(
      "отчёт",
      async () => (await botMsgs({ replyToId: yes })).find((m) => /Готово/.test(m.content ?? "")),
      30_000
    );
    const afterYes = await botMsgs({ replyToId: yes });
    assert.ok(afterYes.some((m) => /Изменения на месте/.test(m.content ?? "")), "промежуточное «ждёт перезапуска»");
    assert.match(report.content ?? "", /подтвердил\(а\) РомаH/);
    assert.match(report.content ?? "", /\*\*Перезапуск:\*\* был — сервер поднялся/);
    assert.match(report.content ?? "", /ответьте на это сообщение «верни как было»/);
    assert.equal(kindOf(report), "command");
    assert.equal((report.metadata as any)?.bot?.triggerMessageId, yes, "отчёт — ответ на «да» (удалить его может подтвердивший)");
    assert.deepEqual(fake.calls.find((c) => c.op === "confirm")!.person, { userId: bob.id, character: "РомаH" });
    // отчёт шёл по продолжению: в Redis есть продолжение на «да»
    const keys = await redis.keys("bot:grant:*");
    let followups = 0;
    for (const k of keys) {
      if (k.split(":").length !== 3) continue;
      const v = await redis.get(k);
      if (v && JSON.parse(v).followup === true && JSON.parse(v).triggerMessageId === yes) followups++;
    }
    assert.equal(followups, 1, "после «да» взято одно продолжение");
    console.log("[va-it] ok: «да» непривязанного — отказ; «да» другого привязанного — выполнение, «ждёт перезапуска», отчёт по продолжению");

    // «верни как было» ответом на отчёт
    const undo = await send(tA, { content: "верни как было", replyToId: report.id });
    const undone = await waitFor("отчёт об откате", async () => (await botMsgs({ replyToId: undo })).find((m) => /Вернул как было/.test(m.content ?? "")));
    assert.equal(undone.isBot, true);
    assert.equal(fake.calls.filter((c) => c.op === "undo").length, 1);
    console.log("[va-it] ok: «верни как было» ответом на отчёт → откат и отчёт");

    // устаревший план
    fake.planFor = () => ({ kind: "plan", plan: samplePlan({ summary_ru: "Сделаю бэкап мира." }) });
    const q3 = await send(tA, { content: "Еблуша, сделай бэкап мира" });
    const plan3 = await waitFor("план 3", async () => (await botMsgs({ replyToId: q3 })).find((m) => kindOf(m) === "confirm"));
    fake.expired.add([...fake.tasks.keys()].at(-1)!);
    const yes3 = await send(tB, { content: "ок", replyToId: plan3.id });
    const stale = await waitFor("устарел", async () => (await botMsgs({ replyToId: yes3 }))[0]);
    assert.match(stale.content ?? "", /план устарел — планы живут час/);
    console.log("[va-it] ok: устаревший план — сказать и предложить заново");

    assert.equal(llm.calls.length, 2, "«да», «ок», «верни как было» и привязки — без модели");

    // журнал без текста сообщений
    assert.ok(logLines.some((l) => l.includes('"evt":"admin.plan_posted"')));
    assert.ok(logLines.some((l) => l.includes('"evt":"admin.report_posted"')));
    for (const w of SECRET_WORDS) assert.ok(!logLines.some((l) => l.includes(w)), `в журнале нет текста «${w}»`);
    console.log(`[va-it] ok: журнал (${logLines.length} строк) без текста сообщений`);

    const proof = {
      run: RUN,
      userIds: [botId, alice.id, bob.id, owner.id],
      usernames: [`${RUN}_bot`, alice.username, bob.username, owner.username],
      deviceIds: [`${RUN}-nodevice`],
      threadId: group.id,
      msgId: crypto.randomUUID(),
      redisKeys: [proofKey],
    };
    console.log(`EB_PROOF ${JSON.stringify(proof)}`);
  } catch (e) {
    console.error("[va-it] журнал бота (последние 40 строк):\n" + logLines.slice(-40).join("\n"));
    throw e;
  } finally {
    await handle?.stop().catch(() => undefined);
    await getBotQueue().drain(true).catch(() => undefined);
    if (botId) await prisma.user.update({ where: { id: botId }, data: { isBot: false, deletedAt: new Date() } }).catch(() => undefined);
    agentHttp.close();
    fs.rmSync(tokenDir, { recursive: true, force: true });
    io.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().then(
  async () => {
    console.log("bot valheim agent integration: ok");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  },
  async (err) => {
    console.error("bot valheim agent integration: FAILED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
);
