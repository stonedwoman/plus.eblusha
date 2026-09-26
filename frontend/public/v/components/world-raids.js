/* Набеги мира Koban — отдельная панель главной.
 *
 * Данные — world.events из /v/valheim-join-code.json: строки «Random event
 * set:…» из лога сервера (сколько отдавать — VALHEIM_MAX_WORLD_EVENTS у
 * valheim-join-api). Разбор записей и справочник набегов (враги, биомы,
 * длительность) — общие с панелью «Боссы»: window.ValheimEvents из
 * world-info.js и window.ValheimWorldRu из constants/valheim-world-ru.js.
 *
 * Две вкладки в строке заголовка: «Последний» — последний набег и счёт
 * (кто пришёл, где бывает, сколько длится, сколько уже без набегов, какой
 * чаще всего), «История» — лента прошлых набегов. Сделано так, чтобы
 * «Последний» влезал в панель ~490×410 без прокрутки. Выбранная вкладка
 * запоминается в браузере.
 */
(function (global) {
  "use strict";

  var SHOW_HISTORY = 40;
  var TAB_KEY = "koban.raids.tab";
  var tab = "last";
  try { if (localStorage.getItem(TAB_KEY) === "history") tab = "history"; } catch (e) {}

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100;
    var b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  // «Сколько уже без набегов» — коротко, без «назад».
  function span(seconds) {
    if (seconds == null || !isFinite(seconds)) return "";
    var m = Math.floor(Math.max(0, seconds) / 60);
    if (m < 60) return m + " мин";
    var h = Math.floor(m / 60);
    if (h < 48) return h + " " + plural(h, "час", "часа", "часов");
    var d = Math.floor(h / 24);
    return d + " " + plural(d, "день", "дня", "дней");
  }

  // Дата из строки лога как есть: «26.09, 02:38».
  function when(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "." + m[2] + ", " + m[4] + ":" + m[5] : "";
  }

  function facts(meta) {
    var out = [];
    if (!meta) return out;
    if (meta.enemies && meta.enemies.length) out.push(["Враги", meta.enemies.join(", ")]);
    if (meta.biomes && meta.biomes.length) out.push(["Где", meta.biomes.join(", ")]);
    if (meta.duration) out.push(["Длится", meta.duration]);
    return out;
  }

  // Вкладки живут в строке заголовка панели (h2 перед корнем): так они не
  // отнимают высоту у содержимого.
  function tabsFor(root, count, onPick) {
    var head = root.previousElementSibling;
    if (!head || !head.classList || !head.classList.contains("panel__head")) return;
    var box = head.querySelector(".raids__tabs");
    if (!box) {
      box = el("span", "raids__tabs");
      box.setAttribute("role", "tablist");
      box.setAttribute("aria-label", "Набеги");
      [["last", "Последний"], ["history", "История"]].forEach(function (t) {
        var b = el("button", "raids__tab");
        b.type = "button";
        b.setAttribute("role", "tab");
        b.setAttribute("data-tab", t[0]);
        b.appendChild(el("span", null, t[1]));
        b.addEventListener("click", function () { onPick(t[0]); });
        box.appendChild(b);
      });
      head.classList.add("has-tabs");
      head.appendChild(box);
    }
    Array.prototype.forEach.call(box.querySelectorAll(".raids__tab"), function (b) {
      var on = b.getAttribute("data-tab") === tab;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      var n = b.querySelector(".raids__count");
      if (b.getAttribute("data-tab") === "history") {
        if (!n) { n = el("span", "raids__count"); b.appendChild(n); }
        n.textContent = count > 0 ? String(count) : "";
      }
    });
  }

  function renderWorldRaids(root, world) {
    if (!root) return;
    var E = global.ValheimEvents;
    var raw = world && Array.isArray(world.events) ? world.events : [];
    var events = E ? raw.map(E.normalize) : [];
    // Свежие сверху.
    events = events.slice().reverse();

    tabsFor(root, Math.max(0, events.length - 1), function (t) {
      tab = t;
      try { localStorage.setItem(TAB_KEY, t); } catch (e) {}
      renderWorldRaids(root, world);
    });

    root.textContent = "";
    root.setAttribute("data-tab", tab);

    if (!events.length) {
      root.appendChild(el("p", "empty", "Набегов пока не было — или лог о них молчит"));
      return;
    }

    if (tab === "history") {
      renderHistory(root, events.slice(1), E);
      return;
    }

    // ---------- последний набег ----------

    var last = events[0];
    var hero = el("div", "raids__last");
    var kick = el("div", "raids__kicker");
    kick.appendChild(el("span", "raids__dot"));
    kick.appendChild(el("span", null, "Последний набег"));
    var ago = last.secondsAgo != null && E ? E.formatRealAgo(last.secondsAgo) : "";
    if (ago) kick.appendChild(el("span", "raids__ago", ago));
    hero.appendChild(kick);

    hero.appendChild(el("div", "raids__name", last.nameRu || last.id));
    var info = el("dl", "raids__facts");
    facts(last.meta).forEach(function (f) {
      info.appendChild(el("dt", null, f[0]));
      info.appendChild(el("dd", null, f[1]));
    });
    if (info.childNodes.length) hero.appendChild(info);
    if (E) hero.title = E.tooltip(last);
    root.appendChild(hero);

    // ---------- счёт ----------

    var stats = el("div", "raids__stats");
    function stat(value, label, title) {
      var st = el("div", "raids__stat");
      st.appendChild(el("b", null, value));
      st.appendChild(el("span", null, label));
      if (title) st.title = title;
      stats.appendChild(st);
    }
    stat(String(events.length), plural(events.length, "набег", "набега", "набегов") + " в логе");
    if (last.secondsAgo != null) stat(span(last.secondsAgo), "без набегов");
    var counts = {};
    events.forEach(function (e) {
      var k = e.nameRu || e.id;
      counts[k] = (counts[k] || 0) + 1;
    });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    if (top && counts[top] > 1) stat("×" + counts[top], top, "Чаще всего: " + top);
    root.appendChild(stats);
  }

  function renderHistory(root, older, E) {
    if (!older.length) {
      root.appendChild(el("p", "empty", "Кроме последнего, набегов не было"));
      return;
    }
    var list = el("ol", "raids__list");
    older.slice(0, SHOW_HISTORY).forEach(function (e) {
      var li = el("li", "raids__item" + (e.unknown ? " is-unknown" : ""));
      li.appendChild(el("span", "raids__mark"));
      li.appendChild(el("span", "raids__item-name", e.nameRu || e.id));
      var t = el("span", "raids__item-when");
      t.appendChild(el("span", null, e.secondsAgo != null && E ? E.formatRealAgo(e.secondsAgo) : ""));
      t.appendChild(el("small", null, when(e.occurredAt)));
      li.appendChild(t);
      if (E) li.title = E.tooltip(e);
      list.appendChild(li);
    });
    root.appendChild(list);
    var rest = older.length - SHOW_HISTORY;
    if (rest > 0) root.appendChild(el("p", "raids__more", "и ещё " + rest + " раньше"));
  }

  global.renderWorldRaids = renderWorldRaids;
})(typeof window !== "undefined" ? window : this);
