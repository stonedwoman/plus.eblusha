import { Router } from "express";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import crypto from "crypto";
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { authenticate } from "../middlewares/auth";
import env from "../config/env";
import logger from "../config/logger";
import { rateLimit } from "../middlewares/rateLimit";
import prisma from "../lib/prisma";
import {
  encryptBuffer,
  decryptBuffer,
  decryptEbp2RangeStream,
  parseStorageEncKey,
  isEncryptedPayload,
  EBP2_DEFAULT_CHUNK_SIZE,
} from "../lib/storageEncryption";

const router = Router();
const s3Config =
  env.STORAGE_S3_ENDPOINT &&
  env.STORAGE_S3_REGION &&
  env.STORAGE_S3_BUCKET
    ? {
        endpoint: env.STORAGE_S3_ENDPOINT,
        region: env.STORAGE_S3_REGION,
        bucket: env.STORAGE_S3_BUCKET,
        accessKeyId: env.STORAGE_S3_ACCESS_KEY || undefined,
        secretAccessKey: env.STORAGE_S3_SECRET_KEY || undefined,
      }
    : null;

const s3Client = s3Config
  ? new S3Client({
      region: s3Config.region,
      endpoint: s3Config.endpoint,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      ...(s3Config.accessKeyId && s3Config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: s3Config.accessKeyId,
              secretAccessKey: s3Config.secretAccessKey,
            },
          }
        : {}),
    })
  : null;

const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
const encKey = env.STORAGE_ENC_KEY ? parseStorageEncKey(env.STORAGE_ENC_KEY) : null;

const VIDEO_FETCH_FOR_THUMB = 15 * 1024 * 1024; // 15MB for ffmpeg (enough for 0.5s in most formats)

function extractObjectKeyFromUrl(url: string): string | null {
  if (!url) return null;
  let pathname = url;
  try {
    if (url.startsWith("http")) {
      const u = new URL(url);
      pathname = u.pathname;
    }
  } catch {
    return null;
  }
  const prefix = "/api/files/";
  if (pathname.startsWith(prefix)) {
    const rest = pathname.slice(prefix.length).replace(/^\//, "");
    return rest
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");
  }
  return null;
}

const encodeKeyForUrl = (key: string) =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const readBodyToBuffer = async (body: any): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0);
  if (typeof body.pipe === "function") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      body.on("data", (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      body.on("end", () => resolve());
      body.on("error", (e: any) => reject(e));
    });
    return Buffer.concat(chunks);
  }
  const arrayBuffer = (await body.transformToByteArray?.()) || (await body.arrayBuffer?.());
  if (arrayBuffer) return Buffer.from(arrayBuffer);
  throw new Error("Unsupported S3 body");
};

router.use(authenticate);

router.post(
  "/:attachmentId/thumbnail",
  rateLimit({ name: "attachment_thumbnail", windowMs: 60_000, max: 30 }),
  async (req, res) => {
    const attachmentId = String(req.params.attachmentId || "");
    const userId = (req as any).user?.id;
    if (!userId || !attachmentId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    if (!s3Client || !s3Config || !encKey) {
      res.status(503).json({ message: "Storage or encryption not configured" });
      return;
    }

    const attachment = await prisma.messageAttachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, url: true, type: true, metadata: true, messageId: true },
    });

    if (!attachment) {
      res.status(404).json({ message: "Attachment not found" });
      return;
    }

    const msg = await prisma.message.findUnique({
      where: { id: attachment.messageId },
      select: {
        conversationId: true,
        conversation: {
          select: {
            participants: { select: { userId: true } },
          },
        },
      },
    });
    if (!msg) {
      res.status(404).json({ message: "Message not found" });
      return;
    }
    const isParticipant = (msg.conversation?.participants ?? []).some(
      (p: { userId: string }) => p.userId === userId
    );
    if (!isParticipant) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    const metaForType = (attachment.metadata as Record<string, unknown>) || {};
    const e2ee = metaForType.e2ee as Record<string, unknown> | undefined;
    const mime = (metaForType.mime ?? e2ee?.originalType) as string | undefined;
    const isVideo = attachment.type === "VIDEO" || (typeof mime === "string" && mime.toLowerCase().startsWith("video/"));
    if (!isVideo) {
      res.status(400).json({ message: "Attachment is not a video" });
      return;
    }

    const meta = (attachment.metadata as Record<string, unknown>) || {};
    if (meta.posterKey && typeof meta.posterKey === "string") {
      const posterUrl = `/api/files/${encodeKeyForUrl(meta.posterKey)}`;
      res.json({
        posterKey: meta.posterKey,
        posterUrl,
        width: meta.width,
        height: meta.height,
        duration: meta.duration,
      });
      return;
    }

    const objectKey = extractObjectKeyFromUrl(attachment.url);
    if (!objectKey) {
      res.status(400).json({ message: "Cannot determine object key from URL" });
      return;
    }

    const tmpDir = path.join(process.cwd(), "tmp", "thumbnails");
    fs.mkdirSync(tmpDir, { recursive: true });
    const videoPath = path.join(tmpDir, `video-${attachmentId}-${Date.now()}.bin`);
    const thumbPath = path.join(tmpDir, `thumb-${attachmentId}-${Date.now()}.jpg`);

    try {
      const headResp = await s3Client.send(
        new HeadObjectCommand({
          Bucket: s3Config.bucket,
          Key: objectKey,
        })
      );

      const encMeta = headResp.Metadata as Record<string, string> | undefined;
      const isEbp2 = encMeta?.enc === "ebp2";
      const totalSize = isEbp2 && encMeta?.totalSize
        ? parseInt(encMeta.totalSize, 10)
        : (headResp.ContentLength ?? 0);
      const chunkSize = isEbp2 && encMeta?.chunksize
        ? parseInt(encMeta.chunksize, 10)
        : EBP2_DEFAULT_CHUNK_SIZE;

      let videoBuf: Buffer;

      if (isEbp2 && totalSize > 0) {
        const fetchLen = Math.min(VIDEO_FETCH_FOR_THUMB, totalSize);
        const fetcher = async (range: { start: number; end: number }) => {
          const r = await s3Client.send(
            new GetObjectCommand({
              Bucket: s3Config.bucket!,
              Key: objectKey,
              Range: `bytes=${range.start}-${range.end}`,
            })
          );
          return readBodyToBuffer(r.Body);
        };
        const stream = decryptEbp2RangeStream(
          objectKey,
          fetcher,
          { start: 0, end: fetchLen - 1 },
          encKey,
          { chunkSize, totalSize }
        );
        videoBuf = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => resolve(Buffer.concat(chunks)));
          stream.on("error", reject);
        });
      } else {
        const rangeEnd = Math.min(
          VIDEO_FETCH_FOR_THUMB - 1,
          Math.max(0, (headResp.ContentLength ?? VIDEO_FETCH_FOR_THUMB) - 1)
        );
        const getCmd = new GetObjectCommand({
          Bucket: s3Config.bucket,
          Key: objectKey,
          Range: `bytes=0-${rangeEnd}`,
        });
        const getResp = await s3Client.send(getCmd);
        const encBuf = await readBodyToBuffer(getResp.Body);
        videoBuf = isEncryptedPayload(encBuf)
          ? decryptBuffer(encBuf, encKey, { aad: objectKey })
          : encBuf;
      }

      fs.writeFileSync(videoPath, videoBuf);

      let thumbBuf: Buffer;
      try {
        execSync(
          `ffmpeg -y -ss 1.0 -i "${videoPath}" -vframes 1 -vf "scale='min(640,iw)':-2" -f image2 -q:v 4 "${thumbPath}"`,
          { stdio: "pipe", timeout: 15000 }
        );
      } catch {
        try {
          execSync(
            `ffmpeg -y -ss 0 -i "${videoPath}" -vframes 1 -vf "scale='min(640,iw)':-2" -f image2 -q:v 4 "${thumbPath}"`,
            { stdio: "pipe", timeout: 15000 }
          );
        } catch {
          res.status(500).json({ message: "Failed to extract video frame" });
          return;
        }
      }

      thumbBuf = fs.readFileSync(thumbPath);

      let width: number | undefined;
      let height: number | undefined;
      let duration: number | undefined;
      try {
        const probe = execSync(
          `ffprobe -v quiet -print_format json -show_streams -show_format "${videoPath}"`,
          { encoding: "utf-8", timeout: 5000 }
        );
        const data = JSON.parse(probe);
        const vidStream = data.streams?.find((s: any) => s.codec_type === "video");
        if (vidStream) {
          width = parseInt(vidStream.width, 10);
          height = parseInt(vidStream.height, 10);
        }
        const fmt = data.format;
        if (fmt?.duration) duration = Math.round(parseFloat(fmt.duration));
      } catch {
        // ignore
      }

      const posterKeyBase = objectKey.replace(/\.[^.]+$/, "") || objectKey;
      const posterKey = `${posterKeyBase}-poster-${Date.now()}.eblusha`;

      const { payload, meta: encMetaOut } = encryptBuffer(thumbBuf, encKey, {
        aad: posterKey,
        contentType: "image/jpeg",
      });

      await s3Client.send(
        new PutObjectCommand({
          Bucket: s3Config.bucket,
          Key: posterKey,
          Body: payload,
          ContentType: "application/octet-stream",
          Metadata: {
            enc: "ebp1",
            encv: encMetaOut.v,
            encalg: encMetaOut.alg,
            enciv: encMetaOut.iv,
            enctag: encMetaOut.tag,
            ct: "image/jpeg",
          },
        })
      );

      const updatedMeta = {
        ...meta,
        posterKey,
        ...(width != null ? { width } : {}),
        ...(height != null ? { height } : {}),
        ...(duration != null ? { duration } : {}),
      };

      await prisma.messageAttachment.update({
        where: { id: attachment.id },
        data: { metadata: updatedMeta as any },
      });

      const posterUrl = `/api/files/${encodeKeyForUrl(posterKey)}`;

      res.json({
        posterKey,
        posterUrl,
        width,
        height,
        duration,
      });
    } catch (err: any) {
      logger.error({ err, attachmentId }, "Thumbnail generation failed");
      res.status(500).json({ message: err?.message || "Thumbnail generation failed" });
    } finally {
      try {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      } catch {}
    }
  }
);

export default router;
