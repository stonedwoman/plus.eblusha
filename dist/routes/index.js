"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = __importDefault(require("./auth"));
const contacts_1 = __importDefault(require("./contacts"));
const conversations_1 = __importDefault(require("./conversations"));
const livekit_1 = __importDefault(require("./livekit"));
const messages_1 = __importDefault(require("./messages"));
const status_1 = __importDefault(require("./status"));
const upload_1 = __importDefault(require("./upload"));
const devices_1 = __importDefault(require("./devices"));
const router = (0, express_1.Router)();
router.use("/auth", auth_1.default);
router.use("/contacts", contacts_1.default);
router.use("/conversations", conversations_1.default);
router.use("/livekit", livekit_1.default);
router.use("/messages", messages_1.default);
router.use("/status", status_1.default);
router.use("/upload", upload_1.default);
router.use("/devices", devices_1.default);
router.get("/", (_req, res) => {
    res.json({ message: "Eblusha API" });
});
exports.default = router;
//# sourceMappingURL=index.js.map