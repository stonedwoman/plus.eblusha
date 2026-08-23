import type { CloudActivityType } from "@prisma/client";
import prisma from "../lib/prisma";
import logger from "../config/logger";
import { emitCloud, spaceRoom } from "./realtime";

const AGGREGATION_WINDOW_MS = 10 * 60_000;
// Массовые операции склеиваем, иначе загрузка 800 фотографий превратит ленту в мусор.
const AGGREGATABLE = new Set<CloudActivityType>(["FILES_UPLOADED", "FILES_DELETED", "FILES_RESTORED", "FILES_SAVED"]);

export async function recordActivity(
  spaceId: string,
  actorId: string,
  type: CloudActivityType,
  payload: Record<string, unknown> = {}
): Promise<void> {
  try {
    const count = typeof payload.count === "number" ? payload.count : 1;

    if (AGGREGATABLE.has(type)) {
      const since = new Date(Date.now() - AGGREGATION_WINDOW_MS);
      const recent = await prisma.cloudActivityEvent.findFirst({
        where: { spaceId, actorId, type, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
      });
      if (recent) {
        const prev = (recent.payload as Record<string, unknown> | null) ?? {};
        const prevCount = typeof prev.count === "number" ? prev.count : 1;
        const names = Array.isArray(prev.names) ? (prev.names as string[]) : [];
        const incoming = Array.isArray(payload.names) ? (payload.names as string[]) : [];
        const merged = {
          ...prev,
          ...payload,
          count: prevCount + count,
          names: [...names, ...incoming].slice(0, 5),
        };
        const updated = await prisma.cloudActivityEvent.update({
          where: { id: recent.id },
          data: { payload: merged as never, createdAt: new Date() },
        });
        await publish(spaceId, updated.id);
        return;
      }
    }

    const created = await prisma.cloudActivityEvent.create({
      data: { spaceId, actorId, type, payload: payload as never },
    });
    await publish(spaceId, created.id);
  } catch (err) {
    logger.warn({ err, type, spaceId }, "cloud activity write failed");
  }
}

async function publish(spaceId: string, eventId: string): Promise<void> {
  const event = await prisma.cloudActivityEvent.findUnique({
    where: { id: eventId },
    include: { actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
  if (!event) return;
  await emitCloud("cloud.activity.created", [spaceRoom(spaceId)], {
    spaceId,
    event: {
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      payload: event.payload,
      actor: event.actor,
    },
  });
}
