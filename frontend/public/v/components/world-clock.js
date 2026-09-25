/* Игровые часы мира Koban.
 *
 * Сервер — источник истины, но дёргать его ради каждого кадра незачем. Поэтому
 * здесь свои часы, которые идут сами, а ответы сервера служат опорными точками:
 * раз в POLL_MS считается невязка и выбирается постепенно, а не подставляется
 * скачком. Отсюда непрерывный ровный ход стрелок.
 *
 * Дисциплина часов (по образцу NTP):
 *   est   — наша оценка сетевого времени сервера, в секундах;
 *   err   — невязка, которую ещё предстоит выбрать;
 *   slew  — выбираем её не быстрее MAX_SLEW от хода реального времени, то есть
 *           часы чуть спешат или чуть отстают, но никогда не прыгают;
 *   step  — исключение: расхождение больше STEP_THRESHOLD ставится мгновенно.
 *           Так бывает, когда игроки легли спать и игра промотала время вперёд.
 *
 * Запрос учитывает задержку сети: ответ описывает момент примерно rtt/2 назад,
 * на столько и поправляем.
 *
 * Берём у сервера netTime (ZNet.GetTimeSeconds) — точное сетевое время.
 * GetDayFraction() для этого не годится: это m_smoothDayFraction, сглаженное
 * значение, которое игра лерпит к истинному по 1% за кадр, оно отстаёт и дрожит.
 *
 * Отрисовка — в requestAnimationFrame, а не по таймеру. Минутная стрелка делает
 * оборот за игровой час, это 75 секунд реального времени, её ход виден глазом.
 *
 * Отдельный случай — остановка. Пустой сервер время не крутит: netTime стоит на
 * месте. Если при этом гнать свои часы вперёд, каждый опрос будет откидывать
 * стрелку назад на POLL_MS — именно это и выглядело как циклический рывок.
 * Поэтому остановку определяем по факту: сравниваем netTime соседних опросов и,
 * если он не сдвинулся, замираем вместе с сервером. Подсказку running (игроки
 * на сервере) используем только чтобы понять это сразу, а не со второго опроса.
 */
(function () {
  "use strict";

  var ENDPOINT = "/v/api/time";
  var POLL_MS = 15000;
  var MAX_SLEW = 0.25;      // не быстрее четверти хода реального времени
  var STEP_THRESHOLD = 5;   // секунд: больше — ставим мгновенно

  var root = document.getElementById("worldClockRoot");
  if (!root) return;

  var est = null;           // оценка netTime, с
  var err = 0;              // невязка, с
  var dayLengthSec = 1800;
  // Куда игра будит после сна: EnvMan.SkipToMorning целится в 0.15 суток
  // следующего дня, то есть 03:36 по нашей шкале.
  var WAKE_AT = 0.15;

  // Практическое окно сна: с полудня до 03:36.
  //
  // В коде пороги другие — CanSleep = IsAfternoon || IsNight, то есть формально
  // до рассвета на 0.25. Но кровать сверяется с EnvMan.CanSleep(), а тот считает
  // фазу по m_smoothDayFraction — сглаженному значению. После сна оно ползёт от
  // вечернего к 0.15 «коротким путём», то есть сверху вниз, и надолго застревает
  // в дневном диапазоне 0.25..0.5. Поэтому сразу после подъёма игра в кровать
  // уже не пускает, что подтверждается и на практике, и полем canSleep с сервера.
  // Показываем то, что работает, а не то, что написано в порогах.
  var opens = 0.5;
  var closes = WAKE_AT;
  var haveData = false;
  var lastServerTime = null;
  var frozen = false;
  var lastFrame = 0;
  var last = {};            // что уже отрисовано, чтобы не трогать DOM зря
  var ui = null;

  var SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  // Точка на окружности: доля 0 — наверху, дальше по часовой.
  function onCircle(f, r) {
    var a = f * Math.PI * 2;
    return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
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

  // Сон всегда переносит на 0.15 суток СЛЕДУЮЩЕГО дня, считая от момента
  // за 0.15 суток до текущего. Поэтому лечь сразу после подъёма — значит
  // потерять почти целые сутки, и это стоит показать заранее.
  function skipIfSleepNow(netTime) {
    var from = netTime - WAKE_AT * dayLengthSec;
    var d = Math.floor(from / dayLengthSec);
    var wakeAt = (d + 1 + WAKE_AT) * dayLengthSec;
    return wakeAt - netTime;
  }

  function phaseName(f) {
    if (f <= 0.25 || f >= 0.75) return "ночь";
    if (f >= 0.5) return "день";
    return "утро";
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
      { cls: "is-yes", left: 0, width: 15, text: "можно", word: true },
      { cls: "is-no", left: 15, width: 35, text: "нельзя", word: true },
      { cls: "is-yes", left: 50, width: 50, text: "можно", word: true }
    ].forEach(function (seg) {
      var n = el("span", "wclock__seg " + seg.cls);
      // «спать» отдельным словом: на узком экране оно не влезает в сегмент
      // и прячется стилями.
      if (seg.word) n.appendChild(el("span", "wclock__segword", "спать"));
      n.appendChild(document.createTextNode(seg.text));
      n.style.left = seg.left + "%";
      n.style.width = seg.width + "%";
      dial.appendChild(n);
    });
    var wake = el("span", "wclock__wake");
    wake.style.left = (WAKE_AT * 100) + "%";
    wake.title = "После сна игра будит в " + clock(WAKE_AT);
    dial.appendChild(wake);

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

    ui = {
      day: day, time: time, phase: phase, hand: hand, status: status, note: note,
      hHand: face.hour, mHand: face.minute, plate: face.plate,
      dayNight: face.mark, window: face.window
    };
  }

  // DOM трогаем только когда значение реально изменилось: иначе на каждом кадре
  // шла бы перерисовка текста.
  function setText(node, key, value) {
    if (last[key] === value) return;
    last[key] = value;
    node.textContent = value;
  }

  function draw() {
    if (!ui) return;

    if (!haveData) {
      setText(ui.status, "status", "Сервер не отдаёт время");
      setText(ui.note, "note", "");
      return;
    }

    var total = est / dayLengthSec;
    var day = Math.floor(total);
    var f = total - day;

    // Стрелки считаются каждый кадр, поэтому переходов в CSS у них нет:
    // они боролись бы с покадровым пересчётом и давали рывки.
    ui.hHand.setAttribute("transform", "rotate(" + (f * 720 % 360).toFixed(3) + " 50 50)");
    ui.mHand.setAttribute("transform", "rotate(" + ((f * 24 % 1) * 360).toFixed(3) + " 50 50)");
    ui.hand.style.left = (f * 100).toFixed(3) + "%";

    var night = f <= 0.25 || f >= 0.75;
    setText(ui.dayNight, "dn", night ? "НОЧЬ" : "ДЕНЬ");
    if (last.night !== night) {
      last.night = night;
      ui.plate.classList.toggle("is-night", night);
      ui.dayNight.classList.toggle("is-night", night);
      ui.window.classList.toggle("is-night", night);
    }

    setText(ui.day, "day", "День " + day);
    setText(ui.time, "time", clock(f));
    setText(ui.phase, "phase", phaseName(f));

    var canSleep = f >= opens || f <= closes;
    if (last.canSleep !== canSleep) {
      last.canSleep = canSleep;
      root.classList.toggle("is-sleep", canSleep);
    }

    if (frozen) {
      setText(ui.status, "status", "Время стоит");
      setText(ui.note, "note", canSleep
        ? "На сервере никого — игра не крутит часы. Сейчас спать можно."
        : "На сервере никого — игра не крутит часы. Отсчёт пойдёт, когда кто-то зайдёт.");
    } else if (canSleep) {
      var skip = skipIfSleepNow(est);
      var skipHours = skip / dayLengthSec * 24;
      var skipText = skipHours >= 1
        ? Math.round(skipHours) + " ч"
        : Math.round(skipHours * 60) + " мин";
      setText(ui.status, "status", "Спать можно");
      setText(ui.note, "note",
        "Ляжете — проснётесь в " + clock(WAKE_AT) + ", игра промотает " + skipText +
        " игрового времени. Лечь можно до " + clock(closes) + ", это ещё " +
        fmtReal(ahead(f, closes) * dayLengthSec) + ".");
    } else {
      setText(ui.status, "status", "До сна " + fmtReal(ahead(f, opens) * dayLengthSec));
      setText(ui.note, "note", "Кровать работает с " + clock(opens) + " до " +
        clock(closes) + ". После подъёма игра спать уже не пускает.");
    }
  }

  function frame(nowMs) {
    if (!lastFrame) lastFrame = nowMs;
    var dt = (nowMs - lastFrame) / 1000;
    lastFrame = nowMs;

    // Вкладка могла уйти в фон: кадров там нет, и dt приходит огромным.
    // Ограничиваем — всё равно поправимся ближайшим опросом.
    if (!(dt > 0)) dt = 0;
    if (dt > 5) dt = 5;

    if (haveData && !frozen) {
      est += dt;
      if (err !== 0) {
        var limit = MAX_SLEW * dt;
        var size = Math.min(Math.abs(err), limit);
        var move = err > 0 ? size : -size;
        est += move;
        err -= move;
      }
    }
    if (haveData) draw();

    requestAnimationFrame(frame);
  }

  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  function load() {
    var t0 = now();
    return fetch(ENDPOINT, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d || d.ok !== true) throw new Error("нет данных");

        var rtt = Math.max(0, (now() - t0) / 1000);

        if (typeof d.dayLengthSec === "number" && d.dayLengthSec > 0) dayLengthSec = d.dayLengthSec;
        if (typeof d.sleepOpens === "number") opens = d.sleepOpens;
        // sleepCloses с сервера (0.25) — формальный порог из кода; на деле
        // кровать перестаёт работать в момент подъёма. См. комментарий выше.

        // Плагин отдаёт точное сетевое время. Если попали на старую версию —
        // собираем его из дня и доли: точность хуже, но часы работают.
        var serverTime = (typeof d.netTime === "number")
          ? d.netTime
          : (d.day + d.fraction) * dayLengthSec;

        // Остановка определяется по факту: netTime не сдвинулся между опросами.
        // На первом ответе факта ещё нет, поэтому верим подсказке про игроков.
        if (lastServerTime !== null) {
          frozen = Math.abs(serverTime - lastServerTime) < 0.001;
        } else if (d.running === false) {
          frozen = true;
        }
        lastServerTime = serverTime;

        if (frozen) {
          // Стоим ровно там же, где сервер: поправка на задержку тут не нужна.
          est = serverTime;
          err = 0;
        } else {
          // Ответ описывает момент примерно rtt/2 назад.
          var target = serverTime + rtt / 2;
          if (!haveData || Math.abs(target - est) > STEP_THRESHOLD) {
            // Первый запуск или скачок: игроки легли спать и время промотали.
            est = target;
            err = 0;
          } else {
            err = target - est;
          }
        }
        haveData = true;
        draw();
      })
      .catch(function () {
        // Связь пропала — свои часы идут дальше, это лучше пустого экрана.
        if (!haveData) draw();
      });
  }

  build();
  draw();
  // Второй опрос вскоре после первого: так факт остановки виден сразу,
  // а не через POLL_MS ошибочного хода стрелок.
  load().then(function () { setTimeout(load, 2500); });
  setInterval(load, POLL_MS);
  requestAnimationFrame(frame);

  // В фоне кадров нет и часы отстают — вернулись во вкладку, сразу сверяемся.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      lastFrame = 0;
      load();
    }
  });
})();
