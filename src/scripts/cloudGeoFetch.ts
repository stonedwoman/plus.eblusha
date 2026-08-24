/**
 * Разовая загрузка справочника мест GeoNames для обратного геокодирования.
 *
 *   npx ts-node src/scripts/cloudGeoFetch.ts
 *
 * Кладёт cities500.txt в CLOUD_STORAGE_ROOT/geo. Файл около 30 МБ, ~235 тысяч
 * населённых пунктов с населением от 500 человек плюс все административные
 * центры. Лицензия CC BY 4.0 — источник указан в docs/eblusha-cloud.md.
 *
 * Обновлять имеет смысл раз в несколько месяцев: список городов меняется
 * медленно, а обработка снимков от свежести справочника не зависит.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import cloudConfig from "../cloud/config";

const CITIES_URL = "https://download.geonames.org/export/dump/cities500.zip";
const ALT_URL = "https://download.geonames.org/export/dump/alternateNamesV2.zip";

async function download(url: string, into: string, name: string): Promise<string> {
  console.log(`Качаем ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GeoNames ответил ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  console.log(`  получено ${(zip.length / 1024 / 1024).toFixed(1)} МБ`);
  const zipPath = path.join(into, name + ".zip");
  await fsp.writeFile(zipPath, zip);
  const unzip = spawnSync("unzip", ["-o", "-q", zipPath, "-d", into], { stdio: "inherit" });
  if (unzip.status !== 0) throw new Error("не удалось распаковать архив (нужен unzip)");
  return path.join(into, name + ".txt");
}

async function main(): Promise<void> {
  const dir = path.join(cloudConfig.CLOUD_STORAGE_ROOT, "geo");
  const target = path.join(dir, "cities500.txt");
  const namesTarget = path.join(dir, "names-ru.tsv");
  await fsp.mkdir(dir, { recursive: true });

  // Распаковываем во временный каталог: битая загрузка не должна затирать
  // уже работающий справочник.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "geonames-"));
  try {
    const cities = await download(CITIES_URL, tmp, "cities500");
    const size = (await fsp.stat(cities)).size;
    if (size < 5_000_000) throw new Error(`подозрительно маленький файл: ${size} байт`);
    await fsp.copyFile(cities, target);
    const lines = fs.readFileSync(target, "utf8").split("\n").length;
    console.log(`Готово: ${target}, ${lines.toLocaleString("ru-RU")} строк`);

    /*
     * Русские названия берём из отдельного справочника с ЯЗЫКОВЫМИ метками.
     * Без него приходилось угадывать по списку alternatenames, где языки
     * перемешаны, и выходило «Парис» вместо «Парижа»: транслитерация ближе к
     * оригиналу, чем принятое русское имя. Архив тяжёлый (~190 МБ), поэтому
     * из него сразу отбираем только русские строки нужных мест.
     */
    const wanted = new Set<string>();
    for (const line of fs.readFileSync(target, "utf8").split("\n")) {
      const id = line.slice(0, line.indexOf("\t"));
      if (id) wanted.add(id);
    }
    const alt = await download(ALT_URL, tmp, "alternateNamesV2");
    const best = new Map<string, { name: string; rank: number }>();
    /*
     * Строго построчно: распакованный справочник — около полутора гигабайт, а
     * строка в Node ограничена примерно половиной гигабайта, и readFileSync на
     * нём падает с «Cannot create a string longer than…».
     */
    const rl = readline.createInterface({ input: fs.createReadStream(alt, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      const f = line.split("\t");
      if (f[2] !== "ru") continue;
      const id = f[1] ?? "";
      if (!wanted.has(id)) continue;
      const name = (f[3] ?? "").trim();
      if (!name) continue;
      // Предпочитаем помеченное как предпочтительное, затем короткое, затем
      // первое встреченное; исторические и уменьшительные — в последнюю очередь.
      const rank = (f[4] === "1" ? 0 : 4) + (f[5] === "1" ? 1 : 0) + (f[6] === "1" ? 8 : 0) + (f[7] === "1" ? 8 : 0);
      const prev = best.get(id);
      if (!prev || rank < prev.rank) best.set(id, { name, rank });
    }
    rl.close();
    const out = [...best].map(([id, v]) => `${id}\t${v.name}`).join("\n");
    await fsp.writeFile(namesTarget, out, "utf8");
    console.log(`Готово: ${namesTarget}, ${best.size.toLocaleString("ru-RU")} русских названий`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Не получилось:", err instanceof Error ? err.message : err);
  process.exit(1);
});
