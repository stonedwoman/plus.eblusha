"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const livekit_server_sdk_1 = require("livekit-server-sdk");
const zod_1 = require("zod");
const env_1 = __importDefault(require("../config/env"));
const auth_1 = require("../middlewares/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const tokenSchema = zod_1.z.object({
    room: zod_1.z.string().min(3),
    participantName: zod_1.z.string().min(1).optional(),
    participantMetadata: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
});
router.post("/token", async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid token request" });
        return;
    }
    const { room, participantName, participantMetadata } = parsed.data;
    const user = req.user;
    const opts = {
        identity: user.id,
        name: participantName ?? user.displayName ?? user.username,
    };
    if (participantMetadata) {
        opts.metadata = JSON.stringify(participantMetadata);
    }
    const token = new livekit_server_sdk_1.AccessToken(env_1.default.LIVEKIT_API_KEY, env_1.default.LIVEKIT_API_SECRET, opts);
    token.addGrant({
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        // required for LiveKit data channel messages (used for ping exchange, etc.)
        canPublishData: true,
    });
    const jwt = await token.toJwt();
    res.json({ token: jwt, url: env_1.default.LIVEKIT_URL });
});
exports.default = router;
//# sourceMappingURL=livekit.js.map