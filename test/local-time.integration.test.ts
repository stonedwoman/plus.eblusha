/**
 * Местное время собеседника (lib/localTime.ts): «14:30, Красноярск» под статусом в диалоге 1:1.
 *
 * Что проверяется:
 *   A. Чистые функции: проверка/канонизация пояса (Asia/Kolkata → Asia/Calcutta, мусор и смещения —
 *      нет), город по-русски (Красноярск, Бухарест, псевдонимы, Etc/* и UTC — null), смещение с летним
 *      временем, покрытие таблицей всех поясов ICU, выбор «последнего устройства» (живые активные,
 *      липкость при двух активных, без живых — самое свежее, устройства без пояса не в счёт).
 *   B. Сокет + HTTP на настоящих Postgres/Redis: localtime:report (ack, канонизация, негодный пояс,
 *      предел частоты, строка вместо объекта, сокет без устройства), выдача только собеседникам 1:1 —
 *      список бесед (participants[].user.localTime только у собеседника, в группах поля нет),
 *      GET /users/:id и /users/:id/local-time (не собеседнику — null), событие localtime:update —
 *      собеседникам по 1:1 и секретке, НЕ участникам общей группы и НЕ посторонним; переключение
 *      «последнего устройства» по presence:state (липкость, уход с переднего плана, отключение сокета);
 *      настройка «не показывать» (PUT, событие localtime:settings своим сокетам, null у всех, смена пояса
 *      при выключенной — без событий, включение — снова виден); восстановление выключенной настройки
 *      после потери Redis (reassert: новее — принимается, старее/из будущего — нет); REST-путь пояса;
 *      отзыв устройства убирает его пояс.
 *
 * Запускать ТОЛЬКО в изолированной среде (guard.ts не пустит к боевым БД/Redis):
 *   test/secret-env/secret-test.sh run test/local-time.integration.test.ts
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import app from "../src/app";
import env from "../src/config/env";
import prisma from "../src/lib/prisma";
import { getRedisClient } from "../src/lib/redis";
import { initSocket } from "../src/realtime/socket";
import { signAccessToken } from "../src/utils/jwt";
import { getPushQueue } from "../src/jobs/queue";
import {
  LIVE_MS,
  LOCALTIME_REPORTS_PER_MINUTE,
  cityForTimeZone,
  describeTimeZone,
  normalizeTimeZone,
  offsetMinutesAt,
  pickEffectiveDevice,
  type DeviceTzRecord,
} from "../src/lib/localTime";
import { RU_CITY_BY_TIME_ZONE } from "../src/lib/localTimeCities";
import { io as ioClient } from "socket.io-client";

const RUN = `ebst_lt_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let baseUrl = "";

type Resp = { status: number; body: any };
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { token: string; device?: string; body?: unknown },
): Promise<Resp> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
      ...(opts.device ? { "X-Device-Id": opts.device } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

type U = { id: string; token: string };
let seq = 0;
async function mkUser(tag: string): Promise<U> {
  seq += 1;
  const user = await prisma.user.create({ data: { username: `${RUN}_${tag}_${seq}`, passwordHash: `x_${crypto.randomUUID()}` } });
  return { id: user.id, token: signAccessToken({ sub: user.id, tokenId: crypto.randomUUID() }) };
}
async function mkDevice(u: U, tag: string): Promise<string> {
  const id = `${RUN}-${tag}`;
  await prisma.userDevice.create({
    data: { id, userId: u.id, name: `${RUN} ${tag}`, platform: "test", publicKey: crypto.randomBytes(32).toString("base64") },
  });
  return id;
}
async function mkConv(members: U[], opts: { secret?: boolean; group?: boolean } = {}): Promise<string> {
  const c = await prisma.conversation.create({
    data: {
      isGroup: Boolean(opts.group),
      isSecret: Boolean(opts.secret),
      ...(opts.secret ? { type: "SECRET" } : {}),
      createdById: members[0]!.id,
      participants: { create: members.map((m) => ({ userId: m.id })) },
    } as any,
  });
  return c.id;
}

type Sock = { s: ReturnType<typeof ioClient>; events: Array<{ event: string; payload: any; at: number }>; label: string };
const openSockets: Sock[] = [];
async function connectSock(u: U, label: string, deviceId?: string): Promise<Sock> {
  const token = signAccessToken({ sub: u.id, tokenId: crypto.randomUUID(), ...(deviceId ? { did: deviceId } : {}) });
  const s = ioClient(baseUrl, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
  const sock: Sock = { s, events: [], label };
  s.onAny((event: string, payload: any) => sock.events.push({ event, payload, at: Date.now() }));
  await new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("connect_error", reject);
  });
  openSockets.push(sock);
  return sock;
}
const LT = "localtime:update";
const updatesAbout = (sock: Sock, userId: string) => sock.events.filter((e) => e.event === LT && e.payload?.userId === userId);
function mark(socks: Sock[]): Map<Sock, number> {
  return new Map(socks.map((s) => [s, s.events.length]));
}
const since = (sock: Sock, m: Map<Sock, number>) => sock.events.slice(m.get(sock) ?? 0);
async function waitUpdate(sock: Sock, m: Map<Sock, number>, userId: string, ms = 2500): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const got = since(sock, m).filter((e) => e.event === LT && e.payload?.userId === userId);
    if (got.length > 0) {
      await sleep(80);
      const all = since(sock, m).filter((e) => e.event === LT && e.payload?.userId === userId);
      assert.equal(all.length, 1, `${sock.label}: ждали ОДНО localtime:update, пришло ${all.length}`);
      return all[0]!.payload;
    }
    if (Date.now() - t0 > ms) assert.fail(`${sock.label}: не пришло localtime:update о ${userId}`);
    await sleep(20);
  }
}
async function expectNoUpdate(socks: Sock[], m: Map<Sock, number>, userId: string, waitMs = 700) {
  await sleep(waitMs);
  for (const s of socks) {
    const got = since(s, m).filter((e) => e.event === LT && e.payload?.userId === userId);
    assert.equal(got.length, 0, `${s.label}: не должно быть localtime:update о ${userId} (пришло ${JSON.stringify(got.map((g) => g.payload))})`);
  }
}
async function report(sock: Sock, payload: unknown): Promise<any> {
  return sock.s.timeout(3000).emitWithAck("localtime:report", payload);
}
async function presence(sock: Sock, active: boolean) {
  sock.s.emit("presence:state", { active, visibility: active ? "visible" : "hidden", source: "web" });
  await sleep(250);
}

type StepResult = { name: string; ok: boolean; err?: string };
const results: StepResult[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message ?? String(e) });
    console.log(`  FAIL ${name}: ${e?.message ?? e}`);
  }
}

const rec = (tz: string | null, usedAt: number, active = false): DeviceTzRecord => ({ tz, usedAt, active });

async function main() {
  console.log(`[local-time] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[local-time] isolated backends: ${JSON.stringify(identity)}`);

  // ================================================================ A. чистые функции
  console.log("A — чистые функции");
  await step("normalizeTimeZone: годные имена, канонизация, мусор", async () => {
    assert.equal(normalizeTimeZone("Asia/Krasnoyarsk"), "Asia/Krasnoyarsk");
    assert.equal(normalizeTimeZone("  Europe/Bucharest "), "Europe/Bucharest");
    assert.equal(normalizeTimeZone("America/Argentina/Buenos_Aires"), normalizeTimeZone("America/Buenos_Aires"));
    assert.equal(normalizeTimeZone("Asia/Kolkata"), normalizeTimeZone("Asia/Calcutta"));
    assert.equal(normalizeTimeZone("Europe/Kyiv"), normalizeTimeZone("Europe/Kiev"));
    assert.ok(normalizeTimeZone("Etc/GMT-7"));
    assert.ok(normalizeTimeZone("UTC"));
    for (const bad of ["", "   ", "Mars/Olympus_Mons", "+07:00", "UTC+7", "../etc/passwd", "Asia/Krasnoyarsk; DROP", "a".repeat(65), "__proto__", "constructor"]) {
      assert.equal(normalizeTimeZone(bad), null, `«${bad}» должен быть отвергнут`);
    }
    for (const bad of [null, undefined, 7, {}, ["Asia/Krasnoyarsk"]]) assert.equal(normalizeTimeZone(bad as any), null);
  });
  await step("cityForTimeZone: Красноярск, Бухарест, псевдонимы; Etc/UTC — null", async () => {
    assert.equal(cityForTimeZone("Asia/Krasnoyarsk"), "Красноярск");
    assert.equal(cityForTimeZone("Europe/Bucharest"), "Бухарест");
    assert.equal(cityForTimeZone("Europe/Moscow"), "Москва");
    assert.equal(cityForTimeZone("Asia/Novosibirsk"), "Новосибирск");
    assert.equal(cityForTimeZone("Europe/Kaliningrad"), "Калининград");
    assert.equal(cityForTimeZone("Asia/Kolkata"), cityForTimeZone("Asia/Calcutta"));
    assert.equal(cityForTimeZone("Europe/Kyiv"), "Киев");
    assert.equal(cityForTimeZone("America/Argentina/Buenos_Aires"), "Буэнос-Айрес");
    assert.equal(cityForTimeZone("Etc/GMT-7"), null);
    assert.equal(cityForTimeZone("UTC"), null);
    assert.equal(cityForTimeZone("Etc/UTC"), null);
    assert.equal(cityForTimeZone("Mars/Olympus_Mons"), null);
  });
  await step("offsetMinutesAt: постоянные и с летним временем", async () => {
    assert.equal(offsetMinutesAt("Asia/Krasnoyarsk"), 420);
    assert.equal(offsetMinutesAt("Asia/Kolkata"), 330);
    assert.equal(offsetMinutesAt("Asia/Kathmandu"), 345);
    assert.equal(offsetMinutesAt("UTC"), 0);
    assert.equal(offsetMinutesAt("Etc/GMT-7"), 420);
    assert.equal(offsetMinutesAt("Etc/GMT+5"), -300);
    assert.equal(offsetMinutesAt("Europe/Bucharest", Date.UTC(2026, 0, 15)), 120);
    assert.equal(offsetMinutesAt("Europe/Bucharest", Date.UTC(2026, 6, 15)), 180);
    assert.equal(offsetMinutesAt("America/St_Johns", Date.UTC(2026, 0, 15)), -210);
    assert.equal(offsetMinutesAt("America/St_Johns", Date.UTC(2026, 6, 15)), -150);
  });
  await step("describeTimeZone: {timeZone, city, offsetMinutes}", async () => {
    assert.deepEqual(describeTimeZone("Asia/Krasnoyarsk"), { timeZone: "Asia/Krasnoyarsk", city: "Красноярск", offsetMinutes: 420 });
    assert.deepEqual(describeTimeZone("Etc/GMT-7"), { timeZone: "Etc/GMT-7", city: null, offsetMinutes: 420 });
    assert.equal(describeTimeZone("nope/nope"), null);
  });
  await step("таблица городов покрывает все пояса ICU с городом (кроме Etc/*, UTC и пр.)", async () => {
    const all = (Intl as any).supportedValuesOf("timeZone") as string[];
    const noCity = all.filter((tz) => /\//.test(tz) && !tz.startsWith("Etc/") && cityForTimeZone(tz) === null);
    console.log(`       поясов ICU: ${all.length}, в таблице: ${Object.keys(RU_CITY_BY_TIME_ZONE).length}, без города: ${noCity.length} ${JSON.stringify(noCity)}`);
    assert.ok(noCity.length <= 3, `без города: ${noCity.join(", ")}`);
    for (const [tz, city] of Object.entries(RU_CITY_BY_TIME_ZONE)) {
      assert.ok(city && !/[A-Za-z]{3,}/.test(city), `город для ${tz} не по-русски: ${city}`);
    }
  });
  await step("pickEffectiveDevice: живые активные, липкость, без живых — самое свежее, без пояса — не в счёт", async () => {
    const now = 10_000_000;
    // один-единственный — даже неактивный и никогда не бывший на переднем плане
    assert.equal(pickEffectiveDevice({ a: rec("Asia/Krasnoyarsk", 0) }, null, now), "a");
    // без пояса — не в счёт
    assert.equal(pickEffectiveDevice({ a: rec(null, now, true) }, null, now), null);
    assert.equal(pickEffectiveDevice({ a: rec(null, now, true), b: rec("Europe/Bucharest", 5) }, null, now), "b");
    // живой активный побеждает более свежий неактивный
    assert.equal(pickEffectiveDevice({ a: rec("X/A", now - 60_000, true), b: rec("X/B", now - 1_000) }, "b", now), "a");
    // два живых активных: остаётся текущий (без дребезга)
    assert.equal(pickEffectiveDevice({ a: rec("X/A", now - 90_000, true), b: rec("X/B", now - 1_000, true) }, "a", now), "a");
    assert.equal(pickEffectiveDevice({ a: rec("X/A", now - 90_000, true), b: rec("X/B", now - 1_000, true) }, "b", now), "b");
    // текущий не живой — самый свежий из живых
    assert.equal(pickEffectiveDevice({ a: rec("X/A", now - 90_000, true), b: rec("X/B", now - 1_000, true), c: rec("X/C", now) }, "c", now), "b");
    // «активный», но давно без хартбита (сокет умер без disconnect) — не живой
    assert.equal(pickEffectiveDevice({ a: rec("X/A", now - LIVE_MS - 1, true), b: rec("X/B", now - 10_000) }, "a", now), "b");
    // живых нет: самое свежее; равенство — текущий
    assert.equal(pickEffectiveDevice({ a: rec("X/A", 100), b: rec("X/B", 200) }, "a", now), "b");
    assert.equal(pickEffectiveDevice({ a: rec("X/A", 200), b: rec("X/B", 200) }, "a", now), "a");
    assert.equal(pickEffectiveDevice({ a: rec("X/A", 200), b: rec("X/B", 200) }, "b", now), "b");
    assert.equal(pickEffectiveDevice({}, "a", now), null);
  });

  // ================================================================ B. сокет + HTTP
  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const A = await mkUser("a"); // чьё время показываем: ПК (A1) и телефон (A2)
    const B = await mkUser("b"); // собеседник A по 1:1
    const E = await mkUser("e"); // собеседник A только по секретке
    const G = await mkUser("g"); // с A только в общей группе
    const X = await mkUser("x"); // посторонний
    const A1 = await mkDevice(A, "A1");
    const A2 = await mkDevice(A, "A2");
    const direct = await mkConv([A, B]);
    await mkConv([A, E], { secret: true });
    const group = await mkConv([A, B, G], { group: true });

    const sB = await connectSock(B, "B (1:1)");
    const sE = await connectSock(E, "E (секретка)");
    const sG = await connectSock(G, "G (только группа)");
    const sX = await connectSock(X, "X (посторонний)");
    const peers = [sB, sE];
    const outsiders = [sG, sX];

    console.log("B — сокет и выдача собеседникам");
    const sA1 = await connectSock(A, "A1 (ПК)", A1);
    await step("A1 на переднем плане сообщает Asia/Krasnoyarsk → ack ok; собеседникам 1:1 и секретки — событие, группе и постороннему — нет", async () => {
      await presence(sA1, true);
      const m = mark([...peers, ...outsiders, sA1]);
      const ack = await report(sA1, { timeZone: "Asia/Krasnoyarsk" });
      assert.equal(ack.ok, true, JSON.stringify(ack));
      assert.equal(ack.timeZone, "Asia/Krasnoyarsk");
      assert.equal(ack.shareLocalTime, true);
      assert.equal(ack.shareLocalTimeAt, 0);
      for (const p of peers) {
        const e = await waitUpdate(p, m, A.id);
        assert.deepEqual(e, { userId: A.id, localTime: { timeZone: "Asia/Krasnoyarsk", city: "Красноярск", offsetMinutes: 420 } });
      }
      await expectNoUpdate([...outsiders, sA1], m, A.id, 300);
    });
    await step("повторный тот же пояс — без событий", async () => {
      const m = mark(peers);
      const ack = await report(sA1, { timeZone: "Asia/Krasnoyarsk" });
      assert.equal(ack.ok, true);
      await expectNoUpdate(peers, m, A.id);
    });
    await step("список бесед B: у A в 1:1 есть localTime, у самого B — нет; в группе поля нет ни у кого", async () => {
      const r = await call("GET", "/api/conversations", { token: B.token });
      assert.equal(r.status, 200);
      const d = r.body.conversations.find((c: any) => c.conversation.id === direct);
      assert.ok(d, "беседа 1:1 в списке");
      const pa = d.conversation.participants.find((p: any) => p.userId === A.id);
      const pb = d.conversation.participants.find((p: any) => p.userId === B.id);
      assert.deepEqual(pa.user.localTime, { timeZone: "Asia/Krasnoyarsk", city: "Красноярск", offsetMinutes: 420 });
      assert.equal("localTime" in pb.user, false, "у себя поля нет");
      const g = r.body.conversations.find((c: any) => c.conversation.id === group);
      assert.ok(g, "группа в списке");
      for (const p of g.conversation.participants) assert.equal("localTime" in p.user, false, "в группе поля нет");
    });
    await step("список бесед G (только группа с A): поля localTime нет", async () => {
      const r = await call("GET", "/api/conversations", { token: G.token });
      for (const c of r.body.conversations) for (const p of c.conversation.participants) assert.equal("localTime" in p.user, false);
    });
    await step("GET /users/A/local-time и /users/A: собеседнику 1:1 и секретки — время, группе/постороннему — null", async () => {
      const want = { timeZone: "Asia/Krasnoyarsk", city: "Красноярск", offsetMinutes: 420 };
      for (const v of [B, E]) {
        const r = await call("GET", `/api/users/${A.id}/local-time`, { token: v.token });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { userId: A.id, localTime: want });
        const u = await call("GET", `/api/users/${A.id}`, { token: v.token });
        assert.deepEqual(u.body.user.localTime, want);
      }
      for (const v of [G, X]) {
        const r = await call("GET", `/api/users/${A.id}/local-time`, { token: v.token });
        assert.deepEqual(r.body, { userId: A.id, localTime: null });
        const u = await call("GET", `/api/users/${A.id}`, { token: v.token });
        assert.equal(u.body.user.localTime, null);
      }
    });

    const sA2 = await connectSock(A, "A2 (телефон)", A2);
    await step("A2 сообщает Europe/Bucharest в фоне → выбранным не становится (A1 активен)", async () => {
      const m = mark(peers);
      const ack = await report(sA2, { timeZone: "Europe/Bucharest" });
      assert.equal(ack.ok, true);
      await expectNoUpdate(peers, m, A.id);
    });
    await step("A2 выходит на передний план при активном A1 → без переключения (липкость)", async () => {
      const m = mark(peers);
      await presence(sA2, true);
      await expectNoUpdate(peers, m, A.id);
    });
    await step("A1 уходит с переднего плана → выбран A2: Бухарест", async () => {
      const m = mark([...peers, ...outsiders]);
      await presence(sA1, false);
      const e = await waitUpdate(sB, m, A.id);
      assert.equal(e.localTime.timeZone, "Europe/Bucharest");
      assert.equal(e.localTime.city, "Бухарест");
      assert.equal(e.localTime.offsetMinutes, offsetMinutesAt("Europe/Bucharest"));
      await waitUpdate(sE, m, A.id);
      await expectNoUpdate(outsiders, m, A.id, 200);
    });
    await step("A2 отключается (был активен) → остаётся Бухарест (самое свежее «пользование»)", async () => {
      const m = mark(peers);
      sA2.s.close();
      await expectNoUpdate(peers, m, A.id, 900);
      const r = await call("GET", `/api/users/${A.id}/local-time`, { token: B.token });
      assert.equal(r.body.localTime.timeZone, "Europe/Bucharest");
    });
    await step("A1 снова на переднем плане → Красноярск", async () => {
      const m = mark(peers);
      await presence(sA1, true);
      const e = await waitUpdate(sB, m, A.id);
      assert.equal(e.localTime.timeZone, "Asia/Krasnoyarsk");
    });
    await step("смена пояса на активном A1 (Asia/Kolkata) → событие с каноническим именем; строкой тоже принимается", async () => {
      const m = mark(peers);
      const ack = await report(sA1, "Asia/Kolkata");
      assert.equal(ack.ok, true, JSON.stringify(ack));
      const e = await waitUpdate(sB, m, A.id);
      assert.equal(e.localTime.timeZone, normalizeTimeZone("Asia/Kolkata"));
      assert.equal(e.localTime.city, cityForTimeZone("Asia/Calcutta"));
      assert.equal(e.localTime.offsetMinutes, 330);
      const m2 = mark(peers);
      assert.equal((await report(sA1, { timeZone: "Asia/Krasnoyarsk" })).ok, true);
      await waitUpdate(sB, m2, A.id);
    });
    await step("негодный пояс → ack {ok:false, error:invalid_time_zone}, ничего не меняется", async () => {
      const m = mark(peers);
      for (const bad of [{ timeZone: "Mars/Olympus_Mons" }, { timeZone: "+07:00" }, {}, null, 42]) {
        const ack = await report(sA1, bad);
        assert.deepEqual(ack, { ok: false, error: "invalid_time_zone" }, JSON.stringify(bad));
      }
      await expectNoUpdate(peers, m, A.id, 300);
    });
    await step(`предел частоты: не больше ${LOCALTIME_REPORTS_PER_MINUTE} сообщений в минуту с сокета`, async () => {
      const s = await connectSock(A, "A1 (второй сокет для предела)", A1);
      const acks: any[] = [];
      for (let i = 0; i <= LOCALTIME_REPORTS_PER_MINUTE; i++) acks.push(await report(s, { timeZone: "Asia/Krasnoyarsk" }));
      assert.ok(acks.slice(0, LOCALTIME_REPORTS_PER_MINUTE).every((a) => a.ok === true));
      assert.deepEqual(acks[LOCALTIME_REPORTS_PER_MINUTE], { ok: false, error: "rate_limited" });
      s.s.close();
      await sleep(300);
    });

    console.log("B — настройка «Показывать моё местное время»");
    let offAt = 0;
    await step("GET /status/me/local-time: по умолчанию включено, свой пояс виден", async () => {
      const r = await call("GET", "/api/status/me/local-time", { token: A.token });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        shareLocalTime: true,
        shareLocalTimeAt: 0,
        localTime: { timeZone: "Asia/Krasnoyarsk", city: "Красноярск", offsetMinutes: 420 },
      });
    });
    await step("выключить → ответ, localtime:settings своим сокетам, null собеседникам; список и /users — null", async () => {
      const m = mark([...peers, ...outsiders, sA1]);
      const r = await call("PUT", "/api/status/me/local-time", { token: A.token, body: { shareLocalTime: false } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.shareLocalTime, false);
      assert.ok(r.body.shareLocalTimeAt > 0);
      offAt = r.body.shareLocalTimeAt;
      assert.equal(r.body.localTime.timeZone, "Asia/Krasnoyarsk", "сам человек свой пояс видит");
      for (const p of peers) assert.deepEqual(await waitUpdate(p, m, A.id), { userId: A.id, localTime: null });
      await expectNoUpdate(outsiders, m, A.id, 200);
      const t0 = Date.now();
      while (!since(sA1, m).some((e) => e.event === "localtime:settings") && Date.now() - t0 < 2000) await sleep(20);
      const st = since(sA1, m).filter((e) => e.event === "localtime:settings");
      assert.equal(st.length, 1);
      assert.deepEqual(st[0]!.payload, { shareLocalTime: false, shareLocalTimeAt: offAt });
      const list = await call("GET", "/api/conversations", { token: B.token });
      const d = list.body.conversations.find((c: any) => c.conversation.id === direct);
      assert.equal(d.conversation.participants.find((p: any) => p.userId === A.id).user.localTime, null);
      assert.equal((await call("GET", `/api/users/${A.id}/local-time`, { token: B.token })).body.localTime, null);
      assert.equal((await call("GET", `/api/users/${A.id}`, { token: B.token })).body.user.localTime, null);
    });
    await step("при выключенной смена пояса — без событий; ack несёт состояние настройки", async () => {
      const m = mark(peers);
      const ack = await report(sA1, { timeZone: "Europe/Bucharest" });
      assert.equal(ack.ok, true);
      assert.equal(ack.shareLocalTime, false);
      assert.equal(ack.shareLocalTimeAt, offAt);
      await expectNoUpdate(peers, m, A.id);
      assert.equal((await call("GET", `/api/users/${A.id}/local-time`, { token: B.token })).body.localTime, null);
    });
    await step("потеря Redis: настройка пропала → устройство напоминает {false, at} → снова выключено, событие null", async () => {
      await redis.del(`ltz:share:${A.id}`);
      const leaked = await call("GET", `/api/users/${A.id}/local-time`, { token: B.token });
      assert.equal(leaked.body.localTime?.timeZone, "Europe/Bucharest", "без настройки — снова видно (это и чиним)");
      const m = mark(peers);
      const ack = await report(sA1, { timeZone: "Europe/Bucharest", shareLocalTime: false, shareLocalTimeAt: offAt });
      assert.equal(ack.ok, true);
      assert.equal(ack.shareLocalTime, false);
      assert.equal(ack.shareLocalTimeAt, offAt);
      assert.deepEqual(await waitUpdate(sB, m, A.id), { userId: A.id, localTime: null });
      assert.equal((await call("GET", `/api/users/${A.id}/local-time`, { token: B.token })).body.localTime, null);
    });
    await step("устаревшее устройство {true, at старее} не перебивает; «из будущего» не принимается", async () => {
      const m = mark(peers);
      const ack1 = await report(sA1, { timeZone: "Europe/Bucharest", shareLocalTime: true, shareLocalTimeAt: offAt - 1 });
      assert.equal(ack1.shareLocalTime, false);
      const ack2 = await report(sA1, { timeZone: "Europe/Bucharest", shareLocalTime: true, shareLocalTimeAt: Date.now() + 3_600_000 });
      assert.equal(ack2.shareLocalTime, false);
      const ack3 = await report(sA1, { timeZone: "Europe/Bucharest", shareLocalTime: true, shareLocalTimeAt: "x" });
      assert.equal(ack3.shareLocalTime, false);
      await expectNoUpdate(peers, m, A.id);
    });
    await step("включить → собеседникам снова пояс; at растёт", async () => {
      const m = mark(peers);
      const r = await call("PUT", "/api/status/me/local-time", { token: A.token, body: { shareLocalTime: true } });
      assert.equal(r.status, 200);
      assert.equal(r.body.shareLocalTime, true);
      assert.ok(r.body.shareLocalTimeAt > offAt);
      const e = await waitUpdate(sB, m, A.id);
      assert.equal(e.localTime.timeZone, "Europe/Bucharest");
    });

    console.log("B — REST-путь, сокет без устройства, отзыв устройства");
    await step("PUT /status/me/local-time {timeZone} с X-Device-Id: годный — принят, негодный — 400 INVALID_TIME_ZONE", async () => {
      const A3 = await mkDevice(A, "A3");
      const bad = await call("PUT", "/api/status/me/local-time", { token: A.token, device: A3, body: { timeZone: "Nowhere/Land" } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, "INVALID_TIME_ZONE");
      const badType = await call("PUT", "/api/status/me/local-time", { token: A.token, body: { shareLocalTime: "no" } });
      assert.equal(badType.status, 400);
      const m = mark(peers);
      // REST засчитывается как «пользовался сейчас»: A3 свежее A1 (который уже не шлёт хартбит в тесте? — шлёт,
      // но A1 активен и выбран; REST-устройство не «активно» → A1 остаётся)
      const ok = await call("PUT", "/api/status/me/local-time", { token: A.token, device: A3, body: { timeZone: "Asia/Vladivostok" } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      await expectNoUpdate(peers, m, A.id);
      // A1 уходит с переднего плана: A1.usedAt = сейчас, свежее A3 → остаётся Бухарест
      await presence(sA1, false);
      await expectNoUpdate(peers, m, A.id, 300);
      // A3 сообщает снова (позже) → самое свежее «пользование» → Владивосток
      const ok2 = await call("PUT", "/api/status/me/local-time", { token: A.token, device: A3, body: { timeZone: "Asia/Vladivostok" } });
      assert.equal(ok2.status, 200);
      const e = await waitUpdate(sB, m, A.id);
      assert.equal(e.localTime.city, "Владивосток");
      // отзыв A3 → его пояс забыт → снова самое свежее из оставшихся (A1, Бухарест)
      const m2 = mark(peers);
      const del = await call("DELETE", `/api/devices/${A3}`, { token: A.token });
      assert.equal(del.status, 200);
      const e2 = await waitUpdate(sB, m2, A.id);
      assert.equal(e2.localTime.timeZone, "Europe/Bucharest");
    });
    await step("сокет без проверенного устройства — общее поле nodev, работает так же", async () => {
      const N = await mkUser("n");
      const P = await mkUser("p");
      await mkConv([N, P]);
      const sP = await connectSock(P, "P (собеседник N)");
      const sN = await connectSock(N, "N (без устройства)");
      await presence(sN, true);
      const m = mark([sP]);
      const ack = await report(sN, { timeZone: "Asia/Krasnoyarsk" });
      assert.equal(ack.ok, true);
      const e = await waitUpdate(sP, m, N.id);
      assert.equal(e.localTime.city, "Красноярск");
      const keys = Object.keys(await redis.hGetAll(`ltz:dev:${N.id}`));
      assert.deepEqual(keys, ["nodev"]);
    });
    await step("старый клиент (presence есть, пояса нет) не мешает: выбирается устройство с поясом", async () => {
      const O = await mkUser("o");
      const Q = await mkUser("q");
      await mkConv([O, Q]);
      const O1 = await mkDevice(O, "O1");
      const O2 = await mkDevice(O, "O2");
      const sQ = await connectSock(Q, "Q (собеседник O)");
      const sO1 = await connectSock(O, "O1 (новый клиент)", O1);
      await presence(sO1, true);
      const m = mark([sQ]);
      assert.equal((await report(sO1, { timeZone: "Europe/Moscow" })).ok, true);
      assert.equal((await waitUpdate(sQ, m, O.id)).localTime.city, "Москва");
      const sO2 = await connectSock(O, "O2 (старый клиент)", O2);
      const m2 = mark([sQ]);
      await presence(sO2, true);
      await presence(sO1, false);
      await expectNoUpdate([sQ], m2, O.id);
      const r = await call("GET", `/api/users/${O.id}/local-time`, { token: Q.token });
      assert.equal(r.body.localTime.city, "Москва");
    });
  } finally {
    for (const s of openSockets) s.s.close();
    io.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().then(
  async () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nlocal-time: ${results.length - failed.length}/${results.length} ok`);
    for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
    await getPushQueue().close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(failed.length ? 1 : 0);
  },
  async (err) => {
    console.error("local-time: CRASHED", err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  },
);
