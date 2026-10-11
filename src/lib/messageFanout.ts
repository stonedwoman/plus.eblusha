import logger from "../config/logger";
import prisma from "./prisma";
import { extractFirstUrl } from "./linkPreview";
import { enqueueLinkPreview, enqueuePush } from "../jobs/queue";
import { getIO } from "../realtime/socket";

/**
 * Рассылка только что созданного облачного сообщения — общая для POST /conversations/send
 * (человек) и POST /api/bot/messages (бот «Еблуша», src/routes/bot.ts). Вынесено из /send без
 * изменения поведения:
 *   1. Conversation.lastMessageAt;
 *   2. message:new в комнату беседы (полный message);
 *   3. message:notify каждому участнику, кроме отправителя (комнаты user:<id>);
 *   4. пуш тем же получателям — без текста (push/types.ts);
 *   5. превью ссылки (воркер), если linkPreview не выключен и беседа не секретная.
 * Бот не участник беседы (кроме личного чата с ботом), поэтому получатели — ВСЕ участники,
 * кроме отправителя, а не «все, кроме меня» из состава беседы.
 */

const userRoom = (userId: string) => `user:${userId}`;

/** include для сообщения в ответах и событиях (отправка человеком и ботом — одинаково). */
export const SENT_MESSAGE_INCLUDE = {
  sender: { select: { id: true, username: true, displayName: true, isBot: true } },
  attachments: true,
  replyTo: { select: { id: true, content: true, senderId: true, createdAt: true, isBot: true } },
} as const;

export interface FanoutMessage {
  id: string;
  createdAt: Date | string;
  attachments?: Array<{ type?: unknown }> | null;
  sender?: { displayName?: string | null; username?: string | null } | null;
}

export async function publishNewMessage(opts: {
  conversationId: string;
  message: FanoutMessage;
  senderId: string;
  /** Секретная беседа (сюда облачные сообщения не доходят — S1; поле для пуша, как было в /send). */
  secret: boolean;
  type: string;
  content: string | null | undefined;
  /** false — не ставить превью ссылки (бот: источники в ответе карточкой не разворачиваем). */
  linkPreview?: boolean;
  /** Кому считать лимит постановки превью (rate:preview-enqueue). */
  previewUserId: string;
  /**
   * Кого будить (подмножество получателей): пуш — только им, а message:notify остальным уходит с muted: true
   * («не звени», тот же признак, что у «Без звука»). Нет — будить всех, как раньше. message:new / message:notify
   * уходят всем в любом случае (непрочитанные считаются у всех): так карточка «поделиться перепиской» будит только
   * спросившего (docs/bot-cards.md) — и на телефоне, и звуком на ПК/в вебе.
   */
  pushTo?: string[];
  /**
   * Кого это сообщение упоминает (напоминание таймера — обещавшего, metadata.bot.mentions). Сейчас ничего не меняет
   * (будятся все); при слиянии с «Без звука» (feat/chat-mute) упомянутый будится и в заглушённой беседе — как ответ
   * на его сообщение. Решение конфликта при слиянии:
   *   const wake = (rid) => (alert(rid) || mentioned.has(rid)) && (!pushSet || pushSet.has(rid));
   *   message:notify … muted: !wake(rid);   enqueuePush(recipients.filter((rid) => rid !== senderId && wake(rid)), …)
   */
  mentions?: string[];
}): Promise<void> {
  const { conversationId, message, senderId } = opts;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });

  const io = getIO();
  io?.to(conversationId).emit("message:new", {
    conversationId,
    messageId: message.id,
    senderId,
    message,
  });

  // Immediate notify event for tiles/unread without waiting for queries
  const convForNotify = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: true },
  });
  const recipients = convForNotify?.participants.map((p) => p.userId) ?? [];
  // Кого будить (пуш, звук, плашка): pushTo — только их (остальным message:notify с muted: true).
  const pushSet = opts.pushTo ? new Set(opts.pushTo) : null;
  const wake = (rid: string) => !pushSet || pushSet.has(rid);

  for (const rid of recipients) {
    if (rid !== senderId) {
      io?.to(userRoom(rid)).emit("message:notify", {
        conversationId,
        messageId: message.id,
        senderId,
        message,
        ...(pushSet ? { muted: !wake(rid) } : {}),
      });
    }
  }

  // Push-уведомление тем же получателям. Текст сообщения НЕ отправляем: он ушёл бы через
  // Google/Apple, а для секретных бесед сервер его и не должен показывать. Клиент покажет
  // имя и пометку типа, остальное подтянет сам. Ошибки здесь безопасны — enqueuePush не бросает.
  try {
    const senderName = message?.sender?.displayName || message?.sender?.username || "Сообщение";
    const attachmentKind =
      Array.isArray(message?.attachments) && message.attachments.length > 0
        ? String(message.attachments[0]?.type || "")
        : "";
    const preview =
      attachmentKind === "IMAGE"
        ? "Фото"
        : attachmentKind === "VIDEO"
          ? "Видео"
          : attachmentKind === "AUDIO"
            ? "Голосовое сообщение"
            : attachmentKind
              ? "Файл"
              : "";
    enqueuePush(
      recipients.filter((rid) => rid !== senderId && wake(rid)),
      {
        kind: "message",
        conversationId,
        messageId: message.id,
        senderId,
        senderName,
        preview,
        secret: Boolean(convForNotify?.isSecret),
        // read-sync: момент сообщения по часам сервера — Android сравнит его с readAt (push/types.ts).
        sentAt: new Date(message.createdAt).getTime(),
      },
      `msg:${message.id}`,
    );
  } catch (error) {
    // Пуш — ускоритель поверх сокета, его сбой не должен влиять на отправку сообщения.
    // Но молчать нельзя: ровно так первая версия этого блока падала незаметно.
    logger.warn({ error, conversationId }, "Failed to enqueue message push");
  }

  // Link preview (Telegram-like unfurl): enqueue job and return immediately.
  // Disabled for secret conversations to avoid metadata leaks.
  if (opts.linkPreview === false) return;
  try {
    const contentForPreview = opts.type === "TEXT" ? (opts.content ?? null) : null;
    const firstUrl = !opts.secret ? extractFirstUrl(contentForPreview) : null;
    if (firstUrl) {
      void enqueueLinkPreview(
        { messageId: message.id, conversationId, url: firstUrl },
        { userId: opts.previewUserId, conversationId },
      ).catch(() => {});
    }
  } catch {}
}
