/* Koban · Valheim — раскладка панелей, заданная в админ-режиме.
 *
 * Админ-режим открывается отдельной ссылкой (/v/admin/) и сохраняет раскладку
 * на сервере (/v/api/layout). Этот скрипт применяет её у всех: порядок и
 * ширину панелей главной, оформление плиток «Карта мира» и «Настройки мира»,
 * порядок и ширину групп настроек. Пока раскладку никто не менял, он ничего
 * не трогает — страница выглядит как свёрстана.
 *
 * Раскладок две: для компьютера (desktop) и для телефона (phone, до 720 px),
 * каждая правится в админ-режиме на своём экране и применяется на своём.
 * Сервер хранит { v: 2, desktop: {...}, phone: {...} }.
 *
 * Что можно задать в каждой (JSON):
 *   main.order        — ключи панелей главной по порядку
 *   main.items[key]   — { span: 1..6, hidden: bool, stretch: bool, head: выравнивание }
 *   tiles[map|opts]   — { arrow: "tl"|"tr"|"bl"|"br", desc: bool, kicker: bool,
 *                         valign: "top"|"center"|"bottom",
 *                         align: { kicker, title, text: "left"|"center"|"right" } }
 *   tiles.code        — рунный камень с кодом: { valign, button: "full"|"auto",
 *                         align: { kicker, title, code, button } }
 *   main.grid         — свободная сетка: { items: { key: { x, y, w, h } } }.
 *                       Колонок 12 на компьютере и 2 на телефоне, строка —
 *                       --k-row (8px) плюс зазор сетки. Если сетка задана,
 *                       порядок и ширина из order/span не действуют: каждая
 *                       панель стоит ровно в своих клетках, пустоты остаются.
 *   options.grid      — то же для групп настроек.
 *   options.order     — названия групп настроек по порядку
 *   options.items[..] — { span: 2..6, head: выравнивание заголовка }
 * На компьютере ширина — шестые доли строки и действует от 1240 px; на
 * телефоне — половина (1) или вся строка (2), у групп настроек её нет.
 *
 * Последняя раскладка лежит и в localStorage, чтобы применить её до ответа
 * сервера и не мигнуть свёрсткой по умолчанию.
 */
(function () {
  "use strict";

  var ENDPOINT = "/v/api/layout";
  var CACHE_KEY = "koban.layout";
  var ARROWS = ["tl", "tr", "bl", "br"];
  var ALIGNS = ["left", "center", "right"];
  var VALIGNS = ["top", "center", "bottom"];
  // Элементы плиток, которые выравниваются каждый отдельно.
  var ELEMENTS = {
    map: ["kicker", "title", "text"],
    opts: ["kicker", "title", "text"],
    code: ["kicker", "title", "code", "button"]
  };

  function setAttr(el, name, value) {
    if (value === null || value === undefined) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }

  function pick(v, allowed) { return allowed.indexOf(v) >= 0 ? v : null; }

  var PHONE = window.matchMedia("(max-width: 720px)");
  var data = null;

  function profileName() { return PHONE.matches ? "phone" : "desktop"; }

  // Самая первая версия хранила одну раскладку без профилей — это компьютер.
  function migrate(d) {
    if (!d || typeof d !== "object") return null;
    if (!d.desktop && !d.phone && (d.main || d.tiles || d.options)) return { v: 2, desktop: d };
    return d;
  }

  function current() { return obj(obj(data)[profileName()]); }

  // ---------- свободная сетка ----------

  var COLS = { desktop: 12, phone: 2 };
  function cols() { return COLS[profileName()]; }

  function int(v) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v ? v : null; }

  // Проверенная позиция в клетках или null.
  function cell(p, n) {
    p = obj(p);
    var x = int(p.x), y = int(p.y), w = int(p.w), h = int(p.h);
    if (x === null || y === null || w === null || h === null) return null;
    if (x < 0 || y < 0 || w < 1 || h < 1) return null;
    x = Math.min(x, n - 1);
    w = Math.min(w, n - x);
    return { x: x, y: y, w: w, h: Math.min(h, 400) };
  }

  function hasGrid(area) {
    var g = obj(obj(area).grid);
    return Object.keys(obj(g.items)).length > 0;
  }

  function applyFree(grid, items, area) {
    var n = cols();
    var placed = obj(obj(area.grid).items);
    var bottom = 0;
    var pos = {};
    items.forEach(function (el) {
      var p = cell(placed[el.getAttribute("data-layout-key")], n);
      if (p) {
        pos[el.getAttribute("data-layout-key")] = p;
        bottom = Math.max(bottom, p.y + p.h);
      }
    });
    grid.classList.add("is-free");
    grid.style.setProperty("--cols", String(n));
    grid.style.setProperty("--rows", String(Math.max(1, bottom)));
    // Панели, которых ещё нет в сетке (добавили новую), встают в первое
    // свободное место от трёх колонок шириной; нет такого — вниз во всю ширину.
    var taken = Object.keys(pos).map(function (k) { return pos[k]; });
    items.forEach(function (el) {
      var key = el.getAttribute("data-layout-key");
      if (pos[key] || el.hidden) return;
      var spot = freeSpot(taken, n, bottom);
      if (spot) {
        pos[key] = spot;
        taken.push(spot);
      }
    });
    var extra = 0;
    items.forEach(function (el) {
      var p = pos[el.getAttribute("data-layout-key")];
      el.style.order = "";
      el.classList.remove("has-span");
      el.style.removeProperty("--span");
      if (p) {
        el.style.gridColumn = (p.x + 1) + " / span " + p.w;
        el.style.gridRow = (p.y + 1) + " / span " + p.h;
        el.classList.add("is-placed");
      } else {
        // Новая панель, которой ещё нет в сетке, — во всю ширину под ней.
        el.style.gridColumn = "1 / -1";
        el.style.gridRow = String(Math.max(1, bottom) + 1 + extra++);
        el.classList.remove("is-placed");
      }
    });
  }

  // Первая сверху-слева пустота в пределах сетки: от 3 до 4 колонок шириной и
  // не ниже 12 строк; высота — до ближайшей панели снизу или до низа сетки.
  function freeSpot(taken, n, bottom) {
    function busy(x, y) {
      for (var i = 0; i < taken.length; i++) {
        var t = taken[i];
        if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return true;
      }
      return false;
    }
    for (var y = 0; y < bottom; y++) {
      for (var x = 0; x + 3 <= n; x++) {
        if (busy(x, y) || (x > 0 && !busy(x - 1, y) && y > 0 && !busy(x, y - 1))) continue;
        var w = 0;
        while (x + w < n && w < 4 && !busy(x + w, y)) w++;
        if (w < 3) continue;
        var h = 0;
        for (var free = true; free && y + h < bottom; ) {
          for (var c = x; c < x + w; c++) if (busy(c, y + h)) { free = false; break; }
          if (free) h++;
        }
        if (h >= 12) return { x: x, y: y, w: w, h: h };
      }
    }
    return null;
  }

  function clearFree(grid, items) {
    if (!grid.classList.contains("is-free")) return;
    grid.classList.remove("is-free");
    grid.style.removeProperty("--cols");
    grid.style.removeProperty("--rows");
    items.forEach(function (el) {
      el.style.gridColumn = "";
      el.style.gridRow = "";
      el.classList.remove("is-placed");
    });
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (e) { return null; }
  }

  function writeCache(d) {
    try {
      if (d) localStorage.setItem(CACHE_KEY, JSON.stringify(d));
      else localStorage.removeItem(CACHE_KEY);
    } catch (e) {}
  }

  function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }

  function clampSpan(v, lo, hi) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return null;
    return Math.max(lo, Math.min(hi, n));
  }

  // Порядок: сначала перечисленные в order, остальные — как стояли.
  function applyOrder(items, order) {
    var keys = Array.isArray(order) ? order : [];
    var pos = {};
    keys.forEach(function (k, i) { pos[k] = i; });
    var tail = keys.length;
    items.forEach(function (el, i) {
      var k = el.getAttribute("data-layout-key");
      el.style.order = k in pos ? String(pos[k]) : String(tail + i);
    });
  }

  function applyMain(d) {
    var grid = document.querySelector(".dashboard-grid");
    if (!grid) return;
    var phone = profileName() === "phone";
    var spanHi = phone ? 2 : 6;
    var anySpan = false;
    var items = Array.prototype.slice.call(grid.querySelectorAll(":scope > [data-layout-key]"));
    var main = obj(d.main);
    var conf = obj(main.items);
    var free = hasGrid(main);
    if (free) applyFree(grid, items, main);
    else {
      clearFree(grid, items);
      if (Array.isArray(main.order)) applyOrder(items, main.order);
      else items.forEach(function (el) { el.style.order = ""; });
    }
    items.forEach(function (el) {
      var c = obj(conf[el.getAttribute("data-layout-key")]);
      var span = free ? null : clampSpan(c.span, 1, spanHi);
      if (span) {
        anySpan = true;
        el.style.setProperty("--span", String(span));
        el.classList.add("has-span");
      } else {
        el.style.removeProperty("--span");
        el.classList.remove("has-span");
      }
      el.classList.toggle("is-stretch", !free && c.stretch === true);
      setAttr(el, "data-head", pick(c.head, ALIGNS));
      if (c.hidden === true) el.setAttribute("data-layout-hidden", "");
      else el.removeAttribute("data-layout-hidden");
      // Админ видит скрытое полупрозрачным, остальные не видят вовсе.
      el.hidden = c.hidden === true && !document.documentElement.classList.contains("nr-admin");
    });
    // Телефон: сетка в две колонки, только если кому-то задана половина.
    grid.classList.toggle("has-phone-spans", !free && phone && anySpan);
  }

  function applyTiles(d) {
    var tiles = obj(d.tiles);
    Object.keys(ELEMENTS).forEach(function (key) {
      var el = document.querySelector('[data-layout-key="' + key + '"]');
      if (!el) return;
      var c = obj(tiles[key]);
      if (key !== "code") {
        var arrow = pick(c.arrow, ARROWS);
        setAttr(el, "data-arrow", arrow && arrow !== "br" ? arrow : null);
        setAttr(el, "data-desc", c.desc === false ? "off" : null);
        setAttr(el, "data-kicker", c.kicker === false ? "off" : null);
      } else {
        setAttr(el, "data-button", c.button === "auto" ? "auto" : null);
      }
      setAttr(el, "data-valign", pick(c.valign, VALIGNS));
      var align = obj(c.align);
      ELEMENTS[key].forEach(function (part) {
        setAttr(el, "data-a-" + part, pick(align[part], ALIGNS));
      });
    });
  }

  function applyOptions(d) {
    var grid = document.getElementById("worldOptionsRoot");
    if (!grid) return;
    var items = Array.prototype.slice.call(grid.querySelectorAll(":scope > [data-layout-key]"));
    if (!items.length) return;
    var opt = obj(d.options);
    var conf = obj(opt.items);
    var phone = profileName() === "phone";
    var free = hasGrid(opt);
    if (free) applyFree(grid, items, opt);
    else {
      clearFree(grid, items);
      if (Array.isArray(opt.order)) applyOrder(items, opt.order);
      else items.forEach(function (el) { el.style.order = ""; });
    }
    // Сетка переходит на шесть колонок, только если кому-то задана ширина.
    grid.classList.toggle("has-spans", !free && !phone && items.some(function (el) {
      return !!clampSpan(obj(conf[el.getAttribute("data-layout-key")]).span, 1, 6);
    }));
    items.forEach(function (el) {
      var c = obj(conf[el.getAttribute("data-layout-key")]);
      var span = phone || free ? null : clampSpan(c.span, 1, 6);
      if (span) {
        el.style.setProperty("--span", String(span));
        el.classList.add("has-span");
      } else {
        el.style.removeProperty("--span");
        el.classList.remove("has-span");
      }
      setAttr(el, "data-head", pick(c.head, ALIGNS));
    });
  }

  function apply() {
    var d = current();
    document.documentElement.setAttribute("data-layout-profile", profileName());
    applyMain(d);
    applyTiles(d);
    applyOptions(d);
    try { window.dispatchEvent(new CustomEvent("koban:layout-applied")); } catch (e) {}
  }

  function set(d, persist) {
    data = migrate(d);
    if (persist) writeCache(data);
    apply();
  }

  // Черновик админ-режима: подменяем одну раскладку, не трогая другую.
  function setProfile(name, prof) {
    var full = obj(data) === data ? JSON.parse(JSON.stringify(data)) : { v: 2 };
    if (prof && Object.keys(prof).length) full[name] = prof;
    else delete full[name];
    data = full;
    apply();
  }

  function load() {
    return fetch(ENDPOINT, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) {
        set(d && d.layout ? d.layout : null, true);
        return data;
      })
      .catch(function () { return data; });
  }

  window.KobanLayout = {
    get: function () { return data ? JSON.parse(JSON.stringify(data)) : null; },
    profile: profileName,
    set: set,
    setProfile: setProfile,
    apply: apply,
    load: load,
    ARROWS: ARROWS.slice(),
    ALIGNS: ALIGNS.slice(),
    VALIGNS: VALIGNS.slice(),
    ELEMENTS: JSON.parse(JSON.stringify(ELEMENTS)),
    cols: cols,
    cell: cell
  };

  // Группы настроек рисует world-options.js — применяем, когда они появятся.
  window.addEventListener("koban:options-rendered", function () { applyOptions(current()); });
  // Повернули телефон или сузили окно — другая раскладка.
  if (PHONE.addEventListener) PHONE.addEventListener("change", apply);

  data = migrate(readCache());
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { apply(); load(); });
  } else {
    apply();
    load();
  }
})();
