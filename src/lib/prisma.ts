import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

/**
 * Глобальный omit: ConversationParticipant.mutedUntil («Без звука», lib/conversationMute.ts) — личная
 * настройка участника. Строки участия уходят клиентам целиком во многих местах (participants[] в списке
 * бесед, conversations:updated, треды, бот), и без omit каждый видел бы, кто из остальных заглушил беседу.
 * Поле возвращается, только если его попросили явно: select: { mutedUntil: true } или
 * omit: { mutedUntil: false } (так делают lib/conversationMute.ts и GET /api/conversations).
 *
 * Тип клиента оставлен обычным PrismaClient (без omit-дженерика): иначе он не присваивается
 * параметрам `PrismaClient | Prisma.TransactionClient` (systemBot, livekitFacts, faces). Цена — в типах
 * participant.mutedUntil есть, а в ответе Prisma его нет (undefined), пока не попросили явно.
 */
const prisma =
  global.prisma ??
  (new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
    omit: { conversationParticipant: { mutedUntil: true } },
  }) as unknown as PrismaClient);

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

export default prisma
