# Аудит подсистемы звонков Eblusha-plus — 01.07.2026

Многоагентная проверка: 14 сценарных агентов трассировали каждый сценарий сквозь 4 слоя
(бэкенд-сигналинг, веб-фронтенд, Capacitor-мост, Android-натив), каждая находка проверена
двумя независимыми скептиками + прогон «критика полноты».

**Итог: 63 кандидата → 53 подтверждённых дефекта** (10 critical, 18 high, 14 medium, 11 low),
из них 36 с высшим уровнем уверенности (CONFIRMED). Ничего в коде не менялось.

> ⚠️ В репозитории **два** мобильных клиента: нативный Kotlin (`android/`) и Capacitor/Java
> (`capacitor/android/`). Часть багов дублируется в обоих, часть уникальна. Это само по себе
> архитектурный риск (два сокета, два incoming-call пути).

---

## КЛАСТЕР A. Звонок не доходит и не восстанавливается (сеть/фон) — САМОЕ КРИТИЧНОЕ

### A1 [CRITICAL] Нет push/VoIP-пробуждения — 1:1 звонок теряется полностью, если у вызываемого нет живого сокета
`src/realtime/socket.ts:1697-1702`, `notification-service.ts:219-249`, `RealtimeService.kt:188`
`call:invite` эмитит `call:incoming` только в `userRoom(callee)`. Если приложение убито/свёрнуто
и ОС оборвала websocket — событие уходит в никуда (socket.io молча дропает emit в пустую комнату).
Серверного push нет **вообще** (grep по web-push/APNs/FCM/VoIP/PushKit — пусто), нет и store-and-forward.
IncomingCallService на Android стартует **только** из уже подключённого сокета.
**Итог: позвонить пользователю, чей апп не на переднем плане, невозможно.** Это доминирующий реальный отказ.

### A2 [CRITICAL] Кратковременный обрыв сокета у ОДНОЙ стороны рушит звонок у ОБОИХ
`src/realtime/socket.ts:2160-2177`, `ChatsPage.tsx:4613,4649`, `CallOverlay.tsx:3599`
Обрыв сокета B > pingTimeout (~20–25с) → сервер в `disconnecting` видит `participants.size<=1`,
удаляет `activeDirectCalls`+`callState` и шлёт `call:ended` стороне A. A корректно завершает звонок.
B через пару секунд реконнектится и заново `call:room:join`, но A уже ушёл. **Восстановления нет** —
живой звонок уничтожен восстановимым сетевым глюком.

### A3 [CRITICAL] Android: после reconnect сокета клиент не переотправляет `call:room:join`
`CallViewModel.kt:154-158`, `RealtimeService.kt:136,166`
`joinCallRoom` вызывается только в одноразовой ветке `RoomEvent.Connected`. При реконнекте сокета
(с новым socket.id, `forceNew=true`) сервер уже вычистил presence по старому сокету, а клиент не
наблюдает `connectionState` и не переотправляет join. Пользователь становится «призраком»:
для пиров — вышел, в `call:status` его нет.

### A4 [CRITICAL] (дубль A2 со стороны бэкенда) Транзиентный blip любой стороны принятого 1:1 звонка → teardown у обоих
`src/realtime/socket.ts:2160-2177`, `CallOverlay.tsx:1663,3599`
`connectionStateRecovery` у socket.io не настроен; клиент CallOverlay специально НЕ самозакрывается
при транзиентном LiveKit-disconnect и полагается на серверный `call:ended` — а сервер шлёт его именно
на blip. Порочный контур.

### A5 [HIGH] Android: `RoomEvent.Disconnected` мгновенно = ошибка и teardown; `RoomEvent.Reconnected` не обрабатывается
`CallViewModel.kt:166-172,531` — LiveKit-уровневое авто-восстановление невозможно в принципе.

### A6 [HIGH] Реконнект инициатора между invite и accept осиротит `callState` → accept вызываемого становится no-op
`src/realtime/socket.ts:1620,2125-2127` — звонок никогда не соединяется.

### A7 [MEDIUM] Групповой звонок: транзиентный обрыв предпоследнего участника запускает «alone» авто-завершение
`CallViewModel.kt:268,279` + бэкенд-таймеры — реконнектящегося могут авто-сбросить в процессе восстановления.

---

## КЛАСТЕР B. Безопасность сигналинга — нет проверки участия (membership)

### B1 [CRITICAL] `POST /livekit/token` минтит join-токен на ЛЮБУЮ строку комнаты без проверки участия
`src/routes/livekit.ts:78,85,100`
Любой аутентифицированный юзер запрашивает токен на `conv-<чужой_id>` (имя комнаты детерминировано и
угадываемо) и получает JWT с `roomJoin/canPublish/canSubscribe`. Он **подключается к чужому звонку**,
светится как участник, может публиковать и класть звонок. E2EE (где включено) прячет медиа-контент,
но не факт входа в SFU-комнату.

### B2 [CRITICAL] `call:end` / `call:decline` без проверки участия — любой юзер убивает любой звонок по conversationId
`src/realtime/socket.ts:1771,1833,887`
Нет `participants.some(p => p.userId === userId)`. Атакующий эмитит `call:end` с чужим conversationId →
сервер сносит `activeGroupCalls/callState`, шлёт `call:ended` всей комнате (рушит оверлеи всех реальных
участников) и пишет системное сообщение «Звонок продлился…» от имени атакующего. Повторяемо, перечислимо.

### B3 [HIGH] `call:accept` (1:1) без проверки участия — не-участник форс-активирует звонок
`src/realtime/socket.ts:1710,1720`
Единственный guard `if (!st || st.inviterId === userId)`. Третий юзер проходит: `accepted=true`,
атакующий регистрируется участником, реальный вызываемый видит «принято на другом устройстве».

### B4 [HIGH] `call:status:request` сливает состояние любого звонка (список userId, startedAt) без проверки участия
`src/realtime/socket.ts:2105,858` — оракул присутствия/соц-графа, можно опрашивать непрерывно.

### B5 [MEDIUM] `participantMetadata` полностью управляется клиентом (userId/displayName/avatar) и раздаётся другим
`src/routes/livekit.ts` (metadata) — спуфинг личности в ростере звонка.

### B6 [MEDIUM] `call:invite` без rate-limit/dedupe — спам-инвайтами держат жертву в вечном звонке
`src/realtime/socket.ts:1543,1697` — каждый повтор ресетит рингтон и 25с авто-decline у вызываемого.

---

## КЛАСТЕР C. Нет серверного ring-timeout и TTL состояния

### C1 [HIGH] Нет серверного no-answer таймаута: неотвеченный `callState` живёт вечно
`src/realtime/socket.ts:1543,1618,372` — убирается только если какой-то клиент случайно это сделает.

### C2 [HIGH] На каждый (ре)коннект сервер заново рассылает `call:incoming` для непринятого `callState` ВСЕЙ user-room; TTL нет
`src/realtime/socket.ts:1187-1231,1219,372` — залипший инвайт «воскресает» на каждом реконнекте.

### C3 [MEDIUM] Тайм-ауты рассинхронизированы между платформами
web-инициатор 30с, web/capacitor вызываемый 25с, натив — **ни у кого**. `ChatsPage.tsx:7999` и др.

### C4 [MEDIUM] Accept-after-end гонка (1:1): `call:end` удаляет state, затем `call:accept` дропается как «stale», вызываемый залипает
`src/realtime/socket.ts:1833,1720`, `ChatsPage.tsx:4437` — вызываемый уже подключился к LiveKit, а инициатор всё снёс.

---

## КЛАСТЕР D. Android incoming-call сломан вне активной Compose-композиции

### D1 [CRITICAL] Нет `onNewIntent` — Accept/Open из уведомления игнорируется, когда апп уже запущен (singleTask)
`AndroidManifest.xml:35`, `MainActivity.kt:401`, `IncomingCallService.kt:94,191`
`launchMode=singleTask` + нет override `onNewIntent`/`setIntent` → `getIntent()` возвращает старый intent,
обработчик `LaunchedEffect(Unit)` не перезапускается. **Кнопка «Принять» из шторки ничего не делает.**

### D2 [CRITICAL] Ring/уведомление стартует только из Compose-collector → звонки теряются при уничтоженной Activity
`MainActivity.kt:344-347`, `BackgroundConnectionService.kt:57`
Сокет жив в Application-scope, но превращает `call:incoming` в `IncomingCallService.start` только collector
внутри Compose-дерева. Свайпнули из recents → collector мёртв → входящий не звонит и не показывается.

### D3 [CRITICAL] Ghost-ringing: `IncomingCallService` не останавливается на remote cancel/decline/accept, если Compose-экран LoggedIn неактивен
`MainActivity.kt:344-387`, `IncomingCallService.kt:52` — рингтон/вибрация/уведомление идут до 10-мин wakelock.

### D4 [CRITICAL] Capacitor: нативный рингер не глохнет на «принято на другом устройстве»
`capacitor/.../BackgroundConnectionService.java:478-530`, `IncomingCallService.java:129`, `socket.ts:1764-1768`
Бэкенд шлёт только `call:accepted`, а нативный сокет слушает `incoming/declined/ended`, но **не `accepted`**,
и у сервиса нет самотаймаута. Рингтон навечно.

### D5 [HIGH] Активный 1:1 на нативе не сносится по `call:end/decline` пира — только 5с LiveKit-автосброс, а если пир не дошёл до LiveKit — навсегда
`MainActivity.kt:379-387`, `CallViewModel.kt:268`.

### D6 [HIGH] Нативный инициатор: нет экрана дозвона и no-answer таймаута, игнорит `call:declined/ended` — сидит в пустой комнате вечно
`MainActivity.kt:537`, `CallViewModel.kt:268`, `MainActivity.kt:379`.

### D7 [HIGH] Accept из cold-start уведомления теряется: emit по ещё-не-подключённому сокету — fire-and-forget
`MainActivity.kt:404`, `RealtimeService.kt:41,75`.

### D8 [HIGH] Ringing-сервис глохнет только из Compose-collector: cancel/decline при мёртвой Activity оставляет звон/вибрацию
`MainActivity.kt:358-387`, `IncomingCallService.kt:76`.

### D9 [HIGH] Неверный тип foreground-сервиса (`mediaPlayback`) + нет try/catch вокруг `startForeground` → краш/ANR и осиротевший звон
`AndroidManifest.xml:47`, `IncomingCallService.kt:46,218`.

### D10 [MEDIUM] Android group-call авто-сброс за 5с при кратком падении remote-count до 1→0
`CallViewModel.kt:268,279` — `seenMultipleRemoteParticipants` латчится только на одновременном снимке >1.

---

## КЛАСТЕР E. Идентичность и мультиустройство

### E1 [HIGH] Identity токена = `user.id` без device-суффикса → коллизия на двух устройствах, первое кикает
`src/routes/livekit.ts:91`, `CallOverlay.tsx:2527`, `CallViewModel.kt:98`.

### E2 [HIGH] Два одновременных Socket.IO на Capacitor-Android (webview JS + нативный BG-сервис)
`capacitor/index.ts:41`, `capacitor/.../MainActivity.java:60`, `BackgroundConnectionService.java:428`
— дублирование presence/room state и двойная обработка входящих событий.

### E3 [HIGH] Двойной показ входящего на Capacitor-Android: и нативный BG-сокет, и webview CallHandler стартуют IncomingCallService
`BackgroundConnectionService.java:479-516`, `call-handler.ts:68`.

### E4 [MEDIUM] Decline/End 1:1 не ретранслируется на СВОИ другие устройства — второе устройство звонит все 25с
`src/realtime/socket.ts` (нет emit на `userRoom(self)` при decline/end).

---

## КЛАСТЕР F. Деградация медиа

### F1 [HIGH] Видео-звонок не принимается вовсе, если недоступна только камера (нет audio-only fallback)
`frontend/src/utils/media.ts:24`, `CallHost.tsx:80`, `ChatsPage.tsx:1952`.

### F2 [HIGH] 1:1 E2EE-звонок полностью рушится (вместе с аудио), если публикация камеры падает на коннекте
`CallOverlay.tsx:2708-2712`.

### F3 [HIGH] Android: отказ в разрешении/ошибка захвата mic/cam оставляет звонок half-joined (room connected, UI = Error)
`CallViewModel.kt:441,468`.

### F4 [MEDIUM] Android toggleAudio/toggleVideo рассинхрон + не перепроверяет разрешение; провал toggle оставляет room на Error-экране
`CallViewModel.kt` toggle-пути.

---

## КЛАСТЕР G. Утечки, качество, прочее (medium/low)

- **G1 [MED]** Оверлей unmount / не-ручной LiveKit-disconnect не шлёт `call:room:leave` — участник осиротел в `activeGroupCalls`. `CallOverlay.tsx:1628,3578`, `ChatsPage.tsx:12140`
- **G2 [MED]** Фронтовый `activeCalls` дрейфует от серверной правды из-за оптимистичной локальной мутации.
- **G3 [MED]** Дубль/re-emit `call:invite` во время принятого звонка перезаписывает `callState` (`accepted=false`, `startedAt`) и заново звонит.
- **G4 [MED]** Screen-share «Источник / без даунскейла» молча режется до 1080p на не-Safari.
- **G5 [MED]** AudioContext усиления громкости никогда не закрывается — течёт по одному на каждый mount CallOverlay. `screenShareAudio.ts`
- **G6 [MED]** Кольца качества у ремоутов матчатся по display name — тёзки получают перепутанные/устаревшие кольца. `CallQualityRingUpdater.tsx`
- **G7 [MED]** Token TTL = дефолт 6ч, не рефрешится — звонок/удержанный reconnect за пределом 6ч падает навсегда.
- **G8 [MED]** Вибро/wakelock-утечка, если сервис убит не через ACTION_ACCEPT/DECLINE. `IncomingCallService.kt`
- **G9 [LOW]** Инициатор, упавший на дозвоне, шлёт `call:ended` но не пишет missed-call сообщение (в отличие от decline/end).
- **G10 [LOW]** Групповой: реконнект одинокого участника постит дубли «call started»/«call ended».
- **G11 [LOW]** `nameToIdentityRef` не чистится при выходе участников — рост без границ на длинном звонке.
- **G12 [LOW]** Self uplink packetsLost/jitter читаются из неверного RTP-объекта — своё кольцо качества «слепо» к потерям.
- **G13 [LOW]** MutationObserver перезапускается на собственных вставленных нодах — лишний рендер-проход.
- **G14 [LOW]** `call:glare` чисто информационный: не примиряет рассинхрон audio/video-режима двух одновременных инициаторов.
- **G15 [LOW]** Нативный Kotlin-клиент подписан на `call:incoming`, но не на `call:glare` — нет outgoing→incoming конверсии при glare.

---

## Приоритеты (рекомендация к порядку исправления)

1. **Безопасность сигналинга (B1–B6)** — это отдалённо эксплуатируемо любым аутентифицированным юзером:
   войти/подслушать/убить/зафлудить чужой звонок. Проверка membership на `call:accept/end/decline/status:request`
   и на `/livekit/token`; серверная генерация identity/metadata; rate-limit на invite.
2. **Устойчивость к потере сети (A1–A7)** — без push (A1) мобильные звонки не доходят вообще; teardown-на-blip
   (A2/A4) и отсутствие re-join (A3) делают любой звонок хрупким. Нужны: серверный grace-период вместо мгновенного
   `call:ended`, re-join на reconnect, VoIP/push-канал.
3. **Android incoming (D1–D10)** — весь путь входящего вне активной Compose-композиции нерабочий; ghost-ringing.
4. **Ring-timeout/TTL (C1–C4)** и **идентичность/дубли клиентов (E1–E4)**.
5. **Медиа-fallback (F1–F4)** и утечки (G-кластер).
