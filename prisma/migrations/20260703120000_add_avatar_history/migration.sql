-- Avatar history: past avatar URLs kept when the user changes their picture.
-- Postgres TEXT[] with a non-null empty-array default (safe, non-blocking add on PG11+).
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "avatarHistory" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
