import { sign, verify, type Secret } from "jsonwebtoken";
import env from "../config/env";

type JwtPayload = Record<string, unknown>;

const accessSecret: Secret = env.JWT_SECRET as unknown as Secret;
const refreshSecret: Secret = env.JWT_REFRESH_SECRET as unknown as Secret;

export function signAccessToken(payload: JwtPayload): string {
  return sign(payload, accessSecret, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as unknown as number,
  });
}

export function signRefreshToken(payload: JwtPayload): string {
  return sign(payload, refreshSecret, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as unknown as number,
  });
}

export function verifyAccessToken<T extends JwtPayload>(token: string): T {
  return verify(token, accessSecret) as unknown as T;
}

export function verifyRefreshToken<T extends JwtPayload>(token: string): T {
  return verify(token, refreshSecret) as unknown as T;
}


