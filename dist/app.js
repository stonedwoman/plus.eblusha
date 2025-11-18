"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const morgan_1 = __importDefault(require("morgan"));
const env_1 = __importDefault(require("./config/env"));
const routes_1 = __importDefault(require("./routes"));
const app = (0, express_1.default)();
// Respect reverse proxy headers (X-Forwarded-*) so we can generate correct absolute URLs
app.set("trust proxy", true);
app.use((0, helmet_1.default)({
    // Allow cross-origin loading of static uploads in <img> tags
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use((0, cors_1.default)({
    origin: env_1.default.CLIENT_URL ?? true,
    credentials: true,
}));
app.use((0, compression_1.default)({
    threshold: 0,
}));
app.use(express_1.default.json({ limit: "10mb" }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
app.use((0, morgan_1.default)(env_1.default.NODE_ENV === "development" ? "dev" : "combined"));
app.use("/api", routes_1.default);
app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});
exports.default = app;
//# sourceMappingURL=app.js.map