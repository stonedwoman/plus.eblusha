-- Карточки бота «Еблуша» (src/lib/botCards.ts, docs/bot-cards.md): таймер обещания (PromiseTimer) и согласие
-- «поделиться перепиской» (BotShare). Только новые типы и таблицы — без блокировок и переписывания данных; откат
-- сервера безопасен (таблицы просто не читаются). Текстов переписки здесь нет.
-- CreateEnum
CREATE TYPE "PromiseStatus" AS ENUM ('RUNNING', 'ARRIVED', 'CANCELLED', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "BotShareStatus" AS ENUM ('PENDING', 'GRANTED', 'DECLINED', 'EXPIRED', 'REVOKED', 'ENDED');

-- CreateTable
CREATE TABLE "PromiseTimer" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "conversationId" TEXT NOT NULL,
    "cardMessageId" TEXT,
    "promiseMessageId" TEXT,
    "triggerMessageId" TEXT NOT NULL,
    "promiserId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "cancelAllowedIds" TEXT[],
    "quote" TEXT,
    "quoteById" TEXT,
    "quoteAt" TIMESTAMP(3),
    "label" TEXT NOT NULL,
    "upperBound" BOOLEAN NOT NULL DEFAULT false,
    "parseSource" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "zoneSource" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "originalDeadlineAt" TIMESTAMP(3) NOT NULL,
    "extensions" JSONB NOT NULL DEFAULT '[]',
    "extensionCount" INTEGER NOT NULL DEFAULT 0,
    "status" "PromiseStatus" NOT NULL DEFAULT 'RUNNING',
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "arrivedAt" TIMESTAMP(3),
    "arrivedVia" TEXT,
    "arrivedById" TEXT,
    "arrivedDetail" TEXT,
    "cancelledById" TEXT,
    "lateSec" INTEGER,
    "lateVsOriginalSec" INTEGER,
    "remindersSent" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "remindersTotal" INTEGER NOT NULL DEFAULT 0,
    "createdLate" BOOLEAN NOT NULL DEFAULT false,
    "reopenUntil" TIMESTAMP(3),
    "reopenBy" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reopenPrev" JSONB,
    "rev" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PromiseTimer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotShare" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "conversationId" TEXT NOT NULL,
    "cardMessageId" TEXT,
    "triggerMessageId" TEXT NOT NULL,
    "askerId" TEXT NOT NULL,
    "status" "BotShareStatus" NOT NULL DEFAULT 'PENDING',
    "zone" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "suggestPeriod" TEXT,
    "suggestPhotos" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "period" TEXT,
    "includePhotos" BOOLEAN NOT NULL DEFAULT false,
    "periodFrom" TIMESTAMP(3),
    "pendingUntil" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "until" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "endedById" TEXT,
    "answerMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "answers" INTEGER NOT NULL DEFAULT 0,
    "readMessages" INTEGER,
    "readPhotos" INTEGER,
    "usd" DECIMAL(8,4),
    "rev" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BotShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromiseTimer_cardMessageId_key" ON "PromiseTimer"("cardMessageId");

-- CreateIndex
CREATE INDEX "PromiseTimer_conversationId_status_idx" ON "PromiseTimer"("conversationId", "status");

-- CreateIndex
CREATE INDEX "PromiseTimer_promiserId_status_createdAt_idx" ON "PromiseTimer"("promiserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PromiseTimer_status_deadlineAt_idx" ON "PromiseTimer"("status", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "BotShare_cardMessageId_key" ON "BotShare"("cardMessageId");

-- CreateIndex
CREATE INDEX "BotShare_conversationId_status_idx" ON "BotShare"("conversationId", "status");

-- CreateIndex
CREATE INDEX "BotShare_askerId_createdAt_idx" ON "BotShare"("askerId", "createdAt");

-- CreateIndex
CREATE INDEX "BotShare_status_until_idx" ON "BotShare"("status", "until");

-- AddForeignKey
ALTER TABLE "PromiseTimer" ADD CONSTRAINT "PromiseTimer_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotShare" ADD CONSTRAINT "BotShare_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
