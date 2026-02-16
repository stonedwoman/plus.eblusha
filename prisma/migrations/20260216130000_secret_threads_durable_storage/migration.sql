-- Conversation.type (cloud|secret)
DO $$ BEGIN
  CREATE TYPE "ConversationType" AS ENUM ('CLOUD', 'SECRET');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Conversation"
ADD COLUMN IF NOT EXISTS "type" "ConversationType" NOT NULL DEFAULT 'CLOUD';

-- Backfill: existing secret conversations become type=SECRET
UPDATE "Conversation" SET "type" = 'SECRET' WHERE "isSecret" = true;

-- Durable ciphertext storage for secret threads
DO $$ BEGIN
  CREATE TYPE "SecretDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'READ');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "messages_secret" (
  "msgId" UUID NOT NULL,
  "threadId" TEXT,
  "senderUserId" TEXT NOT NULL,
  "senderDeviceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "headerJson" JSONB NOT NULL,
  "ciphertextBlob" BYTEA NOT NULL,
  "contentType" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "messages_secret_pkey" PRIMARY KEY ("msgId")
);

CREATE INDEX IF NOT EXISTS "messages_secret_threadId_createdAt_idx"
ON "messages_secret" ("threadId", "createdAt");

CREATE INDEX IF NOT EXISTS "messages_secret_senderUserId_createdAt_idx"
ON "messages_secret" ("senderUserId", "createdAt");

CREATE TABLE IF NOT EXISTS "deliveries_secret" (
  "msgId" UUID NOT NULL,
  "receiverDeviceId" TEXT NOT NULL,
  "status" "SecretDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),

  CONSTRAINT "deliveries_secret_pkey" PRIMARY KEY ("msgId", "receiverDeviceId"),
  CONSTRAINT "deliveries_secret_msgId_fkey" FOREIGN KEY ("msgId")
    REFERENCES "messages_secret" ("msgId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "deliveries_secret_receiverDeviceId_status_idx"
ON "deliveries_secret" ("receiverDeviceId", "status");

-- Device pairing tokens
CREATE TABLE IF NOT EXISTS "device_pairings" (
  "token" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "newDeviceId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumedByDeviceId" TEXT,

  CONSTRAINT "device_pairings_pkey" PRIMARY KEY ("token")
);

CREATE INDEX IF NOT EXISTS "device_pairings_userId_expiresAt_idx"
ON "device_pairings" ("userId", "expiresAt");

CREATE INDEX IF NOT EXISTS "device_pairings_newDeviceId_expiresAt_idx"
ON "device_pairings" ("newDeviceId", "expiresAt");

