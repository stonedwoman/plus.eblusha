import logger from "./config/logger";
import { startLinkPreviewWorker } from "./jobs/workers/linkPreview.worker";
import { startPushWorker } from "./jobs/workers/push.worker";
import { startImageThumbWorker } from "./jobs/workers/imageThumb.worker";

function main() {
  const worker = startLinkPreviewWorker();
  const pushWorker = startPushWorker();
  // Превью картинок чата: перенесено сюда из HTTP-обработчика загрузки, где
  // отправитель фото ждал форк ffmpeg (до 15 с). Воркер уже примонтирован
  // к хранилищу и имеет STORAGE_ENC_KEY — ни compose, ни образ менять не нужно.
  const imageThumbWorker = startImageThumbWorker();
  logger.info("Link preview + push + image thumbnail workers started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down link preview worker");
    try {
      await Promise.allSettled([worker.close(), pushWorker.close(), imageThumbWorker.close()]);
      process.exit(0);
    } catch (error) {
      logger.error({ error }, "Failed to close workers");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main();
