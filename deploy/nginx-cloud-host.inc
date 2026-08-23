# Локации отдельного поддомена cloud.eblusha.org.
#
# Отличается от eblusha.org намеренно: здесь НЕТ лендинга, /updates/, /game/ и
# прочего хозяйства мессенджера. Только SPA Cloud, его API, сокет и internal-
# локация отдачи файлов. Меньше поверхность — меньше поводов для сюрпризов.
#
# Подключается из nginx-docker.conf в server-блоках с server_name cloud.eblusha.org.

client_max_body_size 0;      # размер загрузки ограничивает Cloud (CLOUD_MAX_FILE_BYTES), а не nginx
add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;

open_file_cache off;

# Корень поддомена — сразу в приложение.
# absolute_redirect off: за тоннелем nginx видит схему http и без этого построил
# бы Location: http://cloud.eblusha.org/cloud, роняя схему на один лишний хоп.
# Относительный Location браузер достраивает сам, оставаясь на https.
absolute_redirect off;
location = / { return 302 /cloud; }

# Отдача файлов Cloud: backend проверяет права и отвечает X-Accel-Redirect,
# дальше nginx сам делает sendfile/Range. Снаружи путь недоступен (internal).
include /etc/nginx/conf.d/eblusha-cloud.inc;

location /api/ {
  set $backend_host backend:4000;
  proxy_pass http://$backend_host$request_uri;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  # Многочасовые загрузки: короткие таймауты рвали бы их на ровном месте.
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  # Без буферизации тела: чанки tus должны доезжать до backend потоком, а не
  # оседать во временном файле nginx целиком.
  proxy_request_buffering off;
  proxy_buffering off;
}

location /socket.io/ {
  set $backend_host backend:4000;
  proxy_pass http://$backend_host$request_uri;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 3600s;
}

# Админка мессенджера снаружи не светится и здесь тоже.
location = /admin.html { return 404; }
location ^~ /api/admin/ { return 404; }

# Статика SPA: хешированные ассеты кэшируем надолго, index.html — никогда.
location ^~ /assets/ {
  root /var/www/eblusha.org;
  access_log off;
  add_header Cache-Control "public, max-age=31536000, immutable" always;
  try_files $uri =404;
}

# Шрифты и иконки лежат в public/ мессенджера — переиспользуем, не копируя.
location ^~ /fonts/ {
  root /var/www/eblusha.org-public;
  add_header Cache-Control "public, max-age=2592000" always;
  try_files $uri =404;
}

location / {
  root /var/www/eblusha.org;
  add_header Cache-Control "no-cache, must-revalidate" always;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
  try_files $uri /index.html;
}
