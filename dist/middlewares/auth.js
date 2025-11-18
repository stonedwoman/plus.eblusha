"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticate = authenticate;
const prisma_1 = __importDefault(require("../lib/prisma"));
const jwt_1 = require("../utils/jwt");
const logger_1 = __importDefault(require("../config/logger"));
async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;
    if (!token) {
        res.status(401).json({ message: "Unauthorized" });
        return;
    }
    try {
        const payload = (0, jwt_1.verifyAccessToken)(token);
        const user = await prisma_1.default.user.findUnique({
            where: { id: payload.sub },
            select: { id: true, username: true, displayName: true },
        });
        if (!user) {
            res.status(401).json({ message: "Unauthorized" });
            return;
        }
        const r = req;
        r.user = user;
        r.accessTokenId = payload.tokenId;
        next();
    }
    catch (error) {
        logger_1.default.warn({ error }, "Auth middleware error");
        res.status(401).json({ message: "Unauthorized" });
    }
}
//# sourceMappingURL=auth.js.map