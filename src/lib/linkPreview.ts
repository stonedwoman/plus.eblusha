import { lookup } from "node:dns/promises";
import net from "node:net";

export type LinkPreview = {
  url: string;
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  siteName?: string | null;
  youtube?: {
    videoId: string;
    channelTitle?: string | null;
    durationIso?: string | null;
    durationText?: string | null;
    viewCount?: string | null;
  } | null;
  fetchedAtISO: string;
};

// Matches:
// - https://example.com/...
// - www.example.com/...
// - example.com/... (bare domains)
const URL_RE =
  /((?:(?:https?:\/\/)|www\.)[^\s<]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24})(?::\d{2,5})?(?:\/[^\s<]*)?)/gi;
const TRAILING_PUNCT_RE = /[)\]}.,!?;:]+$/;

const MAX_HTML_BYTES = 512_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const YOUTUBE_DEBUG = process.env.YOUTUBE_DEBUG === "1";
const YOUTUBE_DEBUG_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "googlevideo.com",
  "ytimg.com",
  "googleusercontent.com",
  "www.googleapis.com",
]);

function isYouTubeRelatedUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    const host = u.hostname.toLowerCase();
    if (YOUTUBE_DEBUG_HOSTS.has(host)) return true;
    for (const h of YOUTUBE_DEBUG_HOSTS) {
      if (host === h || host.endsWith(`.${h}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function ytDebug(event: string, details: Record<string, unknown>) {
  if (!YOUTUBE_DEBUG) return;
  try {
    // eslint-disable-next-line no-console
    console.log("[YOUTUBE_DEBUG]", event, details);
  } catch {
    // ignore
  }
}

type CacheEntry = { value: LinkPreview | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<LinkPreview | null>>();

type YouTubeMeta = {
  videoId: string;
  title: string | null;
  channelTitle: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  durationIso: string | null;
  durationText: string | null;
  viewCount: string | null;
};
type YouTubeCacheEntry = { value: YouTubeMeta | null; expiresAt: number };
const youtubeCache = new Map<string, YouTubeCacheEntry>();
const youtubeInflight = new Map<string, Promise<YouTubeMeta | null>>();

export function extractFirstUrl(text: unknown): string | null {
  if (typeof text !== "string") return null;
  URL_RE.lastIndex = 0;
  const m = URL_RE.exec(text);
  if (!m) return null;
  const raw = m[1] ?? "";
  const trailing = raw.match(TRAILING_PUNCT_RE)?.[0] ?? "";
  const core = trailing ? raw.slice(0, -trailing.length) : raw;
  const href = normalizeLinkHref(core);
  return href;
}

export async function getLinkPreview(urlString: string): Promise<LinkPreview | null> {
  const key = normalizeCacheKey(urlString);
  if (!key) return null;

  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const inflightExisting = inflight.get(key);
  if (inflightExisting) return inflightExisting;

  const promise = (async () => {
    try {
      // Prefer oEmbed where available; otherwise fallback to OG/Twitter/title/description.
      const preview =
        (await fetchOEmbedIfSupported(key)) ??
        (await fetchOEmbedDiscovered(key)) ??
        (await fetchOpenGraphWithRedirects(key));
      cache.set(key, { value: preview, expiresAt: Date.now() + CACHE_TTL_MS });
      return preview;
    } catch {
      cache.set(key, { value: null, expiresAt: Date.now() + 10 * 60 * 1000 });
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

async function fetchOEmbedIfSupported(urlString: string): Promise<LinkPreview | null> {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be" || host.endsWith(".youtube.com") || host === "youtube.com") {
    // YouTube: metadata only via Data API + ytimg (no HTML parsing, no watch-page fetching).
    return await fetchYouTubeDataApiPreview(urlString);
  }
  if (host === "open.spotify.com" || host.endsWith(".spotify.com") || host === "spotify.com" || host === "spoti.fi") {
    return await fetchSpotifyOEmbed(urlString);
  }
  return null;
}

function getYouTubeApiKey(): string | null {
  const k = process.env.YOUTUBE_API_KEY;
  if (!k || typeof k !== "string") return null;
  const trimmed = k.trim();
  return trimmed ? trimmed : null;
}

async function fetchYouTubeDataApiPreview(videoUrl: string): Promise<LinkPreview | null> {
  const apiKey = getYouTubeApiKey();
  const videoId = parseYouTubeVideoId(videoUrl);
  if (!videoId) return null;
  if (!apiKey) return null;

  const meta = await fetchYouTubeMeta(videoId, apiKey);
  if (!meta) return null;

  if (!meta.title && !meta.thumbnailUrl && !meta.description) return null;
  return {
    url: videoUrl,
    title: meta.title,
    description: meta.description ? meta.description.slice(0, 200) : (meta.channelTitle ? `Provided to YouTube by ${meta.channelTitle}` : null),
    imageUrl: meta.thumbnailUrl,
    imageWidth: meta.thumbnailWidth,
    imageHeight: meta.thumbnailHeight,
    siteName: "YouTube",
    youtube: {
      videoId,
      channelTitle: meta.channelTitle,
      durationIso: meta.durationIso,
      durationText: meta.durationText,
      viewCount: meta.viewCount,
    },
    fetchedAtISO: new Date().toISOString(),
  };
}

function parseYouTubeVideoId(urlString: string): string | null {
  try {
    const u = new URL(urlString);
    const host = u.hostname.toLowerCase();
    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const id = u.pathname.replace(/^\//, "").split("/")[0] || "";
      return id || null;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      // /watch?v=ID
      const v = u.searchParams.get("v");
      if (v) return v;
      // /shorts/ID, /embed/ID, /v/ID
      const parts = u.pathname.split("/").filter(Boolean);
      const head = parts[0] || "";
      const id = parts[1] || "";
      if (head === "shorts" || head === "embed" || head === "v") return id || null;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchYouTubeMeta(videoId: string, apiKey: string): Promise<YouTubeMeta | null> {
  const key = videoId.trim();
  if (!key) return null;

  const cached = youtubeCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const inflightExisting = youtubeInflight.get(key);
  if (inflightExisting) return inflightExisting;

  const promise = (async () => {
    try {
      const endpoint = new URL("https://www.googleapis.com/youtube/v3/videos");
      endpoint.searchParams.set("part", "snippet,contentDetails,statistics");
      endpoint.searchParams.set("id", key);
      endpoint.searchParams.set("key", apiKey);

      const res = await fetchWithTimeout(endpoint.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": "EblushaLinkPreview/1.0",
          accept: "application/json",
        },
      });
      if (!res.ok) return null;

      const data = (await res.json().catch(() => null)) as any;
      const item = Array.isArray(data?.items) && data.items.length ? data.items[0] : null;
      const sn = item?.snippet;
      const cd = item?.contentDetails;
      const st = item?.statistics;
      if (!sn || typeof sn !== "object") return null;

      const title = typeof sn.title === "string" && sn.title.trim() ? sn.title.trim() : null;
      const channelTitle =
        typeof sn.channelTitle === "string" && sn.channelTitle.trim() ? sn.channelTitle.trim() : null;
      const descRaw = typeof sn.description === "string" ? sn.description.trim() : "";
      const description = descRaw ? descRaw : null;

      const durationIso = typeof cd?.duration === "string" ? cd.duration : null;
      const durationText = durationIso ? formatYouTubeDuration(durationIso) : null;
      const viewCount = typeof st?.viewCount === "string" ? st.viewCount : null;

      const thumbs = sn.thumbnails && typeof sn.thumbnails === "object" ? sn.thumbnails : null;
      const pick = (k: string) => (thumbs && thumbs[k] && typeof thumbs[k] === "object" ? thumbs[k] : null);
      const t =
        pick("maxres") ??
        pick("standard") ??
        pick("high") ??
        pick("medium") ??
        pick("default") ??
        null;

      const thumbnailUrl = typeof t?.url === "string" && t.url.trim()
        ? t.url.trim()
        : `https://i.ytimg.com/vi/${key}/hqdefault.jpg`;
      const thumbnailWidth = typeof t?.width === "number" ? t.width : 480;
      const thumbnailHeight = typeof t?.height === "number" ? t.height : 360;

      return {
        videoId: key,
        title,
        channelTitle,
        description,
        thumbnailUrl,
        thumbnailWidth,
        thumbnailHeight,
        durationIso,
        durationText,
        viewCount,
      };
    } catch {
      return null;
    } finally {
      youtubeInflight.delete(key);
    }
  })();

  youtubeInflight.set(key, promise);
  const value = await promise;
  youtubeCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

function formatYouTubeDuration(iso: string): string | null {
  // PT#H#M#S -> hh:mm:ss or m:ss
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(iso);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = m[2] ? Number(m[2]) : 0;
  const s = m[3] ? Number(m[3]) : 0;
  if (![h, min, s].every((n) => Number.isFinite(n) && n >= 0)) return null;
  const total = h * 3600 + min * 60 + s;
  if (total <= 0) return "0:00";
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (hh > 0) return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function extractJsonObject(text: string, startAtBrace: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startAtBrace; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(startAtBrace, i + 1);
      }
    }
  }
  return null;
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function fetchSpotifyOEmbed(url: string): Promise<LinkPreview | null> {
  // Spotify oEmbed: https://open.spotify.com/oembed?url=...
  const endpoint = new URL("https://open.spotify.com/oembed");
  endpoint.searchParams.set("url", url);

  const res = await fetchWithTimeout(endpoint.toString(), {
    method: "GET",
    redirect: "manual",
    headers: {
      "user-agent": "EblushaLinkPreview/1.0",
      accept: "application/json",
    },
  });
  if (!res.ok) return null;
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("json")) return null;
  const data = (await res.json().catch(() => null)) as any;
  if (!data || typeof data !== "object") return null;

  return mapOEmbedToPreview(url, data);
}

function normalizeLinkHref(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const withScheme =
    lower.startsWith("http://") || lower.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeCacheKey(urlString: string) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Avoid cache explosion on tracking params; keep some common meaningful params, drop the rest.
    // This is intentionally conservative: we keep the full query only if it's short.
    if (u.search.length > 120) u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchOpenGraphWithRedirects(initialUrl: string): Promise<LinkPreview | null> {
  let current = new URL(initialUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertUrlIsSafeToFetch(current);

    const res = await fetchWithTimeout(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        // Some sites block non-browser UAs; use a common desktop UA.
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    // Redirect handling (manual so we can validate each hop)
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      const next = new URL(loc, current);
      current = next;
      continue;
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) return null;

    const html = await readBodyUpTo(res, MAX_HTML_BYTES);
    if (!html) return null;

    // Some sites return bot protection pages (Cloudflare/recaptcha).
    // Mark as blocked so the UI can stop "loading" immediately and show a plain link instead.
    const titleTag = readTitle(html);
    if (looksLikeBotWall(html, titleTag)) {
      return {
        url: current.toString(),
        title: null,
        description: null,
        imageUrl: null,
        imageWidth: null,
        imageHeight: null,
        siteName: current.hostname,
        fetchedAtISO: new Date().toISOString(),
        blockedReason: "bot_wall",
      } as any;
    }

    const parsed = parseOpenGraph(html, current.toString());
    if (!parsed) return null;

    // If we at least have a title or description or image, return it.
    const hasAny =
      (parsed.title && parsed.title.trim()) ||
      (parsed.description && parsed.description.trim()) ||
      (parsed.imageUrl && parsed.imageUrl.trim());
    if (!hasAny) return null;

    return {
      url: parsed.url,
      title: parsed.title ?? null,
      description: parsed.description ?? null,
      imageUrl: parsed.imageUrl ?? null,
      imageWidth: (parsed as any).imageWidth ?? null,
      imageHeight: (parsed as any).imageHeight ?? null,
      siteName: parsed.siteName ?? null,
      fetchedAtISO: new Date().toISOString(),
    };
  }
  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    if (YOUTUBE_DEBUG && isYouTubeRelatedUrl(url)) {
      ytDebug("fetch:start", {
        url,
        method: (init.method || "GET").toString(),
        redirect: (init.redirect || "follow").toString(),
      });
    }
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (YOUTUBE_DEBUG && isYouTubeRelatedUrl(url)) {
      ytDebug("fetch:done", {
        url,
        status: res.status,
        contentType: res.headers.get("content-type"),
        location: res.headers.get("location"),
      });
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchOEmbedDiscovered(pageUrl: string): Promise<LinkPreview | null> {
  // Fetch page HTML (limited) and look for:
  // <link rel="alternate" type="application/json+oembed" href="...">
  // <link rel="alternate" type="text/xml+oembed" href="..."> (we only support json endpoint)
  const { finalUrl, html } = await fetchHtmlWithRedirects(pageUrl);
  if (!html) return null;
  const endpoint = discoverOEmbedEndpoint(finalUrl, html);
  if (!endpoint) return null;

  // Validate endpoint (SSRF mitigation)
  await assertUrlIsSafeToFetch(endpoint);

  const res = await fetchWithTimeout(endpoint.toString(), {
    method: "GET",
    redirect: "manual",
    headers: {
      "user-agent": "EblushaLinkPreview/1.0",
      accept: "application/json",
    },
  });
  if (!res.ok) return null;
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("json")) return null;
  const data = (await res.json().catch(() => null)) as any;
  if (!data || typeof data !== "object") return null;
  return mapOEmbedToPreview(finalUrl, data);
}

async function fetchHtmlWithRedirects(initialUrl: string, maxBytes: number = MAX_HTML_BYTES): Promise<{ finalUrl: string; html: string | null }> {
  let current = new URL(initialUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertUrlIsSafeToFetch(current);

    const res = await fetchWithTimeout(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { finalUrl: current.toString(), html: null };
      current = new URL(loc, current);
      continue;
    }

    if (!res.ok) return { finalUrl: current.toString(), html: null };
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { finalUrl: current.toString(), html: null };
    }
    const html = await readBodyUpTo(res, maxBytes);
    return { finalUrl: current.toString(), html };
  }
  return { finalUrl: current.toString(), html: null };
}

function discoverOEmbedEndpoint(baseUrl: string, html: string): URL | null {
  // Robust best-effort: match any <link> with rel=alternate AND type=application/json+oembed and capture href,
  // regardless of attribute order.
  const jsonRe =
    /<link\b(?=[^>]*\brel\s*=\s*["']alternate["'])(?=[^>]*\btype\s*=\s*["']application\/json\+oembed["'])(?=[^>]*\bhref\s*=\s*["']([^"']+)["'])[^>]*>/i;
  const href = jsonRe.exec(html)?.[1] ?? null;
  if (!href) return null;
  try {
    return new URL(href, baseUrl);
  } catch {
    return null;
  }
}

function mapOEmbedToPreview(url: string, data: any): LinkPreview | null {
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;
  const thumb =
    typeof data.thumbnail_url === "string" && data.thumbnail_url.trim()
      ? data.thumbnail_url.trim()
      : null;
  const tw = typeof data.thumbnail_width === "number" ? data.thumbnail_width : null;
  const th = typeof data.thumbnail_height === "number" ? data.thumbnail_height : null;
  const provider =
    typeof data.provider_name === "string" && data.provider_name.trim()
      ? data.provider_name.trim()
      : (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return "site";
          }
        })();
  const author = typeof data.author_name === "string" && data.author_name.trim() ? data.author_name.trim() : null;

  if (!title && !thumb) return null;
  return {
    url,
    title,
    description: author ? `${author}` : null,
    imageUrl: thumb,
    imageWidth: tw,
    imageHeight: th,
    siteName: provider,
    fetchedAtISO: new Date().toISOString(),
  };
}

function looksLikeBotWall(html: string, title: string | null): boolean {
  const t = (title || "").toLowerCase();
  const h = html.toLowerCase();

  // Common Cloudflare interstitials
  if (t.includes("just a moment") || t.includes("checking your browser") || t.includes("attention required")) return true;
  if (h.includes("cf-browser-verification") || h.includes("/cdn-cgi/") || h.includes("cloudflare")) {
    if (h.includes("just a moment") || h.includes("checking your browser") || h.includes("attention required")) return true;
    if (h.includes("enable javascript") || h.includes("ddos protection")) return true;
  }

  // Captcha pages
  if (t.includes("captcha")) return true;
  if (h.includes("captcha") && (h.includes("recaptcha") || h.includes("hcaptcha") || h.includes("turnstile"))) return true;
  if (h.includes("g-recaptcha") || h.includes("hcaptcha") || h.includes("cf-turnstile")) return true;

  // Generic access blocks
  if (t.includes("access denied") || t.includes("request blocked") || t.includes("temporarily unavailable")) return true;

  return false;
}

async function readBodyUpTo(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) break;
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  return buf.toString("utf8");
}

function parseOpenGraph(html: string, baseUrl: string): { url: string; title?: string; description?: string; imageUrl?: string; imageWidth?: number; imageHeight?: number; siteName?: string } | null {
  const ogTitle =
    readMeta(html, "property", "og:title") ??
    readMeta(html, "name", "twitter:title") ??
    readMeta(html, "name", "title");
  const ogDesc =
    readMeta(html, "property", "og:description") ??
    readMeta(html, "name", "twitter:description") ??
    readMeta(html, "name", "description");
  const ogImage = readMeta(html, "property", "og:image") ?? readMeta(html, "name", "twitter:image");
  const ogImageW =
    readMeta(html, "property", "og:image:width") ??
    readMeta(html, "name", "twitter:image:width");
  const ogImageH =
    readMeta(html, "property", "og:image:height") ??
    readMeta(html, "name", "twitter:image:height");
  const ogSite = readMeta(html, "property", "og:site_name");
  const titleTag = readTitle(html);

  const title = cleanText(ogTitle ?? titleTag);
  const description = cleanText(ogDesc);
  const siteName =
    cleanText(ogSite) ??
    (() => {
      try {
        return new URL(baseUrl).hostname;
      } catch {
        return undefined;
      }
    })();
  const imageUrl = normalizeMaybeRelativeUrl(ogImage, baseUrl);
  const imageWidth = (() => {
    const n = ogImageW ? Number(ogImageW) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();
  const imageHeight = (() => {
    const n = ogImageH ? Number(ogImageH) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();

  const out: { url: string; title?: string; description?: string; imageUrl?: string; imageWidth?: number; imageHeight?: number; siteName?: string } = {
    url: baseUrl,
  };
  if (title) out.title = title;
  if (description) out.description = description;
  if (imageUrl) out.imageUrl = imageUrl;
  if (imageWidth) out.imageWidth = imageWidth;
  if (imageHeight) out.imageHeight = imageHeight;
  if (siteName) out.siteName = siteName;
  return out;
}

function readMeta(html: string, attr: "property" | "name", key: string): string | null {
  // Very small, dependency-free parser: search meta tags with attr=key and extract content="..."
  // Handles single/double quotes and varying attribute order (best-effort).
  const re = new RegExp(
    `<meta[^>]+${attr}\\s*=\\s*["']${escapeRegExp(key)}["'][^>]*>`,
    "ig",
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

function cleanText(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const s = v
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return undefined;
  return s.slice(0, 300);
}

function normalizeMaybeRelativeUrl(v: string | null | undefined, baseUrl: string): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assertUrlIsSafeToFetch(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported_protocol");
  if (!url.hostname) throw new Error("missing_host");
  if (url.username || url.password) throw new Error("auth_in_url");

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("localhost_blocked");

  // Reduce SSRF surface: block non-standard ports
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (![80, 443].includes(port)) throw new Error("port_blocked");

  // Resolve DNS and block private/link-local/etc.
  const addrs = await lookup(host, { all: true });
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error("ip_blocked");
  }
}

function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return true;
  // 0.0.0.0/8, 127.0.0.0/8
  if (a === 0 || a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved)
  if (a >= 224) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  // ::, ::1
  if (norm === "::" || norm === "::1") return true;
  // fc00::/7 (unique local)
  if (norm.startsWith("fc") || norm.startsWith("fd")) return true;
  // fe80::/10 (link-local)
  if (norm.startsWith("fe8") || norm.startsWith("fe9") || norm.startsWith("fea") || norm.startsWith("feb")) return true;
  return false;
}

