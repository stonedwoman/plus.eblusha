/* Ферма мира Koban: сколько у нас прирученной живности.
 *
 * Данные из /v/api/animals — плагин обходит ZDO и берёт только тех, у кого
 * стоит флаг tamed. Дикие того же префаба в мире встречаются постоянно и в
 * подсчёт не идут. Плагин пересчитывает прирученных раз в 10 секунд, мы
 * спрашиваем с той же частотой — но только пока главная грань на экране и
 * вкладка открыта. Перерисовываем, только если что-то изменилось; новое число
 * на мгновение вспыхивает.
 *
 * На каждый вид показываем: сколько всего, сколько взрослых и молодняка,
 * сколько со звёздами и какие клички дали игроки. Виды, которых ещё нет,
 * просто не выводятся — появятся сами, как только кого-то приручат.
 *
 * Сытость. Плагин считает её так же, как игра (Tameable.IsHungry): время
 * последней кормёжки из ZDO против сытости вида. Голодный зверь ищет корм на
 * земле рядом и не размножается, умереть от голода не может. Поля у зверя:
 *   a — 1, если рядом игрок и зона живёт; 0 — зона стоит;
 *   w — сколько секунд назад зону держали (тогда сытость — на тот момент);
 *   h — 1 голоден, 0 сыт; g — сколько уже голоден; s — сколько ещё сыт.
 * Без игрока рядом мир на ферме стоит, и «сытость сейчас» там смысла не имеет:
 * вернёшься — звери проголодаются сразу. Поэтому для стоящей зоны показываем,
 * были ли звери голодны, когда там в последний раз кто-то был: долгий голод
 * при живой зоне значит, что корма в досягаемости нет.
 */
(function () {
  "use strict";

  var ENDPOINT = "/v/api/animals";
  var POLL_MS = 10000;
  // Столько голода при живой зоне уже не случайность: корма рядом нет.
  var NO_FOOD_SEC = 120;
  var lastJson = null;
  var lastCounts = {};

  var root = document.getElementById("worldFarmRoot");
  if (!root) return;

  // Префаб → вид и формы для счёта (1 / 2-4 / 5+). Порядок внутри вида
  // задаёт порядок в подписи: сначала взрослые, потом молодняк.
  var KINDS = [
    { key: "Hen", species: "hen", forms: ["курица", "курицы", "куриц"] },
    { key: "Chicken", species: "hen", forms: ["цыплёнок", "цыплёнка", "цыплят"] },
    { key: "Boar", species: "boar", forms: ["кабан", "кабана", "кабанов"] },
    { key: "Boar_piggy", species: "boar", forms: ["поросёнок", "поросёнка", "поросят"] },
    { key: "Wolf", species: "wolf", forms: ["волк", "волка", "волков"] },
    { key: "Wolf_cub", species: "wolf", forms: ["волчонок", "волчонка", "волчат"] },
    { key: "Lox", species: "lox", forms: ["локс", "локса", "локсов"] },
    { key: "Lox_Calf", species: "lox", forms: ["телёнок", "телёнка", "телят"] },
    { key: "Asksvin", species: "asksvin", forms: ["асксвин", "асксвина", "асксвинов"] },
    { key: "Asksvin_hatchling", species: "asksvin", forms: ["птенец", "птенца", "птенцов"] }
  ];

  var SPECIES = [
    { id: "hen", label: "Куры", icon: "🐔" },
    { id: "boar", label: "Кабаны", icon: "🐗" },
    { id: "wolf", label: "Волки", icon: "🐺" },
    { id: "lox", label: "Локсы", icon: "🐂" },
    { id: "asksvin", label: "Асксвины", icon: "🦖" }
  ];

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

  // «8 мин», «2 ч», «3 дня»; меньше минуты — «меньше минуты».
  function dur(sec) {
    var m = Math.floor(Math.max(0, sec) / 60);
    if (m < 1) return "меньше минуты";
    if (m < 60) return m + "\u00a0мин";
    var h = Math.floor(m / 60);
    if (h < 48) return h + "\u00a0ч";
    var d = Math.floor(h / 24);
    return d + "\u00a0" + plural(d, "день", "дня", "дней");
  }

  // Сытость вида по тем, про кого она известна. null — узнать не из чего.
  function hungerOf(list) {
    var known = 0, hungry = 0, live = 0, maxG = -1, minS = Infinity, minW = Infinity;
    list.forEach(function (it) {
      if (it.h !== 0 && it.h !== 1) return;
      known++;
      if (it.a === 1) live++;
      else if (typeof it.w === "number") minW = Math.min(minW, it.w);
      if (it.h === 1) {
        hungry++;
        if (typeof it.g === "number") maxG = Math.max(maxG, it.g);
      } else if (it.a === 1 && typeof it.s === "number") {
        minS = Math.min(minS, it.s);
      }
    });
    if (!known) return null;
    return { known: known, hungry: hungry, live: live > 0, maxG: maxG, minS: minS, minW: minW };
  }

  function hungerLine(h) {
    var cls = h.hungry === 0 ? "is-fed" : "is-hungry";
    var text;
    if (h.hungry === 0) {
      text = "сыты все";
      if (h.live && isFinite(h.minS)) text += " · хватит ещё на " + dur(h.minS);
    } else {
      text = h.hungry === h.known ? "голодны все" : "голодных " + h.hungry + " из " + h.known;
      if (h.maxG >= 60) text += " · до " + dur(h.maxG) + " без еды";
      if (h.maxG >= NO_FOOD_SEC) text += " — корма рядом нет?";
    }
    var line = el("p", "farm__hunger " + cls);
    line.appendChild(el("span", "farm__dot"));
    line.appendChild(el("span", null, text));
    if (!h.live && isFinite(h.minW)) {
      line.classList.add("is-past");
      line.appendChild(el("small", null, "так было " + dur(h.minW) + " назад"));
    }
    line.title = "Голодный зверь ищет корм на земле в паре шагов и не размножается. " +
      "От голода звери не умирают." +
      (h.live ? "" : " Рядом с фермой сейчас никого, мир там стоит — показано, как было, " +
        "когда там в последний раз кто-то был.");
    return line;
  }

  function render(items) {
    root.textContent = "";

    if (!items) {
      root.appendChild(el("p", "empty", "Сервер сейчас недоступен"));
      return;
    }

    // Группируем по префабу: счёт, звёздные и клички.
    var by = {};
    var hungerKnown = false;   // плагин вообще умеет сытость (есть поле a)
    var anyLive = false;
    var anyPast = false;
    items.forEach(function (it) {
      var g = by[it.n] || (by[it.n] = { n: 0, stars: 0, names: [], all: [] });
      g.n++;
      g.all.push(it);
      if (it.l > 1) g.stars++;
      if (it.t) g.names.push(it.t);
      if (it.a === 0 || it.a === 1) hungerKnown = true;
      if (it.a === 1) anyLive = true;
      if (it.h === 0 || it.h === 1) anyPast = true;
    });

    var list = el("div", "farm__list");
    var total = 0;
    var totalStars = 0;
    var shown = 0;

    SPECIES.forEach(function (sp) {
      var kinds = KINDS.filter(function (k) { return k.species === sp.id; });
      var sum = kinds.reduce(function (a, k) { return a + ((by[k.key] || {}).n || 0); }, 0);
      if (sum === 0) return;
      shown++;
      total += sum;

      var row = el("div", "farm__row");

      var head = el("div", "farm__head");
      head.appendChild(el("span", "farm__icon", sp.icon));
      head.appendChild(el("span", "farm__name", sp.label));
      var countEl = el("b", "farm__count", String(sum));
      if (lastCounts[sp.id] != null && lastCounts[sp.id] !== sum) {
        countEl.classList.add(sum > lastCounts[sp.id] ? "is-up" : "is-down");
      }
      lastCounts[sp.id] = sum;
      head.appendChild(countEl);
      row.appendChild(head);

      var facts = [];
      kinds.forEach(function (k) {
        var g = by[k.key];
        if (!g) return;
        facts.push(g.n + " " + plural(g.n, k.forms[0], k.forms[1], k.forms[2]));
      });

      var stars = kinds.reduce(function (a, k) { return a + ((by[k.key] || {}).stars || 0); }, 0);
      totalStars += stars;
      if (stars) facts.push("★ " + stars + " со " + plural(stars, "звездой", "звёздами", "звёздами"));

      row.appendChild(el("p", "farm__facts", facts.join(" · ")));

      var hunger = hungerOf(kinds.reduce(function (a, k) {
        return by[k.key] ? a.concat(by[k.key].all) : a;
      }, []));
      if (hunger) row.appendChild(hungerLine(hunger));

      var names = [];
      kinds.forEach(function (k) {
        var g = by[k.key];
        if (g) names = names.concat(g.names);
      });
      if (names.length) {
        row.appendChild(el("p", "farm__names",
          names.slice(0, 10).join(", ") + (names.length > 10 ? " и ещё " + (names.length - 10) : "")));
      }

      list.appendChild(row);
    });

    if (!shown) {
      root.appendChild(el("p", "empty", "Прирученных пока нет"));
      return;
    }

    root.appendChild(list);

    var foot = "Всего " + total + " " + plural(total, "голова", "головы", "голов");
    if (totalStars) foot += ", из них " + totalStars + " со звёздами";
    root.appendChild(el("p", "farm__foot", foot + "."));

    // Про сытость, когда рядом с фермой никого нет и её неоткуда взять.
    if (hungerKnown && !anyLive && !anyPast) {
      root.appendChild(el("p", "farm__foot",
        "Сытость видна, пока рядом с фермой кто-то есть: без игрока мир там стоит."));
    }
  }

  function load() {
    return fetch(ENDPOINT, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        if (text === lastJson) return;
        lastJson = text;
        render(JSON.parse(text));
      })
      .catch(function () {
        if (lastJson === null) render(null);
      });
  }

  // Спрашиваем, только когда ферму видно: главная грань куба и открытая вкладка.
  function visible() {
    if (document.visibilityState === "hidden") return false;
    var face = document.documentElement.dataset.face;
    return !face || face === "main";
  }

  load();
  setInterval(function () { if (visible()) load(); }, POLL_MS);
  document.addEventListener("visibilitychange", function () { if (visible()) load(); });
  window.addEventListener("koban:face", function (e) {
    if (e.detail && e.detail.face === "main") load();
  });
})();
