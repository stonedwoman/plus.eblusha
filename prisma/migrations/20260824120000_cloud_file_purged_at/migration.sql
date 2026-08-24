-- Безвозвратное удаление отделено от корзины.
-- Раньше «удалить навсегда» ставило deletedAt в эпоху (1970), и файл
-- возвращался обычной кнопкой «Восстановить»: пользователь думал, что стёр
-- снимок насовсем, а тот лежал в корзине и восстанавливался одним кликом.
ALTER TABLE "CloudFile" ADD COLUMN "purgedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CloudFile_purgedAt_idx" ON "CloudFile"("purgedAt");

-- Файлы, уже помеченные старым способом (deletedAt в эпохе), переводим
-- на новый признак, чтобы уборка их забрала, а корзина больше не показывала.
UPDATE "CloudFile" SET "purgedAt" = "deletedAt" WHERE "deletedAt" < '1990-01-01';
