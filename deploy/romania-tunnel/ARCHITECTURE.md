# Romania ↔ SPB: Архитектура туннеля

## Обзор

- **SPB**: edge-сервер с публичным IP, принимает Trojan + TLS + WebSocket (config.chesnok.org:443, path /ws)
- **Romania**: домашний сервер за NAT, только исходящие соединения

## Что делает sing-box на Romania

Sing-box работает как **Trojan-клиент**:
- Инициирует исходящее соединение к SPB
- Локальный SOCKS inbound (127.0.0.1:1080) → весь трафик уходит в outbound → SPB → интернет

**Направление трафика**: Romania → SPB → Internet (forward proxy)

## Ограничение протокола Trojan

Trojan — это **forward proxy**. Клиент (Romania) инициирует запросы, сервер (SPB) их проксирует.  
**Обратное направление** (SPB → Romania) протоколом Trojan **не поддерживается**.

Для того чтобы SPB мог:
1. отправлять VPN‑трафик клиентов через Romania;
2. проксировать HTTP‑сервисы Romania (nginx, Eblusha);

нужен **reverse tunnel**. Для этого используйте **frp** или **rathole** параллельно с sing-box.

## Два сценария

### 1. Romania → Internet через SPB (sing-box)

Уже реализовано. На Romania:

```bash
# Любое приложение через SOCKS 127.0.0.1:1080
curl -x socks5://127.0.0.1:1080 https://ifconfig.me
```

### 2. SPB → Romania (reverse proxy)

Добавить **frp**:

- **Romania**: `frpc` — подключается к SPB, регистрирует HTTP/TCP‑сервисы
- **SPB**: `frps` + nginx reverse proxy к frp‑туннелю

Пример на Romania (`frpc.toml`):

```toml
serverAddr = "config.chesnok.org"
serverPort = 7000

[[proxies]]
name = "eblusha-http"
type = "tcp"
localIP = "127.0.0.1"
localPort = 80
remotePort = 8080
```

На SPB nginx проксирует, например, `eblusha.chesnok.org` → `127.0.0.1:8080` (frp remote port).

## Почему SOCKS inbound остаётся

Без inbound sing-box не получает трафик и туннель не используется. SOCKS inbound:

1. Даёт канал для keepalive (периодический `curl` через proxy)
2. Позволяет локальным приложениям выходить через SPB

Для keepalive можно настроить cron:

```bash
# /etc/cron.d/sing-box-keepalive
*/5 * * * * root curl -s -x socks5://127.0.0.1:1080 -o /dev/null --connect-timeout 5 https://1.1.1.1/ || true
```
