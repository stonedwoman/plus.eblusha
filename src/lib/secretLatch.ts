import type { Response } from "express";
import prisma from "./prisma";
import logger from "../config/logger";

/**
 * S1 — защёлка открытого текста для секретных бесед.
 *
 * В секретной беседе сервер хранит только шифротекст (`messages_secret`, канал /secret/*).
 * Облачная строка `Message` там — это открытый текст на сервере: её не должен создавать
 * и менять НИ ОДИН путь (HTTP-отправка/правка/реакции/удаление, пересылка, сокетные
 * системные записи о звонках, «покинул беседу»).
 *
 * Секретной считаем беседу, если `type === "SECRET"` (V2-тред) ИЛИ `isSecret === true`
 * (легаси-ветка POST /conversations создаёт `isSecret:true` при `type=CLOUD`; такой
 * беседе облачный канал тоже закрыт — у легаси-клиентов он шёл открытым текстом).
 *
 * Системные записи сервера (звонок начат/завершён/пропущен, участник вышел) в секретных
 * беседах тоже НЕ пишутся: клиенты рисуют секретку только из /secret/history, облачная
 * запись в ней видна лишь как превью/счётчик непрочитанного в списке чатов, а хранит
 * открытые метаданные (имена, время и длительность звонков) в «секретной» беседе.
 * Инвариант «облачных Message в секретках — 0» так остаётся проверяемым одним SELECT.
 */

export const SECRET_E2EE_ONLY_CODE = "SECRET_E2EE_ONLY";
export const SECRET_E2EE_ONLY_MESSAGE = "Secret conversations accept only end-to-end encrypted messages";

export type SecretLikeConversation = { type?: unknown; isSecret?: unknown } | null | undefined;

export function isSecretConversation(conv: SecretLikeConversation): boolean {
  if (!conv) return false;
  return conv.type === "SECRET" || conv.isSecret === true;
}

/**
 * Можно ли писать облачное `Message` в эту беседу.
 * `conv` — уже загруженная беседа (если есть под рукой), иначе читаем по id.
 * Fail-closed: беседа не найдена или чтение упало → false (запись не делаем).
 */
export async function cloudMessageWritesAllowed(
  conversationId: string,
  conv?: SecretLikeConversation,
): Promise<boolean> {
  if (conv) return !isSecretConversation(conv);
  try {
    const row = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true, isSecret: true },
    });
    if (!row) return false;
    return !isSecretConversation(row);
  } catch (error) {
    logger.warn({ error, conversationId }, "secret-latch: conversation lookup failed, cloud write skipped");
    return false;
  }
}

export function rejectSecretCloudWrite(res: Response): void {
  res.status(409).json({ message: SECRET_E2EE_ONLY_MESSAGE, code: SECRET_E2EE_ONLY_CODE });
}

/** Лог отбитой попытки: только метаданные (кто/куда/какой путь), без содержимого. */
export function logSecretCloudWriteBlocked(path: string, fields: { conversationId: string; userId?: string; messageId?: string }) {
  logger.warn({ path, ...fields }, "secret-latch: cloud message write into secret conversation blocked");
}
