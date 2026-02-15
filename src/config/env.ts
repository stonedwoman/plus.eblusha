import dotenv from "dotenv";
import { z } from "zod";

// Load base .env then override with .env.local if present
dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  CLIENT_URL: z.string().url().optional(),
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
  // LiveKit must be explicitly provided
  LIVEKIT_URL: z.string().url({ message: "LIVEKIT_URL must be a valid ws(s) URL" }),
  LIVEKIT_API_KEY: z.string(),
  LIVEKIT_API_SECRET: z.string(),
  REDIS_URL: z.string().url().optional(),
  // Default TTL for secret messages on the server (in seconds)
  SECRET_MESSAGE_TTL_SECONDS: z.coerce.number().default(3600),
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
  STORAGE_ENC_KEY: z.string().optional(),
  // Optional KEK (base64 or hex, 32 bytes) for server-side encryption of NON-secret chat DEKs
  // If unset, non-secret chat encryption helpers will throw when used.
  CHAT_ENC_KEK: z.string().optional(),
});

const env = envSchema.parse(process.env);

export default env;

