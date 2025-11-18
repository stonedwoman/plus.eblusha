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
```

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




