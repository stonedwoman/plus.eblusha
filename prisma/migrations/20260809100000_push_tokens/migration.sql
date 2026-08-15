-- Push-токены устройств: FCM сейчас, APNs позже. Поля необязательные — устройство без
-- уведомлений продолжает работать через постоянный сокет, как и раньше.
ALTER TABLE "UserDevice" ADD COLUMN IF NOT EXISTS "pushToken" TEXT;
ALTER TABLE "UserDevice" ADD COLUMN IF NOT EXISTS "pushProvider" TEXT;
ALTER TABLE "UserDevice" ADD COLUMN IF NOT EXISTS "pushUpdatedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "UserDevice_pushToken_idx" ON "UserDevice"("pushToken");
