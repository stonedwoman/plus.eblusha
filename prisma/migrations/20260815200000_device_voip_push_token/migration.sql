-- Отдельный слот под VoIP-токен iOS. PushKit выдаёт свой токен, независимый от токена
-- обычных уведомлений, и нужны ОБА одновременно: alert показывает уведомление о
-- сообщении, VoIP поднимает убитое приложение под звонок (иначе CallKit не успеть).
-- У Android поле пустует — там один FCM-токен на всё.
ALTER TABLE "UserDevice" ADD COLUMN IF NOT EXISTS "pushVoipToken" TEXT;
ALTER TABLE "UserDevice" ADD COLUMN IF NOT EXISTS "pushVoipUpdatedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "UserDevice_pushVoipToken_idx" ON "UserDevice"("pushVoipToken");
