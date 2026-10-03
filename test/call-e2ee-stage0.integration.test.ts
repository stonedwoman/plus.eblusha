/**
 * E2EE звонков, этап 0 (сервер): звонок 1:1 без шифрования невозможен.
 *   - рубильника E2EE_1TO1 нет: ключ 1:1 выдаётся и создаётся при call:invite даже с
 *     E2EE_1TO1= (пусто — единственное значение, которым старый код выключал шифрование);
 *   - вебхук LiveKit track_published с encryption NONE в комнате `conv-<id>` беседы 1:1 →
 *     MutePublishedTrack + RemoveParticipant (подставной RoomService на 127.0.0.1);
 *     в группе, для зашифрованных и data-дорожек, для комнат не `conv-` — ничего;
 *   - вебхук без подписи или с чужой подписью → 401 и ни одного вызова RoomService (правка В11).
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
type RsCall = { method: string; body: any; authorization: string | undefined };
const rsCalls: RsCall[] = [];
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

    console.log("Вебхук: подпись");
    await step("без Authorization → 401, RoomService не вызывался", async () => {
      takeRsCalls();
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }), "none");
      assert.equal(r.status, 401);
      await sleep(100);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("подпись чужим секретом → 401", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }), "wrong-secret");
      assert.equal(r.status, 401);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("подпись от другого тела (sha256 не сходится) → 401", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }), "wrong-body");
      assert.equal(r.status, 401);
      assert.deepEqual(takeRsCalls(), []);
    });

    console.log("Вебхук: незашифрованная дорожка");
    await step("1:1, звук NONE в conv-<cuid> → MutePublishedTrack + RemoveParticipant с roomAdmin этой комнаты", async () => {
      const evt = trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}`, type: "AUDIO", encryption: "NONE" });
      const r = await postWebhook(evt);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const calls = takeRsCalls();
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
        takeRsCalls().map((c) => c.method),
        ["MutePublishedTrack", "RemoveParticipant"]
      );
    });
    await step("секретная беседа (1:1) с NONE → выкинут", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${S}`, identity: `${C.id}#${C.dev}` }));
      assert.equal(r.status, 200);
      const calls = takeRsCalls();
      assert.deepEqual(calls.map((c) => c.method), ["MutePublishedTrack", "RemoveParticipant"]);
      assert.equal(calls[1]!.body.room, `conv-${S}`);
    });
    await step("1:1, GCM-дорожка → ничего", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}`, encryption: "GCM" }));
      assert.equal(r.status, 200);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("1:1, data-дорожка NONE → ничего (не звук и не видео)", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}`, type: "DATA" }));
      assert.equal(r.status, 200);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("группа, звук NONE → ничего (этап 0: группы ещё никто не шифрует)", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${G}`, identity: `${C.id}#${C.dev}` }));
      assert.equal(r.status, 200);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("имя комнаты без conv- (голый id беседы 1:1) → не комната звонка, ничего", async () => {
      const r = await postWebhook(trackPublished({ room: D, identity: `${B.id}#${B.dev}` }));
      assert.equal(r.status, 200);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("conv-<несуществующая беседа> → ничего", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${RUN}nope`, identity: `${B.id}#${B.dev}` }));
      assert.equal(r.status, 200);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("повтор того же события (тот же id) → duplicate, второй раз не выкидываем", async () => {
      const evt = trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` });
      assert.equal((await postWebhook(evt)).status, 200);
      assert.equal(takeRsCalls().length, 2);
      const again = await postWebhook(evt);
      assert.equal(again.status, 200);
      assert.equal(again.body.duplicate, true);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("другие события (participant_joined) в 1:1 — RoomService не трогаем", async () => {
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}`, event: "participant_joined" }));
      assert.equal(r.status, 200);
      assert.deepEqual(takeRsCalls(), []);
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
    await step("сбой поиска беседы → не выкидываем (это могла быть группа), вердикт lookup_failed", async () => {
      takeRsCalls();
      const v = await guard.enforceCallEncryption(trackPublished({ room: `conv-${D}`, identity: "x#y" }), async () => {
        throw new Error("db down");
      });
      assert.deepEqual(v, { action: "ignore", reason: "lookup_failed" });
      await sleep(100);
      assert.deepEqual(takeRsCalls(), []);
    });
    await step("RoomService недоступен → вебхук всё равно 200 (страховка не роняет обработку)", async () => {
      const verdict = await guard.judgeCallEncryptionEvent(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }));
      assert.equal(verdict.action, "evict");
      fakeRoomService.closeAllConnections?.();
      await new Promise<void>((resolve) => fakeRoomService.close(() => resolve()));
      const r = await postWebhook(trackPublished({ room: `conv-${D}`, identity: `${B.id}#${B.dev}` }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
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
