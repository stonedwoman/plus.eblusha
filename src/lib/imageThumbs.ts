import sharp from "sharp";

/**
 * Превью картинок чата: ОДНО место, где живут и формула ключа, и геометрия.
 *
 * Раньше формула ключа была скопирована в три файла (routes/upload.ts,
 * routes/files.ts, scripts/backfillImageThumbnails.ts) с комментарием «ДОЛЖЕН
 * совпадать с…» — копии успели разъехаться, и часть превью оказалась
 * недостижима с отдачи. Импортируйте отсюда, не копируйте.
 */

/** Деривативный ключ превью. Кладётся РЯДОМ с оригиналом, оригинал не трогается. */
export const deriveThumbKey = (key: string): string =>
  key.endsWith(".eblusha") ? key.replace(/\.eblusha$/, ".thumb.eblusha") : `${key}.thumb`;

/**
 * Геометрия. Как превью показывают клиенты:
 *   ПК (Eblusha.Desktop)  — плитка мозаики и одиночное фото укладываются
 *                           в 480x528 точек при масштабе 100 %;
 *   веб (ChatMessageRow)  — бабл не шире доли экрана, высота ограничена
 *                           0.6–0.75 от неё, плюс лента миниатюр лайтбокса;
 *   Android (ChatScreen)  — пузырь/плитка альбома; полноэкранный просмотр
 *                           берёт ОРИГИНАЛ, превью там лишь заглушка.
 *
 * 720 по ширине и 1280 по высоте — ровно то, что давал прежний ffmpeg
 * (`scale='min(720,iw)':-2`, высота не ограничивалась вовсе), только с
 * потолком для панорам. Геометрия та же → средний размер превью остаётся
 * прежним (замер по 153 живым превью на диске: 57.9 КБ).
 */
export const THUMB_MAX_WIDTH = 720;
export const THUMB_MAX_HEIGHT = 1280;
export const THUMB_JPEG_QUALITY = 78;
/** Для превью с прозрачностью (PNG с палитрой) — см. renderImageThumb. */
export const THUMB_PNG_QUALITY = 80;

/**
 * 80 Мп: снимок с телефона (5712x4284 = 24 Мп) проходит с запасом, а
 * «бомба» из миллиарда пикселей не съедает память живого сервера.
 */
export const THUMB_MAX_INPUT_PIXELS = 80_000_000;

/** Больше этого в память не читаем: превью не стоит риска OOM. */
export const THUMB_MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export type RenderedThumb = {
  data: Buffer;
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  srcFormat: string;
  /** Чем отдавать превью: `image/jpeg` обычно, `image/png` — если есть прозрачность. */
  contentType: "image/jpeg" | "image/png";
};

const sharpOpts = { limitInputPixels: THUMB_MAX_INPUT_PIXELS, failOn: "none" } as const;

/**
 * Реально ли картинка ПОЛЬЗУЕТСЯ прозрачностью.
 *
 * Сам альфа-канал ничего не значит: в архиве 218 скриншотов несут RGBA, который целиком
 * непрозрачен, — таким JPEG не вредит. А вот у стикера с прозрачным фоном JPEG зальёт
 * фон ЧЁРНЫМ, и в ленте вместо картинки будет чёрный прямоугольник. Различаем по
 * минимуму альфа-канала: 255 — прозрачных пикселей нет вовсе.
 */
async function usesTransparency(input: Buffer): Promise<boolean> {
  try {
    const stats = await sharp(input, sharpOpts).stats();
    const alpha = stats.channels[3];
    return Boolean(alpha) && (alpha!.min ?? 255) < 255;
  } catch {
    // Не смогли посчитать — считаем непрозрачной: JPEG меньше и это прежнее поведение.
    return false;
  }
}

/**
 * Сжать картинку в превью. Возвращает null, если это не картинка или размеров
 * нет — бросать наружу нечего, вызывающий просто пропустит объект.
 *
 * Для шифротекста секретного чата (мы его сюда не пускаем, но на всякий) sharp
 * не опознает формат и бросит — E2EE не расшифровывается и расшифрован быть не может.
 */
export async function renderImageThumb(input: Buffer): Promise<RenderedThumb | null> {
  const meta = await sharp(input, sharpOpts).metadata();
  if (!meta.width || !meta.height) return null;

  // Лишний проход делаем только там, где он может что-то изменить: альфа-канала нет —
  // и считать нечего.
  const transparent = meta.hasAlpha === true && (await usesTransparency(input));

  const resized = sharp(input, sharpOpts)
    // .rotate() без аргумента = применить EXIF-ориентацию. Без неё превью снимка
    // с телефона лежит на боку, а оригинал стоит прямо.
    .rotate()
    .resize({
      width: THUMB_MAX_WIDTH,
      height: THUMB_MAX_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    });

  // PNG с палитрой: без квантования превью стикера выходит тяжелее оригинала и его
  // всё равно отбросит проверка «не меньше» — а так оно и лёгкое, и с прозрачностью.
  const out = transparent
    ? await resized
        .png({ palette: true, quality: THUMB_PNG_QUALITY, effort: 7 })
        .toBuffer({ resolveWithObject: true })
    : await resized
        .jpeg({ quality: THUMB_JPEG_QUALITY, mozjpeg: true, chromaSubsampling: "4:2:0" })
        .toBuffer({ resolveWithObject: true });

  return {
    data: out.data,
    width: out.info.width,
    height: out.info.height,
    srcWidth: meta.width,
    srcHeight: meta.height,
    srcFormat: String(meta.format ?? "unknown"),
    contentType: transparent ? "image/png" : "image/jpeg",
  };
}
