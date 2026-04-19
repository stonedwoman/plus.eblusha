#!/usr/bin/env npx ts-node
/**
 * Remove stale/overflowing device prekeys from Postgres.
 *
 * Covers:
 * - consumed prekeys older than a retention window
 * - unconsumed prekeys beyond a per-device cap (keeps the newest ones)
 *
 * Usage:
 *   npx ts-node src/scripts/gcDevicePrekeys.ts
 *   npx ts-node src/scripts/gcDevicePrekeys.ts --delete
 *   npx ts-node src/scripts/gcDevicePrekeys.ts --delete --max-unconsumed-per-device 250
 *   npx ts-node src/scripts/gcDevicePrekeys.ts --delete --delete-consumed-older-than-days 14
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const doDelete = process.argv.includes("--delete");

function readFlagValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

const maxUnconsumedPerDevice = Math.max(
  1,
  Number(readFlagValue("--max-unconsumed-per-device") ?? process.env.DEVICE_PREKEY_MAX_UNCONSUMED ?? "250")
);
const consumedRetentionDays = Math.max(
  1,
  Number(
    readFlagValue("--delete-consumed-older-than-days") ??
      process.env.DEVICE_PREKEY_CONSUMED_RETENTION_DAYS ??
      "14"
  )
);
const batchSize = Math.max(
  100,
  Number(readFlagValue("--batch-size") ?? process.env.DEVICE_PREKEY_GC_BATCH_SIZE ?? "1000")
);
const consumedCutoff = new Date(Date.now() - consumedRetentionDays * 24 * 60 * 60 * 1000);

type OverflowSummaryRow = {
  deviceId: string;
  total: number;
  overflow: number;
};

async function getOverflowSummary(): Promise<{
  overflowRows: number;
  overflowDeviceCount: number;
  topOverflowDevices: OverflowSummaryRow[];
}> {
  const grouped = await prisma.devicePrekey.groupBy({
    by: ["deviceId"],
    where: { consumedAt: null },
    _count: { _all: true },
  });

  const overflowed = grouped
    .map((row) => {
      const total = row._count._all;
      return {
        deviceId: row.deviceId,
        total,
        overflow: Math.max(0, total - maxUnconsumedPerDevice),
      };
    })
    .filter((row) => row.overflow > 0)
    .sort((a, b) => b.overflow - a.overflow);

  return {
    overflowRows: overflowed.reduce((sum, row) => sum + row.overflow, 0),
    overflowDeviceCount: overflowed.length,
    topOverflowDevices: overflowed.slice(0, 20),
  };
}

async function countStaleConsumedRows(): Promise<number> {
  return prisma.devicePrekey.count({
    where: {
      consumedAt: {
        not: null,
        lt: consumedCutoff,
      },
    },
  });
}

async function deleteStaleConsumedBatch(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH doomed AS (
      SELECT "id"
      FROM "DevicePrekey"
      WHERE "consumedAt" IS NOT NULL
        AND "consumedAt" < ${consumedCutoff}
      ORDER BY "consumedAt" ASC
      LIMIT ${batchSize}
    )
    DELETE FROM "DevicePrekey"
    WHERE "id" IN (SELECT "id" FROM doomed)
    RETURNING "id"
  `;
  return rows.length;
}

async function deleteOverflowUnconsumedBatch(): Promise<Array<{ deviceId: string }>> {
  return prisma.$queryRaw<Array<{ deviceId: string }>>`
    WITH ranked AS (
      SELECT
        "id",
        "deviceId",
        ROW_NUMBER() OVER (PARTITION BY "deviceId" ORDER BY "createdAt" DESC) AS row_num
      FROM "DevicePrekey"
      WHERE "consumedAt" IS NULL
    ),
    doomed AS (
      SELECT "id", "deviceId"
      FROM ranked
      WHERE row_num > ${maxUnconsumedPerDevice}
      LIMIT ${batchSize}
    )
    DELETE FROM "DevicePrekey"
    WHERE "id" IN (SELECT "id" FROM doomed)
    RETURNING "deviceId"
  `;
}

async function main() {
  const [overflowSummary, staleConsumedRows] = await Promise.all([
    getOverflowSummary(),
    countStaleConsumedRows(),
  ]);

  if (!doDelete) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          maxUnconsumedPerDevice,
          consumedRetentionDays,
          batchSize,
          staleConsumedRows,
          overflowRows: overflowSummary.overflowRows,
          overflowDeviceCount: overflowSummary.overflowDeviceCount,
          topOverflowDevices: overflowSummary.topOverflowDevices,
        },
        null,
        2
      )
    );
    return;
  }

  let deletedConsumedRows = 0;
  while (true) {
    const deleted = await deleteStaleConsumedBatch();
    if (!deleted) break;
    deletedConsumedRows += deleted;
    console.log(`[gcDevicePrekeys] deleted stale consumed rows: +${deleted}, total=${deletedConsumedRows}`);
  }

  let deletedOverflowRows = 0;
  const deletedOverflowByDevice = new Map<string, number>();
  while (true) {
    const deletedRows = await deleteOverflowUnconsumedBatch();
    if (!deletedRows.length) break;
    deletedOverflowRows += deletedRows.length;
    for (const row of deletedRows) {
      const deviceId = String(row.deviceId ?? "");
      if (!deviceId) continue;
      deletedOverflowByDevice.set(deviceId, (deletedOverflowByDevice.get(deviceId) ?? 0) + 1);
    }
    console.log(`[gcDevicePrekeys] deleted overflow rows: +${deletedRows.length}, total=${deletedOverflowRows}`);
  }

  console.log(
    JSON.stringify(
      {
        mode: "delete",
        maxUnconsumedPerDevice,
        consumedRetentionDays,
        batchSize,
        deletedConsumedRows,
        deletedOverflowRows,
        overflowDevicesTouched: deletedOverflowByDevice.size,
        topOverflowDevicesTouched: [...deletedOverflowByDevice.entries()]
          .map(([deviceId, deleted]) => ({ deviceId, deleted }))
          .sort((a, b) => b.deleted - a.deleted)
          .slice(0, 20),
      },
      null,
      2
    )
  );
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
