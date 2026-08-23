import { Router } from "express";
import type { Request } from "express";
import prisma from "../../lib/prisma";
import { ah, invalid } from "../errors";
import { requireCloudAdmin } from "../auth/middleware";
import { storageSnapshot } from "../storage/quota";
import { enqueueMaintenance, failedJobSummaries, queueStats } from "../jobs/queues";
import cloudConfig from "../config";

/**
 * Статусный экран для оператора. Не публичный: доступ по списку логинов Еблуши
 * в CLOUD_ADMIN_USERNAMES.
 */
const router = Router();

router.use(requireCloudAdmin);

router.get(
  "/storage",
  ah(async (_req: Request, res) => {
    const [snapshot, queues, failed, counts, pendingUploads] = await Promise.all([
      storageSnapshot(),
      queueStats(),
      failedJobSummaries(20),
      Promise.all([
        prisma.cloudSpace.count({ where: { deletedAt: null } }),
        prisma.cloudFile.count({ where: { deletedAt: null } }),
        prisma.cloudFile.count({ where: { deletedAt: { not: null } } }),
        prisma.cloudStorageObject.count(),
        prisma.cloudFile.count({ where: { status: "FAILED" } }),
      ]),
      prisma.cloudUploadSession.count({
        where: { status: { in: ["CREATED", "UPLOADING", "PAUSED", "UPLOADED", "VERIFYING"] } },
      }),
    ]);
    const [spaces, files, trashed, objects, failedFiles] = counts;

    // Дедупликация: сумма логических размеров минус физический расход.
    const logical = await prisma.cloudFile.aggregate({ _sum: { size: true }, where: { deletedAt: null } });
    const logicalBytes = Number(logical._sum.size ?? 0n);

    res.json({
      storage: snapshot,
      dedupSavedBytes: Math.max(0, logicalBytes - snapshot.originals),
      logicalBytes,
      counts: { spaces, files, trashed, objects, failedFiles, pendingUploads },
      queues,
      failedJobs: failed,
      config: {
        root: cloudConfig.CLOUD_STORAGE_ROOT,
        trashRetentionDays: cloudConfig.CLOUD_TRASH_RETENTION_DAYS,
        uploadTtlHours: cloudConfig.CLOUD_UPLOAD_TTL_HOURS,
        maxFileBytes: cloudConfig.CLOUD_MAX_FILE_BYTES,
        xaccel: cloudConfig.CLOUD_XACCEL,
      },
    });
  })
);

router.post(
  "/maintenance/:task",
  ah(async (req: Request, res) => {
    const task = String(req.params.task);
    if (!["trash-purge", "upload-gc", "derived-gc", "refcount-audit"].includes(task)) throw invalid("Неизвестная задача");
    await enqueueMaintenance(task as "trash-purge" | "upload-gc" | "derived-gc" | "refcount-audit");
    res.json({ ok: true, queued: task });
  })
);

router.get(
  "/audit",
  ah(async (req: Request, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const events = await prisma.cloudAuditEvent.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    res.json({ events });
  })
);

export default router;
