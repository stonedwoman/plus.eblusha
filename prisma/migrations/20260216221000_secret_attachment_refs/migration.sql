-- Secret attachment refs (metadata-only, no plaintext keys/content)
CREATE TABLE IF NOT EXISTS "secret_attachment_refs" (
  "id" TEXT PRIMARY KEY,
  "threadId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "secret_attachment_refs_threadId_objectKey_key"
  ON "secret_attachment_refs" ("threadId", "objectKey");

CREATE INDEX IF NOT EXISTS "secret_attachment_refs_threadId_deletedAt_idx"
  ON "secret_attachment_refs" ("threadId", "deletedAt");

CREATE INDEX IF NOT EXISTS "secret_attachment_refs_ownerUserId_deletedAt_idx"
  ON "secret_attachment_refs" ("ownerUserId", "deletedAt");

CREATE INDEX IF NOT EXISTS "secret_attachment_refs_expiresAt_deletedAt_idx"
  ON "secret_attachment_refs" ("expiresAt", "deletedAt");

