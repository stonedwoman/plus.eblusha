# SSL-сертификаты для stoned.local

Самоподписанный сертификат для HTTPS (getUserMedia требует secure context).

## Регенерация

```bash
cd deploy/certs
openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout key.pem -out cert.pem \
  -config openssl-san.cnf -extensions v3_req
```

При смене IP добавьте его в `openssl-san.cnf` в `[alt_names]`.
