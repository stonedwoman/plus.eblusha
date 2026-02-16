import logger from "../../config/logger";
import type { LinkPreview } from "../../lib/linkPreview";
import { extractYouTubeVideoId, isYouTubeUrl } from "../../lib/youtube";
import { ssrfFetch, type SsrfFetchOptions } from "../../security/ssrf";

type SsrfFetchLike = typeof ssrfFetch;

const SSRF_MAX_REDIRECTS = 3;
const SSRF_TIMEOUT_MS = 5_000;
const SSRF_MAX_BODY_BYTES = 512 * 1024;
const SSRF_MAX_JSON_BODY_BYTES = 256 * 1024;

const YOUTUBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const youtubeCache = new Map<string, { value: LinkPreview | null; expiresAt: number }>();
const youtubeInflight = new Map<string, Promise<LinkPreview | null>>();

const YOUTUBE_ALLOWED_HOSTNAMES = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtu.be",
  "www.googleapis.com",
]);

function assertHostnameAllowlisted(u: URL, allowlist: ReadonlySet<string>, label: string) {
  const host = (u.hostname || "").trim().toLowerCase();
  if (!allowlist.has(host)) {
    throw new Error(`${label}_hostname_not_allowed`);
  }
}

function readYouTubeApiKey(): string | null {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function ssrfFetchJson(
  ssrfFetchImpl: SsrfFetchLike,
  urlString: string,
  init: RequestInit,
  opts: SsrfFetchOptions
): Promise<{ finalUrl: string; status: number; headers: Headers; body: Buffer; json: any }> {
  const res = await ssrfFetchImpl(urlString, init, {
    maxRedirects: SSRF_MAX_REDIRECTS,
    timeoutMs: SSRF_TIMEOUT_MS,
    maxBodyBytes: SSRF_MAX_JSON_BODY_BYTES,
    allowedContentTypes: ["application/json", "text/plain"],
    ...opts,
  });
  const text = res.body.toString("utf8");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ...res, json };
}

function parseYouTubeApiError(data: any): { reason: string | null; message: string | null } {
  const reason =
    typeof data?.error?.errors?.[0]?.reason === "string" ? data.error.errors[0].reason : null;
  const message = typeof data?.error?.message === "string" ? data.error.message : null;
  return { reason, message };
}

function formatYouTubeDuration(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(iso);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = m[2] ? Number(m[2]) : 0;
  const s = m[3] ? Number(m[3]) : 0;
  if (![h, min, s].every((n) => Number.isFinite(n) && n >= 0)) return null;
  if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${min}:${String(s).padStart(2, "0")}`;
}

async function fetchYouTubeApiPreview(
  ssrfFetchImpl: SsrfFetchLike,
  originalUrl: string,
  videoId: string
): Promise<LinkPreview | null> {
  const apiKey = readYouTubeApiKey();
  if (!apiKey) {
    logger.warn({ videoId }, "YouTube preview: YOUTUBE_API_KEY is missing, using fallback");
    return null;
  }

  const endpoint = new URL("https://www.googleapis.com/youtube/v3/videos");
  endpoint.searchParams.set("part", "snippet,contentDetails,status");
  endpoint.searchParams.set("id", videoId);
  endpoint.searchParams.set("key", apiKey);
  assertHostnameAllowlisted(endpoint, YOUTUBE_ALLOWED_HOSTNAMES, "youtube");

  let res: { status: number; json: any } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await ssrfFetchJson(
        ssrfFetchImpl,
        endpoint.toString(),
        {
          method: "GET",
          headers: {
            "user-agent": "EblushaLinkPreviewWorker/1.0",
            accept: "application/json",
          },
        },
        {
          allowedContentTypes: ["application/json"],
        }
      );
      res = r;
      if (r.status >= 500 && attempt === 0) continue;
      break;
    } catch (err) {
      if (attempt === 0) continue;
      logger.warn({ err, videoId }, "YouTube Data API request failed after retry");
      return null;
    }
  }

  if (!res) return null;
  if (res.status < 200 || res.status >= 300) {
    const parsed = parseYouTubeApiError(res.json);
    if (res.status === 403 || res.status === 429) {
      logger.warn(
        { status: res.status, videoId, reason: parsed.reason, message: parsed.message },
        "YouTube Data API rejected request (quota/key/rate-limit)"
      );
    } else {
      logger.warn(
        { status: res.status, videoId, reason: parsed.reason, message: parsed.message },
        "YouTube Data API returned non-ok response"
      );
    }
    return null;
  }

  const data = res.json;
  const item = Array.isArray(data?.items) && data.items.length > 0 ? data.items[0] : null;
  const snippet = item?.snippet;
  if (!snippet || typeof snippet !== "object") return null;

  const thumbnails =
    snippet?.thumbnails && typeof snippet.thumbnails === "object" ? snippet.thumbnails : null;
  const pick =
    thumbnails?.maxres ??
    thumbnails?.standard ??
    thumbnails?.high ??
    thumbnails?.medium ??
    thumbnails?.default ??
    null;

  const title = typeof snippet.title === "string" ? snippet.title.trim() : "";
  const descriptionRaw = typeof snippet.description === "string" ? snippet.description.trim() : "";
  const channelTitle = typeof snippet.channelTitle === "string" ? snippet.channelTitle.trim() : "";
  const durationIso =
    typeof item?.contentDetails?.duration === "string" ? item.contentDetails.duration : null;
  const durationText = formatYouTubeDuration(durationIso);

  if (!title && !descriptionRaw && !pick?.url) return null;
  return {
    url: originalUrl,
    title: title || "YouTube",
    description: descriptionRaw ? descriptionRaw.slice(0, 200) : channelTitle || null,
    imageUrl:
      typeof pick?.url === "string" && pick.url.trim()
        ? pick.url.trim()
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    imageWidth: typeof pick?.width === "number" ? pick.width : 480,
    imageHeight: typeof pick?.height === "number" ? pick.height : 360,
    siteName: "YouTube",
    youtube: {
      videoId,
      channelTitle: channelTitle || null,
      durationIso,
      durationText,
      viewCount: null,
    },
    fetchedAtISO: new Date().toISOString(),
  };
}

async function fetchYouTubeOEmbedPreview(
  ssrfFetchImpl: SsrfFetchLike,
  originalUrl: string,
  videoId: string
): Promise<LinkPreview | null> {
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("url", originalUrl);
  assertHostnameAllowlisted(endpoint, YOUTUBE_ALLOWED_HOSTNAMES, "youtube");

  try {
    const r = await ssrfFetchJson(
      ssrfFetchImpl,
      endpoint.toString(),
      {
        method: "GET",
        headers: {
          "user-agent": "EblushaLinkPreviewWorker/1.0",
          accept: "application/json",
        },
      },
      {
        allowedContentTypes: ["application/json", "text/plain"],
      }
    );
    if (r.status < 200 || r.status >= 300) return null;
    const data = r.json;
    if (!data || typeof data !== "object") return null;
    const title =
      typeof data.title === "string" && data.title.trim() ? data.title.trim() : "YouTube";
    const thumb =
      typeof data.thumbnail_url === "string" && data.thumbnail_url.trim()
        ? data.thumbnail_url.trim()
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    return {
      url: originalUrl,
      title,
      description:
        typeof data.author_name === "string" && data.author_name.trim() ? data.author_name.trim() : null,
      imageUrl: thumb,
      imageWidth: typeof data.thumbnail_width === "number" ? data.thumbnail_width : 480,
      imageHeight: typeof data.thumbnail_height === "number" ? data.thumbnail_height : 360,
      siteName: "YouTube",
      youtube: {
        videoId,
        channelTitle:
          typeof data.author_name === "string" && data.author_name.trim()
            ? data.author_name.trim()
            : null,
        durationIso: null,
        durationText: null,
        viewCount: null,
      },
      fetchedAtISO: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err, videoId }, "YouTube oEmbed fallback failed");
    return null;
  }
}

function buildYouTubeThumbnailFallback(originalUrl: string, videoId: string): LinkPreview {
  return {
    url: originalUrl,
    title: "YouTube",
    description: null,
    imageUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    imageWidth: 480,
    imageHeight: 360,
    siteName: "YouTube",
    youtube: {
      videoId,
      channelTitle: null,
      durationIso: null,
      durationText: null,
      viewCount: null,
    },
    fetchedAtISO: new Date().toISOString(),
  };
}

export async function fetchYouTubePreview(
  originalUrl: string,
  deps?: { ssrfFetch?: SsrfFetchLike }
): Promise<LinkPreview | null> {
  const ssrfFetchImpl = deps?.ssrfFetch ?? ssrfFetch;

  const videoId = extractYouTubeVideoId(originalUrl);
  if (!videoId) return null;

  const now = Date.now();
  const cached = youtubeCache.get(videoId);
  if (cached && cached.expiresAt > now) return cached.value;

  const inflight = youtubeInflight.get(videoId);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const apiPreview = await fetchYouTubeApiPreview(ssrfFetchImpl, originalUrl, videoId);
      if (apiPreview) return apiPreview;

      const oEmbedPreview = await fetchYouTubeOEmbedPreview(ssrfFetchImpl, originalUrl, videoId);
      if (oEmbedPreview) return oEmbedPreview;

      return buildYouTubeThumbnailFallback(originalUrl, videoId);
    } finally {
      youtubeInflight.delete(videoId);
    }
  })();

  youtubeInflight.set(videoId, p);
  const value = await p;
  youtubeCache.set(videoId, { value, expiresAt: Date.now() + YOUTUBE_CACHE_TTL_MS });
  return value;
}

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
  const thumb = typeof data?.thumbnail_url === "string" ? cleanText(data.thumbnail_url, 2048) : null;
  const provider =
    typeof data?.provider_name === "string" ? cleanText(data.provider_name, 120) : null;
  const author = typeof data?.author_name === "string" ? cleanText(data.author_name, 120) : null;
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

export async function fetchLinkPreview(
  urlString: string,
  deps?: { ssrfFetch?: SsrfFetchLike }
): Promise<LinkPreview | null> {
  const ssrfFetchImpl = deps?.ssrfFetch ?? ssrfFetch;

  if (isYouTubeUrl(urlString)) {
    const yt = await fetchYouTubePreview(urlString, { ssrfFetch: ssrfFetchImpl });
    if (yt) return yt;
  }

  const ua =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // 1) Fetch HTML (SSRF-guarded) and try oEmbed discovery.
  let finalUrl = urlString;
  let html: string | null = null;
  try {
    const res = await ssrfFetchImpl(
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
        maxRedirects: SSRF_MAX_REDIRECTS,
        timeoutMs: SSRF_TIMEOUT_MS,
        maxBodyBytes: SSRF_MAX_BODY_BYTES,
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
        const o = await ssrfFetchImpl(
          endpoint,
          {
            method: "GET",
            headers: {
              "user-agent": "EblushaLinkPreviewWorker/1.0",
              accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
            },
          },
          {
            maxRedirects: SSRF_MAX_REDIRECTS,
            timeoutMs: SSRF_TIMEOUT_MS,
            maxBodyBytes: SSRF_MAX_JSON_BODY_BYTES,
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
  const ogImage = readMeta(html, "property", "og:image") ?? readMeta(html, "name", "twitter:image");
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

