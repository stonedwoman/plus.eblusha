import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import compression from "compression";
import env from "./config/env";
import routes from "./routes";
import { requestIdMiddleware } from "./middlewares/requestId";
import { httpLoggerMiddleware } from "./middlewares/httpLogger";

const app = express();

// Respect reverse proxy headers (X-Forwarded-*) so we can generate correct absolute URLs
app.set("trust proxy", true);

// request_id baseline: attach id early, always return it in headers
app.use(requestIdMiddleware);
// structured baseline logs
app.use(httpLoggerMiddleware);

app.use(
  helmet({
    // Allow cross-origin loading of static uploads in <img> tags
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // Default Helmet CSP blocks external images (img-src 'self' data:),
    // but game presence uses Steam/Discord CDNs for icons/covers.
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "img-src": [
          "'self'",
          "data:",
          "https://cdn.steamstatic.com",
          "https://cdn.discordapp.com",
        ],
      },
    },
  })
);
app.use(
  cors({
    origin: env.CLIENT_URL ?? true,
    credentials: true,
  })
);
app.use(
  compression({
    threshold: 0,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", routes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

export default app;

