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

  function faceFromHash() {
    var h = (location.hash || "").replace(/^#/, "");
    if (h === "map") return "map";
    if (h === "settings" || h === "options") return "options";
    return "main";
  }

  function measure() {
    W = viewport.clientWidth || window.innerWidth;
    H = viewport.clientHeight || window.innerHeight;
    viewport.style.setProperty("--cube-p", Math.round(Math.max(W, H) * 1.3) + "px");
  }

  // Насколько куб отходит назад при угле a: на 45° больше всего, на гранях — 0.
  function pull(a) {
    return 0.32 * W * Math.abs(Math.sin((a * Math.PI) / 90));
  }

  function place(a) {
    cube.style.transform =
      "translateZ(" + (-W / 2 - pull(a)).toFixed(1) + "px) rotateY(" + a.toFixed(3) + "deg)";
    // Грань, повёрнутая от нас, темнеет.
    FACES.forEach(function (f) {
      var el = faces[f];
      if (!el || !el.classList.contains("is-in")) return;
      var net = Math.min(90, Math.abs(FACE_ROT[f] + a));
      el.style.setProperty("--shade", ((net / 90) * 0.62).toFixed(3));
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
    });
    root.dataset.face = face;
    setSkies([face]);
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
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    var target = ANGLE[face];
    var from = angle;
    current = face;
    announce(face);

    if (reduceMotion || Math.abs(target - from) < 0.01) {
      angle = target;
      flatten(face);
      return;
    }

    var lo = Math.min(from, target) - 0.01;
    var hi = Math.max(from, target) + 0.01;
    var involved = FACES.filter(function (f) { return ANGLE[f] >= lo && ANGLE[f] <= hi; });
    enter3D(involved);

    var dur = 620 + Math.abs(target - from) * 3.6;
    var t0 = performance.now();
    place(from);
    function step(now) {
      var p = Math.min(1, (now - t0) / dur);
      angle = from + (target - from) * easeInOut(p);
      place(angle);
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

  window.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (typing(e.target) || document.querySelector("dialog[open]")) return;
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
    // Бросок докручивает дальше, чем стоял палец.
    var projected = angle + (d.v * 260 / W) * 110;
    var face = faceForAngle(projected);
    if (Math.abs(ANGLE[face] - d.a0) > 90) face = faceForAngle(d.a0 + Math.sign(ANGLE[face] - d.a0) * 90);
    if (face === current) turnTo(face);
    else go(face);
  }

  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  // ---------- карта во встроенном окне ----------

  var mapState = { panels: {}, players: 0, unread: 0 };

  function ensureMap() {
    if (frame && !frame.getAttribute("src")) frame.setAttribute("src", MAP_SRC);
  }

  function toMap(msg) {
    ensureMap();
    if (!frame || !frame.contentWindow) return;
    try { frame.contentWindow.postMessage(msg, location.origin); } catch (e) {}
  }

  function anchorOf(btn) {
    var r = btn.getBoundingClientRect();
    return Math.round(r.left + r.width / 2);
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-map-panel]"), function (btn) {
    btn.addEventListener("click", function () {
      var name = btn.getAttribute("data-map-panel");
      toMap({ type: "koban-map", cmd: "toggle", panel: name, anchor: anchorOf(btn) });
    });
  });

  function renderMapState() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-map-panel]"), function (btn) {
      var open = !!mapState.panels[btn.getAttribute("data-map-panel")];
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
    var d = e.data;
    if (d.type === "koban-map-state") {
      mapState = d;
      renderMapState();
    } else if (d.type === "koban-key") {
      onKey(d.key);
    } else if (d.type === "koban-map-ready") {
      toMap({ type: "koban-map", cmd: "hello" });
    }
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
