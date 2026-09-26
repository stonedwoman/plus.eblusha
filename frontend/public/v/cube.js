/* Koban · Valheim — куб разделов.
 *
 * Раздел — одна страница: под неподвижной балкой стоит куб, на левой грани
 * карта, на передней главная, на правой настройки. Поворачивают его щиты
 * балки (обычные ссылки #map / #main / #settings, так что работают и адрес, и
 * «назад» в браузере), клавиши 1 / 2 / 3 и ← / →, а на телефоне — палец:
 * куб едет за ним и на отпускании докручивается до ближайшей грани.
 *
 * В покое куб плоский (cube.css): никакого 3D, текст и карта чёткие. На время
 * поворота грани встают по сторонам куба, а сам куб, чтобы ближнее ребро не
 * вылезало из окна, на середине поворота немного отходит назад.
 *
 * Отдельно здесь же — мост к карте во встроенном окне: кнопки балки
 * «Слои / Игроки / Чат» управляют её панелями, а она сообщает обратно, что
 * открыто и сколько игроков и новых сообщений.
 */
(function () {
  "use strict";

  var FACES = ["map", "main", "options"];
  // Поворот куба, при котором грань смотрит на нас.
  var ANGLE = { map: 90, main: 0, options: -90 };
  // Где грань стоит на кубе.
  var FACE_ROT = { map: -90, main: 0, options: 90 };
  var HASH = { map: "#map", main: "#main", options: "#settings" };
  var TITLE = {
    map: "Карта мира · Koban",
    main: "Koban · Valheim",
    options: "Настройки мира · Koban"
  };
  var MAP_SRC = "/v/map/?embed=1";

  var root = document.documentElement;
  var viewport = document.getElementById("cubeViewport");
  var cube = document.getElementById("cube");
  if (!viewport || !cube) return;

  var faces = {};
  FACES.forEach(function (f) { faces[f] = cube.querySelector(".face--" + f); });
  var frame = document.getElementById("mapFrame");

  var reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var current = faceFromHash();
  var angle = ANGLE[current];
  var raf = 0;
  var W = 0;
  var H = 0;
  var P = 0;
  var zPull = 0; // сколько куб сейчас отошёл назад

  function faceFromHash() {
    var h = (location.hash || "").replace(/^#/, "");
    if (h === "map") return "map";
    if (h === "settings" || h === "options") return "options";
    return "main";
  }

  function measure() {
    W = viewport.clientWidth || window.innerWidth;
    H = viewport.clientHeight || window.innerHeight;
    P = Math.round(Math.max(W, H) * 1.3);
    viewport.style.setProperty("--cube-p", P + "px");
  }

  // Насколько куб отходит назад при угле a. Подбираем так, чтобы дальний
  // угол силуэта (x' = h(c+s) на глубине h|c−s|) проецировался внутрь окна с
  // запасом m; на гранях запас и отход — 0, поэтому нет скачка в начале и в
  // конце поворота. На узком высоком экране (телефон) иначе рёбра куба уходили
  // за края.
  function pull(a) {
    var r = (Math.abs(a) * Math.PI) / 180;
    var c = Math.cos(r), sn = Math.sin(r), h = W / 2;
    var bend = Math.abs(Math.sin(2 * r));
    var m = 20 * bend;
    var need = (h * (c + sn) * P) / (h - m) - P - h + h * Math.abs(c - sn);
    return Math.max(0.32 * W * bend, need);
  }

  // Ширина силуэта куба на 45° при текущем отходе — в пикселях экрана.
  function silhouette45() {
    var h = W / 2;
    var r = Math.PI / 4;
    var x = h * (Math.cos(r) + Math.sin(r));
    var z = -h - pull(45) + h * Math.abs(Math.cos(r) - Math.sin(r));
    var k = P / (P - z);
    return 2 * x * k;
  }

  function place(a, pl) {
    zPull = pl == null ? pull(a) : pl;
    cube.style.transform =
      "translateZ(" + (-W / 2 - zPull).toFixed(1) + "px) rotateY(" + a.toFixed(3) + "deg)";
    // Грань, повёрнутая от нас, темнеет. Свет чуть слева: из двух видимых
    // граней левая светлее, и ребро между ними видно даже на 45°. На самих
    // гранях (0°, ±90°) поправка нулевая — в конце поворота ничего не прыгает.
    FACES.forEach(function (f) {
      var el = faces[f];
      if (!el || !el.classList.contains("is-in")) return;
      var yaw = FACE_ROT[f] + a;
      var net = Math.min(90, Math.abs(yaw));
      var side = 0.1 * Math.sin((yaw * Math.PI) / 180) * Math.abs(Math.sin((a * Math.PI) / 90));
      var shade = Math.max(0, Math.min(0.7, (net / 90) * 0.62 + side));
      el.style.setProperty("--shade", shade.toFixed(3));
    });
  }

  function enter3D(involved) {
    measure();
    FACES.forEach(function (f) {
      var el = faces[f];
      if (!el) return;
      var on = involved.indexOf(f) >= 0;
      el.classList.toggle("is-in", on);
      el.style.transform = on
        ? "rotateY(" + FACE_ROT[f] + "deg) translateZ(" + (W / 2).toFixed(1) + "px)"
        : "";
    });
    root.classList.add("cube-3d");
    setSkies(involved);
  }

  function flatten(face) {
    root.classList.remove("cube-3d");
    cube.style.transform = "";
    FACES.forEach(function (f) {
      var el = faces[f];
      if (!el) return;
      el.classList.remove("is-in");
      el.style.transform = "";
      el.style.removeProperty("--shade");
      el.setAttribute("aria-hidden", f === face ? "false" : "true");
      // Отвёрнутые грани (и карта во встроенном окне) не держат ни фокуса,
      // ни Tab, ни клавиш.
      el.inert = f !== face;
    });
    root.dataset.face = face;
    setSkies([face]);
    // Фокус остался на отвёрнутой грани (ушли с карты клавишами) — ставим
    // его на прокрутку видимой, чтобы PageDown и пробел листали её.
    var cur = faces[face];
    var active = document.activeElement;
    if (cur && active && active !== document.body && !cur.contains(active) && !active.closest(".nr-bar")) {
      var sc = cur.querySelector(".face__scroll");
      if (sc) sc.focus({ preventScroll: true });
      else if (active.blur) active.blur();
    }
  }

  // Небо рисуется только на видимых гранях.
  function setSkies(list) {
    if (window.KobanSky && typeof window.KobanSky.setActive === "function") {
      window.KobanSky.setActive(list);
    }
  }

  // Балка переключается сразу, не дожидаясь конца поворота.
  function announce(face) {
    root.dataset.nav = face;
    document.title = TITLE[face];
    var tabs = document.querySelectorAll(".nr-tab[data-face]");
    Array.prototype.forEach.call(tabs, function (t) {
      if (t.getAttribute("data-face") === face) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    if (face === "map") ensureMap();
    try {
      window.dispatchEvent(new CustomEvent("koban:face", { detail: { face: face } }));
    } catch (e) {}
  }

  function easeInOut(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }

  function turnTo(face) {
    if (!faces[face]) return;
    // Уже крутимся туда — не перезапускаем разгон.
    if (raf && face === current) return;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    var target = ANGLE[face];
    var from = angle;
    var span = Math.abs(target - from);
    // Прерванный поворот: начинаем с того отхода, на котором остановились.
    var pull0 = root.classList.contains("cube-3d") ? zPull : 0;
    current = face;
    announce(face);
    // Ушли с настроек («назад» в браузере) — окно пароля не должно висеть.
    if (face !== "options" && faces.options) {
      Array.prototype.forEach.call(faces.options.querySelectorAll("dialog[open]"), function (d) { d.close(); });
    }

    if (reduceMotion || Math.abs(target - from) < 0.01) {
      angle = target;
      flatten(face);
      return;
    }

    // Все грани, что хоть где-то на пути окажутся на виду (ближе 90°), —
    // в том числе когда цель сменили посреди поворота.
    var lo = Math.min(from, target);
    var hi = Math.max(from, target);
    var involved = FACES.filter(function (f) { return ANGLE[f] > lo - 89.99 && ANGLE[f] < hi + 89.99; });
    enter3D(involved);

    var dur = 620 + span * 3.6;
    // Отход на 0°, при котором плоская грань видна той же ширины, что силуэт
    // куба на 45°.
    var w45 = silhouette45();
    var F180 = w45 > 0 ? Math.max(0, P * (W / w45 - 1)) : 0.2 * W;
    var t0 = performance.now();
    place(from, Math.max(pull(from), pull0));
    function step(now) {
      var p = Math.min(1, (now - t0) / dur);
      var e = easeInOut(p);
      angle = from + (target - from) * e;
      var pl = pull(angle);
      // Карта ↔ настройки: один отход на весь поворот, без нырка вперёд на 0°
      // и без лишнего отскока назад — на 0° куб такой же ширины, как на 45°.
      if (span > 90) pl = Math.max(pl, F180 * Math.sin(Math.PI * p));
      pl = Math.max(pl, pull0 * (1 - e));
      place(angle, pl);
      if (p < 1) {
        raf = requestAnimationFrame(step);
      } else {
        raf = 0;
        angle = target;
        flatten(face);
      }
    }
    raf = requestAnimationFrame(step);
  }

  function go(face) {
    if (!faces[face]) return;
    var hash = HASH[face];
    if (location.hash === hash) {
      turnTo(face);
      return;
    }
    // Своя запись в истории: «назад» в браузере поворачивает куб обратно.
    location.hash = hash;
  }

  window.addEventListener("hashchange", function () {
    turnTo(faceFromHash());
  });

  window.addEventListener("resize", function () {
    measure();
    if (root.classList.contains("cube-3d")) {
      enter3D(FACES.filter(function (f) { return faces[f] && faces[f].classList.contains("is-in"); }));
      place(angle);
    }
  });

  // ---------- клавиши ----------

  function typing(t) {
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  function neighbour(dir) {
    var i = FACES.indexOf(current) + dir;
    return FACES[Math.max(0, Math.min(FACES.length - 1, i))];
  }

  function onKey(key) {
    if (key === "1") go("map");
    else if (key === "2") go("main");
    else if (key === "3") go("options");
    else if (key === "ArrowLeft") go(neighbour(-1));
    else if (key === "ArrowRight") go(neighbour(1));
    else return false;
    return true;
  }

  // Окно больше не прокручивается — прокручивается грань. На клавишу
  // прокрутки отдаём фокус прокрутке видимой грани, а листает уже браузер.
  var SCROLL_KEY = /^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown| )$/;

  function focusFaceScroller(e) {
    var t = e.target;
    var onBar = t && t.closest && t.closest(".nr-bar");
    if (!(t === document.body || t === root || (onBar && (e.key !== " " || t.tagName === "A")))) return;
    var sc = faces[current] && faces[current].querySelector(".face__scroll");
    if (sc) sc.focus({ preventScroll: true });
  }

  window.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e.target) || document.querySelector("dialog[open]")) return;
    if (SCROLL_KEY.test(e.key)) { focusFaceScroller(e); return; }
    if (e.key === "Escape" && current === "map") {
      toMap({ type: "koban-map", cmd: "close" });
      return;
    }
    if (e.shiftKey) return;
    if (e.repeat && /^[123]$/.test(e.key)) { e.preventDefault(); return; }
    if (onKey(e.key)) e.preventDefault();
  });

  // ---------- палец: куб едет за ним ----------

  var drag = null;

  function faceForAngle(a) {
    var best = "main";
    var bestD = Infinity;
    FACES.forEach(function (f) {
      var d = Math.abs(ANGLE[f] - a);
      if (d < bestD) { bestD = d; best = f; }
    });
    return best;
  }

  viewport.addEventListener("pointerdown", function (e) {
    if (e.pointerType !== "touch" || !e.isPrimary || raf) return;
    // Ручки админ-режима и его панели — не повод крутить куб.
    if (e.target && e.target.closest && e.target.closest("[data-noswipe]")) return;
    // На карте палец двигает карту, а не куб.
    if (current === "map") return;
    // Внутри того, что само листается вбок, — листаем его.
    for (var n = e.target; n && n !== viewport; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 2) {
        var ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll") return;
      }
    }
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, a0: angle, on: false, lastX: e.clientX, lastT: e.timeStamp, v: 0 };
  }, { passive: true });

  viewport.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x0;
    var dy = e.clientY - drag.y0;
    if (!drag.on) {
      if (Math.abs(dx) < 14) return;
      // Больше вниз, чем вбок — это прокрутка, не мешаем.
      if (Math.abs(dx) < Math.abs(dy) * 1.4) { drag = null; return; }
      drag.on = true;
      // Грани на время поворота не принимают касаний — держим палец на сцене.
      try { viewport.setPointerCapture(e.pointerId); } catch (err) {}
      enter3D(FACES);
    }
    var dt = Math.max(1, e.timeStamp - drag.lastT);
    drag.v = (e.clientX - drag.lastX) / dt;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    angle = Math.max(-90, Math.min(90, drag.a0 + (dx / W) * 110));
    place(angle);
  }, { passive: true });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag;
    drag = null;
    if (!d.on) return;
    // Бросок докручивает дальше, чем стоял палец. Палец постоял перед тем,
    // как оторваться, — это не бросок.
    var v = e.timeStamp - d.lastT > 80 ? 0 : d.v;
    var projected = angle + (v * 260 / W) * 110;
    var face = faceForAngle(projected);
    if (Math.abs(ANGLE[face] - d.a0) > 90) face = faceForAngle(d.a0 + Math.sign(ANGLE[face] - d.a0) * 90);
    if (face === current) turnTo(face);
    else go(face);
  }

  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  // ---------- карта во встроенном окне ----------

  var mapState = { panels: {}, players: 0, unread: 0 };
  // Карта прислала koban-map-ready — её скрипт уже слушает. До этого окно
  // ещё грузится, и сообщения в него теряются: нажатия на кнопки балки
  // запоминаем как «хочу открыто/закрыто» и сверяем с первым её отчётом.
  var mapReady = false;
  var mapWant = {};

  function ensureMap() {
    if (frame && !frame.getAttribute("src")) frame.setAttribute("src", MAP_SRC);
  }

  function toMap(msg) {
    ensureMap();
    if (!mapReady || !frame || !frame.contentWindow) return;
    try { frame.contentWindow.postMessage(msg, location.origin); } catch (e) {}
  }

  function anchorOf(btn) {
    var r = btn.getBoundingClientRect();
    return Math.round(r.left + r.width / 2);
  }

  // Кнопки балки двигаются от ширины окна, масштаба и счётчиков — карте нужны
  // свежие координаты, чтобы ромб каждой панели указывал на свою кнопку.
  function sendAnchors() {
    if (!mapReady) return;
    var a = {};
    var any = false;
    Array.prototype.forEach.call(document.querySelectorAll("[data-map-panel]"), function (btn) {
      var r = btn.getBoundingClientRect();
      if (r.width > 0) {
        a[btn.getAttribute("data-map-panel")] = Math.round(r.left + r.width / 2);
        any = true;
      }
    });
    if (any) toMap({ type: "koban-map", cmd: "anchors", anchors: a });
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-map-panel]"), function (btn) {
    btn.addEventListener("click", function () {
      var name = btn.getAttribute("data-map-panel");
      if (!mapReady) {
        ensureMap();
        var cur = name in mapWant ? mapWant[name] : !!mapState.panels[name];
        mapWant[name] = !cur;
        btn.setAttribute("aria-pressed", mapWant[name] ? "true" : "false");
        return;
      }
      toMap({ type: "koban-map", cmd: "toggle", panel: name, anchor: anchorOf(btn) });
    });
  });

  function renderMapState() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-map-panel]"), function (btn) {
      var name = btn.getAttribute("data-map-panel");
      var open = name in mapWant ? mapWant[name] : !!mapState.panels[name];
      btn.setAttribute("aria-pressed", open ? "true" : "false");
    });
    var pc = document.getElementById("mapPlayersCount");
    if (pc) {
      pc.textContent = String(mapState.players || 0);
      pc.classList.toggle("is-live", (mapState.players || 0) > 0);
    }
    var cc = document.getElementById("mapChatCount");
    if (cc) {
      var n = mapState.unread || 0;
      cc.hidden = n === 0;
      cc.textContent = n > 99 ? "99+" : String(n);
    }
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (!frame || e.source !== frame.contentWindow) return;
    var d = e.data;
    if (d.type === "koban-map-state") {
      mapState = d;
      mapState.panels = mapState.panels || {};
      // Нажатия, сделанные пока карта грузилась: переключаем только те панели,
      // что сейчас не в нужном положении (открытую с прошлого раза не трогаем).
      var pend = Object.keys(mapWant);
      if (mapReady && pend.length) {
        var want = mapWant;
        mapWant = {};
        pend.forEach(function (name) {
          var b = document.querySelector('[data-map-panel="' + name + '"]');
          if (!!mapState.panels[name] !== want[name] && b) {
            toMap({ type: "koban-map", cmd: "toggle", panel: name, anchor: anchorOf(b) });
            mapState.panels[name] = want[name];
          }
        });
      }
      renderMapState();
      sendAnchors();
    } else if (d.type === "koban-key") {
      onKey(d.key);
    } else if (d.type === "koban-map-ready") {
      mapReady = true;
      toMap({ type: "koban-map", cmd: "hello" });
      sendAnchors();
    }
  });

  var anchorTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(anchorTimer);
    anchorTimer = setTimeout(sendAnchors, 120);
  });
  window.addEventListener("koban:face", function (e) {
    if (e.detail && e.detail.face === "map") requestAnimationFrame(sendAnchors);
  });

  // Карту подгружаем заранее, когда главная уже отрисовалась: к первому
  // повороту на неё она будет готова. На неё же сразу — если открыли #map.
  if (current === "map") {
    ensureMap();
  } else if (root.classList.contains("nr-admin")) {
    // В админ-режиме карта не нужна, пока на неё не повернули.
  } else {
    var later = function () {
      if (window.requestIdleCallback) window.requestIdleCallback(ensureMap, { timeout: 4000 });
      else setTimeout(ensureMap, 1500);
    };
    if (document.readyState === "complete") later();
    else window.addEventListener("load", later);
  }

  // Наведение на щит карты — тоже повод начать грузить.
  var mapTab = document.querySelector('.nr-tab[data-face="map"]');
  if (mapTab) mapTab.addEventListener("pointerenter", ensureMap, { once: true });

  // ---------- старт ----------

  measure();
  flatten(current);
  announce(current);

  window.KobanCube = {
    go: go,
    current: function () { return current; },
    // Для проверок: поставить куб на произвольный угол и замереть
    // (pose(45)), вернуть в покой — pose(null).
    pose: function (a) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (a === null || a === undefined) { angle = ANGLE[current]; flatten(current); return; }
      angle = a;
      enter3D(FACES);
      place(a);
    }
  };
})();
