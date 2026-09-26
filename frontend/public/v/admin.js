/* Koban · Valheim — админ-режим раскладки.
 *
 * Открывается только отдельной ссылкой /v/admin/ (→ /v/?admin). В обычном
 * интерфейсе от него нет ни кнопок, ни следов: этот файл и admin.css грузятся
 * лишь с ?admin в адресе.
 *
 * Что умеет:
 *  - панели главной и группы настроек: перетаскивание за ручку (остальные
 *    расступаются, у края грани страница сама прокручивается), ширина —
 *    за правую кромку с прилипанием к шестым долям строки;
 *  - «Формат» у каждой плитки — панель оформления прямо под своей кнопкой:
 *    ширина, высота, видимость, выравнивание заголовка; у плиток «Карта мира»
 *    и «Настройки мира» — угол стрелки, показ описания и надписи, выравнивание
 *    каждого элемента и положение текста по вертикали; у рунного камня —
 *    выравнивание каждого элемента и ширина кнопки;
 *  - «Сохранить» кладёт раскладку на сервер (/v/api/layout) — её видят все;
 *    «Отменить» возвращает сохранённую, «По умолчанию» — свёрстанную.
 *
 * Раскладок две — для компьютера и для телефона (до 720 px). Админ-режим на
 * компьютере правит компьютерную, а кнопка «Телефон» открывает посреди экрана
 * рамку телефона со страницей в телефонной ширине (/v/?admin=phone) — там
 * правится телефонная, ровно в том виде, в каком её увидят. С телефона
 * режим сразу правит телефонную; «Как на компьютере» берёт компьютерную за
 * основу. Сохраняется только своя раскладка, вторая не затирается.
 *
 * Пароль тот же, что для правки настроек мира; держим его в sessionStorage.
 * Сама раскладка применяется у всех через layout.js (KobanLayout).
 */
(function () {
  "use strict";

  var root = document.documentElement;
  if (!root.classList.contains("nr-admin")) return;
  var L = window.KobanLayout;
  if (!L) return;

  var ENDPOINT = "/v/api/layout";
  var PASS_KEY = "koban.valheim.pass";
  var WIDE = window.matchMedia("(min-width: 1240px)");
  var PHONE = window.matchMedia("(max-width: 720px)");
  var PROFILE = PHONE.matches ? "phone" : "desktop";
  var framed = true;
  try { framed = window.self !== window.top; } catch (e) {}
  // Рамка телефона внутри админ-режима компьютера.
  var PREVIEW = framed && /(?:^|[?&])admin=phone(?:&|$)/.test(location.search);

  var saved = null;
  var draft = {};
  var unlocked = false;
  var busy = false;

  var ALIGN_LABEL = { left: "Слева", center: "По центру", right: "Справа" };
  var VALIGN_LABEL = { top: "Сверху", center: "По центру", bottom: "Снизу" };
  var PART_LABEL = {
    kicker: "Надпись над заголовком",
    title: "Заголовок",
    text: "Описание",
    code: "Код",
    button: "Кнопка"
  };
  var CORNER_LABEL = { tl: "Слева сверху", tr: "Справа сверху", bl: "Слева снизу", br: "Справа снизу" };
  var GROUP_SPANS = [
    { span: 2, label: "⅓", title: "Треть строки" },
    { span: 3, label: "½", title: "Половина строки" },
    { span: 4, label: "⅔", title: "Две трети строки" },
    { span: 6, label: "Вся", title: "Вся строка" }
  ];

  var ICON = {
    grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></g></svg>',
    brush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20c2.5 0 4-1.6 4-3.6 0-1.3-1-2.4-2.3-2.4C4.4 14 3.5 15 3.5 16.3 3.5 18 4 20 4 20z"/><path d="M8.6 13.4 19.5 2.5a1.8 1.8 0 0 1 2.5 2.5L11.1 15.9"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 10h10M4 14h16M4 18h10"/></svg>',
    center: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 10h10M4 14h16M7 18h10"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M10 10h10M4 14h16M10 18h10"/></svg>',
    top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 4h16"/><rect x="7" y="7" width="10" height="6" rx="1"/></svg>',
    vcenter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 12h3M17 12h3"/><rect x="7" y="9" width="10" height="6" rx="1"/></svg>',
    bottom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 20h16"/><rect x="7" y="11" width="10" height="6" rx="1"/></svg>'
  };

  // ---------- мелочи ----------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o || {})); }

  // Пустые объекты не храним: «ничего не задано» должно выглядеть одинаково.
  function prune(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return o;
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        prune(v);
        if (!Object.keys(v).length) delete o[k];
      } else if (v === undefined || v === null) {
        delete o[k];
      }
    });
    return o;
  }

  function canon(o) {
    if (Array.isArray(o)) return o.map(canon);
    if (o && typeof o === "object") {
      var out = {};
      Object.keys(o).sort().forEach(function (k) { out[k] = canon(o[k]); });
      return out;
    }
    return o;
  }

  function sameLayout(a, b) {
    var x = prune(clone(a));
    var y = prune(clone(b));
    delete x.v;
    delete y.v;
    return JSON.stringify(canon(x)) === JSON.stringify(canon(y));
  }

  function pass() {
    try { return sessionStorage.getItem(PASS_KEY) || ""; } catch (e) { return ""; }
  }

  function setPass(v) {
    try {
      if (v) sessionStorage.setItem(PASS_KEY, v);
      else sessionStorage.removeItem(PASS_KEY);
    } catch (e) {}
  }

  function node(key) { return document.querySelector('[data-layout-key="' + key + '"]'); }

  function titleOf(n) {
    var h = n.querySelector(".panel__head, .tile__title, .hero__title");
    return h ? h.textContent.trim() : "Плитка";
  }

  // ---------- черновик ----------

  function section(name) { return draft[name] || (draft[name] = {}); }

  function conf(kind, key) {
    if (kind === "panel") {
      var m = section("main");
      m.items = m.items || {};
      return m.items[key] || (m.items[key] = {});
    }
    if (kind === "group") {
      var o = section("options");
      o.items = o.items || {};
      return o.items[key] || (o.items[key] = {});
    }
    var t = section("tiles");
    return t[key] || (t[key] = {});
  }

  function savedProfile() { return clone((saved || {})[PROFILE] || {}); }

  function commit() {
    prune(draft);
    L.setProfile(PROFILE, clone(draft));
    refreshBar();
    decorate();
    if (pop) pop.refresh();
  }

  // ---------- панель внизу ----------

  var bar = el("div", "adm-bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Раскладка");
  bar.setAttribute("data-noswipe", "");
  // Компьютер: переключатель «Компьютер / Телефон». Телефон: пометка и
  // «Как на компьютере».
  var deviceHtml = PROFILE === "desktop"
    ? '<div class="adm-device" role="group" aria-label="Чья раскладка">' +
        '<button type="button" class="adm-device__btn is-on" aria-pressed="true" data-act="desktop">Компьютер</button>' +
        '<button type="button" class="adm-device__btn" aria-pressed="false" data-act="phone">Телефон</button>' +
      '</div>'
    : '<span class="adm-device adm-device--static">Телефон</span>';
  bar.innerHTML =
    '<div class="adm-bar__title"><span class="adm-bar__mark" aria-hidden="true">' + ICON.brush + '</span>' +
    '<span class="adm-bar__name">Раскладка</span>' + deviceHtml + '</div>' +
    '<p class="adm-bar__hint"><span class="adm-bar__status" aria-live="polite"></span>' +
    '<span class="adm-bar__hinttext"></span></p>' +
    '<div class="adm-bar__actions">' +
      '<button type="button" class="adm-btn adm-btn--primary" data-act="save">Сохранить</button>' +
      '<button type="button" class="adm-btn" data-act="revert">Отменить</button>' +
      (PROFILE === "phone" ? '<button type="button" class="adm-btn" data-act="copy">Как на компьютере</button>' : "") +
      '<button type="button" class="adm-btn" data-act="reset">По умолчанию</button>' +
      '<button type="button" class="adm-btn adm-btn--ghost" data-act="exit">' + (PREVIEW ? "Закрыть" : "Выйти") + '</button>' +
    '</div>';
  bar.classList.toggle("adm-bar--phone", PROFILE === "phone");

  // На телефоне доска сворачивается в полоску — касанием по заголовку.
  if (PROFILE === "phone") {
    var titleEl = bar.querySelector(".adm-bar__title");
    titleEl.setAttribute("role", "button");
    titleEl.setAttribute("tabindex", "0");
    titleEl.setAttribute("aria-expanded", "true");
    titleEl.appendChild(el("span", "adm-bar__fold", "свернуть"));
    var fold = function () {
      var min = bar.classList.toggle("is-min");
      titleEl.setAttribute("aria-expanded", min ? "false" : "true");
      titleEl.querySelector(".adm-bar__fold").textContent = min ? "развернуть" : "свернуть";
      root.classList.toggle("adm-bar-min", min);
    };
    titleEl.addEventListener("click", fold);
    titleEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fold(); }
    });
  }
  document.body.appendChild(bar);

  var statusEl = bar.querySelector(".adm-bar__status");
  var hintEl = bar.querySelector(".adm-bar__hinttext");

  function dirty() { return !sameLayout(draft, savedProfile()); }

  function refreshBar() {
    var d = unlocked && dirty();
    bar.classList.toggle("is-dirty", d);
    bar.querySelector('[data-act="save"]').disabled = !unlocked || !d || busy;
    bar.querySelector('[data-act="revert"]').disabled = !unlocked || !d || busy;
    bar.querySelector('[data-act="reset"]').disabled = !unlocked || busy;
    var copyBtn = bar.querySelector('[data-act="copy"]');
    if (copyBtn) copyBtn.disabled = !unlocked || busy || !(saved && saved.desktop);
    if (!unlocked) statusEl.textContent = "нужен пароль";
    else if (busy) statusEl.textContent = "сохраняю…";
    else statusEl.textContent = d ? "есть несохранённое" : "сохранено";
    var face = window.KobanCube ? window.KobanCube.current() : "main";
    if (face === "map") hintEl.textContent = "На карте нечего раскладывать — поверни куб на главную или настройки.";
    else if (PROFILE === "phone") hintEl.textContent = "Раскладка для телефона: тащи за ⠿, оформление и ширину (половина или вся строка) — в «Формате».";
    else if (!WIDE.matches) hintEl.textContent = "Раскладка для компьютера. Ширина панелей задаётся на экране от 1240 px — здесь порядок и оформление.";
    else hintEl.textContent = "Раскладка для компьютера: тащи за ⠿, ширину — за правую кромку, оформление — «Формат».";
  }

  var toastTimer = 0;
  function toast(text, bad) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = text;
    t.className = "k-toast is-on " + (bad ? "is-bad" : "is-good");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("is-on"); }, 3200);
  }

  bar.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    var act = b.getAttribute("data-act");
    if (act === "save") save();
    else if (act === "phone") openPhone();
    else if (act === "desktop") return;
    else if (act === "copy") {
      // Компьютерная раскладка за основу: порядок и оформление, без ширины.
      var d = clone((saved || {}).desktop || {});
      if (d.main && d.main.items) Object.keys(d.main.items).forEach(function (k) { delete d.main.items[k].span; });
      if (d.options && d.options.items) Object.keys(d.options.items).forEach(function (k) { delete d.options.items[k].span; });
      draft = d;
      commit();
      toast("Взял раскладку компьютера — ширину выстави заново");
    } else if (act === "revert") {
      draft = savedProfile();
      commit();
      toast("Вернул сохранённую раскладку");
    } else if (act === "reset") {
      if (!window.confirm("Вернуть раскладку, как была свёрстана? Сохранится, когда нажмёшь «Сохранить».")) return;
      draft = {};
      commit();
    } else if (act === "exit") {
      if (dirty() && !window.confirm("Есть несохранённые изменения. Выйти без сохранения?")) return;
      window.removeEventListener("beforeunload", onUnload);
      if (PREVIEW) {
        try { window.parent.postMessage({ type: "koban-admin-phone-close" }, location.origin); } catch (e) {}
        return;
      }
      location.href = "/v/" + (location.hash || "");
    }
  });

  function onUnload(e) {
    if (unlocked && dirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  }
  window.addEventListener("beforeunload", onUnload);

  // ---------- сервер ----------

  function request(body, check) {
    return fetch(ENDPOINT + (check ? "?check=1" : ""), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "X-Koban-Pass": pass() },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
    });
  }

  function save() {
    busy = true;
    refreshBar();
    prune(draft);
    request({ profile: PROFILE, layout: Object.keys(draft).length ? draft : null })
      .then(function (res) {
        if (res.status === 403) {
          setPass("");
          lock("Пароль больше не подходит — войди заново");
          return;
        }
        if (res.status !== 200 || !res.body || res.body.ok !== true) {
          toast((res.body && res.body.error) || "Не сохранилось", true);
          return;
        }
        saved = res.body.layout || {};
        draft = savedProfile();
        L.set(clone(saved), true);
        toast(PROFILE === "phone" ? "Сохранено — так увидят на телефонах" : "Сохранено — так увидят на компьютерах");
      })
      .catch(function () { toast("Сервер не ответил", true); })
      .then(function () {
        busy = false;
        refreshBar();
      });
  }

  // ---------- вход ----------

  var login = el("dialog", "k-dialog adm-login");
  login.setAttribute("data-noswipe", "");
  login.innerHTML =
    '<form method="dialog">' +
      '<h2>Админ-режим</h2>' +
      '<p>Раскладка панелей для всех. Пароль тот же, что для правки настроек мира.</p>' +
      '<input class="k-input" type="password" autocomplete="current-password" placeholder="Пароль" required>' +
      '<p class="adm-login__err" hidden></p>' +
      '<div class="k-dialog__actions">' +
        '<a class="btn-ghost" href="/v/">На сайт</a>' +
        '<button type="submit" class="btn-primary">Войти</button>' +
      '</div>' +
    '</form>';
  document.body.appendChild(login);
  var loginInput = login.querySelector("input");
  var loginErr = login.querySelector(".adm-login__err");

  login.addEventListener("cancel", function (e) { e.preventDefault(); });
  login.querySelector("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var typed = loginInput.value.trim();
    if (!typed) return;
    setPass(typed);
    check();
  });

  function lock(message) {
    unlocked = false;
    root.classList.remove("adm-on");
    undecorate();
    refreshBar();
    loginErr.hidden = !message;
    loginErr.textContent = message || "";
    if (!login.open) login.showModal();
    loginInput.value = "";
    loginInput.focus();
  }

  function unlock() {
    unlocked = true;
    root.classList.add("adm-on");
    if (login.open) login.close();
    decorate();
    refreshBar();
  }

  function check() {
    if (!pass()) { lock(""); return; }
    request({}, true)
      .then(function (res) {
        if (res.status === 200 && res.body && res.body.ok) unlock();
        else if (res.status === 403) { setPass(""); lock("Пароль не подошёл"); }
        else lock((res.body && res.body.error) || "Сервер не принял вход");
      })
      .catch(function () { lock("Сервер не ответил"); });
  }

  // ---------- метки на плитках ----------

  function items() {
    return {
      panel: Array.prototype.slice.call(document.querySelectorAll(".dashboard-grid > [data-layout-key]")),
      tile: Array.prototype.slice.call(document.querySelectorAll(".hero__grid > [data-layout-key]")),
      group: Array.prototype.slice.call(document.querySelectorAll("#worldOptionsRoot > [data-layout-key]"))
    };
  }

  function decorate() {
    if (!unlocked) return;
    var all = items();
    Object.keys(all).forEach(function (kind) {
      all[kind].forEach(function (n) { ensureControls(n, kind); });
    });
  }

  function undecorate() {
    Array.prototype.forEach.call(document.querySelectorAll(".adm-ctrl, .adm-resize, .adm-hidden"), function (n) { n.remove(); });
    Array.prototype.forEach.call(document.querySelectorAll(".adm-item"), function (n) {
      n.classList.remove("adm-item", "adm-item--panel", "adm-item--tile", "adm-item--group");
    });
  }

  function ensureControls(n, kind) {
    if (n.querySelector(":scope > .adm-ctrl")) return;
    n.classList.add("adm-item", "adm-item--" + kind);
    // У плиток отключаем наклон за мышью: мешает целиться в кнопки.
    n.removeAttribute("data-tilt");
    n.style.transform = "";

    var ctrl = el("div", "adm-ctrl");
    ctrl.setAttribute("data-noswipe", "");
    if (kind !== "tile") {
      var grip = el("button", "adm-grip");
      grip.type = "button";
      grip.title = "Перетащить";
      grip.setAttribute("aria-label", "Перетащить «" + titleOf(n) + "»");
      grip.innerHTML = ICON.grip;
      grip.addEventListener("pointerdown", function (e) { startDrag(e, n, kind); });
      ctrl.appendChild(grip);
    }
    var fmt = el("button", "adm-fmt");
    fmt.type = "button";
    fmt.innerHTML = ICON.brush + "<span>Формат</span>";
    fmt.setAttribute("aria-label", "Оформление «" + titleOf(n) + "»");
    fmt.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (pop && pop.target === n) closePop();
      else openPop(n, kind, fmt);
    });
    ctrl.appendChild(fmt);
    n.appendChild(ctrl);

    if (kind !== "tile") {
      var rz = el("span", "adm-resize");
      rz.setAttribute("data-noswipe", "");
      rz.title = "Потяни, чтобы изменить ширину";
      rz.addEventListener("pointerdown", function (e) { startResize(e, n, kind); });
      n.appendChild(rz);
    }
    if (kind === "panel") {
      var hid = el("span", "adm-hidden", "Скрыто для всех");
      n.appendChild(hid);
    }
  }

  // Плитки в админ-режиме не поворачивают куб: клик — это выбор для оформления.
  document.addEventListener("click", function (e) {
    if (!unlocked) return;
    var tile = e.target.closest && e.target.closest(".hero__grid > [data-layout-key]");
    if (!tile || e.target.closest(".adm-ctrl")) return;
    e.preventDefault();
    var btn = tile.querySelector(".adm-fmt");
    if (btn) openPop(tile, "tile", btn);
  }, true);

  window.addEventListener("koban:options-rendered", function () { decorate(); });
  window.addEventListener("koban:layout-applied", function () { decorate(); });
  window.addEventListener("koban:face", function () { closePop(); refreshBar(); });
  WIDE.addEventListener("change", refreshBar);

  // ---------- перетаскивание ----------

  function visualOrder(container) {
    var kids = Array.prototype.slice.call(container.querySelectorAll(":scope > [data-layout-key]"));
    return kids
      .map(function (n, i) { return { n: n, o: parseInt(getComputedStyle(n).order, 10) || 0, i: i }; })
      .sort(function (a, b) { return a.o - b.o || a.i - b.i; })
      .map(function (x) { return x.n; });
  }

  function scroller(n) { return n.closest(".face__scroll"); }

  var drag = null;

  function startDrag(e, n, kind) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    closePop();
    var list = visualOrder(n.parentElement);
    list.forEach(function (x, i) { x.style.order = String(i); });
    var r = n.getBoundingClientRect();
    drag = {
      n: n, kind: kind, list: list, id: e.pointerId,
      gx: e.clientX - r.left, gy: e.clientY - r.top,
      x: e.clientX, y: e.clientY, over: null,
      sc: scroller(n), raf: 0
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    n.classList.add("is-dragging");
    root.classList.add("adm-dragging");
    follow();
    drag.raf = requestAnimationFrame(autoscroll);
    e.currentTarget.addEventListener("pointermove", onDragMove);
    e.currentTarget.addEventListener("pointerup", endDrag);
    e.currentTarget.addEventListener("pointercancel", endDrag);
  }

  function follow() {
    var n = drag.n;
    n.style.transform = "none";
    var r = n.getBoundingClientRect();
    n.style.transform =
      "translate(" + (drag.x - drag.gx - r.left).toFixed(1) + "px," + (drag.y - drag.gy - r.top).toFixed(1) + "px) rotate(-0.6deg) scale(1.015)";
  }

  function inside(r, x, y) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    var over = null;
    for (var i = 0; i < drag.list.length; i++) {
      var o = drag.list[i];
      if (o === drag.n) continue;
      if (inside(o.getBoundingClientRect(), drag.x, drag.y)) { over = o; break; }
    }
    if (over && over !== drag.over) move(over);
    drag.over = over;
    follow();
  }

  // Переставляем, а соседи плавно едут на новые места (FLIP).
  function move(over) {
    var list = drag.list;
    var before = new Map();
    list.forEach(function (x) { if (x !== drag.n) before.set(x, x.getBoundingClientRect()); });
    var from = list.indexOf(drag.n);
    var to = list.indexOf(over);
    list.splice(from, 1);
    list.splice(to, 0, drag.n);
    list.forEach(function (x, i) { x.style.order = String(i); });
    before.forEach(function (a, x) {
      var b = x.getBoundingClientRect();
      var dx = a.left - b.left;
      var dy = a.top - b.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      x.animate(
        [{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "translate(0,0)" }],
        { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
      );
    });
  }

  // У верхнего и нижнего края грани прокручиваем сами.
  function autoscroll() {
    if (!drag) return;
    var sc = drag.sc;
    if (sc) {
      var r = sc.getBoundingClientRect();
      var edge = 70;
      var v = 0;
      if (drag.y < r.top + edge) v = -Math.ceil((r.top + edge - drag.y) / 5);
      else if (drag.y > r.bottom - edge - 80) v = Math.ceil((drag.y - (r.bottom - edge - 80)) / 5);
      if (v) {
        sc.scrollTop += v;
        follow();
      }
    }
    drag.raf = requestAnimationFrame(autoscroll);
  }

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    e.currentTarget.removeEventListener("pointermove", onDragMove);
    e.currentTarget.removeEventListener("pointerup", endDrag);
    e.currentTarget.removeEventListener("pointercancel", endDrag);
    var n = d.n;
    var cur = n.style.transform;
    n.style.transform = "none";
    n.animate([{ transform: cur }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    n.style.transform = "";
    n.classList.remove("is-dragging");
    root.classList.remove("adm-dragging");
    var keys = d.list.map(function (x) { return x.getAttribute("data-layout-key"); });
    section(d.kind === "group" ? "options" : "main").order = keys;
    commit();
  }

  // ---------- ширина ----------

  function startResize(e, n, kind) {
    e.preventDefault();
    e.stopPropagation();
    if (!WIDE.matches) {
      toast("Ширину задают на экране от 1240 px", true);
      return;
    }
    closePop();
    var grid = n.parentElement;
    var cs = getComputedStyle(grid);
    var gap = parseFloat(cs.columnGap) || 0;
    var gr = grid.getBoundingClientRect();
    var col = (gr.width - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0) - gap * 5) / 6;
    var left = n.getBoundingClientRect().left;
    var min = kind === "group" ? 2 : 1;
    var badge = el("span", "adm-span-badge");
    n.appendChild(badge);
    n.classList.add("is-resizing");
    var target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch (err) {}
    var span = null;

    function at(x) {
      return Math.max(min, Math.min(6, Math.round((x - left + gap) / (col + gap))));
    }
    function show(s) {
      span = s;
      n.style.setProperty("--span", String(s));
      n.classList.add("has-span");
      badge.textContent = s + " / 6";
    }
    show(at(e.clientX));

    function onMove(ev) { show(at(ev.clientX)); }
    function onUp() {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      badge.remove();
      n.classList.remove("is-resizing");
      conf(kind, n.getAttribute("data-layout-key")).span = span;
      commit();
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  // ---------- панель «Формат» ----------

  var pop = null;

  function closePop() {
    if (!pop) return;
    pop.el.remove();
    if (pop.btn) pop.btn.setAttribute("aria-expanded", "false");
    pop = null;
  }

  document.addEventListener("pointerdown", function (e) {
    if (pop && !pop.el.contains(e.target) && !(pop.btn && pop.btn.contains(e.target))) closePop();
  }, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
  window.addEventListener("resize", function () { if (pop) pop.place(); });
  document.addEventListener("scroll", function () { if (pop) pop.place(); }, true);

  function heading(text) { return el("div", "adm-sec", text); }

  function seg(label, options, current, onPick, extraCls, inline) {
    var row = el("div", "adm-row" + (inline ? " adm-row--inline" : ""));
    row.appendChild(el("div", "adm-row__label", label));
    var g = el("div", "adm-seg" + (extraCls ? " " + extraCls : ""));
    g.setAttribute("role", "radiogroup");
    g.setAttribute("aria-label", label);
    options.forEach(function (o) {
      var b = el("button", "adm-seg__btn");
      b.type = "button";
      b.setAttribute("role", "radio");
      var on = o.value === current;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.classList.toggle("is-on", on);
      b.title = o.title || o.text || "";
      b.innerHTML = o.html || "";
      if (o.text) b.appendChild(el("span", "adm-seg__text", o.text));
      b.addEventListener("click", function () { onPick(o.value); });
      g.appendChild(b);
    });
    row.appendChild(g);
    return row;
  }

  function toggle(label, on, onChange) {
    var row = el("div", "adm-row adm-row--inline");
    row.appendChild(el("div", "adm-row__label", label));
    var sw = el("button", "k-switch" + (on ? " is-on" : ""));
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", on ? "true" : "false");
    sw.setAttribute("aria-label", label);
    sw.addEventListener("click", function () { onChange(!on); });
    row.appendChild(sw);
    return row;
  }

  function alignRow(label, current, onPick) {
    return seg(label, ["left", "center", "right"].map(function (a) {
      return { value: a, html: ICON[a], title: ALIGN_LABEL[a] };
    }), current || "left", onPick, "adm-seg--icons", true);
  }

  function valignRow(current, onPick) {
    return seg("По вертикали", ["top", "center", "bottom"].map(function (v) {
      return { value: v, html: ICON[v === "center" ? "vcenter" : v], title: VALIGN_LABEL[v] };
    }), current, onPick, "adm-seg--icons", true);
  }

  function spanBars(n) {
    var s = '<span class="adm-bars" aria-hidden="true">';
    for (var i = 1; i <= 6; i++) s += '<i class="' + (i <= n ? "on" : "") + '"></i>';
    return s + "</span>";
  }

  function build(n, kind) {
    var key = n.getAttribute("data-layout-key");
    var c = conf(kind, key);
    var wrap = el("div", "adm-pop__body");

    function set(k, v) {
      c = conf(kind, key);
      if (v === undefined || v === null) delete c[k];
      else c[k] = v;
      commit();
    }
    // По умолчанию всё слева, кроме надписи на кнопке камня — она по центру.
    function def(part) { return key === "code" && part === "button" ? "center" : "left"; }
    function setAlign(part, v) {
      c = conf(kind, key);
      c.align = c.align || {};
      if (v === def(part) || v === null) delete c.align[part];
      else c.align[part] = v;
      commit();
    }

    var narrow = !WIDE.matches;

    if (kind === "panel") {
      wrap.appendChild(heading("Размер"));
      if (PROFILE === "phone") {
        wrap.appendChild(seg("Ширина", [
          { value: null, text: "Вся строка", title: "Как свёрстано" },
          { value: 1, text: "Половина", title: "Две такие панели встанут рядом" }
        ], c.span === 1 ? 1 : null, function (v) { set("span", v); }));
      } else {
        var opts = [{ value: null, text: "Авто", title: "Как свёрстано" }];
        for (var i = 1; i <= 6; i++) opts.push({ value: i, html: spanBars(i), text: String(i), title: i + " из 6 колонок" });
        wrap.appendChild(seg("Ширина", opts, c.span || null, function (v) { set("span", v); }, "adm-seg--spans"));
        if (narrow) wrap.appendChild(el("p", "adm-note", "Ширина действует на экране от 1240 px — здесь панели идут одна под другой."));
      }
      wrap.appendChild(seg("Высота", [
        { value: false, text: "По содержимому" },
        { value: true, text: "По высоте ряда" }
      ], c.stretch === true, function (v) { set("stretch", v ? true : null); }));
      wrap.appendChild(heading("Выравнивание"));
      wrap.appendChild(alignRow("Заголовок", c.head, function (v) { set("head", v === "left" ? null : v); }));
      wrap.appendChild(heading("Показывать"));
      wrap.appendChild(toggle("Панель на странице", c.hidden !== true, function (v) { set("hidden", v ? null : true); }));
    } else if (kind === "group" && PROFILE === "phone") {
      wrap.appendChild(heading("Выравнивание"));
      wrap.appendChild(alignRow("Заголовок", c.head, function (v) { set("head", v === "left" ? null : v); }));
    } else if (kind === "group") {
      wrap.appendChild(heading("Размер"));
      var gopts = [{ value: null, text: "Авто", title: "Как свёрстано" }].concat(GROUP_SPANS.map(function (g) {
        return { value: g.span, html: spanBars(g.span), text: g.label, title: g.title };
      }));
      wrap.appendChild(seg("Ширина", gopts, c.span || null, function (v) { set("span", v); }, "adm-seg--spans adm-seg--5"));
      if (narrow) wrap.appendChild(el("p", "adm-note", "Ширина действует на экране от 1240 px."));
      wrap.appendChild(heading("Выравнивание"));
      wrap.appendChild(alignRow("Заголовок", c.head, function (v) { set("head", v === "left" ? null : v); }));
    } else if (key === "code") {
      wrap.appendChild(heading("Выравнивание"));
      ["kicker", "title", "code", "button"].forEach(function (part) {
        wrap.appendChild(alignRow(PART_LABEL[part], (c.align && c.align[part]) || def(part), function (v) { setAlign(part, v); }));
      });
      wrap.appendChild(valignRow(c.valign || "center", function (v) { set("valign", v === "center" ? null : v); }));
      wrap.appendChild(heading("Кнопка"));
      wrap.appendChild(seg("Ширина кнопки", [
        { value: "full", text: "Во всю ширину" },
        { value: "auto", text: "По тексту" }
      ], c.button === "auto" ? "auto" : "full", function (v) { set("button", v === "auto" ? "auto" : null); }));
    } else {
      // «Карта мира» / «Настройки мира»
      wrap.appendChild(heading("Стрелка"));
      var corners = el("div", "adm-row");
      var pick = el("div", "adm-corners");
      pick.setAttribute("role", "radiogroup");
      pick.setAttribute("aria-label", "Угол стрелки");
      pick.appendChild(el("span", "adm-corners__name", titleOf(n)));
      var arrow = c.arrow || "br";
      L.ARROWS.forEach(function (a) {
        var b = el("button", "adm-corner adm-corner--" + a + (a === arrow ? " is-on" : ""));
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", a === arrow ? "true" : "false");
        b.title = CORNER_LABEL[a];
        b.setAttribute("aria-label", CORNER_LABEL[a]);
        b.textContent = key === "map" ? "←" : "→";
        b.addEventListener("click", function () { set("arrow", a === "br" ? null : a); });
        pick.appendChild(b);
      });
      corners.appendChild(pick);
      wrap.appendChild(corners);
      wrap.appendChild(heading("Выравнивание"));
      ["kicker", "title", "text"].forEach(function (part) {
        wrap.appendChild(alignRow(PART_LABEL[part], c.align && c.align[part], function (v) { setAlign(part, v); }));
      });
      wrap.appendChild(valignRow(c.valign || "bottom", function (v) { set("valign", v === "bottom" ? null : v); }));
      wrap.appendChild(heading("Показывать"));
      wrap.appendChild(toggle("Надпись над заголовком", c.kicker !== false, function (v) { set("kicker", v ? null : false); }));
      wrap.appendChild(toggle("Описание", c.desc !== false, function (v) { set("desc", v ? null : false); }));
    }

    var reset = el("button", "adm-btn adm-btn--ghost adm-pop__reset", "Сбросить оформление");
    reset.type = "button";
    reset.addEventListener("click", function () {
      if (kind === "panel") delete section("main").items[key];
      else if (kind === "group") delete section("options").items[key];
      else delete section("tiles")[key];
      commit();
    });
    wrap.appendChild(reset);
    return wrap;
  }

  function openPop(n, kind, btn) {
    closePop();
    var p = el("div", "adm-pop");
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-label", "Оформление: " + titleOf(n));
    p.setAttribute("data-noswipe", "");
    var head = el("div", "adm-pop__head");
    head.appendChild(el("span", "adm-pop__title", titleOf(n)));
    var x = el("button", "adm-pop__close");
    x.type = "button";
    x.setAttribute("aria-label", "Закрыть");
    x.innerHTML = ICON.close;
    x.addEventListener("click", closePop);
    head.appendChild(x);
    p.appendChild(head);
    var body = build(n, kind);
    p.appendChild(body);
    document.body.appendChild(p);
    btn.setAttribute("aria-expanded", "true");

    pop = {
      el: p, target: n, btn: btn, kind: kind,
      // Панель — прямо под своей кнопкой, с ромбом на неё; не влезает — над ней.
      place: function () {
        var b = btn.getBoundingClientRect();
        var w = p.offsetWidth;
        var h = p.offsetHeight;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var cx = b.left + b.width / 2;
        var left = Math.max(10, Math.min(vw - w - 10, cx - w / 2));
        // Снизу — доска «Раскладка»: панель до неё не доходит.
        var floor = bar.getBoundingClientRect().top - 12;
        var roof = 76;
        var body = p.querySelector(".adm-pop__body");
        body.style.maxHeight = "";
        h = p.offsetHeight;
        var below = floor - (b.bottom + 14);
        var over = b.top - 14 - roof;
        var above = h > below && over > below;
        var room = above ? over : below;
        if (h > room) {
          body.style.maxHeight = Math.max(140, room - (h - body.offsetHeight)) + "px";
          h = p.offsetHeight;
        }
        var top = above ? b.top - 14 - h : b.bottom + 14;
        p.classList.toggle("is-above", above);
        p.style.left = Math.round(left) + "px";
        p.style.top = Math.round(Math.max(roof, top)) + "px";
        p.style.setProperty("--adm-notch", Math.round(cx - left) + "px");
      },
      refresh: function () {
        var fresh = build(n, kind);
        p.replaceChild(fresh, p.querySelector(".adm-pop__body"));
        this.place();
      }
    };
    pop.place();
  }

  // ---------- старт ----------

  // ---------- рамка телефона (только на компьютере) ----------

  var phoneBox = null;

  function fitPhone() {
    if (!phoneBox) return;
    var frame = phoneBox.querySelector(".adm-phone__device");
    var scale = Math.min(1, (window.innerHeight - 120) / 872, (window.innerWidth - 40) / 418);
    frame.style.transform = "scale(" + scale.toFixed(3) + ")";
    // Масштаб не двигает поток — подтягиваем подпись и кнопку под рамку.
    frame.style.marginBottom = Math.round(872 * scale - 872) + "px";
    frame.style.marginLeft = frame.style.marginRight = Math.round((418 * scale - 418) / 2) + "px";
  }

  function openPhone() {
    if (phoneBox) return;
    closePop();
    phoneBox = el("div", "adm-phone");
    phoneBox.setAttribute("data-noswipe", "");
    phoneBox.setAttribute("role", "dialog");
    phoneBox.setAttribute("aria-label", "Раскладка для телефона");
    var face = location.hash === "#settings" ? "#settings" : "#main";
    phoneBox.innerHTML =
      '<div class="adm-phone__device">' +
        '<span class="adm-phone__speaker" aria-hidden="true"></span>' +
        '<iframe class="adm-phone__screen" title="Страница на телефоне" src="/v/?admin=phone' + face + '"></iframe>' +
      '</div>' +
      '<p class="adm-phone__hint">Телефонная раскладка: правь прямо в рамке, сохраняй там же. Ширина экрана — 390 px.</p>' +
      '<button type="button" class="adm-btn adm-phone__close">Вернуться к компьютеру</button>';
    document.body.appendChild(phoneBox);
    phoneBox.querySelector(".adm-phone__close").addEventListener("click", closePhone);
    root.classList.add("adm-phone-open");
    bar.querySelector('[data-act="phone"]').classList.add("is-on");
    bar.querySelector('[data-act="phone"]').setAttribute("aria-pressed", "true");
    bar.querySelector('[data-act="desktop"]').classList.remove("is-on");
    bar.querySelector('[data-act="desktop"]').setAttribute("aria-pressed", "false");
    fitPhone();
  }

  function closePhone() {
    if (!phoneBox) return;
    phoneBox.remove();
    phoneBox = null;
    root.classList.remove("adm-phone-open");
    bar.querySelector('[data-act="phone"]').classList.remove("is-on");
    bar.querySelector('[data-act="phone"]').setAttribute("aria-pressed", "false");
    bar.querySelector('[data-act="desktop"]').classList.add("is-on");
    bar.querySelector('[data-act="desktop"]').setAttribute("aria-pressed", "true");
    // Телефонную могли сохранить — подтягиваем, компьютерный черновик не теряем.
    L.load().then(function (d) {
      saved = clone(d || {});
      commit();
    });
  }

  window.addEventListener("resize", fitPhone);
  window.addEventListener("message", function (e) {
    if (e.origin === location.origin && e.data && e.data.type === "koban-admin-phone-close") closePhone();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && phoneBox && !pop) closePhone(); });

  // Экран сменил ширину через границу телефона — это уже другая раскладка.
  // Ждём, пока новая ширина устоится (окно могли просто протащить), и не
  // теряем несохранённое: тогда только просим сохранить или отменить.
  var profileTimer = 0;
  if (PHONE.addEventListener) {
    PHONE.addEventListener("change", function () {
      if (PREVIEW) return;
      clearTimeout(profileTimer);
      profileTimer = setTimeout(function () {
        var now = PHONE.matches ? "phone" : "desktop";
        if (now === PROFILE) return;
        if (unlocked && dirty()) {
          toast("Экран стал " + (now === "phone" ? "телефонным" : "широким") + ". Сохрани или отмени правки и обнови страницу — откроется другая раскладка.", true);
          return;
        }
        window.removeEventListener("beforeunload", onUnload);
        location.reload();
      }, 1500);
    });
  }

  function start() {
    L.load().then(function (d) {
      saved = clone(d || {});
      draft = savedProfile();
      check();
      refreshBar();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
