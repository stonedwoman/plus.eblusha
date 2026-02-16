import { Worker } from "bullmq";
import IORedis from "ioredis";
import env from "../../config/env";
import logger from "../../config/logger";
import prisma from "../../lib/prisma";
import { incCounter, setGauge } from "../../obs/metrics";
import { publishMessageUpdate } from "../../realtime/events";
import { getLinkPreviewQueueDepth, type LinkPreviewJob } from "../queue";
import { fetchLinkPreview } from "./linkPreview.fetchers";

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
        select: { isSecret: true, secretStatus: true },
      });
      const isSecret = Boolean((conv as any)?.isSecret) && (conv as any)?.secretStatus !== "CANCELLED";
      if (isSecret) return { skipped: "secret_disabled" };

      const meta =
        message.metadata && typeof message.metadata === "object"
          ? (message.metadata as Record<string, unknown>)
          : {};
      if ((meta as any)?.linkPreview) return { skipped: "already_has_preview" };

      const preview = await fetchLinkPreview(url);
      const nowISO = new Date().toISOString();
      const nextMeta: any = {
        ...(meta && typeof meta === "object" ? meta : {}),
        linkPreviewAttemptedAt: nowISO,
        linkPreviewUrl: url,
        ...(preview ? { linkPreview: preview } : {}),
      };

      const updated = await prisma.message.update({
        where: { id: messageId },
        data: { metadata: nextMeta as any },
        include: {
          sender: { select: { id: true, username: true, displayName: true } },
          attachments: true,
          reactions: true,
          receipts: true,
          replyTo: { select: { id: true, content: true, senderId: true, createdAt: true } },
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

