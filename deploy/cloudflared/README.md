# Cloudflare Tunnel для eblusha.org

Трафик на **eblusha.org** (включая `/v` и Valheim-статику) идёт через Cloudflare Tunnel (`cloudflared`) на машину, где крутится nginx с тем же `root`, что и для продакшена сайта. **Запасной вход из РФ**, если Cloudflare недоступен: оставьте отдельное имя (например `ru.eblusha.org` или прямой IP/старый frp) **вне** этого туннеля — см. раздел ниже.

## Что нужно на origin

1. Nginx (или контейнер `eblusha-nginx`) слушает HTTP **80** на `127.0.0.1` — туннель шлёт запросы на `http://localhost:80`.
2. В `server_name` указаны `eblusha.org`, `www.eblusha.org` и при необходимости `voice.eblusha.org` — см. `deploy/nginx-eblusha.org.conf` (хостовый nginx) или настройте аналог для Docker.
3. Сертификат на origin для **прямого** доступа (запасной путь) может оставаться на 443; для туннеля достаточно HTTP:80.

## Установка cloudflared (Linux)

Бинарник без `.tgz` (актуальный URL с версией в пути):

```bash
VER=$(curl -fsSL https://api.github.com/repos/cloudflare/cloudflared/releases/latest | sed -n 's/.*"tag_name": "\([^"]*\)".*/\1/p')
sudo curl -fL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${VER}/cloudflared-linux-amd64"
sudo chmod +x /usr/local/bin/cloudflared
```

## Основной способ: токен + systemd (рекомендуется)

Авторизация в Cloudflare делается **в браузере** в вашем аккаунте; на сервер кладётся только **токен коннектора**.

1. [Zero Trust Dashboard](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels** → **Create tunnel** → имя, например `eblusha-org`.
2. В шаге **Configure** добавьте **Public Hostnames** (origin на этой машине):
   - `eblusha.org` → `http://localhost:80`
   - `www.eblusha.org` → `http://localhost:80`
   - при необходимости `voice.eblusha.org` → `http://localhost:80`
3. На шаге **Install connector** скопируйте **токен** (длинная строка `eyJ...`).
4. На сервере:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp /opt/eblusha-plus/deploy/cloudflared/tunnel-token.sample /etc/cloudflared/tunnel.env
sudo chmod 600 /etc/cloudflared/tunnel.env
sudo nano /etc/cloudflared/tunnel.env   # TUNNEL_TOKEN=eyJ...
sudo cp /opt/eblusha-plus/deploy/cloudflared/eblusha-tunnel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eblusha-tunnel
sudo journalctl -u eblusha-tunnel -f
```

Публичный адрес после переключения DNS: **`https://eblusha.org`** (и `https://www.eblusha.org`).

## Альтернатива: CLI + config.yml

Нужен интерактивный `cloudflared tunnel login` (откроется ссылка в браузере) и файлы credentials:

```bash
cloudflared tunnel login
cloudflared tunnel create eblusha-org
# ~/.cloudflared/<UUID>.json
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo cp deploy/cloudflared/config.yml.example /etc/cloudflared/config.yml
# Подставьте tunnel UUID и credentials-file; в unit используйте ExecStart с --config
```

## Маршруты в Cloudflare (обязательно)

В Dashboard для туннеля добавьте **Public Hostnames**:

| Subdomain | Domain    | Service              |
|-----------|-----------|----------------------|
| `@`       | eblusha.org | `http://localhost:80` (или как в config.yml) |
| `www`     | eblusha.org | то же                |
| `voice`   | eblusha.org | то же (если используете поддомен для LiveKit) |

Либо задайте те же правила только в **локальном** `config.yml` (как в примере) и синхронизируйте с Dashboard — для чистого `tunnel run` достаточно записей в YAML + DNS.

## DNS

В Cloudflare для зоны **eblusha.org**:

- Записи **A** на старый сервер для основного домена **удалите** или отключите.
- Для туннеля создаётся **CNAME** на `<tunnel-id>.cfargotunnel.com` (часто делается автоматически при настройке Public Hostname в UI).

Прокси (оранжевое облако) для этих имён должен быть **включён** (Proxied).

Путь к бинарнику в unit: `/usr/local/bin/cloudflared`. Если пакет положил бинарник в `/usr/bin/cloudflared`, поправьте `ExecStart`.

## Запасной путь (РФ / без Cloudflare)

1. **Не** вешайте запасное имя на этот же туннель — иначе оно тоже пойдёт через CF.
2. Оставьте, например, **ru.eblusha.org** с **прямым** A/AAAA на edge (СПб) или существующий frp — как у вас сейчас для «витрины в РФ».
3. В приложении при необходимости можно переключать базовый URL (отдельная задача); документация по старой схеме: `deploy/romania-tunnel/`, `deploy/Caddyfile.ru.eblusha.org.correct`.

## HTTPS к origin вместо HTTP

Если nginx принимает только **443** с TLS:

```yaml
ingress:
  - hostname: eblusha.org
    service: https://127.0.0.1:443
    originRequest:
      noTLSVerify: true
```

(`noTLSVerify` можно убрать, если на origin валидный сертификат для localhost/SNI.)

## Секреты

Файлы `*.json` с ключами туннеля **не коммитьте**. Держите их только на сервере в `/etc/cloudflared/`.
