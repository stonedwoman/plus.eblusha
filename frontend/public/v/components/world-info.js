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

  // ---- раскрытие плитки босса ----
  // Плитка разворачивается поверх соседей и показывает раздел «Советы» с вики.
  // Советы лежат в статическом /v/data/boss-tips.json (снят с Fandom, CC BY-SA).
  var expandedKey = null;
  var tipsCache = null;
  var tipsLoading = null;
  var lastBossesJson = null;
  var resizeObs = null;
  var REDUCED_MOTION =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function loadTips() {
    if (tipsCache) return Promise.resolve(tipsCache);
    if (tipsLoading) return tipsLoading;
    tipsLoading = fetch("/v/data/boss-tips.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        tipsCache = j;
        return j;
      })
      .catch(function () {
        tipsLoading = null;
        return null;
      });
    return tipsLoading;
  }

  function buildTipsList(entry) {
    if (!entry || !entry.tips || !entry.tips.length) {
      var none = document.createElement("div");
      none.className = "world-info__muted";
      none.textContent = "Советов на вики пока нет.";
      return none;
    }
    var ul = document.createElement("ul");
    ul.className = "boss-tips__list";
    entry.tips.forEach(function (t) {
      var li = document.createElement("li");
      li.textContent = t.text || "";
      if (t.sub && t.sub.length) {
        var sub = document.createElement("ul");
        t.sub.forEach(function (txt) {
          var l2 = document.createElement("li");
          l2.textContent = txt;
          sub.appendChild(l2);
        });
        li.appendChild(sub);
      }
      ul.appendChild(li);
    });
    return ul;
  }

  /** Заполняет контейнер советами. Если они уже в кэше — синхронно,
   *  чтобы высоту плитки можно было измерить до анимации. */
  function renderTipsInto(box, key) {
    if (tipsCache) {
      box.innerHTML = "";
      box.appendChild(buildTipsList(tipsCache.bosses && tipsCache.bosses[key]));
      return Promise.resolve(false);
    }
    box.innerHTML = '<div class="world-info__muted">Загружаю советы…</div>';
    return loadTips().then(function (data) {
      box.innerHTML = "";
      box.appendChild(buildTipsList(data && data.bosses && data.bosses[key]));
      return true;
    });
  }

  function tileRect(tile) {
    return {
      top: tile.offsetTop,
      left: tile.offsetLeft,
      width: tile.offsetWidth,
      height: tile.offsetHeight,
    };
  }

  function applyRect(tile, r) {
    tile.style.top = r.top + "px";
    tile.style.left = r.left + "px";
    tile.style.width = r.width + "px";
    tile.style.height = r.height + "px";
  }

  function clearRect(tile) {
    tile.style.top = "";
    tile.style.left = "";
    tile.style.width = "";
    tile.style.height = "";
  }

  function stripIds(el) {
    var withId = el.querySelectorAll("[id]");
    for (var i = 0; i < withId.length; i++) withId[i].removeAttribute("id");
    el.removeAttribute("id");
  }

  /** Итоговая высота плитки в развёрнутом виде. Меряем скрытым клоном с конечными
   *  классами и выключенными переходами: живая плитка в этот момент ещё едет —
   *  миниатюра 72px, шрифт маленький, и её scrollHeight врёт. */
  function measureExpandedHeight(grid, tile, width) {
    var clone = tile.cloneNode(true);
    stripIds(clone);
    clone.classList.remove("boss-tile--animating", "boss-tile--restored");
    clone.classList.add("boss-tile--expanded", "boss-tile--measure");
    clone.style.cssText =
      "position:absolute;top:0;left:0;height:auto;visibility:hidden;pointer-events:none;width:" +
      width +
      "px;";
    grid.appendChild(clone);
    var h = clone.offsetHeight;
    grid.removeChild(clone);
    return h;
  }

  /** Пока плитка развёрнута и вне потока, её место в сетке держит невидимая
   *  заглушка того же размера — иначе соседи в момент клика съезжают на
   *  освободившееся место, и всё дёргается. Сворачивается плитка ровно в заглушку. */
  function placeholderFor(tile) {
    var ph = tile.cloneNode(true);
    stripIds(ph);
    ph.className = "world-info__boss-line boss-tile boss-tile--placeholder";
    ph.setAttribute("aria-hidden", "true");
    ph.removeAttribute("role");
    ph.removeAttribute("data-boss");
    ph.style.cssText = "visibility:hidden;pointer-events:none;";
    return ph;
  }

  function removePlaceholder(tile) {
    var ph = tile._placeholder;
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
    tile._placeholder = null;
  }

  /** Куда плитке садиться и какой будет высота сетки: слот — это заглушка,
   *  а высоту сетки меряем без inline min-height и без переходов. */
  function measureSlot(grid, tile) {
    var ph = tile._placeholder;
    var rect = ph ? tileRect(ph) : tileRect(tile);
    var savedMin = grid.style.minHeight;
    grid.classList.add("world-info__bosses--measure");
    grid.style.minHeight = "";
    var naturalH = grid.offsetHeight;
    grid.style.minHeight = savedMin;
    void grid.offsetHeight; // пересчёт, пока переходы сетки выключены
    grid.classList.remove("world-info__bosses--measure");
    return { rect: rect, naturalH: naturalH };
  }

  /** Снять обработчик и таймер незавершённого перехода: иначе старый onEnd
   *  дёрнется посреди нового и плитка прыгнет. */
  function cancelPending(tile) {
    var p = tile._pending;
    if (!p) return;
    tile.removeEventListener("transitionend", p.onEnd);
    clearTimeout(p.timer);
    tile._pending = null;
  }

  /** Ждём именно переход высоты: background и border-color заканчиваются раньше
   *  и тоже шлют transitionend с той же цели. */
  function armEnd(tile, finish) {
    cancelPending(tile);
    var done = false;
    var onEnd = function (e) {
      if (done) return;
      if (e && (e.target !== tile || e.propertyName !== "height")) return;
      done = true;
      tile.removeEventListener("transitionend", onEnd);
      clearTimeout(pending.timer);
      tile._pending = null;
      finish();
    };
    var pending = { onEnd: onEnd, timer: setTimeout(onEnd, 650) };
    tile._pending = pending;
    tile.addEventListener("transitionend", onEnd);
  }

  function watchExpanded(grid, tile) {
    unwatchExpanded();
    if (typeof ResizeObserver === "undefined") return;
    resizeObs = new ResizeObserver(function () {
      syncExpandedHeight(grid, tile);
    });
    resizeObs.observe(tile);
  }

  function unwatchExpanded() {
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
  }

  /** Высота сетки под развёрнутую плитку, но не ниже её собственной высоты
   *  со скрытыми соседями — иначе под короткими советами пустая полоса. */
  function syncExpandedHeight(grid, tile) {
    if (!grid || !tile || !tile.classList.contains("boss-tile--expanded")) return;
    if (tile.classList.contains("boss-tile--animating")) return;
    var h = Math.max(tile.offsetHeight, grid._naturalH || 0);
    grid.style.minHeight = h + "px";
  }

  function setExpandedState(tile, on) {
    var toggle = tile.querySelector(".boss-tile__toggle");
    if (toggle) toggle.setAttribute("aria-expanded", on ? "true" : "false");
  }

  function focusQuiet(el) {
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      el.focus();
    }
  }

  function expandTile(tile, animate) {
    var grid = tile.parentNode;
    if (!grid) return;
    var key = tile.getAttribute("data-boss");

    var prev = grid.querySelector(".boss-tile--expanded");
    if (prev && prev !== tile) collapseTile(prev, false);
    cancelPending(tile);
    grid.classList.remove("world-info__bosses--closing");

    var first = tileRect(tile);
    var gridW = grid.clientWidth;
    var gridH = grid.offsetHeight;
    grid._naturalH = gridH;

    expandedKey = key;
    removePlaceholder(tile);
    var placeholder = placeholderFor(tile);
    grid.insertBefore(placeholder, tile);
    tile._placeholder = placeholder;
    grid.classList.add("world-info__bosses--has-expanded");
    tile.classList.add("boss-tile--expanded");
    tile.classList.toggle("boss-tile--restored", !animate);
    setExpandedState(tile, true);

    var tipsBox = tile.querySelector("[data-tips]");
    var tipsReady = renderTipsInto(tipsBox, key);
    var targetH = measureExpandedHeight(grid, tile, gridW);

    var finish = function () {
      tile.classList.remove("boss-tile--animating");
      clearRect(tile);
      syncExpandedHeight(grid, tile);
      watchExpanded(grid, tile);
    };

    if (animate && !REDUCED_MOTION) {
      applyRect(tile, first);
      grid.style.minHeight = gridH + "px";
      void tile.offsetWidth; // зафиксировать стартовое положение
      tile.classList.add("boss-tile--animating");
      applyRect(tile, { top: 0, left: 0, width: gridW, height: targetH });
      grid.style.minHeight = Math.max(targetH, gridH) + "px";
      armEnd(tile, finish);
    } else {
      // Без анимации (восстановление после перерисовки): сетку тоже не анимировать.
      grid.classList.add("world-info__bosses--measure");
      grid.style.minHeight = Math.max(targetH, gridH) + "px";
      void grid.offsetHeight;
      grid.classList.remove("world-info__bosses--measure");
      finish();
    }

    // Советы пришли позже замера — перенацелить идущую анимацию на новую высоту.
    tipsReady.then(function (changed) {
      if (!changed || !tile.classList.contains("boss-tile--expanded")) return;
      if (tile.classList.contains("boss-tile--animating")) {
        var h = measureExpandedHeight(grid, tile, grid.clientWidth);
        tile.style.height = h + "px";
        grid.style.minHeight = Math.max(h, grid._naturalH || 0) + "px";
      } else {
        syncExpandedHeight(grid, tile);
      }
    });

    if (animate) focusQuiet(tile.querySelector(".boss-tile__close"));
  }

  function collapseTile(tile, animate) {
    var grid = tile.parentNode;
    if (!grid) return;
    cancelPending(tile);
    unwatchExpanded();

    var cur = tileRect(tile); // текущее, возможно промежуточное положение
    var slot = measureSlot(grid, tile);

    expandedKey = null;
    setExpandedState(tile, false);

    var finish = function () {
      removePlaceholder(tile);
      tile.classList.remove(
        "boss-tile--animating",
        "boss-tile--expanded",
        "boss-tile--restored"
      );
      grid.classList.remove("world-info__bosses--has-expanded", "world-info__bosses--closing");
      clearRect(tile);
      grid.style.minHeight = "";
    };

    if (animate && !REDUCED_MOTION) {
      applyRect(tile, cur);
      void tile.offsetWidth;
      tile.classList.add("boss-tile--animating");
      grid.classList.add("world-info__bosses--closing");
      applyRect(tile, slot.rect);
      // px → px: сетка едет вместе с плиткой, а не падает и не прыгает.
      grid.style.minHeight = slot.naturalH + "px";
      armEnd(tile, finish);
    } else {
      finish();
    }

    if (animate) {
      focusQuiet(tile.querySelector(".boss-tile__toggle"));
      try {
        tile.scrollIntoView({ block: "nearest" });
      } catch (e) {
        // старые браузеры — не критично
      }
    }
  }

  function toggleTile(tile) {
    if (tile.classList.contains("boss-tile--animating")) return;
    if (tile.classList.contains("boss-tile--expanded")) collapseTile(tile, true);
    else expandTile(tile, true);
  }

  // Советы подтягиваем заранее: тогда высота плитки известна до клика,
  // и анимация идёт сразу к цели, без перенацеливания на полпути.
  if (typeof fetch === "function") loadTips();

  if (typeof document !== "undefined") {
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !expandedKey) return;
      var open = document.querySelector(".boss-tile--expanded");
      if (open) collapseTile(open, true);
    });
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

  function plural(value, one, few, many) {
    var mod10 = value % 10;
    var mod100 = value % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  }

  /**
   * Возраст события реальным временем. Игровыми сутками его не измерить:
   * внутриигровые часы идут только когда на сервере есть люди.
   */
  function formatRealAgo(seconds) {
    if (seconds == null || !isFinite(seconds)) return "";
    var s = Math.max(0, Math.floor(seconds));
    if (s < 90) return "только что";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " " + plural(m, "минуту", "минуты", "минут") + " назад";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " " + plural(h, "час", "часа", "часов") + " назад";
    var d = Math.floor(h / 24);
    return d + " " + plural(d, "день", "дня", "дней") + " назад";
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
        secondsAgo: undefined,
          secondsAgo: undefined,
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
        secondsAgo: undefined,
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
        secondsAgo: undefined,
      };
    }

    var id = String(ev.id != null ? ev.id : "").toLowerCase();
    var meta = (META && META[id]) || null;
    var apiName = ev.nameRu;
    var apiUnknown = ev.unknown;
    var apiGameDays = ev.gameDaysAgo != null ? ev.gameDaysAgo : ev.daysAgo;
    var apiEventDay = ev.eventDay;
    var apiAt = ev.occurredAt;
    var apiSeconds = ev.secondsAgo;

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
      secondsAgo: apiSeconds != null ? apiSeconds : undefined,
        secondsAgo: apiSeconds != null ? apiSeconds : undefined,
          secondsAgo: apiSeconds != null ? apiSeconds : undefined,
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
      secondsAgo: apiSeconds != null ? apiSeconds : undefined,
        secondsAgo: apiSeconds != null ? apiSeconds : undefined,
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
      secondsAgo: apiSeconds != null ? apiSeconds : undefined,
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

    // Опрос перерисовывает панель каждые ~20 с, а в событиях всегда меняется
    // secondsAgo, так что сравнивать весь world бесполезно. Сравниваем только
    // боссов: если они те же, сетку с плитками переносим в новую разметку как есть —
    // развёрнутая плитка, её фокус и загруженные советы переживают перерисовку.
    var bossesJson = "";
    try {
      bossesJson = JSON.stringify(bosses);
    } catch (e) {
      bossesJson = "";
    }
    var keepGrid =
      bossesJson && bossesJson === lastBossesJson
        ? root.querySelector(".world-info__bosses")
        : null;
    lastBossesJson = bossesJson;
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

    if (keepGrid) {
      root.appendChild(keepGrid);
    } else {
      var bossList = document.createElement("div");
      bossList.className = "world-info__bosses";
      BOSS_KEYS_ORDER.forEach(function (key) {
        var done = !!bosses[key];
        var nm = bossName(key);
        var wiki = bossWikiUrl(key);
        var imgSrc = bossImgSrc(key);
        var nameId = "boss-name-" + key;
        var bodyId = "boss-body-" + key;

        var tile = document.createElement("div");
        tile.className =
          "world-info__boss-line boss-tile" +
          (done ? " world-info__boss-line--done" : " world-info__boss-line--pending");
        tile.setAttribute("role", "group");
        tile.setAttribute("aria-labelledby", nameId);
        tile.setAttribute("data-boss", key);

        var head = document.createElement("div");
        head.className = "boss-tile__head";

        // Кнопка — только шапка: имя кнопки остаётся именем босса, а не всем текстом советов.
        var toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "boss-tile__toggle";
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-controls", bodyId);

        if (imgSrc) {
          var thumb = document.createElement("span");
          thumb.className = "world-info__boss-thumb";
          var img = document.createElement("img");
          img.src = imgSrc;
          img.alt = "";
          img.width = 72;
          img.height = 72;
          img.loading = "lazy";
          img.decoding = "async";
          thumb.appendChild(img);
          toggle.appendChild(thumb);
        }

        var titleBox = document.createElement("span");
        titleBox.className = "boss-tile__title";
        var nameEl = document.createElement("span");
        nameEl.className = "world-info__boss-link";
        nameEl.id = nameId;
        nameEl.textContent = nm;
        var status = document.createElement("span");
        status.className = "boss-tile__status";
        status.textContent = done ? "Повержен" : "Ещё жив";
        titleBox.appendChild(nameEl);
        titleBox.appendChild(status);
        toggle.appendChild(titleBox);

        var mark = document.createElement("span");
        mark.className = "world-info__boss-mark";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = done ? "✓" : "✗";
        toggle.appendChild(mark);

        head.appendChild(toggle);

        var close = document.createElement("button");
        close.type = "button";
        close.className = "boss-tile__close";
        close.setAttribute("aria-label", "Свернуть");
        close.textContent = "×";
        head.appendChild(close);

        tile.appendChild(head);

        var body = document.createElement("div");
        body.className = "boss-tile__body";
        body.id = bodyId;
        var tipsHead = document.createElement("div");
        tipsHead.className = "world-info__subhead boss-tile__subhead";
        tipsHead.textContent = "Советы";
        body.appendChild(tipsHead);
        var tipsBox = document.createElement("div");
        tipsBox.className = "boss-tips";
        tipsBox.setAttribute("data-tips", "");
        body.appendChild(tipsBox);
        var foot = document.createElement("div");
        foot.className = "boss-tile__foot";
        var src = document.createElement("span");
        src.textContent = "Источник: Valheim вики на Fandom, CC BY-SA · ";
        var link = document.createElement("a");
        link.href = wiki;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Смотреть на fandom.com ↗";
        var collapseBtn = document.createElement("button");
        collapseBtn.type = "button";
        collapseBtn.className = "boss-tile__collapse";
        collapseBtn.textContent = "Свернуть";
        foot.appendChild(src);
        foot.appendChild(link);
        foot.appendChild(collapseBtn);
        body.appendChild(foot);
        tile.appendChild(body);

        toggle.addEventListener("click", function () {
          toggleTile(tile);
        });
        // Кликабельна вся плитка, а не только имя. В развёрнутом виде
        // сворачивает клик по шапке; по тексту советов — нет, чтобы его можно было выделять.
        tile.addEventListener("click", function (e) {
          if (e.target.closest("a, button")) return;
          if (!tile.classList.contains("boss-tile--expanded")) {
            toggleTile(tile);
          } else if (e.target.closest(".boss-tile__head")) {
            collapseTile(tile, true);
          }
        });
        close.addEventListener("click", function () {
          collapseTile(tile, true);
        });
        collapseBtn.addEventListener("click", function () {
          collapseTile(tile, true);
        });

        bossList.appendChild(tile);
      });
      root.appendChild(bossList);

      // Боссы изменились, сетка собрана заново: вернуть развёрнутую плитку без анимации.
      if (expandedKey) {
        var again = bossList.querySelector('[data-boss="' + expandedKey + '"]');
        if (again) expandTile(again, false);
      }
    }

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
          if (isLatest) {
            var ago =
              entry.secondsAgo != null
                ? formatRealAgo(entry.secondsAgo)
                : entry.gameDaysAgo != null
                  ? formatGameDaysAgo(entry.gameDaysAgo)
                  : "";
            if (ago) label += " · " + ago;
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
