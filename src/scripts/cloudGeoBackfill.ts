/**
 * Проставить место съёмки уже загруженным файлам.
 *
 *   npx ts-node src/scripts/cloudGeoBackfill.ts          # только необработанные
 *   npx ts-node src/scripts/cloudGeoBackfill.ts --all    # пересчитать всё заново
 *
 * Нужен после первой установки справочника и после его обновления. Гоняет
 * пачками и ничего не удаляет: файлы без координат просто пропускаются.
 */
import prisma from "../lib/prisma";
import { geoDatasetPath, resolvePlace } from "../cloud/geo/reverse";
import fs from "node:fs";

const BATCH = 500;

async function main(): Promise<void> {
  if (!fs.existsSync(geoDatasetPath())) {
    console.error(`Нет справочника мест: ${geoDatasetPath()}`);
    console.error("Сначала: npx ts-node src/scripts/cloudGeoFetch.ts");
    process.exit(1);
  }

  const all = process.argv.includes("--all");
  let cursor: string | null = null;
  let seen = 0;
  let placed = 0;
  const tally = new Map<string, number>();

  for (;;) {
    // Явный тип: cursor участвует в собственной инициализации, и вывод типов
    // без подсказки уходит в any.
    const rows: { id: string; latitude: number | null; longitude: number | null }[] =
      await prisma.cloudFile.findMany({
        where: {
          latitude: { not: null },
          longitude: { not: null },
          ...(all ? {} : { geoResolvedAt: null }),
        },
        select: { id: true, latitude: true, longitude: true },
        orderBy: { id: "asc" },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      seen++;
      const place = resolvePlace(row.latitude!, row.longitude!);
      if (!place) continue;
      await prisma.cloudFile.update({
        where: { id: row.id },
        data: {
          geoCountryCode: place.countryCode,
          geoCountry: place.country,
          geoCity: place.city,
          geoDistrict: place.district,
          geoPath: place.path,
          geoResolvedAt: new Date(),
        },
      });
      placed++;
      const label = [place.country, place.city, place.district].filter(Boolean).join(" · ");
      tally.set(label, (tally.get(label) ?? 0) + 1);
    }
    console.log(`  обработано ${seen}, распознано ${placed}`);
  }

  console.log(`\nИтого: ${placed} из ${seen} файлов с координатами получили место.`);
  for (const [label, count] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)} × ${label}`);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
