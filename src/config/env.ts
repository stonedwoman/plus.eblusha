import dotenv from "dotenv";
import { z } from "zod";

// Load base .env then override with .env.local if present
dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  // Один origin или несколько через запятую (http://stoned.local,https://eblusha.org)
  CLIENT_URL: z
    .string()
    .optional()
    .transform((v): string[] | undefined => {
      if (!v?.trim()) return undefined;
      const parts = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const valid: string[] = [];
      for (const p of parts) {
        try {
          new URL(p);
          valid.push(p);
        } catch {
          // skip invalid
        }
      }
      return valid.length > 0 ? valid : undefined;
    }),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("180d"),
  // Cookie options for refresh token
  COOKIE_SAMESITE: z.enum(["lax", "none", "strict"]).default("lax"),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_PATH: z.string().default("/api"),
  // Override: 0/false = allow cookies over HTTP (stoned.local и т.п.)
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v): boolean | undefined =>
      v === undefined ? undefined : /^(1|true|yes)$/i.test(String(v).trim())
    ),
  // LiveKit: либо полный URL (LIVEKIT_URL), либо путь для построения от текущего хоста (LIVEKIT_PATH, без доменов)
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_PATH: z.string().optional(), // напр. /api/voice — бэкенд построит ws(s)://host/api/voice из запроса
  LIVEKIT_API_KEY: z.string(),
  LIVEKIT_API_SECRET: z.string(),
  // Feature flags
  // Enable LiveKit E2EE for 1:1 calls (web/electron). Defaults to false.
  E2EE_1TO1: z.coerce.boolean().default(false),
  REDIS_URL: z.string().url(),
  // Allow reading deviceId from socket handshake query (dev-only escape hatch). Default: false.
  ALLOW_DEVICE_QUERY: z.coerce.boolean().default(false),
  // Protect /api/status/metrics (Bearer token). Required in production.
  METRICS_TOKEN: z.string().min(8).optional(),
  // Optional bearer for /api/admin/*. Empty string is treated as unset — in that
  // mode the admin API is open without auth (see src/middlewares/adminAuth.ts;
  // the default deployment binds backend + admin nginx to host loopback only).
  // When set, must be >=16 chars (>=32 recommended).
  ADMIN_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .refine((v) => v === undefined || v.length >= 16, {
      message: "ADMIN_TOKEN must be at least 16 characters or empty",
    }),
  // Default TTL for secret messages on the server (in seconds)
  SECRET_MESSAGE_TTL_SECONDS: z.coerce.number().default(3600),
  // Debug: allow clients to ship SAFE debug logs to server (Redis, TTL/capped).
  // Keep disabled by default in production.
  DEBUG_CLIENT_LOGS: z.coerce.boolean().default(false),
  // Debug: enable storage encryption selftest endpoint (/api/debug/storageenc-selftest)
  DEBUG_STORAGE_ENC: z.coerce.boolean().default(false),
  // Storage backend: "local" | "s3" (default)
  STORAGE_BACKEND: z
    .string()
    .optional()
    .transform((v) => (v?.toLowerCase().trim() === "local" ? "local" : "s3")),
  // For STORAGE_BACKEND=local: base directory for files (default /var/lib/eblusha/storage)
  LOCAL_STORAGE_PATH: z.string().optional(),
  STORAGE_S3_ENDPOINT: z.string().url().optional(),
  STORAGE_S3_REGION: z.string().optional(),
  STORAGE_S3_BUCKET: z.string().optional(),
  STORAGE_S3_ACCESS_KEY: z.string().optional(),
  STORAGE_S3_SECRET_KEY: z.string().optional(),
  STORAGE_S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  STORAGE_PUBLIC_BASE_URL: z.string().url().optional(),
  STORAGE_PREFIX: z.string().default("uploads"),
  STORAGE_S3_ACL: z.string().optional(),
  STORAGE_S3_SSE: z.string().default("AES256"),
  // Optional symmetric key (base64 or hex, 32 bytes) for server-side encryption
  STORAGE_ENC_KEY: z.string().min(1).optional(),
  // When 1, use EBP2 (chunked AEAD) instead of EBP1 for new uploads. Allows Range/seek without full decrypt.
  STORAGE_ENC_V2: z.coerce.boolean().default(false),
  // Optional KEK (base64 or hex, 32 bytes) for server-side encryption of NON-secret chat DEKs
  // If unset, non-secret chat encryption helpers will throw when used.
  CHAT_ENC_KEK: z.string().optional(),
  // Ключ сервис-аккаунта Firebase для push-уведомлений: путь к файлу, сырой JSON или base64.
  // Необязателен — без него пуши просто выключены, сервер работает как раньше.
  FCM_SERVICE_ACCOUNT: z.string().optional(),
  // APNs (iOS): token-based авторизация ключом .p8 из Apple Developer (Keys → APNs).
  // KEY_FILE/KEY_ID/TEAM_ID нужны все три — без любого из них APNs просто выключен,
  // сервер работает как раньше (см. src/push/apns.ts).
  APNS_KEY_FILE: z.string().optional(), // путь к .p8-файлу (пробрасывается в контейнер томом)
  APNS_KEY_ID: z.string().optional(), // 10-символьный Key ID ключа
  APNS_TEAM_ID: z.string().optional(), // Team ID аккаунта разработчика
  APNS_BUNDLE_ID: z.string().default("org.eblusha.plus"),
  // sandbox — для dev-сборок из Xcode: они получают токены sandbox-кластера,
  // и прод-сервер APNs такие токены отвергает как BadDeviceToken.
  APNS_ENV: z.enum(["production", "sandbox"]).default("production"),
});

const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production" && !env.METRICS_TOKEN) {
  throw new Error("METRICS_TOKEN is required in production");
}

if (env.NODE_ENV === "production" && !env.STORAGE_ENC_KEY) {
  throw new Error("STORAGE_ENC_KEY is required in production");
}

if (!env.LIVEKIT_URL && !env.LIVEKIT_PATH) {
  throw new Error("Either LIVEKIT_URL or LIVEKIT_PATH must be set");
}

export default env;

