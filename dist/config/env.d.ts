declare const env: {
    NODE_ENV: "development" | "test" | "production";
    PORT: number;
    DATABASE_URL: string;
    JWT_SECRET: string;
    JWT_REFRESH_SECRET: string;
    JWT_ACCESS_EXPIRES_IN: string;
    JWT_REFRESH_EXPIRES_IN: string;
    COOKIE_SAMESITE: "lax" | "none" | "strict";
    COOKIE_PATH: string;
    LIVEKIT_URL: string;
    LIVEKIT_API_KEY: string;
    LIVEKIT_API_SECRET: string;
    SECRET_MESSAGE_TTL_SECONDS: number;
    CLIENT_URL?: string | undefined;
    COOKIE_DOMAIN?: string | undefined;
    REDIS_URL?: string | undefined;
};
export default env;
//# sourceMappingURL=env.d.ts.map