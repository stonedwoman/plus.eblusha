import { Router, type Request } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/auth";
import prisma from "../lib/prisma";
import { getOrCreateCallE2eeKey } from "../lib/callE2ee";

const router = Router();

router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string } };

const paramsSchema = z.object({
  callId: z.string().min(3),
});

// Шифрование звонков 1:1 включено всегда: рубильника E2EE_1TO1 больше нет. Раньше он отдавал
// здесь 404, а старые телефоны на любую ошибку ключа собирали комнату БЕЗ шифрования.
router.get("/:callId/e2ee-key", async (req, res) => {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid call id" });
    return;
  }

  const callId = parsed.data.callId;
  const userId = (req as AuthedRequest).user!.id;

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: callId, userId },
    select: { id: true },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: callId },
    select: { id: true, isGroup: true },
  });
  if (!conv || conv.isGroup) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const participantCount = await prisma.conversationParticipant.count({
    where: { conversationId: callId },
  });
  if (participantCount !== 2) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  // Create-if-absent so caller (who fetches around invite time) and callee converge on
  // ONE stable key, independent of fetch ordering / invite regeneration.
  const key = await getOrCreateCallE2eeKey(callId);

  // Never cache key responses.
  res.setHeader("Cache-Control", "no-store");
  res.json({ key });
});

export default router;

