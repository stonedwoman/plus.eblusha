/**
 * Компактный smoke-тест Eblusha Cloud против ЖИВОГО backend.
 *
 * Сознательно проверяет немного, но самое важное: авторизацию (никто не должен
 * скачать чужой файл), докачку, Range и то, что медиа-конвейер реально
 * запускается. Гоняется так:
 *
 *   npx ts-node test/cloud.smoke.test.ts            # через nginx, http://127.0.0.1
 *   CLOUD_SMOKE_BASE=... npx ts-node test/...
 *
 * Тестовые данные создаются в отдельном Space и удаляются в конце.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { signAccessToken } from "../src/utils/jwt";

// По умолчанию идём ЧЕРЕЗ nginx: только так проверяется реальный путь отдачи
// файлов (X-Accel-Redirect + Range), которого при обращении к backend напрямую
// просто нет.
const BASE = process.env.CLOUD_SMOKE_BASE ?? "http://127.0.0.1";
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`, detail ?? "");
  }
}

type Session = { cookie: string; csrf: string; userId: string };

async function ssoLogin(userId: string): Promise<Session> {
  const accessToken = signAccessToken({ sub: userId, tokenId: crypto.randomUUID() });
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  const authorize = await fetch(`${BASE}/api/cloud/auth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      clientId: "eblusha-cloud-web",
      redirectUri: "/cloud",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }),
  });
  if (!authorize.ok) throw new Error(`authorize failed: ${authorize.status} ${await authorize.text()}`);
  const { code } = (await authorize.json()) as { code: string };

  const token = await fetch(`${BASE}/api/cloud/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier, clientId: "eblusha-cloud-web" }),
  });
  if (!token.ok) throw new Error(`token failed: ${token.status} ${await token.text()}`);
  const body = (await token.json()) as { csrf: string };
  const setCookie = token.headers.getSetCookie().find((c) => c.startsWith("cloud_sid="));
  if (!setCookie) throw new Error("no cloud_sid cookie");
  return { cookie: setCookie.split(";")[0] as string, csrf: body.csrf, userId };
}

function authed(session: Session, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: session.cookie, "x-cloud-csrf": session.csrf, ...extra };
}

/** Минимальный валидный JPEG через ffmpeg — рисовать байты руками незачем. */
function makeJpeg(color: string): Buffer {
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=640x480:d=1`, "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "-"],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  if (res.status !== 0 || !res.stdout?.length) throw new Error(`ffmpeg failed: ${res.stderr?.toString().slice(0, 200)}`);
  return res.stdout;
}

async function tusUpload(
  session: Session,
  spaceId: string,
  name: string,
  data: Buffer,
  opts: { splitAt?: number } = {}
): Promise<{ uploadUrl: string; sessionId: string }> {
  const meta = [
    `filename ${Buffer.from(name).toString("base64")}`,
    `filetype ${Buffer.from("image/jpeg").toString("base64")}`,
    `spaceId ${Buffer.from(spaceId).toString("base64")}`,
    `fingerprint ${Buffer.from(`smoke-${name}-${data.length}`).toString("base64")}`,
  ].join(",");

  const create = await fetch(`${BASE}/api/cloud/uploads/tus`, {
    method: "POST",
    headers: authed(session, {
      "tus-resumable": "1.0.0",
      "upload-length": String(data.length),
      "upload-metadata": meta,
    }),
  });
  if (create.status !== 201) throw new Error(`tus create: ${create.status} ${await create.text()}`);
  const location = create.headers.get("location") as string;
  const sessionId = create.headers.get("x-cloud-upload-session") as string;

  const split = opts.splitAt ?? data.length;
  const patch = async (offset: number, chunk: Buffer) =>
    fetch(`${BASE}${location}`, {
      method: "PATCH",
      headers: authed(session, {
        "tus-resumable": "1.0.0",
        "upload-offset": String(offset),
        "content-type": "application/offset+octet-stream",
      }),
      body: new Uint8Array(chunk),
    });

  const first = await patch(0, data.subarray(0, split));
  if (first.status !== 204) throw new Error(`tus patch1: ${first.status} ${await first.text()}`);

  if (split < data.length) {
    // Имитируем обрыв: спрашиваем offset через HEAD и продолжаем с него.
    const head = await fetch(`${BASE}${location}`, {
      method: "HEAD",
      headers: authed(session, { "tus-resumable": "1.0.0" }),
    });
    const offset = Number(head.headers.get("upload-offset"));
    check("tus HEAD возвращает реальный offset", offset === split, { offset, split });
    const second = await patch(offset, data.subarray(offset));
    if (second.status !== 204) throw new Error(`tus patch2: ${second.status} ${await second.text()}`);
  }
  return { uploadUrl: location, sessionId };
}

async function waitForFile(sessionId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.cloudUploadSession.findUnique({ where: { id: sessionId } });
    if (row?.fileId) return row.fileId;
    if (row?.status === "FAILED") throw new Error(`upload failed: ${row.error}`);
    if (Date.now() > deadline) throw new Error("timeout waiting for finalize");
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitForVariant(fileId: string, kind: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const variant = await prisma.cloudFileVariant.findUnique({ where: { fileId_kind: { fileId, kind: kind as never } } });
    if (variant?.status === "READY") return true;
    if (variant?.status === "FAILED") return false;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function main() {
  console.log(`Eblusha Cloud smoke @ ${BASE}\n`);

  const users = await prisma.user.findMany({
    where: { deletedAt: null, bannedAt: null },
    select: { id: true, username: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  if (users.length < 2) throw new Error("нужно минимум два пользователя в БД");
  const [owner, viewer] = users as [{ id: string; username: string }, { id: string; username: string }];
  console.log(`  владелец: ${owner.username}, второй участник: ${viewer.username}\n`);

  const ownerSession = await ssoLogin(owner.id);
  const viewerSession = await ssoLogin(viewer.id);
  check("SSO выдаёт cloud-сессию", Boolean(ownerSession.cookie && ownerSession.csrf));

  const me = await fetch(`${BASE}/api/cloud/me`, { headers: { cookie: ownerSession.cookie } });
  check("GET /me с сессией", me.status === 200);
  const anon = await fetch(`${BASE}/api/cloud/me`);
  check("GET /me без сессии → 401", anon.status === 401);

  // CSRF
  const noCsrf = await fetch(`${BASE}/api/cloud/spaces`, {
    method: "POST",
    headers: { cookie: ownerSession.cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "csrf" }),
  });
  check("мутация без X-Cloud-CSRF → 403", noCsrf.status === 403);

  // ── Space ────────────────────────────────────────────────────────────────
  const spaceRes = await fetch(`${BASE}/api/cloud/spaces`, {
    method: "POST",
    headers: authed(ownerSession, { "content-type": "application/json" }),
    body: JSON.stringify({ name: `SMOKE ${new Date().toISOString()}` }),
  });
  check("создание Space", spaceRes.status === 201);
  const spaceId = ((await spaceRes.json()) as { space: { id: string } }).space.id;

  const foreign = await fetch(`${BASE}/api/cloud/spaces/${spaceId}`, { headers: { cookie: viewerSession.cookie } });
  check("посторонний не видит Space → 404", foreign.status === 404);

  // ── Загрузка + докачка ───────────────────────────────────────────────────
  const jpeg = makeJpeg("red");
  const uploaded = await tusUpload(ownerSession, spaceId, "smoke-red.jpg", jpeg, { splitAt: Math.floor(jpeg.length / 3) });
  const fileId = await waitForFile(uploaded.sessionId);
  check("resumable upload завершился созданием файла", Boolean(fileId));

  const stored = await prisma.cloudFile.findUnique({ where: { id: fileId }, include: { storageObject: true } });
  check("сервер сам посчитал sha256", /^[0-9a-f]{64}$/.test(stored?.storageObject.sha256 ?? ""));
  check("размер совпал", Number(stored?.size) === jpeg.length);
  check("тип определён сервером, не клиентом", stored?.mimeType === "image/jpeg");

  check("превью создано", await waitForVariant(fileId, "THUMB"));
  check("большое превью создано", await waitForVariant(fileId, "PREVIEW"));

  const thumb = await fetch(`${BASE}/api/cloud/files/${fileId}/thumb`, { headers: { cookie: ownerSession.cookie } });
  check("владелец получает превью", thumb.status === 200);

  // ── Авторизация на скачивание ────────────────────────────────────────────
  const anonContent = await fetch(`${BASE}/api/cloud/files/${fileId}/content`);
  check("аноним не качает приватный файл → 401", anonContent.status === 401);
  const foreignContent = await fetch(`${BASE}/api/cloud/files/${fileId}/content`, { headers: { cookie: viewerSession.cookie } });
  check("посторонний не качает приватный файл → 404", foreignContent.status === 404);

  // ── Роль VIEWER не пишет ─────────────────────────────────────────────────
  await fetch(`${BASE}/api/cloud/spaces/${spaceId}/members`, {
    method: "POST",
    headers: authed(ownerSession, { "content-type": "application/json" }),
    body: JSON.stringify({ userId: viewer.id, role: "VIEWER" }),
  });
  const viewerRead = await fetch(`${BASE}/api/cloud/spaces/${spaceId}`, { headers: { cookie: viewerSession.cookie } });
  check("VIEWER видит Space", viewerRead.status === 200);
  const viewerUpload = await fetch(`${BASE}/api/cloud/uploads/tus`, {
    method: "POST",
    headers: authed(viewerSession, {
      "tus-resumable": "1.0.0",
      "upload-length": "10",
      "upload-metadata": `filename ${Buffer.from("x.bin").toString("base64")},spaceId ${Buffer.from(spaceId).toString("base64")}`,
    }),
  });
  check("VIEWER не может загружать → 403", viewerUpload.status === 403);
  const viewerDelete = await fetch(`${BASE}/api/cloud/files/delete`, {
    method: "POST",
    headers: authed(viewerSession, { "content-type": "application/json" }),
    body: JSON.stringify({ ids: [fileId] }),
  });
  check("VIEWER не может удалять → 403", viewerDelete.status === 403);
  const viewerContent = await fetch(`${BASE}/api/cloud/files/${fileId}/content`, { headers: { cookie: viewerSession.cookie } });
  check("VIEWER может скачивать", viewerContent.status === 200 || viewerContent.status === 206);

  // ── Range ────────────────────────────────────────────────────────────────
  const ranged = await fetch(`${BASE}/api/cloud/files/${fileId}/content`, {
    headers: { cookie: ownerSession.cookie, range: "bytes=0-99" },
  });
  const rangeBody = Buffer.from(await ranged.arrayBuffer());
  check(
    "Range отдаёт 206 и ровно запрошенный кусок",
    ranged.status === 206 && rangeBody.length === 100,
    { status: ranged.status, len: rangeBody.length }
  );

  // ── Дедупликация ─────────────────────────────────────────────────────────
  const dupUpload = await tusUpload(ownerSession, spaceId, "smoke-red-copy.jpg", jpeg);
  const dupFileId = await waitForFile(dupUpload.sessionId);
  const dupFile = await prisma.cloudFile.findUnique({ where: { id: dupFileId } });
  check(
    "одинаковое содержимое ссылается на один физический объект",
    dupFile?.storageObjectId === stored?.storageObjectId
  );

  // ── Публичная ссылка ─────────────────────────────────────────────────────
  const shareRes = await fetch(`${BASE}/api/cloud/shares`, {
    method: "POST",
    headers: authed(ownerSession, { "content-type": "application/json" }),
    body: JSON.stringify({ spaceId, targetType: "SPACE", allowPreview: true, allowDownload: true }),
  });
  check("создание публичной ссылки", shareRes.status === 201);
  const shareBody = (await shareRes.json()) as { share: { id: string; publicId: string }; url: string };
  const secret = new URL(shareBody.url).hash.replace("#t=", "");

  const badSecret = await fetch(`${BASE}/api/cloud/public/${shareBody.share.publicId}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "wrong-secret-value" }),
  });
  check("неверный секрет share → 404", badSecret.status === 404);

  const shareSession = await fetch(`${BASE}/api/cloud/public/${shareBody.share.publicId}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: decodeURIComponent(secret) }),
  });
  check("обмен секрета на share-сессию", shareSession.status === 200);
  const shareCookie = shareSession.headers.getSetCookie().find((c) => c.startsWith("cloud_share_"))?.split(";")[0] ?? "";

  const publicList = await fetch(`${BASE}/api/cloud/public/${shareBody.share.publicId}/files`, {
    headers: { cookie: shareCookie },
  });
  check("публичная галерея отдаёт файлы", publicList.status === 200);

  const publicNoSession = await fetch(`${BASE}/api/cloud/public/${shareBody.share.publicId}/files`);
  check("без share-сессии публичная галерея → 401", publicNoSession.status === 401);

  const publicOtherFile = await fetch(
    `${BASE}/api/cloud/public/${shareBody.share.publicId}/files/nonexistent-id/content`,
    { headers: { cookie: shareCookie } }
  );
  check("share не отдаёт файл вне своей области → 404", publicOtherFile.status === 404);

  await fetch(`${BASE}/api/cloud/shares/${shareBody.share.id}`, { method: "DELETE", headers: authed(ownerSession) });
  const afterRevoke = await fetch(`${BASE}/api/cloud/public/${shareBody.share.publicId}/files`, {
    headers: { cookie: shareCookie },
  });
  check("после revoke старая share-сессия мертва", afterRevoke.status === 404 || afterRevoke.status === 401);

  // ── Path traversal ───────────────────────────────────────────────────────
  for (const evil of ["..%2f..%2fetc%2fpasswd", "%2e%2e%2f%2e%2e%2fetc%2fpasswd"]) {
    const res = await fetch(`${BASE}/api/cloud/files/${evil}/content`, { headers: { cookie: ownerSession.cookie } });
    check(`path traversal (${evil.slice(0, 14)}…) отбит`, res.status === 404 || res.status === 400);
  }
  const accel = await fetch(`${BASE}/__cloud_internal/objects/`, { redirect: "manual" });
  check(
    "internal-локация недоступна снаружи",
    accel.status === 404 || accel.status === 403 || accel.status === 502,
    accel.status
  );

  // ── Корзина ──────────────────────────────────────────────────────────────
  await fetch(`${BASE}/api/cloud/files/delete`, {
    method: "POST",
    headers: authed(ownerSession, { "content-type": "application/json" }),
    body: JSON.stringify({ ids: [dupFileId] }),
  });
  const trashed = await prisma.cloudFile.findUnique({ where: { id: dupFileId } });
  check("удаление мягкое (файл в корзине)", Boolean(trashed?.deletedAt));
  const objectStillThere = await prisma.cloudStorageObject.findUnique({ where: { id: stored!.storageObjectId } });
  check("физический объект при этом на месте", Boolean(objectStillThere));

  await fetch(`${BASE}/api/cloud/files/restore`, {
    method: "POST",
    headers: authed(ownerSession, { "content-type": "application/json" }),
    body: JSON.stringify({ ids: [dupFileId] }),
  });
  const restored = await prisma.cloudFile.findUnique({ where: { id: dupFileId } });
  check("восстановление из корзины", restored?.deletedAt === null);

  // ── Уборка тестовых данных ───────────────────────────────────────────────
  await prisma.cloudFile.deleteMany({ where: { spaceId } });
  await prisma.cloudSpace.delete({ where: { id: spaceId } }).catch(() => undefined);

  console.log(`\n  passed: ${passed}, failed: ${failed}`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\nsmoke crashed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
