import type { Request } from "express";
import geoip from "geoip-lite";

export type IpLocation = { ip: string; country?: string | null; city?: string | null };

export function normalizeIp(ip: string): string {
  let v = String(ip || "").trim();
  if (!v) return "";
  // Remove IPv6 prefix for IPv4-mapped addresses
  if (v.startsWith("::ffff:")) v = v.slice("::ffff:".length);
  return v;
}

export function extractClientIp(req: Request): string | null {
  try {
    const xff = req.headers["x-forwarded-for"];
    const raw =
      (typeof xff === "string" ? xff : Array.isArray(xff) ? xff.join(",") : "") ||
      // express with trust proxy uses req.ip
      ((req as any).ip as string | undefined) ||
      ((req.socket as any)?.remoteAddress as string | undefined) ||
      "";
    const first = String(raw).split(",")[0]?.trim() || "";
    const ip = normalizeIp(first);
    return ip || null;
  } catch {
    return null;
  }
}

export function lookupIpLocation(ipRaw: string): { country?: string | null; city?: string | null } {
  const ip = normalizeIp(ipRaw);
  if (!ip) return {};
  try {
    const rec = geoip.lookup(ip);
    if (!rec) return {};
    const countryCode = typeof (rec as any).country === "string" ? String((rec as any).country).trim() : "";
    const city = typeof (rec as any).city === "string" ? String((rec as any).city).trim() : "";
    let country: string | null = countryCode || null;
    try {
      if (countryCode) {
        // Use English names (matches Telegram-style UI best).
        const dn = new Intl.DisplayNames(["en"], { type: "region" });
        country = dn.of(countryCode) ?? countryCode;
      }
    } catch {
      // ignore Intl failures
    }
    return { country, city: city || null };
  } catch {
    return {};
  }
}

export function buildIpLocation(req: Request): IpLocation | null {
  const ip = extractClientIp(req);
  if (!ip) return null;
  const loc = lookupIpLocation(ip);
  return { ip, country: loc.country ?? null, city: loc.city ?? null };
}

export function buildIpLocationFromRaw(ipRaw: string | null | undefined): IpLocation | null {
  const ip = normalizeIp(String(ipRaw || ""));
  if (!ip) return null;
  const loc = lookupIpLocation(ip);
  return { ip, country: loc.country ?? null, city: loc.city ?? null };
}

