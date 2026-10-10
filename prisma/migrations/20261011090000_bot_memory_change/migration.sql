-- Журнал изменений памяти бота «Еблуша» (src/lib/systemBot.ts → botMemoryChangeOps / botMemoryStatus).
-- Удалили или поправили сообщение, которое бот мог запомнить (обращение, ответ бота, сообщение «Чата с
-- Еблушей»), — строка здесь, в той же транзакции, что само удаление/правка. Бот по журналу пересобирает
-- сводку беседы. Текста сообщений нет. Новая пустая таблица — ни блокировок, ни переписывания данных.
CREATE TABLE "BotMemoryChange" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "messageCreatedAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotMemoryChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BotMemoryChange_conversationId_createdAt_idx" ON "BotMemoryChange"("conversationId", "createdAt");
