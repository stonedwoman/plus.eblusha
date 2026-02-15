-- Speed up non-secret message encryption backfill
CREATE INDEX IF NOT EXISTS "Message_conversationId_contentEncV_idx"
ON "Message" ("conversationId", "contentEncV");

