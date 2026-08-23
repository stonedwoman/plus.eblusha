import logger from "./config/logger";
import cloudConfig from "./cloud/config";
import { startCloudMediaWorkers } from "./cloud/jobs/mediaWorker";

/**
 * Отдельный процесс медиа-обработки Cloud.
 *
 * Вынесен из основного worker'а мессенджера намеренно: ffmpeg способен занять
 * все ядра на часы, и он не должен конкурировать с превью ссылок и пушами.
 * Concurrency ограничена (см. CLOUD_VIDEO_CONCURRENCY=1 по умолчанию).
 */
async function main(): Promise<void> {
  if (!cloudConfig.CLOUD_ENABLED) {
    logger.warn("Eblusha Cloud worker: CLOUD_ENABLED=false, nothing to do");
    // Не выходим: иначе Docker будет бесконечно перезапускать контейнер.
    setInterval(() => undefined, 3600_000);
    return;
  }

  const workers = startCloudMediaWorkers();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Eblusha Cloud worker shutting down");
    try {
      await Promise.allSettled(workers.map((w) => w.close()));
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "Eblusha Cloud worker failed to start");
  process.exit(1);
});
