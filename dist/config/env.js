"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
// Load base .env then override with .env.local if present
dotenv_1.default.config();
dotenv_1.default.config({ path: ".env.local", override: true });
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(["development", "test", "production"]).default("development"),
    PORT: zod_1.z.coerce.number().default(4000),
    CLIENT_URL: zod_1.z.string().url().optional(),
    DATABASE_URL: zod_1.z.string(),
    JWT_SECRET: zod_1.z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_REFRESH_SECRET: zod_1.z
        .string()
        .min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    JWT_ACCESS_EXPIRES_IN: zod_1.z.string().default("15m"),
    JWT_REFRESH_EXPIRES_IN: zod_1.z.string().default("180d"),
    // Cookie options for refresh token
    COOKIE_SAMESITE: zod_1.z.enum(["lax", "none", "strict"]).default("lax"),
    COOKIE_DOMAIN: zod_1.z.string().optional(),
    COOKIE_PATH: zod_1.z.string().default("/api"),
    // LiveKit must be explicitly provided
    LIVEKIT_URL: zod_1.z.string().url({ message: "LIVEKIT_URL must be a valid ws(s) URL" }),
    LIVEKIT_API_KEY: zod_1.z.string(),
    LIVEKIT_API_SECRET: zod_1.z.string(),
    REDIS_URL: zod_1.z.string().url().optional(),
    // Default TTL for secret messages on the server (in seconds)
    SECRET_MESSAGE_TTL_SECONDS: zod_1.z.coerce.number().default(3600),
});
const env = envSchema.parse(process.env);
exports.default = env;
//# sourceMappingURL=env.js.map