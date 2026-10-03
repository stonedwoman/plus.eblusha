import prisma from "./prisma";

/**
 * Смена состояния секретного треда (accept / decline) — ОДНА реализация для HTTP
 * (`POST /threads/secret/:id/accept|decline`) и легаси-сокета (`secret:chat:accept|decline`).
 *
 * H08: раньше accept делал findUnique → проверки → безусловный update. Два устройства
 * собеседника одновременно получали 200 (ключ уходил обоим), а accept, прочитавший тред
 * до decline, переписывал CANCELLED обратно в ACTIVE. Теперь переход — один условный
 * UPDATE (`WHERE secretStatus = PENDING` или «уже ACTIVE на ЭТОМ же устройстве»): Postgres
 * перепроверяет условие на свежей версии строки, поэтому из гонки выходит ровно один
 * победитель, а CANCELLED не воскресает.
 *
 * H09: легаси-сокет `secret:chat:accept` не проверял ни создателя, ни «уже принят другим
 * устройством», ни `type`. Теперь он вызывает ту же функцию — правила у путей одинаковые.
 */

export type SecretThreadFailure = {
  ok: false;
  status: 403 | 404 | 409;
  message: string;
  code: string;
};

export type SecretAcceptSuccess = {
  ok: true;
  conversationId: string;
  peerDeviceId: string;
  participantIds: string[];
  thread: any;
};

export type SecretDeclineSuccess = {
  ok: true;
  conversationId: string;
  /** false — тред уже был CANCELLED (идемпотентный повтор): событий не рассылаем. */
  changed: boolean;
  participantIds: string[];
};

// Форма беседы для событий клиентам (как в threads.ts create/accept).
export const secretThreadInclude = {
  participants: {
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    },
  },
} as const;

const fail = (status: SecretThreadFailure["status"], message: string, code: string): SecretThreadFailure => ({
  ok: false,
  status,
  message,
  code,
});

// Тексты ошибок сохранены дословно: клиенты могли на них опираться.
const NOT_FOUND = () => fail(404, "Secret thread not found", "SECRET_THREAD_NOT_FOUND");
const FORBIDDEN = () => fail(403, "Forbidden", "FORBIDDEN");
const CREATOR = () => fail(409, "The creator cannot accept their own invite", "SECRET_ACCEPT_BY_CREATOR");
const DECLINED = () => fail(409, "Invite was declined", "SECRET_INVITE_DECLINED");
/** Ответ принявшему, если тред отменили между коммитом accept и рассылкой (announceSecretThreadAccepted). */
export const SECRET_ACCEPT_LOST_TO_DECLINE = { message: "Invite was declined", code: "SECRET_INVITE_DECLINED" } as const;
const OTHER_DEVICE = () => fail(409, "Already accepted on another device", "SECRET_ACCEPTED_ON_OTHER_DEVICE");

/**
 * Принять приглашение на устройстве `deviceId`. Владение устройством (userId + не отозвано)
 * проверяет ВЫЗЫВАЮЩИЙ (HTTP — resolveCurrentDeviceId, сокет — свой lookup).
 */
export async function acceptSecretThread(params: {
  userId: string;
  conversationId: string;
  deviceId: string;
}): Promise<SecretAcceptSuccess | SecretThreadFailure> {
  const { userId, conversationId, deviceId } = params;

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { select: { userId: true } } },
  });
  const c = conv as any;
  if (!conv || c.type !== "SECRET" || c.isGroup) return NOT_FOUND();
  const participantIds: string[] = c.participants.map((p: any) => p.userId);
  if (!participantIds.includes(userId)) return FORBIDDEN();
  // Принимает только СОБЕСЕДНИК: у создателя ключ уже есть.
  if (c.createdById === userId) return CREATOR();
  if (c.secretStatus === "CANCELLED") return DECLINED();
  if (c.secretStatus === "ACTIVE" && c.secretPeerDeviceId && c.secretPeerDeviceId !== deviceId) return OTHER_DEVICE();

  const outcome = await prisma.$transaction(async (tx) => {
    const claimed = await tx.conversation.updateMany({
      where: {
        id: conversationId,
        type: "SECRET",
        isGroup: false,
        OR: [
          { secretStatus: "PENDING" },
          // Идемпотентный повтор с того же устройства (и старое ACTIVE без закреплённого устройства).
          { secretStatus: "ACTIVE", secretPeerDeviceId: deviceId },
          { secretStatus: "ACTIVE", secretPeerDeviceId: null },
        ],
      } as any,
      data: { secretStatus: "ACTIVE", secretPeerDeviceId: deviceId } as any,
    });
    if (claimed.count === 0) {
      // Проиграли гонку: перечитываем, чтобы ответить по делу.
      const now = (await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { secretStatus: true, secretPeerDeviceId: true },
      })) as any;
      if (!now) return NOT_FOUND();
      if (now.secretStatus === "CANCELLED") return DECLINED();
      return OTHER_DEVICE();
    }
    const thread = await tx.conversation.findUnique({
      where: { id: conversationId },
      include: secretThreadInclude,
    });
    return { thread };
  });

  if ("ok" in outcome) return outcome;
  return { ok: true, conversationId, peerDeviceId: deviceId, participantIds, thread: outcome.thread };
}

/** Минимум от socket.io-сервера, нужный для рассылки (getIO() в HTTP, io в сокете). */
type RoomEmitter = { to(room: string): { emit(...args: any[]): unknown } };

/**
 * Разослать «принято» после успешного acceptSecretThread — ОДНА реализация для HTTP и сокета.
 *
 * Гонка accept ↔ decline: accept коммитит ACTIVE и только потом рассылает события, а decline
 * (условный UPDATE без ожидания accept) может между ними перевести тред в CANCELLED и разослать
 * `conversations:deleted`. Тогда последними у клиентов оказались бы `secret:chat:accepted` и
 * `conversations:updated` (ACTIVE) уже отменённого треда: веб создателя по accepted начал бы
 * отдавать thread_key в отменённый тред, а принявший получил бы 200.
 *
 * Поэтому статус перечитываем ПОСЛЕ рассылки (перечитка ДО неё окно не закрывает: decline мог бы
 * закоммитить и разослать между перечиткой и emit). Если тред уже CANCELLED (или удалён), ещё раз
 * шлём `conversations:deleted` участникам и возвращаем false — вызывающий отвечает 409. Если
 * decline закоммитил ПОСЛЕ перечитки, его собственный `conversations:deleted` уйдёт позже наших
 * событий. В обоих случаях последним событием у клиентов будет deleted.
 *
 * true — тред на момент перечитки живой (или перечитать не удалось: тогда ведём себя как раньше).
 */
export async function announceSecretThreadAccepted(
  io: RoomEmitter | null | undefined,
  result: SecretAcceptSuccess,
): Promise<boolean> {
  const rooms = result.participantIds.map((pid) => `user:${pid}`);
  for (const room of rooms) {
    io?.to(room).emit("secret:chat:accepted", { conversationId: result.conversationId, peerDeviceId: result.peerDeviceId });
    io?.to(room).emit("conversations:updated", { conversationId: result.conversationId, conversation: result.thread });
  }
  let row: { secretStatus?: unknown } | null;
  try {
    row = (await prisma.conversation.findUnique({
      where: { id: result.conversationId },
      select: { secretStatus: true },
    })) as any;
  } catch {
    return true;
  }
  if (row && row.secretStatus !== "CANCELLED") return true;
  for (const room of rooms) {
    io?.to(room).emit("conversations:deleted", { conversationId: result.conversationId });
  }
  return false;
}

/** Отклонить (собеседник) или отменить (создатель) — любой участник; → CANCELLED. */
export async function declineSecretThread(params: {
  userId: string;
  conversationId: string;
}): Promise<SecretDeclineSuccess | SecretThreadFailure> {
  const { userId, conversationId } = params;
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { select: { userId: true } } },
  });
  const c = conv as any;
  if (!conv || c.type !== "SECRET" || c.isGroup) return NOT_FOUND();
  const participantIds: string[] = c.participants.map((p: any) => p.userId);
  if (!participantIds.includes(userId)) return FORBIDDEN();
  if (c.secretStatus === "CANCELLED") return { ok: true, conversationId, changed: false, participantIds };

  const res = await prisma.conversation.updateMany({
    where: { id: conversationId, type: "SECRET", secretStatus: { not: "CANCELLED" } } as any,
    data: { secretStatus: "CANCELLED" } as any,
  });
  return { ok: true, conversationId, changed: res.count > 0, participantIds };
}
