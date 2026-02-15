import { Worker } from "bullmq";
import IORedis from "ioredis";
import env from "../../config/env";
import logger from "../../config/logger";
import prisma from "../../lib/prisma";
import type { LinkPreview } from "../../lib/linkPreview";
import { ssrfFetch } from "../../security/ssrf";
import { incCounter, setGauge } from "../../obs/metrics";
import { publishMessageUpdate } from "../../realtime/events";
import { getLinkPreviewQueueDepth, type LinkPreviewJob } from "../queue";

let workerInstance: Worker<LinkPreviewJob> | null = null;

function readMeta(html: string, attr: "property" | "name", key: string): string | null {
  const re = new RegExp(
    `<meta[^>]+${attr}\\s*=\\s*["']${escapeRegExp(key)}["'][^>]*>`,
    "ig"
  );
  const m = re.exec(html);
  if (!m) return null;
  const tag = m[0];
  const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
  return content ?? null;
}

function readTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1] ?? null;
}

function cleanText(v: string | null | undefined, maxLen: number = 300): string | null {
  if (!v) return null;
  const s = v
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function normalizeMaybeRelativeUrl(v: string | null | undefined, baseUrl: string): string | null {
  if (!v) return null;
  try {
    const u = new URL(v, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function discoverOEmbedEndpoint(baseUrl: string, html: string): string | null {
  const jsonRe =
    /<link\b(?=[^>]*\brel\s*=\s*["']alternate["'])(?=[^>]*\btype\s*=\s*["']application\/json\+oembed["'])(?=[^>]*\bhref\s*=\s*["']([^"']+)["'])[^>]*>/i;
  const href = jsonRe.exec(html)?.[1] ?? null;
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function mapOEmbedToPreview(pageUrl: string, data: any): LinkPreview | null {
  const title = typeof data?.title === "string" ? cleanText(data.title, 300) : null;
  const thumb =
    typeof data?.thumbnail_url === "string" ? cleanText(data.thumbnail_url, 2048) : null;
  const provider =
    typeof data?.provider_name === "string" ? cleanText(data.provider_name, 120) : null;
  const author =
    typeof data?.author_name === "string" ? cleanText(data.author_name, 120) : null;
  const tw = typeof data?.thumbnail_width === "number" ? data.thumbnail_width : null;
  const th = typeof data?.thumbnail_height === "number" ? data.thumbnail_height : null;

  if (!title && !thumb) return null;

  return {
    url: pageUrl,
    title,
    description: author,
    imageUrl: thumb,
    imageWidth: tw,
    imageHeight: th,
    siteName: provider,
    fetchedAtISO: new Date().toISOString(),
  };
}

async function fetchLinkPreview(urlString: string): Promise<LinkPreview | null> {
  const ua =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // 1) Fetch HTML (SSRF-guarded) and try oEmbed discovery.
  let finalUrl = urlString;
  let html: string | null = null;
  try {
    const res = await ssrfFetch(
      urlString,
      {
        method: "GET",
        headers: {
          "user-agent": ua,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      },
      {
        maxRedirects: 3,
        timeoutMs: 5_000,
        maxBodyBytes: 512 * 1024,
        allowedContentTypes: ["text/html", "application/xhtml+xml"],
      }
    );
    finalUrl = res.finalUrl;
    if (res.status >= 200 && res.status < 400) {
      html = res.body.toString("utf8");
    }
  } catch {
    html = null;
  }

  if (html) {
    const endpoint = discoverOEmbedEndpoint(finalUrl, html);
    if (endpoint) {
      try {
        const o = await ssrfFetch(
          endpoint,
          {
            method: "GET",
            headers: {
              "user-agent": "EblushaLinkPreviewWorker/1.0",
              accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
            },
          },
          {
            maxRedirects: 3,
            timeoutMs: 5_000,
            maxBodyBytes: 512 * 1024,
            allowedContentTypes: ["application/json", "text/plain"],
          }
        );
        if (o.status >= 200 && o.status < 400) {
          const data = JSON.parse(o.body.toString("utf8"));
          const mapped = mapOEmbedToPreview(finalUrl, data);
          if (mapped) return mapped;
        }
      } catch {
        // ignore and fallback to OG parsing
      }
    }
  }

  // 2) Fallback: OG/Twitter meta
  if (!html) return null;
  const ogTitle =
    readMeta(html, "property", "og:title") ??
    readMeta(html, "name", "twitter:title") ??
    readMeta(html, "name", "title");
  const ogDesc =
    readMeta(html, "property", "og:description") ??
    readMeta(html, "name", "twitter:description") ??
    readMeta(html, "name", "description");
  const ogImage =
    readMeta(html, "property", "og:image") ?? readMeta(html, "name", "twitter:image");
  const ogSite = readMeta(html, "property", "og:site_name");
  const titleTag = readTitle(html);

  const title = cleanText(ogTitle ?? titleTag);
  const description = cleanText(ogDesc, 300);
  const imageUrl = normalizeMaybeRelativeUrl(ogImage, finalUrl);
  const siteName =
    cleanText(ogSite, 120) ??
    (() => {
      try {
        return new URL(finalUrl).hostname;
      } catch {
        return null;
      }
    })();

  if (!title && !description && !imageUrl) return null;
  return {
    url: finalUrl,
    title,
    description,
    imageUrl,
    imageWidth: null,
    imageHeight: null,
    siteName,
    fetchedAtISO: new Date().toISOString(),
  };
}

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

