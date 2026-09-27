/**
 * Ключи объектов в хранилище: ОДНО место, где живёт разрешение «путь запроса → ключ».
 *
 * Эти функции раньше были приватными внутри routes/files.ts, а всё, что ходило к
 * хранилищу мимо прокси (скрипты, воркеры), заводило себе копию. Так и появился
 * баг с недостижимыми превью: превью писалось по ключу, выведенному из КЛЮЧА
 * ОРИГИНАЛА, а отдача искала его по производной от СЫРОГО ПУТИ ЗАПРОСА. Кто
 * разрешает ключи — разрешает их отсюда.
 */

/** Декодировать URL-кодированные сегменты пути. */
export const decodeKeyFromUrl = (urlPath: string): string =>
  urlPath
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

const splitPathSegments = (p: string) => p.split("/").filter(Boolean);

export const stripLeadingBucketSegment = (
  decodedPath: string,
  bucket: string | null,
  prefix: string
): string => {
  const segments = splitPathSegments(decodedPath);
  if (segments.length === 0) return decodedPath;

  // Common case: proxy path was derived from a path-style public URL:
  //   https://s3.example.com/<bucket>/<key>
  // Frontend converts it to: /api/files/<bucket>/<key>
  // If we see "<something>/<prefix>/..." treat the leading segment as bucket and strip it.
  const prefixSegments = splitPathSegments(prefix);
  if (prefixSegments.length > 0 && segments.length >= 1 + prefixSegments.length) {
    const maybePrefix = segments.slice(1, 1 + prefixSegments.length).join("/");
    if (maybePrefix === prefixSegments.join("/")) {
      return segments.slice(1).join("/");
    }
  }

  // Also strip an explicit, configured bucket name if present.
  if (bucket && segments[0] === bucket) {
    return segments.slice(1).join("/");
  }

  return decodedPath;
};

export const buildCandidateKeys = (
  decodedPath: string,
  bucket: string | null,
  prefix: string
): string[] => {
  const base = decodedPath.replace(/^\//, "");
  const stripped = stripLeadingBucketSegment(base, bucket, prefix);

  const candidates: string[] = [];
  const push = (k: string) => {
    const key = k.replace(/^\//, "");
    if (!key) return;
    if (!candidates.includes(key)) candidates.push(key);
  };

  // Try as-is first (it might already be the real object key).
  push(base);
  push(stripped);

  // Then try enforcing STORAGE_PREFIX (avoids missing prefix issues).
  const prefixNorm = prefix.replace(/^\/|\/$/g, "");
  if (prefixNorm) {
    for (const k of [base, stripped]) {
      if (k === prefixNorm || k.startsWith(prefixNorm + "/")) {
        push(k);
      } else {
        push(`${prefixNorm}/${k}`);
      }
    }
  }

  return candidates;
};

export const toEblushaKey = (k: string): string => {
  if (k.endsWith(".eblusha")) return k;
  const parts = k.split("/");
  const base = parts.pop() ?? "";
  if (!base) return `${k}.eblusha`;
  const dot = base.lastIndexOf(".");
  const baseNoExt = dot > 0 ? base.slice(0, dot) : base;
  parts.push(`${baseNoExt}.eblusha`);
  return parts.join("/");
};

/**
 * Полный набор ключей-кандидатов оригинала — ровно тот, который перебирает
 * /api/files. Отдача и всё, что пишет производные объекты, должны видеть
 * ОДИН И ТОТ ЖЕ набор, иначе производная окажется недостижимой.
 */
export const expandCandidateKeys = (
  decodedPath: string,
  bucket: string | null,
  prefix: string,
  opts?: { eblushaFallback?: boolean }
): string[] => {
  const candidates = buildCandidateKeys(decodedPath, bucket, prefix);
  if (opts?.eblushaFallback === false) return candidates;
  // If we migrated objects to *.eblusha but DB still contains old URLs (.jpg/.png/.bin),
  // transparently try the ".eblusha" variant as a fallback.
  return Array.from(new Set([...candidates, ...candidates.map(toEblushaKey)]));
};

/**
 * `MessageAttachment.url` → путь, который увидит /api/files.
 *
 * В базе лежат две формы: относительная `/api/files/<ключ>` (новые) и абсолютный
 * адрес хранилища `https://<хост>/<бакет>/uploads/<имя>.<ext>` (39 старых строк).
 * Клиент приводит вторую к `/api/files/<бакет>/uploads/<имя>.<ext>` — см.
 * convertToProxyUrl во фронте. Здесь повторяется именно этот путь, чтобы скрипты
 * разрешали ключ ровно так же, как отдача.
 */
export const requestPathFromMediaUrl = (url: string | null | undefined): string | null => {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("blob:") || raw.startsWith("data:")) return null;

  const cut = (s: string) => (s.split("?")[0] ?? "").split("#")[0] ?? "";

  const marker = "/api/files/";
  const at = raw.indexOf(marker);
  if (at !== -1) {
    const rest = cut(raw.slice(at + marker.length)).replace(/^\//, "");
    return rest ? decodeKeyFromUrl(rest) : null;
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const pathname = new URL(raw).pathname.replace(/^\//, "");
      return pathname ? decodeKeyFromUrl(pathname) : null;
    } catch {
      return null;
    }
  }

  const rest = cut(raw).replace(/^\//, "");
  return rest ? decodeKeyFromUrl(rest) : null;
};
