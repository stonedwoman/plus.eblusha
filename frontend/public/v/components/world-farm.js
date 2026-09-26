/* Ферма мира Koban: сколько у нас прирученной живности.
 *
 * Данные из /v/api/animals — плагин обходит ZDO и берёт только тех, у кого
 * стоит флаг tamed. Дикие того же префаба в мире встречаются постоянно и в
 * подсчёт не идут.
 *
 * На каждый вид показываем: сколько всего, сколько взрослых и молодняка,
 * сколько со звёздами и какие клички дали игроки. Виды, которых ещё нет,
 * просто не выводятся — появятся сами, как только кого-то приручат.
 */
(function () {
  "use strict";

  var ENDPOINT = "/v/api/animals";
  var POLL_MS = 60000;

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

  function render(items) {
    root.textContent = "";

    if (!items) {
      root.appendChild(el("p", "empty", "Сервер сейчас недоступен"));
      return;
    }

    // Группируем по префабу: счёт, звёздные и клички.
    var by = {};
    items.forEach(function (it) {
      var g = by[it.n] || (by[it.n] = { n: 0, stars: 0, names: [] });
      g.n++;
      if (it.l > 1) g.stars++;
      if (it.t) g.names.push(it.t);
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
      head.appendChild(el("b", "farm__count", String(sum)));
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
  }

  function load() {
    return fetch(ENDPOINT, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(render)
      .catch(function () { render(null); });
  }

  load();
  setInterval(load, POLL_MS);
})();
