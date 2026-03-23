import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { sign, verify } from "jsonwebtoken";
import env from "../config/env";
import prisma from "./prisma";

const REGISTRATION_INVITE_CODE_DIGITS = 8;
const REGISTRATION_INVITE_WINDOW_MS = 60_000;
const REGISTRATION_INVITE_GRANT_TTL_SECONDS = 10 * 60;

const registrationInviteGrantSecret = crypto
  .createHash("sha256")
  .update(`${env.JWT_REFRESH_SECRET}:registration-invite-grant`)
  .digest("hex");

const inviterSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

export type RegistrationInviteInviter = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type RegistrationInviteCodeView = {
  code: string;
  expiresAt: Date;
  inviter: RegistrationInviteInviter;
};

type GetRegistrationInviteCodeOptions = {
  forceRotate?: boolean;
};

function getInviteWindow(now = new Date()): { minuteBucket: bigint; expiresAt: Date } {
  const nowMs = now.getTime();
  const currentBucket = Math.floor(nowMs / REGISTRATION_INVITE_WINDOW_MS);
  return {
    minuteBucket: BigInt(currentBucket),
    expiresAt: new Date(nowMs + REGISTRATION_INVITE_WINDOW_MS),
  };
}

function generateInviteCodeDigits(length: number): string {
  let value = "";
  while (value.length < length) {
    value += crypto.randomInt(0, 10).toString();
  }
  return value;
}

function isUniqueCodeConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2002") return false;
  const target =
    Array.isArray(error.meta?.target)
      ? error.meta.target.map((item) => String(item))
      : typeof error.meta?.target === "string"
        ? [error.meta.target]
        : [];
  return target.length === 0 || target.includes("code");
}

export function normalizeRegistrationInviteCode(value: unknown): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, REGISTRATION_INVITE_CODE_DIGITS);
}

export async function getCurrentRegistrationInviteCodeForUser(
  userId: string,
  now = new Date(),
  options: GetRegistrationInviteCodeOptions = {}
): Promise<RegistrationInviteCodeView> {
  const { minuteBucket, expiresAt } = getInviteWindow(now);
  const forceRotate = options.forceRotate === true;

  const existing = await prisma.registrationInviteCode.findUnique({
    where: { userId },
    include: { user: { select: inviterSelect } },
  });

  if (
    !forceRotate &&
    existing &&
    existing.expiresAt.getTime() > now.getTime()
  ) {
    return {
      code: existing.code,
      expiresAt: existing.expiresAt,
      inviter: existing.user,
    };
  }

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const code = generateInviteCodeDigits(REGISTRATION_INVITE_CODE_DIGITS);
    try {
      const record = await prisma.registrationInviteCode.upsert({
        where: { userId },
        update: {
          code,
          minuteBucket,
          expiresAt,
        },
        create: {
          userId,
          code,
          minuteBucket,
          expiresAt,
        },
        include: { user: { select: inviterSelect } },
      });

      return {
        code: record.code,
        expiresAt: record.expiresAt,
        inviter: record.user,
      };
    } catch (error) {
      if (isUniqueCodeConflict(error)) continue;
      throw error;
    }
  }

  throw new Error("Unable to generate registration invite code");
}

export async function refreshRegistrationInviteCodeForUser(
  userId: string,
  now = new Date()
): Promise<RegistrationInviteCodeView> {
  return getCurrentRegistrationInviteCodeForUser(userId, now, { forceRotate: true });
}

export async function resolveRegistrationInviteCode(
  codeRaw: string,
  now = new Date()
): Promise<RegistrationInviteCodeView | null> {
  const code = normalizeRegistrationInviteCode(codeRaw);
  if (code.length !== REGISTRATION_INVITE_CODE_DIGITS) {
    return null;
  }

  const record = await prisma.registrationInviteCode.findUnique({
    where: { code },
    include: { user: { select: inviterSelect } },
  });

  if (!record || record.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  return {
    code: record.code,
    expiresAt: record.expiresAt,
    inviter: record.user,
  };
}

export function issueRegistrationInviteGrant(inviterId: string): string {
  return sign(
    {
      kind: "registration_invite",
      inviterId,
    },
    registrationInviteGrantSecret,
    { expiresIn: REGISTRATION_INVITE_GRANT_TTL_SECONDS }
  );
}

export function verifyRegistrationInviteGrant(token: string): { inviterId: string } {
  const payload = verify(token, registrationInviteGrantSecret) as {
    kind?: string;
    inviterId?: string;
  };

  if (payload.kind !== "registration_invite" || typeof payload.inviterId !== "string") {
    throw new Error("Invalid registration invite grant");
  }

  const inviterId = payload.inviterId.trim();
  if (!inviterId) {
    throw new Error("Invalid registration invite grant");
  }

  return { inviterId };
}

export function getRegistrationInviteCodeDigits(): number {
  return REGISTRATION_INVITE_CODE_DIGITS;
}
