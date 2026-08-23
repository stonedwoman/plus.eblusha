import { z } from "zod";

/**
 * Конфигурация Eblusha Cloud. Держим отдельно от src/config/env.ts, чтобы модуль
 * оставался самодостаточным и его отключение/переезд не задевали мессенджер.
 *
 * Все лимиты — в переменных окружения, ничего не зашито в код: диск на этом
 * сервере ~936 ГБ, под Cloud выделяем часть с обязательным резервом (см. README).
 */

const bytes = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (!v?.trim()) return fallback;
      const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/i.exec(v.trim());
      if (!m) return fallback;
      const n = Number(m[1]);
      const unit = (m[2] || "").toLowerCase();
      const mul =
        unit.startsWith("t") ? 1024 ** 4 : unit.startsWith("g") ? 1024 ** 3 : unit.startsWith("m") ? 1024 ** 2 : unit.startsWith("k") ? 1024 : 1;
      return Math.floor(n * mul);
    });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : /^(1|true|yes|on)$/i.test(v.trim())));

const schema = z.object({
  CLOUD_ENABLED: bool(true),
  /// Корень физического хранилища: objects/ derived/ staging/ tmp/
  CLOUD_STORAGE_ROOT: z.string().default("/var/lib/eblusha/cloud"),
  /// Потолок логической квоты оригиналов
  CLOUD_STORAGE_MAX_BYTES: bytes(550 * 1024 ** 3),
  /// Ниже этого свободного места на ФС новые загрузки отклоняются (507)
  CLOUD_STORAGE_MIN_FREE_BYTES: bytes(80 * 1024 ** 3),
  /// Мягкий потолок кэша производных файлов; чистится maintenance-джобой
  CLOUD_DERIVED_CACHE_MAX_BYTES: bytes(60 * 1024 ** 3),
  CLOUD_MAX_FILE_BYTES: bytes(64 * 1024 ** 3),
  CLOUD_SESSION_TTL_DAYS: z.coerce.number().default(30),
  CLOUD_AUTH_CODE_TTL_SECONDS: z.coerce.number().default(120),
  CLOUD_SHARE_SESSION_TTL_HOURS: z.coerce.number().default(12),
  /// Сколько живёт незавершённая загрузка, если её не трогают
  CLOUD_UPLOAD_TTL_HOURS: z.coerce.number().default(24 * 14),
  CLOUD_TRASH_RETENTION_DAYS: z.coerce.number().default(30),
  /// Отдача файлов через nginx X-Accel-Redirect (см. deploy/nginx-cloud.inc)
  CLOUD_XACCEL: bool(true),
  CLOUD_XACCEL_PREFIX: z.string().default("/__cloud_internal/"),
  /// Кто видит /cloud/admin/storage: логины Еблуши через запятую
  CLOUD_ADMIN_USERNAMES: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    ),
  CLOUD_IMAGE_CONCURRENCY: z.coerce.number().default(2),
  CLOUD_VIDEO_CONCURRENCY: z.coerce.number().default(1),
  /// Жёсткие таймауты внешних процессов (недоверенный контент!)
  CLOUD_FFMPEG_TIMEOUT_MS: z.coerce.number().default(2 * 60 * 60 * 1000),
  CLOUD_FFPROBE_TIMEOUT_MS: z.coerce.number().default(60_000),
  CLOUD_IMAGE_TIMEOUT_MS: z.coerce.number().default(120_000),
  /// Тайлы карты — провайдер настраивается, по умолчанию OSM
  CLOUD_MAP_TILE_URL: z.string().default("https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
  CLOUD_MAP_ATTRIBUTION: z.string().default("© OpenStreetMap"),
  /// Публичный origin для построения ссылок (QR, share). По умолчанию — из запроса.
  CLOUD_PUBLIC_BASE_URL: z.string().optional(),
  /// Префикс путей UI. Пусто — домен отдан Cloud целиком (eblusha.cloud/space/…),
  /// "/cloud" — Cloud живёт рядом с мессенджером (eblusha.org/cloud/space/…).
  /// Влияет на генерацию share- и join-ссылок.
  CLOUD_PUBLIC_PATH_PREFIX: z
    .string()
    .default("/cloud")
    .transform((v) => v.replace(/\/+$/, "")),
  /// Origin мессенджера — туда Cloud отправляет браузер за одноразовым кодом,
  /// когда живёт на отдельном поддомене (там лежит сессия Еблуши).
  CLOUD_MESSENGER_ORIGIN: z.string().default("https://eblusha.org"),
  /// Origin'ы, на которые разрешено возвращать код авторизации. Пусто = только
  /// относительные пути внутри текущего домена (режим одного origin).
  /// Это защита от open redirect: неизвестный origin не получит код никогда.
  CLOUD_ALLOWED_REDIRECT_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean)
    ),
});

const parsed = schema.parse(process.env);

export const cloudConfig = {
  ...parsed,
  THUMB_MAX: 512,
  PREVIEW_MAX: 2048,
  /// Максимальная длинная сторона web-версии видео
  PLAYBACK_MAX_HEIGHT: 1080,
  UPLOAD_CHUNK_LIMIT_BYTES: 512 * 1024 * 1024,
} as const;

export type CloudConfig = typeof cloudConfig;
export default cloudConfig;
