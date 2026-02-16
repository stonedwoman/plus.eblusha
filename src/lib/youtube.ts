const YOUTUBE_DOMAINS = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtu.be",
];

const YOUTUBE_HOSTS = new Set(YOUTUBE_DOMAINS);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const NESTED_URL_PARAM_KEYS = ["url", "u", "q", "target", "dest", "destination", "redirect", "redir", "link", "href"];

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return true;
  return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host.endsWith(".youtu.be");
}

function decodeMaybeTwice(value: string): string {
  let out = value;
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch {
      break;
    }
  }
  return out;
}

function sanitizeVideoId(candidate: string | null | undefined): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  // Sometimes id arrives as "abc123...&t=30" or "abc123...?si=..."
  const id = trimmed.split(/[?&#/]/)[0] ?? "";
  return VIDEO_ID_RE.test(id) ? id : null;
}

function extractFromYouTubeUrlObject(u: URL): string | null {
  const host = u.hostname.toLowerCase();

  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    const first = u.pathname.split("/").filter(Boolean)[0] ?? "";
    return sanitizeVideoId(first);
  }

  if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return null;

  const v = sanitizeVideoId(u.searchParams.get("v"));
  if (v) return v;
  const vi = sanitizeVideoId(u.searchParams.get("vi"));
  if (vi) return vi;

  const parts = u.pathname.split("/").filter(Boolean);
  const head = (parts[0] ?? "").toLowerCase();
  const idFromPath = sanitizeVideoId(parts[1]);
  if ((head === "shorts" || head === "live" || head === "embed" || head === "v") && idFromPath) return idFromPath;

  // /attribution_link?u=%2Fwatch%3Fv%3D...
  if (head === "attribution_link" || head === "redirect") {
    for (const key of ["u", "url", "q"]) {
      const raw = u.searchParams.get(key);
      if (!raw) continue;
      const decoded = decodeMaybeTwice(raw);
      const nested = extractYouTubeVideoId(decoded, 1);
      if (nested) return nested;
    }
  }

  return null;
}

export function isYouTubeUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    return isYouTubeHost(u.hostname);
  } catch {
    return false;
  }
}

export function extractYouTubeVideoId(urlString: string, depth: number = 0): string | null {
  if (depth > 3 || typeof urlString !== "string") return null;
  const raw = urlString.trim();
  if (!raw) return null;

  const direct = sanitizeVideoId(raw);
  if (direct) return direct;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Relative attribution-like url: /watch?v=...
    try {
      u = new URL(raw, "https://www.youtube.com");
    } catch {
      const rx = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/))([A-Za-z0-9_-]{11})/i.exec(raw);
      return sanitizeVideoId(rx?.[1] ?? null);
    }
  }

  if (isYouTubeHost(u.hostname)) {
    const fromSelf = extractFromYouTubeUrlObject(u);
    if (fromSelf) return fromSelf;
  }

  // Nested URL in common redirect parameters
  for (const key of NESTED_URL_PARAM_KEYS) {
    const rawValue = u.searchParams.get(key);
    if (!rawValue) continue;
    const decoded = decodeMaybeTwice(rawValue);
    const nested = extractYouTubeVideoId(decoded, depth + 1);
    if (nested) return nested;
  }

  return null;
}
