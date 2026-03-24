#!/usr/bin/env npx ts-node
/**
 * Список пользователей для ревизии: дата регистрации и последняя активность.
 *
 * Поля:
 * - createdAt — момент создания учётной записи
 * - lastSeenAt — поле User (присутствие/офлайн и т.п.; может быть null)
 * - devicesLastSeenMax — максимум lastSeenAt по устройствам (если User пустой)
 * - lastVisitEffective — max(User.lastSeenAt, devicesLastSeenMax)
 *
 * Usage:
 *   npx ts-node src/scripts/listUsersAudit.ts
 *   npx ts-node src/scripts/listUsersAudit.ts --csv
 */

import dotenv from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const csv = process.argv.includes("--csv");

function maxDate(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function iso(d: Date | null | undefined): string {
  return d ? d.toISOString() : "";
}

function escCsv(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (.env / .env.local).");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        eblid: true,
        createdAt: true,
        lastSeenAt: true,
        devices: {
          where: { revokedAt: null },
          select: { lastSeenAt: true },
        },
        registrationInviteCode: { select: { code: true } },
      },
    });

    const rows = users.map((u) => {
      let devicesMax: Date | null = null;
      for (const d of u.devices) {
        devicesMax = maxDate(devicesMax, d.lastSeenAt);
      }
      const lastVisitEffective = maxDate(u.lastSeenAt, devicesMax);
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName ?? "",
        email: u.email ?? "",
        eblid: u.eblid ?? "",
        registeredAt: u.createdAt,
        userLastSeenAt: u.lastSeenAt,
        devicesLastSeenMax: devicesMax,
        lastVisitEffective,
        hasInviteRow: u.registrationInviteCode != null,
        deviceCount: u.devices.length,
      };
    });

    if (csv) {
      const header = [
        "id",
        "username",
        "displayName",
        "email",
        "eblid",
        "registeredAt",
        "userLastSeenAt",
        "devicesLastSeenMax",
        "lastVisitEffective",
        "hasInviteRow",
        "deviceCount",
      ];
      console.log(header.join(","));
      for (const r of rows) {
        console.log(
          [
            escCsv(r.id),
            escCsv(r.username),
            escCsv(r.displayName),
            escCsv(r.email),
            escCsv(r.eblid),
            escCsv(iso(r.registeredAt)),
            escCsv(iso(r.userLastSeenAt)),
            escCsv(iso(r.devicesLastSeenMax)),
            escCsv(iso(r.lastVisitEffective)),
            r.hasInviteRow ? "1" : "0",
            String(r.deviceCount),
          ].join(",")
        );
      }
      return;
    }

    console.log(JSON.stringify(rows, null, 2));
    console.error(`\nTotal: ${rows.length} users`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
