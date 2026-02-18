import { Router, type Request } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rateLimit";
import crypto from "crypto";
import { kickDevice } from "../realtime/socket";

const router = Router();

router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string }; deviceId?: string };

async function resolveCurrentDeviceId(req: Request): Promise<string | null> {
  const r = req as AuthedRequest;
  const candidate =
    (r.deviceId?.trim() ||
      (typeof (req.headers["x-device-id"] as any) === "string" ? String(req.headers["x-device-id"]).trim() : "") ||
      (typeof (req.query as any)?.deviceId === "string" ? String((req.query as any).deviceId).trim() : "") ||
      (typeof (req.body as any)?.deviceId === "string" ? String((req.body as any).deviceId).trim() : "")) || "";
  if (!candidate) return null;
  const device = await prisma.userDevice.findUnique({
    where: { id: candidate },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!device || device.userId !== r.user?.id || device.revokedAt) return null;
  return device.id;
}

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
  try {
    kickDevice(deviceId, { reason: "revoked" });
  } catch {
    // ignore
  }
  res.json({ success: true });
});

router.post("/revoke-others", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  const currentDeviceId = await resolveCurrentDeviceId(req);
  const others = await prisma.userDevice.findMany({
    where: {
      userId,
      revokedAt: null,
      ...(currentDeviceId ? { id: { not: currentDeviceId } } : {}),
    },
    select: { id: true },
  });
  for (const row of others) {
    await prisma.userDevice.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    try {
      kickDevice(row.id, { reason: "revoked" });
    } catch {
      // ignore
    }
  }
  res.json({ success: true });
});

// Pairing flow (Link device)
const PAIRING_TTL_MS = 5 * 60 * 1000;

router.post(
  "/pairing/start",
  rateLimit({ name: "device_pairing_start", windowMs: 60_000, max: 20 }),
  async (req, res) => {
    const userId = (req as AuthedRequest).user!.id;
    const currentDeviceId = await resolveCurrentDeviceId(req);
    if (!currentDeviceId) {
      res.status(400).json({ message: "Current device is required (token did claim)" });
      return;
    }
    const now = Date.now();
    const expiresAt = new Date(now + PAIRING_TTL_MS);
    const token = crypto.randomBytes(32).toString("base64url");
    const code = crypto.randomBytes(5).toString("hex").toUpperCase(); // 10 chars fallback

    await prisma.devicePairing.create({
      data: {
        token,
        userId,
        newDeviceId: currentDeviceId,
        code,
        expiresAt,
      },
    });

    res.json({
      token,
      code,
      newDeviceId: currentDeviceId,
      expiresAt: expiresAt.toISOString(),
    });
  }
);

router.post(
  "/pairing/resolve",
  rateLimit({ name: "device_pairing_resolve", windowMs: 60_000, max: 60 }),
  async (req, res) => {
    const userId = (req as AuthedRequest).user!.id;
    const schema = z.object({
      token: z.string().min(8).optional(),
      code: z.string().min(6).max(16).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid payload" });
      return;
    }
    const token = parsed.data.token?.trim() || null;
    const code = parsed.data.code?.trim().toUpperCase() || null;
    if (!token && !code) {
      res.status(400).json({ message: "token or code is required" });
      return;
    }
    const now = new Date();
    const pairing = await prisma.devicePairing.findFirst({
      where: {
        userId,
        consumedAt: null,
        expiresAt: { gt: now },
        ...(token ? { token } : {}),
        ...(code ? { code } : {}),
      },
    });
    if (!pairing) {
      res.status(404).json({ message: "Pairing request not found or expired" });
      return;
    }
    const device = await prisma.userDevice.findUnique({
      where: { id: pairing.newDeviceId },
      select: { id: true, name: true, platform: true, publicKey: true, identityPublicKey: true, createdAt: true },
    });
    if (!device) {
      res.status(404).json({ message: "Target device not found" });
      return;
    }
    res.json({
      token: pairing.token,
      code: pairing.code,
      newDevice: {
        id: device.id,
        name: device.name,
        platform: device.platform,
        identityPublicKey: device.identityPublicKey ?? device.publicKey,
        createdAt: device.createdAt.toISOString(),
      },
      expiresAt: pairing.expiresAt.toISOString(),
    });
  }
);

router.post(
  "/pairing/consume",
  rateLimit({ name: "device_pairing_consume", windowMs: 60_000, max: 60 }),
  async (req, res) => {
    const userId = (req as AuthedRequest).user!.id;
    const currentDeviceId = await resolveCurrentDeviceId(req);
    if (!currentDeviceId) {
      res.status(400).json({ message: "Current device is required (token did claim)" });
      return;
    }
    const schema = z.object({ token: z.string().min(8) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid payload" });
      return;
    }
    const token = parsed.data.token.trim();
    const now = new Date();
    const pairing = await prisma.devicePairing.findUnique({ where: { token } });
    if (!pairing || pairing.userId !== userId || pairing.consumedAt || pairing.expiresAt <= now) {
      res.status(404).json({ message: "Pairing request not found or expired" });
      return;
    }
    await prisma.devicePairing.update({
      where: { token },
      data: { consumedAt: now, consumedByDeviceId: currentDeviceId },
    });
    res.json({ success: true });
  }
);

export default router;

