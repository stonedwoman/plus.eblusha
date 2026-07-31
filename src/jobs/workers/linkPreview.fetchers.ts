import logger from "../../config/logger";
import type { LinkPreview } from "../../lib/linkPreview";
import { extractYouTubeVideoId, isYouTubeUrl } from "../../lib/youtube";
import { ssrfFetch, type SsrfFetchOptions } from "../../security/ssrf";

type SsrfFetchLike = typeof ssrfFetch;

const SSRF_MAX_REDIRECTS = 10;
const SSRF_TIMEOUT_MS = 12_000;
const SSRF_MAX_BODY_BYTES = 512 * 1024;
const SSRF_MAX_JSON_BODY_BYTES = 256 * 1024;
// HTML preview pages can be large (github.com ~570KB, Wikipedia ~1MB, some SPAs a few MB) and the
// og/meta tags can sit deeper than 512KB. Read the whole page up to a generous 10MB cap and
// truncate (don't fail) beyond that — so any real page yields a preview, while a malicious
// multi-GB stream stays bounded (also guarded by the 5s timeout).
const SSRF_HTML_MAX_BODY_BYTES = 10 * 1024 * 1024;

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

const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "application/xml", "text/xml"];
const MEDIA_CONTENT_TYPES = ["image/", "video/", "audio/", "application/pdf"];

/** Мини-декодер HTML-сущностей: без него ссылки с &amp; ломаются, а заголовки пестрят &quot;. */
function decodeEntities(s: string): string {
  if (!s || s.indexOf("&") === -1) return s;
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»",
    mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", middot: "·",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
    const t = String(g);
    if (t[0] === "#") {
      const code = t[1] === "x" || t[1] === "X" ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = named[t.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

/** Кодировка страницы: сайты на windows-1251 иначе превращаются в кракозябры. */
function decodeHtmlBody(body: Buffer, contentType: string | null): string {
  const head = body.subarray(0, 4096).toString("latin1");
  let charset =
    /charset\s*=\s*["']?\s*([\w-]+)/i.exec(contentType || "")?.[1] ||
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ||
    /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head)?.[1] ||
    "utf-8";
  charset = charset.toLowerCase();
  if (charset === "utf-8" || charset === "utf8" || charset === "us-ascii" || charset === "ascii") {
    return body.toString("utf8");
  }
  try {
    // Node умеет часть однобайтовых кодировок через TextDecoder (ICU).
    return new TextDecoder(charset as any).decode(body);
  } catch {
    return body.toString("utf8");
  }
}

/** Все meta-теги: поддерживает любой порядок атрибутов и content без кавычек. */
function readMetaAny(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const esc = escapeRegExp(key);
    const re = new RegExp(
      `<meta\\b[^>]*?\\b(?:property|name|itemprop)\\s*=\\s*["']?${esc}["']?[^>]*>`,
      "i",
    );
    const tag = re.exec(html)?.[0];
    if (!tag) continue;
    const content =
      /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ??
      /\bcontent\s*=\s*'([^']*)'/i.exec(tag)?.[1] ??
      /\bcontent\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (content && content.trim()) return decodeEntities(content.trim());
  }
  return null;
}

/** <link rel="image_src|apple-touch-icon|icon"> — частый источник картинки, когда og:image нет. */
function readLinkHref(html: string, rels: string[]): string | null {
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] || "").toLowerCase();
    if (!rel) continue;
    if (!rels.some((r) => rel.split(/\s+/).includes(r))) continue;
    const href =
      /\bhref\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ??
      /\bhref\s*=\s*'([^']*)'/i.exec(tag)?.[1] ??
      /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (href && href.trim()) return decodeEntities(href.trim());
  }
  return null;
}

/** JSON-LD (schema.org) — им размечены магазины, новости, объявления; часто есть, когда og нет. */
function readJsonLd(html: string): { title: string | null; description: string | null; image: string | null } {
  const out = { title: null as string | null, description: null as string | null, image: null as string | null };
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const pickImage = (v: any): string | null => {
    if (!v) return null;
    if (typeof v === "string") return v;
    if (Array.isArray(v)) { for (const x of v) { const r = pickImage(x); if (r) return r; } return null; }
    if (typeof v === "object") return pickImage(v.url ?? v.contentUrl ?? v["@id"] ?? null);
    return null;
  };
  const visit = (node: any, depth = 0) => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n, depth + 1)); return; }
    if (typeof node !== "object") return;
    if (!out.title && typeof node.name === "string") out.title = node.name;
    if (!out.title && typeof node.headline === "string") out.title = node.headline;
    if (!out.description && typeof node.description === "string") out.description = node.description;
    if (!out.image) { const img = pickImage(node.image ?? node.thumbnailUrl ?? node.logo); if (img) out.image = img; }
    if (node["@graph"]) visit(node["@graph"], depth + 1);
    for (const k of ["mainEntity", "itemListElement", "offers", "video"]) if (node[k]) visit(node[k], depth + 1);
  };
  while ((m = re.exec(html))) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    try { visit(JSON.parse(raw)); } catch { /* битый JSON-LD — пропускаем */ }
    if (out.title && out.image) break;
  }
  return out;
}

/** Превью для прямой ссылки на медиа: сама картинка и есть превью. */
function buildMediaPreview(finalUrl: string, contentType: string): LinkPreview | null {
  const ct = contentType.toLowerCase();
  let host: string | null = null;
  let name: string | null = null;
  try {
    const u = new URL(finalUrl);
    host = u.hostname;
    name = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "") || null;
  } catch { /* ignore */ }
  if (ct.startsWith("image/")) {
    return { url: finalUrl, title: name || "Изображение", description: null, imageUrl: finalUrl,
             imageWidth: null, imageHeight: null, siteName: host, fetchedAtISO: new Date().toISOString() };
  }
  if (ct.startsWith("video/") || ct.startsWith("audio/") || ct.startsWith("application/pdf")) {
    const kind = ct.startsWith("video/") ? "Видео" : ct.startsWith("audio/") ? "Аудио" : "PDF-документ";
    return { url: finalUrl, title: name || kind, description: kind, imageUrl: null,
             imageWidth: null, imageHeight: null, siteName: host, fetchedAtISO: new Date().toISOString() };
  }
  return null;
}


/**
 * Запасное превью, когда страницу забрать не удалось (антибот, 403, таймаут).
 * Берём то, что доступно почти всегда: домен и иконку сайта, плюс читаемый заголовок из адреса.
 * Пустая карточка лучше отсутствия карточки: ссылка остаётся узнаваемой.
 */
async function buildFallbackPreview(
  ssrfFetchImpl: SsrfFetchLike,
  urlString: string
): Promise<LinkPreview | null> {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.replace(/^www\./, "");
  // Заголовок из адреса: последний осмысленный сегмент пути, иначе домен.
  const segs = u.pathname.split("/").filter((s) => s && !/^\d+$/.test(s));
  const last = segs.length ? decodeURIComponent(segs[segs.length - 1] ?? "") : "";
  const GENERIC = new Set([
    "item", "items", "product", "products", "view", "page", "id", "p", "post", "posts",
    "article", "articles", "film", "movie", "watch", "detail", "details", "ru", "en", "index",
  ]);
  const prettyRaw = last
    .replace(/\.(html?|php|aspx?)$/i, "")
    .replace(/[-_+]+/g, " ")
    .trim();
  const pretty = GENERIC.has(prettyRaw.toLowerCase()) ? "" : prettyRaw;
  // Заголовок — домен: он всегда осмыслен. Расшифровка адреса, если есть, идёт описанием.
  const title = host;
  const description = pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : null;

  // Иконка: часто доступна даже если страница закрыта антиботом.
  let imageUrl: string | null = null;
  for (const candidate of ["/apple-touch-icon.png", "/favicon.ico"]) {
    try {
      const iconUrl = new URL(candidate, u.origin).toString();
      const r = await ssrfFetchImpl(
        iconUrl,
        { method: "GET", headers: { "user-agent": "Mozilla/5.0 Chrome/124.0.0.0", accept: "image/*,*/*;q=0.8" } },
        { maxRedirects: 5, timeoutMs: 6_000, maxBodyBytes: 512 * 1024, truncateBody: true, allowedContentTypes: ["image/", "application/octet-stream", "text/plain"] }
      );
      if (r.status >= 200 && r.status < 300 && r.body.length > 64) {
        imageUrl = r.finalUrl;
        break;
      }
    } catch {
      // иконки может не быть — не страшно
    }
  }

  return {
    url: urlString,
    title: cleanText(title, 200),
    description: cleanText(description, 200),
    imageUrl,
    imageWidth: null,
    imageHeight: null,
    siteName: host,
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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const browserHeaders: Record<string, string> = {
    "user-agent": ua,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "upgrade-insecure-requests": "1",
  };

  // Один запрос, широкий список типов: так и HTML заберём, и прямую картинку/видео опознаем,
  // вместо того чтобы падать с content_type_blocked.
  let finalUrl = urlString;
  let html: string | null = null;
  let contentType = "";
  try {
    const res = await ssrfFetchImpl(
      urlString,
      { method: "GET", headers: browserHeaders },
      {
        maxRedirects: SSRF_MAX_REDIRECTS,
        timeoutMs: SSRF_TIMEOUT_MS,
        maxBodyBytes: SSRF_HTML_MAX_BODY_BYTES,
        truncateBody: true,
        allowedContentTypes: [...HTML_CONTENT_TYPES, ...MEDIA_CONTENT_TYPES],
      }
    );
    finalUrl = res.finalUrl;
    contentType = (res.headers.get("content-type") || "").toLowerCase();

    // Прямая ссылка на медиа — превью строим из неё самой.
    if (MEDIA_CONTENT_TYPES.some((p) => contentType.startsWith(p))) {
      const media = buildMediaPreview(finalUrl, contentType);
      if (media) return media;
    }

    if (res.status >= 200 && res.status < 400) {
      html = decodeHtmlBody(res.body, contentType);
    }
  } catch (err) {
    logger.debug({ err, url: urlString }, "link preview: основной запрос не удался");
    html = null;
  }

  if (!html) return buildFallbackPreview(ssrfFetchImpl, urlString);

  // oEmbed, если сайт его объявляет (даёт лучшие заголовки/картинки, чем og).
  const endpoint = discoverOEmbedEndpoint(finalUrl, html);
  if (endpoint) {
    try {
      const o = await ssrfFetchImpl(
        endpoint,
        { method: "GET", headers: { "user-agent": ua, accept: "application/json,text/plain;q=0.9,*/*;q=0.1" } },
        {
          maxRedirects: SSRF_MAX_REDIRECTS,
          timeoutMs: SSRF_TIMEOUT_MS,
          maxBodyBytes: SSRF_MAX_JSON_BODY_BYTES,
          allowedContentTypes: ["application/json", "text/plain"],
        }
      );
      if (o.status >= 200 && o.status < 400) {
        const mapped = mapOEmbedToPreview(finalUrl, JSON.parse(o.body.toString("utf8")));
        if (mapped) return mapped;
      }
    } catch {
      // не беда — ниже разберём разметку страницы
    }
  }

  // Разметка страницы: og / twitter / itemprop, затем JSON-LD, затем <title> и <link>.
  const ld = readJsonLd(html);
  const title = cleanText(
    readMetaAny(html, ["og:title", "twitter:title", "title"]) ?? ld.title ?? readTitle(html)
  );
  const description = cleanText(
    readMetaAny(html, ["og:description", "twitter:description", "description"]) ?? ld.description,
    300
  );
  const rawImage =
    readMetaAny(html, [
      "og:image:secure_url",
      "og:image:url",
      "og:image",
      "twitter:image",
      "twitter:image:src",
      "image",
      "thumbnailUrl",
    ]) ??
    ld.image ??
    readLinkHref(html, ["image_src"]);
  let imageUrl = normalizeMaybeRelativeUrl(rawImage, finalUrl);

  // Если картинки нет — берём иконку сайта: превью с иконкой лучше, чем голый текст.
  if (!imageUrl) {
    const icon =
      readLinkHref(html, ["apple-touch-icon", "apple-touch-icon-precomposed", "icon", "shortcut icon"]) ?? null;
    imageUrl = normalizeMaybeRelativeUrl(icon, finalUrl);
    if (!imageUrl) {
      try {
        imageUrl = new URL("/favicon.ico", finalUrl).toString();
      } catch {
        imageUrl = null;
      }
    }
  }

  const siteName =
    cleanText(readMetaAny(html, ["og:site_name", "application-name"]), 120) ??
    (() => {
      try {
        // Именно исходный адрес: редирект мог увести на служебный домен (авторизация и т.п.).
        return new URL(urlString).hostname.replace(/^www\./, "");
      } catch {
        try {
          return new URL(finalUrl).hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
      }
    })();

  if (!title && !description && !imageUrl) return buildFallbackPreview(ssrfFetchImpl, urlString);
  // Безымянная карточка выглядит сломанной — если заголовка нет, показываем домен.
  const safeTitle = title && title.trim() ? title : siteName;
  return {
    url: finalUrl,
    title: safeTitle,
    description,
    imageUrl,
    imageWidth: null,
    imageHeight: null,
    siteName,
    fetchedAtISO: new Date().toISOString(),
  };
}
