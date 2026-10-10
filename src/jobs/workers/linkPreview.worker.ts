import { Worker } from "bullmq";
import IORedis from "ioredis";
import env from "../../config/env";
import logger from "../../config/logger";
import prisma from "../../lib/prisma";
import { isSecretConversation } from "../../lib/secretLatch";
import { incCounter, setGauge } from "../../obs/metrics";
import { publishMessageUpdate } from "../../realtime/events";
import { getLinkPreviewQueueDepth, type LinkPreviewJob } from "../queue";
import { fetchLinkPreview } from "./linkPreview.fetchers";

/**
 * Дописать ключи превью в ТЕКУЩУЮ metadata сообщения одним UPDATE (jsonb ||), только у неудалённого. Превью
 * качается секундами — за это время сообщение могли поправить (правка снимает metadata.botAsk у «Еблуша, …»,
 * исправленного в текст для людей, и ставит editedAt) или удалить; запись прочитанной до скачивания копии
 * вернула бы botAsk (текст для людей снова попал бы в память бота) и стёрла бы editedAt (находка ревью).
 * Возвращает, сколько строк обновлено (0 — сообщения нет или оно удалено).
 */
export async function mergeLinkPreviewMetadata(messageId: string, patch: Record<string, unknown>): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "Message"
       SET "metadata" = (CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata" ELSE '{}'::jsonb END)
                        || ${JSON.stringify(patch)}::jsonb
     WHERE "id" = ${messageId}
       AND "deletedAt" IS NULL`;
}

let workerInstance: Worker<LinkPreviewJob> | null = null;
export function startLinkPreviewWorker() {
  if (workerInstance) return workerInstance;

  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  workerInstance = new Worker<LinkPreviewJob>(
    "linkPreview",
    async (job) => {
      const { messageId, conversationId, url } = job.data;

      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { id: true, conversationId: true, type: true, content: true, metadata: true },
      });
      if (!message) return { skipped: "not_found" };
      if (message.conversationId !== conversationId) return { skipped: "conversation_mismatch" };
      if (message.type !== "TEXT" || typeof message.content !== "string") return { skipped: "not_text" };

      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { type: true, isSecret: true },
      });
      // В секретной беседе (любой статус) облачную строку не трогаем (S1, lib/secretLatch).
      if (!conv || isSecretConversation(conv)) return { skipped: "secret_disabled" };

      const meta =
        message.metadata && typeof message.metadata === "object"
          ? (message.metadata as Record<string, unknown>)
          : {};
      if ((meta as any)?.linkPreview) return { skipped: "already_has_preview" };

      const preview = await fetchLinkPreview(url);
      const nowISO = new Date().toISOString();
      const patch: Record<string, unknown> = {
        linkPreviewAttemptedAt: nowISO,
        linkPreviewUrl: url,
        ...(preview ? { linkPreview: preview } : {}),
      };

      // Не перезаписываем metadata копией, прочитанной до скачивания, — дописываем ключи превью в текущую.
      if ((await mergeLinkPreviewMetadata(messageId, patch)) === 0) return { skipped: "gone" };

      const updated = await prisma.message.findUniqueOrThrow({
        where: { id: messageId },
        include: {
          sender: { select: { id: true, username: true, displayName: true, isBot: true } },
          attachments: true,
          reactions: {
            include: { user: { select: { id: true, username: true, displayName: true, isBot: true } } },
          },
          receipts: true,
          replyTo: { select: { id: true, content: true, senderId: true, createdAt: true, isBot: true } },
        },
      });

      if (preview) incCounter("link_preview_success", 1);
      else incCounter("link_preview_fail", 1);

      await publishMessageUpdate({
        conversationId,
        messageId,
        reason: "link_preview",
        message: updated,
      });

      return { ok: true, preview: !!preview };
    },
    { connection, concurrency: 4 }
  );

  workerInstance.on("completed", async () => {
    try {
      const depth = await getLinkPreviewQueueDepth();
      setGauge("queue_link_preview_depth", depth);
    } catch {}
  });
  workerInstance.on("failed", (job, err) => {
    logger.warn({ err, jobId: job?.id }, "linkPreview job failed");
    incCounter("link_preview_fail", 1);
  });

  return workerInstance;
}

