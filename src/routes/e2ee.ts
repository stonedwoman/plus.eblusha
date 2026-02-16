import { Router, type Request } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rateLimit";

const router = Router();
router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string } };

// GET /e2ee/prekeys/bundles?userId=...
router.get("/prekeys/bundles", async (req, res) => {
  const schema = z.object({ userId: z.string().min(1) });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid query" });
    return;
  }
  const { userId } = parsed.data;
  const devices = await prisma.userDevice.findMany({
    where: { userId, revokedAt: null },
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

// POST /e2ee/prekeys/claim { deviceId }
router.post(
  "/prekeys/claim",
  rateLimit({ name: "e2ee_prekeys_claim", windowMs: 60_000, max: 60 }),
  async (req, res) => {
    const claimSchema = z.object({ deviceId: z.string().min(8) });
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid claim payload" });
      return;
    }
    const { deviceId } = parsed.data;
    const device = await prisma.userDevice.findUnique({ where: { id: deviceId } });
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

// Small helper endpoint: return whoami for debugging multi-device flows (auth required).
router.get("/whoami", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  res.json({ userId });
});

export default router;

