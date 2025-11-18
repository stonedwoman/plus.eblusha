type JwtPayload = Record<string, unknown>;
export declare function signAccessToken(payload: JwtPayload): string;
export declare function signRefreshToken(payload: JwtPayload): string;
export declare function verifyAccessToken<T extends JwtPayload>(token: string): T;
export declare function verifyRefreshToken<T extends JwtPayload>(token: string): T;
export {};
//# sourceMappingURL=jwt.d.ts.map