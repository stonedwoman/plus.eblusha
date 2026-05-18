/**
 * Карточка «Мир» — payload.world (логи, .db). Словари: ValheimWorldRu.
 */
(function (global) {
  var BOSS_KEYS_ORDER = [
    "eikthyr",
    "elder",
    "bonemass",
    "moder",
    "yagluth",
    "queen",
    "fader",
  ];

  var FALLBACK_BOSS_NAMES = {
    eikthyr: "Эйктюр",
    elder: "Древний",
    bonemass: "Масса костей",
    moder: "Матерь",
    yagluth: "Яглут",
    queen: "Королева",
    fader: "Прародитель",
  };

  function getV() {
    return global.ValheimWorldRu;
  }

  function bossName(key) {
    var V = getV();
    var m = (V && V.BOSS_NAMES_RU) || FALLBACK_BOSS_NAMES;
    return m[key] || key;
  }

  function bossWikiUrl(key) {
    var V = getV();
    var w = V && V.BOSS_WIKI_RU;
    return (w && w[key]) || "https://valheim.fandom.com/ru/wiki/Valheim_%D0%B2%D0%B8%D0%BA%D0%B8";
  }

  function bossImgSrc(key) {
    var V = getV();
    var m = V && V.BOSS_IMG_LOCAL;
    return (m && m[key]) || "";
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function fmtUnknown(v) {
    if (v === null || v === undefined) return "неизвестно";
    if (typeof v === "number" && !isNaN(v)) return String(v);
    if (typeof v === "string" && v.trim() !== "") return v;
    return "неизвестно";
  }

  function formatGameDaysAgo(n) {
    if (n == null || !isFinite(n)) return "";
    var value = Math.max(0, Math.floor(Math.abs(n)));
    var mod10 = value % 10;
    var mod100 = value % 100;
    var tail = "игровых дней назад";
    if (mod100 < 11 || mod100 > 14) {
      if (mod10 === 1) {
        tail = "игровой день назад";
      } else if (mod10 >= 2 && mod10 <= 4) {
        tail = "игровых дня назад";
      }
    }
    return value + " " + tail;
  }

  /**
   * Нормализует запись события: строка (legacy) или { id, nameRu, unknown }.
   * meta подмешивается с фронта из EVENT_META_RU для подсказок.
   */
  function normalizeEventEntry(ev) {
    var V = getV();
    var mapEv = V && V.mapEventToDisplay;
    var META = V && V.EVENT_META_RU;

    if (typeof ev === "string") {
      var id0 = String(ev).toLowerCase();
      var meta0 = META && META[id0];
      if (mapEv) {
        var d0 = mapEv(id0);
        return {
          id: d0.id,
          nameRu: d0.nameRu,
          unknown: d0.unknown,
          meta: d0.meta || meta0 || null,
          gameDaysAgo: undefined,
          eventDay: undefined,
          occurredAt: undefined,
        };
      }
      return {
        id: id0,
        nameRu: id0,
        unknown: true,
        meta: meta0 || null,
        gameDaysAgo: undefined,
        eventDay: undefined,
        occurredAt: undefined,
      };
    }

    if (!ev || typeof ev !== "object") {
      return {
        id: "",
        nameRu: "?",
        unknown: true,
        meta: null,
        gameDaysAgo: undefined,
        eventDay: undefined,
        occurredAt: undefined,
      };
    }

    var id = String(ev.id != null ? ev.id : "").toLowerCase();
    var meta = (META && META[id]) || null;
    var apiName = ev.nameRu;
    var apiUnknown = ev.unknown;
    var apiGameDays = ev.gameDaysAgo != null ? ev.gameDaysAgo : ev.daysAgo;
    var apiEventDay = ev.eventDay;
    var apiAt = ev.occurredAt;

    if (mapEv) {
      var d = mapEv(id);
      if (apiName != null && apiName !== "") {
        return {
          id: id,
          nameRu: apiName,
          unknown: apiUnknown === true,
          meta: meta || d.meta || null,
          gameDaysAgo: apiGameDays != null ? apiGameDays : undefined,
          eventDay: apiEventDay != null ? apiEventDay : undefined,
          occurredAt: apiAt != null ? apiAt : undefined,
        };
      }
      return {
        id: id,
        nameRu: d.nameRu,
        unknown: d.unknown,
        meta: meta || d.meta || null,
        gameDaysAgo: apiGameDays != null ? apiGameDays : undefined,
        eventDay: apiEventDay != null ? apiEventDay : undefined,
        occurredAt: apiAt != null ? apiAt : undefined,
      };
    }

    return {
      id: id,
      nameRu: apiName != null ? apiName : id,
      unknown: apiUnknown === true,
      meta: meta,
      gameDaysAgo: apiGameDays != null ? apiGameDays : undefined,
      eventDay: apiEventDay != null ? apiEventDay : undefined,
      occurredAt: apiAt != null ? apiAt : undefined,
    };
  }

  function eventTooltip(entry) {
    var V = getV();
    var build = V && V.buildEventTooltip;
    var base = build
      ? build(entry.meta, entry.nameRu, entry.id, entry.unknown)
      : entry.nameRu || entry.id;
    if (entry.eventDay != null) {
      base = base + "\n\nИгровой день: " + entry.eventDay;
    }
    if (entry.occurredAt) {
      base = base + "\n\nСтрока лога: " + entry.occurredAt;
    }
    return base;
  }

  function renderWorldInfo(root, world) {
    if (!root) return;
    var w = world && typeof world === "object" ? world : {};
    var bosses = w.bosses && typeof w.bosses === "object" ? w.bosses : {};
    var rawEvents = Array.isArray(w.events) ? w.events : [];
    var events = rawEvents.map(normalizeEventEntry);

    root.innerHTML = "";

    var meta = document.createElement("div");
    meta.className = "world-info__meta";
    meta.innerHTML =
      '<div class="world-info__kv"><span class="world-info__k">Сид</span> <span class="world-info__v">' +
      esc(fmtUnknown(w.seed)) +
      "</span></div>" +
      '<div class="world-info__kv"><span class="world-info__k">День</span> <span class="world-info__v">' +
      esc(fmtUnknown(w.day)) +
      "</span></div>";
    root.appendChild(meta);

    var bossHead = document.createElement("div");
    bossHead.className = "world-info__subhead";
    bossHead.textContent = "Боссы";
    root.appendChild(bossHead);

    var bossList = document.createElement("div");
    bossList.className = "world-info__bosses";
    BOSS_KEYS_ORDER.forEach(function (key) {
      var done = !!bosses[key];
      var nm = bossName(key);
      var wiki = bossWikiUrl(key);
      var imgSrc = bossImgSrc(key);
      var line = document.createElement("div");
      line.className =
        "world-info__boss-line" +
        (done ? " world-info__boss-line--done" : " world-info__boss-line--pending");

      if (imgSrc) {
        var aThumb = document.createElement("a");
        aThumb.className = "world-info__boss-thumb";
        aThumb.href = wiki;
        aThumb.target = "_blank";
        aThumb.rel = "noopener noreferrer";
        aThumb.title = nm;
        var img = document.createElement("img");
        img.src = imgSrc;
        img.alt = nm;
        img.width = 48;
        img.loading = "lazy";
        img.decoding = "async";
        aThumb.appendChild(img);
        line.appendChild(aThumb);
      }

      var aName = document.createElement("a");
      aName.className = "world-info__boss-link";
      aName.href = wiki;
      aName.target = "_blank";
      aName.rel = "noopener noreferrer";
      aName.textContent = nm;

      var mark = document.createElement("span");
      mark.className = "world-info__boss-mark";
      mark.textContent = done ? "✓" : "✗";

      line.appendChild(aName);
      line.appendChild(mark);
      bossList.appendChild(line);
    });
    root.appendChild(bossList);

    var evHead = document.createElement("div");
    evHead.className = "world-info__subhead world-info__subhead--spaced";
    evHead.textContent = "Последние события";
    root.appendChild(evHead);

    var evBox = document.createElement("div");
    evBox.className = "world-info__events";
    if (!events.length) {
      evBox.innerHTML = '<span class="world-info__muted">нет данных в логе</span>';
    } else {
      events
        .slice()
        .reverse()
        .forEach(function (entry, idx) {
          var chip = document.createElement("span");
          var isLatest = idx === 0;
          chip.className =
            "world-info__event-chip" +
            (entry.unknown ? " world-info__event-chip--unknown" : "") +
            (isLatest ? " world-info__event-chip--latest" : "");
          var label = entry.nameRu || entry.id;
          if (isLatest && entry.gameDaysAgo != null) {
            label += " · " + formatGameDaysAgo(entry.gameDaysAgo);
          }
          chip.textContent = label;
          chip.setAttribute("title", eventTooltip(entry));
          if (entry.unknown) {
            chip.setAttribute("data-event-id", esc(entry.id));
          }
          evBox.appendChild(chip);
        });
    }
    root.appendChild(evBox);
  }

  global.renderWorldInfo = renderWorldInfo;
})(typeof window !== "undefined" ? window : this);
