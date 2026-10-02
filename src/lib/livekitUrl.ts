import type { Request } from "express";

type RequestLike = Pick<Request, "get" | "protocol">;

function firstForwardedValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [first] = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return first || undefined;
}

function readUrlProtocol(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function readUrlHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cloudflare сообщает исходную схему клиента в заголовке CF-Visitor: {"scheme":"https"}.
 * Туннель до nginx идёт по http, поэтому X-Forwarded-Proto здесь «http», а у нативных
 * клиентов (ПК на WinUI, стенды) нет ни Origin, ни Referer — без этого заголовка они
 * получали ws://, Cloudflare отвечал 301, и звонок не поднимался.
 */
function readCfVisitorScheme(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const scheme = (JSON.parse(value) as { scheme?: unknown })?.scheme;
    return typeof scheme === "string" ? scheme.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function buildLivekitPublicUrl(req: RequestLike, livekitPath: string): string {
  const forwardedProto = firstForwardedValue(req.get("x-forwarded-proto") || undefined);
  const cfVisitorProto = readCfVisitorScheme(req.get("cf-visitor") || undefined);
  const requestProto = typeof req.protocol === "string" ? req.protocol.trim().toLowerCase() : undefined;
  const origin = req.get("origin") || undefined;
  const referer = req.get("referer") || undefined;
  const originProto = readUrlProtocol(origin);
  const refererProto = readUrlProtocol(referer);

  const hasSecureSignal = [forwardedProto, cfVisitorProto, requestProto, originProto, refererProto].some(
    (value) => value === "https" || value === "wss"
  );

  const host =
    firstForwardedValue(req.get("x-forwarded-host") || undefined) ||
    firstForwardedValue(req.get("host") || undefined) ||
    readUrlHost(origin) ||
    readUrlHost(referer) ||
    "localhost";

  const normalizedPath = livekitPath.startsWith("/") ? livekitPath : `/${livekitPath}`;
  const protocol = hasSecureSignal ? "wss" : "ws";
  return `${protocol}://${host}${normalizedPath}`;
}
