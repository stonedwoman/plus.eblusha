import http from "http";
import path from "path";
import fs from "fs";
import express from "express";
import app from "./app";
import env from "./config/env";
import logger from "./config/logger";
import { initSocket } from "./realtime/socket";

const port = env.PORT;

// Local uploads are disabled by default when S3 is configured.
// This enforces "nothing is stored on the server" for media.
const s3Configured = !!(env.STORAGE_S3_ENDPOINT && env.STORAGE_S3_REGION && env.STORAGE_S3_BUCKET);
const localUploadsEnabled = !s3Configured && process.env.ENABLE_LOCAL_UPLOADS === "true";

if (localUploadsEnabled) {
  // static serving for uploads with permissive cross-origin headers for images
  const uploadsPath = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsPath)) {
    fs.mkdirSync(uploadsPath, { recursive: true });
  }
  const staticOptions = {
    dotfiles: "deny",
    etag: true,
    fallthrough: true, // Allow request to continue if file not found
    index: false,
    lastModified: true,
    maxAge: "1y",
  };

  // Middleware to set CORS headers for uploads
  const uploadsCors = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  };

  app.use("/uploads", uploadsCors, express.static(uploadsPath, staticOptions));

  app.use(
    "/api/uploads",
    uploadsCors,
    express.static(uploadsPath, staticOptions),
    (_req, res) => {
      // If file not found, return 404 with proper headers
      if (!res.headersSent) {
        res.status(404).json({ message: "File not found" });
      }
    }
  );
} else {
  logger.info(
    { s3Configured, enableLocalUploadsEnv: process.env.ENABLE_LOCAL_UPLOADS },
    "Local uploads are disabled"
  );
}

async function main() {
  const httpServer = http.createServer(app);
  await initSocket(httpServer);

  httpServer.listen(port, () => {
    logger.info(`Server listening on port ${port}`);
  });

  process.on("SIGTERM", () => {
    httpServer.close(() => {
      logger.info("SIGTERM received: shutting down gracefully");
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    httpServer.close(() => {
      logger.info("SIGINT received: shutting down gracefully");
      process.exit(0);
    });
  });
}

main().catch((error) => {
  logger.error({ error }, "Server failed to start");
  process.exit(1);
});

