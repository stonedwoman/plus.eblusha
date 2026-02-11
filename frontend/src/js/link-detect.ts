export type DetectedLink = {
  raw: string;
  href: string;
  start: number;
  end: number;
  score: number;
  shouldPreview: boolean;
};

const CANDIDATE_RE =
  /(https?:\/\/[^\s<>()\[\]{}"']+|www\.[^\s<>()\[\]{}"']+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24})(?::\d{2,5})?(?:\/[^\s<>()\[\]{}"']*)?)/gi;

const TRAILING_PUNCT_RE = /[)\]}.,!?;:]+$/;

const COMMAND_LINE_PREFIX_RE =
  /^\s*(?:\$ |PS> ?|[A-Z]:\\> ?|sudo\s+|docker(?:\.(?:cmd|exe))?\s+|kubectl(?:\.(?:cmd|exe))?\s+|git(?:\.(?:cmd|exe))?\s+|npm(?:\.(?:cmd|exe))?\s+|pnpm(?:\.(?:cmd|exe))?\s+|yarn(?:\.(?:cmd|exe))?\s+|curl(?:\.(?:cmd|exe))?\s+|python(?:\.(?:exe))?\s+|node(?:\.(?:exe))?\s+|java(?:\.(?:exe))?\s+|go\s+|dotnet\s+)/i;

const UNIX_PATH_PREFIX_RE = /^(?:\/|\.\/|\.\.\/)/;
const WINDOWS_PATH_PREFIX_RE = /^(?:[A-Z]:\\|\\\\)/i;

const HOST_HAS_UNDERSCORE_RE = /_/;
const HOST_LIKE_LOCAL_RE = /(?:^localhost$|\.localhost$|\.local$|\.lan$)/i;

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[a-z0-9_]/i.test(ch);
}

function isEscaped(text: string, idx: number): boolean {
  let n = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (text[i] !== '\\') break;
    n++;
  }
  return n % 2 === 1;
}

function buildExcludedMask(text: string): boolean[] {
  const excluded = new Array<boolean>(text.length).fill(false);

  // Fenced code blocks ```...```
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('```', i) && !isEscaped(text, i)) {
      const start = i;
      const endFence = text.indexOf('```', i + 3);
      const end = endFence === -1 ? text.length : endFence + 3;
      for (let k = start; k < end; k++) excluded[k] = true;
      i = end - 1;
    }
  }

  // Inline code `...` (outside fenced blocks)
  for (let i = 0; i < text.length; i++) {
    if (excluded[i]) continue;
    if (text[i] === '`' && !isEscaped(text, i)) {
      const start = i;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (excluded[j]) continue;
        if (text[j] === '`' && !isEscaped(text, j)) break;
      }
      const end = j < text.length ? j + 1 : text.length;
      for (let k = start; k < end; k++) excluded[k] = true;
      i = end - 1;
    }
  }

  // Terminal-like lines
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    const isEol = i === text.length || text[i] === '\n';
    if (!isEol) continue;
    const line = text.slice(lineStart, i);
    if (COMMAND_LINE_PREFIX_RE.test(line)) {
      for (let k = lineStart; k < i; k++) excluded[k] = true;
    }
    lineStart = i + 1;
  }

  return excluded;
}

function trimTrailingPunct(raw: string): { core: string; trailing: string } {
  const trailing = raw.match(TRAILING_PUNCT_RE)?.[0] ?? '';
  const core = trailing ? raw.slice(0, -trailing.length) : raw;
  return { core, trailing };
}

function looksLikePath(core: string): boolean {
  if (UNIX_PATH_PREFIX_RE.test(core)) return true;
  if (WINDOWS_PATH_PREFIX_RE.test(core)) return true;
  if (!core.includes('://') && core.includes('/') && !core.includes('.')) return true;
  if (core.includes('\\')) return true;
  return false;
}

function normalizeHttpHref(core: string): URL | null {
  const trimmed = core.trim();
  if (!trimmed) return null;
  if (looksLikePath(trimmed)) return null;

  const lower = trimmed.toLowerCase();
  const hasScheme = lower.startsWith('http://') || lower.startsWith('https://');
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

function scoreAndValidate(core: string): { href: string; score: number; shouldPreview: boolean } | null {
  const lower = core.trim().toLowerCase();
  const hasExplicitScheme = lower.startsWith('http://') || lower.startsWith('https://');

  const u = normalizeHttpHref(core);
  if (!u) return null;

  const host = u.hostname.toLowerCase();
  if (HOST_HAS_UNDERSCORE_RE.test(host)) return null;

  const schemeMissing = !hasExplicitScheme;
  if (schemeMissing) {
    if (u.port) return null; // host:port without scheme

    const startsWww = lower.startsWith('www.');
    const parts = host.split('.').filter(Boolean);
    const tld = parts.length ? (parts[parts.length - 1] ?? '') : '';
    const validTld = /^[a-z]{2,24}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld);
    const hasDot = parts.length >= 2;
    if (!startsWww && !(hasDot && validTld)) return null;

    if (HOST_LIKE_LOCAL_RE.test(host)) return null;
  } else {
    if (/^localhost$/i.test(host) || host.endsWith('.localhost')) return null;
  }

  let score = 0;
  if (hasExplicitScheme) score += 2;
  if (lower.startsWith('www.')) score += 2;
  if (host.includes('.')) score += 1;
  {
    const hostParts = host.split('.').filter(Boolean);
    const tld = hostParts.length ? (hostParts[hostParts.length - 1] ?? '') : '';
    if (/^[a-z]{2,24}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld)) score += 2;
  }

  if (/[|<>]/.test(core)) score -= 3;
  if (core.includes('\\') || UNIX_PATH_PREFIX_RE.test(core)) score -= 3;

  const shouldPreview = score >= 3;
  return { href: u.toString(), score, shouldPreview };
}

export function detectLinks(text: unknown): DetectedLink[] {
  if (typeof text !== 'string') return [];
  if (!text.trim()) return [];

  const excluded = buildExcludedMask(text);
  const out: DetectedLink[] = [];

  CANDIDATE_RE.lastIndex = 0;
  while (true) {
    const m = CANDIDATE_RE.exec(text);
    if (!m) break;
    const raw = m[1] ?? '';
    if (!raw) continue;

    const start = m.index;
    const end = start + raw.length;

    let blocked = false;
    for (let i = start; i < end && i < excluded.length; i++) {
      if (excluded[i]) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const before = start > 0 ? text[start - 1] : undefined;
    const after = end < text.length ? text[end] : undefined;
    if (before === '@') continue;
    if (isWordChar(before) || isWordChar(after)) continue;

    // Avoid matching a domain-like substring inside filesystem paths (./, ../, /etc, C:\...).
    // Allow slashes only when they are part of the scheme prefix (https://).
    let tokenStart = start;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? '')) tokenStart--;
    const tokenPrefix = text.slice(tokenStart, start);
    if ((tokenPrefix.includes('/') || tokenPrefix.includes('\\')) && !tokenPrefix.includes('://')) continue;

    const { core, trailing } = trimTrailingPunct(raw);
    const coreEnd = end - trailing.length;
    if (!core) continue;

    const validated = scoreAndValidate(core);
    if (!validated) continue;

    out.push({
      raw,
      href: validated.href,
      start,
      end: coreEnd,
      score: validated.score,
      shouldPreview: validated.shouldPreview,
    });
  }

  return out;
}

export function extractFirstPreviewableUrl(text: unknown): string | null {
  const links = detectLinks(text);
  const first = links.find((l) => l.shouldPreview) ?? null;
  return first ? first.href : null;
}

