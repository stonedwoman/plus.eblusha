"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const auth_1 = require("../middlewares/auth");
const router = (0, express_1.Router)();
const uploadDir = path_1.default.join(process.cwd(), 'uploads');
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname || '') || '.png';
        const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        cb(null, name);
    }
});
// Increase max size to 100MB to support typical documents/archives
const upload = (0, multer_1.default)({ storage, limits: { fileSize: 100 * 1024 * 1024 } });
router.use(auth_1.authenticate);
router.post('/', upload.single('file'), (req, res) => {
    const file = req.file;
    if (!file) {
        res.status(400).json({ message: 'No file' });
        return;
    }
    // Serve via static mapping under /uploads
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
    const protocol = forwardedProto || req.protocol;
    const host = forwardedHost || req.get('host') || req.hostname;
    const relativeUrl = `/api/uploads/${file.filename}`;
    const origin = host ? `${protocol}://${host}` : undefined;
    const absoluteUrl = origin ? new URL(relativeUrl, origin).toString() : relativeUrl;
    res.json({ url: absoluteUrl, path: relativeUrl });
});
exports.default = router;
//# sourceMappingURL=upload.js.map