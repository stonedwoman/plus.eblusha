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

  function build() {
    root.textContent = "";

    var head = el("div", "wclock__head");
    var day = el("p", "wclock__day", "—");
    var phase = el("span", "wclock__phase", "");
    head.appendChild(day);
    head.appendChild(phase);
    root.appendChild(head);

    // Сегменты подписаны прямо внутри: цветовой код без легенды никто не читает.
    var dial = el("div", "wclock__dial");
    [
      { cls: "is-yes", left: 0,  width: 25, text: "можно" },
      { cls: "is-no",  left: 25, width: 25, text: "нельзя" },
      { cls: "is-yes", left: 50, width: 50, text: "можно" }
    ].forEach(function (seg) {
      var n = el("span", "wclock__seg " + seg.cls, seg.text);
      n.style.left = seg.left + "%";
      n.style.width = seg.width + "%";
      dial.appendChild(n);
    });
    var hand = el("span", "wclock__hand");
    dial.appendChild(hand);
    root.appendChild(dial);

    // Отметки стоят ровно на 0.25 / 0.5 / 0.75, поэтому позиционируем их явно,
    // а не раскладкой: space-between ставил «полдень» на 48.2% вместо 50.
    var marks = el("div", "wclock__marks");
    [[25, "рассвет"], [50, "полдень"], [75, "закат"]].forEach(function (m) {
      var n = el("span", null, m[1]);
      n.style.left = m[0] + "%";
      marks.appendChild(n);
    });
    root.appendChild(marks);

    var status = el("p", "wclock__status", "Загрузка…");
    root.appendChild(status);

    var note = el("p", "wclock__note", "");
    root.appendChild(note);

    ui = { day: day, phase: phase, hand: hand, status: status, note: note };
  }

  function fmt(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var m = Math.floor(s / 60);
    var r = s % 60;
    if (m <= 0) return r + " с";
    return m + " мин " + (r < 10 ? "0" : "") + r + " с";
  }

  // Сколько долей суток вперёд по кругу от f до target.
  function ahead(f, target) {
    var d = target - f;
    if (d <= 0) d += 1;
    return d;
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
    ui.phase.textContent = phaseName(f);

    ui.hand.style.left = (f * 100) + "%";

    root.classList.toggle("is-sleep", canSleep);

    if (canSleep) {
      ui.status.textContent = "Спать можно";
      ui.note.textContent = "Окно закроется на рассвете, через " +
        fmt(ahead(f, anchor.closes) * anchor.dayLengthSec) + ".";
    } else {
      ui.status.textContent = "До сна " + fmt(ahead(f, anchor.opens) * anchor.dayLengthSec);
      ui.note.textContent = "Кровать работает с полудня и до рассвета.";
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
