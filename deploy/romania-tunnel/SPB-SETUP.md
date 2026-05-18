# SPB: frps и visitor

Настройка серверной стороны frp на SPB.

## 1. frps (сервер frp)

### Установка

```bash
# Скачать frp
FRP_VERSION=$(curl -s https://api.github.com/repos/fatedier/frp/releases/latest | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" -o /tmp/frp.tar.gz
tar -xzf /tmp/frp.tar.gz -C /tmp
sudo install -m 755 /tmp/frp_${FRP_VERSION}_linux_amd64/frps /usr/local/bin/frps
```

### Конфиг /etc/frp/frps.toml

См. `frps.toml.example` — auth.token должен совпадать с Romania frpc и visitor.

Открыть порт 7000 в firewall.

### systemd: frps.service

```ini
[Unit]
Description=frp server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## 2. Visitor (frpc в режиме visitor на SPB)

Visitor — это frpc с секцией `[[visitors]]`. Он подключается к frps и создаёт локальные порты, которые проксируют в туннель.

### Установка

frpc уже устанавливается вместе с frps из того же архива.

### Конфиг /etc/frp/frpc-visitor.toml

См. `frpc-visitor.toml.example` — auth.token и secretKey должны совпадать с frps и Romania frpc.

### systemd: frpc-visitor.service

```ini
[Unit]
Description=frp visitor - Romania SOCKS tunnel
After=network-online.target frps.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frpc -c /etc/frp/frpc-visitor.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Запуск

```bash
sudo systemctl daemon-reload
sudo systemctl enable frps frpc-visitor
sudo systemctl start frps frpc-visitor
```

### Проверка

```bash
systemctl status frps
systemctl status frpc-visitor

# Активный visitor — в логах frps видны подключения
journalctl -u frps -f

# Тест exit через Romania
curl --socks5 127.0.0.1:7180 https://ifconfig.me
```
