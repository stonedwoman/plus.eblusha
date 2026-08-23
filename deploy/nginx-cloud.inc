# Eblusha Cloud — internal-локация для X-Accel-Redirect.
#
# Backend проверяет права и отвечает заголовком X-Accel-Redirect с путём вида
# /__cloud_internal/objects/ab/cd/<sha256>. Дальше файл отдаёт nginx: sendfile,
# Range, докачка и перемотка видео — всё бесплатно, Node не держит 30 ГБ в потоке.
#
# internal означает, что снаружи по этому пути попасть НЕЛЬЗЯ: nginx отвечает 404
# на любой прямой запрос. Единственный вход — редирект от авторизованного backend.
location ^~ /__cloud_internal/ {
  internal;
  alias /var/lib/eblusha/cloud/;

  # Content-Type приходит из ответа backend (он знает реальный тип файла);
  # у объектов на диске нет расширения, поэтому автоопределение по имени бесполезно.
  default_type application/octet-stream;

  # Файлы иммутабельны (имя = sha256 либо имя производного), но заголовки кэша
  # выставляет backend — здесь ничего не добавляем, чтобы не перебить приватность.
  add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;

  disable_symlinks on;
  sendfile on;
  tcp_nopush on;
}
