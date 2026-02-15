import type { Prisma, PrismaClient } from "@prisma/client";

export type LivekitEventInput = {
  id: string;
  event: string;
  roomName?: string | null;
  participantIdentity?: string | null;
  createdAtSeconds?: bigint | number | null;
};

type TxLike = Prisma.TransactionClient | PrismaClient;

function eventTimestamp(createdAtSeconds?: bigint | number | null): Date {
  if (typeof createdAtSeconds === "bigint") return new Date(Number(createdAtSeconds) * 1000);
  if (typeof createdAtSeconds === "number" && Number.isFinite(createdAtSeconds)) return new Date(createdAtSeconds * 1000);
  return new Date();
}

async function findActiveSession(tx: TxLike, roomName: string) {
  return tx.callSession.findFirst({ where: { roomName, endedAt: null }, orderBy: { startedAt: "desc" } });
}

async function ensureSession(tx: TxLike, roomName: string, participantIdentity: string | null, at: Date) {
  const active = await findActiveSession(tx, roomName);
  if (active) return active;
  const conversation = await tx.conversation.findUnique({
    where: { id: roomName },
    select: {
      id: true,
      createdById: true,
      participants: { select: { userId: true }, orderBy: { joinedAt: "asc" }, take: 1 },
    },
  });
  if (!conversation) return null;
  const initiatorId = participantIdentity ?? conversation.createdById ?? conversation.participants[0]?.userId ?? null;
  if (!initiatorId) return null;
  return tx.callSession.create({
    data: { roomName, conversationId: conversation.id, initiatorId, startedAt: at, type: "VOICE" },
  });
}

async function applyParticipantLeft(tx: TxLike, evt: LivekitEventInput, at: Date) {
  const roomName = evt.roomName?.trim();
  const userId = evt.participantIdentity?.trim();
  if (!roomName || !userId) return;
  const session =
    (await findActiveSession(tx, roomName)) ??
    (await tx.callSession.findFirst({ where: { roomName }, orderBy: { startedAt: "desc" } }));
  if (!session) return;
  const existing = await tx.callParticipant.findUnique({
    where: { sessionId_userId: { sessionId: session.id, userId } },
  });
  if (!existing) return;
  await tx.callParticipant.update({
    where: { id: existing.id },
    data: { leftAt: existing.leftAt && existing.leftAt > at ? existing.leftAt : at },
  });
}

export async function applyLivekitFactsEvent(tx: TxLike, evt: LivekitEventInput): Promise<void> {
  const at = eventTimestamp(evt.createdAtSeconds);
  const roomName = evt.roomName?.trim();
  const userId = evt.participantIdentity?.trim() || null;

  switch (evt.event) {
    case "room_started": {
      if (!roomName) return;
      const session = await ensureSession(tx, roomName, userId, at);
      if (!session) return;
      if (session.startedAt > at) await tx.callSession.update({ where: { id: session.id }, data: { startedAt: at } });
      return;
    }
    case "room_finished": {
      if (!roomName) return;
      const session =
        (await findActiveSession(tx, roomName)) ??
        (await tx.callSession.findFirst({ where: { roomName }, orderBy: { startedAt: "desc" } }));
      if (!session) return;
      const nextEndedAt = session.endedAt && session.endedAt > at ? session.endedAt : at;
      await tx.callSession.update({ where: { id: session.id }, data: { endedAt: nextEndedAt } });
      return;
    }
    case "participant_joined": {
      if (!roomName || !userId) return;
      const session = await ensureSession(tx, roomName, userId, at);
      if (!session) return;
      const existing = await tx.callParticipant.findUnique({
        where: { sessionId_userId: { sessionId: session.id, userId } },
      });
      if (!existing) {
        await tx.callParticipant.create({ data: { sessionId: session.id, userId, joinedAt: at } });
      } else {
        await tx.callParticipant.update({
          where: { id: existing.id },
          data: { joinedAt: existing.joinedAt > at ? at : existing.joinedAt },
        });
      }
      return;
    }
    case "participant_left":
    case "participant_connection_aborted":
      await applyParticipantLeft(tx, evt, at);
      return;
    default:
      return;
  }
}
