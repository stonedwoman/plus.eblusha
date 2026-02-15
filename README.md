## Eblusha Plus (server)

### Smoke tests

- **`npm run smoke`**: starts **Redis** via `docker-compose.smoke.yml`, waits for healthcheck, runs `npm run smoke:test`, then tears Redis down (set `SMOKE_KEEP=1` to keep containers running).
- Smoke runner is **host-based**: Redis is expected at `REDIS_URL=redis://127.0.0.1:6379` and Postgres at `DATABASE_URL=postgresql://eblusha:eblusha@127.0.0.1:5433/eblusha_smoke`.

### Realtime rooms (Socket.IO)

- **User room**: `user:{userId}` (joined after socket auth; used for direct events).
- **Device room**: `device:{deviceId}` (joined only if deviceId is **verified** in DB for the current user).
  - Source of deviceId: JWT claim `did` (if present) or `handshake.auth.deviceId` (verified).
  - `handshake.query.deviceId` is **disabled by default**; can be enabled only in dev with `ALLOW_DEVICE_QUERY=true`.

### Metrics endpoint

- `GET /api/status/metrics` is protected by **`METRICS_TOKEN`**:
  - Send header `Authorization: Bearer <METRICS_TOKEN>`.
  - In production, `METRICS_TOKEN` is required (server will refuse to start without it).

