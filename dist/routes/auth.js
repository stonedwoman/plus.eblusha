"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../lib/prisma"));
const password_1 = require("../utils/password");
const jwt_1 = require("../utils/jwt");
const env_1 = __importDefault(require("../config/env"));
const router = (0, express_1.Router)();
const registerSchema = zod_1.z.object({
    username: zod_1.z.string().min(3).max(30),
    displayName: zod_1.z.string().min(2).max(50),
    password: zod_1.z.string().min(8),
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().optional(),
});
const loginSchema = zod_1.z.object({
    username: zod_1.z.string(),
    password: zod_1.z.string(),
});
router.post("/register", async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
        return;
    }
    const { username, displayName, password, email, phone } = parsed.data;
    const uniqueChecks = [{ username }];
    if (email)
        uniqueChecks.push({ email });
    if (phone)
        uniqueChecks.push({ phone });
    const existing = await prisma_1.default.user.findFirst({
        where: { OR: uniqueChecks },
        select: { id: true, username: true },
    });
    if (existing) {
        res.status(409).json({ message: "User already exists" });
        return;
    }
    const passwordHash = await (0, password_1.hashPassword)(password);
    const user = await prisma_1.default.user.create({
        data: {
            username,
            displayName,
            passwordHash,
            email: email ?? null,
            phone: phone ?? null,
        },
        select: { id: true, username: true, displayName: true },
    });
    res.status(201).json({ user });
});
router.post("/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid credentials" });
        return;
    }
    const { username, password } = parsed.data;
    const user = await prisma_1.default.user.findUnique({
        where: { username },
        select: {
            id: true,
            username: true,
            displayName: true,
            passwordHash: true,
        },
    });
    if (!user) {
        res.status(401).json({ message: "Invalid credentials" });
        return;
    }
    const valid = await (0, password_1.verifyPassword)(password, user.passwordHash);
    if (!valid) {
        res.status(401).json({ message: "Invalid credentials" });
        return;
    }
    const tokenId = node_crypto_1.default.randomUUID();
    const accessToken = (0, jwt_1.signAccessToken)({ sub: user.id, tokenId });
    const refreshTokenValue = (0, jwt_1.signRefreshToken)({ sub: user.id, tokenId });
    await prisma_1.default.refreshToken.create({
        data: {
            token: tokenId,
            userId: user.id,
            expiresAt: new Date(Date.now() + parseJwtExpiry()),
        },
    });
    // Set httpOnly cookie for refresh token
    const cookieMaxAge = parseJwtExpiry();
    const sameSite = env_1.default.COOKIE_SAMESITE ?? "lax";
    res.cookie("refreshToken", refreshTokenValue, {
        httpOnly: true,
        secure: env_1.default.NODE_ENV === "production",
        sameSite,
        maxAge: cookieMaxAge,
        path: env_1.default.COOKIE_PATH || "/api",
        domain: env_1.default.COOKIE_DOMAIN || undefined,
    });
    res.json({
        accessToken,
        user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
        },
    });
});
router.post("/refresh", async (req, res) => {
    // Try to get refresh token from cookie first, then from body (for backward compatibility)
    const token = req.cookies?.refreshToken || req.body?.refreshToken;
    if (typeof token !== "string") {
        res.status(400).json({ message: "Invalid refresh token" });
        return;
    }
    try {
        const payload = (0, jwt_1.verifyRefreshToken)(token);
        const stored = await prisma_1.default.refreshToken.findUnique({
            where: { token: payload.tokenId },
        });
        if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
            res.clearCookie("refreshToken", { path: "/api/auth" });
            res.status(401).json({ message: "Refresh token expired" });
            return;
        }
        const newTokenId = node_crypto_1.default.randomUUID();
        await prisma_1.default.$transaction([
            prisma_1.default.refreshToken.update({
                where: { token: payload.tokenId },
                data: { revokedAt: new Date() },
            }),
            prisma_1.default.refreshToken.create({
                data: {
                    token: newTokenId,
                    userId: payload.sub,
                    expiresAt: new Date(Date.now() + parseJwtExpiry()),
                },
            }),
        ]);
        const accessToken = (0, jwt_1.signAccessToken)({ sub: payload.sub, tokenId: newTokenId });
        const refreshTokenValue = (0, jwt_1.signRefreshToken)({ sub: payload.sub, tokenId: newTokenId });
        // Update httpOnly cookie with new refresh token
        const cookieMaxAge = parseJwtExpiry();
        const sameSite = env_1.default.COOKIE_SAMESITE ?? "lax";
        res.cookie("refreshToken", refreshTokenValue, {
            httpOnly: true,
            secure: env_1.default.NODE_ENV === "production",
            sameSite,
            maxAge: cookieMaxAge,
            path: env_1.default.COOKIE_PATH || "/api",
            domain: env_1.default.COOKIE_DOMAIN || undefined,
        });
        res.json({ accessToken });
    }
    catch (error) {
        res.clearCookie("refreshToken", {
            path: env_1.default.COOKIE_PATH || "/api",
            domain: env_1.default.COOKIE_DOMAIN || undefined,
        });
        res.status(401).json({ message: "Invalid refresh token" });
    }
});
router.post("/logout", async (req, res) => {
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
    if (typeof refreshToken === "string") {
        try {
            const payload = (0, jwt_1.verifyRefreshToken)(refreshToken);
            await prisma_1.default.refreshToken.updateMany({
                where: { token: payload.tokenId },
                data: { revokedAt: new Date() },
            });
        }
        catch {
            // Ignore errors during logout
        }
    }
    res.clearCookie("refreshToken", {
        path: env_1.default.COOKIE_PATH || "/api",
        domain: env_1.default.COOKIE_DOMAIN || undefined,
    });
    res.status(204).send();
});
function parseJwtExpiry() {
    const expiry = process.env.JWT_REFRESH_EXPIRES_IN ?? "180d";
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) {
        throw new Error("Invalid JWT expiry format");
    }
    const amount = Number(match[1]);
    const unit = match[2];
    const multipliers = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
    };
    return amount * multipliers[unit];
}
exports.default = router;
//# sourceMappingURL=auth.js.map