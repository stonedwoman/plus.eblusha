# Cloudflare Tunnel для eblusha.org

Трафик на **eblusha.org** (включая `/v` и Valheim-статику) идёт через Cloudflare Tunnel (`cloudflared`) на машину, где крутится nginx с тем же `root`, что и для plus. **Запасной вход из РФ**, если Cloudflare недоступен: оставьте отдельное имя (например `ru.eblusha.org` или прямой IP/старый frp) **вне** этого туннеля — см. раздел ниже.

## Что нужно на origin

1. Nginx слушает HTTP **80** (рекомендуется для туннеля: TLS заканчивается на Cloudflare, до origin — HTTP на localhost).
2. В `server_name` указаны `eblusha.org`, `www.eblusha.org` и при необходимости `voice.eblusha.org` — см. `deploy/nginx-plus.eblusha.org.conf` в репозитории.
3. Сертификат Let’s Encrypt на origin для **прямого** доступа (запасной путь) можно оставить на 443; туннель использует **только** то, что указано в `config.yml` (обычно `http://127.0.0.1:80`).

## Установка cloudflared (Linux)

```bash
# Актуальная версия: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
```

## Создание туннеля и credentials

Вариант A — через [Zero Trust Dashboard](https://one.dash.cloudflare.com/): **Networks → Tunnels → Create** → выбрать тип **Cloudflared** → скопировать команду установки и токен/файл credentials.

Вариант B — CLI (нужен API Token с правами на Tunnel + DNS):

```bash
cloudflared tunnel login
cloudflared tunnel create eblusha-org
# Запомните UUID туннеля; появится файл ~/.cloudflared/<UUID>.json
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo cp deploy/cloudflared/config.yml.example /etc/cloudflared/config.yml
# Отредактируйте: tunnel, credentials-file, при необходимости service URL
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

## Запуск systemd

```bash
sudo cp /opt/eblusha-plus/deploy/cloudflared/eblusha-tunnel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eblusha-tunnel
sudo journalctl -u eblusha-tunnel -f
```

Путь к бинарнику: при установке через пакет может быть `/usr/bin/cloudflared` — поправьте `ExecStart` в unit.

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
