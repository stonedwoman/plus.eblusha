/**
 * Разовая загрузка моделей InsightFace buffalo_l (CC BY-NC — семейный
 * self-hosted инстанс, некоммерческое использование).
 *
 *   npx ts-node src/scripts/cloudFacesFetch.ts
 *
 * Кладёт det_10g.onnx (детектор SCRFD) и w600k_r50.onnx (ArcFace) в
 * CLOUD_STORAGE_ROOT/models/insightface. Архив ~275 МБ, качается один раз.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import cloudConfig from "../cloud/config";

const URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip";
const WANTED = ["det_10g.onnx", "w600k_r50.onnx"];

function findFile(root: string, name: string): string | null {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) return p;
  }
  return null;
}

async function main(): Promise<void> {
  const dir = path.join(cloudConfig.CLOUD_STORAGE_ROOT, "models", "insightface");
  await fsp.mkdir(dir, { recursive: true });
  if (WANTED.every((f) => fs.existsSync(path.join(dir, f)))) {
    console.log("Модели уже на месте:", dir);
    return;
  }
  console.log("Качаем", URL);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  console.log(`  получено ${(zip.length / 1024 / 1024).toFixed(1)} МБ`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "buffalo-"));
  try {
    const zipPath = path.join(tmp, "buffalo_l.zip");
    await fsp.writeFile(zipPath, zip);
    const unzip = spawnSync("unzip", ["-o", "-q", zipPath, "-d", tmp], { stdio: "inherit" });
    if (unzip.status !== 0) throw new Error("не удалось распаковать (нужен unzip)");
    for (const name of WANTED) {
      // Раскладка архива менялась между релизами: ищем файл по всему дереву.
      const found = findFile(tmp, name);
      if (!found) throw new Error(`в архиве нет ${name}`);
      await fsp.copyFile(found, path.join(dir, name));
      console.log("  →", path.join(dir, name));
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  console.log("Готово.");
}

main().catch((err) => {
  console.error("Не получилось:", err instanceof Error ? err.message : err);
  process.exit(1);
});
