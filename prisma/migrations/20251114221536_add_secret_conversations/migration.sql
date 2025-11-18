/*
  Warnings:

  - A unique constraint covering the columns `[eblid]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "isSecret" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "secretTtlSeconds" INTEGER;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "eblid" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_eblid_key" ON "User"("eblid");
