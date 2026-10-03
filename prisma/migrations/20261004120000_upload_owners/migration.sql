-- S7 (X1): кто загрузил объект хранилища через /api/upload. По этой записи
-- /secret/attachments/ref, авто-реф в /secret/messages/push и /secret/attachments/delete
-- пускают только загрузившего (см. src/lib/uploadOwners.ts). Объекты, загруженные раньше,
-- записи не имеют — для них действует переходный режим «нет записи = разрешить».
CREATE TABLE "upload_owners" (
    "objectKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_owners_pkey" PRIMARY KEY ("objectKey")
);

CREATE INDEX "upload_owners_userId_createdAt_idx" ON "upload_owners"("userId", "createdAt");
