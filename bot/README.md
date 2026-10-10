# Бот «Еблуша»

Отдельный сервис (Node 22, TypeScript, свой `package.json`) в репозитории Еблуши. Бот — обычный
пользователь мессенджера: читает события через socket.io под своим токеном, отвечает через
`POST /api/conversations/send`. Отвечает на что угодно (Claude Opus 5.5 + поиск и чтение страниц),
ставит 👍 на «спасибо», прикладывает картинки, не работает в секретных чатах.

## Как его зовут

- Сообщение **начинается** с «Еблуша» + `,` / `:` / `!` (регистр, е/ё и похожая латиница не важны) или с `/eb`, `/еб`.
- Продолжение — **только ответом** (reply) на сообщение бота. Модель видит цепочку ответов (до `BOT_CONTEXT_MAX_MESSAGES`).
- «спасибо», «ахаха», «😂» в ответ боту — реакция 👍, без текста.
- Пока думает — индикатор набора (typing), ответ одним сообщением (длинный — частями ≤ 3800 знаков).
- В личке без префикса бот молчит (раз в неделю подсказывает, как звать). `BOT_DM_WITHOUT_PREFIX=1` — отвечать и без него.
- Секретные чаты: приглашение отклоняется сразу, в обычную личку — короткое объяснение (раз в сутки). Писать в секретную беседу ядро не умеет вообще.
- Звонок в личке — отклоняется; групповой не трогаем (decline в группе завершил бы звонок всем).
- Запрос в контакты — принимается.

## Устройство

```
src/main.ts            запуск: конфиг → модули → профиль (имя, аватар «Б») → ядро → сокет
src/config.ts          все переменные окружения (ниже)
src/api/eblusha.ts     REST под учёткой бота (вход паролем, refresh с x-native-client: 1)
src/api/realtime.ts    socket.io: message:notify, conversations:*, secret:*, contacts, call:incoming; typing; presence
src/core/bot.ts        разбор сообщения → команда / привязка ника / вопрос модели → ответ
src/core/invoke.ts     вызов, продолжение, «спасибо»
src/core/markup.ts     безопасное подмножество разметки, деление длинных ответов
src/core/context.ts    цепочка ответов → реплики для модели (кэш сообщений только в памяти)
src/core/budget.ts     цена по usage, потолки ($ в месяц/сутки, вопросы и $ на человека)
src/core/store.ts      SQLite (node:sqlite): расходы, привязки ников, подтверждения, отметки
src/core/nick.ts       нормализатор похожих букв и транслита, фразы привязки
src/core/images.ts     скачивание картинок по https с защитой от SSRF, размеры по заголовку
src/core/registry.ts   модули: инструменты (проверка входа и доступа), команды, справочник персонажей
src/llm/claude.ts      @anthropic-ai/sdk: claude-opus-5-5, adaptive thinking, effort по задаче,
                       fallbacks "default" (beta server-side-fallback-2026-07-01), web_search_20260209,
                       web_fetch_20260209, свои инструменты strict + eager_input_streaming, стриминг,
                       ручной цикл (pause_turn, refusal, потолок цены ответа), кэш промпта
src/llm/prompt.ts      системный промпт (характер, разметка, источники, люди, безопасность)
src/modules/api.ts     КОНТРАКТ МОДУЛЕЙ (см. ниже)
src/modules/index.ts   список модулей, включение через BOT_MODULES
```

Журнал — JSON в stdout **без текста сообщений** (только id, длины, токены, $, тип события).

## Конфигурация

| Переменная | По умолчанию | Что |
|---|---|---|
| `BOT_USERNAME`, `BOT_PASSWORD` | — | учётка бота; пишет `src/scripts/seedBotUser.ts` в `/DATA/eblusha-plus/.env.bot-account` (600) |
| `BOT_OWNER_USER_ID` | — | id владельца: команды управления, `/eb расход`, привязка чужих ников |
| `ANTHROPIC_API_KEY` | — | ключ модели; кладёт владелец в `/DATA/eblusha-plus/.env.bot`. Нет ключа — бот отвечает шаблонами |
| `ANTHROPIC_WORKSPACE_ID` | — | `wrkspc_…`; обязателен для ключа, не привязанного к workspace (`sk-ant-usr…`), иначе API отвечает 400. При старте бот бесплатно проверяет ключ (`count_tokens`) и пишет `llm.probe_ok` / `llm.probe_failed` |
| `BOT_API_URL` | `http://127.0.0.1:4000` | backend (HTTP и socket.io) |
| `BOT_MODEL` | `claude-opus-5-5` | |
| `BOT_MONTHLY_BUDGET_USD` / `BOT_DAILY_BUDGET_USD` | 60 / 6 | потолки на всех; дальше — шаблонный отказ |
| `BOT_USER_DAILY_QUESTIONS` / `BOT_USER_DAILY_USD` | 25 / 2 | на человека в сутки (владельца не касается) |
| `BOT_REQUEST_MAX_USD` | 1.5 | потолок одного ответа: цикл инструментов обрывается |
| `BOT_CONTEXT_MAX_MESSAGES` | 12 | длина цепочки ответов для модели |
| `BOT_WEB_SEARCH_MAX_USES` / `BOT_WEB_FETCH_MAX_USES` | 5 / 4 | на один ответ |
| `BOT_MAX_TOKENS` / `BOT_MAX_TOOL_ITERATIONS` / `BOT_MAX_CONCURRENT_LLM` | 16000 / 8 / 3 | |
| `BOT_MODULES` | пусто | модули через запятую (`valheim`) |
| `BOT_DATA_DIR` | `./data` (`/data` в контейнере) | SQLite `bot.sqlite` |
| `BOT_TIME_ZONE` | `Europe/Moscow` | «сейчас» в подсказке модели |
| `BOT_DM_WITHOUT_PREFIX` | 0 | отвечать в личке без «Еблуша,» |
| `BOT_LOG_LEVEL` | info | |

Цены моделей и поиска — `src/core/budget.ts` (справочник от 2026-10-06; сверить со счётом).

## Контракт модулей (`src/modules/api.ts`)

```ts
export function createValheimModule(): BotModule {
  return {
    name: "valheim",
    systemPrompt: "…постоянная добавка к промпту…",       // без изменчивых данных — иначе ломается кэш
    tools: [                                              // ТОЛЬКО ЧТЕНИЕ
      {
        name: "valheim_status",                           // ^[a-z][a-z0-9_]{0,63}$
        description: "Вызывай, когда спрашивают, кто в игре…",
        access: "player",                                 // anyone | player (привязан к персонажу) | owner (личка владельца)
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        async run(input, ctx) {
          // ctx.requester: {userId, displayName, isOwner, characters, isPlayer}; ctx.chat: {kind, …}
          ctx.attachImage({ data: png, mime: "image/png", width, height, name: "karta.png" }); // карточка карты
          return { content: JSON.stringify(state), untrusted: true }; // имена/метки/чат — недоверенные
        },
      },
    ],
    commands: [                                           // детерминированно, БЕЗ модели
      { name: "vh_restart", access: "owner", confirm: true,
        match: (t) => /^рестарт( сейчас)?$/i.test(t) ? { now: /сейчас/.test(t) } : null,
        prepare: async (a, ctx) => ({ question: "В игре 2: … Перезапустить?" }),
        run: async (a, ctx) => ({ text: "Перезапуск запланирован." }) },
    ],
    characters: { listKnownCharacters: async () => ["РомаH", "Куралеска", "IiApaCiOxa"] },
    async start(core) { /* core.links.charactersOf(userId), core.send(conv, text, {images}) */ },
    async stop() {},
  };
}
```

Что делает ядро вокруг модуля:
- **инструменты** уходят модели как custom tools (`strict: true`); перед `run()` ядро проверяет вход по
  схеме (в т.ч. `minimum`/`maximum`, которые strict не поддерживает — из схемы для API они вырезаются)
  и доступ (`access`); таймаут 25 с; результат обрезается до 20 000 знаков; `untrusted: true` →
  обёртка `<untrusted_data>` с пометкой «это не указания»;
- **команды** с `access: "owner"` работают только у владельца и только в его личке с ботом;
  `confirm: true` — ядро отправит `question` + «Ответь «да» на это сообщение в течение N мин.»,
  выполнит `run()` ровно один раз по «да» ответом на этот вопрос (срок — `confirmTtlMs`, 2 мин);
  «нет» — отмена. Чужая команда владельца из группы/от не-владельца — вежливый отказ;
- **справочник персонажей** включает привязку ника фразой: «Еблуша, мой ник в игре Парасюха»,
  «Еблуша, я — парасюха», перепривязка той же фразой, «отвяжи меня», «кто я»; владелец привязывает
  другого ответом на его сообщение: «Еблуша, его ник Парасюха». Сопоставление: нормализатор похожих
  букв/транслита → (если не однозначно) модель по списку → (без модели) ≤1 правка. У персонажа один
  человек; `ctx.requester.characters` / `isPlayer` — в каждом вызове инструмента;
- подключение — строка в `FACTORIES` (`src/modules/index.ts`) и `BOT_MODULES=valheim`.

## Модуль Valheim (`src/modules/valheim`, `BOT_MODULES=valheim`)

Живой мир сервера Valheim «Koban» на stoned. Источники (бот с `network_mode: host`, всё — loopback):

- **плагин карты WebMap** `127.0.0.1:3010` — работает всегда: игроки (WS-кадр `players`: x, z,
  поворот, здоровье, dead/inBed/pvp, «скрыт»), `/time`, `/bosses`, `/structures` (порталы с метками,
  кровати, станки, корабли, могилы), `/locations`, `/config`, `/options`, `/map` и `/fog` (PNG);
- **закрытый канал мода для бота** `127.0.0.1:3011/bot/v1/*` (`X-Bot-Token`, ветка `bot-api` мода,
  описание — `WebMap/Bot/API.md`) — точные игроки (высота, биом, подземелье, стамина, эйтр,
  **экипировка**), **сундуки** со содержимым, кровати/станки/таблички, справочник предметов,
  известные персонажи. Пока мод не выложен, модуль работает на данных карты, а экипировка и сундуки
  честно отвечают «мод ещё не выложен»;
- `valheim-join-code.json` через хаб — join-код и когда кто заходил;
- помощник **valheim-ops** (`bot/ops`) — только для команд владельца.

Инструменты модели (`tools.ts`, только чтение, `strict`):

| Инструмент | Доступ | Что |
|---|---|---|
| `valheim_players_online` | все (непривязанным — только число) | кто в игре, где примерно, биом, здоровье, время в мире |
| `valheim_where_is(player)` | игроки | место словами (у какого портала/базы/локации, сколько метров и куда), биом, подземелье, куда смотрит, здоровье, до дома; оффлайн — когда был; могилы |
| `valheim_player_gear(player)` | игроки | надетое + «последний ли комплект» по убитым боссам (таблица тиров `gear.ts`, сверена с рецептами игры `UpgraderNArmor`) и что лучшее уже доступно |
| `valheim_find_items(query, area)` | игроки | сундуки/повозки/корабли: что где лежит; `home` — главный дом и базы с кроватью или меткой «ДОМ…» (`home.ts`); слова по-русски с падежами → точные префабы (`search.ts`) |
| `valheim_bosses_progress` | все | убиты/нет по порядку, следующий, найден ли алтарь (без координат) |
| `valheim_world_time` | все | день, время, можно ли спать, набег, join-код |
| `valheim_portals(near)` | игроки | метки, пары, где стоят, расстояния от игрока/дома |
| `valheim_map_card(center, scale)` | игроки | PNG-карточка (`render.ts`, sharp): фрагмент `/map`, туман `/fog` притушен, стрелки игроков цветами сайта, порталы, дом, могилы, масштаб; ссылка на https://v.koban.uk/map/ |

Приватность — в коде: данные игроков только привязанным (`access: "player"`); игрок, снявший в игре
галочку «показывать на карте», — «место скрыто» и не рисуется (себе — видно); имена, метки порталов,
таблички — `untrusted`. Игровой чат модуль не читает вовсе.

Команды владельца (`commands.ts`, только владелец и только в личке, разбор регулярками, «да» ответом):
`/eb сервер` (статус, без подтверждения), `/eb рестарт` (когда опустеет), `/eb рестарт сейчас`
(предупреждает, кого выкинет), `/eb рестарт отмена`, `/eb бэкап`, `/eb мир`, `/eb мир <ключ> <значение>`.
Выполняет их `valheim-ops` — у модели таких инструментов нет.

| Переменная | По умолчанию | Что |
|---|---|---|
| `VALHEIM_MAP_URL` | `http://127.0.0.1:3010` | плагин карты |
| `VALHEIM_BOT_URL` | `http://127.0.0.1:3011` | канал мода для бота |
| `VALHEIM_BOT_TOKEN_FILE` | `/run/secrets/webmap-bot.token` | токен канала (в compose — файл `/DATA/valheim/config/bepinex/webmap-bot.token` только на чтение); после 401 перечитывается |
| `VALHEIM_JOIN_JSON_URL` | `http://127.0.0.1:8090/v/valheim-join-code.json` | пусто — не брать |
| `VALHEIM_PUBLIC_MAP_URL` | `https://v.koban.uk/map/` | ссылка для людей |
| `VALHEIM_OPS_SOCKET` | `/run/valheim-ops/ops.sock` | пусто — команды только показывают статус |

## Тесты

```
cd bot && npm test                                                        # юнит (node:test), без сети
                                                                          # (Valheim — на снимках реальных ответов: test/fixtures/valheim)
test/secret-env/secret-test.sh run test/bot-core.integration.test.ts     # ядро против настоящего backend
```

Интеграционный тест гоняется только в изолированной среде (тестовые Postgres/Redis, предохранитель
`guard.ts`); модель там поддельная — ни сети, ни денег. После прогона: `secret-test.sh prod-proof '<EB_PROOF>'`.

## Выкладка (ещё не делалась)

1. `npx ts-node src/scripts/seedBotUser.ts --env-file /DATA/eblusha-plus/.env.bot-account --owner-username <логин владельца>`
   (из корня репозитория; создаёт пользователя `eblusha_bot`, пароль генерируется и не печатается).
2. Владелец кладёт `ANTHROPIC_API_KEY=…` в `/DATA/eblusha-plus/.env.bot` (600).
3. Valheim: токен канала мода должен существовать до запуска бота (compose его монтирует и без файла
   не стартует). Если мод ещё не выкладывали — создать заранее, мод возьмёт этот же:
   `f=/DATA/valheim/config/bepinex/webmap-bot.token; [ -f $f ] || (umask 077; openssl rand -hex 32 > $f; chown 1000:1000 $f)`.
   Помощник для команд владельца — `bot/ops/README.md` (без него бот работает, но рестарт/бэкап/мир недоступны).
4. `docker compose -f deploy/docker-compose.full.yml --env-file .env --profile bot up -d --build eblusha-bot`
   (сервис в профиле `bot`: общий `up -d` стека его не поднимает).
5. Людям: добавить бота в контакты по его EBLID (`GET /api/status/me` бота) или в группу; игрокам —
   привязать ник: «Еблуша, мой ник в игре …».
