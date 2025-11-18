"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAccessToken = signAccessToken;
exports.signRefreshToken = signRefreshToken;
exports.verifyAccessToken = verifyAccessToken;
exports.verifyRefreshToken = verifyRefreshToken;
const jsonwebtoken_1 = require("jsonwebtoken");
const env_1 = __importDefault(require("../config/env"));
const accessSecret = env_1.default.JWT_SECRET;
const refreshSecret = env_1.default.JWT_REFRESH_SECRET;
function signAccessToken(payload) {
    return (0, jsonwebtoken_1.sign)(payload, accessSecret, {
        expiresIn: env_1.default.JWT_ACCESS_EXPIRES_IN,
    });
}
function signRefreshToken(payload) {
    return (0, jsonwebtoken_1.sign)(payload, refreshSecret, {
        expiresIn: env_1.default.JWT_REFRESH_EXPIRES_IN,
    });
}
function verifyAccessToken(token) {
    return (0, jsonwebtoken_1.verify)(token, accessSecret);
}
function verifyRefreshToken(token) {
    return (0, jsonwebtoken_1.verify)(token, refreshSecret);
}
//# sourceMappingURL=jwt.js.map