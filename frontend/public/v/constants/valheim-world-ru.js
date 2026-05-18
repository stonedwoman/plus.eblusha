/**
 * Единый словарь отображения мира Valheim (боссы, рейды) для /v/.
 */
(function (global) {
  var BOSS_NAMES_RU = {
    eikthyr: "Эйктюр",
    elder: "Древний",
    bonemass: "Масса костей",
    moder: "Матерь",
    yagluth: "Яглут",
    queen: "Королева",
    fader: "Прародитель",
  };

  /** Страницы русской вики (как на valheim.fandom.com) */
  var BOSS_WIKI_RU = {
    eikthyr: "https://valheim.fandom.com/ru/wiki/%D0%AD%D0%B9%D0%BA%D1%82%D1%8E%D1%80",
    elder: "https://valheim.fandom.com/ru/wiki/%D0%94%D1%80%D0%B5%D0%B2%D0%BD%D0%B8%D0%B9",
    bonemass:
      "https://valheim.fandom.com/ru/wiki/%D0%9C%D0%B0%D1%81%D1%81%D0%B0_%D0%BA%D0%BE%D1%81%D1%82%D0%B5%D0%B9",
    moder: "https://valheim.fandom.com/ru/wiki/%D0%9C%D0%B0%D1%82%D0%B5%D1%80%D1%8C",
    yagluth: "https://valheim.fandom.com/ru/wiki/%D0%AF%D0%B3%D0%BB%D1%83%D1%82",
    queen: "https://valheim.fandom.com/ru/wiki/%D0%9A%D0%BE%D1%80%D0%BE%D0%BB%D0%B5%D0%B2%D0%B0",
    fader: "https://valheim.fandom.com/ru/wiki/%D0%9F%D1%80%D0%B0%D1%80%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C",
  };

  /** Локальные PNG (scale 64 с Fandom CDN), чтобы не зависеть от hotlink */
  var BOSS_IMG_LOCAL = {
    eikthyr: "/v/assets/bosses/eikthyr.png",
    elder: "/v/assets/bosses/elder.png",
    bonemass: "/v/assets/bosses/bonemass.png",
    moder: "/v/assets/bosses/moder.png",
    yagluth: "/v/assets/bosses/yagluth.png",
    queen: "/v/assets/bosses/queen.png",
    fader: "/v/assets/bosses/fader.png",
  };

  var EVENT_ID_ALIASES = {
    forest: "army_theelder",
    swamp: "army_bonemass",
    mountain: "army_moder",
    forest_trolls: "foresttrolls",
    army_yagluth: "army_goblin",
    blob: "blobs",
    surtling: "surtlings",
    seekers: "army_seekers",
    gjall: "army_gjall",
    charred_monument: "army_charredspawners",
    hildir_1: "hildirboss1",
    hildir_2: "hildirboss2",
    hildir_3: "hildirboss3",
  };

  var EVENT_NAMES_RU = {
    army_eikthyr: "Эйктюр объединяет существ леса",
    army_theelder: "Лес движется..",
    army_bonemass: "Вонь с болот",
    army_moder: "Ледяной ветер дует с гор",
    army_goblin: "Орда атакует",
    army_gjall: "Дарова, Гьялль!?",
    army_seekers: "Они ищут вас",
    army_charred: "Марш армии мертвых",
    army_charredspawners: "Восстание мертвецов",
    foresttrolls: "Земля трясется",
    blobs: "Вонь с болот",
    ghosts: "Мороз по коже пробежал...",
    skeletons: "Незваные кости",
    surtlings: "В воздухе висит запах серы…",
    wolves: "На вас охотятся…",
    bats: "Вы размешали котел",
    hildirboss1: "Она вот-вот задаст Вам жару",
    hildirboss2: "По Вам пробежал холодок",
    hildirboss3: "Они были братанами, парень...",
  };

  var EVENT_META_RU = {
    army_eikthyr: {
      nameRu: "Эйктюр объединяет существ леса",
      start: "Со старта игры",
      end: "Убив Эйктюра",
      enemies: ["Кабаны", "Никсы"],
      duration: "1,5 мин.",
      biomes: ["Луга", "Черный лес"],
    },
    army_theelder: {
      nameRu: "Лес движется..",
      start: "Убив Эйктюра",
      end: "Убив Древнего",
      enemies: ["Грейдворфы", "Грейдворф-дикари", "Грейдворф-шаманы"],
      duration: "2 мин.",
      biomes: ["Луга", "Черный лес", "Болото", "Равнины"],
    },
    army_bonemass: {
      nameRu: "Вонь с болот",
      start: "Убив Древнего",
      end: "Убив Массу костей",
      enemies: ["Драугры", "Скелеты", "Дождь с болот"],
      duration: "2,5 мин.",
      biomes: ["Луга", "Черный лес", "Болото", "Гора", "Равнины"],
    },
    army_moder: {
      nameRu: "Ледяной ветер дует с гор",
      start: "Убив Массу костей",
      end: "Убив Матерь",
      enemies: ["Драконы", "Эффект Замерзание"],
      duration: "2,5 мин.",
      biomes: ["Луга", "Черный лес", "Болото", "Гора", "Равнины"],
    },
    army_goblin: {
      nameRu: "Орда атакует",
      start: "Убив Матерь",
      end: "Убив Яглута",
      enemies: ["Фулинги", "Фулинг-берсерки", "Фулинг-шаманы"],
      duration: "2,5 мин.",
      biomes: ["Луга", "Черный лес", "Равнины"],
    },
    army_gjall: {
      nameRu: "Дарова, Гьялль!?",
      start: "Убив Яглута",
      end: "Убив Королеву",
      enemies: ["Гьялль", "Клещи"],
      duration: "1,5 мин.",
      biomes: ["Туманные земли"],
    },
    army_seekers: {
      nameRu: "Они ищут вас",
      start: "Убив Яглута",
      end: "Убив Королеву",
      enemies: ["Искатели", "Выводки искателя"],
      duration: "1,5 мин.",
      biomes: ["Черный лес", "Равнины", "Туманные земли", "Пепельные земли", "Дальний север"],
    },
    army_charred: {
      nameRu: "Марш армии мертвых",
      start: "Убив Королеву",
      end: "Убив Прародителя",
      enemies: ["Обугленные воины", "Обугленные лучники", "Обугленные чернокнижники", "Обугленные дергуны"],
      duration: "1,5 мин.",
      biomes: ["Любой"],
    },
    army_charredspawners: {
      nameRu: "Восстание мертвецов",
      start: "Убив Королеву",
      end: "Убив Прародителя",
      enemies: ["Монумент страданий"],
      duration: "1,5 мин.",
      biomes: ["Любой"],
      note: "Не исчезнет после события",
    },
    foresttrolls: {
      nameRu: "Земля трясется",
      start: "Убив Древнего и тролля",
      end: null,
      enemies: ["Тролли"],
      duration: "1,3 мин.",
      biomes: ["Луга", "Черный лес", "Болото", "Равнины"],
    },
    blobs: {
      nameRu: "Вонь с болот",
      start: "Убив Массу костей",
      end: null,
      enemies: ["Сгустни", "Слизняки", "Дождь с болот"],
      duration: "2 мин.",
      biomes: ["Луга", "Черный лес", "Болото", "Равнины"],
    },
    ghosts: {
      nameRu: "Мороз по коже пробежал...",
      start: "Убив Массу костей",
      end: null,
      enemies: ["Духи", "Призраки", "Временная ночь"],
      duration: "2,5 мин.",
      biomes: ["Луга", "Черный лес", "Болото", "Гора", "Равнины"],
    },
    skeletons: {
      nameRu: "Незваные кости",
      start: "Убив Массу костей",
      end: null,
      enemies: ["Скелеты", "Сгнившие останки"],
      duration: "2 мин.",
      biomes: ["Луга", "Черный лес", "Болото", "Равнины", "Туманные земли"],
    },
    surtlings: {
      nameRu: "В воздухе висит запах серы…",
      start: "Убив Суртлингов и Массу костей",
      end: null,
      enemies: ["Суртлинги", "Пепельный дождь"],
      duration: "2 мин.",
      biomes: ["Луга", "Черный лес", "Болото", "Равнины"],
    },
    wolves: {
      nameRu: "На вас охотятся…",
      start: "Убив Массу костей",
      end: null,
      enemies: ["Волки"],
      duration: "2 мин.",
      biomes: ["Гора", "Равнины"],
      note: "Событие не привязано к дому игрока",
    },
    bats: {
      nameRu: "Вы размешали котел",
      start: "Убив летучих мышей и Массу костей",
      end: null,
      enemies: ["Летучие мыши"],
      duration: "2 мин.",
      biomes: ["Любой"],
    },
    hildirboss1: {
      nameRu: "Она вот-вот задаст Вам жару",
      start: "Убив Бренну и вернув Медный сундук Хильдир",
      end: null,
      enemies: ["Бренна", "Скелеты 1⭐", "Сгнившие останки 1⭐"],
      duration: "1,5 мин.",
      biomes: ["Любой"],
    },
    hildirboss2: {
      nameRu: "По Вам пробежал холодок",
      start: "Убив Гейрафу и вернув Серебряный сундук Хильдир",
      end: null,
      enemies: ["Гейрафа", "Фенринги 1⭐", "Культисты 1⭐"],
      duration: "1,5 мин.",
      biomes: ["Любой"],
    },
    hildirboss3: {
      nameRu: "Они были братанами, парень...",
      start: "Убив Зила и Тангра и вернув Бронзовый сундук Хильдир",
      end: null,
      enemies: ["Зил и Тангр", "Фулинги 1⭐", "Фулинг-берсерки 1⭐"],
      duration: "1,5 мин.",
      biomes: ["Любой"],
    },
  };

  function canonicalEventId(eventId) {
    var id = String(eventId || "").toLowerCase();
    return EVENT_ID_ALIASES[id] || id;
  }

  function mapEventToDisplay(eventId) {
    var id = canonicalEventId(eventId);
    var meta = EVENT_META_RU[id];
    if (meta) {
      return {
        id: id,
        nameRu: meta.nameRu,
        meta: meta,
        unknown: false,
      };
    }
    var nameFromShort = EVENT_NAMES_RU[id];
    if (nameFromShort) {
      return {
        id: id,
        nameRu: nameFromShort,
        meta: null,
        unknown: false,
      };
    }
    return {
      id: id,
      nameRu: id,
      meta: null,
      unknown: true,
    };
  }

  function buildEventTooltip(meta, nameRu, eventId, unknown) {
    if (!meta) {
      return unknown ? "id: " + eventId + " (нет в справочнике)" : String(nameRu || "");
    }
    var lines = [meta.nameRu || nameRu];
    if (meta.start) lines.push("Старт: " + meta.start);
    if (meta.end !== undefined && meta.end !== null) lines.push("Конец: " + meta.end);
    if (meta.enemies && meta.enemies.length) lines.push("Враги: " + meta.enemies.join(", "));
    if (meta.duration) lines.push("Длительность: " + meta.duration);
    if (meta.biomes && meta.biomes.length) lines.push("Биомы: " + meta.biomes.join(", "));
    if (meta.note) lines.push("Примечание: " + meta.note);
    return lines.join("\n");
  }

  global.ValheimWorldRu = {
    BOSS_NAMES_RU: BOSS_NAMES_RU,
    BOSS_WIKI_RU: BOSS_WIKI_RU,
    BOSS_IMG_LOCAL: BOSS_IMG_LOCAL,
    EVENT_ID_ALIASES: EVENT_ID_ALIASES,
    EVENT_NAMES_RU: EVENT_NAMES_RU,
    EVENT_META_RU: EVENT_META_RU,
    canonicalEventId: canonicalEventId,
    mapEventToDisplay: mapEventToDisplay,
    buildEventTooltip: buildEventTooltip,
  };
})(typeof window !== "undefined" ? window : this);
