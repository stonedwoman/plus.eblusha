-- Keep oldest-unconsumed prekey lookup fast for claim/bundle flows.
CREATE INDEX IF NOT EXISTS "DevicePrekey_unconsumed_deviceId_createdAt_idx"
ON "DevicePrekey"("deviceId", "createdAt")
WHERE "consumedAt" IS NULL;

-- Make cleanup of consumed prekeys cheaper for maintenance GC.
CREATE INDEX IF NOT EXISTS "DevicePrekey_consumedAt_idx"
ON "DevicePrekey"("consumedAt")
WHERE "consumedAt" IS NOT NULL;
