/**
 * Картинки с сайтов (вики и т.п.) → вложение Еблуши.
 *
 * Бот живёт на хосте рядом с внутренними сервисами (127.0.0.1:4000, :3010, …), поэтому
 * скачивание — только https и только на публичные адреса: каждый IP из DNS проверяется
 * в lookup самого соединения (без окна между проверкой и подключением), редиректы — заново
 * через ту же проверку. Размер ≤ 8 МБ, тип по сигнатуре (png/jpeg/gif/webp), размеры кадра —
 * из заголовка файла (клиентам нужны width/height, иначе лента прыгает).
 */
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import type { OutgoingImage } from "../modules/api";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function ipv4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Адрес, на который боту ходить нельзя (loopback, частные сети, link-local, multicast, …). */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return ipv4Private(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s) || s.startsWith("64:ff9b:") || s.startsWith("2001:db8");
  }
  return true;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function safeLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, "");
    const list = (addresses as dns.LookupAddress[]).filter((a) => !isPrivateAddress(a.address));
    if (list.length === 0) {
      const e = new Error(`blocked address for ${hostname}`) as NodeJS.ErrnoException;
      e.code = "EBLOCKED";
      return cb(e, "");
    }
    if (options.all) return cb(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
}

export function sniffImage(buf: Buffer): { mime: OutgoingImage["mime"]; width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { mime: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { mime: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { mime: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { mime: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

export class ImageFetchError extends Error {}

/**
 * Картиночные хосты вики. Скачивание картинки — запрос с нашего сервера на адрес, который выбрала
 * модель; если в ответе уже есть данные модулей (места игроков, склады), подсунутая страница могла
 * бы попросить модель «приложить» https://чужой-сайт/x.png?d=<данные>. Поэтому после данных
 * модулей качаем только отсюда (у web_fetch Anthropic похожее правило: только адреса из беседы).
 */
const WIKI_IMAGE_HOSTS = /^(?:upload\.wikimedia\.org|static\.wikia\.nocookie\.net|(?:[a-z0-9-]+\.)*wiki\.gg)$/i;

export function isWikiImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && WIKI_IMAGE_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

function getOnce(url: URL, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; location?: string; body?: Buffer; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        lookup: safeLookup as unknown as typeof dns.lookup,
        timeout: timeoutMs,
        headers: { "User-Agent": "EblushaBot/1.0 (+https://eblusha.org)", Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
        ...(signal ? { signal } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, location: res.headers.location });
          return;
        }
        if (status !== 200) {
          res.resume();
          resolve({ status });
          return;
        }
        const len = Number(res.headers["content-length"] ?? "0");
        if (len > MAX_IMAGE_BYTES) {
          res.destroy();
          reject(new ImageFetchError("слишком большой файл"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX_IMAGE_BYTES) {
            res.destroy(new ImageFetchError("слишком большой файл"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks), type: String(res.headers["content-type"] ?? "") }));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new ImageFetchError("таймаут")));
    req.on("error", reject);
  });
}

/** Скачать картинку по https с защитой от SSRF. Бросает ImageFetchError с понятной причиной. */
export async function downloadImage(rawUrl: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<OutgoingImage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageFetchError("кривой адрес");
  }
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:") throw new ImageFetchError("только https");
    if (url.username || url.password) throw new ImageFetchError("адрес с логином");
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) {
      throw new ImageFetchError("внутренний адрес");
    }
    let r;
    try {
      r = await getOnce(url, opts.timeoutMs ?? 12_000, opts.signal);
    } catch (e) {
      if (e instanceof ImageFetchError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      throw new ImageFetchError(code === "EBLOCKED" ? "внутренний адрес" : "не скачалось");
    }
    if (r.location) {
      url = new URL(r.location, url);
      continue;
    }
    if (r.status !== 200 || !r.body) throw new ImageFetchError(`HTTP ${r.status}`);
    const info = sniffImage(r.body);
    if (!info) throw new ImageFetchError("это не картинка png/jpeg/gif/webp");
    if (info.width < 16 || info.height < 16 || info.width > 12000 || info.height > 12000) throw new ImageFetchError("странный размер");
    const base = decodeURIComponent(url.pathname.split("/").pop() || "image").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60) || "image";
    const ext = info.mime.split("/")[1] === "jpeg" ? "jpg" : info.mime.split("/")[1]!;
    const name = /\.(png|jpe?g|gif|webp)$/i.test(base) ? base : `${base}.${ext}`;
    return { data: r.body, mime: info.mime, width: info.width, height: info.height, name };
  }
  throw new ImageFetchError("слишком много перенаправлений");
}
