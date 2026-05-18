# Upload Progress Investigation — Structured Report

## === REAL UPLOAD URL PATH ===

### Dev (npm run dev)
```
Browser → http://localhost:5173/api/upload (same-origin)
       → Vite proxy (http-proxy) → http://localhost:4000/api/upload
       → Express (Node.js)
```

### Production (eblusha.org)
```
Browser → https://eblusha.org/api/upload (same-origin)
       → nginx (proxy_pass http://127.0.0.1:4000/api/)
       → Express (Node.js)
```

### Production (ru.eblusha.org — EU mirror)
```
Browser → https://ru.eblusha.org/api/upload (same-origin)
       → Caddy reverse_proxy → https://eblusha.org/api/*
       → nginx on eblusha.org → http://127.0.0.1:4000/api/upload
       → Express (Node.js)
```

**Exact URL used in XHR:** `getUploadUrl()` returns `baseURL + '/upload'`:
- Default: `/api/upload` (relative, same-origin)
- With `VITE_API_URL` (absolute): e.g. `https://eblusha.org/api/upload` — cross-origin only if `VITE_ALLOW_CROSS_ORIGIN_API` is truthy and origin differs

---

## === WHAT SHOULD TRIGGER PROGRESS EVENTS ===

1. **Browser:** When XHR sends `FormData` with `Blob`/`File`, the browser streams the multipart body. `xhr.upload.onprogress` fires as bytes are handed off to the network stack (TCP send buffer).

2. **Progress events:** Each event has `loaded` (bytes sent), optionally `total` (if `Content-Length` known). For multipart with known Blob size, `total` is typically known.

3. **Expected cadence:** Browser may fire progress many times during transfer (e.g. every ~50–100ms or per TCP segment). Throttle of 80ms in our code batches updates but does not block events.

4. **Critical:** Progress fires based on **browser → network** progress. Downstream (proxy, backend) buffering does **not** prevent progress — the browser does not wait for the server to read.

---

## === WHERE EVENTS ARE LIKELY LOST ===

| Layer | Risk | Notes |
|-------|------|-------|
| **Vite proxy (dev)** | **HIGH** | Known issues: POST body not always forwarded; >1MB can cause ECONNRESET. If proxy buffers or misbehaves, upload may complete but progress could be erratic. Also, Vite uses http-proxy — its `proxyReq`/`data` handling can affect streaming. |
| **Caddy (ru.eblusha.org)** | Low | Default `reverse_proxy` streams. No known buffering. |
| **nginx (eblusha.org)** | None | `proxy_request_buffering off` explicitly set. |
| **Express/multer** | None | multer uses busboy (streaming). `express.json`/`urlencoded` skip multipart. |
| **Browser** | Unlikely | Same-origin, native XHR. Blob in FormData is streamed, not fully buffered. |
| **Frontend throttle 80ms** | Low | Only reduces UI updates; events still fire. If events never fire, throttle is irrelevant. |

**Most likely point:** Vite dev proxy (http-proxy) in development. In production, nginx and Caddy are configured for streaming; Vite is not in the path.

---

## === CODE-LEVEL RISKS ===

1. **`uploadBlob.size` vs `e.total`:** We use `uploadBlob.size` as total. If Blob is empty or corrupted, `uploadTotal` could be 0 → `uploadFrac` NaN or 1, causing odd behavior. Logging confirms `blobSize`.

2. **Throttle `now - lastProgressMs >= 80`:** If progress fires only 1–2 times (e.g. start + end), we still call `reportProgress(uploadFrac)` for `uploadFrac >= 1` and on each event. No events = no updates.

3. **`setAttachProgress` / `setPendingByConv`:** Both run on each `updateProgress`. No reset between files for `attachProgress` — it’s cumulative across the loop. Next file’s prep phase does `updateProgress(...)` which overwrites. No bug here.

4. **Progress bar binding:** `width: ${attachProgress}%` — direct. If `attachProgress` stays at 30, the bar stays at 30.

5. **`reportProgress(1)` in `onreadystatechange`:** When status 200–299, we force 100%. So even with zero `onprogress` events, we should see a jump to 100% at the end. If the bar stays at 30% until completion, either (a) `onreadystatechange` runs late, or (b) component unmounts/resets before it, or (c) upload fails before readyState 4.

6. **Multiple files:** Per-file `updateProgress` uses `basePct`/`uploadRange`. For file 1: basePct=0, uploadRange=30. For file 2: basePct=30, uploadRange=30, etc. Logic is sound.

---

## === ENVIRONMENT / PROXY RISKS ===

### Vite proxy (dev)
- Uses `http-proxy`. Known problems: POST body sometimes not forwarded; large payloads (>1MB) can trigger ECONNRESET.
- If the proxy buffers the request before forwarding, the browser still sends bytes to Vite; progress should fire. The risk is connection reset or timeout, not missing progress.
- **Real risk:** Proxy bugs could cause connection instability, retries, or early termination — which might look like “stuck” progress.

### Caddy (ru.eblusha.org)
- `reverse_proxy https://eblusha.org` — standard streaming. No buffering config.
- Possible extra latency for double hop (ru → eblusha.org → nginx → backend).

### nginx
- `proxy_request_buffering off` — request body streamed to backend.
- `client_max_body_size 1024m` — large uploads allowed.

### Express
- `express.json` (10mb limit) and `express.urlencoded` — only for `application/json` and `x-www-form-urlencoded`. Multipart is not consumed.
- `authenticate` — reads headers, not body.
- `rateLimit` — Redis only, no body read.
- `upload.single("file")` — multer streams via busboy.

---

## === DIAGNOSTIC LOG PLAN ===

Логи уже добавлены (только при `import.meta.env.DEV`). Места и смысл:

| Location | Log | Proves |
|----------|-----|--------|
| Before `xhr.open` | `[upload] xhr opened` `{ url, origin, blobSize }` | URL, same/cross-origin, размер тела |
| Before `xhr.send` | `[upload] xhr.send(form) about to send` `{ formDataKeys, blobSize }` | Момент старта отправки |
| `xhr.upload.onprogress` | `[upload] onprogress` `{ loaded, total, uploadFrac, lengthComputable, eventNum, ts }` | **Ключевой:** приходят ли события, как часто, рост `loaded` |
| `reportProgress` | `[upload] reportProgress` `{ uploadFrac, pct, basePct, uploadRange }` | Что реально уходит в UI |
| `onreadystatechange` when readyState=4 | `[upload] readyState 4` `{ status, progressEventsReceived }` | Итог: сколько событий progress было, статус ответа |

**Опционально — в компоненте progress bar:** Добавить `useEffect` на `attachProgress`:
```ts
useEffect(() => {
  if (import.meta.env?.DEV && attachUploading && attachProgress > 0) {
    console.debug('[upload] attachProgress→UI', { attachProgress })
  }
}, [attachProgress, attachUploading])
```
Это докажет, что React получает обновления и что `attachProgress` доходит до рендера.

**Интерпретация:**
- `progressEventsReceived` = 0 или 1–2 → события не приходят или почти не приходят (проблема на уровне браузера/прокси).
- `progressEventsReceived` растёт, но `reportProgress` не вызывается часто → throttle или условие `uploadFrac >= 1 || now - lastProgressMs >= 80`.
- `reportProgress` вызывается часто, но бар не двигается → проблема в `setAttachProgress` / React.

---

## === MOST LIKELY ROOT CAUSE ===

**Primary hypothesis: Vite dev proxy (http-proxy) ведёт себя нестабильно при streaming multipart upload.**

**Аргументы:**
1. В dev путь идёт через Vite proxy; в проде — нет.
2. Известные баги Vite/http-proxy: POST body, большие тела, ECONNRESET.
3. nginx и Caddy настроены на стриминг; Vite — нет.
4. `xhr.upload.onprogress` должен срабатывать на стороне браузера при отдаче байт в сокет; прокси «впереди» не должен это блокировать. Исключение — если прокси ломает соединение, вызывает повторы или задерживает ответ так, что таймаут срабатывает раньше.
5. Альтернатива: браузер даёт очень мало progress events для конкретного размера/типа запроса. Логи `eventNum` и `ts` подтвердят или опровергнут.

**Чтобы сузить причину:**
- Сравнить логи в dev (Vite proxy) и в production build (nginx/Caddy, без Vite).
- Если в проде `progressEventsReceived` нормальное, а в dev — нет, виноват Vite proxy.
- Если и в проде мало событий — смотреть браузер, размер файла, Content-Length vs chunked.

---

## === BROWSER PROGRESS FOR MULTIPART BLOB XHR ===

**Вопрос:** Может ли браузер показывать upload progress для multipart/form-data с большим Blob в XHR в нашей схеме?

**Ответ:** Да, может. Same-origin XHR с FormData и Blob/File — стандартный сценарий. `xhr.upload.onprogress` обязан поддерживаться.

**Ограничения:**
- Cross-origin: нужны CORS и `withCredentials` при необходимости. У нас same-origin.
- Service worker / fetch interceptors: у нас нет.
- Прокси между браузером и backend: теоретически не мешают progress (события на стороне клиента). Практически — нестабильность прокси может влиять на соединение.
- Итог: архитектура не должна делать real progress «ненадёжным по определению». Проблема скорее в конкретной реализации (Vite dev proxy) или в редких progress events со стороны браузера.
