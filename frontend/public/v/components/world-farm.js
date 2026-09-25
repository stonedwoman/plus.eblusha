/* Ферма мира Koban: сколько у нас прирученной живности.
 *
 * Данные из /v/api/animals — плагин обходит ZDO и берёт только тех, у кого
 * стоит флаг tamed. Дикие того же префаба в мире встречаются постоянно и в
 * подсчёт не идут.
 *
 * Взрослые и молодняк считаются раздельно: понятно, кто уже несёт яйца, а кто
 * ещё растёт. Клички (TamedName) показываем, если игроки их давали.
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

  // «21 взрослая», «11 цыплят» — без склонений не обойтись.
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

    var byKey = {};
    var names = [];
    items.forEach(function (it) {
      byKey[it.n] = (byKey[it.n] || 0) + 1;
      if (it.t) names.push(it.t);
    });

    var list = el("ul", "list");
    var total = 0;

    SPECIES.forEach(function (sp) {
      var kinds = KINDS.filter(function (k) { return k.species === sp.id; });
      var sum = kinds.reduce(function (a, k) { return a + (byKey[k.key] || 0); }, 0);
      if (sum === 0) return;
      total += sum;

      var li = document.createElement("li");

      var left = el("span", "farm__kind");
      left.appendChild(el("span", "farm__icon", sp.icon));

      var text = el("span", "farm__text");
      text.appendChild(el("span", "farm__name", sp.label));

      var parts = kinds
        .filter(function (k) { return byKey[k.key]; })
        .map(function (k) {
          var n = byKey[k.key];
          return n + " " + plural(n, k.forms[0], k.forms[1], k.forms[2]);
        });
      // Расшифровка нужна только когда есть и взрослые, и молодняк.
      if (parts.length > 1) text.appendChild(el("span", "farm__split", parts.join(" · ")));
      left.appendChild(text);

      var right = el("b", "farm__count", String(sum));

      li.appendChild(left);
      li.appendChild(right);
      list.appendChild(li);
    });

    if (total === 0) {
      root.appendChild(el("p", "empty", "Прирученных пока нет"));
      return;
    }

    root.appendChild(list);

    var foot = el("p", "farm__foot",
      "Всего " + total + " " + plural(total, "голова", "головы", "голов") + ".");
    if (names.length) {
      foot.textContent += " С кличками: " + names.slice(0, 8).join(", ") +
        (names.length > 8 ? " и ещё " + (names.length - 8) : "") + ".";
    }
    root.appendChild(foot);
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
