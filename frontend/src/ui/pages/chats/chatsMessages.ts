/**
 * chatsMessages — чистая «модель сообщения» страницы чатов: разбор метаданных,
 * тексты для копирования/системных сообщений, черновики ответов (reply) и вся
 * логика пересылки (forward), включая сборку мульти-исходных пачек и полезной
 * нагрузки для отправки. Всё — чистые функции/типы без состояния компонента.
 *
 * Разделы:
 *   • Плюрализация и фразы (reply/forward подписи)
 *   • Копирование и системные сообщения
 *   • Типы и построение reply-черновиков
 *   • Пересылка: детект, отпечатки, мульти-исходные пачки, заголовки
 *   • Метаданные сообщения и разбор reply-quote
 *   • Разбор forwardFrom / исходного времени пересылки
 *   • Контекст источника пересылки и сборка payload на отправку
 */

import {
  describeCopyableAttachment,
  inferAttachmentRenderType,
  resolveAttachmentFileName,
} from './chatsAttachments'
import { formatMessageClockLabel } from './chatsTime'

/** Склонение существительного «сообщение» для русского (11–14 → сообщений). */
export function ruPluralSoobsheniya(n: number): string {
  const k = Math.abs(Math.floor(n))
  const mod100 = k % 100
  if (mod100 >= 11 && mod100 <= 14) return 'сообщений'
  const mod10 = k % 10
  if (mod10 === 1) return 'сообщение'
  if (mod10 >= 2 && mod10 <= 4) return 'сообщения'
  return 'сообщений'
}

export function formatReplyBundleHeader(count: number): string {
  return `Ответ на ${count} ${ruPluralSoobsheniya(count)}`
}

/** Фраза после имени пересылающего: «ответил на N сообщений» / одно сообщение */
export function formatSenderReplyActionPhrase(count: number): string {
  return `ответил на ${count} ${ruPluralSoobsheniya(count)}`
}

export function formatSenderReplySingleActionPhrase(): string {
  return 'ответил на сообщение'
}

/**
 * То же, что заголовок конверта («Из переписки с …» / «Из «Группа»»), но с маленькой «из»
 * для склейки с именем: «Роман из переписки с …»
 */
export function formatForwardSourcePhraseAfterName(bundleMessages: any[]): string {
  const raw = formatMultiSourceForwardBundleSourceHeader(bundleMessages).trim()
  if (!raw.length) return 'пересланное'
  return raw.replace(/^Из\s+/iu, 'из ')
}

export function buildMessageCopyText(message: any): string {
  if (!message) return ''

  const parts: string[] = []
  const replyPreview = typeof message?.replyTo?.content === 'string' ? message.replyTo.content.trim() : ''
  const content = typeof message?.content === 'string' ? message.content.trim() : ''
  const attachments = Array.isArray(message?.attachments) ? message.attachments : []
  const meta = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {}
  const rqBundleForCopy = parseReplyQuoteBundleEntries(message)
  if (rqBundleForCopy && rqBundleForCopy.length >= 2) {
    parts.push(formatReplyBundleHeader(rqBundleForCopy.length))
    for (const e of rqBundleForCopy) {
      parts.push(`— ${e.preview}`)
    }
  }
  const ff = (meta as any).forwardFrom
  if (ff && typeof ff === 'object' && typeof ff.authorName === 'string' && ff.authorName.trim()) {
    const who = ff.authorName.trim()
    const peerDm =
      typeof (ff as any).directChatPeerName === 'string' ? String((ff as any).directChatPeerName).trim() : ''
    const fromGroup = ff.isGroupSource && typeof ff.sourceChatTitle === 'string' && ff.sourceChatTitle.trim()
    if (fromGroup) {
      parts.push(`Переслано от ${who}, из «${ff.sourceChatTitle.trim()}»`)
    } else if (peerDm) {
      parts.push(`Переслано от ${who}, из переписки с ${peerDm}`)
    } else {
      parts.push(`Переслано от ${who}`)
    }
  }
  const fwdComposerCap =
    typeof (meta as any).forwardComposerCaption === 'string'
      ? String((meta as any).forwardComposerCaption).trim()
      : ''
  if (fwdComposerCap) {
    parts.push(fwdComposerCap)
  }
  if (!(rqBundleForCopy && rqBundleForCopy.length >= 2) && replyPreview) {
    parts.push(formatReplyBundleHeader(1))
    parts.push(`— ${replyPreview}`)
  }
  if (content) {
    parts.push(content)
  }
  if (attachments.length > 0) {
    parts.push(
      ...attachments
        .map((att: any) => describeCopyableAttachment(att))
        .filter((value: string | null): value is string => !!value),
    )
  }

  return parts.join('\n').trim()
}

export type ReplyDraftQuotedEntry = {
  id: string
  senderId: string
  preview: string
  createdAt?: string | null
  replyImageStub?: { url: string; type: 'IMAGE'; metadata?: Record<string, unknown> } | null
}

export type ReplyDraftState =
  | null
  | {
      replyToId: string
      quoted: ReplyDraftQuotedEntry[]
    }

/** После выбора адресата: пересылаемые сообщения уже «упакованы», комментарий — из основного композера (как у ответа). */
export type ForwardComposerDraftState = {
  destinationConversationId: string
  payloads: Array<{ type: string; content?: string | null; metadata?: Record<string, unknown>; attachments?: any[] }>
  mergeAsImageBulk: boolean
  previews: Array<{ text: string; imageStub?: { url: string; type: 'IMAGE'; metadata?: Record<string, unknown> } | null }>
}

/** Служебные строки ленты (звонки и т.п.): для пересылки/превью нужен текст, даже когда `content` пуст или форматируется на клиенте. */
export function renderSystemMessageContent(message: any, currentUserId: string | null | undefined): string {
  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {}
  const content = typeof message?.content === 'string' ? message.content.trim() : ''

  if (metadata.missed === true) {
    const timeSuffix = content.match(/^Пропущенный звонок\s+(.+)$/i)?.[1]?.trim()
    const fallbackSuffix = message?.createdAt
      ? `в ${new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false })}`
      : ''
    const suffix = timeSuffix || fallbackSuffix
    if (currentUserId && message?.senderId === currentUserId) {
      return `Исходящий звонок без ответа${suffix ? ` ${suffix}` : ''}`
    }
    return `Пропущенный звонок${suffix ? ` ${suffix}` : ''}`
  }

  return content
}

export function previewTextForReplyDraft(msg: any): string {
  const raw =
    (typeof msg?.content === 'string' ? msg.content.trim() : '') ||
    (msg?.type === 'SYSTEM' ? renderSystemMessageContent(msg, null).trim() : '')
  if (raw) return raw.length > 200 ? `${raw.slice(0, 197)}…` : raw
  const atts = msg?.attachments
  if (Array.isArray(atts) && atts.length > 0) {
    const t = atts[0]?.type
    if (t === 'IMAGE') return 'Фото'
    if (t === 'VIDEO') return 'Видео'
    if (t === 'AUDIO') return 'Голосовое сообщение'
    return 'Вложение'
  }
  return 'Сообщение'
}

export function firstImageAttachmentStubForQuote(msg: any): { url: string; type: 'IMAGE'; metadata?: Record<string, unknown> } | null {
  const atts = msg?.attachments
  if (!Array.isArray(atts)) return null
  const img = atts.find((a: any) => a?.type === 'IMAGE' && typeof a?.url === 'string' && String(a.url).trim())
  if (!img) return null
  const meta = img.metadata
  return {
    url: String(img.url).trim(),
    type: 'IMAGE',
    ...(meta && typeof meta === 'object' && !Array.isArray(meta) ? { metadata: meta as Record<string, unknown> } : {}),
  }
}

export function replySnippetIsGenericRu(line: string): boolean {
  const t = line.trim()
  return t === '' || t === 'Фото' || t === 'Видео' || t === 'Голосовое сообщение' || t === 'Вложение' || t === 'Сообщение'
}

export function buildReplyDraftFromMessages(msgs: any[]): ReplyDraftState | null {
  const list = Array.isArray(msgs) ? msgs.filter((m) => m && typeof m.id === 'string') : []
  if (!list.length) return null
  const quoted: ReplyDraftQuotedEntry[] = list.map((m) => ({
    id: m.id,
    senderId: typeof m.senderId === 'string' ? m.senderId : '',
    preview: previewTextForReplyDraft(m),
    replyImageStub: firstImageAttachmentStubForQuote(m),
    ...(typeof m.createdAt === 'string' && m.createdAt.trim()
      ? { createdAt: m.createdAt.trim() }
      : typeof m.createdAt === 'number' && Number.isFinite(m.createdAt)
        ? { createdAt: new Date(m.createdAt).toISOString() }
        : m.createdAt instanceof Date && Number.isFinite(m.createdAt.getTime())
          ? { createdAt: m.createdAt.toISOString() }
          : {}),
  }))
  const last = list[list.length - 1]
  return { replyToId: last.id, quoted }
}

export function buildReplyQuoteMetadataForSend(draft: ReplyDraftState): Record<string, unknown> | undefined {
  if (!draft || draft.quoted.length < 2) return undefined
  return {
    replyQuoteBundle: draft.quoted.map((q) => ({
      messageId: q.id,
      ...(q.senderId ? { senderId: q.senderId } : {}),
      preview: q.preview.slice(0, 420),
      ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    })),
  }
}

/** Предельный размах пачки «от первой до последней пересылки в блоке» (защита от склейки далёких по времени сообщений). */
export const MULTI_FWD_MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000
/** Макс. пауза между двумя подряд идущими в ленте пересылками одного конверта (между ними нет других сообщений). */
export const MULTI_FWD_GAP_MS = 25_000

export function forwardFromAuthorKeyForBundle(m: any): string | null {
  const ff = normalizeForwardFromRecord(parseMessageMetadata(m)?.forwardFrom)
  if (!ff) return null
  const name = typeof ff.authorName === 'string' ? String(ff.authorName).trim() : ''
  if (!name) return null
  const title = typeof ff.sourceChatTitle === 'string' ? String(ff.sourceChatTitle).trim() : ''
  return `${name}|${title}`
}

export function hasForwardFromMeta(m: any): boolean {
  return forwardFromAuthorKeyForBundle(m) != null
}

/** Один источник переслыки для склейки конверта: только «откуда» (группа или личка с тем же собеседником), без автора оригинала — иначе две пересылки из одного чата не слипаются. */
export function forwardSourceFingerprintForBundle(m: any): string | null {
  if (!hasForwardFromMeta(m)) return null
  const ff = normalizeForwardFromRecord(parseMessageMetadata(m)?.forwardFrom)
  if (!ff) return null
  const isGroup = !!(ff as any).isGroupSource
  const titleRaw =
    typeof (ff as any).sourceChatTitle === 'string'
      ? String((ff as any).sourceChatTitle).trim()
      : ''
  if (isGroup) {
    return `grp:${titleRaw || '«без названия»'}`
  }
  const peer = directChatPeerDisplayForForwardHeader(m)
  return `dm:p:${peer ? peer : '¦'}`
}

/**
 * Подряд в ленте идущие пересылки от **одного** пересылающего и **одного источника** (та же группа / та же личка) —
 * один внешний «конверт»; внутри — свой бабл на сообщение. Несколько сообщений из одного чата (одна или несколько отправок) — обязательно один конверт.
 */
export function computeMultiSourceForwardBundles(fullList: any[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let i = 0
  const n = fullList.length
  while (i < n) {
    const m = fullList[i]
    if (m?.deletedAt || m?.type === 'SYSTEM' || !hasForwardFromMeta(m)) {
      i++
      continue
    }
    const forwarder = m.senderId
    const t0 = new Date(m.createdAt || 0).getTime()
    const fp0 = forwardSourceFingerprintForBundle(m)
    if (!fp0) {
      i++
      continue
    }
    let j = i
    while (j + 1 < n) {
      const next = fullList[j + 1]
      if (next?.deletedAt || next?.type === 'SYSTEM') break
      if (!hasForwardFromMeta(next)) break
      if (forwardSourceFingerprintForBundle(next) !== fp0) break
      if (next.senderId !== forwarder) break
      const tNext = new Date(next.createdAt || 0).getTime()
      if (tNext - t0 > MULTI_FWD_MAX_SPAN_MS) break
      const cur = fullList[j]
      if (tNext - new Date(cur.createdAt || 0).getTime() > MULTI_FWD_GAP_MS) break
      j++
    }
    /** Одна или несколько пересылок подряд склеиваются (включая одно сообщение — иначе layout расходился с пачкой). */
    out.push({ start: i, end: j })
    i = j + 1
  }
  return out
}

/** Заголовок «конверта»: группы («…»); личка — «из переписки с Имя» только из directChatPeerName (беседа-источник / собеседник). Имя автора оригинала сюда не подставляется. */
export function formatMultiSourceForwardBundleSourceHeader(bundleMessages: any[]): string {
  const groupTitles = new Set<string>()
  const dmPeers = new Set<string>()
  let hasDmLegacySansPeer = false
  for (const msg of bundleMessages) {
    const md = parseMessageMetadata(msg)
    const ff = normalizeForwardFromRecord(md?.forwardFrom)
    if (!ff) continue
    const isGroupSource = !!(ff as any).isGroupSource
    const st = (ff as any).sourceChatTitle
    const sourceChatTitle = typeof st === 'string' && st.trim() ? st.trim() : null

    if (isGroupSource) {
      if (sourceChatTitle) groupTitles.add(sourceChatTitle)
      else groupTitles.add('Группа')
      continue
    }

    const peerLabel = directChatPeerDisplayForForwardHeader(msg)
    if (peerLabel) dmPeers.add(peerLabel)
    else hasDmLegacySansPeer = true
  }
  const titles = [...groupTitles].sort((a, b) => a.localeCompare(b, 'ru'))
  const gpParts = titles.map((t) => `«${t}»`)
  const peersSorted = [...dmPeers].sort((a, b) => a.localeCompare(b, 'ru'))
  let dmPhrase = ''
  if (peersSorted.length === 1) dmPhrase = `переписки с ${peersSorted[0]}`
  else if (peersSorted.length > 1) dmPhrase = `переписки с ${peersSorted.join(' · ')}`
  else if (hasDmLegacySansPeer) dmPhrase = 'личной переписки'

  const parts = [...gpParts]
  if (dmPhrase) parts.push(dmPhrase)

  if (parts.length === 0) return 'Переслано'
  return `Из ${parts.join(' · ')}`
}

export function parseMessageMetadata(msg: any): Record<string, unknown> | null {
  const md = msg?.metadata
  if (md == null) return null
  if (typeof md === 'string') {
    try {
      const p = JSON.parse(md) as unknown
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  if (typeof md === 'object' && !Array.isArray(md)) return md as Record<string, unknown>
  return null
}

/** Несколько цитируемых сообщений в одном ответе (metadata.replyQuoteBundle). */
export function parseReplyQuoteBundleEntries(msg: any): ReplyDraftQuotedEntry[] | null {
  const md = parseMessageMetadata(msg)
  if (!md) return null
  const raw = md.replyQuoteBundle
  if (!Array.isArray(raw) || raw.length < 2) return null
  const out: ReplyDraftQuotedEntry[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const messageId = typeof (row as any).messageId === 'string' ? String((row as any).messageId).trim() : ''
    if (!messageId) continue
    let preview =
      typeof (row as any).preview === 'string'
        ? String((row as any).preview)
        : typeof (row as any).content === 'string'
          ? String((row as any).content)
          : ''
    preview = preview.trim()
    if (preview.length > 240) preview = `${preview.slice(0, 237)}…`
    const senderId = typeof (row as any).senderId === 'string' ? String((row as any).senderId) : ''
    const createdRaw =
      (row as any).createdAt ?? (row as any).created_at ?? (row as any).messageCreatedAt ?? null
    let createdAt: string | undefined
    if (typeof createdRaw === 'string' && createdRaw.trim()) createdAt = createdRaw.trim()
    else if (typeof createdRaw === 'number' && Number.isFinite(createdRaw)) {
      const d = new Date(createdRaw)
      if (Number.isFinite(d.getTime())) createdAt = d.toISOString()
    }
    out.push({
      id: messageId,
      senderId,
      preview: preview || 'Сообщение',
      ...(createdAt ? { createdAt } : {}),
    })
  }
  return out.length >= 2 ? out : null
}

export const FORWARD_COMPOSER_CAPTION_META_KEY = 'forwardComposerCaption'

/** Комментарий к пересылке из композера — в metadata первого сообщения пачки; с текстом показываем под вложенным оранжевым конвертом, внутри обычного бабла. */
export function extractForwardComposerCaption(msg: any): string | null {
  const md = parseMessageMetadata(msg)
  if (!md) return null
  const raw = md[FORWARD_COMPOSER_CAPTION_META_KEY]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/** Собеседник в исходной личке для «Из переписки с …» — дублируем в metadata.sourceDmPeerName и forwardFrom.directChatPeerName. */
export function directChatPeerDisplayForForwardHeader(msg: any): string {
  const md = parseMessageMetadata(msg)
  if (!md) return ''
  const root =
    (typeof md.sourceDmPeerName === 'string' && String(md.sourceDmPeerName).trim()) ||
    (typeof md.directChatPeerName === 'string' && String(md.directChatPeerName).trim()) ||
    ''
  if (root) return root
  const ff = normalizeForwardFromRecord(md.forwardFrom)
  if (ff) {
    const camel =
      typeof (ff as any).directChatPeerName === 'string' ? String((ff as any).directChatPeerName).trim() : ''
    if (camel) return camel
    const snake =
      typeof (ff as any).direct_chat_peer_name === 'string'
        ? String((ff as any).direct_chat_peer_name).trim()
        : ''
    if (snake) return snake
    const isGroupSource = !!(ff as any).isGroupSource
    if (!isGroupSource) {
      const an = typeof (ff as any).authorName === 'string' ? String((ff as any).authorName).trim() : ''
      if (an) return an
    }
  }
  return ''
}


export function coerceParsedMessageInstant(raw: unknown): Date | null {
  if (raw == null || raw === '') return null
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw : null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = new Date(raw)
    return Number.isFinite(d.getTime()) ? d : null
  }
  if (typeof raw === 'string' && raw.trim()) {
    const d = new Date(raw.trim())
    return Number.isFinite(d.getTime()) ? d : null
  }
  return null
}

export function normalizeForwardFromRecord(rawFf: unknown): Record<string, unknown> | null {
  if (rawFf == null) return null
  if (typeof rawFf === 'string') {
    try {
      const p = JSON.parse(rawFf) as unknown
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return typeof rawFf === 'object' ? (rawFf as Record<string, unknown>) : null
}

/** Момент оригинала в исходном чате (для времени у пересланного бабла) */
export function extractOriginalForwardedInstantFromMessage(m: any): Date | null {
  const md = parseMessageMetadata(m)
  if (!md) return null
  const fromTop = coerceParsedMessageInstant(md.forwardOriginalCreatedAt)
  if (fromTop) return fromTop
  const ff = normalizeForwardFromRecord(md.forwardFrom)
  if (!ff) return null
  const keys = ['originalCreatedAt', 'original_created_at', 'sourceCreatedAt', 'postedAt'] as const
  for (const k of keys) {
    if (!(k in ff)) continue
    const d = coerceParsedMessageInstant(ff[k])
    if (d) return d
  }
  return null
}


export type ForwardAttachment = { url: string; type: string; size?: number; metadata?: Record<string, unknown> }

/** Сохраняется в Message.metadata при пересылке */
export type ForwardFromMeta = {
  authorName: string
  /** Название чата для группы; для лички — null */
  sourceChatTitle: string | null
  isGroupSource: boolean
  /** Отображаемое имя собеседника в исходной личке (кроме себя): для строки «из переписки с …» */
  directChatPeerName?: string | null
  /** ISO: момент оригинального сообщения (для времени на бабле при пересылке) */
  originalCreatedAt?: string | null
}

export type ForwardSourceContext = {
  authorName: string
  sourceChatTitle: string | null
  isGroupSource: boolean
  /** ISO время исходного сообщения */
  originalCreatedAt: string
  /** Для DM: заголовок беседы в списке (собеседник), может быть несколько через «, » */
  directChatPeerName: string | null
}

/**
 * Контекст источника для «Переслать»: если сообщение уже переслано — берём группу/личку из его metadata.forwardFrom.
 * Иначе — активный чат. Так пересылка **из группы** не превращает старую личку в «из «Группа»» без собеседника.
 */
export function buildForwardSourceContextForSend(
  found: any,
  activeConv: any,
  currentUserId: string | null | undefined,
  usersById: Record<string, any>,
): ForwardSourceContext {
  const orig = usersById[found.senderId] ?? found.sender
  const srcOthers = (activeConv?.participants || [])
    .filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true))
    .map((p: any) => p.user)
  const srcFallbackChatName = srcOthers.map((u: any) => u.displayName ?? u.username).join(', ') || 'Диалог'
  const srcIsGroup = !!(activeConv?.isGroup || (activeConv?.participants?.length ?? 0) > 2)
  const srcSourceChatTitle = srcIsGroup
    ? typeof activeConv?.title === 'string' && activeConv.title.trim()
      ? activeConv.title.trim()
      : srcFallbackChatName
    : null

  const mdFf = normalizeForwardFromRecord(parseMessageMetadata(found)?.forwardFrom)

  const authorName =
    mdFf && typeof (mdFf as any).authorName === 'string' && String((mdFf as any).authorName).trim()
      ? String((mdFf as any).authorName).trim()
      : (typeof orig?.displayName === 'string' && orig.displayName.trim()) ||
        (typeof orig?.username === 'string' && orig.username.trim()) ||
        'Участник'

  let isGroupSource: boolean
  let sourceChatTitle: string | null
  let directChatPeerName: string | null

  if (mdFf && typeof (mdFf as any).authorName === 'string' && String((mdFf as any).authorName).trim()) {
    const wasGroup = !!(mdFf as any).isGroupSource
    if (wasGroup) {
      isGroupSource = true
      const t = typeof (mdFf as any).sourceChatTitle === 'string' ? String((mdFf as any).sourceChatTitle).trim() : ''
      sourceChatTitle = t || srcSourceChatTitle
      directChatPeerName = null
    } else {
      isGroupSource = false
      sourceChatTitle = null
      const peer = directChatPeerDisplayForForwardHeader(found)
      const ffPeer =
        typeof (mdFf as any).directChatPeerName === 'string' ? String((mdFf as any).directChatPeerName).trim() : ''
      let resolvedPeer: string | null = peer || ffPeer || null
      if (!resolvedPeer && !srcIsGroup) resolvedPeer = srcFallbackChatName
      /**
       * Пересылка **из группы**: активный чат — не личка, `srcFallbackChatName` это участники группы, не собеседник в DM.
       * Если в метадате нет `directChatPeerName`, подставляем автора оригинала (в входящей личке это обычно собеседник).
       * Не подставляем, если автор — вы (иначе «из переписки с [вы]»).
       */
      if (!resolvedPeer && srcIsGroup && authorName && authorName !== 'Участник') {
        let hint: string | null = authorName
        if (hint && currentUserId) {
          const meUser = usersById[currentUserId]
          const norm = (s: string) => s.trim().toLowerCase()
          const hRaw = norm(hint)
          const h = hRaw.startsWith('@') ? hRaw.slice(1) : hRaw
          const meA = meUser?.displayName ? norm(String(meUser.displayName)) : ''
          const meBU = meUser?.username ? norm(String(meUser.username)) : ''
          const meB = meBU.startsWith('@') ? meBU.slice(1) : meBU
          if ((meA && h === meA) || (meB && h === meB)) hint = null
        }
        resolvedPeer = hint
      }
      directChatPeerName = resolvedPeer
    }
  } else {
    isGroupSource = srcIsGroup
    sourceChatTitle = srcSourceChatTitle
    directChatPeerName = srcIsGroup ? null : srcFallbackChatName
  }

  const originalIso = (() => {
    const d = extractOriginalForwardedInstantFromMessage(found)
    if (d && Number.isFinite(d.getTime())) return d.toISOString()
    const raw = found.createdAt
    if (!raw) return new Date().toISOString()
    const dt = new Date(raw as string | number)
    return Number.isFinite(dt.getTime()) ? dt.toISOString() : new Date().toISOString()
  })()

  return {
    authorName,
    sourceChatTitle,
    isGroupSource,
    originalCreatedAt: originalIso,
    directChatPeerName,
  }
}

export function cloneAttachmentForForward(att: any): ForwardAttachment | null {
  if (!att?.url || !att.type) return null
  if (att.metadata?.e2ee?.kind === 'ciphertext') return null
  const out: {
    url: string
    type: string
    size?: number
    metadata?: Record<string, unknown>
  } = { url: String(att.url), type: String(att.type) }
  if (typeof att.size === 'number' && Number.isFinite(att.size)) out.size = att.size
  if (att.metadata && typeof att.metadata === 'object') {
    const meta = { ...att.metadata } as Record<string, unknown>
    delete meta.e2ee
    if (Object.keys(meta).length > 0) out.metadata = meta
  }
  return out
}

/**
 * Для модалки «Переслать»: новее сверху (по активности беседы).
 */
export function recencyTimestampForConversationRow(row: any): number {
  const c = row?.conversation
  if (!c) return 0
  const pick = (v: unknown): number | null => {
    if (v == null) return null
    const t = new Date(v as string | number | Date).getTime()
    return Number.isFinite(t) ? t : null
  }
  let t = pick(c.lastMessageAt)
  if (t != null) return t
  const m0 = Array.isArray(c.messages) ? c.messages[0] : null
  t = pick(m0?.createdAt)
  if (t != null) return t
  t = pick(c.createdAt)
  if (t != null) return t
  t = pick(row.joinedAt)
  return t ?? 0
}

/**
 * Тело запроса для «Переслать»: тот же текст (опционально с префиксом ↪, если нет контекста источника)
 * и копии вложений по URL; при forwardCtx добавляет metadata.forwardFrom.
 */
export function buildForwardSendPayload(
  message: any,
  forwardCtx?: ForwardSourceContext,
): { ok: true; payload: { type: string; content?: string | null; attachments?: any[]; metadata?: Record<string, unknown>; replyToId?: undefined } } | { ok: false; error: string } {
  if (!message) return { ok: false, error: 'Сообщение не найдено' }
  const forwardMetadata: Record<string, unknown> | undefined = forwardCtx
    ? (() => {
        const dmPeerFlat =
          !forwardCtx.isGroupSource &&
          forwardCtx.directChatPeerName != null &&
          String(forwardCtx.directChatPeerName).trim()
            ? String(forwardCtx.directChatPeerName).trim()
            : null
        return {
          /** Дублируем на корень метадаты — часть клиентов/цепочек безопаснее читает плоским ключом */
          forwardOriginalCreatedAt: forwardCtx.originalCreatedAt,
          /** Дубликат имени собеседника в личке — чтобы шапка «Из переписки с …» не терялась при вложенном JSON. */
          ...(dmPeerFlat ? { sourceDmPeerName: dmPeerFlat } : {}),
          forwardFrom: forwardCtx.isGroupSource
            ? {
                authorName: forwardCtx.authorName,
                sourceChatTitle: forwardCtx.sourceChatTitle,
                isGroupSource: true as const,
                originalCreatedAt: forwardCtx.originalCreatedAt,
              }
            : ({
                authorName: forwardCtx.authorName,
                sourceChatTitle: null,
                isGroupSource: false as const,
                originalCreatedAt: forwardCtx.originalCreatedAt,
                directChatPeerName: dmPeerFlat,
              } satisfies ForwardFromMeta),
        }
      })()
    : undefined
  // Carry media-display metadata from the original message so forwarded media keeps its
  // duration/dimensions — e.g. a forwarded voice message shows its real length (not 0:00)
  // instead of the lost message-level metadata.duration.
  const srcMeta =
    message.metadata && typeof message.metadata === 'object'
      ? (message.metadata as Record<string, unknown>)
      : {}
  const carriedMediaMeta: Record<string, unknown> = {}
  for (const key of ['duration', 'width', 'height'] as const) {
    const v = srcMeta[key]
    if (typeof v === 'number' && Number.isFinite(v)) carriedMediaMeta[key] = v
  }
  const forwardPayloadMeta: Record<string, unknown> | undefined =
    forwardMetadata || Object.keys(carriedMediaMeta).length > 0
      ? { ...(forwardMetadata ?? {}), ...carriedMediaMeta }
      : undefined
  const usePlainContent = !!forwardCtx
  const attsIn: any[] = Array.isArray(message.attachments) ? message.attachments : []
  if (attsIn.some((a: any) => a?.metadata?.e2ee?.kind === 'ciphertext')) {
    return {
      ok: false,
      error: 'Зашифрованные вложения из секретного чата нельзя переслать. Сохраните файл вручную или перешлите из обычного чата.',
    }
  }
  const attachments: ForwardAttachment[] = attsIn
    .map(cloneAttachmentForForward)
    .filter((x): x is ForwardAttachment => x !== null)
  if (attachments.length < attsIn.length) {
    return { ok: false, error: 'Не удалось подготовить вложения для пересылки.' }
  }
  const rawContent =
    (typeof message.content === 'string' ? message.content.trim() : '') ||
    (message.type === 'SYSTEM' ? renderSystemMessageContent(message, null).trim() : '')
  if (attachments.length === 0) {
    if (!rawContent) return { ok: false, error: 'В сообщении нет текста и вложений.' }
    const textBody = usePlainContent ? rawContent : `↪ ${rawContent}`
    return {
      ok: true,
      payload: {
        type: 'TEXT',
        content: textBody,
        ...(forwardPayloadMeta ? { metadata: forwardPayloadMeta } : {}),
        replyToId: undefined,
      },
    }
  }
  const msgType = attachments.every((u: ForwardAttachment) => u.type === 'IMAGE')
    ? 'IMAGE'
    : attachments.every((u: ForwardAttachment) => u.type === 'VIDEO')
      ? 'VIDEO'
      : attachments.every((u: ForwardAttachment) => u.type === 'AUDIO')
        ? 'AUDIO'
        : 'FILE'
  const caption = rawContent ? (usePlainContent ? rawContent : `↪ ${rawContent}`) : ''
  return {
    ok: true,
    payload: {
      type: msgType,
      ...(caption ? { content: caption } : {}),
      attachments,
      ...(forwardMetadata ? { metadata: forwardMetadata } : {}),
      replyToId: undefined,
    },
  }
}
