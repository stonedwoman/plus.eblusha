import { Router } from "express";
import authRouter from "./auth";
import contactsRouter from "./contacts";
import conversationsRouter from "./conversations";
import livekitRouter from "./livekit";
import messagesRouter from "./messages";
import mobileRouter from "./mobile";
import statusRouter from "./status";
import uploadRouter from "./upload";
import attachmentsRouter from "./attachments";
import devicesRouter from "./devices";
import filesRouter from "./files";
import secretRouter from "./secret";
import callsRouter from "./calls";
import threadsRouter from "./threads";
import e2eeRouter from "./e2ee";
import debugRouter from "./debug";
import adminRouter from "./admin";

const router = Router();

router.use("/auth", authRouter);
router.use("/contacts", contactsRouter);
router.use("/conversations", conversationsRouter);
router.use("/livekit", livekitRouter);
router.use("/calls", callsRouter);
router.use("/messages", messagesRouter);
router.use("/mobile", mobileRouter);
router.use("/status", statusRouter);
router.use("/upload", uploadRouter);
router.use("/attachments", attachmentsRouter);
router.use("/devices", devicesRouter);
router.use("/files", filesRouter);
router.use("/secret", secretRouter);
router.use("/threads", threadsRouter);
router.use("/e2ee", e2eeRouter);
router.use("/debug", debugRouter);
router.use("/admin", adminRouter);

router.get("/", (_req, res) => {
  res.json({ message: "Eblusha API" });
});

export default router;

