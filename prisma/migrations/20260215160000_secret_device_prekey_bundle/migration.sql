-- AlterTable
ALTER TABLE "UserDevice"
ADD COLUMN "identityPublicKey" TEXT,
ADD COLUMN "signedPreKeyId" TEXT,
ADD COLUMN "signedPreKeyPublic" TEXT,
ADD COLUMN "signedPreKeySignature" TEXT,
ADD COLUMN "signedPreKeyExpiresAt" TIMESTAMP(3),
ADD COLUMN "keyVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "keyAlg" TEXT NOT NULL DEFAULT 'x25519+ed25519';

-- Backfill identity key for existing rows
UPDATE "UserDevice" SET "identityPublicKey" = "publicKey" WHERE "identityPublicKey" IS NULL;

-- AlterTable
ALTER TABLE "DevicePrekey"
ADD COLUMN "oneTimePreKeyId" TEXT,
ADD COLUMN "oneTimePreKeyPublic" TEXT,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "alg" TEXT NOT NULL DEFAULT 'x25519';

-- Backfill one-time fields for existing prekeys
UPDATE "DevicePrekey"
SET
  "oneTimePreKeyId" = "keyId",
  "oneTimePreKeyPublic" = "publicKey"
WHERE
  "oneTimePreKeyId" IS NULL
  OR "oneTimePreKeyPublic" IS NULL;
