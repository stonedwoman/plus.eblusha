import { Router, type Request, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import logger from "../config/logger";
import { authenticate } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rateLimit";
import { isSecretConversation } from "../lib/secretLatch";
import { CardError, cardHandler, cardOf, loadCardMessage } from "../lib/botCards";
// Регистрация типов карточек (registerCardType) — при импорте модулей типов.
import "../lib/promiseTimer";
import "../lib/botShare";

/**
 * /api/cards — карточки бота «Еблуша» для клиентов (docs/bot-cards.md):
 *   GET  /api/cards/:messageId                        → 200 { message, card, serverNow }
 *   POST /api/cards/:messageId/act { action, input? } → 200 { message, card, serverNow }
 * Ошибки — { message, code, card?, serverNow }: 404 CARD_NOT_FOUND (нет карточки / не участник / секретная беседа),
 * 400 CARD_BAD_INPUT, 403 CARD_FORBIDDEN, 409 CARD_CLOSED {card} / CARD_ACTION_EXPIRED {card},
 * 404 CARD_TYPE_DISABLED (BOT_SHARE=off), 429 RATE_LIMITED. Права решает сервер под замком строки типа.
 */
const router = Router();
router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string } };
const userId = (req: Request) => (req as AuthedRequest).user!.id;
const idSchema = z.string().cuid();

function fail(res: Response, status: number, code: string, message: string, card: unknown = null): void {
  res.status(status).json({ message, code, ...(card ? { card } : {}), serverNow: new Date().toISOString() });
}

/** Сообщение-карточка, которое зритель может видеть: участник обычной беседы. */
async function visibleCard(messageId: string, viewerId: string) {
  const loaded = await loadCardMessage(messageId);
  if (!loaded) return null;
  const conv = await prisma.conversation.findUnique({
    where: { id: loaded.message.conversationId },
    select: { type: true, isSecret: true, participants: { where: { userId: viewerId }, select: { id: true } } },
  });
  if (!conv || isSecretConversation(conv) || conv.participants.length === 0) return null;
  return loaded;
}

router.get("/:messageId", rateLimit({ name: "card_get", windowMs: 60_000, max: 120 }), async (req, res) => {
  const id = idSchema.safeParse(req.params.messageId);
  if (!id.success) return fail(res, 404, "CARD_NOT_FOUND", "No such card");
  const v = await visibleCard(id.data, userId(req));
  if (!v) return fail(res, 404, "CARD_NOT_FOUND", "No such card");
  res.json({ message: v.message, card: v.card, serverNow: new Date().toISOString() });
});

const actSchema = z.object({ action: z.string().min(1).max(32), input: z.unknown().optional() }).strict();

router.post("/:messageId/act", rateLimit({ name: "card", windowMs: 60_000, max: 30 }), async (req, res) => {
  const id = idSchema.safeParse(req.params.messageId);
  if (!id.success) return fail(res, 404, "CARD_NOT_FOUND", "No such card");
  const body = actSchema.safeParse(req.body ?? {});
  if (!body.success) return fail(res, 400, "CARD_BAD_INPUT", "Invalid payload");
  const viewer = userId(req);
  const v = await visibleCard(id.data, viewer);
  if (!v) return fail(res, 404, "CARD_NOT_FOUND", "No such card");
  const handler = cardHandler(v.card.type);
  if (!handler) return fail(res, 404, "CARD_NOT_FOUND", "No such card");
  if (!handler.enabled()) return fail(res, 404, "CARD_TYPE_DISABLED", "This card type is turned off", v.card);
  try {
    await handler.act({
      message: { id: v.message.id, conversationId: v.message.conversationId, metadata: v.message.metadata },
      card: v.card,
      userId: viewer,
      action: body.data.action,
      input: body.data.input,
      now: new Date(),
    });
  } catch (e) {
    if (e instanceof CardError) {
      const fresh = await loadCardMessage(id.data);
      return fail(res, e.status, e.code, e.message, e.card ?? (fresh ? cardOf(fresh.message.metadata) : null));
    }
    logger.error({ error: e, messageId: id.data, action: body.data.action }, "cards: act failed");
    return fail(res, 500, "CARD_ERROR", "Something went wrong");
  }
  const fresh = await loadCardMessage(id.data);
  if (!fresh) return fail(res, 404, "CARD_NOT_FOUND", "No such card");
  logger.info({ messageId: id.data, type: fresh.card.type, action: body.data.action, state: fresh.card.state }, "cards: act");
  res.json({ message: fresh.message, card: fresh.card, serverNow: new Date().toISOString() });
});

export default router;
