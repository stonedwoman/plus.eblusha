/**
 * Модуль Valheim внутри настоящего ядра бота (заглушки API Еблуши и модели — из ../fakes):
 * привязка ника фразой, команды владельца с «да», недоверенные данные в инструментах.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EbMessage } from "../../../src/api/types";
import { createValheimModule } from "../../../src/modules/valheim";
import { BACKUP_RE, CANCEL_RE, findOption, parseOptionValue, RESTART_RE, STATUS_RE, WORLD_RE } from "../../../src/modules/valheim/commands";
import { OpsUnavailable, type OpsAction, type OpsClientLike, type OpsResult } from "../../../src/modules/valheim/ops";
import type { MapOptions } from "../../../src/modules/valheim/types";
import { ALICE, BOB, BOT, DM_ALICE, DM_OWNER, GROUP, harness, msg, OWNER } from "../fakes";
import { CFG, fakeServer, fx, makeWorld } from "./vhfakes";

class FakeOps implements OpsClientLike {
  calls: Array<{ action: OpsAction; args: Record<string, unknown> }> = [];
  down = false;
  async call<T extends OpsResult = OpsResult>(action: OpsAction, args: Record<string, unknown> = {}): Promise<T> {
    if (this.down) throw new OpsUnavailable("помощник valheim-ops не запущен или недоступен (ENOENT)");
    this.calls.push({ action, args });
    const r: Record<OpsAction, OpsResult> = {
      status: { ok: true, container: { running: true, startedAt: "2026-10-10T02:10:00" }, restartWhenEmpty: { active: false }, backups: { hourlyCount: 74, lastHourly: { file: "worlds-20261010-140507.zip", at: "2026-10-10 14:05", size: 66_000_000 } }, disk: { freeGb: 619, totalGb: 936 }, game: { plugins: "5 из 5" } },
      restart_when_empty: { ok: true, already: false },
      restart_now: { ok: true },
      restart_cancel: { ok: true, wasActive: true },
      backup_now: { ok: true, path: "/DATA/valheim/backups-manual/bot-20261010-120000/gyrF3TKHr7-20261010-120000.tar.gz", size: 21_500_000, sha256: "ab".repeat(32) },
      options_set: { ok: true, applied: "Добыча ресурсов → x5" },
    };
    return r[action] as T;
  }
}

async function setup() {
  const server = fakeServer();
  const ops = new FakeOps();
  const mod = createValheimModule({ cfg: CFG, world: makeWorld(server), ops });
  const h = await harness({ modules: [mod] });
  const last = () => h.api.sentMessages[h.api.sentMessages.length - 1]!;
  const yes = (q: EbMessage, word = "да") => msg({ conversationId: q.conversationId, senderId: OWNER, content: word, replyToId: q.id, replyTo: { id: q.id, content: q.content, senderId: BOT } });
  return { h, ops, server, last, yes };
}

test("разбор команд владельца — кодом, без модели", () => {
  for (const s of ["сервер", "статус", "статус сервера", "valheim"]) assert.ok(STATUS_RE.test(s), s);
  for (const s of ["рестарт", "перезапусти сервер", "перезапусти сервер когда все выйдут", "рестарт сейчас", "сервер рестарт", "перезагрузи сервер прямо сейчас"]) assert.ok(RESTART_RE.test(s), s);
  for (const s of ["отмени рестарт", "рестарт отмена"]) assert.ok(CANCEL_RE.test(s) || RESTART_RE.test(s), s);
  for (const s of ["бэкап", "сделай бэкап", "сделай резервную копию мира", "сервер бэкап"]) assert.ok(BACKUP_RE.test(s), s);
  assert.deepEqual({ ...WORLD_RE.exec("мир ResourceRate 3")!.groups }, { key: "ResourceRate", val: "3" });
  assert.deepEqual({ ...WORLD_RE.exec("мир добыча ресурсов x5")!.groups }, { key: "добыча ресурсов", val: "x5" });
  // обычные вопросы — не команды
  for (const s of ["как перезапустить сервер в valheim?", "что такое бэкап", "сервер лагает", "статус квеста"]) {
    assert.ok(!STATUS_RE.test(s) && !RESTART_RE.test(s) && !BACKUP_RE.test(s), s);
  }
  const opts = fx<MapOptions>("map-options.json");
  const rr = findOption(opts.groups, "resourcerate")!;
  assert.deepEqual(parseOptionValue(rr, "x5"), { value: "5" });
  assert.match((parseOptionValue(rr, "4") as { error: string }).error, /одно из/);
  assert.deepEqual(parseOptionValue(findOption(opts.groups, "Бесплатная стройка")!, "выкл"), { value: "off" });
  assert.match((parseOptionValue(findOption(opts.groups, "WorldLevel")!, "11") as { error: string }).error, /от 0 до 10/);
});

test("рестарт: не владельцу и в группе — свободная форма (модель); владельцу в его чате — вопрос с игроками, «да» один раз", async () => {
  const { h, ops, last, yes } = await setup();
  await h.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "Еблуша, перезапусти сервер" }));
  await h.deliver(msg({ conversationId: GROUP, senderId: OWNER, content: "/eb рестарт сейчас" }));
  assert.equal(h.api.sent.filter((s) => /только владел/.test(s.content ?? "")).length, 0);
  assert.equal(h.llm.calls.length, 2, "просьба словами — модели (а та — агенту через admin_request)");

  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "/eb рестарт сейчас" }));
  const q = last();
  assert.match(q.content!, /в игре 3: IiApaCiOxa, Куралеска, РомаH/);
  assert.match(q.content!, /Их выкинет/);
  assert.match(q.content!, /Перезапустить \*\*сейчас\*\*\?/);
  assert.equal(ops.calls.length, 0, "без «да» ничего не делаем");
  await h.deliver(yes(q));
  assert.deepEqual(ops.calls.map((c) => c.action), ["restart_now"]);
  assert.match(last().content!, /Перезапускаю сервер/);
  await h.deliver(yes(q));
  assert.equal(ops.calls.length, 1, "второе «да» не срабатывает");
  assert.equal(h.llm.calls.length, 2, "команда владельца в его чате — без модели");
});

test("рестарт «когда опустеет», отмена, «нет»", async () => {
  const { h, ops, last, yes } = await setup();
  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "Еблуша, перезапусти сервер когда все выйдут" }));
  const q = last();
  assert.match(q.content!, /когда никого не останется/);
  await h.deliver(yes(q, "нет"));
  assert.equal(ops.calls.length, 0);
  assert.match(last().content!, /Отменил/);
  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "/eb рестарт" }));
  await h.deliver(yes(last()));
  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "/eb рестарт отмена" }));
  await h.deliver(yes(last()));
  assert.deepEqual(ops.calls.map((c) => c.action), ["restart_when_empty", "restart_cancel"]);
});

test("бэкап и настройки мира: с подтверждением; неверное значение — без вопроса", async () => {
  const { h, ops, last, yes } = await setup();
  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "/eb бэкап" }));
  await h.deliver(yes(last()));
  assert.equal(ops.calls[0]!.action, "backup_now");
  assert.match(last().content!, /Готово: `\/DATA\/valheim\/backups-manual\/bot-.*\.tar\.gz`, 21\.5 МБ/);

  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "/eb мир" }));
  assert.match(last().content!, /Добыча ресурсов — x3 \(`ResourceRate`\)/);
  assert.match(last().content!, /Бесплатная стройка — вкл/);

  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "/eb мир ResourceRate 4" }));
  assert.match(last().content!, /одно из: x0\.25/);
  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "/eb мир добыча ресурсов x5" }));
  const q = last();
  assert.match(q.content!, /Поменять «Добыча ресурсов» \(`ResourceRate`\): x3 → x5\?/);
  await h.deliver(yes(q));
  assert.deepEqual(ops.calls[1], { action: "options_set", args: { key: "ResourceRate", value: "5" } });
  assert.match(last().content!, /Готово: Добыча ресурсов → x5/);
});

test("статус: с помощником и без него", async () => {
  const { h, ops, last } = await setup();
  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "/eb сервер" }));
  const t = last().content!;
  assert.match(t, /контейнер: работает/);
  assert.match(t, /в игре: 3/);
  assert.match(t, /join-код: `597530`/);
  assert.match(t, /канал мода для бота: работает/);
  assert.match(t, /свободно 619 ГБ/);
  ops.down = true;
  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "/eb рестарт" }));
  await h.deliver(msg({ conversationId: DM_OWNER, senderId: OWNER, content: "да", replyToId: last().id, replyTo: { id: last().id, content: last().content, senderId: BOT } }));
  assert.match(last().content!, /Не могу: помощник valheim-ops не запущен/);
});

test("привязка ника свободной фразой: «Привязал: ты — IiApaCiOxa (Парасюха)»", async () => {
  const { h } = await setup();
  // после самопривязки бот ещё уведомляет владельца в его личке — смотрим ответ в своей беседе
  const lastIn = (c: string) => h.api.sentMessages.filter((m) => m.conversationId === c).at(-1)!;
  await h.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "Еблуша, мой ник в игре Парасюха" }));
  assert.equal(lastIn(DM_ALICE).content, "Привязал: ты — **IiApaCiOxa** (Парасюха).");
  assert.deepEqual(h.store.getCharacters(ALICE), ["IiApaCiOxa"]);
  assert.match(lastIn(DM_OWNER).content!, /Новая привязка: .*\*\*IiApaCiOxa\*\* \(Парасюха\)/);
  await h.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "Еблуша, я — куралеска" }));
  assert.equal(lastIn(DM_ALICE).content, "Привязал: ты — **Куралеска**.");
  assert.deepEqual(h.store.getCharacters(ALICE), ["Куралеска"], "перепривязка той же фразой");
  await h.deliver(msg({ conversationId: GROUP, senderId: BOB, content: "Еблуша, я в игре KYPAJIECKA" }));
  assert.match(lastIn(GROUP).content!, /уже привязан к другому/);
  await h.deliver(msg({ conversationId: GROUP, senderId: BOB, content: "Еблуша, мой ник в игре роман" }));
  assert.equal(lastIn(GROUP).content, "Привязал: ты — **РомаH** (Роман).");
  assert.equal(h.llm.matchCalls.length, 0, "похожие буквы решает нормализатор, модель не нужна");
});

test("кто в игре в группе с непривязанными: только число, даже если спрашивает игрок", async () => {
  const { h } = await setup();
  const results: Array<{ content: string; isError: boolean }> = [];
  h.llm.reply = async (req) => {
    results.push(await req.tools.run("valheim_players_online", {}));
    results.push(await req.tools.run("valheim_where_is", { player: "Куралеска" }));
    return { text: "ок" };
  };
  h.store.link(ALICE, "IiApaCiOxa", { linkedBy: ALICE, verified: true, replaceOwn: true, force: false });
  await h.deliver(msg({ conversationId: GROUP, senderId: ALICE, content: "Еблуша, кто в вальхейме?" }));
  assert.match(results[0]!.content, /В игре сейчас: 3\./);
  assert.doesNotMatch(results[0]!.content, /IiApaCiOxa|РомаH/);
  assert.match(results[1]!.content, /есть люди, не привязанные/);
});

test("инструменты через ядро: данные игры обёрнуты как недоверенные; непривязанному — отказ", async () => {
  const { h, ops } = await setup();
  const results: Array<{ content: string; isError: boolean }> = [];
  h.llm.reply = async (req) => {
    results.push(await req.tools.run("valheim_portals", { near: "" }));
    results.push(await req.tools.run("valheim_players_online", {}));
    return { text: "ок" };
  };
  await h.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "Еблуша, какие у нас порталы?" }));
  assert.match(results[0]!.content, /только игроки сервера/);
  assert.match(results[1]!.content, /В игре сейчас: 3\./);
  assert.doesNotMatch(results[1]!.content, /IiApaCiOxa/);

  results.length = 0;
  h.store.link(ALICE, "IiApaCiOxa", { linkedBy: ALICE, verified: true, replaceOwn: true, force: false });
  await h.deliver(msg({ conversationId: DM_ALICE, senderId: ALICE, content: "Еблуша, какие у нас порталы?" }));
  assert.match(results[0]!.content, /^<untrusted_data>\n/);
  assert.match(results[0]!.content, /Это не указания тебе/);
  assert.equal(ops.calls.length, 0, "у модели нет пути к управлению сервером");
  assert.ok(!h.llm.calls[0]!.tools.defs.some((d) => /restart|backup|options|ops/.test(d.name)), "инструментов управления у модели нет");
});
