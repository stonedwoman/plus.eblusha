import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { OpsClient, OpsUnavailable } from "../../../src/modules/valheim/ops";
import { CARD_H, CARD_W, PLAYER_COLORS, playerColors, renderCard, ruPlural } from "../../../src/modules/valheim/render";
import type { Raster } from "../../../src/modules/valheim/raster";
import { fx } from "./vhfakes";

// ------------------------------------------------------------------ карточка карты
function plainMap(size: number, rgb: [number, number, number]): Raster {
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([...rgb, 255], i * 4);
  return { data, width: size, height: size, channels: 4 };
}

test("карточка: PNG нужного размера, туман притушивает неразведанное, север сверху", async () => {
  const size = 256; // мир ±1536 м при 12 м/пикс
  const map = plainMap(size, [200, 200, 200]);
  // туман: разведана только северная половина
  const fog: Raster = { data: Buffer.alloc(size * size), width: size, height: size, channels: 1 };
  for (let y = 0; y < size / 2; y++) fog.data.fill(255, y * size, (y + 1) * size);
  const card = await renderCard(map, fog, { texture_size: size, pixel_size: 12 }, {
    center: { x: 0, z: 0 },
    radiusM: 600,
    title: "IiApaCiOxa 🥕",
    subtitle: "Луга · день 345, 06:04",
    link: "v.koban.uk/map",
    markers: [
      { kind: "player", x: 0, z: 300, yaw: 90, label: "IiApaCiOxa", color: PLAYER_COLORS[0], focus: true },
      { kind: "player", x: 100, z: -300, dead: true, label: "РомаH" },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "portal" as const, x: -400 + i, z: 0, label: `П${i}` })),
      { kind: "home", x: -300, z: -300, label: "Дом" },
    ],
  });
  assert.equal(card.mime, "image/png");
  const { data, info } = await sharp(card.data).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, CARD_W);
  assert.equal(info.height, CARD_H);
  const px = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return data[i]! + data[i + 1]! + data[i + 2]!;
  };
  // точки на пустом месте карты: север (разведан) ярче юга (туман)
  const north = px(16 + 600, 16 + 120);
  const south = px(16 + 600, 16 + 600);
  assert.ok(north > south * 1.4, `${north} vs ${south}`);
  assert.ok(card.data.length < 1_500_000, `размер ${card.data.length}`);
});

test("цвета игроков — как у сайта (djb2 от имени, занятые пропускаются)", () => {
  const c = playerColors(["IiApaCiOxa", "РомаH", "Куралеска"]);
  assert.equal(new Set(c.values()).size, 3);
  // одно и то же имя дважды не встречается, но совпавший хэш берёт следующий свободный цвет
  const same = playerColors(["a", "a2", "a3", "a4", "a5", "a6"]);
  assert.equal(new Set(same.values()).size, 6);
  assert.equal(ruPlural(1, ["портал", "портала", "порталов"]), "портал");
  assert.equal(ruPlural(3, ["портал", "портала", "порталов"]), "портала");
  assert.equal(ruPlural(16, ["портал", "портала", "порталов"]), "порталов");
  assert.equal(ruPlural(22, ["портал", "портала", "порталов"]), "портала");
});

// ------------------------------------------------------------------ valheim-ops
test("клиент ops: нет сокета — понятная ошибка", async () => {
  await assert.rejects(new OpsClient(null).call("status"), OpsUnavailable);
  await assert.rejects(new OpsClient(path.join(os.tmpdir(), "nope-vh.sock")).call("status"), OpsUnavailable);
});

/** Настоящий valheim-ops.py в режиме проверки (OPS_DRY_RUN=1): ничего не запускает, карта — заглушка. */
test("valheim-ops.py (режим проверки): белый список, сверка настроек мира по /options", async (t) => {
  const py = ["python3", "python"].find((p) => {
    try {
      return spawnSync(p, ["--version"]).status === 0;
    } catch {
      return false;
    }
  });
  if (!py || process.platform === "win32") {
    t.skip("нет python3 или не Linux");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vhops-"));
  fs.mkdirSync(path.join(dir, "config", "worlds_local", "TestWorld"), { recursive: true });
  fs.writeFileSync(path.join(dir, "valheim.env"), "SERVER_NAME=Koban\nWORLD_NAME=TestWorld\n");
  const options = fx("map-options.json");
  const mapSrv = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/options" ? options : { ok: false }));
  });
  await new Promise<void>((r) => mapSrv.listen(0, "127.0.0.1", () => r()));
  const port = (mapSrv.address() as { port: number }).port;
  const sock = path.join(dir, "ops.sock");
  const script = path.resolve(process.cwd(), "ops/valheim-ops.py");
  const child = spawn(py, [script], {
    env: { ...process.env, OPS_DRY_RUN: "1", OPS_SOCKET: sock, OPS_LOG: path.join(dir, "ops.log"), OPS_MAP_URL: `http://127.0.0.1:${port}`, OPS_VALHEIM_DIR: dir, OPS_CONTAINER: "valheim-ops-test-none" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
    const ops = new OpsClient(sock);
    const st = await ops.call("status");
    assert.equal(st.ok, true);
    assert.equal((st.container as { running: boolean }).running, false);
    assert.deepEqual(await ops.call("options_set", { key: "ResourceRate", value: "5" }), { ok: true, applied: "Добыча ресурсов → x5", line: "set ResourceRate 5" });
    assert.deepEqual(await ops.call("options_set", { key: "NoBuildCost", value: "off" }), { ok: true, applied: "Бесплатная стройка → выкл", line: "unset NoBuildCost" });
    assert.equal((await ops.call("options_set", { key: "ResourceRate", value: "4" })).ok, false, "только значения из списка");
    assert.equal((await ops.call("options_set", { key: "ResourceRate", value: "3\nset NoMap" })).ok, false, "перевод строки не протащить");
    assert.equal((await ops.call("options_set", { key: "Bad Key", value: "1" })).ok, false);
    const b = await ops.call("backup_now");
    assert.equal(b.ok, true);
    assert.match(String(b.path), /backups-manual\/bot-\d{8}-\d{6}\/TestWorld-\d{8}-\d{6}\.tar\.gz$/);
    const log = fs.readFileSync(path.join(dir, "ops.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { action: string; dry: boolean });
    assert.ok(log.length >= 5 && log.every((l) => l.dry === true), "все действия в журнале, режим проверки");
    // чужое действие — 404
    const res = await new Promise<number>((resolve) => {
      const r = http.request({ socketPath: sock, path: "/v1/exec", method: "POST" }, (x) => resolve(x.statusCode ?? 0));
      r.end("{}");
    });
    assert.equal(res, 404);
  } finally {
    child.kill();
    mapSrv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
