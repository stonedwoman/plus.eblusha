import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCharacter, readableName, sameCharacter, shapeSkeleton } from "../../../src/core/nick";
import { BotChannel, parsePlayersFrame, VhUnavailable } from "../../../src/modules/valheim/client";
import { ARMOR_SETS, catalogTier, evaluateGear, gearReport, setOf, unlockedTier } from "../../../src/modules/valheim/gear";
import { bearing, describeNear, facing, fmtDist, sideOf } from "../../../src/modules/valheim/geo";
import { baseAt, findBases, homeBases, isHomeLabel } from "../../../src/modules/valheim/home";
import { classifyLocation, plainLabel } from "../../../src/modules/valheim/names";
import { matchItems, stem } from "../../../src/modules/valheim/search";
import type { CatalogItem, MapBoss, ModAnchors, ModItems } from "../../../src/modules/valheim/types";
import { structuresToAnchors } from "../../../src/modules/valheim/world";
import { fx, modPlayers, playersFrame } from "./vhfakes";

// ------------------------------------------------------------------ ники
test("ники: похожие латинские буквы → кириллица (IiApaCiOxa, РомаH, Куралеска)", () => {
  assert.equal(shapeSkeleton("IiApaCiOxa"), "ПАРАСЮХА");
  assert.equal(shapeSkeleton("РомаH"), "РОМАН");
  assert.ok(sameCharacter("Парасюха", "IiApaCiOxa"));
  assert.ok(sameCharacter("парасюха", "IiApaCiOxa"));
  assert.ok(sameCharacter("Роман", "РомаH"));
  assert.ok(sameCharacter("КУРАЛЕСКА", "Куралеска"));
  assert.ok(sameCharacter("KYPAJIECKA", "Куралеска"), "JI = Л, Y = У, P = Р");
  assert.ok(sameCharacter("Kuraleska", "Куралеска"), "транслит");
  assert.ok(!sameCharacter("Парасюха", "Куралеска"));
  // со списком персонажей, которых знает сервер (снимок /bot/v1/known)
  const known = fx<{ players: Array<{ name: string }> }>("mod-known.json").players.map((p) => p.name);
  assert.deepEqual(matchCharacter("Парасюха", known), { kind: "exact", character: "IiApaCiOxa" });
  assert.deepEqual(matchCharacter("роман", known), { kind: "exact", character: "РомаH" });
  assert.deepEqual(matchCharacter("куралеска", known), { kind: "exact", character: "Куралеска" });
});

test("ники: как читается по-русски (для «Привязал: ты — IiApaCiOxa (Парасюха)»)", () => {
  assert.equal(readableName("IiApaCiOxa"), "Парасюха");
  assert.equal(readableName("РомаH"), "Роман");
  assert.equal(readableName("Kurolesska"), "Куролесска");
  assert.equal(readableName("Куралеска"), null, "обычная кириллица — без скобок");
});

// ------------------------------------------------------------------ геометрия
test("стороны света и расстояния", () => {
  assert.equal(Math.round(bearing({ x: 0, z: 0 }, { x: 10, z: 0 })), 90);
  assert.equal(facing(0), "на север");
  assert.equal(facing(45), "на северо-восток");
  assert.equal(facing(265), "на запад");
  assert.equal(sideOf({ x: 0, z: 0 }, { x: -100, z: -100 }), "к юго-западу");
  assert.equal(fmtDist(343), "340 м");
  assert.equal(fmtDist(1234), "1,2 км");
  assert.equal(fmtDist(15600), "16 км");
  const d = describeNear({ x: 0, z: -340 }, [{ kind: "portal", name: "портала «БОЛОТО»", x: 0, z: 0 }]);
  assert.equal(d.text, "в 340 м к югу от портала «БОЛОТО»");
  assert.equal(describeNear({ x: 3, z: 4 }, [{ kind: "portal", name: "портала «X»", x: 0, z: 0 }]).text, "у портала «X»");
});

test("названия локаций и чистка подписей", () => {
  assert.equal(classifyLocation("Crypt3")?.ru, "Погребальные комнаты");
  assert.equal(classifyLocation("GDKing")?.category, "boss");
  assert.equal(classifyLocation("Something"), null);
  assert.equal(plainLabel("🥕овощи🧅"), "овощи");
  assert.equal(plainLabel("👁️глаза"), "глаза");
});

// ------------------------------------------------------------------ броня
const catalog = new Map(fx<ModItems>("items.json").items.map((i) => [i.p, i] as [string, CatalogItem]));
const bossesNow = fx<{ bosses: MapBoss[] }>("map-bosses.json").bosses;

test("тиры брони: таблица сходится со справочником игры (UpgraderNArmor)", () => {
  let checked = 0;
  for (const s of ARMOR_SETS) {
    for (const p of s.pieces) {
      const it = catalog.get(p);
      assert.ok(it, `в справочнике игры нет ${p}`);
      const t = catalogTier(it);
      if (t !== null && !(s.id === "berserker" && p === "HelmetBerserkerHood")) {
        assert.equal(t, s.tier, `${p}: в игре тир ${t}, в таблице ${s.tier}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 50, `сверено ${checked}`);
  assert.equal(setOf("FW_ArmorBronzeChest")?.id, "bronze", "варианты FW_/SP_ — та же вещь");
});

test("открытый тир по боссам: убита Королева → тир 6 (Пепельные земли), следующий — Прародитель", () => {
  const u = unlockedTier(bossesNow);
  assert.equal(u.tier, 6);
  assert.equal(u.lastBoss, "Королева");
  assert.equal(u.nextBoss, "Прародитель");
  assert.equal(unlockedTier([]).tier, 0);
  assert.equal(unlockedTier(["defeated_eikthyr", "defeated_gdking"]).tier, 2);
});

test("«последний ли у меня комплект брони?»: волчий при открытых Пепельных землях — нет", () => {
  const v = evaluateGear(modPlayers()[0]!.equipment!, bossesNow, catalog);
  assert.equal(v.isTop, false);
  assert.deepEqual(v.behind.map((b) => b.slot), ["helmet", "chest", "legs"]);
  assert.equal(v.pieces.find((p) => p.slot === "chest")?.tier, 3);
  const bestChest = v.bestBySlot.chest!.map((b) => b.p);
  assert.ok(bestChest.includes("ArmorFlametalChest") && bestChest.includes("ArmorAshlandsMediumChest") && bestChest.includes("ArmorMageChest_Ashlands"), bestChest.join());
  assert.equal(v.bestBySlot.chest![0]!.p, "ArmorFlametalChest", "по броне — огнеметалл первым");
  const r = gearReport("IiApaCiOxa", v);
  assert.match(r, /не последний комплект/);
  assert.match(r, /Огнеметаллическая кираса \(38\)/);
  assert.match(r, /качество .*не видит/);

  const top = evaluateGear(modPlayers()[1]!.equipment!, bossesNow, catalog);
  assert.equal(top.isTop, true);
  assert.match(gearReport("Куралеска", top), /уже последнего открытого тира/);

  // без справочника — по таблице
  const noCat = evaluateGear(modPlayers()[0]!.equipment!, bossesNow, null);
  assert.equal(noCat.isTop, false);
  assert.ok(noCat.bestBySlot.chest!.some((b) => b.p === "ArmorFlametalChest"));
});

// ------------------------------------------------------------------ поиск предметов
test("поиск предмета по-русски с падежами", () => {
  const all = [...catalog.values()];
  assert.equal(stem("репы"), "реп");
  assert.equal(matchItems("семена репы", all)[0]?.item.p, "TurnipSeeds");
  const repa = matchItems("репа", all).map((m) => m.item.p);
  assert.equal(repa[0], "Turnip");
  assert.ok(repa.includes("TurnipSeeds"));
  assert.equal(matchItems("есть ли у нас дома семена репы", all)[0]?.item.p, "TurnipSeeds", "шумовые слова отбрасываются");
  assert.equal(matchItems("семян репы", all)[0]?.item.p, "TurnipSeeds");
  assert.equal(matchItems("железо", all)[0]?.item.p, "Iron");
  assert.equal(matchItems("серебра", all)[0]?.item.p, "Silver");
  assert.ok(!matchItems("серебро", all).some((m) => m.item.p === "SulfurStone"), "«серебро» — не «Сера»");
  assert.equal(matchItems("Turnip seeds", all)[0]?.item.p, "TurnipSeeds");
  assert.deepEqual(matchItems("абырвалг", all), []);
});

// ------------------------------------------------------------------ дом и базы
test("дом: кластер у кроватей и станков; базы с меткой «ДОМ…»", () => {
  const anchors = fx<ModAnchors>("mod-anchors.json").anchors;
  const bases = findBases(anchors.map((a) => ({ kind: a.kind, prefab: a.prefab, x: a.x, z: a.z, text: a.text, owner: a.owner, world: a.world })));
  const main = bases[0]!;
  assert.equal(main.isMain, true);
  assert.equal(main.name, "главный дом");
  assert.ok(Math.abs(main.x + 744) < 30 && Math.abs(main.z + 325) < 30, `${main.x},${main.z}`);
  assert.ok(main.beds >= 3);
  assert.ok(main.owners.includes("Куралеска") && main.owners.includes("IiApaCiOxa"));
  const dom4 = bases.find((b) => b.homeLabel === "ДОМ4");
  assert.ok(dom4, "база у портала ДОМ4");
  const homes = homeBases(bases);
  assert.ok(homes.includes(main) && homes.includes(dom4!));
  // сундук «🥕овощи🧅» (репа) — дома
  assert.equal(baseAt({ x: -710.5, z: -320.5 }, bases), main);
  assert.equal(baseAt({ x: 0, z: 0 }, bases), null);
  assert.ok(isHomeLabel("ДОМ2") && isHomeLabel("дом") && !isHomeLabel("домик у озера"));
  // без мода — то же из /structures карты
  const fromMap = findBases(structuresToAnchors(fx("map-structures.json")));
  assert.equal(fromMap[0]!.name, "главный дом");
  assert.ok(Math.abs(fromMap[0]!.x + 740) < 40);
});

// ------------------------------------------------------------------ клиенты
test("кадр WS «players»: скрытые, флаги, без координат", () => {
  const ps = parsePlayersFrame(playersFrame(modPlayers()));
  assert.equal(ps.length, 3);
  assert.deepEqual(
    ps.map((p) => [p.name, p.hidden, p.dead, p.x, p.yaw]),
    [
      ["IiApaCiOxa", false, false, -737, 45],
      ["Куралеска", true, false, -3782, 180],
      ["РомаH", false, true, 1866, 270],
    ]
  );
  assert.deepEqual(parsePlayersFrame("players"), []);
  const noPos = parsePlayersFrame("players\n7\nX\n10\n25\nhidden\n001");
  assert.equal(noPos[0]!.x, null);
  assert.equal(noPos[0]!.inBed, true);
});

test("канал мода: токен из файла, после 401 — перечитать; нет файла — честная ошибка", async () => {
  let token = "old-token-0000000000";
  let reads = 0;
  const seen: string[] = [];
  const ch = new BotChannel(
    "http://mod",
    "/token",
    async (_u, init) => {
      seen.push(init.headers?.["X-Bot-Token"] ?? "");
      const ok = init.headers?.["X-Bot-Token"] === "new-token-0000000000";
      return { status: ok ? 200 : 401, ok, json: async () => ({ ok: true, api: "1", boot: "b", ready: true, catalog: true, scan: null }), arrayBuffer: async () => new ArrayBuffer(0) };
    },
    () => {
      reads++;
      return token;
    }
  );
  token = "new-token-0000000000";
  // первый раз прочитает уже новый — сделаем «старый» в кэше
  (ch as unknown as { token: string }).token = "old-token-0000000000";
  const h = await ch.health();
  assert.equal(h.ready, true);
  assert.deepEqual(seen, ["old-token-0000000000", "new-token-0000000000"]);
  assert.equal(reads, 1);

  const none = new BotChannel("http://mod", "/nope", async () => {
    throw new Error("не должно звать");
  }, () => {
    throw new Error("ENOENT");
  });
  await assert.rejects(none.health(), (e) => e instanceof VhUnavailable && /нет файла токена/.test(e.message));
});
