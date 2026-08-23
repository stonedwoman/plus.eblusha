/**
 * Проверка медиа-конвейера Cloud на живом сервере: что видео действительно
 * обрабатывается, а решение «играть оригинал или делать web-версию» принимается
 * правильно.
 *
 *   npx ts-node test/cloud.media.test.ts <файл> [<файл> ...]
 *
 * Без аргументов берёт видео, сгенерированные ffmpeg (h264+aac и HEVC).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { signAccessToken } from "../src/utils/jwt";

const BASE = process.env.CLOUD_SMOKE_BASE ?? "http://127.0.0.1";
const prisma = new PrismaClient();

async function ssoLogin(userId: string) {
  const accessToken = signAccessToken({ sub: userId, tokenId: crypto.randomUUID() });
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = await fetch(`${BASE}/api/cloud/auth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ clientId: "eblusha-cloud-web", redirectUri: "/cloud", codeChallenge: challenge, codeChallengeMethod: "S256" }),
  });
  const { code } = (await authorize.json()) as { code: string };
  const token = await fetch(`${BASE}/api/cloud/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier, clientId: "eblusha-cloud-web" }),
  });
  const { csrf } = (await token.json()) as { csrf: string };
  const cookie = token.headers.getSetCookie().find((c) => c.startsWith("cloud_sid="))!.split(";")[0] as string;
  return { cookie, csrf };
}

async function upload(session: { cookie: string; csrf: string }, spaceId: string, file: string) {
  const data = fs.readFileSync(file);
  const headers = (extra: Record<string, string>) => ({ cookie: session.cookie, "x-cloud-csrf": session.csrf, ...extra });
  const meta = [
    `filename ${Buffer.from(path.basename(file)).toString("base64")}`,
    `spaceId ${Buffer.from(spaceId).toString("base64")}`,
    `fingerprint ${Buffer.from(`media-${path.basename(file)}-${data.length}`).toString("base64")}`,
  ].join(",");
  const create = await fetch(`${BASE}/api/cloud/uploads/tus`, {
    method: "POST",
    headers: headers({ "tus-resumable": "1.0.0", "upload-length": String(data.length), "upload-metadata": meta }),
  });
  if (create.status !== 201) throw new Error(`create ${create.status}: ${await create.text()}`);
  const location = create.headers.get("location") as string;
  const sessionId = create.headers.get("x-cloud-upload-session") as string;
  const patch = await fetch(`${BASE}${location}`, {
    method: "PATCH",
    headers: headers({ "tus-resumable": "1.0.0", "upload-offset": "0", "content-type": "application/offset+octet-stream" }),
    body: new Uint8Array(data),
  });
  if (patch.status !== 204) throw new Error(`patch ${patch.status}: ${await patch.text()}`);
  return sessionId;
}

function generateSamples(): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-media-"));
  const h264 = path.join(dir, "sample-h264.mp4");
  const hevc = path.join(dir, "sample-hevc.mp4");
  spawnSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", h264,
  ]);
  spawnSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=4",
    "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", hevc,
  ]);
  return [h264, hevc].filter((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
}

async function main() {
  const files = process.argv.slice(2);
  const samples = files.length > 0 ? files : generateSamples();
  if (samples.length === 0) throw new Error("нет файлов для проверки");

  const owner = await prisma.user.findFirstOrThrow({ where: { deletedAt: null, bannedAt: null }, orderBy: { createdAt: "asc" } });
  const session = await ssoLogin(owner.id);

  const spaceRes = await fetch(`${BASE}/api/cloud/spaces`, {
    method: "POST",
    headers: { cookie: session.cookie, "x-cloud-csrf": session.csrf, "content-type": "application/json" },
    body: JSON.stringify({ name: `MEDIA ${new Date().toISOString()}` }),
  });
  const spaceId = ((await spaceRes.json()) as { space: { id: string } }).space.id;

  const sessionIds: { file: string; sessionId: string }[] = [];
  for (const file of samples) {
    sessionIds.push({ file, sessionId: await upload(session, spaceId, file) });
    console.log(`  загружен ${path.basename(file)}`);
  }

  console.log("\n  ждём обработку…");
  const deadline = Date.now() + 10 * 60_000;
  let failed = 0;
  for (const { file, sessionId } of sessionIds) {
    let fileId: string | null = null;
    for (;;) {
      const row = await prisma.cloudUploadSession.findUnique({ where: { id: sessionId } });
      if (row?.fileId) {
        fileId = row.fileId;
        break;
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!fileId) {
      console.error(`  FAIL ${path.basename(file)}: файл так и не создан`);
      failed++;
      continue;
    }
    for (;;) {
      const row = await prisma.cloudFile.findUnique({ where: { id: fileId } });
      if (row?.status === "READY" || row?.status === "FAILED") break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const result = await prisma.cloudFile.findUniqueOrThrow({ where: { id: fileId }, include: { variants: true } });
    const variants = Object.fromEntries(result.variants.map((v) => [v.kind, v.status]));
    // Критерий готовности у видео и у картинки разный: видео обязано иметь
    // постер и играбельный источник, картинка — миниатюру и большое превью.
    const ok =
      result.status === "READY" &&
      (result.kind === "VIDEO"
        ? variants.POSTER === "READY" && (result.directPlayable || variants.PLAYBACK === "READY")
        : result.kind === "IMAGE"
          ? variants.THUMB === "READY" && variants.PREVIEW === "READY"
          : true);
    const description =
      result.kind === "VIDEO"
        ? `${result.videoCodec}/${result.audioCodec ?? "—"} ${result.width}x${result.height} ${result.durationMs}мс · ` +
          `${result.directPlayable ? "оригинал играбелен" : "сделана web-версия"}`
        : `${result.kind} ${result.mimeType} ${result.width ?? "?"}x${result.height ?? "?"}` +
          (result.takenAtSource === "exif" ? " · дата из EXIF" : "");
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${path.basename(file)}: ${description} · ${JSON.stringify(variants)}` +
        (result.processingError ? ` · ${result.processingError}` : "")
    );
    if (!ok) failed++;
  }

  await prisma.cloudFile.deleteMany({ where: { spaceId } });
  await prisma.cloudSpace.delete({ where: { id: spaceId } }).catch(() => undefined);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
