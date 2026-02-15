import { Router, type Request } from "express";
import { z } from "zod";
import env from "../config/env";
import { authenticate } from "../middlewares/auth";
import prisma from "../lib/prisma";
import { getCallE2eeKey } from "../lib/callE2ee";

const router = Router();

router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string } };

const paramsSchema = z.object({
  callId: z.string().min(3),
});

router.get("/:callId/e2ee-key", async (req, res) => {
  // Feature flag: when disabled, behave as "not found" so clients can fall back if desired.
  if (!env.E2EE_1TO1) {
    res.status(404).json({ message: "Not found" });
    return;
  }

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

  const key = await getCallE2eeKey(callId);
  if (!key) {
    res.status(404).json({ message: "E2EE key not found" });
    return;
  }

  // Never cache key responses.
  res.setHeader("Cache-Control", "no-store");
  res.json({ key });
});

export default router;

