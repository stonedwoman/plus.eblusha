import crypto from "crypto";
import logger from "../config/logger";
import env from "../config/env";
import { getStorageProvider } from "./storage";
import {
  decryptBuffer,
  encryptBuffer,
  parseStorageEncKey,
} from "./storageEncryption";
import { getNonSecretConversationDek } from "./nonSecretChatEncryption";

type SendAttachmentLike = {
  url: string;
  type: "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
  size?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
};

const encKeyMaster = env.STORAGE_ENC_KEY ? parseStorageEncKey(env.STORAGE_ENC_KEY) : null;
const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
const decodeSeg = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Decode path after `/api/files/`. */
function extractPrimaryRelativeKey(attUrl: string): string | null {
  const raw = String(attUrl || "").trim();
  if (!raw) return null;
  try {
    let pathname = raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      pathname = new URL(raw).pathname;
    }
    const idx = pathname.indexOf("/api/files/");
    if (idx < 0) return null;
    const rest = pathname.slice(idx + "/api/files/".length);
    if (!rest) return null;
    return rest.split("/").map(decodeSeg).join("/").replace(/^\/+/, "");
  } catch {
    return null;
  }
}

function encodeKeyForUrl(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

const splitPathSegments = (p: string) => p.split("/").filter(Boolean);

const stripLeadingBucketSegment = (decodedPath: string, bucket: string | null, prefix: string): string => {
  const segments = splitPathSegments(decodedPath);
  if (segments.length === 0) return decodedPath;
  const prefixSegments = splitPathSegments(prefix.replace(/^\/|\/$/g, ""));
  if (
    prefixSegments.length > 0 &&
    segments.length >= 1 + prefixSegments.length
  ) {
    const maybePrefix = segments.slice(1, 1 + prefixSegments.length).join("/");
    if (maybePrefix === prefixSegments.join("/")) {
      return segments.slice(1).join("/");
    }
  }
  if (bucket && segments[0] === bucket) {
    return segments.slice(1).join("/");
  }
  return decodedPath;
};

function buildCandidateKeys(decodedPath: string, bucketForKeys: string | null): string[] {
  const bucket = bucketForKeys;
  const prefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
  const base = decodedPath.replace(/^\//, "");
  const stripped = stripLeadingBucketSegment(base, bucket, prefix);

  const candidates: string[] = [];
  const push = (k: string) => {
    const key = k.replace(/^\//, "");
    if (!key) return;
    if (!candidates.includes(key)) candidates.push(key);
  };

  push(base);
  push(stripped);
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
}

function bucketHintForForwardedRemap(): string | null {
  return env.STORAGE_BACKEND === "local" ? null : (env.STORAGE_S3_BUCKET ?? null);
}

/**
 * Относится ли URL к нашим `/api/files/…` бинарникам *.eblusha (прокси в storage).
 * Внешние ссылки (*.eblusha на другом хосте) не трогаем.
 */
export function forwardedHostedBlobUrlLikely(attUrl: string): boolean {
  const raw = String(attUrl ?? "").trim();
  if (!raw || raw.includes("..")) return false;
  try {
    let pathname = raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      pathname = new URL(raw).pathname;
    }
    if (!/\.eblusha$/i.test(pathname)) return false;
    return pathname.includes("/api/files/");
  } catch {
    return false;
  }
}

/** Первый объект в storage среди ключей-кандидатов для этого URL или null */
async function resolveFirstExistingAttachmentKey(
  attUrl: string,
  bucketForKeys: string | null,
): Promise<{ key: string; metadata: Record<string, string> } | null> {
  const primaryRel = extractPrimaryRelativeKey(attUrl);
  if (!primaryRel) return null;
  let storage;
  try {
    storage = getStorageProvider();
  } catch {
    return null;
  }
  if (!storage.isAvailable()) return null;

  const expandedKeys = buildCandidateKeys(primaryRel, bucketForKeys);
  for (const candidate of expandedKeys) {
    try {
      const head = await storage.headObject(candidate);
      if (!head) continue;
      return { key: candidate, metadata: head.metadata ?? {} };
    } catch {
      /* next */
    }
  }
  return null;
}

export async function hostedForwardedAttachmentBlobExists(attUrl: string): Promise<boolean> {
  const r = await resolveFirstExistingAttachmentKey(attUrl, bucketHintForForwardedRemap());
  return r != null;
}

async function readBodyToBuffer(body: unknown): Promise<Buffer> {
  const b = body as any;
  if (!b) return Buffer.alloc(0);
  if (Buffer.isBuffer(b)) return b;
  if (typeof b.pipe === "function") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      b.on("data", (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      b.on("end", () => resolve());
      b.on("error", (e: unknown) => reject(e));
    });
    return Buffer.concat(chunks);
  }
  const ab = typeof b.transformToByteArray === "function" ? await b.transformToByteArray() : await b.arrayBuffer?.();
  return ab ? Buffer.from(ab as ArrayBuffer) : Buffer.alloc(0);
}

const MAX_REMEDY_BYTES = 55 * 1024 * 1024; /** safety: avoid OOM on accidental huge payloads */

async function remapOneAttachment<T extends SendAttachmentLike>(
  attachment: T,
  destinationConversationId: string,
  bucketForKeys: string | null,
): Promise<T> {
  if (!encKeyMaster) return attachment;

  const primaryRel = extractPrimaryRelativeKey(attachment.url);
  if (!primaryRel) return attachment;

  let storage;
  try {
    storage = getStorageProvider();
  } catch {
    return attachment;
  }
  if (!storage.isAvailable()) return attachment;

  const resolvedFirst = await resolveFirstExistingAttachmentKey(attachment.url, bucketForKeys);
  if (!resolvedFirst) {
    logger.warn({ url: attachment.url, primaryRel }, "[forward-remap] object not found, keeping url");
    return attachment;
  }
  const resolvedKey = resolvedFirst.key;

  const mergedMeta = resolvedFirst.metadata;
  const encTag = String(mergedMeta.enc ?? "").trim().toLowerCase();

  /** EBP2 / unknown: keep blob as-is — served with global STORAGE_ENC_KEY in files router. */
  if (encTag === "ebp2") {
    return attachment;
  }

  const encvHint = String(mergedMeta.encv ?? mergedMeta.enc_v ?? "")
    .trim()
    .toLowerCase();
  const isEbp1 = encTag === "ebp1" || encvHint === "1";
  if (!isEbp1) {
    return attachment;
  }

  const scoped =
    String(mergedMeta.encscope || "").toLowerCase() === "chat" &&
    typeof mergedMeta.cid === "string" &&
    mergedMeta.cid.trim().length > 0;

  if (!scoped) {
    /** Legacy global STORAGE_ENC_KEY — same URL для всех бесед. */
    return attachment;
  }

  const sourceConvId = mergedMeta.cid!.trim();
  if (sourceConvId === destinationConversationId) {
    return attachment;
  }

  const expandedKeys = buildCandidateKeys(primaryRel, bucketForKeys);

  try {
    const getRet = await storage.getObject(resolvedKey, undefined);
    const ciphertext = await readBodyToBuffer(getRet.body);
    if (ciphertext.length > MAX_REMEDY_BYTES) {
      logger.warn(
        { key: resolvedKey, len: ciphertext.length },
        "[forward-remap] skip: object too large for in-memory remap",
      );
      return attachment;
    }

    const blobMeta = { ...mergedMeta, ...((getRet.metadata ?? {}) as Record<string, string>) } as Record<
      string,
      string
    >;
    const aadFromMetaRaw = blobMeta?.aad?.trim?.() ?? "";
    const expandedForAad = expandedKeys.includes(resolvedKey) ? expandedKeys : [...expandedKeys, resolvedKey];
    const aadCandidates: string[] = aadFromMetaRaw
      ? [aadFromMetaRaw]
      : [resolvedKey, ...expandedForAad.filter((k) => k !== resolvedKey)];

    let decrypted: Buffer | undefined;
    try {
      const dekSrc = await getNonSecretConversationDek(sourceConvId);
      let lastConvErr: Error | null = null;
      for (const aad of aadCandidates) {
        try {
          decrypted = decryptBuffer(ciphertext, dekSrc, { aad });
          break;
        } catch (e) {
          lastConvErr = e as Error;
        }
      }
      if (!decrypted && lastConvErr) {
        logger.warn(
          { err: lastConvErr, cid: sourceConvId, key: resolvedKey },
          "[forward-remap] decrypt with conversation DEK failed (aad exhaustion)",
        );
      }
    } catch (e: any) {
      logger.warn({ err: e, cid: sourceConvId }, "[forward-remap] could not unwrap source conversation DEK");
    }

    if (!decrypted) {
      for (const aad of aadCandidates) {
        try {
          decrypted = decryptBuffer(ciphertext, encKeyMaster, { aad });
          break;
        } catch {
          /* next */
        }
      }
    }

    if (!decrypted) {
      logger.warn(
        { url: attachment.url, key: resolvedKey, sourceConvId },
        "[forward-remap] failed to decrypt; keeping original URL (recipient may hit 404)",
      );
      return attachment;
    }

    /**
     * Пакуем для целевого чата **как обычную загрузку** (см. upload.ts EBP1): только STORAGE_ENC_KEY и aad=putKey,
     * без encscope/cid. Иначе нужны CHAT_ENC_KEK и DEK беседы назначения — на части установок этого нет,
     * remap падал во внешний catch или оставлял старый URL → 404 у получателя после пересылки.
     */
    if (!encKeyMaster) {
      logger.warn("[forward-remap] STORAGE_ENC_KEY missing; cannot re-encrypt forwarded blob");
      return attachment;
    }

    const randomId =
      typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    const uniqueName = `${Date.now()}-${randomId}.eblusha`;
    const putKey = objectPrefix ? `${objectPrefix}/${uniqueName}` : uniqueName;

    const originalCt =
      (blobMeta.ct && blobMeta.ct.trim()) ||
      (mergedMeta.ct && mergedMeta.ct.trim()) ||
      "application/octet-stream";

    const encrypted = encryptBuffer(decrypted, encKeyMaster, {
      aad: putKey,
      contentType: originalCt,
    });
    const m = encrypted.meta;

    await storage.putObject(putKey, encrypted.payload, {
      contentType: "application/octet-stream",
      metadata: {
        enc: "ebp1",
        encv: m.v,
        encalg: m.alg,
        enciv: m.iv,
        enctag: m.tag,
        ct: m.ct || "",
        aad: putKey,
      },
    });

    const proxyUrl = `/api/files/${encodeKeyForUrl(putKey)}`;
    logger.info(
      { fromKey: resolvedKey, toKey: putKey, fromConv: sourceConvId, toConv: destinationConversationId },
      "[forward-remap] re-materialized chat-scoped attachment",
    );

    return {
      ...attachment,
      url: proxyUrl,
      size: encrypted.payload.length,
    } as T;
  } catch (e: unknown) {
    logger.warn(
      {
        err: e,
        url: attachment.url,
        key: resolvedKey,
        sourceConvId,
        destinationConversationId,
      },
      "[forward-remap] remap failed; keeping original URL",
    );
    return attachment;
  }
}

/**
 * Пересланные вложения: заново упаковать в хранилище так, чтобы URL открывался у получателя в целевом чате.
 * Исходники с encscope=chat расшифровываются DEK исходной беседы; результат сохраняется как глобальный EBP1
 * тем же образом, что и upload.ts (STORAGE_ENC_KEY + aad=putKey, без cid).
 */
export async function remapAttachmentsForForwardedNonSecretConversation<T extends SendAttachmentLike>(
  destinationConversationId: string,
  conversationIsSecret: boolean,
  attachments: T[] | undefined | null,
): Promise<T[] | undefined> {
  if (!attachments?.length || conversationIsSecret) return attachments ?? undefined;
  const bucketForKeys = bucketHintForForwardedRemap();

  const out = await Promise.all(
    attachments.map((a) => remapOneAttachment(a, destinationConversationId, bucketForKeys)),
  );

  return out;
}
