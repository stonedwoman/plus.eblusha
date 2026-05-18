ALTER TABLE "RefreshToken"
ADD COLUMN "sessionId" TEXT,
ADD COLUMN "client" TEXT,
ADD COLUMN "deviceId" TEXT,
ADD COLUMN "replacedByToken" TEXT,
ADD COLUMN "revocationReason" TEXT;

CREATE UNIQUE INDEX "RefreshToken_replacedByToken_key" ON "RefreshToken"("replacedByToken");
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");
CREATE INDEX "RefreshToken_deviceId_idx" ON "RefreshToken"("deviceId");
CREATE INDEX "RefreshToken_userId_sessionId_idx" ON "RefreshToken"("userId", "sessionId");
