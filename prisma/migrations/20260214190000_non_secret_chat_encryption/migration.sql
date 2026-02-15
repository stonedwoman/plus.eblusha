-- Add per-conversation wrapped DEK for non-secret chat encryption
ALTER TABLE "Conversation"
ADD COLUMN "nonSecretDekWrapped" TEXT;

-- Add message content encryption version
ALTER TABLE "Message"
ADD COLUMN "contentEncV" INTEGER NOT NULL DEFAULT 0;

