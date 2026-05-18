(function initForestParallax() {
  try {
    var root = document.documentElement;
    var container = document.getElementById("forestParallax");
    if (!container) return;
    if (
      root.dataset.embedded === "true" ||
      /(?:^|[?&])preview=1(?:&|$)/.test(window.location.search)
    ) {
      return;
    }

    var reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var coarsePointer =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    var layers = Array.prototype.slice.call(
      container.querySelectorAll(".forest-parallax__layer")
    );
    if (!layers.length) return;

    var targetX = 0;
    var targetY = 0;
    var currentX = 0;
    var currentY = 0;
    var maxX = 34;
    var maxY = 14;
    var raf = 0;

    function parseNum(v) {
      var n = parseFloat(v);
      return isFinite(n) ? n : 0;
    }

    function updateBounds() {
      maxX = Math.max(18, Math.min(52, window.innerWidth * 0.035));
      maxY = Math.max(8, Math.min(18, window.innerHeight * 0.02));
    }

    function renderLayers() {
      layers.forEach(function (layer) {
        var dx = parseNum(layer.getAttribute("data-depth-x"));
        var dy = parseNum(layer.getAttribute("data-depth-y"));
        var baseY = parseNum(layer.getAttribute("data-base-y"));
        var tx = currentX * dx;
        var ty = baseY + currentY * dy;
        layer.style.transform =
          "translate3d(" + tx.toFixed(2) + "px, " + ty.toFixed(2) + "px, 0)";
      });
    }

    function tick() {
      raf = 0;
      currentX += (targetX - currentX) * 0.08;
      currentY += (targetY - currentY) * 0.08;
      renderLayers();
      if (
        Math.abs(targetX - currentX) > 0.05 ||
        Math.abs(targetY - currentY) > 0.05
      ) {
        raf = requestAnimationFrame(tick);
      }
    }

    function requestTick() {
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function resetParallax() {
      targetX = 0;
      targetY = 0;
      requestTick();
    }

    function onPointerMove(ev) {
      var nx = ev.clientX / Math.max(1, window.innerWidth) - 0.5;
      targetX = nx * 2 * maxX;
      targetY = 0;
      requestTick();
    }

    updateBounds();

    if (reduceMotion || coarsePointer) {
      renderLayers();
      return;
    }

    renderLayers();
    window.addEventListener("resize", function () {
      updateBounds();
      requestTick();
    });
    window.addEventListener("mousemove", onPointerMove, { passive: true });
    window.addEventListener("mouseleave", resetParallax);
    window.addEventListener("blur", resetParallax);
  } catch (err) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[forest-parallax]", err);
    }
  }
})();
