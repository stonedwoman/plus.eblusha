/* Koban · Valheim — общее поведение трёх страниц.
 *
 * Переходы между страницами делает сам браузер (View Transitions, см.
 * «переходы между страницами» в theme.css), а направление ставит инлайновый
 * скрипт в <head> каждой страницы. Здесь остался только наклон плиток за
 * курсором ([data-tilt]) — для мыши.
 */
(function () {
  "use strict";

  var reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
