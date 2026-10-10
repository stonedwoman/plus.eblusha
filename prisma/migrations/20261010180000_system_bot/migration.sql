-- Бот «Еблуша» — часть системы (src/lib/systemBot.ts, src/routes/bot.ts).
-- User.isBot: системный бот. Ставит src/scripts/seedBotUser.ts / setupSystemBot.ts, через API не меняется.
-- Message.isBot: сообщение от бота (пишет только POST /api/bot/messages). Клиенты рисуют «бот»
-- (оранжевая полоса, «Б», подпись) по этому полю, а не по metadata, которую задаёт отправитель.
-- Оба столбца с константным DEFAULT: в PostgreSQL 11+ это правка каталога, таблица не переписывается.
ALTER TABLE "User" ADD COLUMN "isBot" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "isBot" BOOLEAN NOT NULL DEFAULT false;
