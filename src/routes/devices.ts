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
  identityPublicKey: z.string().min(16).optional(),
  signedPreKey: z
    .object({
      id: z.string().min(1),
      publicKey: z.string().min(16),
      signature: z.string().min(16),
      expiresAt: z.string().datetime().optional(),
    })
    .optional(),
  version: z.number().int().min(1).optional(),
  alg: z.string().min(1).optional(),
  prekeys: z
    .array(
      z.object({
        keyId: z.string().min(1),
        publicKey: z.string().min(16),
        oneTimePreKeyId: z.string().min(1).optional(),
        oneTimePreKeyPublic: z.string().min(16).optional(),
        version: z.number().int().min(1).optional(),
        alg: z.string().min(1).optional(),
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
      identityPublicKey: d.identityPublicKey,
      signedPreKey: d.signedPreKeyPublic
        ? {
            id: d.signedPreKeyId,
            publicKey: d.signedPreKeyPublic,
            signature: d.signedPreKeySignature,
            expiresAt: d.signedPreKeyExpiresAt,
          }
        : null,
      version: d.keyVersion,
      alg: d.keyAlg,
      availablePrekeys: d._count.prekeys,
    })),
  });
});

router.get("/:userId/prekey-bundles", async (req, res) => {
  const { userId } = req.params;
  const devices = await prisma.userDevice.findMany({
    where: {
      userId,
      revokedAt: null,
    },
    orderBy: { createdAt: "asc" },
    include: {
      prekeys: {
        where: { consumedAt: null },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });

  res.json({
    userId,
    bundles: devices.map((d) => {
      const prekey = d.prekeys[0] ?? null;
      return {
        deviceId: d.id,
        identityPublicKey: d.identityPublicKey ?? d.publicKey,
        signedPreKey: d.signedPreKeyPublic
          ? {
              id: d.signedPreKeyId,
              publicKey: d.signedPreKeyPublic,
              signature: d.signedPreKeySignature,
              expiresAt: d.signedPreKeyExpiresAt,
            }
          : null,
        oneTimePreKey: prekey
          ? {
              id: prekey.oneTimePreKeyId ?? prekey.keyId,
              publicKey: prekey.oneTimePreKeyPublic ?? prekey.publicKey,
              consumedAt: prekey.consumedAt,
            }
          : null,
        version: d.keyVersion,
        alg: d.keyAlg,
      };
    }),
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
      identityPublicKey: true,
      signedPreKeyId: true,
      signedPreKeyPublic: true,
      signedPreKeySignature: true,
      signedPreKeyExpiresAt: true,
      keyVersion: true,
      keyAlg: true,
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
  const { deviceId, name, platform, publicKey, identityPublicKey, signedPreKey, version, alg, prekeys } =
    parsed.data;
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
      identityPublicKey: identityPublicKey ?? publicKey,
      signedPreKeyId: signedPreKey?.id ?? null,
      signedPreKeyPublic: signedPreKey?.publicKey ?? null,
      signedPreKeySignature: signedPreKey?.signature ?? null,
      signedPreKeyExpiresAt: signedPreKey?.expiresAt ? new Date(signedPreKey.expiresAt) : null,
      keyVersion: version ?? 1,
      keyAlg: alg ?? "x25519+ed25519",
      lastSeenAt: new Date(),
      revokedAt: null,
    },
    create: {
      id: deviceId,
      userId,
      name,
      platform: platform ?? null,
      publicKey,
      identityPublicKey: identityPublicKey ?? publicKey,
      signedPreKeyId: signedPreKey?.id ?? null,
      signedPreKeyPublic: signedPreKey?.publicKey ?? null,
      signedPreKeySignature: signedPreKey?.signature ?? null,
      signedPreKeyExpiresAt: signedPreKey?.expiresAt ? new Date(signedPreKey.expiresAt) : null,
      keyVersion: version ?? 1,
      keyAlg: alg ?? "x25519+ed25519",
      lastSeenAt: new Date(),
    },
  });

  if (prekeys && prekeys.length) {
    await prisma.devicePrekey.createMany({
      data: prekeys.map((pk) => ({
        deviceId,
        keyId: pk.keyId,
        publicKey: pk.publicKey,
        oneTimePreKeyId: pk.oneTimePreKeyId ?? pk.keyId,
        oneTimePreKeyPublic: pk.oneTimePreKeyPublic ?? pk.publicKey,
        version: pk.version ?? version ?? 1,
        alg: pk.alg ?? alg ?? "x25519",
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
        oneTimePreKeyId: z.string().min(1).optional(),
        oneTimePreKeyPublic: z.string().min(16).optional(),
        version: z.number().int().min(1).optional(),
        alg: z.string().min(1).optional(),
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
      oneTimePreKeyId: pk.oneTimePreKeyId ?? pk.keyId,
      oneTimePreKeyPublic: pk.oneTimePreKeyPublic ?? pk.publicKey,
      version: pk.version ?? 1,
      alg: pk.alg ?? "x25519",
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
  const now = new Date();
  const claimedRows = await prisma.$queryRaw<
    Array<{
      id: string;
      keyId: string;
      publicKey: string;
      oneTimePreKeyId: string | null;
      oneTimePreKeyPublic: string | null;
    }>
  >`
    WITH picked AS (
      SELECT "id"
      FROM "DevicePrekey"
      WHERE "deviceId" = ${deviceId}
        AND "consumedAt" IS NULL
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "DevicePrekey" AS dp
    SET "consumedAt" = ${now}
    FROM picked
    WHERE dp."id" = picked."id"
    RETURNING
      dp."id",
      dp."keyId",
      dp."publicKey",
      dp."oneTimePreKeyId",
      dp."oneTimePreKeyPublic"
  `;
  const prekey = claimedRows[0];
  if (!prekey) {
    res.status(404).json({ message: "No prekeys available" });
    return;
  }

  res.json({
    deviceId,
    identityKey: device.identityPublicKey ?? device.publicKey,
    signedPreKey: device.signedPreKeyPublic
      ? {
          id: device.signedPreKeyId,
          publicKey: device.signedPreKeyPublic,
          signature: device.signedPreKeySignature,
          expiresAt: device.signedPreKeyExpiresAt,
        }
      : null,
    prekey: {
      keyId: prekey.oneTimePreKeyId ?? prekey.keyId,
      publicKey: prekey.oneTimePreKeyPublic ?? prekey.publicKey,
    },
    version: device.keyVersion,
    alg: device.keyAlg,
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

