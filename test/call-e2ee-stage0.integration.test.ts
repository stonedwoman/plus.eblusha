/**
 * E2EE звонков, этап 0 (сервер): звонок 1:1 без шифрования невозможен.
 *   - рубильника E2EE_1TO1 нет: ключ 1:1 выдаётся и создаётся при call:invite даже с
 *     E2EE_1TO1= (пусто — единственное значение, которым старый код выключал шифрование);
 *   - вебхук LiveKit track_published с encryption NONE в комнате `conv-<id>` беседы 1:1 →
 *     MutePublishedTrack + RemoveParticipant (подставной RoomService на 127.0.0.1);
 *     в группе, для зашифрованных и data-дорожек, для комнат не `conv-` — ничего;
 *   - вебхук без подписи или с чужой подписью → 401 и ни одного вызова RoomService (правка В11);
 *   - (ревью этапа 0) выкидывание идёт в фоне и с повторами: ответ вебхука не ждёт RoomService,
 *     сбой RoomService/БД повторяется; выкинутому устройству 2 мин не выдаётся пропуск в ту же
 *     комнату; комната несуществующей беседы — тоже выкидываем;
 *   - (ревью этапа 0) ключ 1:1 продлевается при каждом чтении, accept, room:join и у идущих
 *     звонков: повторный запрос не создаёт новый ключ.
 *
 * Запускать ТОЛЬКО в изолированной среде (боевые БД/Redis недоступны предохранителю guard.ts):
 *   test/secret-env/secret-test.sh run test/call-e2ee-stage0.integration.test.ts
 *
 * Модули приложения грузятся динамически ПОСЛЕ того, как выставлены переменные окружения теста
 * (src/config/env.ts читает process.env один раз, при первом импорте).
 */
import { assertIsolatedBackends, describeUrl } from "./secret-env/guard";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const RUN = `ebst_ce0_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = () => crypto.randomBytes(32).toString("base64");

let baseUrl = "";
const sockets: ClientSocket[] = [];

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

type Resp = { status: number; body: any };
async function call(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; device?: string; body?: unknown } = {}
): Promise<Resp> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
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

// ---------- подставной RoomService (Twirp поверх HTTP, как у livekit-server-sdk) ----------
type RsCall = { method: string; body: any; authorization: string | undefined; failed?: boolean };
const rsCalls: RsCall[] = [];
/** Сколько следующих вызовов RoomService отвечают 503 (проверка повторов). */
let rsFailNext = 0;
const fakeRoomService = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const method = String(req.url ?? "").replace(/^\/twirp\/livekit\.RoomService\//, "");
    let body: any = {};
    try {
      body = data ? JSON.parse(data) : {};
    } catch {
      body = { raw: data };
    }
    if (rsFailNext > 0) {
      rsFailNext -= 1;
      rsCalls.push({ method, body, authorization: req.headers.authorization, failed: true });
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "unavailable", msg: "test: RoomService down" }));
      return;
    }
    rsCalls.push({ method, body, authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});

let evtSeq = 0;
function trackPublished(p: {
  room: string;
  identity: string;
  type?: "AUDIO" | "VIDEO" | "DATA";
  encryption?: "NONE" | "GCM" | "CUSTOM" | null;
  event?: string;
}) {
  evtSeq += 1;
  const type = p.type ?? "AUDIO";
  return {
    event: p.event ?? "track_published",
    id: `EV_${RUN}_${evtSeq}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { sid: `RM_${RUN}`, name: p.room },
    participant: { sid: `PA_${RUN}_${evtSeq}`, identity: p.identity },
    track: {
      sid: `TR_${RUN}_${evtSeq}`,
      type,
      source: type === "VIDEO" ? "CAMERA" : "MICROPHONE",
      // null — поля нет вовсе (так шлёт событие клиент без шифрования: значение по умолчанию NONE)
      ...(p.encryption === null ? {} : { encryption: p.encryption ?? "NONE" }),
    },
  };
}

async function main() {
  // ---- окружение теста ДО загрузки приложения ----
  await new Promise<void>((resolve) => fakeRoomService.listen(0, "127.0.0.1", () => resolve()));
  const rsPort = (fakeRoomService.address() as AddressInfo).port;
  // Пустая строка — единственное значение, которым старый код (z.coerce.boolean) выключал E2EE 1:1.
  process.env.E2EE_1TO1 = "";
  process.env.LIVEKIT_API_URL = `http://127.0.0.1:${rsPort}`;

  const { default: app } = await import("../src/app");
  const { default: env } = await import("../src/config/env");
  const { default: prisma } = await import("../src/lib/prisma");
  const { getRedisClient } = await import("../src/lib/redis");
  const { initSocket } = await import("../src/realtime/socket");
  const { signAccessToken } = await import("../src/utils/jwt");
  const { getPushQueue } = await import("../src/jobs/queue");
  // Путь переменной: контрольный прогон на коде ДО этапа 0 (модуля ещё нет) должен падать
  // шагами, а не компиляцией всего файла.
  const guardPath = "../src/lib/callEncryptionGuard";
  const guard: any = await import(guardPath).catch((e: any) => {
    console.log(`[call-e2ee-stage0] нет ${guardPath}: ${e?.message ?? e}`);
    return {} as any;
  });
  const { AccessToken, TokenVerifier } = await import("livekit-server-sdk");

  console.log(`[call-e2ee-stage0] run=${RUN} DATABASE_URL=${describeUrl(env.DATABASE_URL)} REDIS_URL=${describeUrl(env.REDIS_URL)}`);
  const redis = await getRedisClient();
  const identity = await assertIsolatedBackends(prisma, redis);
  console.log(`[call-e2ee-stage0] isolated backends: ${JSON.stringify(identity)}`);

  const server = http.createServer(app);
  const io = await initSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type U = { id: string; username: string; token: string; dev: string };
  let userSeq = 0;
  async function mkUser(tag: string): Promise<U> {
    userSeq += 1;
    const username = `${RUN}_${tag}_${userSeq}`;
    const user = await prisma.user.create({ data: { username, passwordHash: `x_${crypto.randomUUID()}` } });
    const token = signAccessToken({ sub: user.id, tokenId: crypto.randomUUID() });
    const dev = crypto.randomUUID();
    const r = await call("POST", "/api/devices/register", {
      token,
      device: dev,
      body: { deviceId: dev, name: `${RUN} ${tag}`, platform: "test", publicKey: b64(), identityPublicKey: b64(), prekeys: [] },
    });
    assert.ok(r.status < 300, `register ${dev}: ${r.status} ${JSON.stringify(r.body)}`);
    return { id: user.id, username, token, dev };
  }
  async function connect(u: U): Promise<ClientSocket> {
    const s = ioClient(baseUrl, { auth: { token: u.token, deviceId: u.dev }, transports: ["websocket"], reconnection: false, forceNew: true });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("socket connect timeout")), 5000);
      s.once("connect", () => {
        clearTimeout(t);
        resolve();
      });
      s.once("connect_error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    await sleep(300);
    return s;
  }
  async function signWebhook(body: string, key = env.LIVEKIT_API_KEY, secret = env.LIVEKIT_API_SECRET) {
    const at = new AccessToken(key, secret);
    at.sha256 = crypto.createHash("sha256").update(body).digest("base64");
    return at.toJwt();
  }
  async function postWebhook(evt: unknown, sign: "ok" | "none" | "wrong-secret" | "wrong-body" = "ok") {
    const body = JSON.stringify(evt);
    let authorization: string | undefined;
    if (sign === "ok") authorization = await signWebhook(body);
    else if (sign === "wrong-secret") authorization = await signWebhook(body, env.LIVEKIT_API_KEY, crypto.randomBytes(32).toString("hex"));
    else if (sign === "wrong-body") authorization = await signWebhook(`${body} `);
    const res = await fetch(`${baseUrl}/api/livekit/webhook`, {
      method: "POST",
      // так шлёт LiveKit (app.ts принимает application/*+json)
      headers: { "Content-Type": "application/webhook+json", ...(authorization ? { Authorization: authorization } : {}) },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  const takeRsCalls = () => rsCalls.splice(0, rsCalls.length);
  // Страховка вебхука идёт в фоне: ответ приходит раньше вызовов RoomService. Дожидаемся конца
  // всех фоновых проверок и только потом смотрим, что было вызвано.
  const settledRsCalls = async () => {
    await guard.whenCallEncryptionIdle?.();
    return takeRsCalls();
  };
  const keyTtl = async (cid: string) => redis.ttl(`call_e2ee_key:${cid}`);

  try {
    const A = await mkUser("a");
    const B = await mkUser("b");
    const C = await mkUser("c");
    const direct = await call("POST", "/api/conversations", { token: A.token, body: { participantIds: [B.id] } });
    assert.ok(direct.status === 200 || direct.status === 201, `create 1:1 ${direct.status} ${JSON.stringify(direct.body)}`);
    const D = direct.body.conversation.id as string;
    const group = await prisma.conversation.create({
      data: {
        isGroup: true,
        title: `${RUN} group`,
        createdById: A.id,
        participants: { create: [{ userId: A.id }, { userId: B.id }, { userId: C.id }] },
      },
    });
    const G = group.id;
    const secretR = await call("POST", "/api/threads/secret", { token: A.token, device: A.dev, body: { peerUserId: C.id } });
    assert.ok(secretR.status === 200 || secretR.status === 201, `secret thread ${secretR.status} ${JSON.stringify(secretR.body)}`);
    const S = secretR.body.threadId as string;

    console.log("Рубильник E2EE_1TO1 убран");
    await step("env: поля E2EE_1TO1 больше нет (E2EE_1TO1= в окружении ни на что не влияет)", async () => {
      assert.equal(process.env.E2EE_1TO1, "");
      assert.equal(Object.prototype.hasOwnProperty.call(env, "E2EE_1TO1"), false);
    });
    await step("GET /calls/:id/e2ee-key в 1:1 → 200 и ключ 32 байта (стандартный base64 с =)", async () => {
      const r = await call("GET", `/api/calls/${D}/e2ee-key`, { token: A.token, device: A.dev });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(String(r.body.key), /^[A-Za-z0-9+/]{43}=$/);
      assert.equal(Buffer.from(r.body.key, "base64").length, 32);
      const r2 = await call("GET", `/api/calls/${D}/e2ee-key`, { token: B.token, device: B.dev });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.key, r.body.key, "оба собеседника получают ОДИН ключ");
      await redis.del(`call_e2ee_key:${D}`);
    });
    await step("e2ee-key: посторонний → 403, группа → 404 (группы пока без шифрования)", async () => {
      assert.equal((await call("GET", `/api/calls/${D}/e2ee-key`, { token: C.token })).status, 403);
      assert.equal((await call("GET", `/api/calls/${G}/e2ee-key`, { token: A.token })).status, 404);
    });
    await step("call:invite 1:1 создаёт ключ сразу (без флага), accept его не перегенерирует", async () => {
      await redis.del(`call_e2ee_key:${D}`);
      const sa = await connect(A);
      const sb = await connect(B);
      sa.emit("call:invite", { conversationId: D, video: false });
      let key: string | null = null;
      for (let i = 0; i < 30 && !key; i += 1) {
        await sleep(100);
        key = await redis.get(`call_e2ee_key:${D}`);
      }
      assert.ok(key, "после call:invite в Redis есть call_e2ee_key");
      assert.equal(Buffer.from(key!, "base64").length, 32);
      sb.emit("call:accept", { conversationId: D, video: false });
      await sleep(500);
      assert.equal(await redis.get(`call_e2ee_key:${D}`), key, "accept не меняет ключ");
      const r = await call("GET", `/api/calls/${D}/e2ee-key`, { token: B.token, device: B.dev });
      assert.equal(r.body.key, key, "собеседник получает тот же ключ");
      sa.emit("call:end", { conversationId: D });
      await sleep(300);
    });

    console.log("Срок ключа 1:1 продлевается");
    await step("GET ключа продлевает срок (GETEX): почти истёкший ключ после чтения живёт снова 2 ч", async () => {
      const k = (await call("GET", `/api/calls/${D}/e2ee-key`, { token: A.token, device: A.dev })).body.key;
      await redis.expire(`call_e2ee_key:${D}`, 3);
      const r = await call("GET", `/api/calls/${D}/e2ee-key`, { token: B.token, device: B.dev });
      assert.equal(r.body.key, k, "тот же ключ");
      const ttl = await keyTtl(D);
      assert.ok(ttl > 7000, `ttl после чтения ${ttl}`);
    });
    await step("invite → ключ почти истёк → собеседник берёт ключ → тот же ключ (а не новый)", async () => {
      await redis.del(`call_e2ee_key:${D}`);
      const sa = await connect(A);
      sa.emit("call:invite", { conversationId: D, video: false });
      let key: string | null = null;
      for (let i = 0; i < 30 && !key; i += 1) {
        await sleep(100);
        key = await redis.get(`call_e2ee_key:${D}`);
      }
      assert.ok(key, "ключ создан invite");
      await redis.expire(`call_e2ee_key:${D}`, 1);
      const r = await call("GET", `/api/calls/${D}/e2ee-key`, { token: B.token, device: B.dev });
      assert.equal(r.body.key, key, "собеседник получил ключ звонящего");
      await sleep(1500);
      assert.equal(await redis.get(`call_e2ee_key:${D}`), key, "ключ не истёк через 1 с: чтение продлило срок");
      sa.emit("call:end", { conversationId: D });
      await sleep(300);
    });
    await step("accept и room:join продлевают срок ключа и не меняют его", async () => {
      await redis.del(`call_e2ee_key:${D}`);
      const sa = await connect(A);
      const sb = await connect(B);
      sa.emit("call:invite", { conversationId: D, video: false });
      let key: string | null = null;
      for (let i = 0; i < 30 && !key; i += 1) {
        await sleep(100);
        key = await redis.get(`call_e2ee_key:${D}`);
      }
      assert.ok(key);
      await redis.expire(`call_e2ee_key:${D}`, 30);
      sb.emit("call:accept", { conversationId: D, video: false });
      await sleep(500);
      assert.ok((await keyTtl(D)) > 7000, "accept продлил срок");
      assert.equal(await redis.get(`call_e2ee_key:${D}`), key);
      await redis.expire(`call_e2ee_key:${D}`, 30);
      sb.emit("call:room:join", { conversationId: D, video: false });
      await sleep(500);
      assert.ok((await keyTtl(D)) > 7000, "room:join продлил срок");
      assert.equal(await redis.get(`call_e2ee_key:${D}`), key, "room:join не меняет ключ");
      sa.emit("call:end", { conversationId: D });
      await sleep(300);
    });
    await step("touchCallE2eeKeys продлевает ключи идущих звонков и не создаёт отсутствующие", async () => {
      const ce = await import("../src/lib/callE2ee");
      await redis.set(`call_e2ee_key:${D}`, b64(), { EX: 30 });
      await redis.del(`call_e2ee_key:${G}`);
      await ce.touchCallE2eeKeys([D, G]);
      assert.ok((await keyTtl(D)) > 7000);
      assert.equal(await redis.exists(`call_e2ee_key:${G}`), 0, "ключ не создан");
      assert.ok(ce.CALL_E2EE_KEY_REFRESH_INTERVAL_MS < (ce.CALL_E2EE_KEY_TTL_SECONDS * 1000) / 2);
    });
    await step("getOrCreate: отсутствующий создаётся один на всех, существующий отдаётся и продлевается", async () => {
      const ce = await import("../src/lib/callE2ee");
      await redis.del(`call_e2ee_key:${D}`);
      const keys = await Promise.all(Array.from({ length: 8 }, () => ce.getOrCreateCallE2eeKey(D)));
      assert.equal(new Set(keys).size, 1, "параллельные запросы сошлись на одном ключе");
      assert.equal(await redis.get(`call_e2ee_key:${D}`), keys[0]);
      await redis.expire(`call_e2ee_key:${D}`, 5);
      assert.equal(await ce.getOrCreateCallE2eeKey(D), keys[0]);
      assert.ok((await keyTtl(D)) > 7000);
    });

    console.log("Вебхук: подпись");
    await step("без Authorization → 401, RoomService не вызывался", async () => {
      takeRsCalls();
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }), "none");
      assert.equal(r.status, 401);
      await sleep(100);
      assert.deepEqual(await settledRsCalls(), []);
    });
    await step("подпись чужим секретом → 401", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }), "wrong-secret");
      assert.equal(r.status, 401);
      assert.deepEqual(await settledRsCalls(), []);
    });
    await step("подпись от другого тела (sha256 не сходится) → 401", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }), "wrong-body");
      assert.equal(r.status, 401);
      assert.deepEqual(await settledRsCalls(), []);
    });

    console.log("Вебхук: незашифрованная дорожка");
    await step("1:1, звук NONE в conv-<cuid> → MutePublishedTrack + RemoveParticipant с roomAdmin этой комнаты", async () => {
      const evt = trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}`, type: "AUDIO", encryption: "NONE" });
      const r = await postWebhook(evt);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const calls = (await settledRsCalls());
      assert.deepEqual(
        calls.map((c) => c.method),
        ["MutePublishedTrack", "RemoveParticipant"]
      );
      assert.equal(calls[0]!.body.room, `conv-${D}`);
      assert.equal(calls[0]!.body.identity, `${B.id}#${B.dev}`);
      assert.equal(calls[0]!.body.trackSid, evt.track.sid);
      assert.equal(calls[0]!.body.muted, true);
      assert.deepEqual(calls[1]!.body, { room: `conv-${D}`, identity: `${B.id}#${B.dev}` });
      const verifier = new TokenVerifier(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
      for (const c of calls) {
        const auth = String(c.authorization ?? "");
        assert.ok(auth.startsWith("Bearer "), "Twirp-запрос подписан");
        const claims = await verifier.verify(auth.slice("Bearer ".length));
        assert.equal(claims.video?.roomAdmin, true);
        assert.equal(claims.video?.room, `conv-${D}`);
      }
    });
    await step("1:1, видео без поля encryption (значение по умолчанию NONE) → выкинут", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${A.id}#${A.dev}`, type: "VIDEO", encryption: null }));
      assert.equal(r.status, 200);
      assert.deepEqual(
        (await settledRsCalls()).map((c) => c.method),
        ["MutePublishedTrack", "RemoveParticipant"]
      );
    });
    await step("секретная беседа (1:1) с NONE → выкинут", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${S}`, identity: `${C.id}#${C.dev}` }));
      assert.equal(r.status, 200);
      const calls = (await settledRsCalls());
      assert.deepEqual(calls.map((c) => c.method), ["MutePublishedTrack", "RemoveParticipant"]);
      assert.equal(calls[1]!.body.room, `conv-${S}`);
    });
    await step("1:1, GCM-дорожка → ничего", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}`, encryption: "GCM" }));
      assert.equal(r.status, 200);
      assert.deepEqual((await settledRsCalls()), []);
    });
    await step("1:1, data-дорожка NONE → ничего (не звук и не видео)", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}`, type: "DATA" }));
      assert.equal(r.status, 200);
      assert.deepEqual((await settledRsCalls()), []);
    });
    await step("группа, звук NONE → ничего (этап 0: группы ещё никто не шифрует)", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${G}`, identity: `${C.id}#${C.dev}` }));
      assert.equal(r.status, 200);
      assert.deepEqual((await settledRsCalls()), []);
    });
    await step("имя комнаты без conv- (голый id беседы 1:1) → не комната звонка, ничего", async () => {
      const r = await postWebhook(trackPublished({ room: D, identity: `${B.id}#${B.dev}` }));
      assert.equal(r.status, 200);
      assert.deepEqual((await settledRsCalls()), []);
    });
    await step("conv-<несуществующая беседа> → выкинут (законного звонка в такой комнате нет)", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${RUN}nope`, identity: `${B.id}#${B.dev}` }));
      assert.equal(r.status, 200);
      const calls = await settledRsCalls();
      assert.deepEqual(calls.map((c) => c.method), ["MutePublishedTrack", "RemoveParticipant"]);
      assert.equal(calls[1]!.body.room, `conv-${RUN}nope`);
    });
    await step("повтор того же события (тот же id) → duplicate, второй раз не выкидываем", async () => {
      const evt = trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` });
      assert.equal((await postWebhook(evt)).status, 200);
      assert.equal((await settledRsCalls()).length, 2);
      const again = await postWebhook(evt);
      assert.equal(again.status, 200);
      assert.equal(again.body.duplicate, true);
      assert.deepEqual((await settledRsCalls()), []);
    });
    await step("другие события (participant_joined) в 1:1 — RoomService не трогаем", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}`, event: "participant_joined" }));
      assert.equal(r.status, 200);
      assert.deepEqual((await settledRsCalls()), []);
    });
    console.log("Чистые функции и отказ БД");
    await step("conversationIdFromCallRoom / isUnencryptedTrack", async () => {
      assert.equal(guard.conversationIdFromCallRoom("conv-abc"), "abc");
      assert.equal(guard.conversationIdFromCallRoom(" conv-abc "), "abc");
      assert.equal(guard.conversationIdFromCallRoom("abc"), null);
      assert.equal(guard.conversationIdFromCallRoom("conv-"), null);
      assert.equal(guard.conversationIdFromCallRoom(null), null);
      assert.equal(guard.isUnencryptedTrack(0), true);
      assert.equal(guard.isUnencryptedTrack(undefined), true);
      assert.equal(guard.isUnencryptedTrack("NONE"), true);
      assert.equal(guard.isUnencryptedTrack(1), false);
      assert.equal(guard.isUnencryptedTrack(2), false);
    });
    await step("сбой поиска беседы → повторы, потом не выкидываем (это могла быть группа), вердикт lookup_failed", async () => {
      takeRsCalls();
      let lookups = 0;
      const out = await guard.enforceCallEncryption(trackPublished({ room: `conv-${D}`, identity: "x#y" }), {
        findConversation: async () => {
          lookups += 1;
          throw new Error("db down");
        },
        lookupDelaysMs: [0, 20, 20],
      });
      assert.deepEqual(out.verdict, { action: "ignore", reason: "lookup_failed" });
      assert.equal(out.eviction, null);
      assert.equal(lookups, 3, "поиск беседы повторён");
      await sleep(100);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("сбой поиска беседы, потом БД ответила → выкинут", async () => {
      takeRsCalls();
      let lookups = 0;
      const out = await guard.enforceCallEncryption(trackPublished({ room: `conv-${D}`, identity: `${A.id}#lookup-retry` }), {
        findConversation: async () => {
          lookups += 1;
          if (lookups < 2) throw new Error("db blip");
          return { isGroup: false };
        },
        lookupDelaysMs: [0, 20, 20],
      });
      assert.equal(out.verdict.action, "evict");
      assert.equal(out.eviction?.removed, true);
      assert.deepEqual(takeRsCalls().map((c) => c.method), ["MutePublishedTrack", "RemoveParticipant"]);
    });
    await step("RoomService отвечает ошибкой → выкидывание повторяется, пока не выйдет", async () => {
      takeRsCalls();
      rsFailNext = 4; // обе попытки (Mute+Remove) первых двух заходов падают, третий заход проходит
      const out = await guard.enforceCallEncryption(trackPublished({ room: `conv-${D}`, identity: `${A.id}#rs-retry` }), {
        evictDelaysMs: [0, 20, 20, 20],
      });
      rsFailNext = 0;
      assert.equal(out.eviction?.removed, true);
      assert.equal(out.eviction?.attempts, 3);
      const calls = takeRsCalls();
      assert.equal(calls.filter((c) => c.method === "RemoveParticipant").length, 3, JSON.stringify(calls.map((c) => [c.method, !!c.failed])));
      assert.equal(calls.filter((c) => c.method === "RemoveParticipant" && !c.failed).length, 1);
      assert.equal(calls.filter((c) => c.method === "MutePublishedTrack" && !c.failed).length, 1, "дорожка заглушена с третьей попытки");
    });

    console.log("Запрет на возврат выкинутого");
    await step("выкинутое устройство 2 мин не получает пропуск в ту же комнату (403), остальные — получают", async () => {
      const banKey = guard.callEncryptionBanKey(`conv-${D}`, `${B.id}#${B.dev}`);
      // Оба устройства выкидывались шагами выше — снимаем их запреты, чтобы начать с чистого листа.
      await redis.del([banKey, guard.callEncryptionBanKey(`conv-${D}`, `${A.id}#${A.dev}`)]);
      const before = await call("POST", "/api/livekit/token", { token: B.token, device: B.dev, body: { room: `conv-${D}` } });
      assert.equal(before.status, 200, JSON.stringify(before.body));
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }));
      assert.equal(r.status, 200);
      await settledRsCalls();
      const ttl = await redis.ttl(banKey);
      assert.ok(ttl > 60 && ttl <= 120, `ttl запрета ${ttl}`);
      const blocked = await call("POST", "/api/livekit/token", { token: B.token, device: B.dev, body: { room: `conv-${D}` } });
      assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
      assert.equal(blocked.body.code, "CALL_UNENCRYPTED_BLOCKED");
      const other = await call("POST", "/api/livekit/token", { token: A.token, device: A.dev, body: { room: `conv-${D}` } });
      assert.equal(other.status, 200, "собеседник не затронут");
      await redis.del(banKey);
      const after = await call("POST", "/api/livekit/token", { token: B.token, device: B.dev, body: { room: `conv-${D}` } });
      assert.equal(after.status, 200, "после истечения запрета пропуск снова выдаётся");
    });

    await step("RoomService недоступен → вебхук отвечает сразу (не ждёт RoomService) и 200", async () => {
      const verdict = await guard.judgeCallEncryptionEvent(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }));
      assert.equal(verdict.action, "evict");
      fakeRoomService.closeAllConnections?.();
      await new Promise<void>((resolve) => fakeRoomService.close(() => resolve()));
      const t0 = Date.now();
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${A.id}#rs-down` }));
      const took = Date.now() - t0;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(took < 2000, `вебхук ждал RoomService ${took} мс`);
    });

    await getPushQueue().close().catch(() => undefined);
  } finally {
    for (const s of sockets) {
      try {
        s.disconnect();
      } catch {}
    }
    io.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fakeRoomService.listening) await new Promise<void>((resolve) => fakeRoomService.close(() => resolve()));
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().then(
  () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\ncall-e2ee-stage0: ${results.length - failed.length}/${results.length} ok`);
    for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
    process.exit(failed.length ? 1 : 0);
  },
  (err) => {
    console.error("call-e2ee-stage0: CRASHED", err);
    process.exit(1);
  }
);
