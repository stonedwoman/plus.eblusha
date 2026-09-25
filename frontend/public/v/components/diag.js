/* Диагностика тормозов: koban.uk/v/?fx=diag
 *
 * Показывает поверх страницы, что именно съедает главный поток. Нужно потому,
 * что замеры на сервере без видеокарты не переносятся на живую машину.
 *
 * В окошке:
 *   fps          — кадров в секунду за последнюю секунду;
 *   худший кадр  — самый долгий промежуток между кадрами за всё время;
 *   долгих задач — блокировки главного потока дольше 50 мс (PerformanceObserver
 *                  longtask), с именем источника;
 *   события      — сколько wheel / mousemove / scroll пришло за секунду и
 *                  сколько времени заняли их обработчики;
 *   память       — если браузер её отдаёт (Chrome).
 *
 * Оверлей ничего не меняет в странице и сам почти ничего не стоит: обновляется
 * раз в секунду.
 */
(function () {
  "use strict";

  if (!document.documentElement.classList.contains("fx-diag")) return;

  var box = document.createElement("div");
  box.id = "kobanDiag";
  box.style.cssText = [
    "position:fixed", "right:8px", "top:8px", "z-index:99999",
    "background:rgba(0,0,0,.82)", "color:#dfe7df", "font:12px/1.45 ui-monospace,monospace",
    "padding:10px 12px", "border-radius:8px", "border:1px solid rgba(200,164,90,.4)",
    "pointer-events:none", "white-space:pre", "min-width:270px"
  ].join(";");
  document.body.appendChild(box);

  var worstFrame = 0;
  var frames = 0;
  var lastFrame = performance.now();
  var lastReport = lastFrame;

  var longTasks = [];          // {ms, src}
  var counts = { wheel: 0, mousemove: 0, scroll: 0 };
  var spent = { wheel: 0, mousemove: 0, scroll: 0 };

  // Сколько времени тратят обработчики: замеряем промежуток от события до
  // конца текущей задачи через микрозадачу.
  function watch(name) {
    window.addEventListener(name, function () {
      counts[name]++;
      var t = performance.now();
      Promise.resolve().then(function () {
        spent[name] += performance.now() - t;
      });
    }, { passive: true, capture: true });
  }
  watch("wheel");
  watch("mousemove");
  watch("scroll");

  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        var src = "";
        try {
          var a = e.attribution && e.attribution[0];
          if (a) src = (a.containerType || "") + " " + (a.containerName || a.containerSrc || "");
        } catch (err) {}
        longTasks.push({ ms: Math.round(e.duration), src: src.trim() });
        if (longTasks.length > 200) longTasks.shift();
      });
    }).observe({ entryTypes: ["longtask"] });
  } catch (err) {
    longTasks.push({ ms: 0, src: "longtask не поддержан" });
  }

  function frame(now) {
    var dt = now - lastFrame;
    lastFrame = now;
    if (dt > worstFrame) worstFrame = dt;
    frames++;

    if (now - lastReport >= 1000) {
      var top = longTasks.slice().sort(function (a, b) { return b.ms - a.ms; }).slice(0, 3);
      var lines = [
        "fps " + frames + "   худший кадр " + Math.round(worstFrame) + " мс",
        "долгих задач: " + longTasks.length +
          (top.length ? "  макс " + top[0].ms + " мс" : ""),
      ];
      top.forEach(function (t) {
        lines.push("   " + t.ms + " мс " + (t.src || "(источник не указан)"));
      });
      lines.push("за секунду:");
      ["wheel", "mousemove", "scroll"].forEach(function (k) {
        lines.push("   " + k + " " + counts[k] + " шт, " + Math.round(spent[k]) + " мс");
        counts[k] = 0;
        spent[k] = 0;
      });
      if (performance.memory) {
        lines.push("память " + Math.round(performance.memory.usedJSHeapSize / 1048576) + " МБ");
      }
      lines.push("сброс: клик по странице");
      box.textContent = lines.join("\n");
      frames = 0;
      lastReport = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  document.addEventListener("click", function () {
    worstFrame = 0;
    longTasks.length = 0;
  });
})();
