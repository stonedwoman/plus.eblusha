/* Игровые часы мира Koban.
 *
 * Данные берёт из /v/api/time — это значения самой игры (EnvMan.GetDay,
 * GetDayFraction, EnvMan.CanSleep), а не наш параллельный отсчёт.
 *
 * Между опросами стрелка идёт локально: игровая секунда равна реальной, так что
 * достаточно прибавлять прошедшее время к последнему снимку. Замер показал, что
 * время идёт и на пустом сервере, поэтому отсчёт не замораживаем. Исключение —
 * сон игроков: игра ускоренно мотает время до утра, и стрелка на сайте в этот
 * момент отстаёт, но следующий опрос (раз в 15 с) её подтягивает.
 */
(function () {
  "use strict";

  var ENDPOINT = "/v/api/time";
  var POLL_MS = 15000;
  var TICK_MS = 1000;

  var root = document.getElementById("worldClockRoot");
  if (!root) return;

  var anchor = null; // { day, fraction, dayLengthSec, opens, closes, atMs }
  var ui = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  // Точка на окружности: доля суток 0 — наверху (полночь), дальше по часовой.
  function onCircle(f, r) {
    var a = f * Math.PI * 2;
    return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
  }


  // Классический циферблат на 12 часов: часовая стрелка делает два оборота за
  // игровые сутки, минутная — оборот за игровой час.
  //
  // Дуг окна сна здесь нет намеренно: на 12-часовом циферблате полдень и
  // полночь попадают в одну точку, поэтому промежуток «с 12:00 до 06:00»
  // нарисовать однозначно нельзя. Окно показывает полоса под часами, а
  // циферблат говорит, день сейчас или ночь.
  function buildFace() {
    var wrap = el("div", "wclock__face");
    var svg = svgEl("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" });

    var plate = svgEl("circle", { cx: 50, cy: 50, r: 46, class: "wclock__plate" });
    svg.appendChild(plate);

    for (var i = 0; i < 12; i++) {
      var major = i % 3 === 0;
      var a = i / 12;
      var outer = onCircle(a, 40);
      var inner = onCircle(a, major ? 34 : 37);
      svg.appendChild(svgEl("line", {
        x1: outer[0].toFixed(2), y1: outer[1].toFixed(2),
        x2: inner[0].toFixed(2), y2: inner[1].toFixed(2),
        class: "wclock__tick" + (major ? " is-major" : "")
      }));
    }

    [[0, "12"], [0.25, "3"], [0.5, "6"], [0.75, "9"]].forEach(function (m) {
      var p = onCircle(m[0], 27);
      var t = svgEl("text", {
        x: p[0].toFixed(2), y: p[1].toFixed(2),
        "text-anchor": "middle", "dominant-baseline": "central",
        class: "wclock__num"
      });
      t.textContent = m[1];
      svg.appendChild(t);
    });

    var hour = svgEl("line", { x1: 50, y1: 50, x2: 50, y2: 30, class: "wclock__hhand" });
    var minute = svgEl("line", { x1: 50, y1: 50, x2: 50, y2: 19, class: "wclock__mhand" });
    svg.appendChild(hour);
    svg.appendChild(minute);
    svg.appendChild(svgEl("circle", { cx: 50, cy: 50, r: 2.6, class: "wclock__pin" }));

    // Окошко «день / ночь» — как на часах. Рисуем последним, поверх стрелок:
    // иначе минутная перечёркивает надпись и её не прочесть.
    var win = svgEl("g", { class: "wclock__window" });
    win.appendChild(svgEl("rect", { x: 34, y: 58.5, width: 32, height: 11, rx: 3, class: "wclock__winbg" }));
    var mark = svgEl("text", {
      x: 50, y: 64.3, "text-anchor": "middle", "dominant-baseline": "central",
      class: "wclock__daynight"
    });
    mark.textContent = "—";
    win.appendChild(mark);
    svg.appendChild(win);

    wrap.appendChild(svg);
    return { wrap: wrap, hour: hour, minute: minute, plate: plate, mark: mark, window: win };
  }

  function build() {
    root.textContent = "";

    var face = buildFace();
    root.appendChild(face.wrap);

    var body = el("div", "wclock__body");

    var head = el("div", "wclock__head");
    var day = el("p", "wclock__day", "—");
    var time = el("span", "wclock__time", "--:--");
    var phase = el("span", "wclock__phase", "");
    head.appendChild(day);
    head.appendChild(time);
    head.appendChild(phase);
    body.appendChild(head);

    // Сегменты подписаны прямо внутри: цветовой код без легенды никто не читает.
    var dial = el("div", "wclock__dial");
    [
      { cls: "is-yes", left: 0,  width: 25, text: "можно" },
      { cls: "is-no",  left: 25, width: 25, text: "нельзя" },
      { cls: "is-yes", left: 50, width: 50, text: "можно" }
    ].forEach(function (seg) {
      var n = el("span", "wclock__seg " + seg.cls);
      // «спать» отдельным словом: на узком экране оно не влезает в сегмент
      // шириной в четверть полосы и прячется стилями.
      n.appendChild(el("span", "wclock__segword", "спать"));
      n.appendChild(document.createTextNode(seg.text));
      n.style.left = seg.left + "%";
      n.style.width = seg.width + "%";
      dial.appendChild(n);
    });
    var hand = el("span", "wclock__hand");
    dial.appendChild(hand);
    body.appendChild(dial);

    // Отметки стоят ровно на 0.25 / 0.5 / 0.75, поэтому позиционируем их явно,
    // а не раскладкой: space-between ставил «полдень» на 48.2% вместо 50.
    var marks = el("div", "wclock__marks");
    [[25, "рассвет"], [50, "полдень"], [75, "закат"]].forEach(function (m) {
      var n = el("span", null, null);
      n.style.left = m[0] + "%";
      n.appendChild(el("b", null, clock(m[0] / 100)));
      n.appendChild(el("i", null, m[1]));
      marks.appendChild(n);
    });
    body.appendChild(marks);

    var status = el("p", "wclock__status", "Загрузка…");
    body.appendChild(status);

    var note = el("p", "wclock__note", "");
    body.appendChild(note);
    root.appendChild(body);

    ui = { day: day, time: time, phase: phase, hand: hand, status: status, note: note,
           hHand: face.hour, mHand: face.minute,
           plate: face.plate, dayNight: face.mark, window: face.window };
  }

  function fmt(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var m = Math.floor(s / 60);
    var r = s % 60;
    if (m <= 0) return r + " с";
    return m + " мин " + (r < 10 ? "0" : "") + r + " с";
  }

  // Игровая секунда равна реальной, поэтому обратный отсчёт — это ровно столько
  // же реального ожидания. Подписываем явно, иначе «6 мин» читается как игровые.
  function fmtReal(seconds) {
    return fmt(seconds) + " реального времени";
  }

  // Сколько долей суток вперёд по кругу от f до target.
  function ahead(f, target) {
    var d = target - f;
    if (d <= 0) d += 1;
    return d;
  }

  // Доля суток линейно переводится в часы: 0 — полночь, 0.25 — рассвет,
  // 0.5 — полдень, 0.75 — закат. Своих часов игра не показывает, это наша
  // подача её же числа, но перевод однозначный.
  function clock(f) {
    var total = Math.round(((f % 1) + 1) % 1 * 24 * 60);
    var h = Math.floor(total / 60) % 24;
    var m = total % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function phaseName(f) {
    if (f <= 0.25 || f >= 0.75) return "ночь";
    if (f >= 0.5) return "день";
    return "утро";
  }

  function render() {
    if (!ui) return;

    if (!anchor) {
      ui.status.textContent = "Сервер не отдаёт время";
      ui.note.textContent = "";
      return;
    }

    var f = anchor.fraction;
    var day = anchor.day;

    // Время идёт всегда, в том числе на пустом сервере — проверено замером.
    // Сон игроков игра ускоренно мотает время вперёд, но опрос раз в 15 с
    // подтягивает стрелку обратно к серверной.
    var elapsed = (Date.now() - anchor.atMs) / 1000;
    var advanced = f + elapsed / anchor.dayLengthSec;
    day += Math.floor(advanced);
    f = advanced - Math.floor(advanced);

    var canSleep = f >= anchor.opens || f <= anchor.closes;

    ui.day.textContent = "День " + day;
    ui.time.textContent = clock(f);
    ui.phase.textContent = phaseName(f);

    ui.hand.style.left = (f * 100) + "%";
    // Часовая — два оборота за игровые сутки, минутная — оборот за игровой час.
    ui.hHand.setAttribute("transform", "rotate(" + (f * 720 % 360).toFixed(2) + " 50 50)");
    ui.mHand.setAttribute("transform", "rotate(" + ((f * 24 % 1) * 360).toFixed(2) + " 50 50)");

    // День и ночь по границам самой игры: ночь это f <= 0.25 или f >= 0.75.
    var night = f <= 0.25 || f >= 0.75;
    ui.dayNight.textContent = night ? "НОЧЬ" : "ДЕНЬ";
    ui.plate.classList.toggle("is-night", night);
    ui.dayNight.classList.toggle("is-night", night);
    ui.window.classList.toggle("is-night", night);

    root.classList.toggle("is-sleep", canSleep);

    if (canSleep) {
      ui.status.textContent = "Спать можно";
      ui.note.textContent = "Окно закроется в " + clock(anchor.closes) + " — через " +
        fmtReal(ahead(f, anchor.closes) * anchor.dayLengthSec) + ".";
    } else {
      ui.status.textContent = "До сна " + fmtReal(ahead(f, anchor.opens) * anchor.dayLengthSec);
      ui.note.textContent = "Кровать заработает в " + clock(anchor.opens) +
        " и будет работать до " + clock(anchor.closes) + ".";
    }
  }

  function load() {
    return fetch(ENDPOINT, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d || d.ok !== true) throw new Error("нет данных");
        anchor = {
          day: d.day,
          fraction: d.fraction,
          dayLengthSec: d.dayLengthSec,
          opens: typeof d.sleepOpens === "number" ? d.sleepOpens : 0.5,
          closes: typeof d.sleepCloses === "number" ? d.sleepCloses : 0.25,
          atMs: Date.now()
        };
        render();
      })
      .catch(function () {
        if (!anchor) render();
      });
  }

  build();
  render();
  load();
  setInterval(load, POLL_MS);
  setInterval(render, TICK_MS);
})();
