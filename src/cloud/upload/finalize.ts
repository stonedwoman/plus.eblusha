import fsp from "node:fs/promises";
import prisma from "../../lib/prisma";
import logger from "../../config/logger";
import { stagingPath } from "../paths";
import { adoptStagingFile } from "../storage/objects";
import { kindFromMime, sniffFile } from "../media/sniff";
import { enqueueImageJob, enqueueVideoJob } from "../jobs/queues";
import { emitCloud, spaceRoom, userRoom } from "../realtime";
import { recordActivity } from "../activity";
import { writeAudit } from "../audit";
import { fileDto } from "../serialize";
import { processGeneric } from "../jobs/mediaWorker";

/**
 * Финализация загрузки. Единственное место, где недоверенные байты становятся
 * логическим файлом.
 *
 * Порядок принципиален:
 *   размер → SHA-256 сервером → реальный media type → атомарный перенос в
 *   objects/ → StorageObject (с дедупом) → CloudFile → медиа-джоба → событие.
 *
 * Клиентский хеш здесь не участвует вообще: он не является источником истины.
 */
export async function finalizeUpload(sessionId: string): Promise<void> {
  const session = await prisma.cloudUploadSession.findUnique({ where: { id: sessionId } });
  if (!session) return;
  if (session.status === "READY" || session.status === "PROCESSING") return;

  const staging = stagingPath(session.uploadProtocolId);
  const emitSession = async (status: string, extra: Record<string, unknown> = {}) => {
    await emitCloud("cloud.upload.updated", [userRoom(session.userId)], {
      id: session.id,
      spaceId: session.spaceId,
      status,
      name: session.originalName,
      expectedSize: Number(session.expectedSize),
      bytesReceived: Number(session.bytesReceived),
      ...extra,
    });
  };

  try {
    await prisma.cloudUploadSession.update({ where: { id: sessionId }, data: { status: "VERIFYING" } });
    await emitSession("VERIFYING");

    const st = await fsp.stat(staging).catch(() => null);
    if (!st || !st.isFile()) throw new Error("staging file missing");
    if (BigInt(st.size) !== session.expectedSize) {
      throw new Error(`size mismatch: got ${st.size}, expected ${session.expectedSize}`);
    }

    const sniffed = await sniffFile(staging);
    const adopted = await adoptStagingFile(staging, { detectedMime: sniffed.mime });

    const takenAt = session.clientMtime ?? new Date();
    const file = await prisma.$transaction(async (tx) => {
      const created = await tx.cloudFile.create({
        data: {
          spaceId: session.spaceId,
          folderId: session.folderId,
          storageObjectId: adopted.objectId,
          originalName: session.originalName,
          mimeType: sniffed.mime,
          size: BigInt(adopted.size),
          kind: kindFromMime(sniffed.mime),
          uploaderId: session.userId,
          status: "PROCESSING",
          takenAt,
          takenAtSource: session.clientMtime ? "client" : "upload",
        },
      });
      await tx.cloudStorageObject.update({
        where: { id: adopted.objectId },
        data: { refCount: { increment: 1 } },
      });
      return created;
    });

    await prisma.cloudUploadSession.update({
      where: { id: sessionId },
      data: { status: "PROCESSING", fileId: file.id, bytesReceived: BigInt(adopted.size) },
    });
    await emitSession("PROCESSING", { fileId: file.id });

    const full = await prisma.cloudFile.findUnique({
      where: { id: file.id },
      include: { variants: true, uploader: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    if (full) {
      await emitCloud("cloud.file.created", [spaceRoom(session.spaceId)], {
        spaceId: session.spaceId,
        file: fileDto(full),
      });
    }

    await recordActivity(session.spaceId, session.userId, "FILES_UPLOADED", {
      count: 1,
      names: [session.originalName],
    });
    await writeAudit(null, "FILE_UPLOADED", {
      actorId: session.userId,
      spaceId: session.spaceId,
      targetId: file.id,
      detail: { size: adopted.size, deduped: adopted.deduped, mime: sniffed.mime },
    });

    if (file.kind === "IMAGE") await enqueueImageJob(file.id);
    else if (file.kind === "VIDEO") await enqueueVideoJob(file.id);
    else await processGeneric(file.id);

    await prisma.cloudUploadSession.update({ where: { id: sessionId }, data: { status: "READY" } });
    await emitSession("READY", { fileId: file.id });
  } catch (err) {
    logger.error({ err, sessionId }, "cloud: upload finalize failed");
    await prisma.cloudUploadSession
      .update({ where: { id: sessionId }, data: { status: "FAILED", error: String(err).slice(0, 400) } })
      .catch(() => undefined);
    await emitSession("FAILED", { error: "Не удалось завершить загрузку" });
  }
}
