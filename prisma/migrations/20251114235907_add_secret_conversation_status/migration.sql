-- CreateEnum
CREATE TYPE "SecretConversationStatus" AS ENUM ('ACTIVE', 'PENDING', 'CANCELLED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "secretInitiatorDeviceId" TEXT,
ADD COLUMN     "secretPeerDeviceId" TEXT,
ADD COLUMN     "secretStatus" "SecretConversationStatus" NOT NULL DEFAULT 'ACTIVE';
