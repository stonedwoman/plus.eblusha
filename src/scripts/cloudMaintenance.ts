import logger from "../config/logger";
import { runAllMaintenance } from "../cloud/jobs/maintenance";

/** Ручной прогон уборки Cloud: npm run cloud:maintenance */
runAllMaintenance()
  .then(() => {
    logger.info("Eblusha Cloud maintenance finished");
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, "Eblusha Cloud maintenance failed");
    process.exit(1);
  });
