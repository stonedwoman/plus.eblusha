/**
 * Русские названия для мира Valheim: биомы, локации, постройки.
 * Источник — правила карты сайта (WebMap/web-src/poi.js, сессия «Valheim: сервер и карта»),
 * чтобы бот и карта называли одно и то же одинаково.
 */

export const BIOME_RU: Record<string, string> = {
  Meadows: "Луга",
  BlackForest: "Чёрный лес",
  Swamp: "Болота",
  Mountain: "Горы",
  Plains: "Равнины",
  Ocean: "Океан",
  Mistlands: "Мгла",
  AshLands: "Пепельные земли",
  Ashlands: "Пепельные земли",
  DeepNorth: "Дальний север",
};

export function biomeRu(b: string | null | undefined): string | null {
  if (!b) return null;
  return BIOME_RU[b] ?? null;
}

export type LocationCategory = "boss" | "trader" | "dungeon" | "tar" | "camp" | "stone" | "ruin" | "nature";

/** Имя локации мира (префаб) → категория и русское название. Порядок важен: первое совпадение. */
const LOCATION_RULES: Array<[RegExp, LocationCategory, string]> = [
  [/^Eikthyrnir$/i, "boss", "алтарь Эйктюра"],
  [/^GDKing$/i, "boss", "алтарь Древнего"],
  [/^Bonemass$/i, "boss", "алтарь Массы костей"],
  [/^Dragonqueen$/i, "boss", "алтарь Матери"],
  [/^GoblinKing$/i, "boss", "алтарь Яглута"],
  [/^Mistlands_DvergrBossEntrance/i, "boss", "логово Королевы"],
  [/^FaderLocation$/i, "boss", "алтарь Прародителя"],
  [/^DN_Bossroom$/i, "boss", "логово Келла"],

  [/^Vendor_BlackForest$/i, "trader", "торговец Хальдор"],
  [/^Hildir_camp$/i, "trader", "лагерь Хильдир"],
  [/^BogWitch_Camp$/i, "trader", "Болотная ведьма"],

  [/^Crypt\d*$/i, "dungeon", "Погребальные комнаты"],
  [/^SunkenCrypt/i, "dungeon", "Затонувший склеп"],
  [/^TrollCave/i, "dungeon", "Пещера тролля"],
  [/^BearCave/i, "dungeon", "Медвежья берлога"],
  [/^MountainCave/i, "dungeon", "Ледяная пещера"],
  [/^Mistlands_DvergrTownEntrance/i, "dungeon", "Заражённый рудник"],
  [/^Mistlands_Excavation/i, "dungeon", "Раскопки двергов"],
  [/^Hildir_cave$/i, "dungeon", "Жуткая пещера"],
  [/^Hildir_crypt$/i, "dungeon", "Тлеющая гробница"],
  [/^Hildir_plainsfortress$/i, "dungeon", "Запечатанная башня"],
  [/^CharredFortress/i, "dungeon", "Обугленная крепость"],
  [/^FortressRuins/i, "dungeon", "Руины крепости"],
  [/^MorgenHole/i, "dungeon", "Логово моргена"],
  [/^TheHole/i, "dungeon", "Провал"],
  [/^MountainGrave/i, "dungeon", "Горная могила"],
  [/^Grave\d*$/i, "dungeon", "Болотное захоронение"],
  [/^MorkBorg$/i, "dungeon", "Мрачная крепость"],

  [/^TarPit/i, "tar", "Дегтярная яма"],

  [/^GoblinCamp/i, "camp", "Деревня фулингов"],
  [/^GoblinHut/i, "camp", "Хижина фулингов"],
  [/^Greydwarf_camp/i, "camp", "Гнездо грейдворфов"],
  [/^SwampHut/i, "camp", "Заброшенная хижина"],
  [/^WoodHouse/i, "camp", "Деревянный дом"],
  [/^WoodVillage/i, "camp", "Деревня драугров"],
  [/^StoneHouse/i, "camp", "Каменный дом"],
  [/^AbandonedLogCabin/i, "camp", "Заброшенный дом в горах"],
  [/^NorthVillage/i, "camp", "Северная деревня"],
  [/^DN_hut/i, "camp", "Хижина Севера"],
  [/^LumberCamp/i, "camp", "Лесопилка"],
  [/^WoodFarm/i, "camp", "Ферма"],
  [/^Mistlands_Harbour/i, "camp", "Гавань двергов"],
  [/^Mistlands_GuardTower/i, "camp", "Башня двергов"],

  [/^DrakeLorestone/i, "stone", "Камень дрейков"],
  [/^Dolmen/i, "stone", "Дольмен"],
  [/^StoneHenge/i, "stone", "Круг камней"],
  [/^StoneCircle/i, "stone", "Каменный круг"],
  [/^ShipSetting/i, "stone", "Захоронение викинга"],
  [/^Waymarker/i, "stone", "Вегвизир"],
  [/^AncientUpgradeStation/i, "stone", "Древний алтарь"],
  [/^NorthMemorialPlace/i, "stone", "Мемориал Севера"],
  [/^PlaceofMystery/i, "stone", "Загадочное место"],
  [/^Mistlands_Statue/i, "stone", "Статуи двергов"],
  [/^Mistlands_Swords/i, "stone", "Мечи в камне"],
  [/^StartTemple$/i, "stone", "Точка старта"],

  [/^Ruin\d*$/i, "ruin", "Руины"],
  [/^StoneTowerRuins/i, "ruin", "Руины башни"],
  [/^StoneTower\d*$/i, "ruin", "Каменная башня"],
  [/^ShipWreck/i, "ruin", "Кораблекрушение"],
  [/^FrozenShip/i, "ruin", "Вмёрзший корабль"],
  [/^SwampRuin/i, "ruin", "Болотная башня"],
  [/^CharredTowerRuins/i, "ruin", "Обугленная башня"],
  [/^CharredRuins/i, "ruin", "Обугленные руины"],
  [/^AshlandRuins/i, "ruin", "Руины Пепельных земель"],
  [/^Mistlands_Viaduct/i, "ruin", "Виадук"],
  [/^Mistlands_Lighthouse/i, "ruin", "Маяк двергов"],
  [/^CombatRuin/i, "ruin", "Боевые руины"],

  [/^InfestedTree/i, "nature", "Заражённое дерево"],
  [/^VoltureNest/i, "nature", "Гнездо вольтура"],
  [/^DrakeNest/i, "nature", "Гнездо дрейка"],
  [/^Mistlands_Giant/i, "nature", "Останки гиганта"],
  [/^LeviathanLava/i, "nature", "Жила огнеметалла"],
  [/^SulfurArch/i, "nature", "Серная арка"],
  [/^IcePond/i, "nature", "Ледяное озеро"],
  [/^FireHole/i, "nature", "Огненный гейзер"],
  [/^MountainWell/i, "nature", "Горный колодец"],
  [/^SwampWell/i, "nature", "Болотный колодец"],
];

export function classifyLocation(prefab: string): { category: LocationCategory; ru: string } | null {
  for (const [re, category, ru] of LOCATION_RULES) if (re.test(prefab)) return { category, ru };
  return null;
}

/** Постройки (станки, корабли и т. п.) по префабу. */
const PIECE_RU: Record<string, string> = {
  portal_wood: "портал",
  portal_stone: "каменный портал",
  portal: "портал",
  Raft: "плот",
  Karve: "карве",
  VikingShip: "драккар",
  VikingShip_Ashlands: "драккар Пепельных земель",
  Cart: "повозка",
  bed: "кровать",
  piece_bed02: "кровать",
  ashwood_bed: "кровать",
  Player_tombstone: "могила",
  guard_stone: "оберег",
  piece_workbench: "верстак",
  forge: "кузница",
  blackforge: "чёрная кузница",
  piece_artisanstation: "стол ремесленника",
  piece_stonecutter: "камнерезка",
  piece_magetable: "стол мага",
  smelter: "плавильня",
  blastfurnace: "доменная печь",
  charcoal_kiln: "углевыжигательная печь",
  windmill: "мельница",
  eitrrefinery: "очиститель эйтра",
  piece_spinningwheel: "прялка",
  piece_sapcollector: "сборщик сока",
  piece_beehive: "улей",
  piece_cauldron: "котёл",
  piece_oven: "печь",
  piece_chest_wood: "сундук",
  piece_chest: "армированный сундук",
  piece_chest_private: "личный сундук",
  piece_chest_blackmetal: "сундук из чёрного металла",
  piece_chest_barrel: "бочка",
};

export function pieceRu(prefab: string): string {
  return PIECE_RU[prefab] ?? prefab;
}

/** Станки, которые делают место «базой» (а не просто сундуком в поле). */
export const BASE_STATIONS = new Set([
  "piece_workbench",
  "forge",
  "blackforge",
  "piece_artisanstation",
  "piece_stonecutter",
  "piece_magetable",
  "smelter",
  "blastfurnace",
  "charcoal_kiln",
  "piece_spinningwheel",
  "piece_cauldron",
  "piece_oven",
  "eitrrefinery",
  "windmill",
]);

export const BED_PREFABS = new Set(["bed", "piece_bed02", "ashwood_bed"]);
export const SHIP_PREFABS = new Set(["Raft", "Karve", "VikingShip", "VikingShip_Ashlands"]);

/** Порядок боссов: от него зависит, какой тир брони уже доступен. */
export const BOSS_ORDER: Array<{ key: string; p: string; ru: string; biome: string; tier: number }> = [
  { key: "defeated_eikthyr", p: "Eikthyr", ru: "Эйктюр", biome: "Meadows", tier: 1 },
  { key: "defeated_gdking", p: "gd_king", ru: "Древний", biome: "BlackForest", tier: 2 },
  { key: "defeated_bonemass", p: "Bonemass", ru: "Масса костей", biome: "Swamp", tier: 3 },
  { key: "defeated_dragon", p: "Dragon", ru: "Матерь", biome: "Mountain", tier: 4 },
  { key: "defeated_goblinking", p: "GoblinKing", ru: "Яглут", biome: "Plains", tier: 5 },
  { key: "defeated_queen", p: "SeekerQueen", ru: "Королева", biome: "Mistlands", tier: 6 },
  { key: "defeated_fader", p: "Fader", ru: "Прародитель", biome: "AshLands", tier: 7 },
  // Келл засчитывается только по третьей фазе (ключ _p3) — так ведёт себя игра.
  { key: "defeated_frozenking_p3", p: "FrozenKing_p3", ru: "Келл Вестник Зимы", biome: "DeepNorth", tier: 8 },
];

/** Локация алтаря/логова по ключу босса — для «найден ли алтарь». */
export const BOSS_ALTAR: Record<string, RegExp> = {
  defeated_eikthyr: /^Eikthyrnir$/i,
  defeated_gdking: /^GDKing$/i,
  defeated_bonemass: /^Bonemass$/i,
  defeated_dragon: /^Dragonqueen$/i,
  defeated_goblinking: /^GoblinKing$/i,
  defeated_queen: /^Mistlands_DvergrBossEntrance/i,
  defeated_fader: /^FaderLocation$/i,
  "defeated_frozenking_p3": /^DN_Bossroom$/i,
};

/** Убрать эмодзи и управляющие символы из подписи (для картинки: в шрифте их нет). */
export function plainLabel(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
