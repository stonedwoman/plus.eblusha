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

## Тесты

```
cd bot && npm test                                                        # юнит (node:test), без сети
test/secret-env/secret-test.sh run test/bot-core.integration.test.ts     # ядро против настоящего backend
```

Интеграционный тест гоняется только в изолированной среде (тестовые Postgres/Redis, предохранитель
`guard.ts`); модель там поддельная — ни сети, ни денег. После прогона: `secret-test.sh prod-proof '<EB_PROOF>'`.

## Выкладка (ещё не делалась)

1. `npx ts-node src/scripts/seedBotUser.ts --env-file /DATA/eblusha-plus/.env.bot-account --owner-username <логин владельца>`
   (из корня репозитория; создаёт пользователя `eblusha_bot`, пароль генерируется и не печатается).
2. Владелец кладёт `ANTHROPIC_API_KEY=…` в `/DATA/eblusha-plus/.env.bot` (600).
3. `docker compose -f deploy/docker-compose.full.yml --env-file .env --profile bot up -d --build eblusha-bot`
   (сервис в профиле `bot`: общий `up -d` стека его не поднимает).
4. Людям: добавить бота в контакты по его EBLID (`GET /api/status/me` бота) или в группу.
