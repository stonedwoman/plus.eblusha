import logger from "./config/logger";
import { startLinkPreviewWorker } from "./jobs/workers/linkPreview.worker";

function main() {
  const worker = startLinkPreviewWorker();
  logger.info("Link preview worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down link preview worker");
    try {
      await worker.close();
      process.exit(0);
    } catch (error) {
      logger.error({ error }, "Failed to close link preview worker");
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
