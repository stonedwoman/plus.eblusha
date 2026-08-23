# Eblusha Cloud

Приватное файловое хранилище поверх существующей Еблуши. Живёт на
**https://eblusha.org/cloud**, использует ту же БД, тот же Redis, тот же
Socket.IO и тот же nginx. Отдельного сервера, отдельной базы и отдельной
регистрации нет — и не должно появиться.

---

## Архитектура

```
браузер ──► nginx (eblusha.org)
              ├─ /cloud/*            → SPA (frontend/dist)
              ├─ /api/cloud/*        → backend:4000
              ├─ /socket.io/         → backend:4000  (namespace /cloud)
              └─ /__cloud_internal/  → internal, отдача файлов по X-Accel-Redirect

backend (eblusha-backend)          — API, ACL, tus, отдача, уборка
cloud-worker (eblusha-cloud-worker) — ffmpeg/sharp, НЕ root (user 1000:101)
postgres                            — таблицы Cloud* рядом с таблицами мессенджера
redis                               — сессии Cloud, presence, очереди BullMQ
```

Код целиком в `src/cloud/` и `frontend/src/cloud/`. Модуль монтируется одной
строкой в `src/routes/index.ts` и полностью выключается `CLOUD_ENABLED=0`.

| Каталог | Что там |
|---|---|
| `src/cloud/auth/` | SSO (PKCE), сессии в Redis, CSRF |
| `src/cloud/acl.ts` | вся авторизация, одна точка входа `requireSpaceAccess` |
| `src/cloud/upload/` | серверная сторона протокола tus 1.0.0 + финализация |
| `src/cloud/storage/` | физические объекты, дедуп, refCount, квоты |
| `src/cloud/media/` | ffprobe, sharp, EXIF, постеры, транскод |
| `src/cloud/jobs/` | очереди BullMQ, медиа-воркеры, обслуживание |
| `src/cloud/routes/` | HTTP API |
| `frontend/src/cloud/` | UI, очередь загрузок на tus-js-client, realtime |

---

## Аутентификация

Cloud **не имеет своих паролей** и не хранит хеши Еблуши. Вход только через
существующую сессию мессенджера:

```
SPA (Bearer Еблуши) ─► POST /api/cloud/auth/authorize  ─► одноразовый code (TTL 2 мин)
SPA (без Bearer)    ─► POST /api/cloud/auth/token      ─► Set-Cookie cloud_sid (HttpOnly)
```

* PKCE S256, `state`/`redirect_uri` ограничены путями внутри `/cloud`;
* код одноразовый (Redis `GETDEL`), привязан к `clientId` и challenge;
* сессия — HttpOnly + SameSite=Lax + Secure, скользящий TTL 30 дней;
* все мутации требуют заголовок `X-Cloud-CSRF`;
* identity — только `User.id` Еблуши. По displayName ничего не связывается.

Отдельная сессия нужна не «для красоты»: многочасовая загрузка не должна падать
от ротации 15-минутного access-токена мессенджера.

---

## Права

Роли Space: `OWNER`, `EDITOR`, `VIEWER`. Проверка централизована в
`src/cloud/acl.ts`; ни один handler не решает сам.

| Действие | OWNER | EDITOR | VIEWER |
|---|:--:|:--:|:--:|
| просмотр, скачивание, ZIP | ✓ | ✓ | ✓ |
| загрузка, папки, удаление | ✓ | ✓ | — |
| комментарии, реакции | ✓ | ✓ | по настройке Space |
| участники, приглашения, публичные ссылки | ✓ | — | — |
| удаление Space | ✓ | — | — |

Отсутствие доступа отдаётся как `404`, а не `403`, чтобы не подтверждать
существование чужого Space.

---

## Хранилище

```
/var/lib/eblusha/cloud/
  objects/  ab/cd/<sha256>       root:101 2750   оригиналы            БЭКАП
  derived/  ab/cd/<fileId>/...   1000:101 2770   превью/постеры/web   не бэкапим
  staging/  <uploadId>.part      root:root 0750  незавершённые        не бэкапим
  tmp/                           1000:101 2770   рабочее ffmpeg       не бэкапим
```

Пользовательская иерархия папок **не отражается** на диске: имена файлов и папок —
только метаданные в БД. Путь к объекту строится из sha256, никогда из имени файла.
`sha256` наружу не отдаётся; публичный идентификатор — `CloudFile.id` (cuid).

Логический `CloudFile` и физический `CloudStorageObject` разделены, поэтому
работают дедупликация и «Сохранить к себе» без копирования байтов.
Дедуп применяется **после** полной загрузки — API «у нас уже есть хеш X»
не существует, чтобы не создавать оракул наличия чужих файлов.

Права: медиа-воркер (uid 1000) читает `objects/` по группе, но писать туда не
может. Удаление оригиналов — только у backend.

---

## Загрузки

Протокол **tus 1.0.0** (core + creation + termination + expiration). На клиенте
`tus-js-client`, на сервере — `src/cloud/upload/tus.ts`.

* состояние в `CloudUploadSession` (Postgres) — рестарт backend не убивает закачку;
* offset берётся с диска, а не из счётчика в БД;
* параллельный PATCH в один upload отсекается блокировкой в Redis;
* `POST /api/cloud/uploads/resolve` по отпечатку файла находит начатую загрузку —
  это и есть докачка после перелогина и на другом компьютере;
* отпечаток = размер + mtime + sha256 трёх выборок (начало/середина/конец).
  30 ГБ в браузере целиком не хешируются;
* настоящий SHA-256 считает сервер после приёма последнего байта. Клиентский
  хеш источником истины не является никогда.

После передачи: проверка размера → SHA-256 → определение реального типа по
сигнатуре → атомарный перенос в `objects/` → дедуп → `CloudFile` → медиа-джоба →
realtime-событие.

---

## Медиа

**Фото.** sharp (libvips 8.18): `thumb` 512px и `preview` 2048px в WebP.
EXIF читается `exifr`: дата съёмки, GPS, камера, параметры. Что sharp не открывает
(HEIC/HEIF с iPhone) — декодируется через ffmpeg и потом идёт в sharp.
Если превью не получилось, файл всё равно доступен как обычный файл.

**Видео.** `ffprobe` → постер (кадр на ~10% длительности) → решение:

* h264/vp8/vp9/av1 + aac/mp3/opus в mp4/mov/webm **и** moov в начале файла →
  оригинал отдаётся напрямую с Range. Вторая копия 30-гигабайтного файла на диск
  не кладётся;
* всё остальное (HEVC, ProRes, экзотика) → одна web-версия 1080p H.264 + AAC,
  faststart. Лестница из пяти разрешений не делается: на четырёх ядрах без
  аппаратного кодировщика это бессмысленно.

Аппаратное ускорение не используется: VAAPI в контейнере требует проброса
`/dev/dri` и на этой машине стабильности не даёт. Софтовый путь — единственный.

**Безопасность обработки.** Всё через `spawn` с массивом аргументов (никакой
shell-интерполяции имён), пустое окружение кроме PATH, жёсткие таймауты, лимит
пикселей у sharp, ограниченная concurrency, воркер под непривилегированным
пользователем. Архивы не распаковываются. SVG считается документом и не
рендерится как изображение.

---

## Очереди

| Очередь | Concurrency | Что делает |
|---|---|---|
| `cloud-media-images` | 2 | EXIF, thumb, preview |
| `cloud-media-video` | 1 | ffprobe, постер, транскод |
| `cloud-maintenance` | 1 | корзина, staging, refCount, кэш превью |

Джобы идемпотентны (`jobId` = fileId), 3 попытки с экспоненциальным backoff.
Медиа-очереди слушает `eblusha-cloud-worker`, очередь обслуживания — backend
(только у него есть права на удаление оригиналов).

---

## Realtime

Namespace `/cloud`, комнаты `user:<id>` и `space:<id>`, аутентификация по куке
`cloud_sid` из рукопожатия. События: `cloud.upload.updated`, `cloud.file.created`,
`cloud.file.ready`, `cloud.file.deleted`, `cloud.comment.*`, `cloud.reaction.changed`,
`cloud.presence.changed`, `cloud.activity.created` и другие.

Воркер живёт в отдельном процессе и публикует события в Redis-канал `cloud:events`;
backend ретранслирует их **локальным** сокетам (иначе Redis-адаптер размножил бы
событие по числу инстансов).

Presence — в Redis (ZSET с TTL 75 сек), не в Postgres.

---

## Публичные ссылки

`https://eblusha.org/cloud/s/<publicId>#t=<secret>`

Секрет во фрагменте — браузер его серверу не отправляет, поэтому он не попадает
в access-логи nginx, в Referer и в аналитику. Фронтенд один раз меняет секрет на
короткую HttpOnly-сессию (`POST /api/cloud/public/:id/session`) и немедленно
вычищает фрагмент через `history.replaceState`.

В БД хранится только `sha256(secret)`. Опции: превью, скачивание, срок,
пароль (bcrypt), QR (генерируется в браузере). Права проверяются на **каждом**
запросе по свежей записи — `revoke` действует мгновенно.

Приглашения (`/cloud/join/<publicId>#t=<secret>`) — другое: они всегда требуют
входа через Еблушу и дают роль в Space, но ничего не позволяют скачать анонимно.

---

## Конфигурация

Все переменные — в `.env` (образец в `.env.example`), ничего не зашито в код.

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `CLOUD_ENABLED` | `1` | выключатель модуля |
| `CLOUD_STORAGE_ROOT` | `/var/lib/eblusha/cloud` | корень хранилища |
| `CLOUD_STORAGE_MAX_BYTES` | `520G` | квота оригиналов |
| `CLOUD_STORAGE_MIN_FREE_BYTES` | `100G` | обязательный резерв на ФС |
| `CLOUD_DERIVED_CACHE_MAX_BYTES` | `60G` | потолок кэша превью |
| `CLOUD_MAX_FILE_BYTES` | `64G` | лимит одного файла |
| `CLOUD_TRASH_RETENTION_DAYS` | `30` | сколько живёт корзина |
| `CLOUD_UPLOAD_TTL_HOURS` | `336` | сколько ждём докачку |
| `CLOUD_XACCEL` | `1` | отдача файлов через nginx |
| `CLOUD_ADMIN_USERNAMES` | — | логины Еблуши для `/cloud/admin/storage` |
| `CLOUD_IMAGE_CONCURRENCY` | `2` | параллельных картинок |
| `CLOUD_VIDEO_CONCURRENCY` | `1` | параллельных ffmpeg |
| `CLOUD_MAP_TILE_URL` | OSM | провайдер тайлов карты |

Перед приёмом файла проверяются одновременно квота, реальное свободное место и
резерв. При нехватке — честный `507`.

---

## Требуемые пакеты

Всё уже в образе (`Dockerfile`): ffmpeg 8 (libx264, aac, hevc-декодер),
`sharp` 0.35 с libvips 8.18 (musl-сборка), `exifr`, `archiver`.
На фронте: `tus-js-client`, `leaflet`, `qrcode`.

---

## Эксплуатация

```bash
# Запуск / рестарт
docker compose -f deploy/docker-compose.full.yml --env-file .env up -d backend cloud-worker nginx
docker compose -f deploy/docker-compose.full.yml --env-file .env restart cloud-worker

# Полный передеплой (фронт + бэк)
npm run deploy

# Только фронтенд
cd frontend && npx tsc --noEmit -p tsconfig.json && npm run build   # nginx подхватит dist сразу

# Только бэкенд
npm run build
docker compose -f deploy/docker-compose.full.yml --env-file .env build backend cloud-worker
docker compose -f deploy/docker-compose.full.yml --env-file .env up -d backend cloud-worker
```

### Миграции

Обычные миграции Prisma, применяются автоматически при старте backend
(`docker-entrypoint.sh` → `prisma migrate deploy`). Cloud добавил одну:
`prisma/migrations/20260823120000_cloud_module` — только `CREATE TABLE`/`CREATE INDEX`
для таблиц `Cloud*`. Существующих таблиц она не трогает.

```bash
npx prisma migrate deploy   # вручную
npx prisma migrate status
```

### Логи и диагностика

```bash
docker logs eblusha-backend --tail 200 | grep -i cloud
docker logs eblusha-cloud-worker --tail 200

# Упавшие медиа-джобы: экран /cloud/admin/storage или
curl -s --cookie "cloud_sid=..." http://127.0.0.1/api/cloud/admin/storage | jq .failedJobs
```

Одиночный файл можно переобработать кнопкой в интерфейсе или
`POST /api/cloud/files/:id/reprocess`.

### Место на диске

```bash
df -h /var/lib/eblusha
du -sh /var/lib/eblusha/cloud/*
npm run cloud:maintenance      # разовый прогон уборки
```

Экран `/cloud/admin/storage` показывает оригиналы, кэш, staging, свободное место,
экономию от дедупликации, состояние очередей и упавшие задачи.

### Бэкап

`deploy/cloud-backup.sh` (restic). Бэкапятся `objects/` и дамп PostgreSQL;
`derived/`, `staging/`, `tmp/` — нет, они восстановимы.

**Внешний HDD ещё не подключён**, поэтому путь репозитория в скрипте не
придуман: пока `RESTIC_REPOSITORY` не задан в `/etc/eblusha-cloud-backup.env`,
скрипт сознательно отказывается работать. Как подключите диск — заполните
`deploy/cloud-backup-env.example` → `/etc/eblusha-cloud-backup.env`, затем:

```bash
/usr/local/bin/eblusha-cloud-backup init
/usr/local/bin/eblusha-cloud-backup backup
# в cron: ежедневный backup + еженедельный check (полная проверка дорогая)
```

`rsync --delete` как единственная стратегия не годится: он повторит на копии
любое разрушение оригинала.

---

## Тесты

Намеренно компактные, гоняются против живого сервера через nginx:

```bash
npx ts-node test/cloud.smoke.test.ts   # 35 проверок: авторизация, докачка, Range, share, корзина
npx ts-node test/cloud.media.test.ts   # конвейер: h264 играет как есть, HEVC получает web-версию
npx ts-node test/cloud.media.test.ts /путь/к/своим.MOV /путь/к/фото.HEIC
```

Тестовые Space создаются и удаляются самим тестом.

---

## Отдельный поддомен cloud.eblusha.org

Cloud работает на двух конфигурациях одновременно, переключение — переменными
окружения, без правок кода.

### Что происходит со входом

На отдельном поддомене `localStorage` ДРУГОЙ, и токена Еблуши там нет и быть не
может. Поэтому вместо XHR используется браузерный редирект — обычный
authorization code flow:

```
cloud.eblusha.org/cloud                 нет сессии Cloud
        │
        ▼  редирект (state + code_challenge в query, verifier остаётся здесь)
eblusha.org/cloud-auth                  здесь лежит сессия Еблуши
        │                               (нет — сначала /auth, потом обратно сюда)
        ▼  редирект (code + state)
cloud.eblusha.org/cloud/callback        обмен кода на HttpOnly cloud_sid
        │
        ▼
cloud.eblusha.org/cloud                 returnTo вместе с search и hash
```

`code_verifier` не покидает origin Cloud, наружу уходит только `code_challenge`.
`state` защищает сам редирект. `returnTo` сохраняется целиком, включая фрагмент,
поэтому ссылка-приглашение `/cloud/join/<id>#t=<секрет>` переживает вход.

`redirect_uri` проверяется **строгим allowlist'ом** `CLOUD_ALLOWED_REDIRECT_ORIGINS`
(и путь обязан начинаться с `/cloud`). Никаких эвристик вида «начинается с
https://cloud.»: открытый редирект здесь означал бы выдачу кода чужому сайту.
Отвергаются и `//evil`, и `javascript:`, и `cloud.eblusha.org.evil.example`, и
свой origin с путём вне `/cloud`, и URL с query.

### Переменные

```
CLOUD_PUBLIC_BASE_URL=https://cloud.eblusha.org          # на него генерируются share/join-ссылки
CLOUD_MESSENGER_ORIGIN=https://eblusha.org               # где искать сессию Еблуши
CLOUD_ALLOWED_REDIRECT_ORIGINS=https://cloud.eblusha.org,https://eblusha.org
```

Пустой `CLOUD_ALLOWED_REDIRECT_ORIGINS` = режим одного origin, редирект-flow
выключен, всё работает как раньше на `eblusha.org/cloud`.

`https://eblusha.org` намеренно оставлен в списке: старый путь продолжает
работать, и **ранее розданные share-ссылки на eblusha.org не ломаются**.

### Что настроить в Cloudflare (сторона пользователя)

Два варианта, оба рабочие.

**A. Тот же тоннель — минимальное изменение.** Zero Trust → Networks → Tunnels →
`EBLUSHA` → Public Hostnames → Add: hostname `cloud.eblusha.org`, origin service
такой же, как у `eblusha.org`. DNS создастся автоматически. Всё.

**B. Отдельный тоннель — рекомендуется.** cloudflared мультиплексирует весь
трафик через общий пул QUIC-соединений: многогигабайтная заливка в Cloud будет
делить их с сигналингом звонков и сокетами чата, и просядет при этом сигналинг,
а не файл. Готовый юнит с инструкцией — `deploy/cloudflared-cloud.service.example`.
Тот же приём уже применён для HUILA.

В любом случае nginx уже слушает `server_name cloud.eblusha.org` и на 80, и на
443, поэтому вариант origin service роли не играет.

### Жёсткий переезд (по желанию)

По умолчанию оба адреса рабочие — это обратимо и не рвёт старые ссылки. Если
захочется оставить только поддомен, добавить в `nginx-eblusha-origin-locations.inc`:

```nginx
location ^~ /cloud/s/ { return 301 https://cloud.eblusha.org$request_uri; }
location ^~ /cloud/   { return 301 https://cloud.eblusha.org$request_uri; }
location = /cloud     { return 301 https://cloud.eblusha.org/cloud; }
```

`/cloud-auth` редиректить НЕЛЬЗЯ — это точка выдачи кода, она обязана остаться
на origin мессенджера. Фрагмент (`#t=...`) при 301 браузер переносит сам.

---

## Cloudflare: транспорт, а не кэш

Главная польза Cloudflare здесь — **маршрут**, а не кэширование. Клиент
подключается к ближайшему edge-датацентру, дальше трафик идёт по опорной сети
Cloudflare до анкора рядом с сервером и уже оттуда по QUIC-тоннелю в Румынию.
Вместо одного длинного TCP-соединения через публичный интернет получается
короткий хоп до edge плюс оптимизированный backbone. Для друзей в США и России
это и есть основной выигрыш.

Это работает **уже сейчас** и для Cloud включится автоматически, как только
появится Public Hostname: отдельного «включения CDN» не требуется, тоннель и
есть транспорт.

Замер на текущем тоннеле мессенджера (`curl -s http://127.0.0.1:20342/metrics`):

```
edge_location="otp02"  RTT 2 мс     (Бухарест — анкор рядом с сервером)
edge_location="fra14"  RTT 30 мс    (Франкфурт — резервный)
protocol: QUIC, 4 HA-соединения
```

### Что может улучшить транспорт дальше

| Что | Даёт | Цена |
|---|---|---|
| **Argo Smart Routing** | путь внутри backbone выбирается по реальной загрузке, а не по дефолтной топологии; на длинных маршрутах США→ЕС обычно самый заметный прирост | $5/мес + $0.10 за ГБ |
| **Отдельный тоннель для Cloud** | файловый трафик не делит QUIC-соединения с сигналингом звонков | бесплатно |
| `--protocol quic` | устойчивость к потерям на длинном маршруте; у тоннеля мессенджера уже используется | бесплатно |
| Tiered Cache / кэш | **ничего не даёт**: файлы приватные, `Cache-Control: private` | — |

Про Argo стоит посчитать: $0.10/ГБ при облаке на сотни гигабайт — это десятки
долларов, если участники массово перекачивают оригиналы. При обычном сценарии
(смотрят превью, скачивают выборочно) — единицы долларов в месяц.

### Кэш: что кэшируется, а что нет

Кэшируется только статика SPA: `/assets/` отдаётся с
`public, max-age=31536000, immutable` (файлы хешированные) — это единственный
контент Cloud, которому edge-кэш объективно помогает.

Всё остальное — оригиналы, превью, постеры — идёт с `Cache-Control: private` и
требует куку или share-сессию. Cloudflare такое не кэширует, и не должен:
закэшированное на edge приватное фото это утечка. Поэтому «CDN для облака» в
смысле кэша здесь не работает by design, и рассчитывать на него не нужно.

### Ограничения, о которых надо помнить

**Лимит тела запроса — 100 МБ** на self-serve планах. Загрузки это переживают
только потому, что tus режет файл на куски по 16 МБ (`CHUNK_SIZE` в
`frontend/src/cloud/uploads/manager.ts`). Если будете поднимать размер чанка —
**не выше ~90 МБ**, иначе загрузка через Cloudflare начнёт падать с 413.
Скачивание таким лимитом не ограничено.

**ToS 2.8** формально не одобряет раздачу больших объёмов видео через
проксируемый Cloudflare мимо Stream/R2. Для приватного облака на несколько
человек это не тот масштаб, за которым охотятся, — тем более что через этот же
тоннель уже раздаются гигабайтные инсталляторы в `/updates/`. Осторожность имеет
смысл только если публичные share-ссылки на видео уйдут в широкую раздачу.

**`proxy_request_buffering off`** в конфиге поддомена трогать нельзя: без него
чанки tus целиком оседали бы во временном файле nginx, и прогресс загрузки врал
бы пользователю.

---

## Известные ограничения

* HLS не делается: одна MP4-версия с Range работает во всех браузерах, включая
  Safari. Место под будущий HLS в модели есть (`CloudFileVariant.kind`).
* Транскод только софтовый; длинное 4K HEVC на четырёх ядрах займёт часы.
  Постер и превью при этом появляются сразу.
* E2EE-Space не реализованы. `CloudSpace.encryptionMode` уже есть со значением
  `STANDARD`, архитектура их добавление не блокирует.
* Перемещение файлов между Space через интерфейс не сделано (есть «Сохранить к
  себе» — ссылка на тот же физический объект).
* Поиск — по имени файла средствами PostgreSQL. Elasticsearch не ставился
  и не нужен на таком объёме.
