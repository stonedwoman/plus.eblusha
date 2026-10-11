# Как поддерживать справочник бота «Еблуша»

## Что здесь лежит

- `eblusha-app.md` — справочник по приложению. Он целиком идёт в системный промпт бота отдельным блоком после основного текста, под той же точкой кэша (`bot/src/main.ts` `loadKnowledge`, `bot/src/llm/prompt.ts` `buildKnowledgeBlock`; файл копируется в образ бота, путь — `BOT_KNOWLEDGE_FILE`, `off` — без справочника). Поэтому в нём нет ссылок на код, коммитов (кроме строки «Сверено…»), ключей и имён людей. Проверки формы — `bot/test/unit/knowledge.test.ts`.
- `sources.json` — для каждого утверждения справочника указано, где оно в коде (`file:line`). Корни путей описаны в `roots`, поле `section` — номер раздела справочника. Нужен для перепроверки и для поиска, что трогать при выпуске.
- Разведки — подробные разборы по областям с подписями и ссылками на код:
  - `server-features.md`;
  - `web-ui.md`;
  - `native-pc-ui.md`;
  - `android-ui.md`;
  - `ios-ui.md`.

  Из них собран справочник. При крупном выпуске проще заново прогнать разведку нужной области, чем латать.
- Место: справочник, этот файл и `sources.json` — `bot/knowledge/` в репозитории сервера (с выпуска 2026-10-11). Разведки (`*-ui.md`, `server-features.md`) в репозиторий не входят: их копия — `D:\claude-backup\bot-knowledge\`.

## Когда обновлять

- **Выпуск любой платформы с видимыми людям изменениями:** новая или убранная функция, новые подписи и пути, другие лимиты или умолчания. Платформы: сервер, веб, натив ПК, Android, iOS.
- **Смена версии или ссылки для установки.** Раздел 2 справочника: ПК, Android с прямой ссылкой на APK, номер сборки iOS.
- **Смена лимитов бота** (`BOT_USER_DAILY_QUESTIONS` и т. п.) — раздел 13.
- **Выход функции из раздела 17 «В работе».** Сейчас там мьют бесед, порядок для него — ниже.
- **Новая функция в работе.** Её стоит внести в раздел 17, только если люди о ней уже спрашивают.

## Что смотреть по платформам

Штамп прошлой сверки берётся из первой строки справочника: `Сверено … сервер и веб — <commit>, ПК — X, Android — Y, iPhone — сборка N`.

### Сервер
Репозиторий `/DATA/eblusha-plus` (ssh root@stoned.local; диск S: не использовать).

Что изменилось с прошлой сверки:
```
git -C /DATA/eblusha-plus log --oneline <штамп>..HEAD -- src prisma docs bot
```

Где искать:
- `src/routes/{conversations,messages,auth,status,contacts,devices,upload,calls,threads,bot}.ts` — права, лимиты, кто что может;
- `src/lib/{systemBot,messageFanout,registrationInvites,localTime,secretLatch}.ts`;
- `src/realtime/socket.ts` — тайминги звонков (25/30/60 с, 15 с, 2/5 мин);
- `src/push/*` — что попадает в пуш;
- `prisma/schema.prisma` — новые поля, например `mutedUntil`;
- `docs/bot-system.md` — контракт бота для клиентов;
- `bot/README.md` — что умеет бот, лимиты.

Лимиты бота смотреть так: `docker logs eblusha-bot 2>&1 | grep evt:boot | tail -1`. Там нужны только числа `userDailyQuestions` и `userDailyUsd`. Файл `.env.bot` не печатать: в нём ключ.

### Веб
Код — `frontend/src` в том же репозитории.
```
git log <штамп>..HEAD -- frontend/src
```

Главные файлы:
- `ui/pages/chats/render/{ChatModals,MessagesPane,ConversationListPane,ChatMessageRow}.tsx` — почти все подписи;
- `ui/pages/ChatsPage.tsx`;
- `ui/components/{CallOverlay,CallMini,ScreenShareSettings,callSecurity,LocalTimeSettingsSection,SystemPopups,LinkDeviceModal}.tsx`;
- `ui/components/bot/BotUi.tsx`;
- `features/availability/*`;
- `ui/pages/chats/chatsConstants.ts` — лимиты вложений.

### ПК (натив)
- **Главный источник** — раздел новой версии в `C:/projects/eblusha-winui/CHANGELOG.md` и `installer/whatsnew.txt`.
- **Разница по коду** — в scratch-репозитории натива (main и метки `vX.Y.Z`):
  ```
  git diff vСТАРАЯ..vНОВАЯ --stat -- Eblusha.Desktop Eblusha.Setup
  ```
- **Подписи и пути:**
  - `Eblusha.Desktop/Views/ChatsPage.xaml` и `Views/ChatsPage.*.cs`;
  - `Services/AppSettings.cs` — настройки и их умолчания;
  - `Services/BotRules.cs`;
  - `MainWindow.xaml(.cs)` — трей;
  - `Eblusha.Setup/Ui/Scenes/*` — установщик.
- **Версия:** `Eblusha.Desktop/Eblusha.Desktop.csproj` и `updates/winui/latest.json` на сервере.
- **Открытый пункт:** после выпуска 2.0.11 («старт окна») перепроверить в разделе 14 абзац «Если ярлык не открывает окно».

### Android
- `C:/projects/eblusha-mobile` не под git. Изменения находить сравнением со снимком прошлой сверки. После каждой сверки класть копию `app/src/main/java` и `docs/release-notes-android.md` в `scratchpad/bot-knowledge/snap-android-<версия>/`.
- **Главный источник** — раздел версии в `docs/release-notes-android.md`.
- **Подписи:**
  - `ui/chat/{ChatScreen,ChatListScreen,BotChatUi}.kt`;
  - `ui/social/{SettingsScreen,ContactsScreen,CreateGroupScreen}.kt`;
  - `ui/call/*`;
  - `service/*` — уведомления и их категории;
  - `feature/bot/BotRules.kt`;
  - `core/update/UpdateManager.kt`.
- **Версия** — `app/build.gradle.kts`. Прямая ссылка на APK — поле `download_url` в `https://ru.eblusha.org/updates/android/latest.yml`. Имя файла меняется с каждой версией: в справочнике обновить и номер, и ссылку.

### iOS
- **Что изменилось:**
  ```
  git -C /DATA/eblusha-plus log --oneline <штамп>..HEAD -- ios
  ```
- **Подписи:**
  - `ios/Eblusha/Features/Chat/*`;
  - `Features/Social/{SettingsView,ContactsView,GroupMembersView}.swift`;
  - `Features/Call/*`;
  - `Core/Bot/SystemBot.swift`;
  - `Core/Push/*`;
  - `Resources/Info.plist`;
  - `ios/project.yml` — минимальная iOS.
- **Номер сборки** — из вывода `scripts/ios-release.sh` или `ios-invites/asc.py builds`. В справочнике обновить «сборка N» в шапке и в разделе 2.

## Порядок обновления

1. **Собрать изменения** с прошлого штампа по командам выше. Плюс заметки выпуска: CHANGELOG ПК, `release-notes-android.md`, описание iOS.
2. **Найти, что затронуто.** Для каждого видимого людям изменения найти раздел справочника. Поможет `sources.json`: поиск по `src` с изменённым файлом даёт `section`.
3. **Поправить текст для всех четырёх приложений.** Если функция вышла не везде, прямо написать, где она есть, а где пока нет («сквозное — матрицей»). Подписи — дословно из кода, в «ёлочках».
4. **Обновить `sources.json`:** `file:line`, а для новых утверждений — новые `id`.
5. **Пройти разделы 16 «Чего пока нет» и 17 «В работе».**
   - Вышедшее перенести в основные разделы.
   - Проверки «нет» повторить: grep из `missing.grep` в `sources.json`.
   - Если в разделе 17 ничего не осталось, раздел удалить.
6. **Обновить версии:** строку «Сверено…» (дата, коммит, ПК, Android, iOS) и раздел 2.
7. **Проверить форму:**
   - Объём 6–15 тыс. токенов, то есть примерно до 40 тыс. знаков. Быстрая оценка: `python -c "t=open('eblusha-app.md',encoding='utf-8').read(); print(len(t), int(len(t)/2.8))"`.
   - Без таблиц: бот перенимает разметку, а таблицы в ответах ему запрещены.
   - Без путей к коду.
   - Без служебных синонимов вроде `/eb` — людям их не подсказываем.
   - Без «я не умею / не помню»: что бот помнит, задаёт основной промпт, а не справочник.
8. **Доставить боту.** Файл вшит в образ бота (`bot/Dockerfile`, `COPY knowledge/eblusha-app.md`) и читается при старте: закоммитить, пересобрать образ и пересоздать контейнер — `docker compose -f deploy/docker-compose.full.yml --env-file .env --profile bot build eblusha-bot`, затем `… --profile bot up -d --no-deps --no-build --force-recreate eblusha-bot`. В журнале старта — `knowledge.loaded` (chars, approxTokens, checked = дата «Сверено…»); `knowledge.missing` — файла в образе нет.
9. **Проверить вживую** — только тестовыми учётками и в тестовой беседе, в настоящие беседы людей не писать. Задать 3–5 вопросов:
   - про новую функцию;
   - «как заглушить группу»;
   - «как обновиться на Android»;
   - «как сменить имя в вебе»;
   - про то, чего нет. Ожидаемый ответ — честное «пока нет / точно не знаю, спросите владельца».
10. **Отметить в памяти** (`eblusha-bot.md`): дата сверки, штамп, что поменялось.

## Мьют бесед — вышел (единый выпуск 2026-10-11)

Раздел «В работе» удалён, «Без звука» описан в разделе 10 для всех четырёх приложений, «Как приглушить сейчас» стал «Выключить всё сразу». В том же выпуске в раздел 13 добавлены таймер обещания, «поделиться перепиской», «Подумай лучше», память бота, привязка ников и летопись Valheim, в раздел 14 — окно ПК 2.0.11. При выкладке обновить номера Android и iPhone (шапка и раздел 2) — ПОСЛЕ публикации APK 0.3.42 и загрузки iOS-сборки, отдельным последним коммитом, и пересоздать бота (шаг 8). До этого бот отвечает про 0.3.41 и 995 — они и есть текущие, пока новых нет. Номер iOS-сборки закреплять `EBLUSHA_BUILD_NUMBER` (по умолчанию он равен числу коммитов, и любой коммит до сборки, в том числе этот, его сдвигает). Подробно — `docs/release-2026-10-11.md`.

## Строка для рецептов выпуска

Предлагаю добавить последним шагом в каждый рецепт выпуска:
- натив: `C:/projects/eblusha-winui/CLAUDE.md`, раздел выпуска, и «Рецепт выпуска натива» в памяти `eblusha-electron-to-native-migration.md`;
- сервер, веб, iOS: `/DATA/eblusha-plus/CLAUDE.md`;
- Android: шаги выпуска в памяти `eblusha-bot.md` и `eblusha-push-notifications.md`.

> **Справочник бота.** После выкладки любой платформы обновить `bot-knowledge/eblusha-app.md` и `sources.json` по `bot-knowledge/MAINTAIN.md`: версия и ссылка в разделе 2, новые и изменённые подписи на всех четырёх приложениях, вышедшее из «В работе» — в основные разделы. Затем дать боту перечитать справочник (пересоздать `eblusha-bot`) и задать 2–3 контрольных вопроса тестовой учёткой в тестовой беседе.
