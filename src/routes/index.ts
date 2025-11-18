import { Router } from "express";
import authRouter from "./auth";
import contactsRouter from "./contacts";
import conversationsRouter from "./conversations";
import livekitRouter from "./livekit";
import messagesRouter from "./messages";
import statusRouter from "./status";
import uploadRouter from "./upload";
import devicesRouter from "./devices";

const router = Router();

router.use("/auth", authRouter);
router.use("/contacts", contactsRouter);
router.use("/conversations", conversationsRouter);
router.use("/livekit", livekitRouter);
router.use("/messages", messagesRouter);
router.use("/status", statusRouter);
router.use("/upload", uploadRouter);
router.use("/devices", devicesRouter);

router.get("/", (_req, res) => {
  res.json({ message: "Eblusha API" });
});

export default router;

