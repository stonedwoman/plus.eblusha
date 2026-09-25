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

  // Чем рисует браузер. Если тут SwiftShader, llvmpipe или Software — значит
  // аппаратное ускорение выключено и всё считает процессор; тогда никакая
  // правка вёрстки не поможет, чинить надо в настройках браузера.
  var gpu = "не определился";
  try {
    var c = document.createElement("canvas");
    var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (gl) {
      var ext = gl.getExtension("WEBGL_debug_renderer_info");
      gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "скрыт браузером";
    } else {
      gpu = "WebGL недоступен";
    }
  } catch (e) {
    gpu = "ошибка: " + e.message;
  }
  var soft = /swiftshader|llvmpipe|software|microsoft basic/i.test(gpu);

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

  // long-animation-frame (Chrome 123+) — единственный API, который делит
  // затянувшийся кадр на части: сколько ушло в скрипты, сколько в стиль и
  // раскладку, сколько в саму отрисовку. Именно этого не хватало: longtask
  // видит только главный поток и молчит, когда время уходит в рендер.
  var loaf = [];
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        var scriptMs = e.renderStart ? Math.max(0, e.renderStart - e.startTime) : 0;
        var renderMs = e.renderStart ? Math.max(0, e.startTime + e.duration - e.renderStart) : 0;
        var slMs = e.styleAndLayoutStart
          ? Math.max(0, e.startTime + e.duration - e.styleAndLayoutStart)
          : 0;
        var worst = "";
        try {
          var sc = (e.scripts || []).slice().sort(function (a, b) { return b.duration - a.duration; })[0];
          if (sc) {
            worst = Math.round(sc.duration) + "мс " +
              (sc.sourceFunctionName || sc.invoker || sc.name || "?") + " " +
              String(sc.sourceURL || "").split("/").pop();
          }
        } catch (err) {}
        loaf.push({
          ms: Math.round(e.duration),
          js: Math.round(scriptMs),
          render: Math.round(renderMs),
          sl: Math.round(slMs),
          worst: worst
        });
        if (loaf.length > 100) loaf.shift();
      });
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch (err) {
    loaf.push({ ms: 0, js: 0, render: 0, sl: 0, worst: "LoAF не поддержан" });
  }

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
      var sky = document.querySelector("canvas.bg-canvas");
      var lines = [
        "fps " + frames + "   худший кадр " + Math.round(worstFrame) + " мс",
        (soft ? "!! " : "") + "рисует: " + gpu.slice(0, 46),
        "экран " + innerWidth + "x" + innerHeight + " dpr " + (devicePixelRatio || 1) +
          (sky ? "   холст неба " + sky.width + "x" + sky.height : "   холста нет"),
        "долгих задач: " + longTasks.length +
          (top.length ? "  макс " + top[0].ms + " мс" : ""),
      ];
      top.forEach(function (t) {
        lines.push("   " + t.ms + " мс " + (t.src || "(источник не указан)"));
      });
      var lw = loaf.slice().sort(function (a, b) { return b.ms - a.ms; })[0];
      if (lw) {
        lines.push("затянувшийся кадр " + lw.ms + " мс:");
        lines.push("   скрипты " + lw.js + "   стиль+раскладка " + lw.sl +
                   "   отрисовка " + lw.render);
        if (lw.worst) lines.push("   " + lw.worst);
      } else {
        lines.push("затянувшихся кадров нет");
      }
      lines.push("узлов в DOM " + document.getElementsByTagName("*").length +
                 "   высота " + document.documentElement.scrollHeight);
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
