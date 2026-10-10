/**
 * Броня Valheim: тиры по биомам и «последний ли у тебя комплект» с учётом убитых боссов.
 *
 * Таблица — по вики (valheim.fandom.com / valheim.wiki.gg, «Armor») и по справочнику самой
 * игры (/bot/v1/items мода, 1.0.17): в рецепте каждой брони есть «UpgraderNArmor», где N —
 * тот же номер тира (0 — Луга … 7 — Дальний север). Если справочник мода есть, тир берётся
 * из рецепта; таблица ниже — запасной вариант и русские названия комплектов.
 *
 * Тир N открывается победой над N-м боссом: Эйктюр открывает Чёрный лес (бронза), Древний —
 * Болота (железо), Масса костей — Горы (серебро), Матерь — Равнины, Яглут — Мглу, Королева —
 * Пепельные земли, Прародитель — Дальний север.
 */
import type { CatalogItem, EquipItem, EquipSlot, MapBoss } from "./types";
import { BOSS_ORDER } from "./names";

export type ArmorLine = "heavy" | "light" | "mage" | "special";

export interface ArmorSet {
  id: string;
  ru: string;
  tier: number;
  line: ArmorLine;
  pieces: string[];
}

export const TIER_BIOME_RU = ["Луга", "Чёрный лес", "Болота", "Горы", "Равнины", "Мгла", "Пепельные земли", "Дальний север"] as const;

const LINE_RU: Record<ArmorLine, string> = { heavy: "тяжёлый", light: "лёгкий", mage: "для магии", special: "особый" };

export const ARMOR_SETS: ArmorSet[] = [
  { id: "rags", ru: "холщовый", tier: 0, line: "light", pieces: ["ArmorRagsChest", "ArmorRagsLegs"] },
  { id: "leather", ru: "кожаный", tier: 0, line: "heavy", pieces: ["HelmetLeather", "ArmorLeatherChest", "ArmorLeatherLegs", "CapeDeerHide"] },
  { id: "troll", ru: "из кожи тролля", tier: 1, line: "light", pieces: ["HelmetTrollLeather", "ArmorTrollLeatherChest", "ArmorTrollLeatherLegs", "CapeTrollHide"] },
  { id: "bronze", ru: "бронзовый", tier: 1, line: "heavy", pieces: ["HelmetBronze", "ArmorBronzeChest", "ArmorBronzeLegs"] },
  { id: "berserker", ru: "медвежий (берсерк)", tier: 1, line: "special", pieces: ["HelmetBerserkerHood", "ArmorBerserkerChest", "ArmorBerserkerLegs"] },
  { id: "root", ru: "корневой", tier: 2, line: "light", pieces: ["HelmetRoot", "ArmorRootChest", "ArmorRootLegs"] },
  { id: "iron", ru: "железный", tier: 2, line: "heavy", pieces: ["HelmetIron", "ArmorIronChest", "ArmorIronLegs"] },
  { id: "fenring", ru: "Фенриса", tier: 3, line: "light", pieces: ["HelmetFenring", "ArmorFenringChest", "ArmorFenringLegs"] },
  { id: "wolf", ru: "волчий (с драконьим шлемом)", tier: 3, line: "heavy", pieces: ["HelmetDrake", "ArmorWolfChest", "ArmorWolfLegs", "CapeWolf"] },
  { id: "lox", ru: "из меха быкоящера", tier: 4, line: "light", pieces: ["HelmetLox", "ArmorLoxChest", "ArmorLoxLegs", "CapeLox"] },
  { id: "berserker_undead", ru: "гнилокостный (берсерк)", tier: 4, line: "special", pieces: ["HelmetBerserkerUndead", "ArmorBerserkerUndeadChest", "ArmorBerserkerUndeadLegs"] },
  { id: "padded", ru: "обитый", tier: 4, line: "heavy", pieces: ["HelmetPadded", "ArmorPaddedCuirass", "ArmorPaddedGreaves", "CapeLinen"] },
  { id: "carapace", ru: "панцирный", tier: 5, line: "heavy", pieces: ["HelmetCarapace", "ArmorCarapaceChest", "ArmorCarapaceLegs"] },
  { id: "eitrweave", ru: "сшитый из эйтра", tier: 5, line: "mage", pieces: ["HelmetMage", "ArmorMageChest", "ArmorMageLegs", "CapeFeather"] },
  { id: "flametal", ru: "огнеметаллический", tier: 6, line: "heavy", pieces: ["HelmetFlametal", "ArmorFlametalChest", "ArmorFlametalLegs", "CapeAsh"] },
  { id: "ask", ru: "Аска", tier: 6, line: "light", pieces: ["HelmetAshlandsMediumHood", "ArmorAshlandsMediumChest", "ArmorAshlandsMediumlegs", "CapeAsksvin"] },
  { id: "embla", ru: "Эмблы", tier: 6, line: "mage", pieces: ["HelmetMage_Ashlands", "ArmorMageChest_Ashlands", "ArmorMageLegs_Ashlands"] },
  { id: "dn_heavy", ru: "защитника", tier: 7, line: "heavy", pieces: ["HelmetDNHeavy", "ArmorDeepNorthHeavyChest", "ArmorDeepNorthHeavylegs", "CapeDeepNorth"] },
  { id: "dn_medium", ru: "авангарда", tier: 7, line: "light", pieces: ["HelmetDNMediumHood", "ArmorDeepNorthMediumChest", "ArmorDeepNorthMediumlegs"] },
  { id: "dn_mage", ru: "призывателя", tier: 7, line: "mage", pieces: ["HelmetDNMage", "ArmorDeepNorthMageChest", "ArmorDeepNorthMagelegs", "CapeDeepNorthMage"] },
];

const SET_BY_PIECE = new Map<string, ArmorSet>();
for (const s of ARMOR_SETS) for (const p of s.pieces) SET_BY_PIECE.set(p.toLowerCase(), s);

/** Варианты префабов (FW_…, SP_… — те же вещи) сводим к основному. */
export function basePrefab(p: string): string {
  return p.replace(/^(?:FW_|SP_)/, "");
}

export function setOf(prefab: string): ArmorSet | null {
  return SET_BY_PIECE.get(basePrefab(prefab).toLowerCase()) ?? null;
}

/** Тир по рецепту из справочника игры (UpgraderNArmor); null — не броня или нет рецепта. */
export function catalogTier(item: CatalogItem | undefined): number | null {
  for (const r of item?.recipe?.res ?? []) {
    const m = /^Upgrader(\d)Armor$/.exec(r.p);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Какой тир брони открыт: номер последнего убитого босса по порядку (0 — никого). */
export function unlockedTier(bosses: MapBoss[] | string[]): { tier: number; lastBoss: string | null; nextBoss: string | null } {
  const defeated = new Set<string>();
  for (const b of bosses) {
    if (typeof b === "string") defeated.add(b);
    else if (b.d === 1 && b.k) defeated.add(b.k);
  }
  let tier = 0;
  let last: string | null = null;
  for (const b of BOSS_ORDER) {
    if (defeated.has(b.key) && b.tier <= 7) {
      tier = Math.max(tier, b.tier);
      last = b.ru;
    }
  }
  const next = BOSS_ORDER.find((b) => !defeated.has(b.key))?.ru ?? null;
  return { tier, lastBoss: last, nextBoss: next };
}

export interface PieceInfo {
  slot: EquipSlot;
  p: string;
  ru: string;
  q: number | null;
  tier: number | null;
  set: ArmorSet | null;
  armor: number | null;
}

const ARMOR_SLOTS: EquipSlot[] = ["helmet", "chest", "legs", "shoulder"];
const PIECE_SLOT_RE: Partial<Record<EquipSlot, RegExp>> = {
  helmet: /^Helmet/,
  chest: /(?:Chest|Cuirass)(?:_|$)/,
  legs: /(?:Legs|legs|Greaves)(?:_|$)/,
  shoulder: /^Cape/,
};
const SLOT_TYPE: Record<string, string> = { helmet: "Helmet", chest: "Chest", legs: "Legs", shoulder: "Shoulder" };
export const SLOT_RU: Record<EquipSlot, string> = {
  helmet: "шлем",
  chest: "грудь",
  legs: "ноги",
  shoulder: "плащ",
  utility: "пояс",
  trinket: "безделушка",
  right: "правая рука",
  left: "левая рука",
  backRight: "за спиной (правое)",
  backLeft: "за спиной (левое)",
};

export interface GearVerdict {
  pieces: PieceInfo[];
  unlocked: { tier: number; lastBoss: string | null; nextBoss: string | null };
  /** По каждому слоту брони: что лучшее уже доступно (база брони без улучшений). */
  bestBySlot: Partial<Record<EquipSlot, Array<{ p: string; ru: string; armor: number; tier: number; line: ArmorLine | null }>>>;
  /** Слоты брони, где надето ниже открытого тира. */
  behind: Array<{ slot: EquipSlot; worn: number | null; best: number }>;
  isTop: boolean;
  setsWorn: string[];
}

export function evaluateGear(equipment: Partial<Record<EquipSlot, EquipItem>>, bosses: MapBoss[] | string[], catalog: Map<string, CatalogItem> | null): GearVerdict {
  const unlocked = unlockedTier(bosses);
  const pieces: PieceInfo[] = [];
  for (const [slot, it] of Object.entries(equipment) as Array<[EquipSlot, EquipItem]>) {
    if (!it?.p) continue;
    const cat = catalog?.get(basePrefab(it.p)) ?? catalog?.get(it.p);
    const set = setOf(it.p);
    const tier = catalogTier(cat) ?? set?.tier ?? null;
    pieces.push({
      slot,
      p: it.p,
      ru: it.ru ?? cat?.ru ?? it.p,
      q: it.q ?? null,
      tier,
      set,
      armor: cat?.armor ?? null,
    });
  }

  const bestBySlot: GearVerdict["bestBySlot"] = {};
  if (catalog) {
    for (const slot of ARMOR_SLOTS) {
      const type = SLOT_TYPE[slot]!;
      const cands: Array<{ p: string; ru: string; armor: number; tier: number; line: ArmorLine | null }> = [];
      for (const it of catalog.values()) {
        if (it.type !== type || /^(?:FW_|SP_)/.test(it.p)) continue;
        const t = catalogTier(it) ?? setOf(it.p)?.tier ?? null;
        if (t === null || t > unlocked.tier || it.armor === undefined) continue;
        cands.push({ p: it.p, ru: it.ru ?? it.p, armor: it.armor, tier: t, line: setOf(it.p)?.line ?? null });
      }
      const top = cands.filter((c) => c.tier === unlocked.tier).sort((a, b) => b.armor - a.armor);
      bestBySlot[slot] = (top.length ? top : cands.sort((a, b) => b.armor - a.armor)).slice(0, 4);
    }
  } else {
    // Без справочника игры: комплекты открытого тира из таблицы (без цифр брони).
    for (const slot of ARMOR_SLOTS) {
      const re = PIECE_SLOT_RE[slot]!;
      bestBySlot[slot] = ARMOR_SETS.filter((s) => s.tier === unlocked.tier).flatMap((s) =>
        s.pieces.filter((p) => re.test(p)).map((p) => ({ p, ru: `комплект «${s.ru}»`, armor: 0, tier: s.tier, line: s.line }))
      );
    }
  }

  const behind: GearVerdict["behind"] = [];
  for (const slot of ["helmet", "chest", "legs"] as EquipSlot[]) {
    const worn = pieces.find((p) => p.slot === slot) ?? null;
    if (!worn || worn.tier === null || worn.tier < unlocked.tier) behind.push({ slot, worn: worn?.tier ?? null, best: unlocked.tier });
  }
  const setsWorn = [...new Set(pieces.filter((p) => ARMOR_SLOTS.includes(p.slot) && p.set).map((p) => p.set!.id))];
  return { pieces, unlocked, bestBySlot, behind, isTop: behind.length === 0, setsWorn };
}

/** Текст для модели: компактно, по-русски, с честными оговорками. */
export function gearReport(name: string, v: GearVerdict): string {
  const lines: string[] = [];
  lines.push(`Персонаж «${name}». Надето (по данным сервера, без личного инвентаря):`);
  if (!v.pieces.length) lines.push("- ничего не надето (или персонаж ещё не прогрузился)");
  const order: EquipSlot[] = ["helmet", "chest", "legs", "shoulder", "utility", "trinket", "right", "left", "backRight", "backLeft"];
  for (const slot of order) {
    const p = v.pieces.find((x) => x.slot === slot);
    if (!p) continue;
    const bits = [`${SLOT_RU[slot]}: ${p.ru} (${p.p})`];
    if (p.q !== null) bits.push(`качество ${p.q}`);
    if (p.tier !== null && ["helmet", "chest", "legs", "shoulder"].includes(slot)) bits.push(`тир ${p.tier} — ${TIER_BIOME_RU[p.tier] ?? "?"}`);
    if (p.set) bits.push(`комплект «${p.set.ru}», ${LINE_RU[p.set.line]}`);
    if (p.armor !== null) bits.push(`броня ${p.armor} на 1-м уровне`);
    lines.push(`- ${bits.join(", ")}`);
  }
  const u = v.unlocked;
  lines.push(
    `Прогресс мира: последний убитый босс — ${u.lastBoss ?? "никто"}; открыт тир брони ${u.tier} (${TIER_BIOME_RU[u.tier] ?? "?"}).${u.nextBoss ? ` Следующий босс: ${u.nextBoss}.` : ""}`
  );
  lines.push(v.isTop ? "Вывод: шлем, грудь и ноги — уже последнего открытого тира." : `Вывод: не последний комплект — ниже открытого тира: ${v.behind.map((b) => `${SLOT_RU[b.slot]} (${b.worn === null ? "пусто/не броня" : `тир ${b.worn}`})`).join(", ")}.`);
  const best = (["chest", "helmet", "legs", "shoulder"] as EquipSlot[])
    .map((s) => {
      const list = v.bestBySlot[s] ?? [];
      return list.length ? `${SLOT_RU[s]}: ${list.map((b) => `${b.ru}${b.armor ? ` (${b.armor})` : ""}${b.line ? `, ${LINE_RU[b.line]}` : ""}`).join("; ")}` : null;
    })
    .filter(Boolean);
  if (best.length) lines.push(`Лучшее из открытого тира (база брони):`, ...best.map((b) => `- ${b}`));
  lines.push("Оговорки: качество (уровень улучшения) шлема, груди и ног сервер не видит — только у оружия, щита и плаща; что лежит в рюкзаке, серверу не видно.");
  return lines.join("\n");
}
