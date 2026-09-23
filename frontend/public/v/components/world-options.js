/* Настройки мира Koban.
 *
 * Читает /v/api/options — снимок глобальных ключей мира с игрового сервера.
 * Смотреть может кто угодно, менять — только с паролем: его проверяет
 * koban-hub, он же подставляет токен для плагина. Пароль держим в
 * sessionStorage, чтобы он не жил дольше вкладки.
 *
 * Правка применяется у всех, кто сейчас в игре, без перезахода: сервер
 * рассылает ключи целиком (ZoneSystem.SendGlobalKeys).
 */
(function () {
  "use strict";

  var ENDPOINT = "/v/api/options";
  var PASS_KEY = "koban.valheim.pass";
  var POLL_MS = 30000;

  var root = document.getElementById("worldOptionsRoot");
  if (!root) return;

  var state = null;
  var editing = false;
  var busy = false;
  var pollTimer = null;

  function pass() {
    try {
      return window.sessionStorage.getItem(PASS_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function setPass(value) {
    try {
      if (value) window.sessionStorage.setItem(PASS_KEY, value);
      else window.sessionStorage.removeItem(PASS_KEY);
    } catch (e) {
      /* приватный режим — просто не запоминаем */
    }
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmt(value) {
    var n = Number(value);
    if (!isFinite(n)) return String(value);
    return (Math.round(n * 1000) / 1000).toString().replace(".", ",");
  }

  function load() {
    return fetch(ENDPOINT, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        state = data;
        render();
      })
      .catch(function () {
        if (!state) {
          root.textContent = "";
          root.appendChild(el("p", "wopts__empty", "Сервер сейчас недоступен"));
        }
      });
  }

  function send(lines) {
    if (busy) return Promise.resolve();
    busy = true;
    render();

    return fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Koban-Pass": pass()
      },
      body: lines.join("\n")
    })
      .then(function (r) {
        return r.json().then(function (body) {
          return { status: r.status, body: body };
        });
      })
      .then(function (res) {
        if (res.status === 403) {
          setPass("");
          editing = false;
          note("Пароль не подошёл", true);
          return;
        }
        if (!res.body || res.body.ok !== true) {
          note((res.body && res.body.error) || "Не применилось", true);
          return;
        }
        note("Применено — уже действует в игре", false);
      })
      .catch(function () {
        note("Сервер не ответил", true);
      })
      .then(function () {
        busy = false;
        // Небольшая пауза: плагин применяет очередь на игровом кадре.
        return new Promise(function (done) { setTimeout(done, 400); });
      })
      .then(load);
  }

  var noteTimer = null;
  function note(text, bad) {
    var box = root.querySelector(".wopts__note");
    if (!box) return;
    box.textContent = text;
    box.classList.toggle("is-bad", !!bad);
    box.hidden = false;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { box.hidden = true; }, 4000);
  }

  function askPassword() {
    var typed = window.prompt("Пароль для правки настроек мира:");
    if (typed == null) return;
    typed = typed.trim();
    if (!typed) return;
    setPass(typed);
    editing = true;
    render();
    note("Режим правки включён. Пароль проверится при первом изменении", false);
  }

  function onFlag(item) {
    send([(item.on ? "unset " : "set ") + item.key]);
  }

  function onScale(item, value) {
    // Единица — это значение по умолчанию, ключ тогда просто снимаем,
    // чтобы не засорять список ключей мира.
    send([value === 1 ? "unset " + item.key : "set " + item.key + " " + value]);
  }

  function onInt(item, value) {
    send([value === 0 ? "unset " + item.key : "set " + item.key + " " + value]);
  }

  function renderItem(item) {
    var row = el("div", "wopt");
    // Флажок узкий и помещается справа от подписи, а ряд фишек — нет: при
    // одиннадцати значениях «Уровня мира» подпись сжималась в столбик.
    // Поэтому всё, кроме флажков, кладём под подпись на всю ширину.
    if (item.kind !== "flag") row.classList.add("wopt--stacked");
    if (busy) row.classList.add("is-busy");

    var head = el("div", "wopt__head");
    head.appendChild(el("span", "wopt__label", item.label));
    if (item.hint) head.appendChild(el("span", "wopt__hint", item.hint));
    row.appendChild(head);

    var control = el("div", "wopt__control");

    if (item.kind === "flag") {
      var toggle = el("button", "wswitch", null);
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", item.on ? "true" : "false");
      toggle.setAttribute("aria-label", item.label);
      toggle.classList.toggle("is-on", !!item.on);
      toggle.appendChild(el("span", "wswitch__knob"));
      if (!editing || busy) toggle.disabled = true;
      else toggle.addEventListener("click", function () { onFlag(item); });
      control.appendChild(toggle);
    } else if (item.kind === "int") {
      var group = el("div", "wchips");
      for (var v = item.min; v <= item.max; v++) {
        (function (value) {
          var chip = el("button", "wchip", String(value));
          chip.type = "button";
          if (value === item.value) chip.classList.add("is-on");
          if (!editing || busy) chip.disabled = true;
          else chip.addEventListener("click", function () { onInt(item, value); });
          group.appendChild(chip);
        })(v);
      }
      control.appendChild(group);
    } else {
      var chips = el("div", "wchips");
      (item.choices || []).forEach(function (choice) {
        var chip = el("button", "wchip", "×" + fmt(choice));
        chip.type = "button";
        if (Math.abs(choice - item.value) < 0.0005) chip.classList.add("is-on");
        if (!editing || busy) chip.disabled = true;
        else chip.addEventListener("click", function () { onScale(item, choice); });
        chips.appendChild(chip);
      });
      // Значение могло прийти не из нашего набора (например, из пресета мира).
      var known = (item.choices || []).some(function (c) {
        return Math.abs(c - item.value) < 0.0005;
      });
      if (!known) {
        var odd = el("span", "wchip is-on is-static", "×" + fmt(item.value));
        chips.insertBefore(odd, chips.firstChild);
      }
      control.appendChild(chips);
    }

    row.appendChild(control);
    return row;
  }

  function render() {
    root.textContent = "";

    var bar = el("div", "wopts__bar");
    var status = el("p", "wopts__status", editing
      ? "Правка включена"
      : "Только просмотр");
    bar.appendChild(status);

    var btn = el("button", "wopts__btn", editing ? "Выйти из правки" : "Изменить");
    btn.type = "button";
    btn.addEventListener("click", function () {
      if (editing) {
        editing = false;
        setPass("");
        render();
      } else {
        askPassword();
      }
    });
    bar.appendChild(btn);
    root.appendChild(bar);

    var noteBox = el("p", "wopts__note");
    noteBox.hidden = true;
    root.appendChild(noteBox);

    if (!state || !state.ready) {
      root.appendChild(el("p", "wopts__empty", "Сервер ещё не отдал настройки"));
      return;
    }

    (state.groups || []).forEach(function (group) {
      var section = el("div", "wgroup");
      section.appendChild(el("h3", "wgroup__head", group.name));
      var body = el("div", "wgroup__body");
      (group.items || []).forEach(function (item) {
        body.appendChild(renderItem(item));
      });
      section.appendChild(body);
      root.appendChild(section);
    });

    var foot = el("p", "wopts__foot",
      "Меняется сразу у всех, кто в игре. Настройки сохраняются в мире и переживают перезапуск.");
    root.appendChild(foot);
  }

  render();
  load();

  pollTimer = setInterval(function () {
    // Во время правки не перерисовываем под руками.
    if (!busy && !editing) load();
  }, POLL_MS);

  window.addEventListener("beforeunload", function () {
    if (pollTimer) clearInterval(pollTimer);
  });
})();
