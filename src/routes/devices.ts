import { Router, type Request } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rateLimit";

const router = Router();

router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string } };

const registerSchema = z.object({
  deviceId: z.string().min(8),
  name: z.string().min(1),
  platform: z.string().optional(),
  publicKey: z.string().min(16),
  prekeys: z
    .array(
      z.object({
        keyId: z.string().min(1),
        publicKey: z.string().min(16),
      })
    )
    .max(200)
    .optional(),
});

router.get("/", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  const devices = await prisma.userDevice.findMany({
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
  const userId = (req as AuthedRequest).user!.id;
  const device = await prisma.userDevice.findUnique({
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

router.post(
  "/register",
  rateLimit({ name: "device_register", windowMs: 60_000, max: 30 }),
  async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid device payload" });
    return;
  }
  const { deviceId, name, platform, publicKey, prekeys } = parsed.data;
  const userId = (req as AuthedRequest).user!.id;

  const existing = await prisma.userDevice.findUnique({ where: { id: deviceId } });
  if (existing && existing.userId !== userId) {
    res.status(409).json({ message: "Device already registered to another user" });
    return;
  }

  const device = await prisma.userDevice.upsert({
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
    await prisma.devicePrekey.createMany({
      data: prekeys.map((pk) => ({
        deviceId,
        keyId: pk.keyId,
        publicKey: pk.publicKey,
      })),
      skipDuplicates: true,
    });
  }

  res.json({ device });
  }
);

const publishSchema = z.object({
  prekeys: z
    .array(
      z.object({
        keyId: z.string().min(1),
        publicKey: z.string().min(16),
      })
    )
    .min(1)
    .max(200),
});

router.post(
  "/:deviceId/prekeys",
  rateLimit({ name: "secret_prekeys_publish", windowMs: 60_000, max: 30 }),
  async (req, res) => {
  const deviceId = req.params.deviceId;
  if (!deviceId) {
    res.status(400).json({ message: "Missing deviceId" });
    return;
  }
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid prekeys payload" });
    return;
  }
  const userId = (req as AuthedRequest).user!.id;
  const device = await prisma.userDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== userId) {
    res.status(404).json({ message: "Device not found" });
    return;
  }
  if (device.revokedAt) {
    res.status(409).json({ message: "Device is revoked" });
    return;
  }
  await prisma.devicePrekey.createMany({
    data: parsed.data.prekeys.map((pk) => ({
      deviceId,
      keyId: pk.keyId,
      publicKey: pk.publicKey,
    })),
    skipDuplicates: true,
  });
  res.json({ success: true });
  }
);

router.post(
  "/prekeys/claim",
  rateLimit({ name: "secret_prekeys_claim", windowMs: 60_000, max: 60 }),
  async (req, res) => {
  const claimSchema = z.object({
    deviceId: z.string().min(8),
  });
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid claim payload" });
    return;
  }
  const { deviceId } = parsed.data;
  const device = await prisma.userDevice.findUnique({
    where: { id: deviceId },
  });
  if (!device || device.revokedAt) {
    res.status(404).json({ message: "Device not available" });
    return;
  }
  const prekey = await prisma.devicePrekey.findFirst({
    where: { deviceId, consumedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (!prekey) {
    res.status(404).json({ message: "No prekeys available" });
    return;
  }

  await prisma.devicePrekey.update({
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
  }
);

router.delete("/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const userId = (req as AuthedRequest).user!.id;
  const device = await prisma.userDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== userId) {
    res.status(404).json({ message: "Device not found" });
    return;
  }
  await prisma.userDevice.update({
    where: { id: deviceId },
    data: { revokedAt: new Date() },
  });
  res.json({ success: true });
});

export default router;

