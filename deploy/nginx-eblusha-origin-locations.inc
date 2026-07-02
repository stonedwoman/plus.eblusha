# Shared locations for eblusha.org / www / voice (Romania origin, noindex).
# Included from nginx-docker.conf and nginx-eblusha.org.conf.

client_max_body_size 1024m;

add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;

sub_filter_once on;
sub_filter '<head>' '<head><meta name="robots" content="noindex,nofollow,noarchive,nosnippet">';

# Приём диагностических логов Android-клиента HUILA (кнопка «Отправить логи Роману»).
# PUT /updates/vpn/logs/<имя>.txt → пишется в отдельный writable-том vpn-logs.
# Защищено общим токеном (зашит в apk) — отсекает случайный/спам-доступ. GET запрещён:
# логи читаем только с хоста (/DATA/eblusha-plus/vpn-logs). Отдельный том, т.к. /updates
# смонтирован read-only. client_body_temp_path на том же томе — иначе dav rename() падает
# (cross-device link) между client_temp в образе и bind-mount тома.
location ^~ /updates/vpn/logs/ {
  if ($http_x_eblusha_logs != "f947d1a91f4a11a24a5c51a1c0885328") { return 403; }
  limit_except PUT { deny all; }
  client_max_body_size 15m;
  client_body_temp_path /var/www/vpn-logs/.tmp;
  dav_methods PUT;
  create_full_put_path on;
  alias /var/www/vpn-logs/;
}

# Каталог обновлений: файлы + браузерный листинг (autoindex) любых подпапок на любой
# глубине. Раздаётся напрямую из bind mount public/updates — новое видно сразу, без
# reload. Без try_files: для папки без слеша nginx сам отдаёт 301 на $uri/, иначе
# относительные ссылки в листинге ломаются. ^~ /updates/vpn/logs/ выше — более длинный
# префикс, перехват логов работает как раньше. Права: default ACL на дереве (g:101:rX).
location ^~ /updates/ {
  root /var/www/eblusha.org-public;
  charset utf-8;
  autoindex on;
  autoindex_exact_size off;
  autoindex_localtime on;
  add_header Cache-Control "no-cache, must-revalidate" always;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
}

location = /admin.html { return 404; }
location ^~ /api/admin/ { return 404; }

location = /robots.txt {
  root /var/www/eblusha.org-public;
  default_type text/plain;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
  try_files /robots.txt =404;
}

location = /sitemap.xml { return 404; }
location = /sitemap_index.xml { return 404; }
location ~* ^/sitemap[^/]*\.xml$ { return 404; }

error_page 404 /404.html;
location = /404.html {
  root /var/www/eblusha.org-public;
  add_header Cache-Control "no-cache, must-revalidate" always;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
}

location = /v/index.html {
  root /var/www/eblusha.org-public;
  add_header Cache-Control "no-store, no-cache, must-revalidate" always;
  add_header Pragma "no-cache" always;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
  try_files $uri =404;
}

open_file_cache off;

location = / {
  root /var/www/eblusha.org-public;
  add_header Cache-Control "no-cache, must-revalidate" always;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
  try_files /index.html @spa;
}

location / {
  root /var/www/eblusha.org-public;
  add_header Cache-Control "no-cache, must-revalidate" always;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
  try_files $uri $uri/index.html @spa;
}

location @spa {
  root /var/www/eblusha.org;
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
  try_files $uri $uri/ /index.html;
}

location ^~ /api/valheim-join-code/ {
  rewrite ^/api/valheim-join-code/(.*)$ /$1 break;
  proxy_pass http://172.17.0.1:9876;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 120s;
}

location /api/ {
  set $backend_host backend:4000;
  proxy_pass http://$backend_host$request_uri;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  proxy_request_buffering off;
  proxy_buffering off;
}

location /api/voice/ {
  set $livekit_host livekit:7880;
  rewrite ^/api/voice(/.*)$ $1 break;
  proxy_pass http://$livekit_host;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
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
}
