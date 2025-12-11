"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const express_1 = __importDefault(require("express"));
const app_1 = __importDefault(require("./app"));
const env_1 = __importDefault(require("./config/env"));
const logger_1 = __importDefault(require("./config/logger"));
const socket_1 = require("./realtime/socket");
const port = env_1.default.PORT;
// static serving for uploads with permissive cross-origin headers for images
const uploadsPath = path_1.default.join(process.cwd(), 'uploads');
if (!fs_1.default.existsSync(uploadsPath)) {
    fs_1.default.mkdirSync(uploadsPath, { recursive: true });
}
const staticOptions = {
    dotfiles: 'deny',
    etag: true,
    fallthrough: true, // Allow request to continue if file not found
    index: false,
    lastModified: true,
    maxAge: '1y',
};
// Middleware to set CORS headers for uploads
const uploadsCors = (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
};
app_1.default.use('/uploads', uploadsCors, express_1.default.static(uploadsPath, staticOptions));
app_1.default.use('/api/uploads', uploadsCors, express_1.default.static(uploadsPath, staticOptions), (req, res) => {
    // If file not found, return 404 with proper headers
    if (!res.headersSent) {
        res.status(404).json({ message: 'File not found' });
    }
});
const httpServer = http_1.default.createServer(app_1.default);
(0, socket_1.initSocket)(httpServer);
httpServer.listen(port, () => {
    logger_1.default.info(`Server listening on port ${port}`);
});
process.on("SIGTERM", () => {
    httpServer.close(() => {
        logger_1.default.info("SIGTERM received: shutting down gracefully");
        process.exit(0);
    });
});
process.on("SIGINT", () => {
    httpServer.close(() => {
        logger_1.default.info("SIGINT received: shutting down gracefully");
        process.exit(0);
    });
});
//# sourceMappingURL=server.js.map