/**
 * Просьбы к серверу Valheim через агента (src/modules/valheim/admin.ts) внутри настоящего ядра бота:
 * распознавание просьб и ответов, показ плана (изменения — из description_ru), «да» любого
 * привязанного игрока, отказ непривязанному, устаревший план, отчёт (в т. ч. после перезапуска
 * через долгое разрешение), «верни как было», продолжение после перезапуска бота, клиент HTTP.
 * Агент — поддельный (agentfake.ts), модель — поддельная (../fakes), сети нет.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { EbMessage } from "../../../src/api/types";
import { createValheimModule } from "../../../src/modules/valheim";
import { AdminStore, classifyIntent, formatPlan, formatReport, PLAN_MAX_CHARS } from "../../../src/modules/valheim/admin";
import { AgentClient, AgentError, AgentUnavailable, type AgentTask } from "../../../src/modules/valheim/agent";
import type { OpsAction, OpsClientLike, OpsResult } from "../../../src/modules/valheim/ops";
import type { ValheimConfig } from "../../../src/modules/valheim/config";
import { ALICE, BOB, BOT, DM_ALICE, DM_OWNER, GROUP, harness, msg, OWNER, type Harness } from "../fakes";
import { CFG, fakeServer, makeWorld } from "./vhfakes";
import { enableFollowups, FakeAgent, samplePlan } from "./agentfake";

const statusOps: OpsClientLike = {
  async call<T extends OpsResult = OpsResult>(action: OpsAction): Promise<T> {
    if (action !== "status") throw new Error("ops: только статус в этих тестах");
    return {
      ok: true,
      container: { running: true, startedAt: "2026-10-10T02:10:00" },
      restartWhenEmpty: { active: false },
      game: { version: "0.221.4", plugins: "5 из 5" },
      disk: { freeGb: 619, totalGb: 936 },
      backups: { hourlyCount: 74, lastHourly: { file: "w.zip", at: "2026-10-10 14:05", size: 66_000_000 } },
    } as unknown as T;
  },
};

interface Setup {
  h: Harness;
  agent: FakeAgent;
  mod: ReturnType<typeof createValheimModule>;
  followups: { issued: string[] } | null;
  toolResults: Array<{ content: string; isError: boolean }>;
  settle(): Promise<void>;
  reply(to: EbMessage, sender: string, content: string): EbMessage;
  inConv(c: string): Array<EbMessage & { kind: string | undefined; grant: string | undefined }>;
}

async function setup(o: { agent?: FakeAgent; followups?: boolean; store?: AdminStore; cfg?: Partial<ValheimConfig> } = {}): Promise<Setup> {
  const agent = o.agent ?? new FakeAgent();
  const mod = createValheimModule({
    cfg: { ...CFG, ...o.cfg },
    world: makeWorld(fakeServer()),
    ops: statusOps,
    agent,
    adminPollMs: 2,
    ...(o.store ? { adminStore: o.store } : {}),
  });
  const h = await harness({ modules: [mod] });
  const followups = o.followups === false ? null : enableFollowups(h);
  h.store.link(ALICE, "IiApaCiOxa", { linkedBy: ALICE, verified: true, replaceOwn: true, force: false });
  const toolResults: Setup["toolResults"] = [];
  h.llm.reply = async (req) => {
    const last = req.turns.at(-1)!.text.replace(/^⟦[^⟧]*⟧\n?/, "");
    if (/^(включи|перезапусти|сделай|поставь)/i.test(last)) {
      toolResults.push(await req.tools.run("admin_request", { text: last }));
      return { text: "Сейчас разберусь, что для этого нужно, — пришлю план." };
    }
    if (/как там сервер/i.test(last)) {
      toolResults.push(await req.tools.run("server_status", {}));
      return { text: "Сервер в порядке." };
    }
    return { text: "Ответ модели." };
  };
  return {
    h,
    agent,
    mod,
    followups,
    toolResults,
    async settle() {
      await h.bot.idle();
      await mod.admin.idle();
    },
    reply: (to, sender, content) => msg({ conversationId: to.conversationId, senderId: sender, content, replyToId: to.id, replyTo: { id: to.id, content: to.content, senderId: BOT } }),
    inConv: (c) =>
      h.api.sentMessages
        .map((m, i) => ({ ...m, kind: h.api.sent[i]!.kind, grant: h.api.sent[i]!.grant }))
        .filter((m) => m.conversationId === c),
  };
}

async function deliver(s: Setup, m: EbMessage): Promise<void> {
  await s.h.deliver(m);
  await s.settle();
}

test("распознавание ответов: «да» / «нет» / «верни как было»; вопросы — модели", () => {
  for (const t of ["да", "Да!", "ок", "окей", "ok", "применяй", "да, применяй", "давай", "го", "конечно", "подтверждаю", "Ага."]) assert.equal(classifyIntent(t), "yes", t);
  for (const t of ["нет", "Нет.", "не надо", "отмена", "отмени", "стоп", "нет, не надо"]) assert.equal(classifyIntent(t), "no", t);
  for (const t of ["верни как было", "Верни всё как было", "верни обратно", "откати", "откат", "откати изменения", "отмени изменения", "верни как было, пожалуйста"]) {
    assert.equal(classifyIntent(t), "undo", t);
  }
  for (const t of ["а что будет с моими вещами?", "да ну, а зачем перезапуск?", "нет, сделай x5", "спасибо", "отмени рестарт", "верни мне меч", ""]) {
    assert.equal(classifyIntent(t), null, t);
  }
});

test("план: изменения — из description_ru, на кого, перезапуск, риск, стенд, «да»/«нет» внизу; разметка-обманка и секреты обезврежены", () => {
  const task = {
    taskId: "t20261010-120000-ab12",
    status: "planned",
    target: "test",
    text: "поставь стаки 500 и дай Сане админку",
    requester: { userId: ALICE, character: "IiApaCiOxa" },
    plan: samplePlan({
      summary_ru: "Сделаю [вот так](https://evil.example) — всё будет хорошо.",
      affects: "player:Куралеска",
      restart: "when_empty",
      risk: "high",
      notes_ru: "Админку выдаю по SteamID из списка.",
      changes: [
        { id: "c1", kind: "file_replace", description_ru: "Файл config/x.cfg: правка части текста", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-StackSize = 100\n+StackSize = 500\n-api_token = abc\n+api_token = def" },
        { id: "c2", kind: "mod_install", description_ru: "Мод A-B 1.0.0: установить (Thunderstore, sha256 0123456789ab…)", dependencies: ["denikson-BepInExPack_Valheim-5.4.2202"] },
        { id: "c3", kind: "file_write", description_ru: "Файл lists/adminlist.txt: **заменить** содержимое [целиком](https://evil.example)" },
      ],
    }),
  } as unknown as AgentTask;
  const text = formatPlan(task, { requesterName: "Алиса", isTest: true });
  assert.match(text, /^\*\*План для сервера Valheim\*\* — просьба IiApaCiOxa: «поставь стаки 500 и дай Сане админку»/);
  assert.match(text, /- Файл config\/x\.cfg: правка части текста\n/);
  assert.match(text, /- Мод A-B 1\.0\.0: установить \(Thunderstore, sha256 0123456789ab…\); зависимости: denikson-BepInExPack_Valheim-5\.4\.2202/);
  assert.match(text, /- Файл lists\/adminlist\.txt: заменить содержимое целиком \(https:\/\/evil\.example\)/, "ссылка из описания — не ссылка");
  assert.match(text, /```\n-StackSize = 100\n\+StackSize = 500\n-api_token = <скрыто>\n\+api_token = <скрыто>\n```/);
  assert.match(text, /\*\*На кого действует:\*\* только Куралеска/);
  assert.match(text, /\*\*Перезапуск сервера:\*\* нужен — когда на сервере никого не будет/);
  assert.match(text, /\*\*Риск:\*\* \*\*высокий\*\*/);
  assert.match(text, /тестовым стендом/);
  assert.match(text, /Пояснение агента: Сделаю вот так \(https:\/\/evil\.example\)/);
  assert.doesNotMatch(text, /\]\(https:/);
  assert.match(text, /Подтвердить может любой привязанный игрок/);
  assert.equal(text.split("\n").at(-1), "Ответьте «да», чтобы применить, или «нет».");
  assert.ok(text.length < 3800, "план — одним сообщением");
});

test("просьба словами → план → «да» другого привязанного игрока → отчёт → «верни как было» → откат", async () => {
  const s = await setup();
  const { h, agent } = s;
  const q = msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, включи бесплатный крафт" });
  await deliver(s, q);
  assert.match(s.toolResults[0]!.content, /Передал администратору сервера/);
  assert.deepEqual(agent.calls[0], { op: "create", person: { userId: ALICE, character: "IiApaCiOxa" }, text: "включи бесплатный крафт" });
  let g = s.inConv(GROUP);
  assert.equal(g.length, 2, "короткий ответ модели и план");
  assert.equal(g[0]!.kind, "answer");
  assert.match(g[0]!.content!, /пришлю план/);
  const plan = g[1]!;
  assert.equal(plan.kind, "confirm");
  assert.equal(plan.replyToId, q.id, "план — ответом на просьбу");
  assert.match(plan.content!, /Настройка мира NoCraftCost \(«Бесплатный крафт»\): включить/);
  assert.match(plan.content!, /Ответьте «да», чтобы применить, или «нет»\.$/);

  // непривязанный — вежливый отказ, агенту ничего не уходит
  await deliver(s, s.reply(plan, BOB, "да"));
  assert.match(s.inConv(GROUP).at(-1)!.content!, /только игроки — люди, привязанные к персонажу/);
  assert.equal(agent.calls.filter((c) => c.op === "confirm").length, 0);

  // Боб привязался — его «да» применяет план (подтверждает любой привязанный, не только просивший)
  h.store.link(BOB, "РомаH", { linkedBy: BOB, verified: true, replaceOwn: true, force: false });
  const yes = s.reply(plan, BOB, "да, применяй");
  await deliver(s, yes);
  const confirmCall = agent.calls.find((c) => c.op === "confirm")!;
  assert.equal(confirmCall.id, [...agent.tasks.keys()][0]);
  assert.deepEqual(confirmCall.person, { userId: BOB, character: "РомаH" });
  const report = s.inConv(GROUP).at(-1)!;
  assert.equal(report.replyToId, yes.id, "отчёт — ответом на «да»");
  assert.equal(report.kind, "command");
  assert.match(report.content!, /^✅ \*\*Готово\.\*\*/);
  assert.match(report.content!, /подтвердил\(а\) РомаH/);
  assert.match(report.content!, /- ✅ NoCraftCost включён/);
  assert.match(report.content!, /\*\*Перезапуск:\*\* не нужен/);
  assert.match(report.content!, /Вернуть как было — ответьте на это сообщение «верни как было»/);
  assert.doesNotMatch(report.content!, /«откат» по задаче/);
  assert.equal(h.llm.calls.length, 1, "«да» не идёт через модель");

  // второе «да» — уже подтверждено
  await deliver(s, s.reply(plan, ALICE, "да"));
  assert.match(s.inConv(GROUP).at(-1)!.content!, /уже подтвердил\(а\) РомаH/);

  // «верни как было» ответом на отчёт — откат и отчёт об откате
  const undo = s.reply(report, ALICE, "верни как было");
  await deliver(s, undo);
  assert.equal(agent.calls.filter((c) => c.op === "undo").length, 1);
  const undone = s.inConv(GROUP).at(-1)!;
  assert.equal(undone.replyToId, undo.id);
  assert.match(undone.content!, /^↩️ \*\*Вернул как было\.\*\*/);
  assert.match(undone.content!, /NoCraftCost выключен/);
  assert.equal(h.llm.calls.length, 1);
});

test("непривязанный просит изменить сервер — инструмент отказывает, агенту ничего не уходит", async () => {
  const s = await setup();
  await deliver(s, msg({ conversationId: GROUP, senderId: BOB, content: "Еблуша, перезапусти сервер" }));
  assert.match(s.toolResults[0]!.content, /^ОТКАЗ/);
  assert.match(s.toolResults[0]!.content, /мой ник в игре/);
  assert.equal(s.agent.calls.length, 0);
  assert.equal(s.inConv(GROUP).length, 1, "только ответ модели, плана нет");
});

test("«нет» — отмена; устаревший план — сказать и предложить заново; агент занят — без плана", async () => {
  const s = await setup();
  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "включи бесплатный крафт" }));
  const plan1 = s.inConv(DM_ALICE).at(-1)!;
  await deliver(s, s.reply(plan1, ALICE, "нет"));
  assert.equal(s.inConv(DM_ALICE).at(-1)!.content, "Отменил — ничего не меняю.");
  await deliver(s, s.reply(plan1, ALICE, "да"));
  assert.match(s.inConv(DM_ALICE).at(-1)!.content!, /нечего подтверждать: план отменён/);

  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "сделай бэкап" }));
  const plan2 = s.inConv(DM_ALICE).at(-1)!;
  s.agent.expired.add([...s.agent.tasks.keys()].at(-1)!);
  await deliver(s, s.reply(plan2, ALICE, "ок"));
  assert.match(s.inConv(DM_ALICE).at(-1)!.content!, /план устарел — планы живут час\. Напишите просьбу ещё раз/);

  s.agent.busy = true;
  const before = s.inConv(DM_ALICE).length;
  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "поставь ресурсы x3" }));
  assert.match(s.toolResults.at(-1)!.content, /занят другими просьбами/);
  assert.equal(s.inConv(DM_ALICE).length, before + 1, "только ответ модели");
});

test("перезапуск «когда все выйдут»: промежуточное сообщение, отчёт после перезапуска — по долгому разрешению", async () => {
  const agent = new FakeAgent();
  agent.planFor = () => ({ kind: "plan", plan: samplePlan({ restart: "when_empty", summary_ru: "Ставлю мод, нужен перезапуск." }) });
  agent.execSteps = ["executing", "waiting_restart", "waiting_restart", "waiting_restart", "done"];
  const s = await setup({ agent });
  await deliver(s, msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, поставь мод на сон" }));
  const plan = s.inConv(GROUP).at(-1)!;
  assert.match(plan.content!, /\*\*Перезапуск сервера:\*\* нужен — когда на сервере никого не будет/);
  const yes = s.reply(plan, ALICE, "да");
  await deliver(s, yes);
  assert.equal(s.followups!.issued.length, 1, "долгое разрешение взято сразу после «да»");
  const after = s.inConv(GROUP).filter((m) => m.replyToId === yes.id);
  assert.equal(after.length, 2);
  assert.match(after[0]!.content!, /Изменения на месте.*сервер перезапустится, когда на нём никого не будет/s);
  assert.match(after[1]!.content!, /\*\*Перезапуск:\*\* был — сервер поднялся/);
  for (const m of after) assert.ok(m.grant?.startsWith("followup_"), "пишем по долгому разрешению");
  // «верни как было» ответом на промежуточное сообщение тоже работает
  await deliver(s, s.reply(after[0]!, ALICE, "откати"));
  assert.equal(s.agent.calls.filter((c) => c.op === "undo").length, 1);
});

test("бот перезапустился, пока задача ждала перезапуска сервера: дослеживает и отчитывается по сохранённому разрешению", async () => {
  const store = new AdminStore(":memory:");
  const agent = new FakeAgent();
  agent.execSteps = ["executing", ...Array(400).fill("waiting_restart"), "done"];
  const s1 = await setup({ agent, store });
  await deliver(s1, msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, включи бесплатный крафт" }));
  const plan = s1.inConv(GROUP).at(-1)!;
  const yes = s1.reply(plan, ALICE, "да");
  await s1.h.deliver(yes);
  // ждём промежуточное «ждёт перезапуска» и «гасим» бота
  for (let i = 0; i < 200 && !s1.inConv(GROUP).some((m) => /Изменения на месте/.test(m.content ?? "")); i++) await new Promise((r) => setTimeout(r, 5));
  await s1.mod.stop!();
  assert.equal(store.openWatches().length, 1, "наблюдение сохранено");

  // новый процесс бота: модуль сам поднимает наблюдение из хранилища (задача всё ещё ждёт перезапуска)
  const s2 = await setup({ agent, store });
  for (const [g, c] of s1.h.api.grants) s2.h.api.grants.set(g, c); // те же разрешения на «сервере»
  // сервер перезапустился — задача завершилась
  (agent as unknown as { exec: Map<string, { steps: string[]; i: number }> }).exec.forEach((e) => {
    e.steps = ["done"];
    e.i = -1;
  });
  await s2.mod.admin.idle();
  const report = s2.inConv(GROUP).at(-1)!;
  assert.match(report.content ?? "", /✅ \*\*Готово\.\*\*/);
  assert.equal(report.replyToId, yes.id);
  assert.equal(store.openWatches().length, 0);
});

test("агент ответил без изменений — его ответ; «да» на такой ответ — новая просьба через модель", async () => {
  const agent = new FakeAgent();
  agent.planFor = (t) => (/ночи/.test(t) ? { kind: "answer", text: "Ночи короче серверно не сделать.\n\nЕсть мод ServersideQoL_JustSleep — поставить?" } : { kind: "plan", plan: samplePlan() });
  const s = await setup({ agent });
  await deliver(s, msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, сделай ночи короче" }));
  const ans = s.inConv(GROUP).at(-1)!;
  assert.equal(ans.kind, "answer");
  assert.match(ans.content!, /Ночи короче серверно не сделать\.\n\nЕсть мод/);
  await deliver(s, s.reply(ans, ALICE, "да"));
  assert.equal(s.h.llm.calls.length, 2, "«да» на ответ агента — модели (она передаст новую просьбу)");
  // и «да» без ответа, когда последнее сообщение бота — такой ответ агента, — тоже модели
  await deliver(s, msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, да" }));
  assert.equal(s.h.llm.calls.length, 3);
  assert.equal(s.agent.calls.filter((c) => c.op === "confirm").length, 0);
});

test("«да» без ответа (reply): в «Чате с Еблушей» и «Еблуша, да» в группе — про план, если план — последнее сообщение бота", async () => {
  const s = await setup();
  // «Чат с Еблушей»: просьба → план → просто «да», без ответа на план
  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "включи бесплатный крафт" }));
  assert.equal(s.inConv(DM_ALICE).at(-1)!.kind, "confirm");
  const yes = msg({ conversationId: DM_ALICE, senderId: ALICE, content: "да" });
  await deliver(s, yes);
  assert.equal(s.agent.calls.filter((c) => c.op === "confirm").length, 1);
  const report = s.inConv(DM_ALICE).at(-1)!;
  assert.equal(report.replyToId, yes.id, "отчёт — ответом на «да»");
  assert.match(report.content!, /^✅ \*\*Готово\.\*\*/);

  // группа: «Еблуша, нет» без ответа — отмена последнего плана
  h_link(s);
  await deliver(s, msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, поставь ресурсы x3" }));
  await deliver(s, msg({ conversationId: GROUP, senderId: BOB, content: "Еблуша, нет" }));
  assert.equal(s.agent.calls.filter((c) => c.op === "cancel").length, 1);
  assert.deepEqual(s.agent.calls.find((c) => c.op === "cancel")!.person, { userId: BOB, character: "РомаH" });
  assert.equal(s.inConv(GROUP).at(-1)!.content, "Отменил — ничего не меняю.");

  // после плана бот ответил на другой вопрос — «Еблуша, да» относится к тому разговору (модели), не к плану
  const backup = msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, сделай бэкап" });
  await deliver(s, backup);
  const llmBefore = s.h.llm.calls.length;
  await deliver(s, msg({ conversationId: GROUP, senderId: BOB, content: "Еблуша, рассказать тебе анекдот?" }));
  await deliver(s, msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, да" }));
  assert.equal(s.h.llm.calls.length, llmBefore + 2, "«да» ушло модели");
  assert.equal(s.agent.calls.filter((c) => c.op === "confirm").length, 1, "план не подтверждён");

  // «да» ответом на «сейчас разберусь — пришлю план» — тоже про этот план
  const ack = s.inConv(GROUP).find((m) => m.replyToId === backup.id && m.kind === "answer")!;
  assert.match(ack.content!, /пришлю план/);
  await deliver(s, s.reply(ack, BOB, "ок"));
  assert.equal(s.agent.calls.filter((c) => c.op === "confirm").length, 2);
  assert.match(s.inConv(GROUP).at(-1)!.content!, /Готово/);
});

test("«да» ответом на «пришлю план», пока агент думает, — «план ещё составляется»; после перезапуска бота «да» без ответа — подсказка", async () => {
  const store = new AdminStore(":memory:");
  const agent = new FakeAgent();
  agent.planPolls = 1_000_000;
  const s = await setup({ agent, store });
  await s.h.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "включи бесплатный крафт" }));
  const ack = s.inConv(DM_ALICE).at(-1)!;
  assert.match(ack.content!, /пришлю план/);
  await s.h.deliver(s.reply(ack, ALICE, "да"));
  assert.match(s.inConv(DM_ALICE).at(-1)!.content!, /План ещё составляется/);
  assert.equal(agent.calls.filter((c) => c.op === "confirm").length, 0);
  agent.planPolls = 0;
  await s.settle();
  assert.equal(s.inConv(DM_ALICE).at(-1)!.kind, "confirm");
  await s.mod.stop!();

  // новый процесс бота не помнит, что говорил последним: «да» без ответа — подсказка, а не подтверждение
  const s2 = await setup({ agent, store });
  await deliver(s2, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "да" }));
  assert.match(s2.inConv(DM_ALICE).at(-1)!.content!, /ответьте «да» или «нет» прямо на сообщение с планом/);
  assert.equal(agent.calls.filter((c) => c.op === "confirm").length, 0);
  assert.equal(s2.h.llm.calls.length, 0);
});

test("длинный план — всё равно одно сообщение (без строк диффа, пояснение короче)", () => {
  const changes = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    kind: "file_replace",
    description_ru: `Файл config/mod${i}.cfg: ${"правка ".repeat(40)}`,
    diff: `--- a\n+++ b\n@@ -1 +1 @@\n-${"x".repeat(110)}\n+${"y".repeat(110)}`,
  }));
  const task = {
    taskId: "t20261010-120000-ab12",
    status: "planned",
    target: "live",
    text: "много всего",
    requester: { userId: ALICE, character: "IiApaCiOxa" },
    plan: samplePlan({ changes, summary_ru: "с".repeat(900), notes_ru: "н".repeat(900), restart: "when_empty", risk: "medium" }),
  } as unknown as AgentTask;
  const text = formatPlan(task, { requesterName: "Алиса", isTest: false });
  assert.ok(text.length <= PLAN_MAX_CHARS, `длина ${text.length}`);
  assert.match(text, /…и ещё \d+/);
  assert.match(text, /\*\*Перезапуск сервера:\*\* нужен/);
  assert.doesNotMatch(text, /тестовым стендом/, "боевой — без пометки стенда");
  assert.equal(text.split("\n").at(-1), "Ответьте «да», чтобы применить, или «нет».");
});

function h_link(s: Setup): void {
  s.h.store.link(BOB, "РомаH", { linkedBy: BOB, verified: true, replaceOwn: true, force: false });
}

test("«верни как было» фразой (без ответа) — последняя задача этой беседы", async () => {
  const s = await setup();
  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "включи бесплатный крафт" }));
  await deliver(s, s.reply(s.inConv(DM_ALICE).at(-1)!, ALICE, "да"));
  assert.match(s.inConv(DM_ALICE).at(-1)!.content!, /Готово/);
  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "верни как было" }));
  assert.equal(s.agent.calls.filter((c) => c.op === "undo").length, 1);
  assert.match(s.inConv(DM_ALICE).at(-1)!.content!, /Вернул как было/);
  // в беседе без задач — фраза уходит модели
  await deliver(s, msg({ conversationId: DM_OWNER, senderId: OWNER, content: "верни как было" }));
  assert.equal(s.agent.calls.filter((c) => c.op === "undo").length, 1);
});

test("лимит просьб на человека в сутки; владельца не касается", async () => {
  const s = await setup({ cfg: { agentUserDaily: 1 } });
  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "включи бесплатный крафт" }));
  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "сделай бэкап" }));
  assert.match(s.toolResults[1]!.content, /исчерпан лимит/);
  await deliver(s, msg({ conversationId: DM_OWNER, senderId: OWNER, content: "поставь ресурсы x3" }));
  await deliver(s, msg({ conversationId: DM_OWNER, senderId: OWNER, content: "перезапусти сервер, когда все выйдут" }));
  assert.equal(s.agent.calls.filter((c) => c.op === "create").length, 3);
});

test("server_status: сервер, мир, агент (стенд), последние просьбы — только игрокам", async () => {
  const s = await setup();
  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "включи бесплатный крафт" }));
  await deliver(s, msg({ conversationId: DM_ALICE, senderId: ALICE, content: "как там сервер?" }));
  const r1 = s.toolResults.at(-1)!.content;
  assert.match(r1, /<untrusted_data>/);
  const j = JSON.parse(r1.split("\n").slice(1, -2).join("\n")) as Record<string, any>;
  assert.equal(j.server.running, true);
  assert.equal(j.server.gameVersion, "0.221.4");
  assert.equal(j.world.playersOnline, 3);
  assert.ok(j.worldSettingsChanged.some((x: string) => /Бесплатная стройка/.test(x)));
  assert.match(j.admin.serverItWorksWith, /тестовый стенд/);
  assert.equal(j.recentRequests[0].request, "включи бесплатный крафт");
  assert.equal(j.recentRequests[0].requestedBy, "IiApaCiOxa");
  await deliver(s, msg({ conversationId: GROUP, senderId: BOB, content: "Еблуша, как там сервер?" }));
  const j2 = JSON.parse(s.toolResults.at(-1)!.content.split("\n").slice(1, -2).join("\n")) as Record<string, any>;
  assert.equal(typeof j2.recentRequests, "string", "непривязанному — без чужих просьб");
});

test("отчёт «не получилось» и «применено без перезапуска»", () => {
  const base = { taskId: "t20261010-120000-ab12", text: "x", requester: { userId: ALICE, character: "IiApaCiOxa" }, confirmer: { userId: BOB, character: null }, plan: samplePlan({ restart: "when_empty" }) };
  const failed = formatReport({ ...base, status: "failed", canUndo: false, report_ru: "Не получилось.\nПричина: бэкап мира не удался", execution: { restart: null } } as unknown as AgentTask, "Боб");
  assert.match(failed, /^❗ \*\*Не получилось\.\*\*/);
  assert.match(failed, /Причина: бэкап мира не удался/);
  assert.match(failed, /подтвердил\(а\) Боб/);
  assert.doesNotMatch(failed, /верни как было/);
  const applied = formatReport(
    { ...base, status: "applied", canUndo: true, report_ru: "Изменения применены, перезапуск не случился.", execution: { restart: { requested: "when_empty", effective: "when_empty", note_ru: "ожидание снято", seenBoot: null } } } as unknown as AgentTask,
    null
  );
  assert.match(applied, /\*\*Перезапуск:\*\* не состоялся — изменения заработают при следующем перезапуске \(ожидание снято\)/);
  // длинный отчёт агента — всё равно одно сообщение, хвост (перезапуск, «верни как было») на месте
  const long = formatReport(
    { ...base, status: "done", canUndo: true, report_ru: ["Готово.", "Что сделано:", ...Array.from({ length: 60 }, (_, i) => `- шаг ${i}: ${"ж".repeat(280)}`)].join("\n"), execution: { restart: null } } as unknown as AgentTask,
    null
  );
  assert.ok(long.length <= PLAN_MAX_CHARS, `длина ${long.length}`);
  assert.match(long, /\n- …\n/);
  assert.equal(long.split("\n").at(-1), "Вернуть как было — ответьте на это сообщение «верни как было».");
});

test("клиент агента: токен в заголовке, 401 — перечитать файл, ошибки по коду, нет связи — недоступен", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-agent-"));
  const tokenFile = path.join(dir, "api.token");
  fs.writeFileSync(tokenFile, `${"a".repeat(32)}\n`);
  let expected = "a".repeat(32);
  const seen: Array<{ method: string; url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.headers["x-agent-token"] !== expected) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ ok: false, error: "unauthorized", message: "нужен заголовок X-Agent-Token" }));
      }
      if (req.url === "/health") return res.end(JSON.stringify({ ok: true, target: "test" }));
      if (req.url === "/tasks" && req.method === "POST") {
        res.statusCode = 202;
        return res.end(JSON.stringify({ taskId: "t20261010-120000-ab12", status: "planning" }));
      }
      if (req.url === "/tasks/t20261010-120000-ab12/confirm") {
        res.statusCode = 409;
        return res.end(JSON.stringify({ ok: false, error: "expired", message: "план устарел — попросите заново, агент составит свежий" }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "not_found", message: "нет" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const c = new AgentClient(`http://127.0.0.1:${port}`, tokenFile);
    assert.equal((await c.health()).target, "test");
    // токен сменили — клиент перечитает файл после 401
    expected = "b".repeat(32);
    fs.writeFileSync(tokenFile, expected);
    const t = await c.createTask({ userId: ALICE, character: "IiApaCiOxa" }, "включи бесплатный крафт", 0);
    assert.equal(t.status, "planning");
    assert.deepEqual(JSON.parse(seen.at(-1)!.body), { requester: { userId: ALICE, character: "IiApaCiOxa" }, text: "включи бесплатный крафт", waitMs: 0 });
    await assert.rejects(c.confirm("t20261010-120000-ab12", { userId: BOB, character: null }), (e: unknown) => e instanceof AgentError && e.status === 409 && e.code === "expired");
    await assert.rejects(c.getTask("../../etc/passwd"), (e: unknown) => e instanceof AgentError && e.status === 404);
    const dead = new AgentClient("http://127.0.0.1:1", tokenFile);
    await assert.rejects(dead.health(), (e: unknown) => e instanceof AgentUnavailable);
    const noToken = new AgentClient(`http://127.0.0.1:${port}`, path.join(dir, "missing"));
    await assert.rejects(noToken.health(), (e: unknown) => e instanceof AgentUnavailable);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
