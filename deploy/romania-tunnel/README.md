# Romania → SPB Reverse Tunnel (frp + sing-box)

Постоянный reverse-туннель Romania → SPB. SPB использует Romania как exit и для доступа к локальным HTTP‑сервисам.

## Архитектура

```
Romania                              SPB
────────                             ───
frpc ──────────────────────────────► frps (7000)
  │                                    │
  │ stcp:romania_socks                 visitor (frpc)
  └──► 127.0.0.1:1080                  └──► 127.0.0.1:7180 (SOCKS)

sing-box                               │
  SOCKS 127.0.0.1:1080 ──► direct      │
  (exit в интернет)                    curl --socks5 127.0.0.1:7180
                                       → трафик идёт через Romania
```

## Установка на Romania

```bash
cd /DATA/eblusha-plus/deploy/romania-tunnel
sudo bash install.sh
```

### Редактирование конфига frpc

```bash
sudo nano /etc/frp/frpc.toml
```

Заменить:
- `SPB_SERVER_IP_OR_DOMAIN` — IP или домен SPB
- `REPLACE_TOKEN` — тот же token, что и в frps на SPB
- `REPLACE_SECRET` — секрет для stcp (тот же у visitor на SPB)

### Запуск

```bash
sudo systemctl start sing-box frpc
```

## Проверка

```bash
# Romania
systemctl status sing-box
systemctl status frpc
journalctl -u frpc -f

# SPB: visitor должен показать активный туннель
systemctl status frpc   # или как назван visitor-сервис

# SPB: проверка exit через Romania
curl --socks5 127.0.0.1:7180 https://ifconfig.me
# Должен вернуться румынский IP
```

## Проксирование HTTP (nginx на Romania)

### 1. Romania: добавить в `/etc/frp/frpc.toml`

```toml
[[proxies]]
name = "romania_http"
type = "stcp"
secretKey = "REPLACE_HTTP_SECRET"
localIP = "127.0.0.1"
localPort = 80
```

### 2. SPB: visitor для HTTP

В конфиг frpc (visitor) на SPB:

```toml
[[visitors]]
name = "romania_http_visitor"
type = "stcp"
serverName = "romania_http"
secretKey = "REPLACE_HTTP_SECRET"
bindAddr = "127.0.0.1"
bindPort = 7181
```

### 3. SPB: nginx reverse proxy

```nginx
server {
    listen 443 ssl;
    server_name eblusha.chesnok.org;
    client_max_body_size 1024m;  # Без этого загрузка файлов >1MB даст 413
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    # ...
    location / {
        proxy_pass http://127.0.0.1:7181;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## Секреты (должны совпадать)

| Параметр | Romania frpc | SPB frps | SPB visitor |
|----------|--------------|----------|-------------|
| auth.token | ✓ | ✓ | ✓ |
| secretKey (stcp) | ✓ | — | ✓ |

## Файлы

| Файл | Назначение |
|------|------------|
| `config.json` | sing-box: SOCKS 1080 → direct |
| `frpc.toml` | frpc: stcp proxy к 127.0.0.1:1080 |
| `frps.toml.example` | Пример frps для SPB |
| `frpc-visitor.toml.example` | Пример visitor для SPB |
| `sing-box.service` | systemd unit sing-box |
| `frpc.service` | systemd unit frpc |
| `install.sh` | Установка sing-box и frpc |
