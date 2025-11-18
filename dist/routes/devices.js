"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../lib/prisma"));
const auth_1 = require("../middlewares/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const registerSchema = zod_1.z.object({
    deviceId: zod_1.z.string().min(8),
    name: zod_1.z.string().min(1),
    platform: zod_1.z.string().optional(),
    publicKey: zod_1.z.string().min(16),
    prekeys: zod_1.z
        .array(zod_1.z.object({
        keyId: zod_1.z.string().min(1),
        publicKey: zod_1.z.string().min(16),
    }))
        .max(200)
        .optional(),
});
router.get("/", async (req, res) => {
    const userId = req.user.id;
    const devices = await prisma_1.default.userDevice.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        include: {
            _count: {
                select: {
                    prekeys: {
                        where: { consumedAt: null },
                    },
                },
            },
        },
    });
    res.json({
        devices: devices.map((d) => ({
            id: d.id,
            userId: d.userId,
            name: d.name,
            platform: d.platform,
            createdAt: d.createdAt,
            lastSeenAt: d.lastSeenAt,
            revokedAt: d.revokedAt,
            publicKey: d.publicKey,
            availablePrekeys: d._count.prekeys,
        })),
    });
});
router.get("/:deviceId", async (req, res) => {
    const { deviceId } = req.params;
    const userId = req.user.id;
    const device = await prisma_1.default.userDevice.findUnique({
        where: { id: deviceId },
        select: {
            id: true,
            userId: true,
            name: true,
            platform: true,
            publicKey: true,
            revokedAt: true,
        },
    });
    if (!device || device.userId !== userId || device.revokedAt) {
        res.status(404).json({ message: "Device not found" });
        return;
    }
    res.json({ device });
});
router.post("/register", async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid device payload" });
        return;
    }
    const { deviceId, name, platform, publicKey, prekeys } = parsed.data;
    const userId = req.user.id;
    const existing = await prisma_1.default.userDevice.findUnique({ where: { id: deviceId } });
    if (existing && existing.userId !== userId) {
        res.status(409).json({ message: "Device already registered to another user" });
        return;
    }
    const device = await prisma_1.default.userDevice.upsert({
        where: { id: deviceId },
        update: {
            name,
            platform: platform ?? existing?.platform ?? null,
            publicKey,
            lastSeenAt: new Date(),
            revokedAt: null,
        },
        create: {
            id: deviceId,
            userId,
            name,
            platform: platform ?? null,
            publicKey,
            lastSeenAt: new Date(),
        },
    });
    if (prekeys && prekeys.length) {
        await prisma_1.default.devicePrekey.createMany({
            data: prekeys.map((pk) => ({
                deviceId,
                keyId: pk.keyId,
                publicKey: pk.publicKey,
            })),
            skipDuplicates: true,
        });
    }
    res.json({ device });
});
const publishSchema = zod_1.z.object({
    prekeys: zod_1.z
        .array(zod_1.z.object({
        keyId: zod_1.z.string().min(1),
        publicKey: zod_1.z.string().min(16),
    }))
        .min(1)
        .max(200),
});
router.post("/:deviceId/prekeys", async (req, res) => {
    const { deviceId } = req.params;
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid prekeys payload" });
        return;
    }
    const userId = req.user.id;
    const device = await prisma_1.default.userDevice.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== userId) {
        res.status(404).json({ message: "Device not found" });
        return;
    }
    if (device.revokedAt) {
        res.status(409).json({ message: "Device is revoked" });
        return;
    }
    await prisma_1.default.devicePrekey.createMany({
        data: parsed.data.prekeys.map((pk) => ({
            deviceId,
            keyId: pk.keyId,
            publicKey: pk.publicKey,
        })),
        skipDuplicates: true,
    });
    res.json({ success: true });
});
router.post("/prekeys/claim", async (req, res) => {
    const claimSchema = zod_1.z.object({
        deviceId: zod_1.z.string().min(8),
    });
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid claim payload" });
        return;
    }
    const { deviceId } = parsed.data;
    const device = await prisma_1.default.userDevice.findUnique({
        where: { id: deviceId },
    });
    if (!device || device.revokedAt) {
        res.status(404).json({ message: "Device not available" });
        return;
    }
    const prekey = await prisma_1.default.devicePrekey.findFirst({
        where: { deviceId, consumedAt: null },
        orderBy: { createdAt: "asc" },
    });
    if (!prekey) {
        res.status(404).json({ message: "No prekeys available" });
        return;
    }
    await prisma_1.default.devicePrekey.update({
        where: { id: prekey.id },
        data: { consumedAt: new Date() },
    });
    res.json({
        deviceId,
        identityKey: device.publicKey,
        prekey: {
            keyId: prekey.keyId,
            publicKey: prekey.publicKey,
        },
    });
});
router.delete("/:deviceId", async (req, res) => {
    const { deviceId } = req.params;
    const userId = req.user.id;
    const device = await prisma_1.default.userDevice.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== userId) {
        res.status(404).json({ message: "Device not found" });
        return;
    }
    await prisma_1.default.userDevice.update({
        where: { id: deviceId },
        data: { revokedAt: new Date() },
    });
    res.json({ success: true });
});
exports.default = router;
//# sourceMappingURL=devices.js.map