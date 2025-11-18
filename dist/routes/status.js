"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../lib/prisma"));
const auth_1 = require("../middlewares/auth");
const socket_1 = require("../realtime/socket");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get("/me", async (req, res) => {
    const userId = req.user.id;
    // ensure eblid exists
    const me = await prisma_1.default.user.findUnique({ where: { id: userId }, select: { eblid: true } });
    if (!me?.eblid) {
        // generate 4-digit unique
        let code = null;
        for (let i = 0; i < 20; i++) {
            const candidate = Math.floor(1000 + Math.random() * 9000).toString();
            const exists = await prisma_1.default.user.findFirst({ where: { eblid: candidate }, select: { id: true } });
            if (!exists) {
                code = candidate;
                break;
            }
        }
        if (code)
            await prisma_1.default.user.update({ where: { id: userId }, data: { eblid: code } });
    }
    const user = await prisma_1.default.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            username: true,
            eblid: true,
            displayName: true,
            bio: true,
            avatarUrl: true,
            status: true,
            lastSeenAt: true,
        },
    });
    res.json({ user });
});
router.patch("/me", async (req, res) => {
    const { displayName, bio, status, avatarUrl } = req.body;
    const userId = req.user.id;
    const data = {};
    if (displayName !== undefined)
        data.displayName = displayName ?? null;
    if (bio !== undefined)
        data.bio = bio ?? null;
    if (status !== undefined) {
        data.status = status;
        data.lastSeenAt = status === "ONLINE" ? new Date() : undefined;
    }
    if (avatarUrl !== undefined)
        data.avatarUrl = avatarUrl ?? null;
    const updated = await prisma_1.default.user.update({
        where: { id: userId },
        data,
        select: {
            id: true,
            username: true,
            eblid: true,
            displayName: true,
            bio: true,
            avatarUrl: true,
            status: true,
            lastSeenAt: true,
        },
    });
    // notify others about profile change
    (0, socket_1.getIO)()?.emit("profile:update", { userId, avatarUrl: updated.avatarUrl, displayName: updated.displayName });
    res.json({ user: updated });
});
exports.default = router;
//# sourceMappingURL=status.js.map