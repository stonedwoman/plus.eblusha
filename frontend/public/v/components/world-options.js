/* Настройки мира Koban.
 *
 * Читает /v/api/options — снимок глобальных ключей мира с игрового сервера.
 * Смотреть может кто угодно, менять — только с паролем: его проверяет
 * koban-hub, он же подставляет токен для плагина. Пароль держим в
 * sessionStorage, чтобы он не жил дольше вкладки.
 *
 * Правка применяется у всех, кто сейчас в игре, без перезахода: сервер
 * рассылает ключи целиком (ZoneSystem.SendGlobalKeys).
 *
 * Разметка: группы настроек — отдельные стеклянные панели в сетке
 * #worldOptionsRoot. В общей шапке — статус связи (#optsLink) и кнопка правки
 * (#optsEdit); режим описан во вводной панели (#optsStatus); уведомления —
 * общая пилюля под шапкой (#optsNote); пароль спрашивает <dialog id="passDialog">.
 */
(function () {
  "use strict";

  var ENDPOINT = "/v/api/options";
  var PASS_KEY = "koban.valheim.pass";
  var POLL_MS = 30000;

  var root = document.getElementById("worldOptionsRoot");
  if (!root) return;

  var statusEl = document.getElementById("optsStatus");
  var linkEl = document.getElementById("optsLink");
  var editBtn = document.getElementById("optsEdit");
  var editLabel = document.getElementById("optsEditLabel");
  var noteEl = document.getElementById("optsNote");
  var dialog = document.getElementById("passDialog");
  var passInput = document.getElementById("passInput");

  var state = null;
  var editing = false;
  var busy = false;
  var pollTimer = null;
  // Ключ, который только что изменили: его строка вспыхнет после перерисовки.
  var flashKey = null;

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
        setLink(true);
        render();
      })
      .catch(function () {
        setLink(false);
        if (!state) {
          root.textContent = "";
          root.appendChild(emptyPanel("Сервер сейчас недоступен"));
        }
      });
  }

  function send(lines, key) {
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
        flashKey = key || null;
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

  // Статус связи в шапке — как на главной и на карте.
  function setLink(online) {
    if (!linkEl) return;
    linkEl.className = "kicker topbar__kicker " + (online ? "kicker--online" : "kicker--offline");
    var text = linkEl.querySelector(".topbar__kicker-text");
    if (text) text.textContent = online ? "Онлайн" : "Нет связи";
  }

  var noteTimer = null;
  function note(text, bad) {
    if (!noteEl) return;
    noteEl.textContent = text;
    noteEl.classList.toggle("is-bad", !!bad);
    noteEl.classList.toggle("is-good", !bad);
    noteEl.classList.add("is-on");
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { noteEl.classList.remove("is-on"); }, 4000);
  }

  function startEditing(typed) {
    typed = (typed || "").trim();
    if (!typed) return;
    setPass(typed);
    editing = true;
    render();
    note("Режим правки включён. Пароль проверится при первом изменении", false);
  }

  function askPassword() {
    if (dialog && typeof dialog.showModal === "function") {
      if (passInput) passInput.value = "";
      dialog.showModal();
      if (passInput) passInput.focus();
      return;
    }
    startEditing(window.prompt("Пароль для правки настроек мира:"));
  }

  if (dialog) {
    var form = dialog.querySelector("form");
    if (form) {
      form.addEventListener("submit", function () {
        startEditing(passInput ? passInput.value : "");
      });
    }
    var cancel = document.getElementById("passCancel");
    if (cancel) cancel.addEventListener("click", function () { dialog.close(); });
  }

  function onFlag(item) {
    send([(item.on ? "unset " : "set ") + item.key], item.key);
  }

  function onScale(item, value) {
    // Единица — это значение по умолчанию, ключ тогда просто снимаем,
    // чтобы не засорять список ключей мира.
    send([value === 1 ? "unset " + item.key : "set " + item.key + " " + value], item.key);
  }

  function onInt(item, value) {
    send([value === 0 ? "unset " + item.key : "set " + item.key + " " + value], item.key);
  }

  function renderItem(item) {
    var row = el("div", "wopt");
    // Флажок узкий и помещается справа от подписи, а ряд фишек — нет: при
    // одиннадцати значениях «Уровня мира» подпись сжималась в столбик.
    // Поэтому всё, кроме флажков, кладём под подпись на всю ширину.
    if (item.kind !== "flag") row.classList.add("wopt--stacked");
    if (busy) row.classList.add("is-busy");
    if (flashKey && item.key === flashKey) {
      row.classList.add("is-flash");
      flashKey = null;
    }

    var head = el("div", "wopt__head");
    head.appendChild(el("span", "wopt__label", item.label));
    if (item.hint) head.appendChild(el("span", "wopt__hint", item.hint));
    row.appendChild(head);

    var control = el("div", "wopt__control");

    if (item.kind === "flag") {
      var toggle = el("button", "k-switch", null);
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", item.on ? "true" : "false");
      toggle.setAttribute("aria-label", item.label);
      toggle.classList.toggle("is-on", !!item.on);
      if (!editing || busy) toggle.disabled = true;
      else toggle.addEventListener("click", function () { onFlag(item); });
      control.appendChild(toggle);
    } else if (item.kind === "int") {
      var group = el("div", "wchips");
      for (var v = item.min; v <= item.max; v++) {
        (function (value) {
          var chip = el("button", "k-chip", String(value));
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
        var chip = el("button", "k-chip", "×" + fmt(choice));
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
        var odd = el("span", "k-chip is-on is-static", "×" + fmt(item.value));
        chips.insertBefore(odd, chips.firstChild);
      }
      control.appendChild(chips);
    }

    row.appendChild(control);
    return row;
  }

  function emptyPanel(text) {
    var section = el("section", "panel glass-panel ogroup k-rise");
    section.style.setProperty("--i", "1");
    section.appendChild(el("p", "empty", text));
    return section;
  }

  function renderBar() {
    if (statusEl) {
      statusEl.innerHTML = editing
        ? "<b>Правка включена.</b> Нажми на переключатель или значение — изменится сразу у всех. Закончил — «Готово»."
        : "<b>Только просмотр.</b> Чтобы менять, нажми «Изменить» — понадобится пароль.";
      statusEl.classList.toggle("is-editing", editing);
    }
    if (editBtn) {
      editBtn.setAttribute("aria-pressed", editing ? "true" : "false");
      editBtn.title = editing ? "Выйти из правки" : "Изменить настройки";
    }
    if (editLabel) editLabel.textContent = editing ? "Готово" : "Изменить";
  }

  function render() {
    renderBar();
    root.textContent = "";

    if (!state || !state.ready) {
      root.appendChild(emptyPanel("Сервер ещё не отдал настройки"));
      return;
    }

    (state.groups || []).forEach(function (group, index) {
      var section = el("section", "panel glass-panel glass-panel--interactive ogroup k-rise");
      section.style.setProperty("--i", String(index + 1));
      // Ключ для раскладки из админ-режима (layout.js, admin.js).
      section.setAttribute("data-layout-key", group.name);
      section.appendChild(el("h2", "panel__head", group.name));
      var body = el("div", "ogroup__body");
      (group.items || []).forEach(function (item) {
        body.appendChild(renderItem(item));
      });
      section.appendChild(body);
      root.appendChild(section);
    });

    try { window.dispatchEvent(new CustomEvent("koban:options-rendered")); } catch (e) {}
  }

  if (editBtn) {
    editBtn.addEventListener("click", function () {
      if (editing) {
        editing = false;
        setPass("");
        render();
      } else {
        askPassword();
      }
    });
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
