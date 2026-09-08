import type { Request } from "express";
import prisma from "./prisma";

type AuthedRequest = Request & { user?: { id: string }; deviceId?: string };

/**
 * Текущее устройство запроса — общий резолвер для /devices и /secret.
 *
 * Кандидаты по убыванию доверия: did-claim токена → x-device-id → query → body. Раньше
 * брался ТОЛЬКО первый непустой (обычно did токена), и это намертво ломало устройство,
 * зарегистрированное позже логина или сменившее id: did указывал на чужую/отозванную
 * запись → null. Для секреток это значило 400 на каждый inbox pull (realtime не работал
 * вовсе), для «завершить остальные сеансы» — что без текущего устройства в исключениях
 * отзывалось и само устройство. Теперь перебираем кандидатов, пока один не окажется
 * НАШИМ живым устройством — did остаётся приоритетным, но перестал быть тупиком.
 * Проверка владения (userId + revokedAt) не ослаблена.
 */
export async function resolveCurrentDeviceId(req: Request): Promise<string | null> {
  const r = req as AuthedRequest;
  const candidates = [
    r.deviceId,
    typeof req.headers["x-device-id"] === "string" ? String(req.headers["x-device-id"]) : "",
    typeof (req.query as any)?.deviceId === "string" ? String((req.query as any).deviceId) : "",
    typeof (req.body as any)?.deviceId === "string" ? String((req.body as any).deviceId) : "",
  ]
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const device = await prisma.userDevice.findUnique({
      where: { id: candidate },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (device && device.userId === r.user?.id && !device.revokedAt) return device.id;
  }
  return null;
}
