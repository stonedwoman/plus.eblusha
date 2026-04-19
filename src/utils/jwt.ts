import { sign, verify, type Secret, type SignOptions } from "jsonwebtoken";
import env from "../config/env";

type JwtPayload = Record<string, unknown>;

const accessSecret: Secret = env.JWT_SECRET as unknown as Secret;
const refreshSecret: Secret = env.JWT_REFRESH_SECRET as unknown as Secret;

type SignTokenOptions = {
  expiresInSeconds?: number;
};

function resolveTokenExpiry(
  fallback: string,
  options?: SignTokenOptions
): SignOptions["expiresIn"] {
  return typeof options?.expiresInSeconds === "number"
    ? options.expiresInSeconds
    : (fallback as SignOptions["expiresIn"]);
}

function signWithResolvedExpiry(
  payload: JwtPayload,
  secret: Secret,
  fallback: string,
  options?: SignTokenOptions
): string {
  const signOptions: SignOptions = {};
  const expiresIn = resolveTokenExpiry(fallback, options);
  if (expiresIn !== undefined) {
    signOptions.expiresIn = expiresIn;
  }
  return sign(payload, secret, signOptions);
}

export function signAccessToken(payload: JwtPayload, options?: SignTokenOptions): string {
  return signWithResolvedExpiry(payload, accessSecret, env.JWT_ACCESS_EXPIRES_IN, options);
}

export function signRefreshToken(payload: JwtPayload, options?: SignTokenOptions): string {
  return signWithResolvedExpiry(payload, refreshSecret, env.JWT_REFRESH_EXPIRES_IN, options);
}

export function verifyAccessToken<T extends JwtPayload>(token: string): T {
  return verify(token, accessSecret) as unknown as T;
}

export function verifyRefreshToken<T extends JwtPayload>(token: string): T {
  return verify(token, refreshSecret) as unknown as T;
}


