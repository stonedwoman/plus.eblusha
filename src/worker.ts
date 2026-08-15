import logger from "./config/logger";
import { startLinkPreviewWorker } from "./jobs/workers/linkPreview.worker";
import { startPushWorker } from "./jobs/workers/push.worker";

function main() {
  const worker = startLinkPreviewWorker();
  const pushWorker = startPushWorker();
  logger.info("Link preview + push workers started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down link preview worker");
    try {
      await Promise.allSettled([worker.close(), pushWorker.close()]);
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
