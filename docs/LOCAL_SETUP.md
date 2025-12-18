# Локальный запуск (Windows)

## 1. Зависимости

- Node.js >= 18.18
- npm 10+
- Docker Desktop (для PostgreSQL)

## 2. Поднять PostgreSQL

```powershell
npm run docker:db
```

Альтернатива: `docker compose up -d postgres`.

## 3. Настроить `.env`

Создай `C:\projects\eblusha-plus\.env`:

```
NODE_ENV=development
PORT=4000
CLIENT_URL=http://localhost:5173
DATABASE_URL=postgresql://eblusha:eblusha@localhost:5432/eblusha
JWT_SECRET=<32+ символов>
JWT_REFRESH_SECRET=<32+ символов>
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
LIVEKIT_URL=https://example.livekit.cloud
LIVEKIT_API_KEY=lk_api_key
LIVEKIT_API_SECRET=lk_api_secret
STORAGE_S3_ENDPOINT=https://hel1.your-objectstorage.com
STORAGE_S3_REGION=ru-1
STORAGE_S3_BUCKET=<twc-bucket-id>
STORAGE_S3_ACCESS_KEY=<access-key>
STORAGE_S3_SECRET_KEY=<secret-key>
STORAGE_PUBLIC_BASE_URL=https://s3.twcstorage.ru/<twc-bucket-id>
STORAGE_PREFIX=uploads
STORAGE_S3_FORCE_PATH_STYLE=true
STORAGE_S3_ACL=public-read
STORAGE_S3_SSE=AES256
```

`STORAGE_*` переменные настраивают S3-совместимое хранилище (TWC SPB, AWS, MinIO и т.д.). `STORAGE_PUBLIC_BASE_URL` должен указывать на публичную базу для ссылок (в нашем случае это path-style URL `https://s3.twcstorage.ru/<bucket>`). `STORAGE_S3_SSE` включает server-side encryption (`AES256` по умолчанию) для всех объектов. Для секретных (1:1) чатов вложения дополнительно шифруются на клиенте перед отправкой в бакет.

## Миграция старых файлов в Object Storage

1. Убедись, что все `STORAGE_*` переменные заполнены и бакет уже создан.
2. Останови бэкенд, чтобы не шёл новый upload в локальную папку.
3. (Опционально) Установи `API_BASE_URL=https://ru.eblusha.org` для миграционного скрипта, чтобы он использовал прокси URL вместо прямых ссылок на S3. Если не указано, будет использован origin из `STORAGE_PUBLIC_BASE_URL` или `http://localhost:3000` по умолчанию.
4. Выполни `npm run migrate:uploads` — скрипт загрузит файлы из `uploads/` в бакет (с включённым SSE) и обновит ссылки в базе на прокси URL (`/api/files/...`).  
   Добавь флаг `--keep-local`, если нужно оставить копию файлов, а `--skip-upload`, если ты уже залил их через `mc`/`s3cmd` и хочешь лишь обновить БД.

**Важно:** Все новые загрузки используют прокси URL (`/api/files/...`). Это помогает с совместимостью (CORS) и позволяет менять storage-провайдера без обновления ссылок на клиенте. Старые URL в базе автоматически конвертируются на фронтенде.

Генерация секрета:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4. Миграции Prisma

```powershell
npx prisma migrate dev
```

## 5. Запуск бэкенда

```powershell
npm run dev
```

Health-check: `http://localhost:4000/health`.

## 6. Запуск фронтенда

```powershell
cd frontend
npm run dev
```

Фронт: `http://localhost:5173`.

## 7. LiveKit (опционально)

- Создай проект в LiveKit Cloud или self-hosted.
- Обнови `LIVEKIT_*` переменные.

## 8. Остановка сервисов

```powershell
docker compose down
```

---

# Перенос на VSP (Ubuntu) — краткий план

1. Node.js 20 LTS, npm 10, Docker/Compose.
2. Скопировать проект и `.env` (боевые значения).
3. `docker compose up -d postgres`.
4. `npx prisma migrate deploy`.
5. `npm install && npm run build` (бэкенд).
6. Запустить через PM2/systemd: `node dist/server.js`.
7. `cd frontend && npm install && npm run build`; раздача через nginx или `vite preview`.
8. Настроить reverse proxy, HTTPS, бэкапы БД.




