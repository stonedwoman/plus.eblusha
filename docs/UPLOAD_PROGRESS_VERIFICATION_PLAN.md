# Upload Progress — Verification Test Plan

Финальная верификация гипотезы: основной подозреваемый — Vite dev proxy.

---

## 1. План проверки по средам

| # | Среда | Запрос идёт через | Цель |
|---|-------|------------------|------|
| 1 | Dev (Vite) | Browser → Vite proxy (http-proxy) → Backend | Есть ли проблема при Vite proxy |
| 2 | Local production build | Browser → Backend напрямую | Исключить Vite — проблема исчезает? |
| 3 | Production (eblusha.org / ru) | Browser → nginx/Caddy → Backend | Реальное окружение — есть ли проблема |

---

## 2. Запуск каждой среды

### Среда 1: Dev через Vite proxy

**Терминал A (backend):**
```bash
cd /DATA/eblusha-plus
npm run dev
```
Backend на `http://localhost:4000`.

**Терминал B (frontend):**
```bash
cd /DATA/eblusha-plus/frontend
npm run dev
```
Vite на `http://localhost:5173`. Proxy: `/api` → `http://localhost:4000`.

**Действия:** Открыть `http://localhost:5173`, войти, отправить файл (вложение).  
**Путь запроса:** `localhost:5173/api/upload` → Vite proxy → `localhost:4000/api/upload`.

---

### Среда 2: Local production build без Vite proxy

**Важно:** При порте ≠ 5173 `computeApiBaseUrl()` отдаёт `http://localhost:4000/api`, запросы идут напрямую в backend, без Vite proxy.

**Терминал A (backend):**
```bash
cd /DATA/eblusha-plus
npm run build
npm run start
```
Backend на `http://localhost:4000`.

**Терминал B (frontend — build + preview):**
```bash
cd /DATA/eblusha-plus/frontend
npm run build
npm run preview
```
`vite preview` по умолчанию слушает порт 4173. Приложение берёт `baseURL = http://localhost:4000/api` (порт ≠ 5173).

**Действия:** Открыть `http://localhost:4173`, войти, отправить файл.  
**Путь запроса:** `localhost:4173` → XHR к `http://localhost:4000/api/upload` напрямую. Vite proxy не участвует.

**Альтернатива (Docker):** Полный стек как в production:
```bash
cd /DATA/eblusha-plus
# frontend уже собран
docker compose -f deploy/docker-compose.full.yml --env-file .env up -d
```
Открыть `https://localhost` или `https://stoned.local` (если настроен). Путь: nginx → backend. Vite proxy не участвует.

---

### Среда 3: Production

**Действия:** Открыть `https://eblusha.org` или `https://ru.eblusha.org`, войти, отправить файл.

**Путь (eblusha.org):** `eblusha.org/api/upload` → nginx → `127.0.0.1:4000`.  
**Путь (ru):** `ru.eblusha.org/api/upload` → Caddy → `eblusha.org` → nginx → backend.

---

## 3. Логи и их интерпретация

Логи выводятся только в dev (`import.meta.env.DEV`). В production build `import.meta.env.DEV === false` — логов нет.

**Среда 1 (dev):** логи в DevTools Console.  
**Среда 2 (preview):** `vite preview` — production build, логов нет.  
**Среда 3 (production):** логов нет.

**Для среды 2 и 3** нужен dev build с логами. Вариант: временно заменить проверку на `true` (всегда логировать) или использовать отдельный флаг `VITE_DEBUG_UPLOAD=true` и логировать по нему. В рамках этого плана предполагаем, что в средах 2 и 3 логи недоступны, и фокус — на визуальном поведении progress bar. Для полноты можно один раз запустить dev build на порту 4173 (через кастомную конфигурацию preview или `npm run dev` с `port: 4173` и без proxy) — тогда логи будут. Ниже описан случай, когда логи есть (среда 1) или когда добавлен универсальный флаг.

### `[upload] xhr opened`

```
{ url, origin, blobSize }
```

- **url:** фактический URL запроса (`/api/upload` или `http://localhost:4000/api/upload`).
- **origin:** `window.location.origin` (страница).
- **blobSize:** размер тела запроса.

**Интерпретация:** Подтверждает same-origin/cross-origin и размер файла.

---

### `[upload] xhr.send(form) about to send`

```
{ formDataKeys, blobSize }
```

**Интерпретация:** Момент начала отправки. Должен идти сразу после `xhr opened`.

---

### `[upload] onprogress`

```
{ loaded, total, uploadFrac, lengthComputable, eventNum, ts }
```

- **loaded:** отправлено байт.
- **total:** `uploadBlob.size`.
- **uploadFrac:** `loaded / total` (0–1).
- **eventNum:** счётчик вызовов (1, 2, 3, …).
- **ts:** `Date.now()`.

**Интерпретация:**
- Рост `eventNum` → события приходят.
- Рост `loaded` → прогресс есть.
- `eventNum` 0–2 и затем только `readyState 4` → события почти не приходят.
- `eventNum` ≥ 10 при файле >1 MB → нормальное поведение.

---

### `[upload] reportProgress`

```
{ uploadFrac, pct, basePct, uploadRange }
```

**Интерпретация:** Обновления, уходящие в UI (через `updateProgress`). Если `onprogress` вызывается часто, а `reportProgress` редко — срабатывает throttle 80 ms (ожидаемо).

---

### `[upload] readyState 4`

```
{ status, progressEventsReceived }
```

- **status:** HTTP status.
- **progressEventsReceived:** сколько раз вызвался `onprogress` за весь upload.

**Интерпретация:**
- `progressEventsReceived === 0` → событий не было.
- `progressEventsReceived` 1–2 → почти нет промежуточных событий.
- `progressEventsReceived` ≥ 10 → промежуточные события есть.

---

## 4. Таблица сравнения

| Environment | File size | progressEventsReceived | Промежуточные onprogress? | Progress bar |
|-------------|-----------|-------------------------|---------------------------|--------------|
| Dev (Vite proxy) | _____ MB | _____ | да / нет | плавно / зависал |
| Local prod (no Vite) | _____ MB | _____ (или N/A) | да / нет | плавно / зависал |
| Production | _____ MB | N/A (нет логов) | ? | плавно / зависал |

Рекомендуемые размеры для тестов:
- ~2–5 MB
- ~20–50 MB (если доступно)

---

## 5. Критерии вывода

### Виновен Vite proxy

- В **среде 1** (dev): `progressEventsReceived` 0–2, progress bar висит на ~30%.
- В **среде 2** (local prod): progress bar идёт плавно.
- В **среде 3** (production): progress bar идёт плавно.

Вывод: проблема только в dev с Vite proxy.

---

### Продолжать в production path

- В **среде 2** (local prod) и/или **среде 3** (production): progress bar по-прежнему зависает.

Вывод: причина не в Vite proxy. Искать дальше: nginx/Caddy, браузер, размер/тип файла.

---

### Неоднозначно

- В **среде 1**: progress bar работает.
- В **среде 2/3** не проверяли.

Нужно повторить тесты в средах 2 и 3.

---

## 6. Пошаговый порядок тестов

1. **Подготовка:** backend на 4000, база и .env настроены.
2. **Среда 1:**  
   - Запустить `npm run dev` (backend) и `cd frontend && npm run dev` (frontend).  
   - Открыть http://localhost:5173, войти.  
   - Включить Console (F12).  
   - Выбрать файл 3–5 MB.  
   - Нажать «Отправить».  
   - Записать: `progressEventsReceived` из `[upload] readyState 4`, было ли много `[upload] onprogress`, как вёл себя progress bar.
3. **Среда 2:**  
   - `npm run build && npm run start` (backend).  
   - `cd frontend && npm run build && npm run preview` (frontend).  
   - Открыть http://localhost:4173, войти.  
   - Повторить upload того же файла.  
   - Записать поведение progress bar (логи в production build по умолчанию нет).
4. **Среда 3:**  
   - Открыть production (`https://eblusha.org` или `ru.eblusha.org`).  
   - Повторить upload того же файла.  
   - Записать поведение progress bar.
5. **Сравнение:** заполнить таблицу из п. 4.
6. **Вывод:** применить критерии из п. 5.

---

## Включение логов в local prod / production

Логи работают при любом из условий:

- **Vite dev** — всегда включены (`import.meta.env.DEV`)
- **localStorage:** `localStorage.setItem('eblushaUploadDebug', '1')` в Console, затем перезагрузить страницу
- **Query param:** открыть `http://localhost:4173/?uploadDebug=1` (или `https://eblusha.org/?uploadDebug=1`)

**Отключить:**
- `localStorage.removeItem('eblushaUploadDebug')` и перезагрузить
- Убрать `?uploadDebug=1` из URL
