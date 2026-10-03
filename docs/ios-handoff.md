# iOS-клиент Еблуши — справка для передачи дел

Состояние на 2026-10-02 (вечер). Последняя сборка в TestFlight — **930** (логотип «ЕБлуша»
с большой «Б» на экране установления и входа, коммит `1ee2367e`; VALID, IN_BETA_TESTING).
До неё — 924 (фирменный стиль экрана установления, §12, коммит `363b334f`), загружена
2026-10-01 20:05 после того, как владелец аккаунта принял новое соглашение Apple;
920 (миниатюра свёрнутого звонка, §11)
и 914 (коммит `da4fbe1c`). Грабли на будущее: `403 FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`
на загрузке и на любом запросе ASC API означает новое соглашение в App Store Connect →
Agreements, Tax, and Banking (принимает только владелец аккаунта); после принятия 403
держится ещё ~10 минут. Архив лежит на маке (`~/builds/eblusha-ios/build/archive/Eblusha.xcarchive`),
дозалить без пересборки — `scripts/ios-release.sh --upload-only`; дешёвый зонд — `~/builds/asc/asc-get.sh /v1/users`
на маке. Справку писал агент чата «EBLUSHA iPhone (stoned)», который вёл
порт с первого дня (2026-08-15). Всё ниже сверено с кодом и git на момент записи; если
что-то расходится с кодом — прав код.

---

## 0. Коротко

- Нативный клиент на SwiftUI (плюс UIKit там, где SwiftUI не справляется) лежит в `ios/`
  этого репозитория: ~122 файла, ~42,7 тыс. строк Swift. Bundle `org.eblusha.plus`,
  iOS 18+, только iPhone.
- **Эталон поведения и вида — веб** (`frontend/src/ui/pages/chats/`, там README с картой
  модулей). До 2026-09-10 эталоном был нативный Android.
- Xcode есть только на маке. Сборка: `scripts/ios-build.sh [sim|--install|--clean]`,
  релиз в TestFlight: `scripts/ios-release.sh`. Номер сборки = число коммитов в HEAD →
  **сначала коммит, потом релиз**.
- Правило пользователя: после каждой готовой порции iOS-правок — коммит, пуш и
  **TestFlight**. Исключение — задача прямо запрещает релиз или установку.
- Не проверено вживую: рукопожатие `eb.connect` и новый дозвон на экране установления
  звонка (§7.8). Это первое, что стоит проверить звонком.
- 2026-10-01: свёрнутый звонок — перетаскиваемая плитка-миниатюра 16:9 с говорящим (§11).
  Появился «пульт» симулятора `scripts/ios-drive.sh` (тапы, протяжки, ввод, скриншоты через
  XCUITest) — теперь экран можно гонять без человека (§3.5).

---

## 1. Решения пользователя и ориентиры

- 2026-08-15: v1 = паритет с **нативным Android**, затем оба клиента параллельно
  дотягиваются до веба. С 2026-09-10 эталон — **веб**, и оба клиента приводятся к нему.
- Источник правды Android — **не git**: `C:\projects\eblusha-mobile` на `winpc`
  (Kotlin/Compose, ~20 тыс. строк, пакет `org.eblusha.app`). Каталог `android/` в репо —
  старый прототип, по нему о возможностях Android судить нельзя. Локальная копия
  исходников для сверки: `tmp/eblusha-mobile-src/` (rsync с winpc, перед работой обновить).
- Push: APNs + PushKit/CallKit — сразу, в фундаменте. На iOS нет аналога
  foreground-сервиса Android, и без VoIP-пуша фоновых звонков не существует.
- UI: пользователь **отверг таб-бар** («три бабла внизу выглядят не очень») и карандаш
  «новая беседа» в панели. Фирменные элементы (плитки «Беседа/Контакты», анимированный
  wordmark) он ценит выше системных. Таб-бар не предлагать.
- Расшифровка голосовых — **только на устройстве** (Speech,
  `requiresOnDeviceRecognition = true`). Whisper на сервере отвергнут осознанно: бокс
  (4 ядра Ryzen 3 4300U) делит процессор с LiveKit, а секретные чаты сервер расшифровать
  не может в принципе.
- Фоторедактор свой: код Telegram не брать (GPL v2 заражает приложение и конфликтует с
  App Store), готовые MIT-библиотеки тоже (чужой интерфейс). У Telegram берём только
  поведение и числа (см. `docs/ios-telegram-behaviour-2026-09-11.md`).
- Язык общения с пользователем — русский. Комментарии в коде русские и объясняют
  «почему», а не «что».

---

## 2. Карта кода (`ios/`)

Каркас описан в `ios/project.yml` (XcodeGen). `.xcodeproj` генерируется на маке и в git
не хранится. Swift 5, `SWIFT_STRICT_CONCURRENCY: minimal`: переход на строгую
конкурентность Swift 6 — отдельная большая работа. SPM: LiveKit `client-sdk-swift` 2.16.0,
Socket.IO Swift 16.1.1.

**App/** — `EblushaApp` (в DEBUG есть вход в стенд `-connectDemo`), `PushAppDelegate`
(токены APNs), `RootView` (один `NavigationStack(path:)` с маршрутами `HomeRoute`, поверх
всего — `CallOverlay`; там же `SecretOutboxFlusher`).

**Core/**
- `App/` — жизненный цикл, `DraftStore` (черновики), `SecretOutbox` + `SecretOutboxFlusher`
  (очередь неотправленного в секретках на диске, досыл даже при закрытом чате).
- `Audio/VoiceRecorder` — запись голосовых.
- `Call/` — звонки: `CallManager` (главный, ~1300 строк), `CallModels` (фазы, причины
  конца), экран установления: `CallConnectModel` / `CallConnectWatcher` /
  `CallConnectController` (§7).
- `Config/AppConfig` — источник: eblusha.org или зеркало ru.eblusha.org. Выбирается в
  настройках, смена через выход из аккаунта.
- `Crypto/SecretCrypto` — криптография секретных чатов.
- `DI/AppContainer` — контейнер зависимостей (`AppContainer.shared.callManager` и т. д.).
- `Network/` — `APIClient` и DTO. PATCH живёт расширением в `ProfileRepository.swift`:
  второй такой же метод дал «ambiguous use».
- `Push/` — `CallKitController`, `VoIPPushHandler`, `PushRepository` (регистрация
  токенов), `MessageNotifications`.
- `Realtime/` — `RealtimeClient` (Socket.IO, порт Android один в один), `RealtimeEvents`,
  `CallStatusStore` (идущие звонки для списка и шапки).
- `Repository/` — `ChatRepository` (+ Forward/ReplyBundle/SecretMeta/Social/Uploads),
  `ContactsRepository`, `DevicesRepository`, `LiveKitRepository` (токен и E2EE-ключ
  звонка), `ProfileRepository`, `SecretRepository` (~1400 строк).
- `Session/` — `SessionStore`, `KeychainStore`, `SecretKeyStore`, `DeviceIdProvider`.
- `Speech/` — `VoiceTranscriber`, `TranscriptStore` (§5.6).
- `Util/`, `Result/ApiResult`, **Domain/** (модели чата и социалки).

**Features/**
- `Auth/` — вход и регистрация.
- `Call/` — `CallOverlay` (корень звонкового UI: полный экран ↔ плитка, анимации
  сворачивания/разворота), `CallMiniView` (плитка свёрнутого звонка: снимок состояния,
  размещение, магниты, язычок, память места), `CallView` (разговор), `IncomingCallView`,
  `CallConnectingView` (экран установления), `CallConnectingDemo` и `CallMiniDemo`
  (DEBUG-стенды).
- `Chat/` — список (`ChatListView/VM`), беседа (`ChatView`, `ChatViewModel` +
  `…Secret`/`…Jump`), лента `MessageListView` (UICollectionView, §5.3), композер
  (`ChatComposer`, `ComposerAttachments`, `ComposerFormatting`), вложения
  (`AttachmentAlbum`, `AttachmentSheet`, `AttachmentOpening`, `InlineVideoPlayer`),
  голосовые (`VoiceMessage`, `VoiceRecordGesture`), реакции (`ReactionChips`,
  `ReactionPicker`, `EmojiCatalogSource`), пересылка (`ForwardBundle`, `ForwardFlow`),
  меню и выбор сообщений (`MessageActionsOverlay/Sheet`, `MessageSelection`), цитаты
  (`ReplyQuoteCard`), `ChatMarkdown` (разбор с кэшем по строке), `ChatSounds`,
  `SecretChatCards`.
- `PhotoEditor/` — свой редактор (§5.7). `PhotoViewer/` — просмотрщик (§5.7).
- `Social/` — контакты, создание группы, участники группы, QR-сканер, настройки.
- `Presence/` — устройства и присутствие.

**Рядом с `Eblusha/`:** `EblushaUITests/DriveTests.swift` + `project-drive.yml` — «пульт»
симулятора (§3.5). В `project.yml` тестового таргета нет намеренно: под устройство ему
понадобился бы свой профиль подписи, а релиз и сборка идут по `project.yml`.

**UI/** — `Components/` (`Avatar`, `CachedImage`, `SwipeBack`, `UserProfileCard`),
`Theme/Palette` (`Eb.*`). **Resources/** — `Info.plist`, entitlements, ассеты,
`notify.caf`, `fluent-emoji-reactions.json` (каталог эмодзи из веба, 3145 записей,
обновляется с сервера).

---

## 3. Сборка, установка, релиз

### 3.1 Мак
- ssh-алиас `mac` (user `valentina`). Bonjour-имя `Mac.local`, DHCP-адрес плавает —
  жёсткий IP в конфиге протухает. Xcode 26.6, XcodeGen в `~/.local/bin`. Спарен iPhone 16
  Pro пользователя (iOS 26.6.x).
- На маке **bash 3.2**: пустые массивы под `set -u` ломаются.
- **Мак засыпает** (MacBook на батарее, крышка закрыта). Под caffeinate тоже. Рецепт:
  1. будить циклом, пока `ssh -o ConnectTimeout=3 -o BatchMode=yes mac true` не пройдёт:
     `wakeonlan -i 192.168.1.255 86:0f:ae:7e:9b:a5`, пауза 2 с;
  2. сразу держать фоном: `ssh mac 'caffeinate -dimsu -t 1500' &`;
  3. длинные удалённые работы гнать **одной** ssh-сессией:
     `ssh mac 'caffeinate -dimsu bash -s' <<'EOF' … EOF`. Если мак уснёт между сессиями,
     rsync падает с кодом 255.
  4. 2026-10-02: на батарее с закрытой крышкой мак уходит в «Maintenance Sleep» и под
     caffeinate (видно в `pmset -g log`), ssh рвётся с «Timeout, server mac.local not
     responding». Помогает фоновая петля на боксе на время работы: `wakeonlan …` раз в 5 с.
     Если `ios-release.sh` оборвался на архиве — xcodebuild на маке доживает и кладёт архив
     в `build/archive/`, но экспорт уже не запускается; тогда `--upload-only`.

### 3.2 Сборка — `scripts/ios-build.sh`
- Заливает `ios/` rsync'ом на мак (`~/builds/eblusha-ios`), генерирует проект, собирает.
  Назад ничего не возвращается.
- `sim` — под симулятор, без подписи, быстрее всего. Проверка сборки — только так.
- без аргументов — под устройство; `--install` — собрать и поставить на телефон;
  `--clean` — с нуля.
- Лог фильтруется по `error:` (раньше `tail -40` прятал саму ошибку).
- Под симулятор `.app` лежит в
  `~/builds/eblusha-ios/build/Build/Products/Debug-iphonesimulator/Eblusha.app`.

### 3.3 Подпись — через `build.keychain`, НЕ login
login-связка на macOS 26 для ssh-сессии заперта наглухо: codesign отдаёт
`errSecInternalComponent`, security — «User interaction is not allowed». Разблокировка в
GUI и `set-key-partition-list` не помогают, у ssh своя security-сессия. **Не тратить на это
время и не просить у пользователя пароль.** Рабочая схема (уже в скриптах):
- отдельная `~/Library/Keychains/build.keychain-db` с ключом «Apple Development: Created
  via API», пароль в `~/.keys/build-keychain-pass`;
- профили Xcode создаёт сам по ASC API-ключу `~/.appstoreconnect/private_keys/AuthKey_N433G64327.p8`
  (KID `N433G64327`, ISS `16defce3-2569-44b9-ab9f-e22fcfb630e2`), `-allowProvisioningUpdates`;
- team `4748P9MT6D`. Схема взята из `~/builds/huila-apple/build-signed.sh` (там же
  собирается «Еблуша VPN», `com.eblusha.huila`).

### 3.4 Релиз — `scripts/ios-release.sh`
- archive Release → экспорт `app-store-connect` с загрузкой по ASC-ключу.
  `--no-upload` — только архив и .ipa, `--upload-only` — догрузить готовый архив.
- Номер сборки: `EBLUSHA_BUILD_NUMBER`, по умолчанию `git rev-list --count HEAD`.
  **Незакоммиченное не меняет номер** — дубль отвергается (так пропала сборка 835).
- Приложение в ASC: «Eblusha», app id `6809898824`, SKU `eblusha`, версия 1.0.
  Внутренняя группа «Внутренние» (id `0d23cc04-b1b6-4617-8c66-dba4caef763c`,
  `hasAccessToAllBuilds`) — новые сборки доступны тестеру сами. Тестер — сам
  пользователь (ADMIN в ASC).
- Предупреждения «Upload Symbols Failed … LiveKitWebRTC / RustLiveKitUniFFI» безвредны:
  это бинарные фреймворки без dSYM.
- `ITSAppUsesNonExemptEncryption = false` в Info.plist, поэтому «Missing Compliance» не
  возникает.
- Обработка в ASC занимает 2–5 минут (914 обработалась за ~2). Проверка на маке:
  ```
  ~/builds/asc/asc-get.sh "/v1/builds?filter%5Bapp%5D=6809898824&sort=-uploadedDate&limit=3&fields%5Bbuilds%5D=version,processingState,uploadedDate"
  ~/builds/asc/asc-get.sh "/v1/builds?filter%5Bapp%5D=6809898824&filter%5Bversion%5D=914&include=buildBetaDetail"
  ```
  Готово, когда `processingState = VALID` и `internalBuildState = IN_BETA_TESTING`. JWT
  ES256 скрипт подписывает через openssl и python3 stdlib: PyJWT и cryptography на маке нет.
- Мак один: установку на телефон и релиз запускать по очереди, не параллельно.

### 3.5 Проверка без человека
- Устройство: логов нет (`log stream --device-name` в macOS 26 убран), скриншот снять
  нечем (idevicescreenshot/cfgutil не стоят), GUI-автоматизации нет (osascript без
  Accessibility). **Поведение на телефоне проверяет только пользователь.**
- Симулятор (UDID `2A9441D5-50FF-4F38-9D37-53C1EA5E567E`) + DEBUG-стенд экрана
  установления звонка:
  ```
  xcrun simctl install <UDID> <путь к Eblusha.app>
  xcrun simctl launch <UDID> org.eblusha.plus -connectDemo cf-wait
  sleep 3.5   # иначе после холодного запуска кадр пустой
  xcrun simctl io <UDID> screenshot ~/builds/shot.png
  ```
  Сценарии стенда: `ringing answered signaling keys route cf-e2ee cf-publish cf-wait
  cf-joining own direct switch group-empty group muted longname mic-unavailable
  connect-error sync error done` (те же id, что у веб-стенда `/__dev/call-connecting`),
  плюс `key-error` — «звонок не начат» из-за ключа шифрования, с «Повторить».
  Суффикс `-video` у любого сценария (`ringing-video`) — капсула «Видеозвонок»; у сценариев
  с `ringingSeconds` стенд подставляет `ringStartedAt`, так что секундомер шапки и «· m:ss»
  подзаголовка идут от одного момента. Первый запуск после `simctl install` бывает холодным:
  кадр через 3,5 с пустой (один фон) — повторный запуск сценария это лечит.
  Стенд миниатюры тем же аргументом: `mini` (1:1, собеседник говорит), `mini-silent`,
  `mini-group` («Пока никого»), `mini-reconnect`, `mini-two` (говорит второй — плитка
  переключится через 500 мс). Тап по плитке разворачивает условную панель, её «Свернуть»
  сворачивает обратно — так видно обе анимации. Место плитки запоминается в UserDefaults
  (`eb.call.mini`); сбросить: `xcrun simctl spawn <UDID> defaults delete org.eblusha.plus eb.call.mini`.

### 3.6 «Пульт» симулятора — `scripts/ios-drive.sh` (2026-10-01)
На маке нет ни idb, ни cliclick, а `simctl` не умеет ни тапать, ни тянуть. Поэтому
взаимодействие идёт через XCUITest-раннер `EblushaUITests` (спека `ios/project-drive.yml`
поверх `project.yml`, схема `EblushaDrive`): единственный тест читает сценарий из окружения
и выполняет шаги. Язык шагов — в шапке `ios/EblushaUITests/DriveTests.swift`:
`launch[:аргументы]`, `activate`, `sleep:с`, `shot:имя`, `dump:имя` (дерево доступности —
искать подписи), `tap:x,y`, `tapText:`, `tapButton:`, `tapAny:`, `tapField:N`, `tapSecure:N`,
`type:`, `typeEnv:ПЕРЕМЕННАЯ`, `drag:x1,y1,x2,y2`, `dragHold:x1,y1,x2,y2,с,имя`, `wait:текст|с`.
Координаты в pt (iPhone 17 Pro: 402×874). Скриншоты и `drive.log` — на маке в `~/builds/shots/`.

```
scripts/ios-drive.sh 'launch:-connectDemo mini; sleep:3; shot:mini; drag:301,165,150,450; sleep:1; shot:moved'
EB_PASS=… EBLUSHA_DRIVE_ENV=EB_PASS scripts/ios-drive.sh 'launch; sleep:4; tapField:0; type:sss; tapSecure:0; typeEnv:EB_PASS; tapButton:Войти; …'
```

Грабли:
- пароль — только через `typeEnv` из переменной окружения (в файлы и в сценарий не писать);
- каждый запуск `xcodebuild test` переустанавливает приложение, и **сессия не переживает
  запуск**: вход и всё, что нужно после входа, — в одном сценарии;
- **звонок на симуляторе с микрофоном роняет приложение**: LiveKit поднимает AVAudioEngine
  → `AURemoteIO::Initialize` → RPC-таймаут AudioToolbox → SIGABRT (это симулятор, не код).
  Перед звонком отозвать микрофон: `xcrun simctl privacy <UDID> revoke microphone org.eblusha.plus`
  — экран установления честно покажет «Микрофон недоступен», звонок пойдёт без него;
- скриншот в `dragHold` снимается из фонового потока на половине выдержки, а XCUITest
  перед жестом ждёт «тишины» приложения (пульсирующее кольцо говорящего — это анимация),
  так что момент удержания ловится не всегда; проверка по конечному положению надёжнее;
- видео: `xcrun simctl io <UDID> recordVideo --codec h264 -f файл.mp4` в фоне, `kill -INT`
  по окончании; кадры удобно смотреть на боксе через `ffmpeg -vf "fps=20,scale=180:-1,tile=10x5"`.

---

## 4. Бэкенд, сделанный под iOS

- APNs: `src/push/apns.ts` (HTTP/2, ретраи, keep-alive), `src/push/index.ts`,
  `src/routes/devices.ts` (VoIP-токен устройства), миграция
  `prisma/migrations/20260815200000_device_voip_push_token`. Настройка — `docs/apns-setup.md`,
  установка ключа — `scripts/apns-install-key.sh`.
- Ключ APNs `M64RYD2F6S` («Sandbox & Production»). base64 лежит в `.env` (`APNS_KEY`),
  копия в `secrets/`, на маке — `~/.keys/apns/`. `APNS_ENV=auto`: основной хост
  production, запасной sandbox. В entitlements `aps-environment = development`, экспорт в
  App Store переписывает его на production. ASC API-ключ для APNs **не годится** (403
  InvalidProviderToken).
- Попутно найдено 2026-09-08: пуши о сообщениях вообще не ставились в очередь (BullMQ
  отвергал `jobId` с двоеточием). До этой даты уведомлений о сообщениях не было и на
  Android.
- **`npx prisma migrate dev` на этом проекте хочет сбросить боевую базу.** Миграции писать
  руками в `prisma/migrations/`, катить `migrate deploy` (он в `docker-entrypoint.sh`).
- Пересборка бэка — по `CLAUDE.md` (docker compose `build backend worker maintenance` +
  `up -d`).

---

## 5. Подсистемы: инварианты и уроки

### 5.1 Реалтайм (`RealtimeClient`)
- Порт Android. События `call:*` идут через очередь.
- Ротация токена **одна на всех** (`sharedRefresh`, коммит `d8afae67`). Раньше
  `connect()` и `onAuthError()` обновляли токен независимо, и разбуженный VoIP-пушем
  телефон слал два bootstrap подряд: второй сносил только что поднятый сокет. Перед
  пересборкой проверяется, не поднят ли сокет уже с этим токеном. Смена device-id
  пересобирает принудительно: его везёт рукопожатие.

### 5.2 Звонки (`CallManager`, CallKit, PushKit)
- Фазы: `idle → incoming | outgoing → connecting → inCall`. `isActive` = connecting/inCall.
- **Исходящий:** `startOutgoing(conversationId:title:video:isGroup:)`. Комната
  подключается **ещё на дозвоне**: `connectRoom` сразу, микрофон публикуется до ответа,
  аудиосессия поднимается на дозвоне. 1:1 честно ждёт `call:accepted`
  (`onAccepted` → `.inCall`, или `.connecting`, если комнаты ещё нет). У групп
  `call:accepted` никто не шлёт: `promoteGroupOutgoingToActive` переводит в разговор, когда
  комната подключилась.
- Шифрование 1:1: ключ даёт сервер (`LiveKitRepository.fetchE2eeKey`) — это шифрование
  **через сервер**, не сквозное, и так оно подписано (щит «Шифрование через сервер»,
  не замок). Группы не шифруются (подпись «Без шифрования»), шифровать их будем в 2.0.
  Группа или нет, решает то, что клиент сам знает о беседе (`knownGroup`: кеш бесед,
  иначе подсказка экрана беседы, иначе «личная»), а не ответ ручки ключа.
  ⛔ Открытого личного звонка не бывает (этап 0 ТЗ звонков, 2026-10-03): любой сбой ключа
  (сеть, 403/404/5xx, неверная длина) → `failEncryption`: комнату не собираем, микрофон не
  публикуем, `call:end` собеседнику, CallKit закрывается `reportCall(.failed)` (не
  `CXEndCallAction` — тот ушёл бы серверу отказом), на экране «Не удалось включить
  шифрование — звонок не начат» с «Повторить» (новый исходящий) и «Закрыть».
  Интероп с вебом держится на PBKDF2 от **строки** (подробности в комментарии к
  `encryptedRoomOptions`). Если на вебе ключ уйдёт в `setKey` буфером, будет HKDF, разные
  ключи и DECRYPTIONFAILED.
- CallKit (`CallKitController`): исходящий докладывается по фазе `.outgoing`. Входящий по
  сокету тоже идёт в CallKit. LiveKit-движок включается в `didActivate`. Переписано по
  итогам ревью 2026-09-08 (`80a2d055`); пользователь проверил на телефоне звонок на
  заблокированный экран, ответ с локскрина и отбой.
- `CXEndCallAction` на входящем раньше всегда считался красной кнопкой и слал
  `call:decline`, то есть отбой для обеих сторон и «Пропущенный звонок» в беседе. Теперь
  отказ уходит, только если звонок реально показан (`callDidAppear`), репорт не в полёте и
  провайдер не сбрасывался (`providerWasReset`). Иначе — `dismissIncoming()` без сигнала
  серверу. Реализован `provider(_:timedOutPerforming:)`. Происхождение действия iOS
  достоверно не сообщает, идеальной развязки нет.
- Рингтон входящего (`CallRinger`) ищет в бандле `incoming_call.{caf,m4a,mp3,wav}`. Файла
  нет — остаётся вибрация. **Гудка дозвона у iOS нет** (CallKit его тоже не играет).
- `eb.ping` (RTT собеседникам) заработал только 2026-09-29: SDK по умолчанию не собирает
  статистику дорожки (`Track.set(reportStatistics:)` = false), её включили ради экрана
  установления.

### 5.3 Лента чата (`MessageListView`)
- **SwiftUI ScrollView + LazyVStack для ленты непригоден**: нет детерминированной позиции
  и вклейки истории без рывка, две недели правок результата не дали. Лента —
  **UICollectionView** с diffable-источником, ячейки — SwiftUI через
  `UIHostingConfiguration`. Прокрутку и вставку истории считает арифметика
  `contentOffset/contentSize`.
- Маркер в 1 pt с `onAppear` как признак «мы у низа» в LazyVStack врёт: это
  материализация, а не видимость.
- **Любую цель прокрутки, посчитанную до материализации ячеек, перепроверять после.**
  Одноразовый `setContentOffset` здесь всегда врёт: ячейки ниже экрана не измерены.
  Кнопка «вниз» открывает окно до-прижатия (`armStickToBottom`) и доводит позицию через
  0,35 с после анимации, сверяясь с настоящим `bottomOffset` (не `isAtBottom`: у него
  порог 80 pt).
- «Текст под клавиатурой»: флаг «мы внизу» обновляется на каждый сдвиг позиции
  (`updatePosition()`) плюс прямая реакция на `keyboardWillChangeFrame`. Уведомление
  приходит ДО сжатия вьюпорта, и это единственный достоверный момент.
- Долгое нажатие — `UILongPressGestureRecognizer` на коллекции. SwiftUI
  `onTapGesture`/`onLongPressGesture` в ячейках перехватывали касания. Двойной тап —
  быстрая реакция.
- Свайп-ответ живёт на коллекции (пороги Telegram: тянется до 80 pt, срабатывает после 45),
  по коммиту `c4fff5f3` — влево у всех сообщений. «Назад» — свайп вправо из любой точки
  (`SwipeBack.swift`), кромку 24 pt уступает системному pop.

### 5.4 Оболочка
Корень — один `NavigationStack(path:)` (`RootView`). Список чатов — свой экран: брендовая
шапка, `List` со свайпами, contextMenu и pull-to-refresh, внизу плитки «Беседа/Контакты» и
строка профиля с пилюлей версии; панель навигации скрыта. Остальные экраны — родные панели,
`.searchable`, штатная «назад». Контакты и беседы — карточками на серой поверхности, как в
вебе.

### 5.5 Секретные чаты
`SecretRepository`, `SecretCrypto`, `ChatViewModelSecret`, `SecretChatCards`. Очередь
неотправленного на диске (`SecretOutbox`), досыл — `SecretOutboxFlusher` в `RootView`.
Секретное аудио и вложения расшифровываются ключом треда.

### 5.6 Голосовые и расшифровка
- Воспроизведение вынесено из ячейки в общий `VoicePlaybackCenter`: `@StateObject` в
  ячейке обрывал звук при прокрутке, а переиспользование ячейки путало соседние
  сообщения. Позиция — в отдельных часах `VoicePlaybackClock`, иначе тик 20 раз в
  секунду перерисовывал все видимые голосовые. Перемотка тапом по волне
  (`SpatialTapGesture`), протяжка только у активного пузыря. Скорость 1×/1,5×/2×
  (`defaultRate` + `audioTimePitchAlgorithm = .timeDomain`, выбор в UserDefaults).
- Расшифровка: `VoiceTranscriber`, пилюля «Аа» в пузыре. Кэш `TranscriptStore`: AES-GCM,
  ключ в Keychain, `.completeFileProtection`, срок 7 дней, стирается при выходе.
  Две грабли:
  1. `recognitionTask` и распознаватель **надо удерживать** (`RecognitionSession`), иначе
     ARC убивает их сразу и любой файл даёт «не удалось разобрать речь». Ошибки движка не
     сводить к общей фразе: логов с устройства нет, диагноз — только по тексту в UI.
  2. Файлы хранилища называются `<ключ>.eblusha`. Расширение есть, но AVFoundation его не
     знает (-11828). Неизвестное расширение заменять выведенным из mime
     (`playableAudioURL`).
- Отзыв пользователя о качестве расшифровки: «работает, но плохо». Что именно плохо, не
  выяснено.

### 5.7 Фото
- Редактор (`PhotoEditor/`): слои (штрихи, размытие, текст, стикеры) хранятся в
  нормализованных координатах **исходного** кадра, обрезка — в координатах показанного
  (повёрнутого) кадра и пересчитывается при повороте. `EditGeometry` переводит
  экран↔кадр. Рендер общий для превью и экспорта (`PhotoEditorRenderer`). Фото из
  скрепки → редактор → кнопка сразу отправляет; тап по чипу в очереди — правка.
- Просмотрщик (`PhotoViewer/`): жесты на UIKit (`UIPageViewController` с зазором 20,
  `ZoomableImageView` на UIScrollView, свайп-закрытие `UIPanGestureRecognizer`), хром —
  SwiftUI (`PhotoViewerView`), мост — `PhotoViewerProxy`. Открывается `fullScreenCover`
  с прозрачным фоном без анимации перехода. Кадр вырастает из плитки чата и улетает в её
  **актуальную** рамку (`MessageListProxy.tileFrameInWindow`). Полноразмерные картинки
  даунсэмплятся ImageIO до ≤4096 px.

### 5.8 Паритет с вебом (2026-09-11)
`docs/ios-web-parity-2026-09-11.md` (+ `.json` с деталями): 45 подтверждённых расхождений,
закрыты семью порциями (`13178284 → bbbd94f6`). Поведение из Telegram —
`docs/ios-telegram-behaviour-2026-09-11.md` (принято 31 из 36).

---

## 6. SwiftUI-грабли, найденные здесь

- `.id(text)` + `.transition` **внутри VStack** держит старую и новую строку в раскладке на
  время перехода, и панель прыгает по высоте. Меняющиеся строки класть каждую в свой ZStack
  (так сделан заголовок экрана установления).
- Внутри `ScrollView` жадный `Spacer` или гибкие дети растягивают панель на высоту экрана.
  Панели — `.fixedSize(horizontal: false, vertical: true)`, центрирование через
  `.frame(minHeight: geo.size.height)`.
- Карточки одной строки одинаковой высоты: `Grid`/`GridRow` + `maxHeight: .infinity`, а не
  `LazyVGrid`.
- `@Published`-издатель шлёт значение в `willSet`: в подписчике само свойство ещё старое.
  Нужное значение брать из параметра.

---

## 7. Экран установления звонка (последняя работа, 2026-09-29)

### 7.1 Что и откуда
Порт веб-экрана по спеке `docs/call-connecting-screen.md`. Эталон:
`frontend/src/ui/components/callConnectView.ts` (модель и темп — **один в один**),
`CallOverlay.tsx` → `ConnectProgressWatcher` (сигналы, готовность собеседника,
рукопожатие, таймауты), `CallConnecting.tsx` + `callConnecting.css` (дизайн
«вариант 2»), стенд `frontend/src/ui/dev/CallConnectingDemo.tsx`.

⚠️ На 2026-09-30 спека и веб-эталон **не закоммичены**: это работа другой сессии. От
своего имени их не коммитить.

Коммиты iOS: `df88c5f2` (порт), `1536c903` (уход из комнаты при неподтверждённом
шифровании собеседника), `da4fbe1c` (экран с момента набора, вместо «Звоним…»).

### 7.2 Требования пользователя (жёсткие)
1. Ни один этап или факт не показывается раньше реальности, ничего по таймерам,
   соединение не задерживается.
2. Темп показа ≈3 с: `dwell = max(400, round(3000/(N+1)))` мс на ступень. Заключительная
   пауза — тоже ступень, откат реальности — сразу.
3. Рукопожатие по data-каналу LiveKit: reliable, topic `eb.connect`, JSON
   `{"v":1,"state":"connecting"|"settled","audio":bool}`. Разговор открывается у обоих
   разом; телефон, который не шлёт сигнал, веб не блокирует.
4. Не переписывать сигналинг, E2EE, выбор маршрута и существующие пути завершения.
   Никакой параллельной машины состояний, управляющей звонком. Без новых зависимостей.
5. Дозвон (второй заход): экран появляется в момент набора — один оверлей вместо
   «Звоним…» + экрана установления. Ступень `ring` «Ждём ответа» первая. Заголовок
   «Звоним…», подзаголовок «Ждём ответа собеседника · m:ss». Узел собеседника `ringing`:
   цветной аватар и три кольца со сдвигом 0 / 0,13 / 0,30 периода, период 2 с. Если есть
   свой гудок — период и фаза по нему. После ответа — ✓, «Собеседник ответил», дальше
   этапы в темпе. Группы дозвона не имеют. Отказ и таймаут — существующие пути. CallKit
   не трогать.

### 7.3 Файлы и роли
- `Core/Call/CallConnectModel.swift` — `buildConnectView`, `withPeerSync`,
  `ConnectPacing` (`milestoneFlags`, `applyPacing`, `dwellMs`). Чистые функции, без
  SwiftUI и LiveKit. `nonEmpty()` воспроизводит JS-ложность пустой строки,
  `connectJsRound` — `Math.round`.
- `Core/Call/CallConnectWatcher.swift` — делегат комнаты (`room.add(delegate:)`) и дорожки:
  - собеседники: `heard` = есть подписанная аудиодорожка и (если шифрованный звонок) все
    публикации с `encryptionType != .none`, аналог `participant.isEncrypted` веба;
  - сроки как на вебе: 8000 / 1500 / 5000 / 15000 мс, дедлайны +20 мс;
  - рукопожатие: «connecting» — только при `.connected`, при подключении и при входе
    участника. «settled» — при переходе локальной готовности false→true, если комната не
    `.disconnected`. Ответ каждому identity один раз, адресно. Принимается topic
    `eb.connect` или пустой topic с валидным state. Отправитель по умолчанию —
    единственный участник. `audio` проверяется строго как булево;
  - путь: из `TrackStatistics` микрофона. Пара берётся по
    `transportStats.selectedCandidatePairId`, иначе succeeded/nominated. id кандидатов
    сверяются с парой: SDK отдаёт только первый local/remote кандидат.
    Не подтвердилось — «напрямую/через ретранслятор» не называется;
  - E2EE: `didUpdateE2EEState` `.ok/.key_ratcheted` на своей публикации →
    `localEncryptionOk`, на чужой → `remoteDecryptionOk`.
- `Core/Call/CallConnectController.swift` — склейка, **только показ**:
  - подписки на `$phase`/`$micOn`, темп, `withPeerSync`, защёлка «разговор начался» →
    растворение 220 мс (0 при Reduce Motion) → `watcher.detach()`;
  - `encrypted = !isGroup && (roomEncrypted ?? true)`;
    `e2eeEnabled = localEncryptionOk || (micUnavailable && remoteDecryptionOk)`;
  - дозвон: `dialing`/`hadDial`, `ringing = isGroup ? nil : (dialing ? true : (hadDial ? false : nil))`,
    `ringStartedAt` (монотонные мс — фаза колец), таймер раз в секунду ровно на границе
    секунды от начала вызова.
- `Core/Call/CallManager.swift` — хуки там, где события реально случаются:
  - `connect.outgoingStarting(isGroup:title:)` до `phase = .outgoing`. Признак группы
    приходит из открытой беседы: кеш бесед асинхронный, а словари `ChatRepository`
    пишутся вне главного потока, синхронно их читать нельзя;
  - `configure(...)` — отдельной задачей из кеша бесед, параллельно с токеном;
    `tokenReceived()`, `roomCreated(_:encrypted:)`, `roomConnected()`,
    `markMicUnavailable()`;
  - `failConnect`: на активном звонке — `disconnectRoom()` + экран «Не удалось
    подключиться», закрытие обычным `hangUp`. На дозвоне — `endLocally()`, как было;
  - `onPeerEncryptionFailure`: собеседник 15 с не подтверждает шифрование → уходим из
    комнаты (`disconnectRoom`), как веб (`cleanupE2eeResources`). Звонок закрывает
    человек кнопкой «Закрыть».
- `Features/Call/CallConnectingView.swift` — фирменный стиль Еблуши (2026-10-01, §12),
  раскладка узкого контейнера веба (≤ 480 px): янтарная шапка с логотипом и капсулами,
  заголовок, цепочка узлов (узел 52, обёртка сжимается до ≥64, чтобы 4 узла влезли),
  карточки этапов в `Grid` 2×N (активная — янтарная в полоску, `AmberStripes` на Canvas),
  подсказка по тапу, «Сбросить» (дозвон, красная) / «Отменить», ошибка «Закрыть». Кольца
  дозвона — `RingWaves` (TimelineView, keyframes `eb-cn-ring`: масштаб 1→1,9, прозрачность
  0,75→0 за 55 % периода, CSS ease-out через бисекцию cubic-bezier).
- `Features/Call/CallConnectingDemo.swift` — DEBUG-стенд (§3.5).
- `Features/Call/CallOverlay.swift` — ветка `.outgoing, .connecting, .inCall` общая, чтобы
  экран не пересоздавался в момент ответа. `CallView` монтируется только после ответа.
  `RingingView` удалён.

### 7.4 Намеренные отличия от веба
- Подсказка про микрофон: «Проверьте разрешения **в настройках**» вместо «…браузера».
- «Шифрование включено» = отчёт шифратора своей дорожки: события «включено для
  участника», как на вебе, в iOS-SDK нет. Без микрофона подтверждает расшифрованная чужая
  дорожка.
- Сервер не дал ключ для 1:1 → звонок не начинается: экран «Не удалось включить
  шифрование — звонок не начат» с «Повторить» и «Закрыть» (раньше звонок молча шёл без
  шифрования).
- Маршрут не подтверждён статистикой → факта «напрямую/ретранслятор» нет.
- Этапа «Меняем маршрут» нет: отката маршрутов, как на вебе (`callRouting.ts`), у iOS нет;
  `routeSwitching` всегда false.
- Узлы сжимаются под ширину телефона: на вебе ряд вылезает на ~16 px.
- Капсулы фактов в шапке переносятся под строку логотипа (как `≤ 689 px` на вебе), подпись
  «Звонок · Имя» скрыта (как `≤ 480 px`). Волн за цепочкой нет — их нет и в фирменном
  веб-эталоне.
- Гудка нет: период колец 2 с, фаза от начала вызова.

### 7.5 Сверка модели — дифференциальный тест
Как повторить после правок веб-эталона:
1. Скопировать `callConnectView.ts` во временную папку, удалить строку импорта React,
   добавить `export` к `milestoneFlags` и `leadingTrue`.
2. Скрипт на TS (Node 22, `node --experimental-strip-types`) генерирует N случайных
   состояний ConnectSignals с фиксированным seed. Сюда входят `ringing`
   (нет/true/false) и `ringingSeconds` (нет/null/целые), плюс `peerSettled`. Для каждого
   состояния пишутся `milestoneFlags`, `leadingTrue`, dwell, `buildConnectView(s)`,
   `…withPeerSync…` и виды с темпом (`applyPacing`) для `shown = 0…total+2` в
   `cases.json` и `web.json`.
3. На маке `xcrun swiftc -O -o parity CallConnectModel.swift main.swift`, где `main.swift`
   читает `cases.json` и считает то же самое Swift-функциями. **Без
   `-parse-as-library`**: у `main.swift` код верхнего уровня.
4. Сравнить JSON как словари. Ожидаемые расхождения — только подсказка
   «браузера» → «в настройках»; её заменить перед сравнением.

Результат 2026-09-29: 3000 состояний, 30 952 вида (17 838 со ступенью «Ждём ответа»,
9 582 с узлом `ringing`, 15 разных заголовков) — **0 расхождений**.

### 7.6 Побочные эффекты
- Включён `reportStatistics` у микрофонной дорожки → заработал `eb.ping`.
- Сбой пропуска или подключения на **активном** звонке теперь показывает ошибку, а не
  молча завершает звонок.

### 7.7 Что проверено
Сборка под симулятор; скриншоты всех сценариев стенда (включая `ringing`, `answered`,
группы, ошибки, длинные имена); дифференциальный тест модели. **Настоящих звонков не было**
(пользователь запретил в задаче).

### 7.8 Что проверить первым делом (нужен человек)
1. iPhone → веб, 1:1: пока идёт дозвон — «Звоним…», кольца, таймер. После ответа ✓ и
   «Собеседник ответил», каскад этапов, **разговор открывается у обоих одновременно**
   (рукопожатие `eb.connect`).
2. Веб → iPhone (входящий): экран без ступени «Ждём ответа», то же одновременное открытие.
3. Групповой звонок с iPhone: без дозвона, пустая группа → «вы первые».
4. Отмена на дозвоне, отказ собеседника, таймаут: экран просто уходит.

---

## 8. Открытые вопросы и хвосты

Ждут решения пользователя (без его слова не делать):
- «Мягкий» отказ на сервере: у `call:decline` различать источник (человек или система).
  Это правка сервера.
- Дедупликация синхронизации push-токенов (лишние регистрации, мелочь).
- Предпроверка в `ios-release.sh`, что номер сборки ещё не занят в ASC.
- 2026-10-01: ASC API целиком отвечал `403 FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`
  — владелец принял соглашение в App Store Connect, архив 924 дозалит
  (`scripts/ios-release.sh --upload-only`, см. §0). Закрыто.
- Что конкретно «плохо» в расшифровке голосовых.

Не сделано или стоит иметь в виду:
- Локальный кэш сообщений: беседа всегда открывается спиннером. С Android не портирован.
- Рингтон входящего — файла `incoming_call.*` в бандле нет, только вибрация.
- Гудка дозвона нет. Если его добавить, кольца экрана установления надо синхронизировать
  с его периодом и стартом (`ringStartedAt`, `ringPeriodMs` у `CallConnectingView`).
- Android-трек (довести Android до веба) — отдельная работа, источник на winpc.

---

## 9. Как работать в этом репозитории

- `CLAUDE.md`: после любой правки — пересобрать то, что менялось, **закоммитить и
  запушить** без вопросов. Трейлер коммита: `Co-Authored-By: Claude Opus 4.8
  <noreply@anthropic.com>`. Секреты и `*.bak` не коммитить. `frontend/public/{s,v,w}/*.json`
  постоянно «изменены» — это шум, в коммиты не брать.
- Для iOS «пересобрать» = `scripts/ios-build.sh sim` (проверка), затем **TestFlight**
  (`scripts/ios-release.sh`) после коммита. Напрямую на телефон (`--install`) ставить, только
  когда просят.
- **Рабочее дерево общее**: в этом же checkout коммитят другие сессии (Valheim `/v/`, Cloud,
  VPN, игра, инфраструктура). Текущая ветка — `platform/core-redis-queue-ssrf-rateobs`
  (с upstream на origin), коммиты идут в неё. Всегда `git add <явные пути>`, чужие
  изменённые и неотслеживаемые файлы не трогать и не коммитить.
- В auto-mode `rm` с раскрытием переменной блокируется: использовать литеральные пути или
  `"${VAR:?}"`.
- Пользователь мыслит «один проект — один чат». Жалоба «не подключается / не могу
  продолжить» — это просьба починить доступ, а не заказ работы в этом чате.
- Память проекта: `~/.claude/projects/-DATA-eblusha-plus/memory/` — `ios-port-project.md`
  (подробная хроника), `ios-always-testflight.md`, `android-source-of-truth.md`,
  `infra-ssh-hosts.md`.

## 10. Аккаунты и идентификаторы

- Тестовый аккаунт: `sss` (профиль «Казёл»). **Пароль в репозиторий не кладём** — спросить
  у пользователя.
- Аккаунт пользователя на его iPhone — `ston`.
- Bundle `org.eblusha.plus`, team `4748P9MT6D`, ASC app `6809898824`, ASC API-ключ
  `N433G64327`, ключ APNs `M64RYD2F6S`. Это идентификаторы, не секреты: сами ключи лежат
  на маке и в `.env`/`secrets/`.
- Хосты: `mac` (сборка), `winpc` (Android-исходники; Windows, вывод в cp866),
  `eblusha-ru` (зеркало ru.eblusha.org). Прод — сам этот бокс (eblusha.org).

---

## 11. Миниатюра свёрнутого звонка (2026-10-01)

Порт веб-`CallMini.tsx` + `callMini.css` по спеке `docs/call-mini.md` (общей для веба,
Android и iOS). Плашка «Идёт звонок» у верхнего края заменена плиткой 16:9 поверх всего
приложения; интерактивное вытягивание оверлея из плашки (progress-жест) убрано вместе с ней.

### 11.1 Файлы и роли
- `Features/Call/CallMiniView.swift` — плитка. `CallMiniSnapshot` — снимок значений
  (участники, говорящие, микрофон, камера, группа ли, E2EE, момент соединения,
  переподключение): плитке всё равно, откуда они, поэтому стенд собирает снимок без комнаты.
  `CallMiniPlacement` (`corner | free(fx, fy) | tongue(side, y)`) с ручным Codable — JSON
  тот же, что у веба в localStorage; `CallMiniPlacementStore` — UserDefaults `eb.call.mini`.
  `CallMiniGeometry` — чистые функции: размер плитки (≈44 % короткой стороны, 150–220 pt),
  углы (отступ 12, TOP_GUARD = safe area + навбар 44, BOTTOM_GUARD = safe area + композер 72),
  границы протяжки (за край до 60 % ширины), магнит 56, `drop(at:)` (язычок при ≥25 % за
  краем, угол в радиусе магнита, иначе свободное место долями).
- `Features/Call/CallOverlay.swift` — корень: полный экран, пока не свёрнуто; плитка —
  только для `.inCall` при `minimized`. Сворачивание: `manager.minimize()` сразу, плитка
  прилетает из прямоугольника панели (`flyFrom`, translate+scale, прозрачность .4→1,
  320 мс, cubic-bezier(.2,.8,.2,1)). Разворот: тап по плитке отдаёт её прямоугольник
  (`expandFrom`), панель стартует из него (scaleEffect+offset, тот же темп). Разворот кнопкой
  из шапки беседы — без FLIP (прямоугольник неизвестен). Экран установления снова виден
  (ошибка) в свёрнутом состоянии → разворачиваем: ошибки всегда во весь экран.
- `Core/Call/CallManager.swift` — новое: `isGroup` (из открытой беседы/кеша), `reconnecting`
  (`room(_:didUpdateConnectionState:from:)`), `activeSpeakerIds` (порядок SDK, громкий
  первым), `canMinimize = phase == .inCall && !connect.visible` — дозвон, подключение и
  ошибки не сворачиваются (спека). `expand()` сбрасывает `minimizeProgress`.
- `Features/Call/CallView.swift` — ручка «Свернуть звонок» зовёт `minimize()` напрямую и
  видна доступности как кнопка (для пульта).
- `Features/Call/CallMiniDemo.swift` — DEBUG-стенд (§3.5).

### 11.2 Поведение (как на вебе)
- Показанный участник — говорящий среди удалённых; смена только после 500 мс речи
  (`.task(id:)` с отменой, как cleanup эффекта); в тишине остаётся последний; изначально —
  первый удалённый. Внутри: демонстрация экрана → камера (cover) → аватар 76 с зелёным
  кольцом и ореолом (фаза от часов, `TimelineView`). Никого: «Ждём собеседника» /
  «Пока никого». Наша камера — пип 64×40 слева над нижней панелью.
- Верх: капсула [замок при E2EE] Имя [«говорит»], янтарная «Развернуть». Низ: таймер m:ss
  (без часов, как `formatElapsed`) или мигающее «Переподключение…», микрофон, завершить
  (в группе «Выйти из звонка»). Говорит → обводка 2 px #22c55e; переподключение → красная.
- Перетаскивание: `DragGesture(minimumDistance: 4)`; во время — призрак угла (пунктир
  2 px, янтарный); отпустили — угол/свободно/язычок; `@GestureState` страхует оборванный
  жест. Тап (`onTapGesture`) — развернуть; кнопки — свои. Язычок: пилюля у края (аватар 32,
  таймер, шеврон к экрану), тап — плитка выезжает из-за края в ближайший угол этой стороны.
- «Уменьшить движение» — без анимаций (прилёт, прилипание, кольцо, мигание).

### 11.3 Отличия от веба / не сделано
- Нет кнопок «В угол» и «Камера» (спека: телефон), нет горячих клавиш.
- Клавиатура не учитывается: плитка может оказаться над ней (веб тоже так).
- Отступы safe area берутся из GeometryReader, который НЕ игнорирует safe area (у
  игнорирующего они нули); холст плитки растягивается на всё окно сдвигом на эти отступы.

### 11.4 Что проверено (симулятор, пульт §3.6)
Стенд `mini`: угол → свободное место → магнит (призрак виден) → нижний угол → язычок слева →
возврат из язычка → разворот/сворачивание → магнит у верхнего угла → язычок справа →
микрофон → отбой. Настоящий групповой звонок из одноразовой группы (только `sss`; группу
`sss+test` создать нельзя — сервер дедуплицирует по составу и возвращает чужую): экран
установления → разговор → «Свернуть звонок» → плитка «Пока никого» с таймером → протяжка →
тап-разворот → повторное сворачивание → магнит и прилипание → «Выйти из звонка». Анимации
прилёта и разворота подтверждены покадрово по видео симулятора. На телефоне не проверялось.

---

## 12. Экран установления в фирменном стиле (2026-10-01)

Перерисовка `CallConnectingView` по веб-эталону `CallConnecting.tsx` + `callConnecting.css`
(фирменный стиль на вебе — коммит `2213559b`): графит, янтарь, сливки; синей схемы
«вариант 2» больше нет. Логика (`CallConnectModel/Watcher/Controller`, `CallManager`) не
менялась, кроме текста этапа «Договариваемся о звонке» → «Согласуем звонок» (как на вебе).

- Палитра `CallInk` — токены `Eb.*` (paper / surface100…300 / border / brand* / logoCream /
  logoB) плюс `#6b7280` (приглушённый текст), `#ef4444` (ошибка), `#7a3407` (низ градиента
  инициалов). Роли узлов: «Вы» сливочный, ретранслятор и собеседник янтарные `#e38b0a`,
  сервер `#b45309`.
- Шапка `bar`: градиент rgba(217,119,6,.22→.05), нижняя рамка 2 pt `#d97706`; слева
  `BrandMark` (20 pt heavy, «ЕБлуша» с большой «Б» `#e25c2a`, как в шапке веба; до
  2026-10-02 была маленькая «б»). «Б» крутится `rotation3DEffect` по Y: на дозвоне за
  период гудка в фазе с кольцами, иначе раз в 5 с — keyframes веба `eb-cn-flip(-slow)`,
  TimelineView. Справа капсула «Аудиозвонок/Видеозвонок · m:ss» (`ClockLabel`,
  `.periodic` от начала дозвона — `ringStartedAt` контроллера, иначе от появления; старт
  запоминается один раз и после ответа не сбрасывается). Флаг видео приходит из
  `CallOverlay` (`manager.isVideoCall`). Факты — капсулы под строкой логотипа (`FlowRows`).
- Заголовок 19/700 + подзаголовок 14; на дозвоне столбики гудка `ToneBars` (keyframes
  `eb-cn-tone`). Цепочка `ConnectPath` / `NodeView` / `NodeDisc`: состояния как на вебе
  (waiting — серая рамка и значок `#6b7280`; active — ореол `#b45309` и сливочная дуга;
  ready — рамка роли, подложка 4 pt и свечение; ringing — три кольца `#d97706` и янтарная
  рамка). Аватар собеседника — `ConnectAvatar`: картинка через `CachedImage`, иначе инициалы
  (первая буква первого и последнего слова, как `initialsFromName` веба) на градиенте
  `#b45309→#7a3407`; у группы без картинки — `person.2`.
- Карточки `StepCard`: done — бейдж `#d97706` с белой галочкой; active — `AmberStripes`:
  четыре слоя CSS воспроизведены на Canvas (основа 158°, штрихи −32°/9 pt белые и
  32°/13 pt чёрные, блик сверху), текст `#0a0a0a`, сливочная дуга вокруг бейджа, внешнее
  кольцо rgba(amber,.45) и тень; waiting — opacity .85.
- Кнопка 44 pt (max 280), скругление 12: дозвон — `#ef4444` «Сбросить» с `phone.down.fill`,
  иначе `#1b1f27` с рамкой `#313643` «Отменить».
- Панель во весь экран: `.frame(minHeight: экран − 24)`; шапка сверху, кнопка снизу,
  содержимое между ними центрируется двумя `Spacer`. Грабли: блок с многострочным текстом
  между пружинами обязан быть `.fixedSize(horizontal: false, vertical: true)`, иначе VStack
  делит высоту поровну и подзаголовок ужимается до одной строки с «…».
- «Уменьшить движение»: без переворота «Б», колец, ореола, дуги, бегущих точек и пунктира
  (статичные состояния, как `prefers-reduced-motion` веба). Проверено на симуляторе через
  `defaults write com.apple.Accessibility ReduceMotionEnabled`.
- Проверено: все сценарии стенда (скриншоты), тапы по узлу / карточке / кнопке через пульт
  §3.6, настоящий групповой звонок из одноразовой группы (только `sss`, микрофон отозван):
  «Согласуем звонок» → «Прокладываем путь…» (бегущий пунктир, ореол сервера) →
  «Подключаем микрофон…» (участок проложен, точка бежит) → «Микрофон недоступен» →
  «Соединение установлено» → разговор → «Завершить». Факты пути в таком коротком звонке
  подтвердиться не успели — это поведение наблюдателя, не вида. На телефоне не проверялось.
