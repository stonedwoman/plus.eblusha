/* Koban · Valheim — общее поведение трёх страниц.
 *
 * 1. Переходы между страницами: ссылки внутри раздела /v перелистывают
 *    страницу как лист (см. .k-stage в theme.css). Уходящая страница
 *    запоминает направление в sessionStorage, приходящая его читает и
 *    въезжает с той же стороны. Инлайновый скрипт в <head> по этому же ключу
 *    закрывает окно занавесом до первого кадра, чтобы не мигало белым.
 *
 * 2. Наклон плиток за курсором ([data-tilt]) — только для мыши.
 */
(function () {
  "use strict";

  var KEY = "koban.transit";
  var LEAVE_MS = 380;
  var root = document.documentElement;
  var reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function readTransit() {
    try {
      var raw = sessionStorage.getItem(KEY);
      sessionStorage.removeItem(KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || Date.now() - data.t > 8000) return null;
      return data.dir === "back" ? "back" : "fwd";
    } catch (e) {
      return null;
    }
  }

  function writeTransit(dir) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ dir: dir, t: Date.now() }));
    } catch (e) {}
  }

  function clearClasses() {
    root.classList.remove(
      "k-pre", "k-enter-fwd", "k-enter-back", "k-enter-first",
      "k-leave-fwd", "k-leave-back"
    );
  }

  // ---------- вход ----------

  function enter() {
    var dir = readTransit();
    root.classList.remove("k-pre");
    if (reduceMotion) return;
    root.classList.add(dir ? "k-enter-" + dir : "k-enter-first");
    // Снимаем классы после анимации: иначе fill-mode держит transform и
    // мешает hover-эффектам и наклону плиток.
    setTimeout(function () {
      root.classList.remove("k-enter-fwd", "k-enter-back", "k-enter-first");
    }, 800);
  }

  // ---------- выход ----------

  function pageDepth(path) {
    // Главная — корень раздела, всё остальное глубже.
    var p = path.replace(/\/+$/, "");
    return p === "/v" || p === "" ? 0 : 1;
  }

  function onClick(ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (!a) return;
    if (a.target && a.target !== "_self") return;
    if (a.hasAttribute("download") || a.dataset.transit === "none") return;

    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return; }
    if (url.origin !== location.origin) return;
    if (!/^\/v(\/|$)/.test(url.pathname)) return;
    if (url.pathname === location.pathname && url.hash) return;

    var dir = a.dataset.transit;
    if (dir !== "back" && dir !== "fwd") {
      dir = pageDepth(url.pathname) < pageDepth(location.pathname) ? "back" : "fwd";
    }

    ev.preventDefault();
    writeTransit(dir);
    if (reduceMotion) {
      location.href = url.href;
      return;
    }
    clearClasses();
    root.classList.add("k-leave-" + dir);
    setTimeout(function () { location.href = url.href; }, LEAVE_MS);
  }

  document.addEventListener("click", onClick);

  // Возврат из кэша «назад»: страница приходит с классом ухода и невидима.
  window.addEventListener("pageshow", function (ev) {
    if (ev.persisted) {
      clearClasses();
      try { sessionStorage.removeItem(KEY); } catch (e) {}
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enter);
  } else {
    enter();
  }

  // ---------- наклон плиток ----------

  var finePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  if (finePointer && !reduceMotion) {
    var MAX_DEG = 6;
    var active = null;
    var rect = null;
    var raf = 0;
    var px = 0;
    var py = 0;

    function ensureSheen(el) {
      if (el.querySelector(":scope > .tilt-sheen")) return;
      var s = document.createElement("span");
      s.className = "tilt-sheen";
      s.setAttribute("aria-hidden", "true");
      el.appendChild(s);
    }

    function apply() {
      raf = 0;
      if (!active || !rect) return;
      var nx = (px - rect.left) / Math.max(1, rect.width) - 0.5;
      var ny = (py - rect.top) / Math.max(1, rect.height) - 0.5;
      var ry = nx * 2 * MAX_DEG;
      var rx = -ny * 2 * MAX_DEG;
      active.style.transform =
        "perspective(900px) rotateX(" + rx.toFixed(2) + "deg) rotateY(" + ry.toFixed(2) + "deg) translateY(-3px)";
      active.style.setProperty("--mx", ((nx + 0.5) * 100).toFixed(1) + "%");
      active.style.setProperty("--my", ((ny + 0.5) * 100).toFixed(1) + "%");
    }

    document.addEventListener("pointerenter", function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest("[data-tilt]") : null;
      if (!el) return;
      active = el;
      rect = el.getBoundingClientRect();
      ensureSheen(el);
    }, true);

    document.addEventListener("pointermove", function (ev) {
      if (!active) return;
      px = ev.clientX;
      py = ev.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    }, { passive: true });

    document.addEventListener("pointerleave", function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest("[data-tilt]") : null;
      if (!el || el !== active) return;
      active.style.transform = "";
      active = null;
      rect = null;
    }, true);
  }
})();
