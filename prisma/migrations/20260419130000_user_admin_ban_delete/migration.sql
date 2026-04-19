-- Admin ban/delete fields on User. Both are nullable timestamps + free-form reason.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "bannedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bannedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "deletedAt"    TIMESTAMP(3);

-- Lookups by ban/delete status (admin filters + auth gate are read-heavy).
CREATE INDEX IF NOT EXISTS "User_bannedAt_idx"  ON "User" ("bannedAt");
CREATE INDEX IF NOT EXISTS "User_deletedAt_idx" ON "User" ("deletedAt");
