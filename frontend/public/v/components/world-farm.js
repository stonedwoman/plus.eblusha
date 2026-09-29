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
 *
 * Размножение (наша шутка для троих — «ебутся»). У приручённых взрослых:
 *   mt — сердечки прибавлялись последние пару минут, pg — беременна (у кур —
 *   скоро яйцо), cr — тесно: своих и приплода в 10 м уже столько, что игра
 *   размножаться не даёт. Сердечки идут, только пока зверь сыт, спокоен и
 *   рядом есть пара; набрав четыре, он беременеет.
 *
 * Приручение. Дикий зверь, которого уже начали приручать, приходит с u:1:
 *   tl — сколько секунд приручения осталось, tt — сколько всего у вида,
 *   fr — напуган. Шкала идёт, только пока зверь сыт, не напуган и рядом
 *   игрок (Tameable.TamingUpdate), поэтому «осталось» — это время сытого и
 *   спокойного зверя рядом с вами.
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

  // Форма вида в единственном числе: «волк», «волчонок».
  function kindName(prefab) {
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].key === prefab) return KINDS[i].forms[0];
    }
    return prefab;
  }

  function kindIcon(prefab) {
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].key !== prefab) continue;
      for (var j = 0; j < SPECIES.length; j++) {
        if (SPECIES[j].id === KINDS[i].species) return SPECIES[j].icon;
      }
    }
    return "🐾";
  }

  var SHOW_TAMING = 6;

  // Кто вообще размножается: взрослые. Молодняк сначала растёт.
  var BREEDERS = { Boar: 1, Hen: 1, Wolf: 1, Lox: 1, Asksvin: 1 };

  // Строка «♥ ебутся N · залетели M». Если никто не может — почему.
  function loveLine(list) {
    var adults = 0, mating = 0, preg = 0, crowded = 0;
    list.forEach(function (it) {
      if (!BREEDERS[it.n]) return;
      adults++;
      if (it.mt === 1) mating++;
      if (it.pg === 1) preg++;
      if (it.cr === 1) crowded++;
    });
    if (!adults || (!mating && !preg && !crowded)) return null;

    var line = el("p", "farm__love");
    line.appendChild(el("span", "farm__heart", "♥"));
    var parts = [];
    if (mating) parts.push("ебутся " + mating);
    if (preg) parts.push("залетели " + preg);
    if (parts.length) {
      line.appendChild(el("span", null, parts.join(" · ")));
      if (crowded) line.appendChild(el("small", null, "тесно " + crowded));
    } else {
      line.classList.add("is-idle");
      line.appendChild(el("span", null, "не ебутся: тесно, " + crowded + " из " + adults));
    }
    line.title = "Ебутся — у кого за последние пару минут прибавлялись сердечки: игра даёт их, " +
      "пока зверь сыт, спокоен и рядом есть пара, а на четвёртом он беременеет. " +
      "Залетели — ждут приплод. Тесно — в 10 м уже столько своих и приплода, что игра не даёт размножаться: " +
      "разведите по разным загонам.";
    return line;
  }

  // Кого сейчас приручают: полоса прогресса и что мешает.
  function renderTaming(list) {
    var box = el("div", "farm__taming");
    box.appendChild(el("p", "farm__subhead", "Приручаются"));

    list = list.slice().sort(function (a, b) {
      return (a.tl / a.tt) - (b.tl / b.tt);
    });

    list.slice(0, SHOW_TAMING).forEach(function (it) {
      var pct = Math.max(0, Math.min(100, Math.floor((1 - it.tl / it.tt) * 100)));
      var row = el("div", "farm__tame");

      var head = el("div", "farm__thead");
      head.appendChild(el("span", "farm__icon", kindIcon(it.n)));
      var name = kindName(it.n);
      head.appendChild(el("span", "farm__tname",
        name.charAt(0).toUpperCase() + name.slice(1) + (it.l > 1 ? " " + "★".repeat(it.l - 1) : "")));
      head.appendChild(el("b", "farm__tpct", pct + "%"));
      row.appendChild(head);

      var bar = el("span", "farm__tbar");
      var fill = el("i");
      fill.style.width = pct + "%";
      bar.appendChild(fill);
      row.appendChild(bar);

      // Что сейчас с приручением: идёт или почему стоит.
      var text, cls;
      if (it.a !== 1) {
        text = "рядом никого — приручение стоит";
        cls = "is-idle";
      } else if (it.fr === 1) {
        text = "напуган — приручение стоит";
        cls = "is-hungry";
      } else if (it.h === 1) {
        text = "голоден — нужен корм";
        cls = "is-hungry";
      } else {
        text = "сыт — до конца ~" + dur(Math.max(60, it.tl));
        cls = "is-fed";
      }
      row.appendChild(el("p", "farm__tstate " + cls, text));
      row.title = "Приручение идёт, только пока зверь сыт, не напуган и рядом кто-то есть. " +
        "Осталось " + dur(it.tl) + " такого времени.";
      box.appendChild(row);
    });

    if (list.length > SHOW_TAMING) {
      box.appendChild(el("p", "farm__foot", "и ещё " + (list.length - SHOW_TAMING)));
    }
    return box;
  }

  function render(items) {
    root.textContent = "";

    if (!items) {
      root.appendChild(el("p", "empty", "Сервер сейчас недоступен"));
      return;
    }

    // Приручаемые — отдельным блоком, в счёт фермы они не идут.
    var taming = items.filter(function (it) { return it.u === 1 && it.tt > 0; });
    items = items.filter(function (it) { return it.u !== 1; });

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

      var all = kinds.reduce(function (a, k) {
        return by[k.key] ? a.concat(by[k.key].all) : a;
      }, []);
      var hunger = hungerOf(all);
      if (hunger) row.appendChild(hungerLine(hunger));
      var love = loveLine(all);
      if (love) row.appendChild(love);

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
      if (taming.length) root.appendChild(renderTaming(taming));
      return;
    }

    root.appendChild(list);
    if (taming.length) root.appendChild(renderTaming(taming));

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
