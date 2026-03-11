# Миграция Eblusha Plus на новый сервер (Ubuntu + CasaOS + Docker)

Документ для переноса проекта на новый сервер без изменения кода. Весь стек запускается одной командой `docker compose up -d`.

---

## 1. Полный docker-compose.yml

Используется файл `deploy/docker-compose.full.yml`:

- **postgres** — база данных PostgreSQL 16
- **redis** — кеш и очереди (BullMQ)
- **backend** — Node.js API + Socket.IO
- **worker** — Link Preview worker (отдельный контейнер)
- **nginx** — статика SPA + reverse proxy к backend

Для запуска только инфраструктуры (postgres + redis) без backend в Docker — используйте `deploy/docker-compose.yml` (текущий продакшн).

---

## 2. Список Docker images и версий

| Сервис  | Image              | Версия |
|---------|--------------------|--------|
| postgres| postgres:16-alpine | 16     |
| redis   | redis:7-alpine     | 7      |
| nginx   | nginx:alpine       | latest |
| backend | build from Dockerfile | node:20-alpine |

Backend и worker собираются из `Dockerfile` в корне проекта (Node 20 Alpine).

---

## 3. Environment variables (.env)

Полный список переменных окружения. **На новом сервере создайте `.env` и заполните секреты.**

### Обязательные

```
NODE_ENV=production
PORT=4000
CLIENT_URL=https://plus.eblusha.org          # или ваш домен
DATABASE_URL=postgresql://eblusha:PASSWORD@postgres:5432/eblusha?schema=public
REDIS_URL=redis://redis:6379

# Для docker-compose.full: пароль postgres (должен совпадать с DATABASE_URL)
POSTGRES_PASSWORD=your_secure_password

JWT_SECRET=<32+ символов hex>
JWT_REFRESH_SECRET=<32+ символов hex>
LIVEKIT_URL=wss://voice.eblusha.org          # внешний LiveKit
LIVEKIT_API_KEY=<ключ>
LIVEKIT_API_SECRET=<секрет>
METRICS_TOKEN=<токен для /api/status/metrics>
STORAGE_ENC_KEY=<base64, 32 байта>
```

### Storage (локальный диск или S3)

**Локальный диск (рекомендуется для Румынии):**
```
STORAGE_BACKEND=local
LOCAL_STORAGE_PATH=/var/lib/eblusha/storage
STORAGE_PREFIX=uploads
STORAGE_ENC_KEY=<base64, 32 байта>
CHAT_ENC_KEK=<base64, 32 байта — для шифрования DEK не-secret чатов>
```

**S3 (для РФ или облака):**
```
STORAGE_BACKEND=s3
STORAGE_S3_ENDPOINT=https://s3.twcstorage.ru
STORAGE_S3_REGION=ru-1
STORAGE_S3_BUCKET=<bucket-id>
STORAGE_S3_ACCESS_KEY=<key>
STORAGE_S3_SECRET_KEY=<secret>
STORAGE_PUBLIC_BASE_URL=https://s3.twcstorage.ru/<bucket-id>
STORAGE_PREFIX=uploads
STORAGE_S3_FORCE_PATH_STYLE=true
STORAGE_S3_ACL=public-read
STORAGE_S3_SSE=AES256
STORAGE_ENC_KEY=<base64, 32 байта>
CHAT_ENC_KEK=<base64, 32 байта — для шифрования DEK не-secret чатов>
```

### Опциональные

```
APP_ORIGIN=https://plus.eblusha.org
E2EE_1TO1=true
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=180d
YOUTUBE_API_KEY=<для YouTube preview>
COOKIE_SAMESITE=lax
COOKIE_DOMAIN=
COOKIE_PATH=/api
SECRET_MESSAGE_TTL_SECONDS=3600
STORAGE_ENC_V2=false
```

### Frontend (Vite, при сборке)

```
VITE_E2EE_1TO1=true
VITE_API_URL=                    # обычно пусто — берётся из origin
VITE_WS_URL=                     # обычно пусто
VITE_LIVEKIT_URL=                # если отличается от серверного
```

---

## 4. Volumes и bind mounts

### Named volumes (docker-compose.full.yml)

| Volume                  | Путь в контейнере            | Описание         |
|-------------------------|------------------------------|------------------|
| eblusha-postgres-data   | /var/lib/postgresql/data     | Данные PostgreSQL|
| eblusha-redis-data      | /data                        | RDB Redis        |

### Bind mounts

| Host path                | Контейнер                    | Описание              |
|--------------------------|------------------------------|------------------------|
| deploy/nginx-docker.conf | /etc/nginx/conf.d/default.conf | Конфиг nginx         |
| frontend/dist            | /var/www/plus.eblusha.org    | Собранный SPA         |

### Локальное хранилище (STORAGE_BACKEND=local)

При `STORAGE_BACKEND=local` файлы сохраняются в `LOCAL_STORAGE_PATH` (по умолчанию `/var/lib/eblusha/storage`):

- `LOCAL_STORAGE_PATH/uploads/<filename>.eblusha` — зашифрованные вложения
- `tmp/uploads/` — временные загрузки (multer)

Создать директорию:
```bash
sudo mkdir -p /var/lib/eblusha/storage
sudo chown -R eblusha:eblusha /var/lib/eblusha
```

---

## 5. Команды бэкапа

### PostgreSQL dump

```bash
# Имя контейнера: eblusha-postgres
docker exec eblusha-postgres pg_dump -U eblusha eblusha -Fc -f - > eblusha_backup_$(date +%Y%m%d_%H%M%S).dump

# Или если postgres на хосте:
pg_dump -U eblusha -h 127.0.0.1 eblusha -Fc -f eblusha_backup_$(date +%Y%m%d_%H%M%S).dump
```

### Восстановление PostgreSQL

```bash
docker exec -i eblusha-postgres pg_restore -U eblusha -d eblusha --clean --if-exists < eblusha_backup_YYYYMMDD_HHMMSS.dump
```

### Redis dump

Redis 7-alpine по умолчанию сохраняет RDB в `/data/dump.rdb`.

```bash
# Сохранить дамп вручную
docker exec eblusha-redis redis-cli BGSAVE

# Скопировать дамп на хост
docker cp eblusha-redis:/data/dump.rdb ./redis_dump_$(date +%Y%m%d).rdb

# Или весь volume
docker run --rm -v eblusha-redis-data:/data -v $(pwd):/backup alpine tar czf /backup/redis_data_backup.tar.gz -C /data .
```

Восстановление Redis: заменить содержимое volume или скопировать `dump.rdb` обратно в `/data/` и перезапустить Redis.

---

## 6. Порты

| Сервис  | Внутренний порт | Внешний (по умолчанию) | Переменная       |
|---------|------------------|-------------------------|-------------------|
| postgres| 5432             | 5432                    | POSTGRES_PORT     |
| redis   | 6379             | 6379                    | REDIS_PORT        |
| backend | 4000             | 4000                    | BACKEND_PORT      |
| nginx   | 80               | 80                      | HTTP_PORT         |

Для CasaOS порты можно настроить через переменные в `.env`.

---

## 7. Reverse proxy

### Nginx (текущий продакшн, на хосте)

Файл: `deploy/nginx-plus.eblusha.org.conf`

```nginx
server {
  server_name plus.eblusha.org;
  client_max_body_size 100m;
  root /var/www/plus.eblusha.org;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:4000/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /socket.io/ {
    proxy_pass http://127.0.0.1:4000/socket.io/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Nginx в Docker (deploy/nginx-docker.conf)

Прокси идёт на `http://backend:4000` вместо `127.0.0.1`.

### Caddy (ru.eblusha.org → plus.eblusha.org)

Файлы: `deploy/Caddyfile.ru.eblusha.org`, `deploy/Caddyfile.ru.eblusha.org.correct`

РФ-витрина проксирует `/api/*`, `/socket.io/*`, `/api/files/*` на plus.eblusha.org.

---

## 8. Запуск полного стека одной командой

### Подготовка

1. Скопировать репозиторий на новый сервер
2. Создать `.env` (см. п. 3)
3. **При миграции с того же хоста:** остановить systemd-сервис `eblusha` и освободить порты 4000, 5432, 6379
4. Собрать frontend:

   ```bash
   cd frontend && npm ci && npm run build
   ```

5. (Опционально) Создать volume для postgres, если его ещё нет:

   ```bash
   docker volume create eblusha-postgres-data
   ```

### Запуск

```bash
cd /opt/eblusha-plus
docker compose -f deploy/docker-compose.full.yml up -d
```

Миграции Prisma выполняются автоматически при старте backend (docker-entrypoint.sh).

### Проверка

```bash
docker compose -f deploy/docker-compose.full.yml ps
curl http://localhost/api/health
# или curl http://localhost:4000/health если nginx не используется
```

### Остановка

```bash
docker compose -f deploy/docker-compose.full.yml down
```

---

## Альтернатива: только инфраструктура (текущий режим)

Если backend и worker продолжают работать через systemd на хосте:

```bash
cd deploy
docker compose up -d
# DATABASE_URL и REDIS_URL в .env указывают на 127.0.0.1:5432 и 127.0.0.1:6379
```

---

## LiveKit

LiveKit (голос/видео) — внешний сервис. В текущей конфигурации используется `wss://voice.eblusha.org`.  
Self-hosted LiveKit (из Caddyfile.ru.eblusha.org.correct) — отдельный проект; в репозитории eblusha-plus его нет.
