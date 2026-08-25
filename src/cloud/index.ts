import { Router } from "express";
import type { Request } from "express";
import prisma from "../lib/prisma";
import logger from "../config/logger";
import { rateLimit } from "../middlewares/rateLimit";
import cloudConfig from "./config";
import { ah, invalid } from "./errors";
import { cloudErrorHandler } from "./errors";
import { isCloudAdmin, requireCloudUser, requireCsrf } from "./auth/middleware";
import ssoRouter from "./auth/sso";
import spacesRouter from "./routes/spaces";
import foldersRouter from "./routes/folders";
import filesRouter from "./routes/files";
import uploadsRouter from "./routes/uploads";
import socialRouter from "./routes/social";
import facesRouter from "./routes/faces";
import sharesRouter from "./routes/shares";
import publicRouter from "./routes/public";
import adminRouter from "./routes/admin";
import { listAccessibleSpaceIds } from "./acl";
import { ensureStorageDirs } from "./paths";

/**
 * Точка сборки Eblusha Cloud. Модуль монтируется одной строкой в src/routes и
 * может быть выключен переменной CLOUD_ENABLED, не задевая мессенджер.
 */
const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "eblusha-cloud" });
});

// Публичные share-ссылки: до аутентификации, у них своя короткая сессия.
router.use("/public", publicRouter);

// SSO: /authorize требует Bearer Еблуши, /token и /logout — нет.
router.use("/auth", ssoRouter);

// Всё ниже — только с валидной Cloud-сессией.
router.use(requireCloudUser);

router.get(
  "/me",
  ah(async (req: Request, res) => {
    const user = req.cloudUser!;
    const spaceIds = await listAccessibleSpaceIds(user.id);
    res.json({
      user,
      csrf: req.cloudCsrf,
      isAdmin: isCloudAdmin(user),
      spaceCount: spaceIds.length,
      limits: {
        maxFileBytes: cloudConfig.CLOUD_MAX_FILE_BYTES,
        trashRetentionDays: cloudConfig.CLOUD_TRASH_RETENTION_DAYS,
      },
      map: {
        tileUrl: cloudConfig.CLOUD_MAP_TILE_URL,
        attribution: cloudConfig.CLOUD_MAP_ATTRIBUTION,
      },
    });
  })
);

/** Поиск пользователей Еблуши для приглашения в Space. */
router.get(
  "/users/search",
  rateLimit({ name: "cloud-user-search", windowMs: 60_000, max: 60 }),
  ah(async (req: Request, res) => {
    const q = String(req.query.q ?? "").trim();
    // Минимум три символа: не превращаем поиск в выгрузку списка пользователей.
    if (q.length < 3) throw invalid("Минимум 3 символа");
    const users = await prisma.user.findMany({
      where: {
        deletedAt: null,
        bannedAt: null,
        id: { not: req.cloudUser!.id },
        OR: [
          { username: { contains: q, mode: "insensitive" } },
          { displayName: { contains: q, mode: "insensitive" } },
          { eblid: { equals: q } },
        ],
      },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
      take: 10,
    });
    res.json({ users });
  })
);

// Мутации требуют заголовок X-Cloud-CSRF. Загрузки (tus) ставят его сами.
router.use(requireCsrf);

router.use("/spaces", spacesRouter);
router.use("/folders", foldersRouter);
router.use("/files", filesRouter);
router.use("/faces", facesRouter);
router.use("/uploads", uploadsRouter);
router.use("/", socialRouter);
router.use("/", sharesRouter);
router.use("/admin", adminRouter);

router.use(cloudErrorHandler);

export function createCloudRouter(): Router | null {
  if (!cloudConfig.CLOUD_ENABLED) {
    logger.warn("Eblusha Cloud disabled (CLOUD_ENABLED=false)");
    return null;
  }
  try {
    ensureStorageDirs();
  } catch (err) {
    logger.error({ err, root: cloudConfig.CLOUD_STORAGE_ROOT }, "Eblusha Cloud: cannot create storage dirs");
  }
  logger.info(
    {
      root: cloudConfig.CLOUD_STORAGE_ROOT,
      quotaGb: Math.round(cloudConfig.CLOUD_STORAGE_MAX_BYTES / 1024 ** 3),
      minFreeGb: Math.round(cloudConfig.CLOUD_STORAGE_MIN_FREE_BYTES / 1024 ** 3),
      xaccel: cloudConfig.CLOUD_XACCEL,
    },
    "Eblusha Cloud mounted at /api/cloud"
  );
  return router;
}

export default router;
