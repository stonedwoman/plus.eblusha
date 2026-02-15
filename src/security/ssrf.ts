import { lookup } from "node:dns/promises";
import net from "node:net";

export type SsrfFetchOptions = {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  allowedContentTypes?: ReadonlyArray<string>;
};

const DEFAULT_ALLOWED_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "application/json",
  "text/plain",
  "application/xml",
  "text/xml",
] as const;

export function isBlockedHostname(hostname: string): boolean {
  const h = (hostname || "").trim().replace(/\.$/, "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "local" || h.endsWith(".local")) return true;
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const a = parts[0]!;
  const b = parts[1]!;

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
  // ff00::/8 (multicast)
  if (norm.startsWith("ff")) return true;
  return false;
}

export async function assertSafeUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported_protocol");
  if (!url.hostname) throw new Error("missing_host");
  if (url.username || url.password) throw new Error("auth_in_url");

  const host = url.hostname.trim();
  if (isBlockedHostname(host)) throw new Error("hostname_blocked");

  // If hostname is already an IP literal, validate it directly.
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error("ip_blocked");
    return;
  }

  const addrs = await lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new Error("dns_empty");
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error("ip_blocked");
  }
}

async function readBodyUpTo(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function contentTypeOk(raw: string | null, allowed: ReadonlyArray<string>): boolean {
  const ct = (raw || "").toLowerCase();
  if (!ct) return false;
  const base = ct.split(";")[0]?.trim() || "";
  if (!base) return false;
  return allowed.includes(base);
}

export async function ssrfFetch(
  urlString: string,
  init: RequestInit,
  opts: SsrfFetchOptions = {}
): Promise<{ finalUrl: string; status: number; headers: Headers; body: Buffer }> {
  const maxRedirects = typeof opts.maxRedirects === "number" ? opts.maxRedirects : 3;
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 5_000;
  const maxBodyBytes = typeof opts.maxBodyBytes === "number" ? opts.maxBodyBytes : 512 * 1024;
  const allowedContentTypes = opts.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;

  let current: URL;
  try {
    current = new URL(urlString);
  } catch {
    throw new Error("invalid_url");
  }

  for (let i = 0; i <= maxRedirects; i++) {
    await assertSafeUrl(current);

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        ...init,
        redirect: "manual",
        signal: ac.signal,
      });
    } finally {
      clearTimeout(t);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("redirect_missing_location");
      current = new URL(loc, current);
      continue;
    }

    const ct = res.headers.get("content-type");
    if (!contentTypeOk(ct, allowedContentTypes)) {
      throw new Error("content_type_blocked");
    }

    const body = await readBodyUpTo(res, maxBodyBytes);
    return { finalUrl: current.toString(), status: res.status, headers: res.headers, body };
  }

  throw new Error("too_many_redirects");
}

