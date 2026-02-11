import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../utils/api'
import type { AxiosError } from 'axios'
import { socket, connectSocket, onConversationNew, onConversationDeleted, onConversationUpdated, onConversationMemberRemoved, inviteCall, onIncomingCall, onCallAccepted, onCallDeclined, onCallEnded, acceptCall, declineCall, endCall, onReceiptsUpdate, onPresenceUpdate, onPresenceGame, onPresenceGameSnapshot, onPresenceGameSnapshotBatch, subscribePresenceGame, helloPresenceGame, onContactRequest, onContactAccepted, onContactRemoved, onProfileUpdate, onCallStatus, onCallStatusBulk, requestCallStatuses, joinConversation, joinCallRoom, leaveCallRoom, onSecretChatOffer, acceptSecretChat, declineSecretChat, onSecretChatAccepted, type PresenceGamePayload, type PresenceGameSnapshotBatchPayload } from '../../utils/socket'
import { Phone, Video, Play, X, Reply, PlusCircle, Users, UserPlus, BellRing, Copy, UploadCloud, CheckCircle, ArrowLeft, Paperclip, PhoneOff, Trash2, Maximize2, Minus, LogOut, Lock, Unlock, MoreVertical, Mic, Square, Send } from 'lucide-react'
import { AvailabilityButton } from '../../features/availability/AvailabilityButton'
import { AvailabilityOverlay } from '../../features/availability/AvailabilityOverlay'
import { getFallbackTimeZone } from '../../features/availability/availability.time'
const CallOverlay = lazy(() => import('../components/CallOverlay').then(m => ({ default: m.CallOverlay })))
const preloadCallOverlay = () => import('../components/CallOverlay')
import { useAppStore } from '../../domain/store/appStore'
import { Avatar } from '../components/Avatar'
import { ImageEditorModal } from '../components/ImageEditorModal'
import { ImageLightbox } from '../components/ImageLightbox'
import { LazyImage } from '../components/LazyImage'
import { useCallStore } from '../../domain/store/callStore'
import { ensureDeviceBootstrap, getStoredDeviceInfo, rebootstrapDevice } from '../../domain/device/deviceManager'
import { e2eeManager } from '../../domain/e2ee/e2eeManager'
import { ensureMediaPermissions, convertToProxyUrl } from '../../utils/media'
import { VoiceRecorder } from '../../utils/voiceRecorder'
import { getWaveform } from '../../utils/audioWaveform'
import { unlockAppAudio } from '../../utils/audioUnlock'
import { detectLinks, extractFirstPreviewableUrl } from '../../js/link-detect'
import { renderChatMarkdownToHtml } from '../lib/chatMarkdown'

declare global {
  interface Window {
    __nativeCallOverlayBridge?: {
      accept?: (conversationId: string, withVideo: boolean) => Promise<boolean> | boolean
      decline?: (conversationId: string) => Promise<boolean> | boolean
    }
  }
}

const LAST_ACTIVE_CONVERSATION_KEY = 'eblusha:last-active-conversation'
const MIN_OUTGOING_CALL_DURATION_MS = 30_000
const MAX_PENDING_IMAGES = 10
const MESSAGES_PAGE_SIZE = 80

function decodeUrlForDisplay(raw: string) {
  // decodeURI keeps reserved characters (/, ?, #, &) intact while decoding %XX sequences.
  // This is ideal for showing human-readable paths like /wiki/Трофей:...
  try {
    return decodeURI(raw)
  } catch {
    return raw
  }
}

function renderLinkifiedText(value: unknown) {
  if (typeof value !== 'string') return value as any
  if (!value) return value

  const links = detectLinks(value)
  if (!links.length) {
    // Preserve newlines
    const lines = value.split('\n')
    return (
      <>
        {lines.map((line, idx) => (
          <Fragment key={`t-${idx}`}>
            {line}
            {idx < lines.length - 1 ? <br /> : null}
          </Fragment>
        ))}
      </>
    )
  }

  const nodes: any[] = []
  let last = 0
  for (const l of links) {
    if (l.start > last) nodes.push(value.slice(last, l.start))
    const displayText = decodeUrlForDisplay(value.slice(l.start, l.end))
    nodes.push(
      <a
        key={`u-${l.start}-${l.end}`}
        href={l.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        style={{ color: 'inherit', textDecoration: 'underline', overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {displayText}
      </a>,
    )
    last = l.end
  }
  if (last < value.length) nodes.push(value.slice(last))

  // Convert \n into <br/> while keeping anchors intact.
  const out: any[] = []
  let key = 0
  for (const part of nodes) {
    if (typeof part !== 'string') {
      out.push(<Fragment key={`p-${key++}`}>{part}</Fragment>)
      continue
    }
    const lines = part.split('\n')
    lines.forEach((line, idx) => {
      out.push(<Fragment key={`s-${key++}`}>{line}</Fragment>)
      if (idx < lines.length - 1) out.push(<br key={`br-${key++}`} />)
    })
  }
  return <>{out}</>
}

function isMarkdownLike(text: string): boolean {
  const s = text || ''
  if (!s) return false
  // Keep this intentionally small: we only switch renderer when user clearly uses markers.
  return (
    s.includes('```') ||
    s.includes('`') ||
    s.includes('**') ||
    // italic marker is ambiguous; require space+* or *_ to avoid false positives
    /(^|\s)\*(\S)/.test(s) ||
    /(^|\n)>\s/.test(s) ||
    /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/.test(s)
  )
}

function renderMessageText(value: unknown) {
  if (typeof value !== 'string') return value as any
  const s = value || ''
  if (!s) return s
  if (!isMarkdownLike(s)) return renderLinkifiedText(s)
  const html = renderChatMarkdownToHtml(s)
  // eslint-disable-next-line react/no-danger
  return <div className="chat-md" dangerouslySetInnerHTML={{ __html: html }} />
}

function parseYouTubeVideoId(urlString: string): string | null {
  try {
    const u = new URL(urlString)
    const host = u.hostname.toLowerCase()
    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      const id = u.pathname.replace(/^\//, '').split('/')[0] || null
      return id
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const v = u.searchParams.get('v')
      if (v) return v
      const parts = u.pathname.split('/').filter(Boolean)
      const head = parts[0] || ''
      const id = parts[1] || ''
      if (head === 'shorts' || head === 'embed' || head === 'v') return id || null
    }
    return null
  } catch {
    return null
  }
}

function getYouTubeEmbedUrl(videoId: string): string | null {
  const id = (videoId || '').trim()
  if (!id) return null
  const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`)
  embed.searchParams.set('autoplay', '0')
  embed.searchParams.set('rel', '0')
  embed.searchParams.set('modestbranding', '1')
  embed.searchParams.set('playsinline', '1')
  embed.searchParams.set('enablejsapi', '1')
  const origin =
    typeof window !== 'undefined' &&
    typeof window.location?.origin === 'string' &&
    (window.location.origin.startsWith('http://') || window.location.origin.startsWith('https://'))
      ? window.location.origin
      : null
  if (origin) embed.searchParams.set('origin', origin)
  return embed.toString()
}

function getSpotifyEmbed(urlString: string): { url: string; height: number } | null {
  try {
    const u = new URL(urlString)
    const host = u.hostname.toLowerCase()
    if (!host.includes('spotify.com') && host !== 'spoti.fi') return null
    if (host === 'spoti.fi') return null // short links require a HEAD/redirect; skip for now
    const parts = u.pathname.split('/').filter(Boolean)
    const type = parts[0]
    const id = parts[1]
    if (!type || !id) return null
    const allow = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist'])
    if (!allow.has(type)) return null
    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`
    const height = type === 'track' ? 152 : 352
    return { url: embedUrl, height }
  } catch {
    return null
  }
}

type AttachmentFileKind =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'code'
  | 'data'
  | 'binary'

type AttachmentFileInfo = {
  description: string
  kind: AttachmentFileKind
  badge?: string
}

const FILE_KIND_UI: Record<
  AttachmentFileKind,
  { badge: string; bg: string; fg: string }
> = {
  document: { badge: 'DOC', bg: '#f59e0b', fg: '#0b1220' },
  spreadsheet: { badge: 'XLS', bg: '#22c55e', fg: '#0b1220' },
  presentation: { badge: 'PPT', bg: '#fb923c', fg: '#0b1220' },
  image: { badge: 'IMG', bg: '#3b82f6', fg: '#f8fafc' },
  audio: { badge: 'AUD', bg: '#a855f7', fg: '#f8fafc' },
  video: { badge: 'VID', bg: '#ef4444', fg: '#f8fafc' },
  archive: { badge: 'ZIP', bg: '#14b8a6', fg: '#0b1220' },
  code: { badge: 'CODE', bg: '#6366f1', fg: '#f8fafc' },
  data: { badge: 'DATA', bg: '#64748b', fg: '#f8fafc' },
  binary: { badge: 'FILE', bg: '#64748b', fg: '#f8fafc' },
}

const FILE_EXTENSION_INFO: Record<string, AttachmentFileInfo> = {
  pdf: { description: 'PDF-документ', kind: 'document', badge: 'PDF' },
  doc: { description: 'Документ Word', kind: 'document', badge: 'DOC' },
  docx: { description: 'Документ Word', kind: 'document', badge: 'DOCX' },
  odt: { description: 'Текстовый документ OpenDocument', kind: 'document', badge: 'ODT' },
  rtf: { description: 'Форматированный текст', kind: 'document', badge: 'RTF' },
  txt: { description: 'Текстовый файл', kind: 'document', badge: 'TXT' },
  md: { description: 'Markdown-документ', kind: 'document', badge: 'MD' },

  xls: { description: 'Таблица Excel', kind: 'spreadsheet', badge: 'XLS' },
  xlsx: { description: 'Таблица Excel', kind: 'spreadsheet', badge: 'XLSX' },
  ods: { description: 'Таблица OpenDocument', kind: 'spreadsheet', badge: 'ODS' },
  csv: { description: 'CSV-таблица', kind: 'spreadsheet', badge: 'CSV' },
  tsv: { description: 'TSV-таблица', kind: 'spreadsheet', badge: 'TSV' },

  ppt: { description: 'Презентация PowerPoint', kind: 'presentation', badge: 'PPT' },
  pptx: { description: 'Презентация PowerPoint', kind: 'presentation', badge: 'PPTX' },
  odp: { description: 'Презентация OpenDocument', kind: 'presentation', badge: 'ODP' },
  key: { description: 'Презентация Keynote', kind: 'presentation', badge: 'KEY' },

  jpg: { description: 'Изображение JPEG', kind: 'image', badge: 'JPG' },
  jpeg: { description: 'Изображение JPEG', kind: 'image', badge: 'JPG' },
  png: { description: 'Изображение PNG', kind: 'image', badge: 'PNG' },
  gif: { description: 'Изображение GIF', kind: 'image', badge: 'GIF' },
  webp: { description: 'Изображение WebP', kind: 'image', badge: 'WEBP' },
  svg: { description: 'Векторное изображение SVG', kind: 'image', badge: 'SVG' },
  heic: { description: 'Изображение HEIC', kind: 'image', badge: 'HEIC' },
  bmp: { description: 'Изображение BMP', kind: 'image', badge: 'BMP' },
  tiff: { description: 'Изображение TIFF', kind: 'image', badge: 'TIFF' },

  mp3: { description: 'Аудиофайл MP3', kind: 'audio', badge: 'MP3' },
  wav: { description: 'Аудиофайл WAV', kind: 'audio', badge: 'WAV' },
  ogg: { description: 'Аудиофайл OGG', kind: 'audio', badge: 'OGG' },
  m4a: { description: 'Аудиофайл M4A', kind: 'audio', badge: 'M4A' },
  flac: { description: 'Аудиофайл FLAC', kind: 'audio', badge: 'FLAC' },
  aac: { description: 'Аудиофайл AAC', kind: 'audio', badge: 'AAC' },

  mp4: { description: 'Видеофайл MP4', kind: 'video', badge: 'MP4' },
  mov: { description: 'Видеофайл MOV', kind: 'video', badge: 'MOV' },
  avi: { description: 'Видеофайл AVI', kind: 'video', badge: 'AVI' },
  mkv: { description: 'Видеофайл MKV', kind: 'video', badge: 'MKV' },
  webm: { description: 'Видеофайл WebM', kind: 'video', badge: 'WEBM' },
  m4v: { description: 'Видеофайл M4V', kind: 'video', badge: 'M4V' },

  zip: { description: 'Архив ZIP', kind: 'archive', badge: 'ZIP' },
  rar: { description: 'Архив RAR', kind: 'archive', badge: 'RAR' },
  '7z': { description: 'Архив 7Z', kind: 'archive', badge: '7Z' },
  tar: { description: 'Архив TAR', kind: 'archive', badge: 'TAR' },
  gz: { description: 'Архив GZ', kind: 'archive', badge: 'GZ' },
  bz2: { description: 'Архив BZ2', kind: 'archive', badge: 'BZ2' },

  json: { description: 'JSON-файл данных', kind: 'data', badge: 'JSON' },
  xml: { description: 'XML-файл данных', kind: 'data', badge: 'XML' },
  yaml: { description: 'YAML-файл данных', kind: 'data', badge: 'YAML' },
  yml: { description: 'YAML-файл данных', kind: 'data', badge: 'YAML' },

  html: { description: 'HTML-документ', kind: 'code', badge: 'HTML' },
  css: { description: 'CSS-стили', kind: 'code', badge: 'CSS' },
  js: { description: 'JavaScript-файл', kind: 'code', badge: 'JS' },
  jsx: { description: 'React JSX-файл', kind: 'code', badge: 'JSX' },
  ts: { description: 'TypeScript-файл', kind: 'code', badge: 'TS' },
  tsx: { description: 'React TSX-файл', kind: 'code', badge: 'TSX' },

  apk: { description: 'Android-приложение (APK)', kind: 'binary', badge: 'APK' },
  exe: { description: 'Исполняемый файл Windows', kind: 'binary', badge: 'EXE' },
  msi: { description: 'Установщик Windows', kind: 'binary', badge: 'MSI' },
  dmg: { description: 'Образ macOS', kind: 'binary', badge: 'DMG' },
}

function formatAttachmentFileSize(value: unknown): string | null {
  const bytes = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return null

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  if (unitIndex === 0) return `${Math.round(size)} B`
  return `${size.toFixed(1)} ${units[unitIndex]}`
}

function extractFilenameFromUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  const clean = rawUrl.split('?')[0]?.split('#')[0] || rawUrl
  const name = clean.split('/').filter(Boolean).pop() || ''
  if (!name) return null
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function resolveAttachmentFileName(att: any, metadata: any): string {
  const candidates = [
    metadata?.originalName,
    metadata?.fileName,
    metadata?.filename,
    metadata?.name,
    metadata?.e2ee?.originalName,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return c.trim()
    }
  }
  const fromUrl = extractFilenameFromUrl(att?.url)
  if (fromUrl && !fromUrl.toLowerCase().endsWith('.eblusha')) return fromUrl
  return 'Файл'
}

function getAttachmentFilePresentation(att: any, metadata: any) {
  const fileName = resolveAttachmentFileName(att, metadata)
  const dot = fileName.lastIndexOf('.')
  let ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ''

  const mime =
    (typeof metadata?.mime === 'string' && metadata.mime.trim()) ||
    (typeof metadata?.contentType === 'string' && metadata.contentType.trim()) ||
    (typeof metadata?.e2ee?.originalType === 'string' && metadata.e2ee.originalType.trim()) ||
    ''

  const mimeToExt: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'application/zip': 'zip',
    'application/x-7z-compressed': '7z',
    'application/x-rar-compressed': 'rar',
    'application/x-tar': 'tar',
    'application/gzip': 'gz',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  }
  if (!ext && mime) {
    const base = mime.toLowerCase().split(';')[0]?.trim()
    ext = (base && mimeToExt[base]) || ''
  }

  const info = ext ? FILE_EXTENSION_INFO[ext] : undefined
  const kind: AttachmentFileKind = info?.kind ?? 'binary'
  const ui = FILE_KIND_UI[kind]
  const unknownExtBadge =
    ext && !info
      ? `.${ext.toUpperCase().slice(0, 3)}`
      : null
  const badge = (info?.badge || unknownExtBadge || ui.badge).slice(0, 4).toUpperCase()
  const description = info?.description || (ext ? `Файл ${ext.toUpperCase()}` : 'Неизвестный формат')
  const sizeText = formatAttachmentFileSize(att?.size ?? metadata?.size ?? metadata?.e2ee?.originalSize)
  const displayName = fileName === 'Файл' && ext ? `${fileName}.${ext}` : fileName
  return { fileName: displayName, description, sizeText, badge, ui }
}

function parseContentDispositionFilename(headerValue: string | null): string | null {
  const v = (headerValue || '').trim()
  if (!v) return null
  const star = v.match(/filename\*\s*=\s*([^;]+)/i)?.[1]?.trim()
  if (star) {
    const m = star.match(/^(?:UTF-8''|utf-8'')[\"]?(.+?)[\"]?$/)
    const raw = (m?.[1] || star).replace(/^"+|"+$/g, '')
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  const fn = v.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim()
  if (!fn) return null
  const raw = fn.replace(/^"+|"+$/g, '')
  return raw || null
}

type YouTubeOpenMode = 'embed' | 'external' | 'electron_session' | 'system_browser'

function getDefaultYouTubeOpenMode(): YouTubeOpenMode {
  // Mobile native wrappers should prefer system browser components.
  const isCapacitor =
    typeof window !== 'undefined' &&
    (window as any).Capacitor &&
    ((window as any).Capacitor.isNativePlatform?.() || (window as any).Capacitor.getPlatform?.() !== 'web')
  return isCapacitor ? 'system_browser' : 'embed'
}

function getYouTubeOpenMode(): YouTubeOpenMode {
  try {
    const raw =
      (typeof localStorage !== 'undefined' ? localStorage.getItem('youtubeOpenMode') : null) ||
      null
    const v = (raw || '').trim()
    if (v === 'embed' || v === 'external' || v === 'electron_session' || v === 'system_browser') return v
  } catch {}
  return getDefaultYouTubeOpenMode()
}

async function openUrlSystemBrowser(url: string) {
  // Best-effort: Capacitor Browser plugin if present; fallback to window.open.
  const w: any = typeof window !== 'undefined' ? window : null
  const cap = w?.Capacitor
  const browser = cap?.Plugins?.Browser
  if (browser?.open) {
    try {
      await browser.open({ url })
      return
    } catch {}
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function YouTubePlayerEmbed({ videoId, openUrl, debug }: { videoId: string; openUrl: string; debug: boolean }) {
  const src = getYouTubeEmbedUrl(videoId)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setReady(false)
    setFailed(false)
  }, [videoId])

  useEffect(() => {
    if (!src) return
    const t = window.setTimeout(() => {
      if (!ready) setFailed(true)
    }, 9000)
    return () => window.clearTimeout(t)
  }, [src, ready])

  useEffect(() => {
    if (!src) return
    const handler = (ev: MessageEvent) => {
      const origin = (ev.origin || '').toLowerCase()
      if (!origin.includes('youtube') && !origin.includes('ytimg') && !origin.includes('youtube-nocookie')) return
      const data = ev.data
      // The player sometimes sends stringified JSON.
      const obj = (() => {
        if (!data) return null
        if (typeof data === 'string') {
          try { return JSON.parse(data) } catch { return null }
        }
        if (typeof data === 'object') return data
        return null
      })() as any
      const eventName = typeof obj?.event === 'string' ? obj.event : null
      if (!eventName) return
      if (debug) {
        // eslint-disable-next-line no-console
        console.log('[YOUTUBE_DEBUG] iframe:message', { origin, event: eventName })
      }
      if (eventName === 'onReady') setReady(true)
      if (eventName === 'onError') setFailed(true)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [src, debug])

  if (!src) {
    return (
      <div style={{ padding: 12 }}>
        <button className="btn btn-secondary" type="button" onClick={() => window.open(openUrl, '_blank', 'noopener,noreferrer')}>
          Открыть в браузере
        </button>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.18)' }}>
      <iframe
        src={src}
        title="YouTube"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        loading="lazy"
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
      />
      {failed && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, background: 'rgba(0,0,0,0.55)', color: '#fff', textAlign: 'center' }}>
          <div style={{ maxWidth: 420 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Не удалось встроить YouTube</div>
            <div style={{ opacity: 0.9, fontSize: 13, lineHeight: 1.25, marginBottom: 12 }}>
              YouTube может требовать подтверждение/вход. Откройте видео в браузере.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" type="button" onClick={() => window.open(openUrl, '_blank', 'noopener,noreferrer')}>
                Открыть в браузере
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function LinkPreviewCard({ preview }: { preview: any }) {
  // Full preview when metadata exists, but still show a minimal card (domain + url) when it doesn't.
  if (!preview || typeof preview !== 'object') return null
  const url = typeof preview.url === 'string' ? preview.url : null
  const title = typeof preview.title === 'string' ? preview.title : null
  const description = typeof preview.description === 'string' ? preview.description : null
  const imageUrl = typeof preview.imageUrl === 'string' ? preview.imageUrl : null
  const imageWidth = typeof preview.imageWidth === 'number' && preview.imageWidth > 0 ? preview.imageWidth : null
  const imageHeight = typeof preview.imageHeight === 'number' && preview.imageHeight > 0 ? preview.imageHeight : null
  const siteName = typeof preview.siteName === 'string' ? preview.siteName : null
  const isLoading = (preview as any).__loading === true
  const blockedReason = typeof (preview as any).blockedReason === 'string' ? (preview as any).blockedReason : null
  if (!url) return null

  const YOUTUBE_DEBUG =
    typeof window !== 'undefined' &&
    (
      (window as any).__YOUTUBE_DEBUG === true ||
      (typeof localStorage !== 'undefined' && localStorage.getItem('YOUTUBE_DEBUG') === '1') ||
      (typeof location !== 'undefined' && location.search.includes('YOUTUBE_DEBUG=1'))
    )

  const [showEmbed, setShowEmbed] = useState(false)
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null)

  const siteLabel = siteName || (() => {
    try { return new URL(url).hostname } catch { return null }
  })()
  const fallbackTitle = (() => {
    try {
      const u = new URL(url)
      const host = u.hostname
      const pathRaw = (u.pathname && u.pathname !== '/' ? u.pathname : '')
      const path = pathRaw ? decodeUrlForDisplay(pathRaw) : ''
      return (host + path).slice(0, 160)
    } catch {
      return url.slice(0, 160)
    }
  })()
  const finalTitle = title || fallbackTitle
  const hasImage = !!imageUrl
  const aspectRatio =
    imageWidth && imageHeight
      ? `${imageWidth} / ${imageHeight}`
      : (measured?.w && measured?.h)
        ? `${measured.w} / ${measured.h}`
        : (hasImage ? '16 / 9' : undefined)
  const isMediaProvider = (() => {
    const label = (siteLabel || '').toLowerCase()
    if (label.includes('youtube') || label.includes('spotify')) return true
    try {
      const host = new URL(url).hostname.toLowerCase()
      return host.includes('youtube.com') || host === 'youtu.be' || host.includes('spotify.com') || host === 'spoti.fi'
    } catch {
      return false
    }
  })()
  // Never crop: show the whole image, let the container grow by aspect ratio.
  const imageFit: React.CSSProperties['objectFit'] = 'contain'

  const spotifyEmbed = getSpotifyEmbed(url)
  const youTubeId = url ? parseYouTubeVideoId(url) : null
  const youTubeMode = getYouTubeOpenMode()
  const embed =
    spotifyEmbed
      ? ({ kind: 'spotify' as const, url: spotifyEmbed.url, height: spotifyEmbed.height })
      : null

  const loading = isLoading && !blockedReason

  const effectiveW = imageWidth ?? measured?.w ?? null
  const maxCardW = (() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
    // Keep within bubble's max-width (92% viewport) and existing 720px cap.
    return Math.min(720, Math.floor(vw * 0.92) - 24)
  })()
  const targetW =
    effectiveW ??
    (youTubeId ? 560 : embed?.kind === 'spotify' ? 520 : null)
  const cardW = typeof targetW === 'number' && targetW > 0 ? Math.min(maxCardW, targetW) : null

  return (
    <div
      role="link"
      tabIndex={0}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        if (YOUTUBE_DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[YOUTUBE_DEBUG] ui:open', { url })
        }
        window.open(url, '_blank', 'noopener,noreferrer')
      }}
      style={{
        display: cardW ? 'inline-block' : 'block',
        width: cardW ? cardW : undefined,
        maxWidth: '100%',
        marginTop: 8,
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid var(--surface-border)',
        background: 'rgba(0,0,0,0.10)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
        position: 'relative',
        textDecoration: 'none',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      <div style={{ padding: hasImage ? '12px 12px 10px 12px' : '12px 12px 12px 12px' }}>
        {siteLabel && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--brand)',
              marginBottom: 6,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {siteLabel}
          </div>
        )}
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: description ? 6 : 0, lineHeight: 1.25 }}>
          {finalTitle}
        </div>
        {!!description && (
          <div
            style={{
              fontSize: 13,
              opacity: 0.9,
              lineHeight: 1.25,
              display: '-webkit-box',
              WebkitLineClamp: hasImage ? 2 : 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {description}
          </div>
        )}
        {!description && loading && (
          <div
            style={{
              marginTop: 6,
              height: 30,
              borderRadius: 8,
              background:
                'linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.12) 37%, rgba(255,255,255,0.06) 63%)',
              backgroundSize: '400% 100%',
              animation: 'eb-shimmer 1.2s ease-in-out infinite',
            }}
          />
        )}
      </div>
      {showEmbed && (youTubeId || embed) && (
        <div style={{ padding: '0 12px 12px 12px' }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          {youTubeId ? (
            <YouTubePlayerEmbed videoId={youTubeId} openUrl={url} debug={YOUTUBE_DEBUG} />
          ) : (
            (() => {
              const sEmbed = embed as { kind: 'spotify'; url: string; height: number } | null
              if (!sEmbed) return null
              return (
                <div
                  style={{
                    width: '100%',
                    height: sEmbed.height,
                    borderRadius: 10,
                    overflow: 'hidden',
                    background: 'rgba(0,0,0,0.18)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <iframe
                    src={sEmbed.url}
                    title={finalTitle}
                    allow="encrypted-media"
                    loading="lazy"
                    style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
                  />
                </div>
              )
            })()
          )}
        </div>
      )}
      {!showEmbed && (imageUrl || loading) && (
        <div style={{ padding: '0 12px 12px 12px' }}>
          <div
            style={{
              width: '100%',
              ...(embed?.kind === 'spotify'
                ? { height: embed.height }
                : (youTubeId ? { aspectRatio: '16 / 9' } : (aspectRatio ? { aspectRatio } : {}))),
              borderRadius: 10,
              overflow: 'hidden',
              background: isMediaProvider ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
              border: '1px solid rgba(255,255,255,0.08)',
              position: 'relative',
            }}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt=""
                style={{ width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', display: 'block', objectFit: imageFit, objectPosition: 'center' }}
                loading="lazy"
                referrerPolicy="no-referrer"
                onLoad={(e) => {
                  const img = e.currentTarget
                  const w = img.naturalWidth
                  const h = img.naturalHeight
                  if (w > 0 && h > 0 && !measured) setMeasured({ w, h })
                }}
                onError={(e) => {
                  const el = e.currentTarget
                  el.style.display = 'none'
                }}
              />
            ) : (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background:
                    'linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.12) 37%, rgba(255,255,255,0.06) 63%)',
                  backgroundSize: '400% 100%',
                  animation: 'eb-shimmer 1.2s ease-in-out infinite',
                }}
              />
            )}
            {(youTubeId || embed) && (
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={async (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (youTubeId) {
                    if (YOUTUBE_DEBUG) {
                      // eslint-disable-next-line no-console
                      console.log('[YOUTUBE_DEBUG] ui:youtube:play', { url, videoId: youTubeId, mode: youTubeMode })
                    }
                    if (youTubeMode === 'external') {
                      window.open(url, '_blank', 'noopener,noreferrer')
                      return
                    }
                    if (youTubeMode === 'system_browser') {
                      await openUrlSystemBrowser(url)
                      return
                    }
                    if (youTubeMode === 'electron_session') {
                      const embedUrl = getYouTubeEmbedUrl(youTubeId)
                      const w: any = window as any
                      if (embedUrl && typeof w?.__openYouTubeWindow === 'function') {
                        try { w.__openYouTubeWindow(embedUrl) } catch {}
                        return
                      }
                      window.open(url, '_blank', 'noopener,noreferrer')
                      return
                    }
                    // embed (default)
                    setShowEmbed(true)
                    return
                  }
                  if (embed) {
                    if (YOUTUBE_DEBUG) {
                      // eslint-disable-next-line no-console
                      console.log('[YOUTUBE_DEBUG] ui:embed:show', { url, embedUrl: embed.url })
                    }
                    setShowEmbed(true)
                  }
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  background: 'linear-gradient(180deg, rgba(0,0,0,0.05), rgba(0,0,0,0.25))',
                  color: '#fff',
                  cursor: 'pointer',
                }}
                aria-label="Play"
              >
                <span
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 999,
                    background: 'rgba(0,0,0,0.55)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backdropFilter: 'blur(6px)',
                  }}
                >
                  <Play size={24} />
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function VoiceMessagePlayer({ url, duration }: { url: string; duration: number }) {
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [waveform, setWaveform] = useState<number[]>([])
  const [loadingWaveform, setLoadingWaveform] = useState(true)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  
  // Convert to proxy URL if needed
  const proxyUrl = convertToProxyUrl(url) || url

  // Генерируем waveform при загрузке
  useEffect(() => {
    let cancelled = false
    setLoadingWaveform(true)
    getWaveform(proxyUrl, 60)
      .then((data) => {
        if (!cancelled) {
          setWaveform(data)
          setLoadingWaveform(false)
        }
      })
      .catch((err) => {
        console.error('Failed to load waveform:', err)
        if (!cancelled) {
          setLoadingWaveform(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [proxyUrl])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const updateTime = () => setCurrentTime(audio.currentTime)
    const handleEnded = () => {
      setPlaying(false)
      setCurrentTime(0)
    }
    const handlePlay = () => setPlaying(true)
    const handlePause = () => setPlaying(false)

    audio.addEventListener('timeupdate', updateTime)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)

    return () => {
      audio.removeEventListener('timeupdate', updateTime)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
    }
  }, [])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return

    if (playing) {
      audio.pause()
    } else {
      audio.play().catch((err) => {
        console.error('Failed to play audio:', err)
      })
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
  const currentBarIndex = waveform.length > 0 ? Math.floor((currentTime / duration) * waveform.length) : 0

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--surface-100)', borderRadius: 12, border: '1px solid var(--surface-border)' }}>
      <audio ref={audioRef} src={proxyUrl} preload="metadata" />
      <button
        type="button"
        onClick={togglePlay}
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: 'none',
          background: 'var(--brand)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        aria-label={playing ? 'Пауза' : 'Воспроизвести'}
      >
        {playing ? (
          <Square size={16} fill="currentColor" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M5 3l8 5-8 5V3z" />
          </svg>
        )}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        {loadingWaveform ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 24 }}>
            {Array(20).fill(0).map((_, i) => (
              <div
                key={i}
                style={{
                  width: 2,
                  height: 12,
                  background: 'var(--surface-border)',
                  borderRadius: 1,
                  animation: 'pulse 1.5s ease-in-out infinite',
                  animationDelay: `${i * 0.1}s`,
                }}
              />
            ))}
          </div>
        ) : waveform.length > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 24, marginBottom: 4 }}>
            {waveform.map((amplitude, index) => {
              const isActive = index <= currentBarIndex
              const height = Math.max(4, (amplitude / 100) * 20)
              return (
                <div
                  key={index}
                  style={{
                    width: 2,
                    height: `${height}px`,
                    background: isActive ? 'var(--brand)' : 'var(--surface-border)',
                    borderRadius: 1,
                    transition: 'background 0.2s ease',
                    alignSelf: 'flex-end',
                  }}
                />
              )
            })}
          </div>
        ) : (
          <div style={{ height: 24, display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Загрузка...
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>
        </div>
      </div>
    </div>
  )
}

type PendingAttachment = {
  url: string
  type: 'IMAGE' | 'FILE'
  size?: number
  width?: number
  height?: number
  progress?: number
  __pending?: boolean
  metadata?: Record<string, any>
}

type AttachmentDecryptionEntry = {
  status: 'pending' | 'ready' | 'error'
  url?: string
}

type AttachmentHeadInfo = {
  fileName?: string
  mime?: string
  size?: number
}

type PendingComposerImage = {
  id: string
  file: File
  previewUrl: string
  edited: boolean
  fileName: string
  source: 'paste' | 'upload'
}

type PendingMessage = {
  id: string
  createdAt: number
  senderId: string
  attachments: PendingAttachment[]
  content?: string
}

export default function ChatsPage() {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [callConvId, setCallConvId] = useState<string | null>(null)
  const [minimizedCallConvId, setMinimizedCallConvId] = useState<string | null>(null)
  const [outgoingCall, setOutgoingCall] = useState<{ conversationId: string; startedAt: number; video: boolean; minimized?: boolean } | null>(null)
  const outgoingCallRef = useRef<typeof outgoingCall>(null)
  useEffect(() => { outgoingCallRef.current = outgoingCall }, [outgoingCall])
  const outgoingCallTimerRef = useRef<number | null>(null)
  const [messageText, setMessageText] = useState('')
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null)
  const [editState, setEditState] = useState<{
    messageId: string
    originalText: string
  } | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const attachInputRef = useRef<HTMLInputElement | null>(null)
  const ringTimerRef = useRef<number | null>(null)
  const ringingConvIdRef = useRef<string | null>(null)
  const ringAudioRef = useRef<HTMLAudioElement | null>(null)
  const ringUnlockedRef = useRef<boolean>(false)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  // notify sound
  const notifyAudioRef = useRef<HTMLAudioElement | null>(null)
  const notifyUnlockedRef = useRef<boolean>(false)
  const [showAudioUnlock, setShowAudioUnlock] = useState(false)
  const audioUnlockingRef = useRef<boolean>(false)
  // dialing sound
  const dialingAudioRef = useRef<HTMLAudioElement | null>(null)
  const dialingToneStopRef = useRef<null | (() => void)>(null)
  // end call sound
  const endCallAudioRef = useRef<HTMLAudioElement | null>(null)
  const [typingByUserId, setTypingByUserId] = useState<Record<string, number>>({})
  const [typingDots, setTypingDots] = useState(1)
  const [leftAlignAll, setLeftAlignAll] = useState(false)
  // Outgoing typing emitter (per active conversation)
  const typingEmitRef = useRef<{
    convId: string | null
    startTimer: number | null
    stopTimer: number | null
    lastSentTyping: boolean
    lastSentAt: number
  }>({ convId: null, startTimer: null, stopTimer: null, lastSentTyping: false, lastSentAt: 0 })
  // Incoming typing cleanup (expire stale entries)
  const typingCleanupTimerRef = useRef<number | null>(null)
  const tm = useRef<{ pinTimer: number | null }>({ pinTimer: null })
  const [contextMenu, setContextMenu] = useState<{ open: boolean; x: number; y: number; messageId: string | null }>(() => ({ open: false, x: 0, y: 0, messageId: null }))
  const [convMenu, setConvMenu] = useState<{ open: boolean; x: number; y: number; conversationId: string | null }>(() => ({ open: false, x: 0, y: 0, conversationId: null }))
  const convMenuRef = useRef<HTMLDivElement | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ open: boolean; anchor: HTMLElement | null }>(() => ({ open: false, anchor: null }))
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const [availabilityContext, setAvailabilityContext] = useState<{
    conversationId: string
    peerId: string
    peerName?: string | null
    peerTimeZone?: string | null
  } | null>(null)
  const convScrollRef = useRef<HTMLDivElement | null>(null)
  const [groupAvatarEditor, setGroupAvatarEditor] = useState(false)
  const [reactionBar, setReactionBar] = useState<{ open: boolean; x: number; y: number; messageId: string | null }>(() => ({ open: false, x: 0, y: 0, messageId: null }))
  const [forwardModal, setForwardModal] = useState<{ open: boolean; messageId: string | null }>({ open: false, messageId: null })
  const [addParticipantsModal, setAddParticipantsModal] = useState(false)
  const [addParticipantsSelectedIds, setAddParticipantsSelectedIds] = useState<string[]>([])
  const [addParticipantsLoading, setAddParticipantsLoading] = useState(false)
  const [addParticipantsMode, setAddParticipantsMode] = useState<'friends' | 'eblid'>('friends')
  const [addParticipantsEblDigits, setAddParticipantsEblDigits] = useState<string[]>(['', '', '', ''])
  const addParticipantsEblRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ]
  const [addParticipantsFoundUser, setAddParticipantsFoundUser] = useState<any | null>(null)
  const [addParticipantsSearchError, setAddParticipantsSearchError] = useState<string | null>(null)
  const [addParticipantsSearching, setAddParticipantsSearching] = useState(false)
  const addParticipantsSearchTokenRef = useRef(0)
  const [convHasTopFade, setConvHasTopFade] = useState(false)
  const [convHasBottomFade, setConvHasBottomFade] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const isMobileRef = useRef(isMobile)
  const [isNarrowHeaderButtons, setIsNarrowHeaderButtons] = useState(false)
  const [mobileView, setMobileView] = useState<'list' | 'conversation'>('list')
useEffect(() => { isMobileRef.current = isMobile }, [isMobile])
  const [showJump, setShowJump] = useState(false)
  const visibleObserver = useRef<IntersectionObserver | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const nodesByMessageId = useRef<Map<string, HTMLElement>>(new Map())
  const nearBottomRef = useRef<boolean>(true)
  const userStickyScrollRef = useRef<boolean>(false)
  const lastRenderedMessagesRef = useRef(0)
  const lastScrollConvRef = useRef<string | null>(null)
  const batchToRead = useRef<Set<string>>(new Set())
  const batchTimer = useRef<number | null>(null)
  const scrollPinTimerRef = useRef<number | null>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const touchDeltaRef = useRef<number>(0)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [groupTitle, setGroupTitle] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupAvatarFile, setNewGroupAvatarFile] = useState<File | null>(null)
  const [newGroupAvatarPreviewUrl, setNewGroupAvatarPreviewUrl] = useState<string | null>(null)
  const [newGroupAvatarSourceUrl, setNewGroupAvatarSourceUrl] = useState<string | null>(null)
  const [newGroupAvatarBlob, setNewGroupAvatarBlob] = useState<Blob | null>(null)
  const [newGroupAvatarEditorOpen, setNewGroupAvatarEditorOpen] = useState(false)
  const newGroupFileInputRef = useRef<HTMLInputElement | null>(null)
  const newGroupEditorRef = useRef<HTMLDivElement | null>(null)
  const newGroupImageRef = useRef<HTMLImageElement | null>(null)
  const newGroupCropCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [newGroupCrop, setNewGroupCrop] = useState({ x: 0, y: 0, scale: 1 })
  const [newGroupDragOver, setNewGroupDragOver] = useState(false)
  const [contactsOpen, setContactsOpen] = useState(false)
  const [eblDigits, setEblDigits] = useState<string[]>(['', '', '', ''])
  const eblRefs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)]
  const [foundUser, setFoundUser] = useState<any | null>(null)
  const [sendingInvite, setSendingInvite] = useState(false)
  const [myEblid, setMyEblid] = useState<string>('')
  const [mePopupOpen, setMePopupOpen] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [selectedAvatarFile, setSelectedAvatarFile] = useState<File | null>(null)
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null)
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0, scale: 1 })
  const [uploadProgress, setUploadProgress] = useState<number>(0)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const touchStateRef = useRef<{ touches: React.Touch[], initialDistance: number, initialScale: number, initialX: number, initialY: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  // Refs для редактора группы
  const groupEditorRef = useRef<HTMLDivElement | null>(null)
  const groupImageRef = useRef<HTMLImageElement | null>(null)
  const groupTouchStateRef = useRef<{ touches: React.Touch[], initialDistance: number, initialScale: number, initialX: number, initialY: number } | null>(null)
  const groupRafRef = useRef<number | null>(null)
  const groupCropCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const groupFileInputRef = useRef<HTMLInputElement | null>(null)
  const [groupCrop, setGroupCrop] = useState({ x: 0, y: 0, scale: 1 })
  const [groupAvatarPreviewUrl, setGroupAvatarPreviewUrl] = useState<string | null>(null)
  const [groupSelectedAvatarFile, setGroupSelectedAvatarFile] = useState<File | null>(null)
  const [groupDragOver, setGroupDragOver] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ open: boolean; index: number; items: string[] }>({ open: false, index: 0, items: [] })
  const [attachUploading, setAttachUploading] = useState(false)
  const [attachProgress, setAttachProgress] = useState(0)
  const [attachDragOver, setAttachDragOver] = useState(false)
  const [callPermissionError, setCallPermissionError] = useState<string | null>(null)
  const [pendingByConv, setPendingByConv] = useState<Record<string, PendingMessage[]>>({})
  const [attachmentDecryptMap, setAttachmentDecryptMap] = useState<Record<string, AttachmentDecryptionEntry>>({})
  const [attachmentHeadInfoMap, setAttachmentHeadInfoMap] = useState<Record<string, AttachmentHeadInfo>>({})
  const attachmentDecryptUrlsRef = useRef<Set<string>>(new Set())
  const attachmentDecryptInProgressRef = useRef<Set<string>>(new Set())
  const attachmentHeadInfoInFlightRef = useRef<Set<string>>(new Set())
  const [pendingImages, setPendingImages] = useState<PendingComposerImage[]>([])
  const [editingImageId, setEditingImageId] = useState<string | null>(null)
  const [e2eeVersion, setE2eeVersion] = useState(0)
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceDuration, setVoiceDuration] = useState(0)
  const [voiceWaveform, setVoiceWaveform] = useState<number[]>([])
  const waveformUpdateIntervalRef = useRef<number | null>(null)
  const waveformContainerRef = useRef<HTMLDivElement | null>(null)
  const [waveformMaxBars, setWaveformMaxBars] = useState(150)

  // Вычисляем количество баров на основе ширины контейнера
  useEffect(() => {
    if (isMobile) {
      setWaveformMaxBars(60)
      return
    }
    
    const updateMaxBars = () => {
      if (!waveformContainerRef.current) return
      const containerWidth = waveformContainerRef.current.clientWidth
      const barTotalWidth = 4 // 2px ширина + 2px gap
      const maxBars = Math.floor(containerWidth / barTotalWidth)
      setWaveformMaxBars(Math.max(100, maxBars)) // Минимум 100 баров
    }
    
    updateMaxBars()
    const resizeObserver = new ResizeObserver(updateMaxBars)
    if (waveformContainerRef.current) {
      resizeObserver.observe(waveformContainerRef.current)
    }
    
    return () => {
      resizeObserver.disconnect()
    }
  }, [isMobile])

  // Prefetch CallOverlay to avoid first-time render delay (bundle loading)
  useEffect(() => {
    preloadCallOverlay().catch(() => {})
  }, [])
const activeConversationIdRef = useRef<string | null>(null)
useEffect(() => { activeConversationIdRef.current = activeId }, [activeId])
  useEffect(() => {
    if (availabilityContext && availabilityContext.conversationId !== activeId) {
      setAvailabilityContext(null)
    }
  }, [availabilityContext, activeId])
const pendingImagesRef = useRef<PendingComposerImage[]>([])
useEffect(() => { pendingImagesRef.current = pendingImages }, [pendingImages])
  const releasePreviewUrl = useCallback((url: string | null | undefined) => {
    if (!url) return
    try {
      URL.revokeObjectURL(url)
    } catch {
      // ignore revocation errors
    }
  }, [])
  const clearPendingImages = useCallback(() => {
    setEditingImageId(null)
    setPendingImages((prev) => {
      if (!prev.length) return prev
      prev.forEach((img) => releasePreviewUrl(img.previewUrl))
      return []
    })
  }, [releasePreviewUrl, setEditingImageId])
  const addComposerImage = useCallback((file: File, source: 'paste' | 'upload') => {
    if (!file || !file.type.startsWith('image/')) return
    setPendingImages((prev) => {
      if (prev.length >= MAX_PENDING_IMAGES) {
        alert('Можно редактировать не более 10 изображений за раз.')
        return prev
      }
      const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `img-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const previewUrl = URL.createObjectURL(file)
      const entry: PendingComposerImage = {
        id,
        file,
        previewUrl,
        edited: false,
        fileName: file.name || 'image.png',
        source,
      }
      return [...prev, entry]
    })
  }, [])
  const removeComposerImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const target = prev.find((img) => img.id === id)
      if (target) releasePreviewUrl(target.previewUrl)
      return prev.filter((img) => img.id !== id)
    })
    setEditingImageId((prev) => (prev === id ? null : prev))
  }, [releasePreviewUrl, setEditingImageId])
  const applyComposerImageEdit = useCallback((id: string, file: File, previewUrl: string) => {
    setPendingImages((prev) =>
      prev.map((img) => {
        if (img.id !== id) return img
        releasePreviewUrl(img.previewUrl)
        return {
          ...img,
          file,
          previewUrl,
          edited: true,
          fileName: file.name || img.fileName,
        }
      }),
    )
  }, [releasePreviewUrl])
  const devicesQuery = useQuery({
    queryKey: ['my-devices'],
    queryFn: async () => {
      const response = await api.get('/devices')
      return response.data.devices as Array<{ id: string; name?: string; platform?: string | null; userId: string }>
    },
  })
  const [pingMs, setPingMs] = useState<number | null>(null)
  const [isSocketOnline, setIsSocketOnline] = useState<boolean>(() => socket.connected)
  const [myPresence, setMyPresence] = useState<'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL' | null>(null)
  // Realtime presence overrides (e.g. IN_CALL) must win over API poll results,
  // because the API returns base User.status (ONLINE/BACKGROUND/OFFLINE) from DB.
  const [presenceOverridesByUserId, setPresenceOverridesByUserId] = useState<Record<string, string>>({})
  type PresenceGameState = { ts: number; game: NonNullable<PresenceGamePayload['game']> }
  const [presenceGameByUserId, setPresenceGameByUserId] = useState<Record<string, PresenceGameState>>({})
  const presenceGameExpiryTimersRef = useRef<Map<string, number>>(new Map())
  const [loadedImages, setLoadedImages] = useState<Record<string, boolean>>({})
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({})
  const [imageDimensions, setImageDimensions] = useState<Record<string, { width: number; height: number }>>({})
  const [endSecretModalOpen, setEndSecretModalOpen] = useState(false)
  const [pendingSecretOffers, setPendingSecretOffers] = useState<Record<string, { from: { id: string; name: string; deviceId?: string | null } }>>({})
  const [secretRequestLoading, setSecretRequestLoading] = useState(false)
  const [secretActionLoading, setSecretActionLoading] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const me = useAppStore((s) => s.session?.user)
  const storedUserIdRef = useRef<string | null>(null)
  if (storedUserIdRef.current === null && typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem('eb_user')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.id === 'string') {
          storedUserIdRef.current = parsed.id
        }
      }
    } catch {
      storedUserIdRef.current = null
    }
  }
  useEffect(() => {
    if (me?.id) {
      storedUserIdRef.current = me.id
    }
  }, [me?.id])
  const currentUserId = me?.id ?? storedUserIdRef.current ?? null
  const callStore = useCallStore()
  const client = useQueryClient()
  const activePendingMessages = useMemo<PendingMessage[]>(() => {
    if (!activeId) return []
    return pendingByConv[activeId] || []
  }, [activeId, pendingByConv])
  const editingImage = useMemo(() => {
    if (!editingImageId) return null
    return pendingImages.find((img) => img.id === editingImageId) ?? null
  }, [pendingImages, editingImageId])
  const lightboxTimerRef = useRef<number | null>(null)
  const attachInputOverlayRef = useRef<HTMLDivElement | null>(null)
  const [activeCalls, setActiveCalls] = useState<Record<string, { startedAt: number | null; endedAt?: number | null; active: boolean; participants?: string[]; elapsedMs?: number }>>({})
  const [timerTick, setTimerTick] = useState(0)
  const callConvIdRef = useRef<string | null>(null)
  useEffect(() => { callConvIdRef.current = callConvId }, [callConvId])
  const inviterByConvRef = useRef<Record<string, string>>({})
  const minCallDurationUntilRef = useRef<Record<string, number>>({})
  const pendingCallAutoCloseTimersRef = useRef<Record<string, number>>({})
  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      Object.values(pendingCallAutoCloseTimersRef.current).forEach((id) => {
        if (typeof id === 'number') {
          window.clearTimeout(id)
        }
      })
      if (outgoingCallTimerRef.current) {
        window.clearTimeout(outgoingCallTimerRef.current)
      }
      stopDialingSound()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Обновляем таймер дозвона каждую секунду
  useEffect(() => {
    if (!outgoingCall) return
    const interval = setInterval(() => {
      setOutgoingCall((prev) => prev ? { ...prev } : null) // Force re-render для обновления времени
    }, 1000)
    return () => clearInterval(interval)
  }, [outgoingCall])
  const getConversationFromCache = useCallback((conversationId: string | null | undefined) => {
    if (!conversationId) return null
    const rows = client.getQueryData(['conversations']) as any[] | undefined
    if (!Array.isArray(rows)) return null
    const row = rows.find((r: any) => r?.conversation?.id === conversationId)
    return row?.conversation ?? null
  }, [client])
  const isOneToOneConversation = useCallback((conversationId: string | null | undefined) => {
    const conv = getConversationFromCache(conversationId)
    if (!conv) return false
    const participantsCount = conv.participants?.length ?? 0
    return !conv.isGroup && participantsCount <= 2
  }, [getConversationFromCache])
  const clearMinCallDurationGuard = useCallback((conversationId: string | null | undefined) => {
    if (!conversationId) return
    const timerId = pendingCallAutoCloseTimersRef.current[conversationId]
    if (typeof timerId === 'number' && typeof window !== 'undefined') {
      window.clearTimeout(timerId)
      delete pendingCallAutoCloseTimersRef.current[conversationId]
    }
    delete minCallDurationUntilRef.current[conversationId]
  }, [])
  const beginOutgoingCallGuard = useCallback((conversationId: string | null | undefined) => {
    if (!conversationId) return
    if (!isOneToOneConversation(conversationId)) return
    minCallDurationUntilRef.current[conversationId] = Date.now() + MIN_OUTGOING_CALL_DURATION_MS
  }, [isOneToOneConversation])
  const scheduleAfterMinCallDuration = useCallback((conversationId: string | null | undefined, action: () => void, options?: { force?: boolean }) => {
    if (!conversationId) {
      action()
      return
    }
    if (options?.force) {
      clearMinCallDurationGuard(conversationId)
      action()
      return
    }
    const deadline = minCallDurationUntilRef.current[conversationId]
    if (!deadline) {
      action()
      return
    }
    const now = Date.now()
    if (now >= deadline) {
      clearMinCallDurationGuard(conversationId)
      action()
      return
    }
    const remaining = deadline - now
    const existing = pendingCallAutoCloseTimersRef.current[conversationId]
    if (typeof existing === 'number' && typeof window !== 'undefined') {
      window.clearTimeout(existing)
    }
    if (typeof window === 'undefined') {
      action()
      return
    }
    pendingCallAutoCloseTimersRef.current[conversationId] = window.setTimeout(() => {
      delete pendingCallAutoCloseTimersRef.current[conversationId]
      clearMinCallDurationGuard(conversationId)
      action()
    }, remaining)
  }, [clearMinCallDurationGuard])
  const describeMediaPermissionError = useCallback((needsVideo: boolean, error: unknown) => {
    const target = needsVideo ? 'камере и микрофону' : 'микрофону'
    const name = typeof error === 'object' && error && 'name' in error ? String((error as { name?: string }).name) : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return `Браузер запретил доступ к ${target}. Разрешите его в адресной строке и попробуйте снова.`
    }
    if (name === 'NotFoundError') {
      return needsVideo
        ? 'Браузер не нашёл камеру или микрофон. Подключите устройство и попробуйте ещё раз.'
        : 'Браузер не нашёл микрофон. Подключите устройство и попробуйте ещё раз.'
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Камера или микрофон уже используются другим приложением или вкладкой.'
    }
    return `Не удалось получить доступ к ${target}. Проверьте настройки браузера и попробуйте снова.`
  }, [])
  const requireMediaAccess = useCallback(async (needsVideo: boolean) => {
    try {
      const result = await ensureMediaPermissions({ audio: true, video: needsVideo })
      if (!result.ok) {
        setCallPermissionError(describeMediaPermissionError(needsVideo, result.error))
        return false
      }
      setCallPermissionError(null)
      return true
    } catch (error) {
      setCallPermissionError(describeMediaPermissionError(needsVideo, error))
      return false
    }
  }, [describeMediaPermissionError])
  const acceptIncomingCall = useCallback(async (withVideo: boolean) => {
    const incoming = callStore.incoming
    if (!incoming) return
    if (!(await requireMediaAccess(withVideo))) return
    const convId = incoming.conversationId
    beginOutgoingCallGuard(convId)
    acceptCall(convId, withVideo)
    callStore.startOutgoing(convId, withVideo)
    setActiveCalls((prev) => {
      const current = prev[convId]
      const myId = me?.id
      if (!current?.active) {
        return { ...prev, [convId]: { startedAt: Date.now(), active: true, participants: myId ? [myId] : [] } }
      }
      if (myId && current.participants && !current.participants.includes(myId)) {
        return { ...prev, [convId]: { ...current, participants: [...current.participants, myId] } }
      }
      return prev
    })
    setCallConvId(convId)
    setMinimizedCallConvId((prev) => (prev === convId ? null : prev))
    callStore.setIncoming(null)
    stopRingtone()
  }, [beginOutgoingCallGuard, callStore, me?.id, requireMediaAccess])

  const declineIncomingCall = useCallback(() => {
    const incoming = callStore.incoming
    if (!incoming) return
    declineCall(incoming.conversationId)
    callStore.setIncoming(null)
    stopRingtone()
  }, [callStore])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const bridge = {
      accept: async (conversationId: string, withVideo: boolean) => {
        if (callStore.incoming?.conversationId !== conversationId) {
          return false
        }
        await acceptIncomingCall(withVideo)
        return true
      },
      decline: (conversationId: string) => {
        if (callStore.incoming?.conversationId !== conversationId) {
          return false
        }
        declineIncomingCall()
        return true
      },
    }
    window.__nativeCallOverlayBridge = bridge
    return () => {
      if (window.__nativeCallOverlayBridge === bridge) {
        delete window.__nativeCallOverlayBridge
      }
    }
  }, [callStore.incoming?.conversationId, acceptIncomingCall, declineIncomingCall])
  useEffect(() => {
    const id = window.setInterval(() => setTimerTick((t) => (t + 1) % 1000000), 1000)
    return () => window.clearInterval(id)
  }, [])

  // Fix "Завершен N мин назад" right after hangup:
  // when a call transitions active -> inactive, endedAt must be "now".
  // If endedAt is far from now at that exact transition (e.g. equals call start),
  // force-correct it once so the post-call timer counts from the hangup moment.
  const prevCallActiveByConvIdRef = useRef<Record<string, boolean>>({})
  useEffect(() => {
    const prevActiveMap = prevCallActiveByConvIdRef.current
    const now = Date.now()
    const toFix: string[] = []

    for (const [cid, entry] of Object.entries(activeCalls || {})) {
      if (!entry) continue
      const wasActive = !!prevActiveMap[cid]
      const isActive = !!entry.active
      if (!wasActive || isActive) continue
      const endedAt = typeof entry.endedAt === 'number' && Number.isFinite(entry.endedAt) ? entry.endedAt : null
      // If we just transitioned to inactive, endedAt should be very close to "now".
      if (!endedAt || Math.abs(now - endedAt) > 5000) {
        toFix.push(cid)
      }
    }

    // Update prev map to current.
    const nextPrev: Record<string, boolean> = {}
    for (const [cid, entry] of Object.entries(activeCalls || {})) {
      if (!entry) continue
      nextPrev[cid] = !!entry.active
    }
    prevCallActiveByConvIdRef.current = nextPrev

    if (!toFix.length) return
    setActiveCalls((prev) => {
      const next = { ...prev }
      for (const cid of toFix) {
        const entry = prev[cid]
        if (!entry || entry.active) continue
        next[cid] = { ...entry, endedAt: now }
      }
      return next
    })
  }, [activeCalls])

  useEffect(() => {
    if (!callPermissionError) return
    if (typeof window === 'undefined') return
    const timer = window.setTimeout(() => setCallPermissionError(null), 9000)
    return () => window.clearTimeout(timer)
  }, [callPermissionError])

  useEffect(() => {
    const update = () => {
      const mobile = window.innerWidth <= 768
      setIsMobile(mobile)
      isMobileRef.current = mobile
      // Narrow desktop header: shrink ONLY call buttons to icons.
      setIsNarrowHeaderButtons(!mobile && window.innerWidth <= 1300)
      if (!mobile) {
        setMobileView('conversation')
      } else if (!activeId) {
        setMobileView('list')
      }
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    if (!isMobile) return
    if (activeId) setMobileView('conversation')
    else setMobileView('list')
  }, [isMobile, activeId])


  // Initialize/subscribe to server call status for group calls
  useEffect(() => {
    const debugCallStatus = (() => {
      try {
        const qs = new URLSearchParams(window.location.search)
        const q = qs.get('lkDebugCallStatus')
        if (q === '1' || q === 'true') return true
        const raw = window.localStorage.getItem('lk-debug-callstatus')
        return raw === '1' || raw === 'true'
      } catch {
        return false
      }
    })()

    const handleSingle = (p: { conversationId: string; active: boolean; startedAt?: number; elapsedMs?: number; participants?: string[] }) => {
      if (debugCallStatus) console.log('[CallStatus] Single:', p)
      setActiveCalls((prev) => {
        const list = client.getQueryData(['conversations']) as any[] | undefined
        const conv = Array.isArray(list) ? list.find((r: any) => r.conversation.id === p.conversationId)?.conversation : null
        const current = prev[p.conversationId]
        // Server call status stream is used only for group calls.
        // Do NOT apply it to 1:1 calls, otherwise it can overwrite local endedAt and show wrong "Завершен N мин назад".
        const isGroup = !!(conv && ((conv.isGroup) || ((conv.participants?.length ?? 0) > 2)))
        if (!isGroup) {
          return prev
        }

        const participants = p.participants || []
        if (p.active) {
          const serverStartedAt = typeof p.startedAt === 'number' && p.startedAt > 0 ? p.startedAt : (current?.startedAt ?? Date.now())
          return {
            ...prev,
            [p.conversationId]: {
              active: true,
              startedAt: serverStartedAt,
              participants,
              endedAt: null,
              elapsedMs: typeof p.elapsedMs === 'number' ? p.elapsedMs : undefined,
            },
          }
        }

        const prevEndedAt = (typeof current?.endedAt === 'number' && Number.isFinite(current.endedAt)) ? current.endedAt : null
        const startedAt = (typeof current?.startedAt === 'number' && Number.isFinite(current.startedAt)) ? current.startedAt : null
        // If we receive an "inactive" update but endedAt is missing/invalid (or equals startedAt),
        // treat it as ended "now" to avoid incorrect "Завершен N мин назад" right after hangup.
        const endedAtRaw = current?.active ? Date.now() : prevEndedAt
        const endedAt =
          (typeof endedAtRaw === 'number' && typeof startedAt === 'number' && endedAtRaw <= startedAt)
            ? Date.now()
            : endedAtRaw
        return {
          ...prev,
          [p.conversationId]: {
            active: false,
            startedAt: current?.startedAt ?? null,
            endedAt,
            participants: [],
            elapsedMs: undefined,
          },
        }
      })
    }
    const handleBulk = (payload: { statuses: Record<string, { active: boolean; startedAt?: number; elapsedMs?: number; participants?: string[] }> }) => {
      if (debugCallStatus) console.log('[CallStatus] Bulk:', payload)
      setActiveCalls((prev) => {
        const merged = { ...prev }
        const list = client.getQueryData(['conversations']) as any[] | undefined
        
        for (const [cid, st] of Object.entries(payload.statuses || {})) {
          const conv = Array.isArray(list) ? list.find((r: any) => r.conversation.id === cid)?.conversation : null
          const current = prev[cid]
          const isGroup = !!(conv && ((conv.isGroup) || ((conv.participants?.length ?? 0) > 2)))
          if (!isGroup) continue

          const participants = st.participants || []
          if (st.active) {
            const serverStartedAt = typeof st.startedAt === 'number' && st.startedAt > 0 ? st.startedAt : (current?.startedAt ?? Date.now())
            merged[cid] = {
              active: true,
              startedAt: serverStartedAt,
              participants,
              endedAt: null,
              elapsedMs: typeof st.elapsedMs === 'number' ? st.elapsedMs : undefined,
            }
            continue
          }

          const prevEndedAt = (typeof current?.endedAt === 'number' && Number.isFinite(current.endedAt)) ? current.endedAt : null
          const startedAt = (typeof current?.startedAt === 'number' && Number.isFinite(current.startedAt)) ? current.startedAt : null
          const endedAtRaw = current?.active ? Date.now() : prevEndedAt
          const endedAt =
            (typeof endedAtRaw === 'number' && typeof startedAt === 'number' && endedAtRaw <= startedAt)
              ? Date.now()
              : endedAtRaw
          merged[cid] = {
            active: false,
            startedAt: current?.startedAt ?? null,
            endedAt,
            participants: [],
            elapsedMs: undefined,
          }
        }
        return merged
      })
    }
    onCallStatus(handleSingle)
    onCallStatusBulk(handleBulk)
    return () => {
      socket.off('call:status', handleSingle as any)
      socket.off('call:status:bulk', handleBulk as any)
    }
  }, [])

  // (moved below queries declaration)

  // keep menu within viewport
  useEffect(() => {
    if (!contextMenu.open) return
    const menu = menuRef.current
    if (!menu) return
    const vw = window.innerWidth
    const vh = (window as any).visualViewport ? (window as any).visualViewport.height : window.innerHeight
    const rect = menu.getBoundingClientRect()
    let left = contextMenu.x
    let top = contextMenu.y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    if (left !== contextMenu.x || top !== contextMenu.y) {
      setContextMenu((s) => ({ ...s, x: left, y: top }))
    }
  }, [contextMenu.open, contextMenu.x, contextMenu.y])

  useEffect(() => {
    if (!convMenu.open) return
    const menu = convMenuRef.current
    if (!menu) return
    const vw = window.innerWidth
    const vh = (window as any).visualViewport ? (window as any).visualViewport.height : window.innerHeight
    const rect = menu.getBoundingClientRect()
    let left = convMenu.x
    let top = convMenu.y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    if (left !== convMenu.x || top !== convMenu.y) {
      setConvMenu((s) => ({ ...s, x: left, y: top }))
    }
  }, [convMenu.open, convMenu.x, convMenu.y])

  useEffect(() => {
    if (!headerMenu.open || !headerMenu.anchor) return
    const menu = headerMenuRef.current
    if (!menu) return
    const anchorRect = headerMenu.anchor.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = (window as any).visualViewport ? (window as any).visualViewport.height : window.innerHeight
    menu.style.display = 'flex'
    const rect = menu.getBoundingClientRect()
    let left = anchorRect.right - rect.width
    let top = anchorRect.bottom + 8
    if (left < 8) left = 8
    if (left + rect.width > vw - 8) left = vw - rect.width - 8
    if (top + rect.height > vh - 8) top = anchorRect.top - rect.height - 8
    if (top < 8) top = 8
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [headerMenu.open, headerMenu.anchor])

  useEffect(() => {
    if (!activeId) {
      setHeaderMenu({ open: false, anchor: null })
    }
  }, [activeId])

  function selectConversation(id: string) {
    setActiveId((prev) => {
      try {
        if (prev && prev !== id) {
          const prevRow = (conversationsQuery.data || []).find((r: any) => r.conversation.id === prev)
          const prevConv = prevRow?.conversation
          if (prevConv?.isSecret) {
            // Drop cached messages for secret conversations when leaving them
            client.removeQueries({ queryKey: ['messages', prev] })
          }
        }
      } catch {
        // ignore cache cleanup errors
      }
        return id
      })
    if (isMobile) {
      setMobileView('conversation')
    }
    if (pendingImagesRef.current.length) {
      clearPendingImages()
    }
  }

  async function ensureLocalDevice(): Promise<{ deviceId: string; publicKey: string } | null> {
    let info = getStoredDeviceInfo()
    if (!info) {
      info = await ensureDeviceBootstrap()
    }
    if (!info) return null
    return info
  }

  async function initiateSecretChat(targetUserId: string) {
    if (secretRequestLoading) return
    setSecretRequestLoading(true)
    const MAX_REBOOT_ATTEMPTS = 2
    let rebootAttempts = 0
    const tryRebootstrap = async () => {
      if (rebootAttempts >= MAX_REBOOT_ATTEMPTS) {
        throw new Error('Не удалось подготовить устройство для секретного чата. Попробуйте позже.')
      }
      rebootAttempts += 1
      await rebootstrapDevice()
    }
    try {
      while (true) {
        const device = await ensureLocalDevice()
        if (!device) {
          alert('Не удалось инициализировать устройство для секретного чата')
          return
        }
        try {
          const payload = {
            participantIds: [targetUserId],
            isGroup: false,
            isSecret: true,
            initiatorDeviceId: device.deviceId,
          }
          console.log('[SecretChat] Creating with payload:', payload)
          await api.post('/conversations', payload)
          client.invalidateQueries({ queryKey: ['conversations'] })
          return
        } catch (err: any) {
          console.error('[SecretChat] Creation error:', err?.response?.data || err)
          const message = err?.response?.data?.message
          const errors = err?.response?.data?.errors
          if (errors) {
            console.error('[SecretChat] Validation errors:', errors)
          }
          const isInvalidDevice =
            err?.response?.status === 400 &&
            typeof message === 'string' &&
            message.toLowerCase().includes('invalid initiator device')
          if (isInvalidDevice) {
            await tryRebootstrap()
            continue
          }
          const errorMsg = errors
            ? `Ошибка валидации: ${errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
            : message || 'Не удалось отправить запрос на секретный чат'
          throw new Error(errorMsg)
        }
      }
    } catch (err: any) {
      console.error('Failed to start secret conversation:', err)
      const errorMessage = err?.message || err?.response?.data?.message || 'Не удалось отправить запрос на секретный чат'
      alert(errorMessage)
    } finally {
      setSecretRequestLoading(false)
    }
  }

  const handleDeclinePendingSecret = async (conversationId: string) => {
    setSecretActionLoading(true)
    try {
      declineSecretChat(conversationId)
      setPendingSecretOffers((prev) => {
        const copy = { ...prev }
        delete copy[conversationId]
        return copy
      })
      client.invalidateQueries({ queryKey: ['conversations'] })
    } finally {
      setSecretActionLoading(false)
    }
  }

  const handleAcceptPendingSecret = async (conversationId: string) => {
    setSecretActionLoading(true)
    try {
      const device = await ensureLocalDevice()
      if (!device) {
        alert('Не удалось инициализировать устройство для секретного чата')
        return
      }
      acceptSecretChat(conversationId, device.deviceId)
      client.invalidateQueries({ queryKey: ['conversations'] })
      selectConversation(conversationId)
    } catch (err) {
      console.error('Failed to accept secret chat:', err)
      alert('Не удалось принять секретный чат')
    } finally {
      setSecretActionLoading(false)
    }
  }

  async function sendMessageToConversation(
    conversation: any | null | undefined,
    payload: { type: string; content?: string | null; metadata?: Record<string, any>; replyToId?: string; attachments?: Array<any> },
  ) {
    if (!conversation) return
    // Normalize null content to undefined
    const normalizedPayload = { ...payload, content: payload.content ?? undefined }
    if (conversation.isSecret) {
      const encrypted = await e2eeManager.encryptPayload(conversation, normalizedPayload)
      await api.post('/conversations/send', encrypted)
      return
    }
    await api.post('/conversations/send', { conversationId: conversation.id, ...normalizedPayload })
  }

  const closeAddParticipantsModal = () => {
    setAddParticipantsModal(false)
    setAddParticipantsSelectedIds([])
    setAddParticipantsLoading(false)
    setAddParticipantsMode('friends')
    setAddParticipantsEblDigits(['', '', '', ''])
    setAddParticipantsFoundUser(null)
    setAddParticipantsSearchError(null)
    setAddParticipantsSearching(false)
  }

  const handleAddParticipants = async () => {
    if (!activeId || addParticipantsSelectedIds.length === 0) {
      closeAddParticipantsModal()
      return
    }
    setAddParticipantsLoading(true)
    try {
      await api.post(`/conversations/${activeId}/participants`, { participantIds: addParticipantsSelectedIds })
      client.invalidateQueries({ queryKey: ['conversations'] })
      conversationsQuery.refetch()
      closeAddParticipantsModal()
    } catch (err: any) {
      console.error('Error adding participants:', err)
      alert(err.response?.data?.message || 'Не удалось добавить участников')
    } finally {
      setAddParticipantsLoading(false)
    }
  }

  const handleAddParticipantByEbl = async () => {
    if (!activeId || !addParticipantsFoundUser) return
    setAddParticipantsLoading(true)
    try {
      await api.post(`/conversations/${activeId}/participants`, { participantIds: [addParticipantsFoundUser.id] })
      client.invalidateQueries({ queryKey: ['conversations'] })
      conversationsQuery.refetch()
      closeAddParticipantsModal()
    } catch (err: any) {
      console.error('Error adding participant by EBLID:', err)
      alert(err.response?.data?.message || 'Не удалось добавить участника')
    } finally {
      setAddParticipantsLoading(false)
    }
  }

  const onChangeAddParticipantsDigit = (idx: number, val: string) => {
    if (!/^\d?$/.test(val)) return
    const next = [...addParticipantsEblDigits]
    next[idx] = val
    setAddParticipantsEblDigits(next)
    if (val && idx < 3) addParticipantsEblRefs[idx + 1].current?.focus()
    if (!val && idx > 0) addParticipantsEblRefs[idx - 1].current?.focus()
    const full = next.join('')
    if (full.length === 4 && /^\d{4}$/.test(full)) {
      const token = Date.now()
      addParticipantsSearchTokenRef.current = token
      setAddParticipantsSearching(true)
      setAddParticipantsSearchError(null)
      api
        .get('/contacts/search', { params: { query: full } })
        .then((resp) => {
          if (addParticipantsSearchTokenRef.current !== token) return
          const user = resp.data.results?.[0] ?? null
          setAddParticipantsFoundUser(user)
          setAddParticipantsSearchError(user ? null : 'Пользователь не найден')
        })
        .catch(() => {
          if (addParticipantsSearchTokenRef.current !== token) return
          setAddParticipantsFoundUser(null)
          setAddParticipantsSearchError('Не удалось выполнить поиск')
        })
        .finally(() => {
          if (addParticipantsSearchTokenRef.current === token) {
            setAddParticipantsSearching(false)
          }
        })
    } else {
      setAddParticipantsFoundUser(null)
      setAddParticipantsSearchError(null)
      setAddParticipantsSearching(false)
    }
  }

  function backToList() {
    if (isMobile) {
      // If current conversation is secret, drop its messages cache when leaving
      if (activeId) {
        try {
          const row = (conversationsQuery.data || []).find((r: any) => r.conversation.id === activeId)
          const conv = row?.conversation
          if (conv?.isSecret) {
            client.removeQueries({ queryKey: ['messages', activeId] })
          }
        } catch {
          // ignore cache cleanup errors
        }
      }
      setMobileView('list')
      setActiveId(null)
      setShowJump(false)
    }
    if (pendingImagesRef.current.length) {
      clearPendingImages()
    }
  }

  const meInfoQuery = useQuery({
    queryKey: ['me-info'],
    queryFn: async () => {
      const r = await api.get('/status/me')
      return r.data.user as any
    }
  })
  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      const response = await api.get('/conversations')
      return response.data.conversations
    },
  })

  const [olderMeta, setOlderMeta] = useState<{ hasMore: boolean; nextCursor: string | null }>({ hasMore: false, nextCursor: null })
  const [olderLoading, setOlderLoading] = useState<boolean>(false)
  const olderLoadingRef = useRef<boolean>(false)
  const olderMetaRef = useRef<{ hasMore: boolean; nextCursor: string | null }>({ hasMore: false, nextCursor: null })
  useEffect(() => { olderMetaRef.current = olderMeta }, [olderMeta])

  const messagesQuery = useQuery({
    queryKey: ['messages', activeId],
    enabled: !!activeId,
    queryFn: async () => {
      const conversationId = activeId
      const response = await api.get(`/conversations/${conversationId}/messages`, { params: { limit: MESSAGES_PAGE_SIZE } })
      const fetched = (response.data?.messages || []) as Array<any>
      const sortedFetched = [...fetched].sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
      const nextCursor = (response.data?.nextCursor ?? null) as string | null
      const hasMore = !!response.data?.hasMore
      // Keep older pages already loaded when refetching.
      const existing = client.getQueryData(['messages', conversationId]) as Array<any> | undefined
      const merged = (() => {
        const all = [...(Array.isArray(existing) ? existing : []), ...sortedFetched]
        const byId = new Map<string, any>()
        for (const m of all) {
          if (m && m.id) byId.set(m.id, m)
        }
        return [...byId.values()].sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
      })()
      // Initialize cursor/meta only on first load; do not overwrite after older pages are loaded,
      // otherwise periodic refetch would reset `nextCursor` back to the newest page.
      if (!Array.isArray(existing) || existing.length === 0) {
        setOlderMeta({ hasMore, nextCursor })
      }
      return merged
    },
    // Avoid hard overwriting older pages; we merge in queryFn.
    refetchInterval: activeId ? 15000 : false,
  })

  useEffect(() => {
    // Reset pagination state when switching chats
    setOlderMeta({ hasMore: false, nextCursor: null })
    olderLoadingRef.current = false
    setOlderLoading(false)
  }, [activeId])

  const loadOlderMessages = useCallback(async () => {
    const conversationId = activeId
    if (!conversationId) return
    if (olderLoadingRef.current) return
    const meta = olderMetaRef.current
    if (!meta.hasMore || !meta.nextCursor) return

    const el = messagesRef.current
    const before = el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight } : null
    olderLoadingRef.current = true
    setOlderLoading(true)
    try {
      const resp = await api.get(`/conversations/${conversationId}/messages`, {
        params: { cursor: meta.nextCursor, limit: MESSAGES_PAGE_SIZE },
      })
      const fetched = (resp.data?.messages || []) as Array<any>
      const sortedFetched = [...fetched].sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
      const nextCursor = (resp.data?.nextCursor ?? null) as string | null
      const hasMore = !!resp.data?.hasMore

      client.setQueryData(['messages', conversationId], (old: any) => {
        const existing = Array.isArray(old) ? old : []
        const byId = new Map<string, any>()
        for (const m of [...sortedFetched, ...existing]) {
          if (m && m.id) byId.set(m.id, m)
        }
        return [...byId.values()].sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
      })
      setOlderMeta({ hasMore, nextCursor })

      if (before && messagesRef.current) {
        requestAnimationFrame(() => {
          const el2 = messagesRef.current
          if (!el2) return
          const delta = el2.scrollHeight - before.scrollHeight
          if (delta > 0) {
            el2.scrollTop = before.scrollTop + delta
          }
        })
      }
    } catch (err) {
      console.warn('[ChatsPage] Failed to load older messages', err)
    } finally {
      olderLoadingRef.current = false
      setOlderLoading(false)
    }
  }, [activeId, client])

  // Lazy link preview fetch for older messages (or when socket updates are missed).
  // Server persists preview in message.metadata and may broadcast message:update.
  const requestedPreviewsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!activeId) return
    const row = (conversationsQuery.data || []).find((r: any) => r?.conversation?.id === activeId)
    const isSecret = !!row?.conversation?.isSecret
    if (isSecret) return
    const list = (messagesQuery.data || []) as any[]
    if (!list.length) return
    const candidates = list
      .filter((m) => m && m.type === 'TEXT' && typeof m.content === 'string' && m.content && !m.deletedAt)
      // Do not gate by attemptedAt here: we may have attempted before we added oEmbed support (e.g., YouTube).
      .filter((m) => !(m as any)?.metadata?.linkPreview)
      .filter((m) => {
        if (requestedPreviewsRef.current.has(m.id)) return false
        return !!extractFirstPreviewableUrl(m.content)
      })
      .slice(0, 2)

    if (candidates.length === 0) return

    candidates.forEach((m) => {
      requestedPreviewsRef.current.add(m.id)
      api.get(`/messages/${m.id}/preview`)
        .then((r) => {
          const updated = r.data?.message
          if (updated && updated.id) {
            updateMessageInCache(activeId, updated, { preserveScroll: true })
          } else {
            // fallback
            messagesQuery.refetch().catch(() => {})
          }
        })
        .catch(() => {
          try {
            // Make failures visible even when logs are silenced.
            console.warn('[linkPreview] preview request failed for message', m.id)
          } catch {}
          // allow retry later
          requestedPreviewsRef.current.delete(m.id)
        })
    })
  }, [activeId, conversationsQuery.data, messagesQuery.data])

  useEffect(() => {
    const error = messagesQuery.error as AxiosError | undefined
    if (error?.response?.status === 403 && activeId) {
      console.warn('[ChatsPage] Lost access to conversation, closing view', activeId)
      client.removeQueries({ queryKey: ['messages', activeId] })
      setActiveId(null)
    }
  }, [messagesQuery.error, activeId, client])

  const contactsQuery = useQuery({
    queryKey: ['accepted-contacts'],
    queryFn: async () => {
      const r = await api.get('/contacts', { params: { filter: 'accepted' } })
      return r.data.contacts as Array<any>
    },
  })

  const incomingContactsQuery = useQuery({
    queryKey: ['incoming-contacts'],
    queryFn: async () => {
      const r = await api.get('/contacts', { params: { filter: 'incoming' } })
      return r.data.contacts as Array<any>
    },
  })

  useEffect(() => {
    if (!activeId) return
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(LAST_ACTIVE_CONVERSATION_KEY, activeId)
    } catch {}
  }, [activeId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (activeId) return
    const rows = conversationsQuery.data
    if (!rows || rows.length === 0) return
    if (isMobileRef.current && mobileView !== 'conversation') return
    try {
      const stored = window.localStorage.getItem(LAST_ACTIVE_CONVERSATION_KEY)
      if (!stored) return
      const exists = rows.some((row: any) => row?.conversation?.id === stored)
      if (exists) {
        selectConversation(stored)
      }
    } catch {}
  }, [activeId, conversationsQuery.data, mobileView])

  const closeNewGroupModal = () => {
    setNewGroupOpen(false)
    setGroupTitle('')
    setSelectedIds([])
    setCreatingGroup(false)
    if (newGroupAvatarPreviewUrl) {
      try {
        URL.revokeObjectURL(newGroupAvatarPreviewUrl)
      } catch {
        // ignore
      }
    }
    setNewGroupAvatarPreviewUrl(null)
    if (newGroupAvatarSourceUrl) {
      try {
        URL.revokeObjectURL(newGroupAvatarSourceUrl)
      } catch {
        // ignore
      }
    }
    setNewGroupAvatarSourceUrl(null)
    setNewGroupAvatarFile(null)
    setNewGroupAvatarBlob(null)
    setNewGroupCrop({ x: 0, y: 0, scale: 1 })
    setNewGroupAvatarEditorOpen(false)
  }

  // Scroll shadows for conversations list
  useEffect(() => {
    const el = convScrollRef.current
    if (!el) return

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const hasTop = scrollTop > 2
      const hasBottom = scrollHeight - scrollTop - clientHeight > 2
      setConvHasTopFade(hasTop)
      setConvHasBottomFade(hasBottom)
    }

    update()
    el.addEventListener('scroll', update)
    window.addEventListener('resize', update)

    return () => {
      el.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [conversationsQuery.data?.length])

  useEffect(() => {
    try {
      const list = (conversationsQuery.data || []).map((r: any) => r.conversation.id)
      try {
        const qs = new URLSearchParams(window.location.search)
        const q = qs.get('lkDebugCallStatus')
        const debugCallStatus = (q === '1' || q === 'true') || (window.localStorage.getItem('lk-debug-callstatus') === '1' || window.localStorage.getItem('lk-debug-callstatus') === 'true')
        if (debugCallStatus) console.log('[CallStatus] Requesting statuses for:', list)
      } catch {
        // ignore
      }
      if (list.length > 0) requestCallStatuses(list)
      for (const cid of list) { try { joinConversation(cid) } catch {} }
    } catch {}
  }, [conversationsQuery.data])

  const activeConversation = useMemo(() => {
    return conversationsQuery.data?.find((r: any) => r.conversation.id === activeId)?.conversation
  }, [conversationsQuery.data, activeId])

  useEffect(() => {
    return () => {
      attachmentDecryptUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      attachmentDecryptUrlsRef.current.clear()
      attachmentDecryptInProgressRef.current.clear()
    }
  }, [])

  useEffect(() => {
      attachmentDecryptUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      attachmentDecryptUrlsRef.current.clear()
      attachmentDecryptInProgressRef.current.clear()
      setAttachmentDecryptMap({})
  }, [activeConversation?.id])

  const localDeviceId = useMemo(() => getStoredDeviceInfo()?.deviceId ?? null, [e2eeVersion])
  const myDevicesMap = useMemo(() => {
    const map: Record<string, { id: string; name?: string; platform?: string | null; userId: string }> = {}
    for (const device of devicesQuery.data || []) {
      map[device.id] = device
    }
    return map
  }, [devicesQuery.data])

  const resolveConversationDeviceId = useCallback(
    (conversation: any | null | undefined) => {
      if (!conversation?.isSecret) return null
      const ids = [conversation.secretInitiatorDeviceId, conversation.secretPeerDeviceId]
      for (const deviceId of ids) {
        if (!deviceId) continue
        const info = myDevicesMap[deviceId]
        if (info?.userId && me?.id && info.userId === me.id) {
          return deviceId
        }
      }
      if (me?.id) {
        if (conversation.createdById === me.id && conversation.secretInitiatorDeviceId) {
          return conversation.secretInitiatorDeviceId
        }
        if (conversation.createdById !== me.id && conversation.secretPeerDeviceId) {
          return conversation.secretPeerDeviceId
        }
      }
      return null
    },
    [myDevicesMap, me?.id],
  )

  const myConversationDeviceId = useMemo(() => resolveConversationDeviceId(activeConversation), [activeConversation, resolveConversationDeviceId])
  const connectedDeviceName = useMemo(() => {
    if (!myConversationDeviceId) return undefined
    const fromMap = myDevicesMap[myConversationDeviceId]?.name
    if (fromMap && fromMap.trim()) return fromMap
    const localInfo = getStoredDeviceInfo()
    if (localInfo && localInfo.deviceId === myConversationDeviceId && localInfo.name) {
      return localInfo.name
    }
    return undefined
  }, [myConversationDeviceId, myDevicesMap, e2eeVersion])

  const isSecretBlockedForDevice = useCallback(
    (conversationId: string) => {
      if (!conversationId) return false
      const conv = (conversationsQuery.data || []).find((row: any) => row?.conversation?.id === conversationId)?.conversation
      if (!conv?.isSecret) return false
      const convDeviceId = resolveConversationDeviceId(conv)
      return Boolean(convDeviceId && localDeviceId && convDeviceId !== localDeviceId)
    },
    [conversationsQuery.data, localDeviceId, resolveConversationDeviceId],
  )
  const conversationSecretInactive = !!(activeConversation?.isSecret && (activeConversation.secretStatus ?? 'ACTIVE') !== 'ACTIVE')
  const conversationSecretSessionReady = useMemo(() => {
    if (!activeConversation?.isSecret) return true
    return e2eeManager.hasSession(activeConversation.id)
  }, [activeConversation?.id, activeConversation?.isSecret, e2eeVersion])
  const secretBlockedByOtherDevice = Boolean(
    activeConversation?.isSecret &&
    !conversationSecretInactive &&
    !conversationSecretSessionReady &&
    myConversationDeviceId &&
    localDeviceId &&
    myConversationDeviceId !== localDeviceId,
  )
  const endSecretLabel = secretBlockedByOtherDevice ? 'Завершить везде' : 'Завершить'
  const endSecretTitle = secretBlockedByOtherDevice ? 'Завершить везде' : 'Завершить секретный чат'

  useEffect(() => {
    if (!activeConversation?.isSecret) return
    if (activeConversation.secretStatus !== 'ACTIVE') return
    let cancelled = false
    e2eeManager.ensureSession(activeConversation).then((session) => {
      if (!cancelled && session) {
        setE2eeVersion((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
      }
    }).catch((err) => {
      console.warn('Failed to ensure E2EE session', err)
    })
    return () => {
      cancelled = true
    }
  }, [activeConversation?.id, activeConversation?.secretStatus, activeConversation?.isSecret])

  useEffect(() => {
    if (!activeConversation?.isSecret) return
    if (!messagesQuery.data || messagesQuery.data.length === 0) return
    const updated = e2eeManager.processHandshakes(activeConversation, messagesQuery.data)
    if (updated) {
      setE2eeVersion((v) => (v + 1) % Number.MAX_SAFE_INTEGER)
    }
  }, [messagesQuery.data, activeConversation?.id, activeConversation?.isSecret, activeConversation?.secretStatus])

  const displayedMessages = useMemo(() => {
    if (!messagesQuery.data) return []
    if (!activeConversation?.isSecret) {
      return messagesQuery.data
    }
    return messagesQuery.data
      .filter((msg: any) => {
        const meta = (msg?.metadata ?? {}) as Record<string, any>
        const e2eeMeta = meta.e2ee
        return !(e2eeMeta && e2eeMeta.kind === 'handshake')
      })
      .map((msg: any) => e2eeManager.transformMessage(activeConversation.id, msg))
  }, [messagesQuery.data, activeConversation?.id, activeConversation?.isSecret, e2eeVersion])

  const decryptAttachment = useCallback(
    (att: any) => {
      if (!activeConversation?.id) return
      const meta = att?.metadata?.e2ee
      if (!meta || meta.kind !== 'ciphertext' || !meta.nonce) return
      
      // Проверяем, что сессия готова
      if (!e2eeManager.hasSession(activeConversation.id)) return
      
      // Проверяем, не запущен ли уже процесс расшифровки
      if (attachmentDecryptInProgressRef.current.has(att.url)) return
      
      // Проверяем текущее состояние
      const currentState = attachmentDecryptMap[att.url]
      if (currentState?.status === 'ready') return
      
      // Помечаем как запущенный и устанавливаем состояние
      attachmentDecryptInProgressRef.current.add(att.url)
      setAttachmentDecryptMap((prev) => ({
        ...prev,
        [att.url]: { status: 'pending' },
      }))
      
      ;(async () => {
        try {
          // Convert to proxy URL if needed
          const fetchUrl = convertToProxyUrl(att.url) || att.url
          const response = await fetch(fetchUrl, { credentials: 'omit' })
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
          }
          const cipher = new Uint8Array(await response.arrayBuffer())
          
          const plain = e2eeManager.decryptBinary(activeConversation.id, cipher, meta.nonce)
          if (!plain) {
            throw new Error('Failed to decrypt attachment: decryptBinary returned null')
          }
          
          const blob = new Blob([plain as BlobPart], {
            type:
              meta.originalType ||
              att.metadata?.mime ||
              att.metadata?.contentType ||
              'application/octet-stream',
          })
          const objectUrl = URL.createObjectURL(blob)
          attachmentDecryptUrlsRef.current.add(objectUrl)
          attachmentDecryptInProgressRef.current.delete(att.url)
          setAttachmentDecryptMap((prev) => ({
            ...prev,
            [att.url]: { status: 'ready', url: objectUrl },
          }))
        } catch (error: any) {
          attachmentDecryptInProgressRef.current.delete(att.url)
          setAttachmentDecryptMap((prev) => {
            const next = { ...prev }
            if (error?.message?.includes('E2EE session is not ready')) {
              // Если сессия не готова, удаляем из map, чтобы попробовать позже
              delete next[att.url]
            } else {
              next[att.url] = { status: 'error' }
            }
            return next
          })
        }
      })()
    },
    [activeConversation?.id, attachmentDecryptMap],
  )

  const resolveAttachmentUrl = useCallback(
    (att: any) => {
      if (!att) return null
      
      // Convert S3 URL to proxy URL if needed (for old URLs in database)
      const baseUrl = convertToProxyUrl(att.url)
      
      if (!activeConversation?.isSecret) return baseUrl
      
      const meta = att.metadata?.e2ee
      if (!meta || meta.kind !== 'ciphertext') {
        return baseUrl
      }
      
      // For encrypted attachments, use the original URL as key for decryption map
      const entry = attachmentDecryptMap[att.url]
      if (entry?.status === 'ready' && entry.url) {
        return entry.url
      }
      return null
    },
    [attachmentDecryptMap, activeConversation?.isSecret],
  )

  useEffect(() => {
    if (!activeConversation?.isSecret) return
    if (!conversationSecretSessionReady) return
    const attachments = (displayedMessages || []).flatMap(
      (msg: any) => msg.attachments || [],
    )
    attachments.forEach((att) => {
      if (att?.metadata?.e2ee?.kind === 'ciphertext') {
        decryptAttachment(att)
      }
    })
  }, [
    displayedMessages,
    activeConversation?.id,
    activeConversation?.isSecret,
    conversationSecretSessionReady,
    decryptAttachment,
  ])

  // Retro: if message attachment metadata lacks originalName/mime/size, enrich FILE cards via proxy HEAD headers.
  useEffect(() => {
    const atts = (displayedMessages || []).flatMap((m: any) => m.attachments || [])
    const fileAtts = atts.filter((a: any) => a?.type === 'FILE' && typeof a?.url === 'string' && a.url)
    if (!fileAtts.length) return

    let cancelled = false
    for (const att of fileAtts) {
      const meta = att?.metadata ?? {}
      const existing = attachmentHeadInfoMap[att.url]
      const hasName = typeof meta?.originalName === 'string' && meta.originalName.trim()
      const hasMime = typeof meta?.mime === 'string' && meta.mime.trim()
      const hasSize = typeof att?.size === 'number' && att.size > 0
      if (hasName && (hasMime || hasSize)) continue
      if (existing?.fileName && existing?.mime) continue
      if (attachmentHeadInfoInFlightRef.current.has(att.url)) continue

      attachmentHeadInfoInFlightRef.current.add(att.url)
      const href = convertToProxyUrl(att.url) || att.url
      fetch(href, { method: 'HEAD', credentials: 'omit' })
        .then((r) => {
          if (!r.ok) throw new Error(`HEAD ${r.status}`)
          const cd = r.headers.get('content-disposition')
          const ct = r.headers.get('content-type')
          const cl = r.headers.get('content-length')
          const fileName = parseContentDispositionFilename(cd)
          const size = cl ? Number(cl) : undefined
          if (cancelled) return
          setAttachmentHeadInfoMap((prev) => ({
            ...prev,
            [att.url]: {
              ...(prev[att.url] || {}),
              ...(fileName ? { fileName } : {}),
              ...(ct ? { mime: ct } : {}),
              ...(Number.isFinite(size) && (size as number) > 0 ? { size: size as number } : {}),
            },
          }))
        })
        .catch(() => {
          // ignore
        })
        .finally(() => {
          attachmentHeadInfoInFlightRef.current.delete(att.url)
        })
    }

    return () => {
      cancelled = true
    }
  }, [displayedMessages, attachmentHeadInfoMap])

  useEffect(() => {
    const pendingIds = new Set(
      (conversationsQuery.data || [])
        .map((r: any) => r.conversation)
        .filter((conv: any) => conv?.isSecret && (conv.secretStatus ?? 'ACTIVE') === 'PENDING')
        .map((conv: any) => conv.id)
    )
    setPendingSecretOffers((prev) => {
      let changed = false
      const copy = { ...prev }
      for (const id of Object.keys(copy)) {
        if (!pendingIds.has(id)) {
          delete copy[id]
          changed = true
        }
      }
      return changed ? copy : prev
    })
  }, [conversationsQuery.data])

  const pendingSecretContext = useMemo(() => {
    if (!activeConversation || activeConversation.isGroup || activeConversation.isSecret) return null
    if (!me?.id) return null
    const activeKey = makeParticipantsKey(activeConversation.participants || [])
    if (!activeKey) return null
    const rows = conversationsQuery.data || []
    for (const row of rows) {
      const conv = row.conversation
      if (!conv?.isSecret) continue
      if ((conv.secretStatus ?? 'ACTIVE') !== 'PENDING') continue
      const convKey = makeParticipantsKey(conv.participants || [])
      if (convKey !== activeKey) continue
      const initiatorUser = (conv.participants || []).find((p: any) => p.user.id === conv.createdById)?.user
      const initiatorName = pendingSecretOffers[conv.id]?.from?.name ?? initiatorUser?.displayName ?? initiatorUser?.username ?? 'Собеседник'
      return {
        conversationId: conv.id,
        isInitiator: conv.createdById === me.id,
        initiatorName,
      }
    }
    return null
  }, [activeConversation, conversationsQuery.data, me?.id, pendingSecretOffers])

  const usersById = useMemo(() => {
    const map: Record<string, any> = {}
    if (activeConversation) {
      for (const p of activeConversation.participants) {
        map[p.user.id] = p.user
      }
    }
    // don't overwrite participant data (which contains up-to-date avatarUrl) with stale session
    if (me && !map[me.id]) map[me.id] = me
    return map
  }, [activeConversation, me])

  const activeConversationParticipantIds = useMemo(() => {
    if (!activeConversation) return []
    return (activeConversation.participants || []).map((p: any) => p.user.id)
  }, [activeConversation])

  const eligibleContactsForAdd = useMemo(() => {
    if (!activeConversation || !contactsQuery.data) return []
    const participantIds = new Set(activeConversationParticipantIds)
    return contactsQuery.data.filter((c: any) => !participantIds.has(c.friend.id))
  }, [activeConversation, contactsQuery.data, activeConversationParticipantIds])

  const addParticipantsFoundUserStatus = {
    alreadyInChat: addParticipantsFoundUser ? activeConversationParticipantIds.includes(addParticipantsFoundUser.id) : false,
    isSelf: addParticipantsFoundUser ? addParticipantsFoundUser.id === me?.id : false,
  }

  useEffect(() => {
    if (!addParticipantsModal) return
    if (addParticipantsMode === 'eblid') {
      addParticipantsEblRefs[0].current?.focus()
    }
  }, [addParticipantsModal, addParticipantsMode])

  // Realtime "playing game" presence (Electron) with local TTL fallback (60s)
  useEffect(() => {
    const timers = presenceGameExpiryTimersRef.current
    const clearTimer = (uid: string) => {
      const t = timers.get(uid)
      if (t) window.clearTimeout(t)
      timers.delete(uid)
    }
    const scheduleExpiry = (uid: string, ts: number) => {
      clearTimer(uid)
      const age = Date.now() - ts
      const remaining = Math.max(0, 60_000 - age)
      const t = window.setTimeout(() => {
        setPresenceGameByUserId((prev) => {
          if (!prev[uid]) return prev
          const next = { ...prev }
          delete next[uid]
          return next
        })
        timers.delete(uid)
      }, remaining + 50)
      timers.set(uid, t)
    }

    const handler = (p: PresenceGamePayload) => {
      const uid = typeof p?.userId === 'string' ? p.userId : ''
      if (!uid) return
      if (p.game && typeof p.ts === 'number') {
        scheduleExpiry(uid, p.ts)
        setPresenceGameByUserId((prev) => ({ ...prev, [uid]: { ts: p.ts, game: p.game as any } }))
      } else {
        clearTimer(uid)
        setPresenceGameByUserId((prev) => {
          if (!prev[uid]) return prev
          const next = { ...prev }
          delete next[uid]
          return next
        })
      }
    }

    const handleBatch = (payload: PresenceGameSnapshotBatchPayload) => {
      const items = Array.isArray(payload?.items) ? payload.items : []
      for (const it of items) handler(it as any)
    }

    onPresenceGame(handler)
    onPresenceGameSnapshot(handler)
    onPresenceGameSnapshotBatch(handleBatch)
    return () => {
      socket.off('presence:game', handler as any)
      socket.off('presence:game:snapshot', handler as any)
      socket.off('presence:game:snapshot:batch', handleBatch as any)
      for (const t of timers.values()) window.clearTimeout(t)
      timers.clear()
    }
  }, [])

  // Request game presence snapshots for "relevant" peers (last dialogs) once conversations list is available.
  const helloPeersRef = useRef<string[]>([])
  useEffect(() => {
    const rows = (conversationsQuery.data || []) as any[]
    const peers: string[] = []
    const seen = new Set<string>()
    try {
      for (const row of rows) {
        const conv = row?.conversation
        if (!conv) continue
        const isGroup = !!(conv.isGroup || (conv.participants?.length ?? 0) > 2)
        if (isGroup) continue
        const parts = conv.participants || []
        const peer = parts.find((p: any) => p?.user?.id && p.user.id !== me?.id)?.user
        const peerId = typeof peer?.id === 'string' ? peer.id : null
        if (!peerId) continue
        if (seen.has(peerId)) continue
        seen.add(peerId)
        peers.push(peerId)
        if (peers.length >= 50) break
      }
    } catch {}
    helloPeersRef.current = peers
    if (!peers.length) return
    if (!socket.connected) return
    try { helloPresenceGame(peers) } catch {}
  }, [conversationsQuery.data, me?.id])

  // Re-send hello snapshot batch after reconnect.
  useEffect(() => {
    const onConnect = () => {
      const peers = helloPeersRef.current || []
      if (!peers.length) return
      try { helloPresenceGame(peers) } catch {}
    }
    socket.on('connect', onConnect)
    return () => { socket.off('connect', onConnect as any) }
  }, [])

  // When opening a 1:1 chat, request an immediate snapshot for that peer.
  useEffect(() => {
    if (!activeConversation) return
    const isGroup = !!(activeConversation.isGroup || (activeConversation.participants?.length ?? 0) > 2)
    if (isGroup) return
    const parts = activeConversation.participants || []
    const peer = parts.find((p: any) => p?.user?.id && p.user.id !== me?.id)?.user
    const peerId = typeof peer?.id === 'string' ? peer.id : null
    if (!peerId) return
    try { subscribePresenceGame(peerId) } catch {}
  }, [activeConversation?.id, me?.id])

  // Realtime presence updates into conversations list
  useEffect(() => {
    const handler = (p: { userId: string; status: string }) => {
      // Keep an in-memory override map so polling doesn't revert "IN_CALL" back to "ONLINE".
      setPresenceOverridesByUserId((prev) => {
        const nextStatus = (p.status || '').toString().toUpperCase()
        const prevStatus = prev[p.userId]
        if (prevStatus === nextStatus) return prev
        return { ...prev, [p.userId]: nextStatus }
      })
      // Update status in conversations cache
      client.setQueryData(['conversations'], (old: any) => {
        if (!old) return old
        return old.map((row: any) => {
          const updated = {
            ...row,
            conversation: {
              ...row.conversation,
              participants: row.conversation.participants.map((cp: any) =>
                cp.user.id === p.userId
                  ? {
                      ...cp,
                      user: {
                        ...cp.user,
                        status: p.status,
                        lastSeenAt:
                          p.status === 'ONLINE' || p.status === 'BACKGROUND' || p.status === 'IN_CALL' || p.status === 'OFFLINE'
                            ? new Date().toISOString()
                            : cp.user.lastSeenAt,
                      },
                    }
                  : cp
              ),
            },
          }
          return updated
        })
      })
    }
    onPresenceUpdate(handler)
    return () => { socket.off('presence:update', handler as any) }
  }, [client])

  const effectiveUserStatus = useCallback((u: any): 'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL' => {
    const rawId = u?.id
    const id = typeof rawId === 'string' ? rawId : null
    const override = id ? presenceOverridesByUserId[id] : undefined
    const raw = (override ?? u?.status ?? 'OFFLINE').toString().toUpperCase()
    if (raw === 'IN_CALL') return 'IN_CALL'
    if (raw === 'ONLINE') return 'ONLINE'
    if (raw === 'BACKGROUND') return 'BACKGROUND'
    if (raw === 'AWAY') return 'AWAY'
    return 'OFFLINE'
  }, [presenceOverridesByUserId])

  // Track if socket was previously connected to detect actual reconnects
  const wasConnectedRef = useRef(socket.connected)
  // Reflect socket connection status in UI (especially for mobile self-status)
  useEffect(() => {
    // iOS Safari: refresh viewport height and trigger re-render on focus to avoid stale layout/state
    const onFocus = () => {
      try {
        const h = (window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.01
        document.documentElement.style.setProperty('--vh', h + 'px')
      } catch {}
      client.invalidateQueries({ queryKey: ['me-info'] })
      setIsSocketOnline(socket.connected)
    }
    window.addEventListener('focus', onFocus)
    const onConnect = () => {
      setIsSocketOnline(true)
      const wasConnected = wasConnectedRef.current
      wasConnectedRef.current = true
      // Only re-join rooms if this is an actual reconnect (was previously connected, then disconnected, now reconnected)
      // Skip if this is the initial connection (wasConnected is false and socket was never connected before)
      if (wasConnected) {
        try {
          const list = (conversationsQuery.data || []).map((r: any) => r.conversation.id)
          // re-join all conversation rooms after reconnect so we receive call:status broadcasts
          for (const cid of list) { try { joinConversation(cid) } catch {} }
          if (list.length > 0) requestCallStatuses(list)
        } catch {}
      }
    }
    const onDisconnect = () => {
      setIsSocketOnline(false)
      wasConnectedRef.current = false
    }
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    // initialize once in case it changed before
    setIsSocketOnline(socket.connected)
    if (socket.connected) {
      wasConnectedRef.current = true
    }
    const onVis = () => { client.invalidateQueries({ queryKey: ['me-info'] }) }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      socket.off('connect', onConnect as any)
      socket.off('disconnect', onDisconnect as any)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
    }
  }, [client])

  // Keep own presence in sync with server events, like for other users
  useEffect(() => {
    const handler = (payload: { userId: string; status: string }) => {
      if (!me?.id) return
      if (payload.userId === me.id) {
        const v = (payload.status || '').toUpperCase()
        if (v === 'ONLINE' || v === 'AWAY' || v === 'BACKGROUND' || v === 'IN_CALL' || v === 'OFFLINE') setMyPresence(v)
      }
    }
    onPresenceUpdate(handler)
    return () => { socket.off('presence:update', handler as any) }
  }, [me?.id])

  // Initialize own presence from meInfo endpoint when available
  useEffect(() => {
    const v = ((meInfoQuery.data as any)?.status || '').toString().toUpperCase()
    if (v === 'ONLINE' || v === 'AWAY' || v === 'BACKGROUND' || v === 'IN_CALL' || v === 'OFFLINE') setMyPresence(v)
  }, [meInfoQuery.data])

  // Lightbox keyboard controls are handled inside <ImageLightbox /> now.

  // Live profile updates (avatar/name) across app
  useEffect(() => {
    const handler = (p: { userId: string; avatarUrl?: string | null; displayName?: string | null }) => {
      client.setQueryData(['conversations'], (old: any) => {
        if (!old) return old
        return old.map((row: any) => ({
          ...row,
          conversation: {
            ...row.conversation,
            participants: row.conversation.participants.map((cp: any) => cp.user.id === p.userId ? { ...cp, user: { ...cp.user, avatarUrl: p.avatarUrl ?? cp.user.avatarUrl, displayName: p.displayName ?? cp.user.displayName } } : cp)
          }
        }))
      })
      if (p.userId === me?.id) meInfoQuery.refetch()
    }
    onProfileUpdate(handler)
    return () => { socket.off('profile:update', handler as any) }
  }, [client, me?.id])

  function hashToGray(userId: string | null | undefined) {
    // Все сообщения собеседника используют один цвет
    return '#191d23'
  }

  

  // Глобальный обработчик paste для вставки изображений из буфера обмена (когда фокус не в поле ввода)
  useEffect(() => {
    if (!activeId) return
    
    const handlePaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return
      }
      const items = e.clipboardData?.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.indexOf('image') !== -1) {
          e.preventDefault()
          e.stopPropagation()
          const file = item.getAsFile()
          if (file) {
            addComposerImage(file, 'paste')
          }
          break
        }
      }
    }
    
    window.addEventListener('paste', handlePaste, true)
    return () => {
      window.removeEventListener('paste', handlePaste, true)
    }
  }, [activeId, addComposerImage])

  useEffect(() => {
    conversationsQuery.refetch()
    connectSocket()
    onConversationNew(() => conversationsQuery.refetch())
    onConversationDeleted((payload) => {
      const convId = payload?.conversationId
      if (!convId) {
        conversationsQuery.refetch()
        return
      }
      setPendingSecretOffers((prev) => {
        if (!prev[convId]) return prev
        const copy = { ...prev }
        delete copy[convId]
        return copy
      })
      setPendingByConv((prev) => {
        if (!prev[convId]) return prev
        const copy = { ...prev }
        delete copy[convId]
        return copy
      })
      e2eeManager.clearSession(convId)
      client.removeQueries({ queryKey: ['messages', convId] })
      client.setQueryData(['conversations'], (prev: any) => {
        if (!Array.isArray(prev)) return prev
        return prev.filter((row: any) => row?.conversation?.id !== convId)
      })
      const isDeletingActive = activeConversationIdRef.current === convId
      if (isDeletingActive) {
        setActiveId((prev) => (prev === convId ? null : prev))
        setShowJump(false)
        if (pendingImagesRef.current.length) {
          clearPendingImages()
        }
        if (isMobileRef.current) {
          setMobileView('list')
        }
      }
      conversationsQuery.refetch()
    })
    onConversationUpdated(() => { conversationsQuery.refetch() })
    onConversationMemberRemoved(() => { conversationsQuery.refetch() })
    const offSecretOffer = onSecretChatOffer((payload) => {
      setPendingSecretOffers((prev) => ({ ...prev, [payload.conversationId]: payload }))
      conversationsQuery.refetch()
    })
    const offSecretAccepted = onSecretChatAccepted((payload) => {
      setPendingSecretOffers((prev) => {
        const copy = { ...prev }
        delete copy[payload.conversationId]
        return copy
      })
      client.invalidateQueries({ queryKey: ['conversations'] })
      selectConversation(payload.conversationId)
    })
    onIncomingCall(({ conversationId, from, video }) => {
      // debounce duplicate incoming for same conv
      if (ringingConvIdRef.current && ringingConvIdRef.current === conversationId) return
      // stop previous ring if any
      stopRingtone()
      // suppress popup for group calls or if already in this call
      try {
        const list = client.getQueryData(['conversations']) as any[] | undefined
        const conv = Array.isArray(list) ? list.find((r: any) => r.conversation.id === conversationId)?.conversation : null
        const isGroup = !!(conv && ((conv.isGroup) || ((conv.participants?.length ?? 0) > 2)))
        inviterByConvRef.current[conversationId] = from.id
        const isAlreadyInThisCall = callConvIdRef.current === conversationId
        if (isGroup) {
          // group calls: no popup here; status is driven by room join/leave events
          return
        }
        if (isAlreadyInThisCall) return
        if (from?.id && me?.id && from.id === me.id) {
          // This is our own outgoing call, do not treat as incoming
          return
        }
      } catch {}
      ringingConvIdRef.current = conversationId
      callStore.startIncoming({ conversationId, from, video })
      // start ringtone from file
      try {
        const audio = ensureRingAudio()
        if (audio) {
          audio.currentTime = 0
          audio.loop = true
          audio.volume = 0.9
          void audio.play().catch(() => {})
        }
      } catch (err) {
        console.error('Error starting ringtone:', err)
      }
      // auto-decline after 25s
      ringTimerRef.current = window.setTimeout(() => {
        declineCall(conversationId)
        stopRingtone()
        callStore.setIncoming(null)
      }, 25000)
    })
    onCallAccepted(({ conversationId, by, video }) => {
      clearMinCallDurationGuard(conversationId)

      // Останавливаем "дозвон" на этом устройстве сразу, как только другой участник принял звонок.
      // (Даже если мы не будем подключаться на этом устройстве — дозвон UI/звук не должен продолжаться.)
      setOutgoingCall((prev) => {
        if (prev?.conversationId === conversationId) {
          if (outgoingCallTimerRef.current) {
            window.clearTimeout(outgoingCallTimerRef.current)
            outgoingCallTimerRef.current = null
          }
          stopDialingSound()
          return null
        }
        return prev
      })
      
      // Если звонок принят на другом устройстве (by.id === me.id), прекращаем все действия на этом устройстве
      // и не открываем оверлей - звонок должен быть активен только на том устройстве, где его приняли
      if (by?.id === me?.id) {
        // Прекращаем входящий звонок для этой беседы, если он есть
        const hasIncomingForThisConv = callStore.incoming?.conversationId === conversationId || ringingConvIdRef.current === conversationId
        if (hasIncomingForThisConv) {
          stopRingtone()
          callStore.setIncoming(null)
          if (ringTimerRef.current) {
            window.clearTimeout(ringTimerRef.current)
            ringTimerRef.current = null
          }
          ringingConvIdRef.current = null
        }
        // Закрываем экран дозвона, если он открыт (если пользователь звонил с этого устройства)
        // (уже остановили выше)
        // Не открываем оверлей на этом устройстве - звонок принят на другом
        return
      }

      // Если звонок принят ДРУГИМ пользователем (т.е. это ответ на наш исходящий),
      // то на этом устройстве подключаемся только если МЫ здесь реально инициировали звонок (activeConvId)
      // или уже находимся в этом оверлее. Это предотвращает ситуацию "звонок принялся на другом устройстве"
      // когда один аккаунт открыт на нескольких устройствах.
      const isAlreadyInOverlayHere = callConvIdRef.current === conversationId
      const isOutgoingIntentHere = useCallStore.getState().activeConvId === conversationId
      const hadOutgoingHere = outgoingCallRef.current?.conversationId === conversationId
      if (!isAlreadyInOverlayHere && !isOutgoingIntentHere && !hadOutgoingHere) {
        // У нас на этом устройстве нет намерения участвовать — просто гасим возможный рингтон/инкоминг UI.
        const hasIncomingForThisConv = useCallStore.getState().incoming?.conversationId === conversationId || ringingConvIdRef.current === conversationId
        if (hasIncomingForThisConv) {
          stopRingtone()
          callStore.setIncoming(null)
          if (ringTimerRef.current) {
            window.clearTimeout(ringTimerRef.current)
            ringTimerRef.current = null
          }
          ringingConvIdRef.current = null
        }
        return
      }
      // (дозвон уже остановили выше)
      
      // Для всех типов звонков (1:1 и группы) устанавливаем activeCalls вручную
      // Это обеспечивает единообразное поведение: звонок становится активным сразу
      setActiveCalls((prev) => {
        const current = prev[conversationId]
        if (!current?.active) {
          return { ...prev, [conversationId]: { startedAt: Date.now(), active: true, endedAt: null, participants: [me?.id || ''].filter(Boolean) } }
        }
        return prev
      })
      // Устанавливаем callStore.activeConvId для показа кнопок управления звонком
      // Это нужно для того, чтобы isParticipating был true и показывались кнопки "Развернуть" и "Сбросить"
      if (callStore.activeConvId !== conversationId) {
        // Определяем, есть ли информация о видео в активных звонках или используем false по умолчанию
        // Для 1:1 звонков можно использовать информацию из callStore, если она есть
        const hasVideo = !!video
        callStore.startOutgoing(conversationId, hasVideo)
      }
      // Открываем оверлей только на устройстве, где звонок был принят
      setCallConvId(conversationId)
      setMinimizedCallConvId((prev) => prev === conversationId ? null : prev) // Сбрасываем минимизацию для нового звонка
      stopRingtone()
    })
    onCallDeclined(({ conversationId }) => {
      // Закрываем экран дозвона, если он открыт
      setOutgoingCall((prev) => {
        if (prev?.conversationId === conversationId) {
          if (outgoingCallTimerRef.current) {
            window.clearTimeout(outgoingCallTimerRef.current)
            outgoingCallTimerRef.current = null
          }
          stopDialingSound()
          playEndCallSound()
          return null
        }
        return prev
      })
      const finalize = () => {
        setActiveCalls((prev) => {
          const current = prev[conversationId]
          if (current) {
            if (current.active) {
              return { ...prev, [conversationId]: { ...current, active: false, endedAt: Date.now() } }
            }
            const { [conversationId]: _omit, ...rest } = prev
            return rest
          }
          return prev
        })
        if (callConvIdRef.current === conversationId) {
          setCallConvId((prev) => (prev === conversationId ? null : prev))
          setMinimizedCallConvId((prev) => (prev === conversationId ? null : prev))
          callStore.endCall()
        }
        callStore.setIncoming(null)
        stopRingtone()
        clearMinCallDurationGuard(conversationId)
      }
      if (isOneToOneConversation(conversationId)) {
        scheduleAfterMinCallDuration(conversationId, finalize, { force: true })
      } else {
        finalize()
      }
    })
    onCallEnded(({ conversationId, by }) => {
      const endedByOther = !!by?.id && by.id !== me?.id
      // Игнорируем для групповых звонков — статус придет отдельным событием call:status
      try {
        const list = client.getQueryData(['conversations']) as any[] | undefined
        const conv = Array.isArray(list) ? list.find((r: any) => r.conversation.id === conversationId)?.conversation : null
        const isGroup = !!(conv && ((conv.isGroup) || ((conv.participants?.length ?? 0) > 2)))
        if (isGroup) return
      } catch {}
      // Если звонок минимизирован, не завершаем его - он все еще активен, просто оверлей скрыт
      if (minimizedCallConvId === conversationId) {
        return
      }
      // Для 1:1 звонков проверяем, что звонок действительно неактивен перед закрытием
      // Если callConvId установлен, это означает, что пользователь участвует в звонке
      // В этом случае не закрываем, так как это может быть временное отключение
      if (isOneToOneConversation(conversationId)) {
        const currentCall = activeCalls[conversationId]
        const isParticipating = callConvIdRef.current === conversationId || callStore.activeConvId === conversationId
        // Если пользователь участвует в звонке, не закрываем при получении call:ended
        // Это может быть временное отключение, звонок должен закрыться только когда
        // оба участника явно отключились или один нажал "Leave"
        if (isParticipating && currentCall?.active && !endedByOther) {
          console.log('[ChatsPage] Ignoring call:ended for active 1:1 call where user is participating', conversationId)
          return
        }
      }
      const finalize = () => {
        if (endedByOther) {
          try {
            const audio = ensureNotifyAudio()
            if (audio && notifyUnlockedRef.current) {
              audio.currentTime = 0
              audio.volume = 0.9
              void audio.play().catch(() => {})
            }
          } catch {}
        }
        // Закрываем экран дозвона, если он открыт
        setOutgoingCall((prev) => {
          if (prev?.conversationId === conversationId) {
            if (outgoingCallTimerRef.current) {
              window.clearTimeout(outgoingCallTimerRef.current)
              outgoingCallTimerRef.current = null
            }
            stopDialingSound()
            return null
          }
          return prev
        })
        setActiveCalls((prev) => {
          const current = prev[conversationId]
          if (current?.active) {
            return { ...prev, [conversationId]: { ...current, active: false, endedAt: Date.now() } }
          }
          const { [conversationId]: _omit, ...rest } = prev
          return rest
        })
        if (callConvIdRef.current === conversationId) {
          setCallConvId((prev) => (prev === conversationId ? null : prev))
          setMinimizedCallConvId((prev) => (prev === conversationId ? null : prev))
          callStore.endCall()
        }
        callStore.setIncoming(null)
        stopRingtone()
        clearMinCallDurationGuard(conversationId)
      }
      if (isOneToOneConversation(conversationId)) {
        scheduleAfterMinCallDuration(conversationId, finalize, { force: true })
      } else {
        finalize()
      }
    })
    onReceiptsUpdate(({ conversationId }) => {
      client.invalidateQueries({ queryKey: ['messages', conversationId] })
      client.refetchQueries({ queryKey: ['messages', conversationId] })
    })
    // prepare notification audio and unlock on first user gesture (autoplay policy)
    let detachUnlockListeners: (() => void) | null = null
    try {
      ensureNotifyAudio()
      const isMobileInitial = window.innerWidth <= 768
      if (isMobileInitial) {
        const hasSession = !!useAppStore.getState().session?.user
        const alreadyUnlocked = !!(window as any).__ebAudioUnlockedOnce
        if (hasSession && !alreadyUnlocked && (!notifyUnlockedRef.current || !ringUnlockedRef.current)) {
          setShowAudioUnlock(true)
        }
      }
      const unlock = async () => {
        const ready = await performAudioUnlock()
        if (ready && detachUnlockListeners) {
          detachUnlockListeners()
          detachUnlockListeners = null
        }
      }
      window.addEventListener('click', unlock)
      window.addEventListener('keydown', unlock)
      window.addEventListener('touchstart', unlock)
      detachUnlockListeners = () => {
        window.removeEventListener('click', unlock)
        window.removeEventListener('keydown', unlock)
        window.removeEventListener('touchstart', unlock)
      }
    } catch {}
    return () => {
      detachUnlockListeners?.()
      offSecretOffer?.()
      offSecretAccepted?.()
    }
  }, [])
  // live update contacts tiles
  useEffect(() => {
    onContactRequest(() => { incomingContactsQuery.refetch() })
    onContactAccepted(() => { contactsQuery.refetch(); conversationsQuery.refetch(); incomingContactsQuery.refetch() })
    onContactRemoved(() => { contactsQuery.refetch(); incomingContactsQuery.refetch() })
  }, [])

  // Touch event handlers for personal avatar editor
  useEffect(() => {
    if (!avatarPreviewUrl) return
    const editor = editorRef.current
    if (!editor) return

    const getDistance = (touch1: Touch, touch2: Touch) => {
      const dx = touch2.clientX - touch1.clientX
      const dy = touch2.clientY - touch1.clientY
      return Math.sqrt(dx * dx + dy * dy)
    }

    const getCenter = (touch1: Touch, touch2: Touch) => ({
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2
    })

    const cropSize = 240
    const isPointInCircle = (x: number, y: number, centerX: number, centerY: number, radius: number) => {
      const dx = x - centerX
      const dy = y - centerY
      return dx * dx + dy * dy <= radius * radius
    }

    const handleTouchStart = (e: TouchEvent) => {
      const rect = editor.getBoundingClientRect()
      if (!rect) return
      const editorWidth = rect.width
      const editorHeight = rect.height
      const centerX = editorWidth / 2
      const centerY = editorHeight / 2
      const radius = cropSize / 2

      if (e.touches.length === 1) {
        const touch = e.touches[0]
        const touchX = touch.clientX - rect.left
        const touchY = touch.clientY - rect.top
        
        if (!isPointInCircle(touchX, touchY, centerX, centerY, radius)) {
          return
        }
        
        touchStateRef.current = {
          touches: [touch],
          initialDistance: 0,
          initialScale: crop.scale,
          initialX: crop.x,
          initialY: crop.y
        }
        e.preventDefault()
      } else if (e.touches.length === 2) {
        const touch1 = e.touches[0]
        const touch2 = e.touches[1]
        const center = getCenter(touch1, touch2)
        const centerTouchX = center.x - rect.left
        const centerTouchY = center.y - rect.top
        
        if (!isPointInCircle(centerTouchX, centerTouchY, centerX, centerY, radius)) {
          return
        }
        
        const distance = getDistance(touch1, touch2)
        touchStateRef.current = {
          touches: [touch1, touch2],
          initialDistance: distance,
          initialScale: crop.scale,
          initialX: crop.x,
          initialY: crop.y
        }
        e.preventDefault()
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (!touchStateRef.current) return
      e.preventDefault()

      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }

      rafRef.current = requestAnimationFrame(() => {
        if (!touchStateRef.current) return

        const rect = editor.getBoundingClientRect()
        if (!rect) return
        const editorWidth = rect.width
        const editorHeight = rect.height
        const centerX = editorWidth / 2
        const centerY = editorHeight / 2

        const touchesCount = e.touches.length
        const initialTouchesCount = touchStateRef.current.touches.length

        if (touchesCount === 1 && initialTouchesCount === 1) {
          const touch = e.touches[0]
          const initialTouch = touchStateRef.current.touches[0]
          
          const deltaX = touch.clientX - initialTouch.clientX
          const deltaY = touch.clientY - initialTouch.clientY
          
          setCrop((prev) => {
            let newX = touchStateRef.current!.initialX + deltaX
            let newY = touchStateRef.current!.initialY + deltaY
            
            const img = imageRef.current
            if (img) {
              const currentScale = prev.scale
              const imgScaledWidth = img.naturalWidth * currentScale
              const imgScaledHeight = img.naturalHeight * currentScale
              const maxX = centerX + cropSize / 2
              const minX = centerX - cropSize / 2 - imgScaledWidth
              const maxY = centerY + cropSize / 2
              const minY = centerY - cropSize / 2 - imgScaledHeight
              
              newX = Math.max(minX, Math.min(maxX, newX))
              newY = Math.max(minY, Math.min(maxY, newY))
            }
            
            return { ...prev, x: newX, y: newY }
          })
        } else if (touchesCount === 2 && initialTouchesCount === 2) {
          const touch1 = e.touches[0]
          const touch2 = e.touches[1]
          const distance = getDistance(touch1, touch2)
          const scaleChange = distance / touchStateRef.current.initialDistance
          const newScale = Math.max(0.1, Math.min(10, touchStateRef.current.initialScale * scaleChange))
          
          const img = imageRef.current
          if (img) {
            const imgWidth = img.naturalWidth
            const imgHeight = img.naturalHeight
            const initialCenterX = touchStateRef.current.initialX + (imgWidth * touchStateRef.current.initialScale) / 2
            const initialCenterY = touchStateRef.current.initialY + (imgHeight * touchStateRef.current.initialScale) / 2
            const vectorX = initialCenterX - centerX
            const vectorY = initialCenterY - centerY
            const scaleRatio = newScale / touchStateRef.current.initialScale
            const newCenterX = centerX + vectorX * scaleRatio
            const newCenterY = centerY + vectorY * scaleRatio
            const newX = newCenterX - (imgWidth * newScale) / 2
            const newY = newCenterY - (imgHeight * newScale) / 2
            setCrop({ x: newX, y: newY, scale: newScale })
          }
        }
        
        rafRef.current = null
      })
    }

    const handleTouchEnd = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      touchStateRef.current = null
    }

    editor.addEventListener('touchstart', handleTouchStart, { passive: false })
    editor.addEventListener('touchmove', handleTouchMove, { passive: false })
    editor.addEventListener('touchend', handleTouchEnd, { passive: true })
    editor.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    return () => {
      editor.removeEventListener('touchstart', handleTouchStart)
      editor.removeEventListener('touchmove', handleTouchMove)
      editor.removeEventListener('touchend', handleTouchEnd)
      editor.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [avatarPreviewUrl, crop.scale, crop.x, crop.y])

  // Touch event handlers for group avatar editor
  useEffect(() => {
    if (!groupAvatarPreviewUrl) return
    const editor = groupEditorRef.current
    if (!editor) return

    const getDistance = (touch1: Touch, touch2: Touch) => {
      const dx = touch2.clientX - touch1.clientX
      const dy = touch2.clientY - touch1.clientY
      return Math.sqrt(dx * dx + dy * dy)
    }

    const getCenter = (touch1: Touch, touch2: Touch) => ({
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2
    })

    const cropSize = 240
    const isPointInCircle = (x: number, y: number, centerX: number, centerY: number, radius: number) => {
      const dx = x - centerX
      const dy = y - centerY
      return dx * dx + dy * dy <= radius * radius
    }

    const handleTouchStart = (e: TouchEvent) => {
      const rect = editor.getBoundingClientRect()
      if (!rect) return
      const editorWidth = rect.width
      const editorHeight = rect.height
      const centerX = editorWidth / 2
      const centerY = editorHeight / 2
      const radius = cropSize / 2

      if (e.touches.length === 1) {
        const touch = e.touches[0]
        const touchX = touch.clientX - rect.left
        const touchY = touch.clientY - rect.top
        
        if (!isPointInCircle(touchX, touchY, centerX, centerY, radius)) {
          return
        }
        
        groupTouchStateRef.current = {
          touches: [touch],
          initialDistance: 0,
          initialScale: groupCrop.scale,
          initialX: groupCrop.x,
          initialY: groupCrop.y
        }
        e.preventDefault()
      } else if (e.touches.length === 2) {
        const touch1 = e.touches[0]
        const touch2 = e.touches[1]
        const center = getCenter(touch1, touch2)
        const centerTouchX = center.x - rect.left
        const centerTouchY = center.y - rect.top
        
        if (!isPointInCircle(centerTouchX, centerTouchY, centerX, centerY, radius)) {
          return
        }
        
        const distance = getDistance(touch1, touch2)
        groupTouchStateRef.current = {
          touches: [touch1, touch2],
          initialDistance: distance,
          initialScale: groupCrop.scale,
          initialX: groupCrop.x,
          initialY: groupCrop.y
        }
        e.preventDefault()
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (!groupTouchStateRef.current) return
      e.preventDefault()

      if (groupRafRef.current !== null) {
        cancelAnimationFrame(groupRafRef.current)
      }

      groupRafRef.current = requestAnimationFrame(() => {
        if (!groupTouchStateRef.current) return

        const rect = editor.getBoundingClientRect()
        if (!rect) return
        const editorWidth = rect.width
        const editorHeight = rect.height
        const centerX = editorWidth / 2
        const centerY = editorHeight / 2

        const touchesCount = e.touches.length
        const initialTouchesCount = groupTouchStateRef.current.touches.length

        if (touchesCount === 1 && initialTouchesCount === 1) {
          const touch = e.touches[0]
          const initialTouch = groupTouchStateRef.current.touches[0]
          
          const deltaX = touch.clientX - initialTouch.clientX
          const deltaY = touch.clientY - initialTouch.clientY
          
          setGroupCrop((prev) => {
            let newX = groupTouchStateRef.current!.initialX + deltaX
            let newY = groupTouchStateRef.current!.initialY + deltaY
            
            const img = groupImageRef.current
            if (img) {
              const currentScale = prev.scale
              const imgScaledWidth = img.naturalWidth * currentScale
              const imgScaledHeight = img.naturalHeight * currentScale
              const maxX = centerX + cropSize / 2
              const minX = centerX - cropSize / 2 - imgScaledWidth
              const maxY = centerY + cropSize / 2
              const minY = centerY - cropSize / 2 - imgScaledHeight
              
              newX = Math.max(minX, Math.min(maxX, newX))
              newY = Math.max(minY, Math.min(maxY, newY))
            }
            
            return { ...prev, x: newX, y: newY }
          })
        } else if (touchesCount === 2 && initialTouchesCount === 2) {
          const touch1 = e.touches[0]
          const touch2 = e.touches[1]
          const distance = getDistance(touch1, touch2)
          const scaleChange = distance / groupTouchStateRef.current.initialDistance
          const newScale = Math.max(0.1, Math.min(10, groupTouchStateRef.current.initialScale * scaleChange))
          
          const img = groupImageRef.current
          if (img) {
            const imgWidth = img.naturalWidth
            const imgHeight = img.naturalHeight
            const initialCenterX = groupTouchStateRef.current.initialX + (imgWidth * groupTouchStateRef.current.initialScale) / 2
            const initialCenterY = groupTouchStateRef.current.initialY + (imgHeight * groupTouchStateRef.current.initialScale) / 2
            const vectorX = initialCenterX - centerX
            const vectorY = initialCenterY - centerY
            const scaleRatio = newScale / groupTouchStateRef.current.initialScale
            const newCenterX = centerX + vectorX * scaleRatio
            const newCenterY = centerY + vectorY * scaleRatio
            const newX = newCenterX - (imgWidth * newScale) / 2
            const newY = newCenterY - (imgHeight * newScale) / 2
            setGroupCrop({ x: newX, y: newY, scale: newScale })
          }
        }
        
        groupRafRef.current = null
      })
    }

    const handleTouchEnd = () => {
      if (groupRafRef.current !== null) {
        cancelAnimationFrame(groupRafRef.current)
        groupRafRef.current = null
      }
      groupTouchStateRef.current = null
    }

    editor.addEventListener('touchstart', handleTouchStart, { passive: false })
    editor.addEventListener('touchmove', handleTouchMove, { passive: false })
    editor.addEventListener('touchend', handleTouchEnd, { passive: true })
    editor.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    return () => {
      editor.removeEventListener('touchstart', handleTouchStart)
      editor.removeEventListener('touchmove', handleTouchMove)
      editor.removeEventListener('touchend', handleTouchEnd)
      editor.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [groupAvatarPreviewUrl, groupCrop.scale, groupCrop.x, groupCrop.y])

  const ensureNotifyAudio = useCallback(() => {
    if (typeof window === 'undefined') return null
    if (!notifyAudioRef.current) {
      const audio = new Audio('/notify.mp3')
      audio.preload = 'auto'
      audio.volume = 0.9
      notifyAudioRef.current = audio
    }
    return notifyAudioRef.current
  }, [])

  const ensureRingAudio = useCallback(() => {
    if (typeof window === 'undefined') return null
    if (!ringAudioRef.current) {
      const audio = new Audio('/ring.mp3')
      audio.preload = 'auto'
      audio.loop = true
      audio.volume = 0.9
      ringAudioRef.current = audio
    }
    return ringAudioRef.current
  }, [])

  const performAudioUnlock = async () => {
    if (audioUnlockingRef.current) {
      return notifyUnlockedRef.current && ringUnlockedRef.current
    }
    audioUnlockingRef.current = true
    try {
      ensureNotifyAudio()
      ensureRingAudio()
      const played = await unlockAppAudio()
      if (played) {
        notifyUnlockedRef.current = true
        ringUnlockedRef.current = true
        setShowAudioUnlock(false)
      }
    } catch {}
    audioUnlockingRef.current = false
    return notifyUnlockedRef.current && ringUnlockedRef.current
  }

  function stopRingtone() {
    try {
      ringTimerRef.current && clearTimeout(ringTimerRef.current)
      ringTimerRef.current = null
      if (ringAudioRef.current) {
        try {
          ringAudioRef.current.pause()
          ringAudioRef.current.currentTime = 0
        } catch {}
      }
      ringingConvIdRef.current = null
    } catch {}
  }

  const ensureDialingAudio = useCallback(() => {
    if (typeof window === 'undefined') return null
    if (!dialingAudioRef.current) {
      const audio = new Audio('/dialing.mp3')
      audio.preload = 'auto'
      audio.loop = true
      audio.volume = 0.7
      dialingAudioRef.current = audio
    }
    return dialingAudioRef.current
  }, [])

  function startMelodicDialingTone(): null | { stop: () => void } {
    if (typeof window === 'undefined') return null
    const AudioContextCtor = (window.AudioContext || (window as any).webkitAudioContext) as
      | (new () => AudioContext)
      | undefined
    if (!AudioContextCtor) return null

    // Create a short, pleasant 3-note "chime" motif that repeats.
    // This avoids shipping a new binary audio file and lets us control volume/cadence.
    const ctx = new AudioContextCtor()
    const master = ctx.createGain()
    master.gain.value = 0.08
    master.connect(ctx.destination)

    let stopped = false
    let timer: number | null = null
    const oscillators = new Set<OscillatorNode>()

    const scheduleOnce = () => {
      if (stopped) return
      // Ensure playback starts even if context begins suspended (common on Safari/iOS).
      void ctx.resume().catch(() => {})

      const t0 = ctx.currentTime + 0.02
      const notes: Array<{ f: number; dur: number; gapAfter: number }> = [
        { f: 523.25, dur: 0.18, gapAfter: 0.08 }, // C5
        { f: 659.25, dur: 0.22, gapAfter: 0.12 }, // E5
        { f: 783.99, dur: 0.18, gapAfter: 1.20 }, // G5, then pause
      ]

      let t = t0
      for (const n of notes) {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()

        osc.type = 'sine'
        osc.frequency.setValueAtTime(n.f, t)

        // Gentle envelope to avoid clicks.
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(1, t + 0.01)
        g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur)

        osc.connect(g)
        g.connect(master)

        try {
          osc.start(t)
          osc.stop(t + n.dur + 0.03)
        } catch {}

        oscillators.add(osc)
        osc.onended = () => {
          oscillators.delete(osc)
          try {
            osc.disconnect()
            g.disconnect()
          } catch {}
        }

        t += n.dur + n.gapAfter
      }

      timer = window.setTimeout(scheduleOnce, Math.max(300, Math.round((t - t0) * 1000)))
    }

    scheduleOnce()

    return {
      stop: () => {
        if (stopped) return
        stopped = true
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        for (const osc of Array.from(oscillators)) {
          try {
            osc.onended = null
            osc.stop(0)
          } catch {}
        }
        oscillators.clear()
        try {
          master.disconnect()
        } catch {}
        try {
          void ctx.close()
        } catch {}
      },
    }
  }

  function startDialingSound() {
    try {
      // Stop any previous tone/audio to avoid overlaps.
      stopDialingSound()

      // Prefer a generated "melodic" ringback. Fallback to the existing mp3 if WebAudio isn't available.
      const tone = startMelodicDialingTone()
      if (tone) {
        dialingToneStopRef.current = tone.stop
        return
      }

      const audio = ensureDialingAudio()
      if (!audio) return
      audio.currentTime = 0
      audio.loop = true
      audio.volume = 0.7
      void audio.play().catch(() => {})
    } catch (err) {
      console.error('Error starting dialing sound:', err)
    }
  }

  function stopDialingSound() {
    try {
      if (dialingToneStopRef.current) {
        try {
          dialingToneStopRef.current()
        } catch {}
        dialingToneStopRef.current = null
      }
      if (dialingAudioRef.current) {
        try {
          dialingAudioRef.current.pause()
          dialingAudioRef.current.currentTime = 0
        } catch {}
      }
    } catch {}
  }

  const ensureEndCallAudio = useCallback(() => {
    if (typeof window === 'undefined') return null
    if (!endCallAudioRef.current) {
      const audio = new Audio('/notify.mp3')
      audio.preload = 'auto'
      audio.volume = 0.6
      endCallAudioRef.current = audio
    }
    return endCallAudioRef.current
  }, [])

  function playEndCallSound() {
    try {
      const audio = ensureEndCallAudio()
      if (audio) {
        audio.currentTime = 0
        audio.volume = 0.6
        void audio.play().catch(() => {})
      }
    } catch (err) {
      console.error('Error playing end call sound:', err)
    }
  }

  // Join/leave rooms on active chat change
  // Унифицированная логика обновления сообщений для всех типов бесед (1:1 и группы)
  useEffect(() => {
    const onNew = async (payload: any) => {
      const conversationId = payload.conversationId
      const isActive = conversationId === activeId
      
      // Для неактивных чатов: инвалидируем список бесед, чтобы получить актуальный unreadCount с сервера
      if (!isActive) {
        client.invalidateQueries({ queryKey: ['conversations'] })
        return
      }
      
      // Для активного чата: обновляем сообщения
      if (!activeId) return
      const incoming = payload.message ?? payload
      if (incoming && incoming.id) {
        // Remove any pending messages that might match this one (by sender and attachments)
        setPendingByConv((prev) => {
          const convPending = prev[activeId] || []
          if (convPending.length === 0) return prev
          // Check if this message matches any pending by comparing attachments
          const incomingAttachments = (incoming.attachments || []).map((a: any) => a.url).sort()
          const filtered = convPending.filter((pending) => {
            if (pending.senderId !== incoming.senderId) return true
            const pendingAttachments = pending.attachments.map((a) => a.url).sort()
            // If attachments match (or both have same number), remove pending
            if (pendingAttachments.length === incomingAttachments.length) {
              // For images, compare by checking if URLs match or are similar
              const match = pendingAttachments.every((pUrl, idx) => {
                const iUrl = incomingAttachments[idx]
                // If pending has blob URL and incoming has real URL, it's likely the same message
                return pUrl === iUrl || (pUrl.startsWith('blob:') && iUrl && !iUrl.startsWith('blob:'))
              })
              return !match
            }
            return true
          })
          if (filtered.length === convPending.length) return prev
          if (filtered.length === 0) {
            const { [activeId]: _, ...rest } = prev
            return rest
          }
          return { ...prev, [activeId]: filtered }
        })
        // Оптимистичное обновление кэша (работает для всех типов бесед)
        appendMessageToCache(activeId, incoming)
      }
      // Всегда делаем refetch для получения актуальных данных (как для 1:1, так и для групп)
      messagesQuery.refetch()
    }
    const onTyping = (p: any) => {
      if (!p) return
      if (p.conversationId !== activeId) return
      const uid = typeof p.userId === 'string' ? p.userId : null
      if (!uid) return
      // Ignore our own typing echoes (defense-in-depth)
      if (uid === me?.id) return
      const isTyping = !!p.typing
      setTypingByUserId((prev) => {
        if (!isTyping) {
          if (!prev[uid]) return prev
          const next = { ...prev }
          delete next[uid]
          return next
        }
        return { ...prev, [uid]: Date.now() }
      })
    }
    const onReaction = (payload: { conversationId: string; messageId: string; message?: any }) => {
      if (!activeId || payload.conversationId !== activeId) {
        client.invalidateQueries({ queryKey: ['conversations'] })
        return
      }
      if (payload.message) {
        updateMessageInCache(activeId, payload.message)
      } else {
        messagesQuery.refetch()
      }
    }
    const onUpdate = (payload: any) => {
      if (!payload) return
      const conversationId = payload.conversationId
      if (!activeId || conversationId !== activeId) return
      if (payload.message && payload.message.id) {
        updateMessageInCache(activeId, payload.message, { preserveScroll: payload.reason === 'link_preview' })
      } else if (payload.messageId) {
        messagesQuery.refetch().catch(() => {})
      }
    }

    socket.on('message:new', onNew)
    socket.on('conversation:typing', onTyping)
    socket.on('message:reaction', onReaction)
    socket.on('message:update', onUpdate)
    return () => {
      socket.off('message:new', onNew as any)
      socket.off('conversation:typing', onTyping as any)
      socket.off('message:reaction', onReaction as any)
      socket.off('message:update', onUpdate as any)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, me?.id])

  // Unified handler for message:notify - handles both active and inactive chats
  useEffect(() => {
    const handler = async (p: { conversationId: string; messageId: string; senderId: string; message?: any }) => {
      if (isSecretBlockedForDevice(p.conversationId)) {
        return
      }
      const isMine = p.senderId === me?.id
      const isViewing = p.conversationId === activeId
      const visible = document.visibilityState === 'visible'
      
      // Воспроизводим звук уведомления, если нужно
      if (!isMine && (!isViewing || !visible)) {
        if (notifyAudioRef.current && notifyUnlockedRef.current) {
          notifyAudioRef.current.currentTime = 0
          notifyAudioRef.current.play().catch(() => {})
        }
      }
      
      // Если это текущий чат, обновляем сообщения немедленно
      if (isViewing) {
        // Если есть полное сообщение в payload, используем оптимистичное обновление
        if (p.message && p.message.id) {
          appendMessageToCache(activeId, p.message)
        }
        // Всегда делаем refetch для получения актуальных данных
        messagesQuery.refetch().catch(() => {})
        return
      }
      
      // Для неактивных чатов: НЕ увеличиваем счетчик локально
      // Вместо этого полагаемся на refetch из message:new события
      // Это предотвращает двойное увеличение счетчика
    }
    socket.on('message:notify', handler)
    return () => { socket.off('message:notify', handler) }
  }, [activeId, me?.id, messagesQuery, isSecretBlockedForDevice])

  // Auto-stick to bottom when new messages render (but respect manual scroll)
  useLayoutEffect(() => {
    if (!activeId) {
      lastScrollConvRef.current = null
      lastRenderedMessagesRef.current = 0
      return
    }
    if (lastScrollConvRef.current !== activeId) {
      lastScrollConvRef.current = activeId
      lastRenderedMessagesRef.current = 0
    }
    const renderedCount = (displayedMessages?.length ?? 0) + activePendingMessages.length
    const prevCount = lastRenderedMessagesRef.current
    lastRenderedMessagesRef.current = renderedCount
    if (!messagesRef.current) return
    if (renderedCount === 0 || renderedCount <= prevCount) return
    const fullList = [
      ...(displayedMessages || []),
      ...activePendingMessages,
    ]
    const lastMessage = fullList[fullList.length - 1]
    const isMine = lastMessage?.senderId && me?.id ? lastMessage.senderId === me.id : false
    const shouldStick = isMine || !userStickyScrollRef.current || nearBottomRef.current
    if (!shouldStick) return
    requestAnimationFrame(() => {
      const el = messagesRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      nearBottomRef.current = true
      if (isMine) {
        userStickyScrollRef.current = false
      }
    })
  }, [activeId, activePendingMessages, displayedMessages, me?.id])

  // notifications disabled

  // autoscroll to bottom when chat opens (агрессивно только на мобильных)
  useEffect(() => {
    if (!activeId) return
    const el = messagesRef.current
    if (!el) return
    const scrollToBottom = () => {
      if (el) {
        el.scrollTop = el.scrollHeight
        nearBottomRef.current = true
        userStickyScrollRef.current = false
      }
    }
    if (isMobileRef.current) {
      scrollToBottom()
      const t1 = window.setTimeout(scrollToBottom, 50)
      const t2 = window.setTimeout(scrollToBottom, 200)
      return () => {
        window.clearTimeout(t1)
        window.clearTimeout(t2)
      }
    }
    // На десктопе достаточно одного вызова при открытии
    scrollToBottom()
    return
  }, [activeId])

  // keep pinned to bottom while keyboard is opening/moving on mobile (iOS visualViewport)
  useEffect(() => {
    if (!isMobileRef.current) return
    const el = messagesRef.current
    if (!el) return
    const handleVV = () => {
      const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
      if (active && active === inputRef.current) {
        el.scrollTop = el.scrollHeight
        nearBottomRef.current = true
        userStickyScrollRef.current = false
      }
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleVV, { passive: true } as any)
      window.visualViewport.addEventListener('scroll', handleVV, { passive: true } as any)
    }
    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleVV as any)
        window.visualViewport.removeEventListener('scroll', handleVV as any)
      }
    }
  }, [activeId])

  // Dev-only: warn if credential-like inputs are present on chat page
  useEffect(() => {
    if (!(import.meta as any).env?.DEV) return
    const suspects = document.querySelectorAll(
      'input[type="password"], input[autocomplete*="password" i], input[name*="pass" i], input[name*="user" i], input[name*="email" i], input[autocomplete*="username" i]'
    )
    if (suspects.length) {
      // eslint-disable-next-line no-console
      console.warn('Credential-like inputs present on chat page:', suspects)
    }
  }, [])

  // автопрокрутка по новым сообщениям отключена, чтобы не мешать ручному скроллу

  // animate typing dots and keep view pinned to bottom when typing shown (только на мобильных)
  useEffect(() => {
    const isSomeoneTyping = Object.keys(typingByUserId).length > 0
    if (!isSomeoneTyping || !isMobileRef.current) return
    const el = messagesRef.current
    const id = window.setInterval(() => {
      setTypingDots((d) => (d % 3) + 1)
      if (el) {
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        if (nearBottom) el.scrollTop = el.scrollHeight
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [typingByUserId])

  // Expire incoming typing users automatically (defense in depth; server doesn't send periodic stops).
  useEffect(() => {
    // Reset typing state on chat switch to avoid stale "typing..." from previous conversation.
    setTypingByUserId({})
    if (typingCleanupTimerRef.current) {
      window.clearInterval(typingCleanupTimerRef.current)
      typingCleanupTimerRef.current = null
    }
    typingCleanupTimerRef.current = window.setInterval(() => {
      const now = Date.now()
      setTypingByUserId((prev) => {
        const keys = Object.keys(prev)
        if (!keys.length) return prev
        let changed = false
        const next: Record<string, number> = {}
        for (const uid of keys) {
          const ts = prev[uid]
          if (typeof ts === 'number' && now - ts < 2600) {
            next[uid] = ts
          } else {
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 800)
    return () => {
      if (typingCleanupTimerRef.current) {
        window.clearInterval(typingCleanupTimerRef.current)
        typingCleanupTimerRef.current = null
      }
    }
  }, [activeId])

  // Show jump-to-bottom button when user scrolls up
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    let raf = 0
    let lastScrollTop = el.scrollTop
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf)
      const currentScrollTop = el.scrollTop
      const scrollDelta = Math.abs(currentScrollTop - lastScrollTop)
      // Only mark as user scroll if there's actual movement (not just programmatic scroll)
      if (scrollDelta > 1) {
        userStickyScrollRef.current = true
      }
      raf = requestAnimationFrame(() => {
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
        nearBottomRef.current = nearBottom
        setShowJump(!nearBottom)
        // Infinite scroll: when user reaches near-top, load older messages.
        // We keep scroll position stable in `loadOlderMessages`.
        if (el.scrollTop < 140) {
          void loadOlderMessages()
        }
        if (nearBottom) {
          // Only reset user sticky scroll if we're actually near bottom
          // Give a small delay to allow programmatic scrolls
          window.setTimeout(() => {
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
              userStickyScrollRef.current = false
            }
          }, 100)
        }
        lastScrollTop = el.scrollTop
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [activeId, loadOlderMessages])

  // detect wide area to left-align all messages
  useEffect(() => {
    const measure = () => {
      if (!messagesRef.current) return
      const width = messagesRef.current.clientWidth
      setLeftAlignAll(width >= 900)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [activeId])

  function onChangeDigit(idx: number, val: string) {
    if (!/^\d?$/.test(val)) return
    const next = [...eblDigits]
    next[idx] = val
    setEblDigits(next)
    if (val && idx < 3) eblRefs[idx + 1].current?.focus()
    if (!val && idx > 0) eblRefs[idx - 1].current?.focus()
    const full = next.join('')
    if (full.length === 4 && /^\d{4}$/.test(full)) {
      ;(async () => {
        try {
          const resp = await api.get('/contacts/search', { params: { query: full } })
          setFoundUser(resp.data.results?.[0] ?? null)
        } catch { setFoundUser(null) }
      })()
    } else {
      setFoundUser(null)
    }
  }

  async function openContactsOverlay() {
    setContactsOpen(true)
    try {
      const r = await api.get('/status/me')
      setMyEblid(r.data.user?.eblid ?? '')
    } catch {}
  }

  async function sendInvite() {
    const code = eblDigits.join('')
    if (!/^\d{4}$/.test(code)) return
    setSendingInvite(true)
    try {
      await api.post('/contacts/add', { identifier: code })
      setSendingInvite(false)
    } catch { setSendingInvite(false) }
  }

  function canAutoMarkRead() {
    try {
      return document.visibilityState === 'visible' && document.hasFocus()
    } catch {
      return false
    }
  }

  function markConversationReadNow() {
    if (!activeId) return
    if (!canAutoMarkRead()) return
    // mark conversation read on server to zero unreadCount
    api.post('/messages/mark-conversation-read', { conversationId: activeId }).catch(() => {})
    // Optimistically zero unread locally
    client.setQueryData(['conversations'], (old: any) => {
      if (!old) return old
      return old.map((row: any) => row.conversation.id === activeId ? { ...row, unreadCount: 0 } : row)
    })
  }

  // Simplified: mark all messages as READ if chat is open and window focused
  function markAllReadNow() {
    if (!activeId || !messagesQuery.data || !me?.id) return
    if (!canAutoMarkRead()) return
    const unreadIds = (messagesQuery.data as Array<any>)
      .filter((m) => m.senderId !== me.id)
      .filter((m) => !(m.receipts || []).some((r: any) => r.userId === me.id && (r.status === 'READ' || r.status === 'SEEN')))
      .map((m) => m.id)
    if (unreadIds.length === 0) return
    api.post('/messages/receipts', { messageIds: unreadIds, status: 'READ' })
      .then(() => { client.invalidateQueries({ queryKey: ['messages', activeId] }); })
      .catch(() => {})
  }

  useEffect(() => {
    if (canAutoMarkRead()) {
      markAllReadNow()
      markConversationReadNow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    if (canAutoMarkRead()) {
      markAllReadNow()
      markConversationReadNow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesQuery.data])

  useEffect(() => {
    const onFocus = () => {
      if (!canAutoMarkRead()) return
      markAllReadNow()
      markConversationReadNow()
    }
    const onVis = () => {
      if (!canAutoMarkRead()) return
      markAllReadNow()
      markConversationReadNow()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, messagesQuery.data])

  // batch sender for receipts
  function scheduleSendReceipts() {
    if (batchTimer.current) return
    batchTimer.current = window.setTimeout(() => {
      const ids = Array.from(batchToRead.current)
      batchToRead.current.clear()
      batchTimer.current && clearTimeout(batchTimer.current)
      batchTimer.current = null
      if (!ids.length) return
      api.post('/messages/receipts', { messageIds: ids, status: 'READ' })
        .then(() => { if (activeId) client.invalidateQueries({ queryKey: ['messages', activeId] }) })
        .catch(() => {})
    }, 250)
  }

  // Observe bubbles and mark as READ when visible in viewport and app focused/visible
  useEffect(() => {
    if (!activeId || !messagesQuery.data || !me?.id) return
    // Clean previous
    visibleObserver.current?.disconnect()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue
        if (!canAutoMarkRead()) continue
        const el = entry.target as HTMLElement
        const mid = el.dataset.mid
        if (!mid) continue
        const msg = (messagesQuery.data as Array<any>).find((m) => m.id === mid)
        if (!msg) continue
        if (msg.senderId === me.id) continue
        const already = (msg.receipts || []).some((r: any) => r.userId === me.id && (r.status === 'READ' || r.status === 'SEEN'))
        if (already) continue
        batchToRead.current.add(mid)
        observer.unobserve(el)
      }
      if (batchToRead.current.size) scheduleSendReceipts()
    }, { root: messagesRef.current!, threshold: [0.25] })
    visibleObserver.current = observer
    // Attach to all eligible message bubbles
    for (const m of messagesQuery.data as Array<any>) {
      if (m.senderId === me.id) continue
      const already = (m.receipts || []).some((r: any) => r.userId === me.id && (r.status === 'READ' || r.status === 'SEEN'))
      if (already) continue
      const node = nodesByMessageId.current.get(m.id)
      if (node) observer.observe(node)
    }
    return () => {
      observer.disconnect()
    }
  }, [activeId, messagesQuery.data, me?.id])

  // do not auto-mark all as READ on load; handled on message arrival if window focused

  // detect wide area to left-align all messages
  useEffect(() => {
    const measure = () => {
      if (!messagesRef.current) return
      const width = messagesRef.current.clientWidth
      setLeftAlignAll(width >= 900)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [activeId])

  const emitTyping = useCallback((conversationId: string, typing: boolean) => {
    if (!conversationId) return
    try {
      if (!socket.connected) {
        connectSocket()
      }
    } catch {
      // ignore connect errors; emit may still succeed later
    }
    socket.emit('conversation:typing', { conversationId, typing })
  }, [])

  const stopTyping = useCallback((conversationId: string | null) => {
    const st = typingEmitRef.current
    if (st.startTimer) window.clearTimeout(st.startTimer)
    if (st.stopTimer) window.clearTimeout(st.stopTimer)
    st.startTimer = null
    st.stopTimer = null
    if (conversationId && st.lastSentTyping) {
      emitTyping(conversationId, false)
    }
    st.lastSentTyping = false
    st.lastSentAt = 0
    st.convId = conversationId
  }, [emitTyping])

  const cancelEdit = useCallback(() => {
    setEditState(null)
    setEditBusy(false)
    setMessageText('')
    setReplyTo(null)
    // Keep pending images as-is; entering edit mode is only allowed when composer is empty.
    requestAnimationFrame(() => {
      try {
        inputRef.current?.focus()
      } catch {}
    })
  }, [])

  const startEdit = useCallback(
    (msg: any) => {
      if (!msg || typeof msg.id !== 'string') return
      if (msg.senderId !== me?.id) return
      if (msg.deletedAt) return
      if ((msg.type || 'TEXT') !== 'TEXT') return
      const atts = Array.isArray(msg.attachments) ? msg.attachments : []
      // Avoid mixing editing with attachment flows for now.
      if (atts.length > 0) return
      const text = typeof msg.content === 'string' ? msg.content : ''
      setReplyTo(null)
      setEditBusy(false)
      setEditState({ messageId: msg.id, originalText: text })
      setMessageText(text)
      requestAnimationFrame(() => {
        try {
          const el = inputRef.current
          if (!el) return
          el.focus()
          const end = el.value.length
          el.setSelectionRange(end, end)
        } catch {}
      })
    },
    [me?.id],
  )

  const notifyTyping = useCallback(() => {
    if (!activeId) return
    const st = typingEmitRef.current
    // If conversation changed while timers pending, best-effort stop old one.
    if (st.convId && st.convId !== activeId && st.lastSentTyping) {
      emitTyping(st.convId, false)
      st.lastSentTyping = false
    }
    st.convId = activeId

    if (st.startTimer) window.clearTimeout(st.startTimer)
    // Debounce typing_start
    st.startTimer = window.setTimeout(() => {
      const now = Date.now()
      // Throttle re-sending "typing=true" to keep remote indicator alive without spamming.
      if (!st.lastSentTyping || now - st.lastSentAt > 2000) {
        emitTyping(activeId, true)
        st.lastSentTyping = true
        st.lastSentAt = now
      }
    }, 420)

    if (st.stopTimer) window.clearTimeout(st.stopTimer)
    // Send typing_stop on idle
    st.stopTimer = window.setTimeout(() => {
      if (!st.convId) return
      if (st.lastSentTyping) {
        emitTyping(st.convId, false)
      }
      st.lastSentTyping = false
      st.lastSentAt = Date.now()
    }, 2100)
  }, [activeId, emitTyping])

  const resizeComposer = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    try {
      const cs = window.getComputedStyle(el)
      const minHRaw = cs.getPropertyValue('--control-h').trim()
      const maxHRaw = cs.getPropertyValue('--composer-max-h').trim()
      const minH = Number.parseInt(minHRaw || '46', 10) || 46
      const maxH = Number.parseInt(maxHRaw || '140', 10) || 140

      // Reset height to measure correct scrollHeight (allows shrinking).
      el.style.height = '0px'
      const next = Math.min(el.scrollHeight, maxH)
      el.style.height = `${Math.max(next, minH)}px`
      el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden'
    } catch {
      // ignore
    }
  }, [])

  // Auto-grow composer like in messengers: 1 line min, expand with newlines.
  useLayoutEffect(() => {
    resizeComposer()
  }, [messageText, resizeComposer])

  // Ensure we always send typing_stop on conversation switch/unmount.
  useEffect(() => {
    const convId = activeId
    return () => {
      stopTyping(convId)
    }
  }, [activeId, stopTyping])

  async function uploadAndSendAttachments(files: File[], textContent: string = '', replyToId?: string) {
    if (!activeId || files.length === 0) return
    const isSecretConversation = !!activeConversation?.isSecret
    if (isSecretConversation) {
      if (conversationSecretInactive) {
        alert('Секретный чат больше не активен, отправка вложений отключена.')
        return
      }
      if (!conversationSecretSessionReady) {
        alert('Секретный чат ещё не готов к вложениям, подождите установления защищённой сессии.')
        return
      }
    }
    setAttachUploading(true)
    setAttachProgress(0)
    try {
      // Build optimistic pending entry
      const pid = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const pendingAttachments: PendingAttachment[] = []
      const totalSize = files.reduce((s, f) => s + f.size, 0)
      // Precompute dimensions for images
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const blobUrl = URL.createObjectURL(f)
          const { width, height } = await getImageSize(blobUrl)
          pendingAttachments.push({ url: blobUrl, type: 'IMAGE', width, height, progress: 0, __pending: true })
        } else {
          pendingAttachments.push({ url: f.name, type: 'FILE', size: f.size, __pending: true, progress: 0 })
        }
      }
      setPendingByConv((prev) => ({
        ...prev,
        [activeId!]: [
          ...(prev[activeId!] || []),
          { id: pid, createdAt: Date.now(), senderId: me?.id || 'me', attachments: pendingAttachments, content: textContent },
        ],
      }))

      const uploaded: Array<{ url: string; type: 'IMAGE' | 'FILE'; size?: number; metadata?: Record<string, any> }> = []
      let done = 0
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const pendingAtt = pendingAttachments[i]
        let uploadBlob: Blob | File = f
        let encryptedMeta: Record<string, any> | undefined
        if (isSecretConversation && activeConversation) {
          const buffer = new Uint8Array(await f.arrayBuffer())
          const encrypted = await e2eeManager.encryptBinary(activeConversation, buffer)
          uploadBlob = new Blob([encrypted.cipher as BlobPart], { type: 'application/octet-stream' })
          encryptedMeta = {
            kind: 'ciphertext',
            version: 1,
            algorithm: 'xsalsa20_poly1305',
            nonce: encrypted.nonce,
            originalName: f.name,
            originalType: f.type,
            originalSize: f.size,
          }
        }
        const form = new FormData()
        form.append('file', uploadBlob, isSecretConversation ? `${f.name || 'file'}.enc` : f.name)
        if (f.name) form.append('originalFileName', f.name)
        const url = await new Promise<string>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', '/api/upload')
          try { const token = useAppStore.getState().session?.accessToken; if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`) } catch {}
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const percent = Math.round(((done + e.loaded) / totalSize) * 100)
              setAttachProgress(percent)
              // update corresponding pending attachment progress
              setPendingByConv((prev) => {
                const arr = prev[activeId!] || []
                const copy = arr.map((m) => ({ ...m, attachments: m.attachments.map((a) => ({ ...a })) }))
                const last = copy[copy.length - 1]
                if (last) {
                  const idx = last.attachments.findIndex((a) => a.__pending && a.type === (f.type.startsWith('image/') ? 'IMAGE' : 'FILE') && (!a.width || a.url.startsWith('blob:')))
                  if (idx >= 0) last.attachments[idx].progress = percent
                }
                return { ...prev, [activeId!]: copy }
              })
            }
          }
          xhr.onreadystatechange = () => {
            if (xhr.readyState === 4) {
              if (xhr.status >= 200 && xhr.status < 300) {
                try { const resp = JSON.parse(xhr.responseText); resolve(resp.url) } catch (err) { reject(err) }
              } else reject(new Error('upload failed'))
            }
          }
          xhr.send(form)
        })
        const uploadItem: { url: string; type: 'IMAGE' | 'FILE'; size?: number; metadata?: Record<string, any> } = {
          url,
          type: f.type.startsWith('image/') ? 'IMAGE' : 'FILE',
          size: f.size,
        }
        const metadataPayload: Record<string, any> = {}
        if (f.name) metadataPayload.originalName = f.name
        if (f.type) metadataPayload.mime = f.type
        if (Number.isFinite(f.size) && f.size > 0) metadataPayload.size = f.size
        if (pendingAtt && pendingAtt.type === 'IMAGE' && pendingAtt.width && pendingAtt.height) {
          metadataPayload.width = pendingAtt.width
          metadataPayload.height = pendingAtt.height
        }
        if (encryptedMeta) {
          metadataPayload.e2ee = encryptedMeta
        }
        if (Object.keys(metadataPayload).length > 0) {
          uploadItem.metadata = metadataPayload
        }
        uploaded.push(uploadItem)
        done += f.size
        setAttachProgress(Math.round((done / totalSize) * 100))
      }
      // Send as FILE message if there is no text and only attachments
      const msgType = uploaded.every((u) => u.type === 'IMAGE') ? 'IMAGE' : 'FILE'
      await api.post('/conversations/send', { conversationId: activeId, type: msgType, content: textContent, attachments: uploaded, replyToId })
      // Remove pending message after successful send
      setPendingByConv((prev) => {
        const convPending = prev[activeId!] || []
        const filtered = convPending.filter((m) => m.id !== pid)
        if (filtered.length === 0) {
          const { [activeId!]: _, ...rest } = prev
          return rest
        }
        return { ...prev, [activeId!]: filtered }
      })
      client.invalidateQueries({ queryKey: ['messages', activeId] })
    } catch (error) {
      console.error('Failed to upload attachments', error)
    }
    setAttachUploading(false)
  }

  async function getImageSize(url: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => resolve({ width: 320, height: 200 })
      img.src = url
    })
  }

  const startVoiceRecording = async () => {
    if (!activeId) return
    if (voiceRecording) return

    try {
      const permissionResult = await ensureMediaPermissions({ audio: true })
      if (!permissionResult.ok) {
        alert('Необходимо разрешение на использование микрофона для записи голосовых сообщений')
        return
      }

      // На всякий случай останавливаем рингтон (мог остаться активным)
      stopRingtone()

      // Сбрасываем waveform при начале новой записи
      setVoiceWaveform([])

      const recorder = new VoiceRecorder({
        onStateChange: (state) => {
          setVoiceRecording(state === 'recording')
          if (state !== 'recording') {
            // Останавливаем сбор waveform данных
            if (waveformUpdateIntervalRef.current) {
              clearInterval(waveformUpdateIntervalRef.current)
              waveformUpdateIntervalRef.current = null
            }
          }
        },
        onDurationUpdate: (duration) => {
          setVoiceDuration(duration)
        },
        onAmplitudeUpdate: (amplitude) => {
          // Обновляем waveform в реальном времени
          // Используем фиксированное количество баров (как при воспроизведении) для стабильности на мобильных
          setVoiceWaveform((prev) => {
            const maxBars = isMobile ? 60 : waveformMaxBars
            const newWaveform = [...prev, amplitude]
            // Ограничиваем до фиксированного количества баров, новые данные сдвигают старые влево
            if (newWaveform.length > maxBars) {
              return newWaveform.slice(-maxBars)
            }
            return newWaveform
          })
        },
        onError: (error) => {
          console.error('Voice recording error:', error)
          alert('Ошибка записи голосового сообщения')
          stopVoiceRecording()
        },
      })

      voiceRecorderRef.current = recorder
      await recorder.start()
    } catch (error) {
      console.error('Failed to start voice recording:', error)
      alert('Не удалось начать запись голосового сообщения')
    }
  }

  const stopVoiceRecording = () => {
    if (!voiceRecorderRef.current) return
    const recorder = voiceRecorderRef.current
    const duration = recorder.getDuration()
    const audioBlob = recorder.stop()
    voiceRecorderRef.current = null
    setVoiceRecording(false)
    setVoiceDuration(0)

    if (audioBlob && activeId) {
      sendVoiceMessage(audioBlob, duration)
    }
  }

  const cancelVoiceRecording = () => {
    if (voiceRecorderRef.current) {
      voiceRecorderRef.current.cancel()
      voiceRecorderRef.current = null
    }
    if (waveformUpdateIntervalRef.current) {
      clearInterval(waveformUpdateIntervalRef.current)
      waveformUpdateIntervalRef.current = null
    }
    setVoiceRecording(false)
    setVoiceDuration(0)
    setVoiceWaveform([])
  }

  const sendVoiceMessage = async (audioBlob: Blob, duration: number) => {
    if (!activeId) return
    const isSecretConversation = !!activeConversation?.isSecret

    if (isSecretConversation) {
      if (conversationSecretInactive) {
        alert('Секретный чат больше не активен, отправка голосовых сообщений отключена.')
        return
      }
      if (!conversationSecretSessionReady) {
        alert('Секретный чат ещё не готов к голосовым сообщениям, подождите установления защищённой сессии.')
        return
      }
    }

    setAttachUploading(true)
    setAttachProgress(0)

    try {
      // Create a File from Blob
      const audioFile = new File([audioBlob], 'voice-message.webm', { type: audioBlob.type || 'audio/webm' })
      
      let uploadBlob: Blob | File = audioFile
      let encryptedMeta: Record<string, any> | undefined

      if (isSecretConversation && activeConversation) {
        const buffer = new Uint8Array(await audioFile.arrayBuffer())
        const encrypted = await e2eeManager.encryptBinary(activeConversation, buffer)
        uploadBlob = new Blob([encrypted.cipher as BlobPart], { type: 'application/octet-stream' })
        encryptedMeta = {
          kind: 'ciphertext',
          version: 1,
          algorithm: 'xsalsa20_poly1305',
          nonce: encrypted.nonce,
          originalName: audioFile.name,
          originalType: audioFile.type,
          originalSize: audioFile.size,
        }
      }

      const form = new FormData()
      form.append('file', uploadBlob, isSecretConversation ? `${audioFile.name}.enc` : audioFile.name)
      if (audioFile.name) form.append('originalFileName', audioFile.name)

      const url = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/upload')
        try {
          const token = useAppStore.getState().session?.accessToken
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        } catch {}
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100)
            setAttachProgress(percent)
          }
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const resp = JSON.parse(xhr.responseText)
                resolve(resp.url)
              } catch (err) {
                reject(err)
              }
            } else {
              reject(new Error('upload failed'))
            }
          }
        }
        xhr.send(form)
      })

      const audioAttachmentMeta: Record<string, any> = {
        originalName: audioFile.name,
        mime: audioFile.type || 'audio/webm',
        size: audioFile.size,
      }
      if (encryptedMeta) {
        audioAttachmentMeta.e2ee = encryptedMeta
      }

      const attachment = {
        url,
        type: 'AUDIO' as const,
        size: audioFile.size,
        metadata: audioAttachmentMeta,
      }

      // Send directly (like uploadAndSendAttachments does for attachments)
      await api.post('/conversations/send', {
        conversationId: activeId,
        type: 'AUDIO',
        metadata: { duration },
        attachments: [attachment],
        replyToId: replyTo?.id,
      })

      setReplyTo(null)
      client.invalidateQueries({ queryKey: ['messages', activeId] })
    } catch (error) {
      console.error('Failed to send voice message', error)
      alert('Не удалось отправить голосовое сообщение')
    } finally {
      setAttachUploading(false)
      setAttachProgress(0)
    }
  }

  // Cleanup voice recorder on unmount
  useEffect(() => {
    return () => {
      if (voiceRecorderRef.current) {
        voiceRecorderRef.current.cleanup()
      }
    }
  }, [])

  // ping to eblusha.org (approximate)
  useEffect(() => {
    let timer: number | null = null
    const ping = async () => {
      const start = performance.now()
      try {
        await fetch('https://eblusha.org/', { mode: 'no-cors' })
        setPingMs(Math.round(performance.now() - start))
      } catch {
        setPingMs(null)
      }
    }
    ping()
    timer = window.setInterval(ping, 15000)
    return () => { if (timer) clearInterval(timer) }
  }, [])

  // poll conversations every 20s for status/lastSeen updates
  useEffect(() => {
    let t: number | null = null
    const tick = () => client.invalidateQueries({ queryKey: ['conversations'] })
    t = window.setInterval(tick, 20000)
    return () => { if (t) clearInterval(t) }
  }, [client])

  // Users participating in active *group* calls (for labeling IN_CALL as "В БЕСЕДЕ" vs "В ЗВОНКЕ").
  const groupCallParticipantIds = useMemo(() => {
    const set = new Set<string>()
    try {
      const rows = (conversationsQuery.data || []) as any[]
      const convById = new Map<string, any>()
      for (const row of rows) {
        const conv = row?.conversation
        if (conv?.id) convById.set(conv.id, conv)
      }
      for (const [cid, entry] of Object.entries(activeCalls || {})) {
        if (!entry?.active) continue
        const conv = convById.get(cid)
        const isGroup = !!(conv && (conv.isGroup || (conv.participants?.length ?? 0) > 2))
        if (!isGroup) continue
        const parts = entry.participants || []
        for (const uid of parts) set.add(uid)
      }
    } catch {
      // ignore
    }
    return set
  }, [activeCalls, conversationsQuery.data])

  function formatPresence(u: any): string {
    const status = (u?.id ? effectiveUserStatus(u) : ((u?.status as string | undefined) ?? 'OFFLINE')) as string | undefined
    const uid = typeof u?.id === 'string' ? u.id : null
    const playing = uid ? presenceGameByUserId[uid]?.game : undefined
    const last = u.lastSeenAt ? new Date(u.lastSeenAt) : null
    if (playing?.name && status === 'IN_CALL') return `В ЗВОНКЕ И В ${playing.name}`
    if (playing?.name && (status === 'ONLINE' || status === 'BACKGROUND')) return `Играет в ${playing.name}`
    if (status === 'ONLINE') return 'ОНЛАЙН'
    if (status === 'BACKGROUND') return 'В ФОНЕ'
    if (status === 'IN_CALL') {
      if (uid && groupCallParticipantIds.has(uid)) return 'В БЕСЕДЕ'
      return 'В ЗВОНКЕ'
    }
    if (!last) return 'оффлайн'
    const now = new Date()
    const diffMs = now.getTime() - last.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return 'был(а) онлайн только что'
    if (diffMin < 60) return `был(а) онлайн ${diffMin} мин назад`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `был(а) онлайн ${diffH} ч назад`
    const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
    const dateStr = last.toLocaleDateString()
    const timeStr = last.toLocaleTimeString([], opts)
    return `был(а) онлайн ${dateStr} в ${timeStr}`
  }

  type AvatarPresence = 'ONLINE' | 'AWAY' | 'BACKGROUND' | 'OFFLINE' | 'IN_CALL' | 'PLAYING'
  const avatarPresenceForUser = useCallback((u: any): AvatarPresence => {
    const uid = typeof u?.id === 'string' ? u.id : null
    const base = effectiveUserStatus(u)
    const playing = uid ? presenceGameByUserId[uid]?.game : undefined
    // If we have game presence (TTL-backed), prefer showing PLAYING regardless of base presence.
    // This allows rendering the gamepad even when the base status is briefly stale/offline.
    if (playing?.name) return 'PLAYING'
    return base
  }, [effectiveUserStatus, presenceGameByUserId])

  const avatarPresenceForUserIdAndStatus = useCallback((userId: string | null, status: any): AvatarPresence => {
    const raw = (status ?? 'OFFLINE').toString().toUpperCase()
    const base: AvatarPresence =
      raw === 'IN_CALL' ? 'IN_CALL'
      : raw === 'ONLINE' ? 'ONLINE'
      : raw === 'BACKGROUND' ? 'BACKGROUND'
      : raw === 'AWAY' ? 'AWAY'
      : 'OFFLINE'
    const playing = userId ? presenceGameByUserId[userId]?.game : undefined
    if (playing?.name) return 'PLAYING'
    return base
  }, [presenceGameByUserId])

  function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000))
    const hours = Math.floor(totalSec / 3600)
    const minutes = Math.floor((totalSec % 3600) / 60)
    const seconds = totalSec % 60
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }

  function renderConversationList(mobile: boolean) {
    const className = mobile ? 'conversations-list slider-panel' : 'conversations-list'
    return (
      <aside className={className}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
            <div className="logo">
              <span>Е</span>
              <span className="b">Б</span>
              <span>луша</span>
            </div>
            <div className="subtitle">Здесь мы общаемся</div>
          </div>
        </header>
        <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            ref={convScrollRef}
            className="conversations-scroll-container"
            style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, overflow: 'auto', paddingTop: '10px' }}
          >
          {conversationsQuery.data?.slice().sort((a: any, b: any) => {
            const la = a.conversation.messages?.[0]?.createdAt ? new Date(a.conversation.messages[0].createdAt).getTime() : 0
            const lb = b.conversation.messages?.[0]?.createdAt ? new Date(b.conversation.messages[0].createdAt).getTime() : 0
            return lb - la
          }).filter((row: any) => {
            const conv = row.conversation
            if (conv.isSecret && (conv.secretStatus ?? 'ACTIVE') !== 'ACTIVE') {
              return false
            }
            return true
          }).map((row: any) => {
            const c = row.conversation
            const othersArr = c.participants
              .filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true))
              .map((p: any) => p.user)
            const fallbackName = othersArr.map((u: any) => u.displayName ?? u.username).join(', ') || 'Диалог'
            const title = c.title ?? fallbackName
            const isGroup = c.isGroup || c.participants.length > 2
            const isSecret = !!c.isSecret
            const participantsText = othersArr.map((u: any) => u.displayName ?? u.username).join(', ')
            const isActive = activeId === c.id
            const callEntry = activeCalls[c.id]
            const isCallActive = !!callEntry?.active
            const isCallActiveByState =
              isCallActive ||
              callConvId === c.id ||
              minimizedCallConvId === c.id ||
              outgoingCall?.conversationId === c.id ||
              callStore.activeConvId === c.id
            const isConnectedToCall = callConvId === c.id
            return (
              <div
                key={c.id}
                onContextMenu={(e) => {
                  // Desktop: open the same conversation menu as right-click.
                  // Mobile: disable long-press context menu entirely (we provide the "⋯" button instead).
                  e.preventDefault()
                  e.stopPropagation()
                  if (mobile) return
                  setConvMenu({ open: true, x: e.clientX, y: e.clientY, conversationId: c.id })
                }}
                onClick={() => selectConversation(c.id)}
                className="tile"
                style={{
                  ...(row.unreadCount > 0 ? { borderColor: 'var(--brand-600)', boxShadow: '0 3px 10px rgba(227,139,10,0.15)' } : {}),
                  ...(isActive ? { borderColor: 'var(--brand-600)', boxShadow: '0 4px 12px rgba(227,139,10,0.14)' } : {}),
                  ...(isCallActive
                    ? {
                        background: isConnectedToCall
                          ? 'linear-gradient(135deg, rgba(217, 119, 6, 0.15) 0%, rgba(227, 139, 10, 0.2) 100%)'
                          : 'linear-gradient(135deg, rgba(217, 119, 6, 0.10) 0%, rgba(227, 139, 10, 0.12) 100%)',
                        borderColor: 'var(--brand-600)',
                        ...(isConnectedToCall
                          ? isActive
                            ? {}
                            : { boxShadow: '0 0 0 1px rgba(227,139,10,0.22), 0 6px 16px rgba(227,139,10,0.14)' }
                          : isActive
                            ? {}
                            : { boxShadow: '0 0 0 1px rgba(227,139,10,0.16)' }),
                      }
                    : {}),
                }}
              >
                {isGroup ? (
                  (() => {
                    return (
                      <Avatar 
                        name={title?.trim()?.charAt(0) || 'Г'} 
                        id={c.id} 
                        avatarUrl={c.avatarUrl && c.avatarUrl.trim() ? c.avatarUrl : undefined}
                        presence={isCallActive ? 'IN_CALL' : undefined}
                        inCall={isCallActiveByState}
                      />
                    )
                  })()
                ) : (
                  (() => {
                    const peerUser = othersArr[0]
                    const peerInCallByPresence = peerUser ? effectiveUserStatus(peerUser) === 'IN_CALL' : false
                    return (
                      <Avatar
                        name={peerUser?.displayName ?? peerUser?.username ?? 'D'}
                        id={peerUser?.id ?? c.id}
                        presence={avatarPresenceForUser(peerUser)}
                        inCall={peerInCallByPresence || isCallActiveByState}
                        avatarUrl={peerUser?.avatarUrl && peerUser.avatarUrl.trim() ? peerUser.avatarUrl : undefined}
                      />
                    )
                  })()
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{title}</span>
                    {!isGroup && isSecret && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 18,
                          height: 18,
                          borderRadius: 999,
                          background: 'rgba(34,197,94,0.12)',
                        }}
                      >
                        <Lock size={12} color="#22c55e" />
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: row.unreadCount > 0 ? 'var(--brand-600)' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {row.unreadCount > 0
                      ? `${row.unreadCount} непрочитанных`
                      : (() => {
                            const entry = activeCalls[c.id]
                            const peer = othersArr[0]
                            const uid = typeof peer?.id === 'string' ? peer.id : null
                            const g = uid ? presenceGameByUserId[uid]?.game : undefined
                            const base = peer ? effectiveUserStatus(peer) : 'OFFLINE'
                            const gameSuffix = g?.name ? ` И В ${g.name}` : ''

                            // Call may be active in this conversation, but duration should be shown
                            // ONLY to actual call participants (confidential).
                            const myId = me?.id
                            const isParticipantByServer =
                              !!(myId && entry?.active && Array.isArray(entry.participants) && entry.participants.includes(myId))
                            const isParticipantByLocalState =
                              callConvId === c.id ||
                              minimizedCallConvId === c.id ||
                              outgoingCall?.conversationId === c.id ||
                              callStore.activeConvId === c.id
                            const isParticipant = isParticipantByServer || isParticipantByLocalState
                            const isCallOngoing = !!entry?.active || isParticipant

                            if (isParticipant) {
                              // Use startedAt from entry or outgoingCall as a fallback.
                              const startedAt =
                                (typeof entry?.startedAt === 'number' && entry.startedAt > 0)
                                  ? entry.startedAt
                                  : (outgoingCall && outgoingCall.conversationId === c.id ? outgoingCall.startedAt : null)
                              const elapsedMs = startedAt ? (Date.now() - startedAt) : (typeof entry?.elapsedMs === 'number' ? entry.elapsedMs : 0)
                              return <span>В ЗВОНКЕ: {formatDuration(elapsedMs)}{gameSuffix}</span>
                            }

                            if (isCallOngoing) {
                              // Not a participant: do NOT show duration.
                              if (g?.name) return <span>В ЗВОНКЕ{gameSuffix}</span>
                              return <span>В ЗВОНКЕ</span>
                            }

                            if (entry && entry.endedAt) {
                            // Звонок завершен
                            const endedAt = entry.endedAt
                            const now = Date.now()
                            const diffMs = now - endedAt
                            const diffMin = Math.floor(diffMs / 60000)
                            if (diffMin < 1) return <span>Завершен только что</span>
                            if (diffMin < 60) return <span>Завершен {diffMin} мин назад</span>
                            const diffH = Math.floor(diffMin / 60)
                            if (diffH < 24) return <span>Завершен {diffH} ч назад</span>
                            const endedDate = new Date(endedAt)
                            const dateStr = endedDate.toLocaleDateString()
                            const timeStr = endedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            return <span>Завершен {dateStr} в {timeStr}</span>
                            }
                          // Для групповых бесед показываем null, для личных - статус
                          return isGroup ? null : formatPresence(othersArr[0] ?? {})
                        })()}
                  </div>
                </div>
                {mobile && (
                  <button
                    type="button"
                    aria-label="Меню беседы"
                    title="Меню"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setConvMenu({
                        open: true,
                        x: Math.round(rect.right - 8),
                        y: Math.round(rect.bottom + 6),
                        conversationId: c.id,
                      })
                    }}
                    style={{
                      flexShrink: 0,
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      border: '1px solid transparent',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginLeft: 8,
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    <MoreVertical size={20} />
                  </button>
                )}
              </div>
            )
          })}
          </div>
          {convHasTopFade && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: '24px',
                background: 'linear-gradient(to bottom, var(--surface-200) 0%, rgba(35, 39, 49, 0) 100%)',
                pointerEvents: 'none',
                zIndex: 10,
              }}
            />
          )}
          {convHasBottomFade && (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: '24px',
                background: 'linear-gradient(to top, var(--surface-200) 0%, rgba(35, 39, 49, 0) 100%)',
                pointerEvents: 'none',
                zIndex: 10,
              }}
            />
          )}
        </div>
        <div className="conv-footer">
          <div style={{ borderTop: '1px solid var(--surface-border)', marginTop: 8, marginBottom: 8 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <div onClick={() => setNewGroupOpen(true)} className="tile" style={{ marginTop: 0, flex: 1 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#10b981', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <PlusCircle size={22} />
            </div>
            <div>
                  <div style={{ fontWeight: 600 }}>Беседа</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Групповой чат</div>
            </div>
          </div>
              <div onClick={openContactsOverlay} className="tile" style={{ marginTop: 0, flex: 1 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#6366f1', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {incomingContactsQuery.data && incomingContactsQuery.data.length > 0 ? (
                <BellRing size={22} />
              ) : (contactsQuery.data && contactsQuery.data.length > 0 ? <Users size={22} /> : <UserPlus size={22} />)}
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>Контакты</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {incomingContactsQuery.data && incomingContactsQuery.data.length > 0
                  ? 'Новый запрос в друзья'
                  : (contactsQuery.data && contactsQuery.data.length > 0 ? 'Список контактов' : 'Добавить контакт')}
              </div>
            </div>
          </div>
            </div>
            <div className="tile" onClick={() => setMePopupOpen(true)} style={{ cursor: 'pointer', marginTop: 0 }}>
            {(() => {
              // Force red presence while we are participating in ANY call type (1:1 or group),
              // even if server presence lags behind.
              const isMeInAnyCall = (() => {
                const myId = me?.id
                if (outgoingCall?.conversationId) return true
                if (callConvId) return true
                if (minimizedCallConvId) return true
                if (callStore.activeConvId) return true
                if (myId) {
                  try {
                    for (const entry of Object.values(activeCalls || {})) {
                      if (entry?.active && Array.isArray(entry.participants) && entry.participants.includes(myId)) {
                        return true
                      }
                    }
                  } catch {
                    // ignore
                  }
                }
                return false
              })()

              const directStatus = isMeInAnyCall ? 'IN_CALL' : (myPresence ?? (meInfoQuery.data as any)?.status)
              const fallbackStatus = isSocketOnline ? 'ONLINE' : 'OFFLINE'
              const normalized = (directStatus ?? fallbackStatus ?? 'OFFLINE').toString().toUpperCase()
              const allowedPresence = ['ONLINE', 'AWAY', 'BACKGROUND', 'IN_CALL', 'OFFLINE'] as const
              type KnownPresence = (typeof allowedPresence)[number]
              const normalizedPresence = normalized as KnownPresence
              const fallbackPresence = fallbackStatus as KnownPresence
              const presenceValue: KnownPresence = allowedPresence.includes(normalizedPresence) ? normalizedPresence : fallbackPresence
              const myId = me?.id
              const myGame = myId ? presenceGameByUserId[myId]?.game : undefined
              const presenceWithGame: any =
                myGame?.name && (presenceValue === 'ONLINE' || presenceValue === 'BACKGROUND' || presenceValue === 'IN_CALL')
                  ? 'PLAYING'
                  : presenceValue
              const avatarUrl = (meInfoQuery.data as any)?.avatarUrl ?? me?.avatarUrl ?? undefined
              return (
                <Avatar
                  name={me?.displayName ?? me?.username ?? 'Me'}
                  id={me?.id ?? 'me'}
                  presence={presenceWithGame}
                  inCall={isMeInAnyCall}
                  avatarUrl={avatarUrl}
                />
              )
            })()}
            <div>
              <div style={{ fontWeight: 700 }}>{me?.displayName ?? me?.username ?? 'Я'}</div>
              {(() => {
                const myId = me?.id
                const g = myId ? presenceGameByUserId[myId]?.game : undefined
                if (g?.name) {
                  return (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>Играю в {g.name}</span>
                    </div>
                  )
                }
                return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>EBLID: {meInfoQuery.data?.eblid ?? '— — — —'}</div>
              })()}
              </div>
            </div>
          </div>
        </div>
      </aside>
    )
  }

  function renderMessagesPane(mobile: boolean) {
    const sectionClass = mobile ? 'messages-pane slider-panel' : 'messages-pane'
    const secretInactive = conversationSecretInactive
    const secretSessionReady = conversationSecretSessionReady
    let secretBlockedText = ''
    if (activeConversation?.isSecret) {
      if (secretInactive) {
        secretBlockedText = 'Секретный чат станет доступен после подтверждения собеседника.'
      } else if (secretBlockedByOtherDevice) {
        secretBlockedText = connectedDeviceName
          ? `Секретный чат подключён на устройстве «${connectedDeviceName}»`
          : 'Секретный чат подключён на другом устройстве.'
      } else if (!secretSessionReady) {
        secretBlockedText = 'Готовим защищённое подключение...'
      }
    }
    return (
      <section className={sectionClass}>
        <header
          style={{
            ...(() => {
              if (!activeId) return {}
              const callEntry = activeCalls[activeId]
              const isActive = callEntry?.active
              const isMinimized = minimizedCallConvId === activeId
              // Подсвечиваем шапку если звонок активен ИЛИ минимизирован (для всех типов звонков)
              if (isActive || isMinimized) {
                return {
                  background: 'linear-gradient(135deg, rgba(217, 119, 6, 0.15) 0%, rgba(227, 139, 10, 0.2) 100%)',
                  borderBottom: '2px solid var(--brand)',
                }
              }
              return {}
            })(),
            display: isMobile ? 'flex' : 'grid',
            // True centering: equal side columns so the image stays centered.
            gridTemplateColumns: isMobile ? undefined : 'minmax(0, 1fr) auto minmax(0, 1fr)',
            // Match spacing between call control buttons (gap: 8)
            columnGap: isMobile ? undefined : 8,
            flexDirection: isMobile ? 'column' : undefined,
            justifyContent: isMobile ? 'flex-start' : undefined,
            justifyItems: isMobile ? undefined : 'stretch',
            alignItems: isMobile ? 'stretch' : 'center',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minWidth: 0,
              width: isMobile ? '100%' : 'auto',
              padding: isMobile ? '0 8px' : '0',
              gridColumn: isMobile ? undefined : '1 / 2',
            }}
          >
            {mobile && (
              <button className="btn btn-icon btn-ghost" onClick={backToList}>
                <ArrowLeft size={18} />
              </button>
            )}
            {activeConversation ? (
              (() => {
                const othersArr = activeConversation.participants.filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true)).map((p: any) => p.user)
                const fallbackName = othersArr.map((u: any) => u.displayName ?? u.username).join(', ') || 'Диалог'
                const title = activeConversation.title ?? fallbackName
                const isGroup = activeConversation.isGroup || activeConversation.participants.length > 2
                const isSecret = !!activeConversation.isSecret && !isGroup
                const callEntry = activeCalls[activeConversation.id]
                const isActive = callEntry?.active
                return isGroup ? (
                  <>
                    <div onClick={() => setGroupAvatarEditor(true)} style={{ cursor: 'pointer' }}>
                      <Avatar 
                        name={title?.trim()?.charAt(0) || 'Г'} 
                        id={activeConversation.id} 
                        size={60} 
                        avatarUrl={activeConversation.avatarUrl && activeConversation.avatarUrl.trim() ? activeConversation.avatarUrl : undefined}
                        presence={isActive ? 'IN_CALL' : undefined}
                        inCall={!!isActive}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0, order: isMobile ? 1 : 2 }}>
                      <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                        <span>{title}</span>
                        {isMobile && (
                          <button
                            className="btn btn-icon btn-ghost"
                            title="Меню"
                            onClick={(e) => {
                              setHeaderMenu({ open: true, anchor: e.currentTarget })
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 42,
                              height: 42,
                              minWidth: 42,
                              padding: 0,
                              margin: 0,
                              borderRadius: 999,
                              flexShrink: 0,
                            }}
                          >
                            <MoreVertical size={20} />
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {isActive ? (
                          <>
                            {(() => {
                              const participants = callEntry.participants || []
                              const allParticipants = activeConversation.participants || []
                              // Используем elapsedMs с сервера и добавляем локальный тик для плавного обновления между событиями
                              // Re-render each second via timerTick, compute from startedAt to avoid double counting
                              const elapsedMs = callEntry.startedAt ? (Date.now() - callEntry.startedAt) : (typeof callEntry.elapsedMs === 'number' ? callEntry.elapsedMs : 0)
                              return (
                                <>
                                  {callEntry.active && <span>{formatDuration(elapsedMs)}</span>}
                                  {allParticipants.length > 0 && (
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                      {callEntry.startedAt && ' • '}
                                      {allParticipants.map((p: any, idx: number) => {
                                        const u = p.user
                                        const isInCall = participants.length > 0 && participants.includes(u.id)
                                        return (
                                          <span key={u.id} style={{ fontWeight: isInCall ? 700 : 400, color: isInCall ? 'var(--brand-600)' : 'var(--text-muted)' }}>
                                            {idx > 0 && ', '}
                                            {u.displayName ?? u.username}
                                            {isInCall && ' ✓'}
                                          </span>
                                        )
                                      })}
                                    </span>
                                  )}
                                </>
                              )
                            })()}
                          </>
                        ) : callEntry && callEntry.endedAt ? (
                          (() => {
                            // Звонок завершен
                            const endedAt = callEntry.endedAt
                            const now = Date.now()
                            const diffMs = now - endedAt
                            const diffMin = Math.floor(diffMs / 60000)
                            let timeText = ''
                            if (diffMin < 1) timeText = 'Завершен только что'
                            else if (diffMin < 60) timeText = `Завершен ${diffMin} мин назад`
                            else {
                              const diffH = Math.floor(diffMin / 60)
                              if (diffH < 24) timeText = `Завершен ${diffH} ч назад`
                              else {
                                const endedDate = new Date(endedAt)
                                const dateStr = endedDate.toLocaleDateString()
                                const timeStr = endedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                timeText = `Завершен ${dateStr} в ${timeStr}`
                              }
                            }
                            const allParticipants = activeConversation.participants || []
                            return (
                              <>
                                <span>{timeText}</span>
                                {allParticipants.length > 0 && (
                                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    {' • '}
                                    {allParticipants.map((p: any, idx: number) => {
                                      const u = p.user
                                      return (
                                        <span key={u.id}>
                                          {idx > 0 && ', '}
                                          {u.displayName ?? u.username}
                                        </span>
                                      )
                                    })}
                                  </span>
                                )}
                              </>
                            )
                          })()
                        ) : (
                          othersArr.map((u: any) => u.displayName ?? u.username).join(', ')
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  (() => {
                    const peer: any = othersArr[0]
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                        <div style={{ marginRight: 10 }}>
                          <Avatar
                            name={peer?.displayName ?? peer?.username ?? 'D'}
                            id={peer?.id ?? activeConversation.id}
                            avatarUrl={peer?.avatarUrl && peer.avatarUrl.trim() ? peer.avatarUrl : undefined}
                            presence={avatarPresenceForUser(peer)}
                              inCall={effectiveUserStatus(peer) === 'IN_CALL' || !!callEntry?.active || minimizedCallConvId === activeId}
                            size={60}
                          />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                            {isMobile && (
                              <button
                                className="btn btn-icon btn-ghost"
                                title="Меню"
                                onClick={(e) => {
                                  setHeaderMenu({ open: true, anchor: e.currentTarget })
                                }}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: 42,
                                  height: 42,
                                  minWidth: 42,
                                  padding: 0,
                                  margin: 0,
                                  borderRadius: 999,
                                  flexShrink: 0,
                                }}
                              >
                                <MoreVertical size={20} />
                              </button>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: 'var(--text-muted)',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-start',
                              gap: 2,
                              lineHeight: 1.15,
                            }}
                          >
                            {(() => {
                              const isMinimized = minimizedCallConvId === activeId

                              // Если звонок завершен (и не минимизирован), показываем время завершения
                              if (callEntry && callEntry.endedAt && !isMinimized) {
                                const endedAt = callEntry.endedAt
                                const now = Date.now()
                                const diffMs = now - endedAt
                                const diffMin = Math.floor(diffMs / 60000)
                                if (diffMin < 1) return <span>Завершен только что</span>
                                if (diffMin < 60) return <span>Завершен {diffMin} мин назад</span>
                                const diffH = Math.floor(diffMin / 60)
                                if (diffH < 24) return <span>Завершен {diffH} ч назад</span>
                                const endedDate = new Date(endedAt)
                                const dateStr = endedDate.toLocaleDateString()
                                const timeStr = endedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                return <span>Завершен {dateStr} в {timeStr}</span>
                              }

                              // Если звонок минимизирован или активен — показываем статус звонка (с длительностью только участникам)
                              if ((callEntry?.active || isMinimized) && callEntry) {
                                const uid = typeof peer?.id === 'string' ? peer.id : null
                                const g = uid ? presenceGameByUserId[uid]?.game : undefined
                                const myId = me?.id
                                const isParticipantByServer =
                                  !!(myId && callEntry?.active && Array.isArray(callEntry.participants) && callEntry.participants.includes(myId))
                                const isParticipantByLocalState =
                                  callConvId === activeId ||
                                  minimizedCallConvId === activeId ||
                                  outgoingCall?.conversationId === activeId ||
                                  callStore.activeConvId === activeId
                                const isParticipant = isParticipantByServer || isParticipantByLocalState
                                const elapsedMs = isParticipant
                                  ? (callEntry.startedAt ? (Date.now() - callEntry.startedAt) : (typeof callEntry.elapsedMs === 'number' ? callEntry.elapsedMs : 0))
                                  : null

                                return (
                                  <>
                                    <span>{elapsedMs != null ? `В ЗВОНКЕ: ${formatDuration(elapsedMs)}` : 'В ЗВОНКЕ'}</span>
                                    {g?.name ? (
                                      <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                                        ИГРАЕТ В {g.name}
                                      </span>
                                    ) : null}
                                  </>
                                )
                              }

                              // Иначе показываем статус пользователя (в две строки, если в игре)
                              if (!peer) return ''
                              const uid = typeof peer?.id === 'string' ? peer.id : null
                              const base = effectiveUserStatus(peer)
                              const g = uid ? presenceGameByUserId[uid]?.game : undefined

                              if (g?.name && base === 'IN_CALL') {
                                return (
                                  <>
                                    <span>В ЗВОНКЕ</span>
                                    <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                                      ИГРАЕТ В {g.name}
                                    </span>
                                  </>
                                )
                              }
                              if (g?.name && (base === 'ONLINE' || base === 'BACKGROUND' || base === 'IN_CALL')) {
                                return (
                                  <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                                    ИГРАЕТ В {g.name}
                                  </span>
                                )
                              }
                              return <span>{formatPresence(peer)}</span>
                            })()}
                          </div>
                        </div>
                      </div>
                    )
                  })()
                )
              })()
            ) : (
              <div>Выберите чат</div>
            )}
        </div>
          {/* Center game image (no bubble) */}
          {activeConversation && (() => {
            if (isMobile) return null
            const isGroup = !!(activeConversation.isGroup || (activeConversation.participants?.length ?? 0) > 2)
            if (isGroup) return null
            const othersArr = activeConversation.participants
              .filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true))
              .map((p: any) => p.user)
            const peer: any = othersArr[0]
            const uid = typeof peer?.id === 'string' ? peer.id : null
            const baseStatus = peer ? effectiveUserStatus(peer) : 'OFFLINE'
            const playing = uid ? presenceGameByUserId[uid]?.game : undefined
            if (!playing?.name || !(baseStatus === 'ONLINE' || baseStatus === 'BACKGROUND' || baseStatus === 'IN_CALL')) return null
            const steamAppIdRaw = playing?.steamAppId
            const steamAppId =
              typeof steamAppIdRaw === 'number'
                ? (Number.isFinite(steamAppIdRaw) ? String(steamAppIdRaw) : null)
                : (typeof steamAppIdRaw === 'string' && steamAppIdRaw.trim() ? steamAppIdRaw.trim() : null)
            const steamUrl = steamAppId ? `https://store.steampowered.com/app/${encodeURIComponent(steamAppId)}/` : null

            return (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 14px',
                  gridColumn: '2 / 3',
                  justifySelf: 'center',
                  pointerEvents: 'auto',
                }}
              >
                {playing.imageUrl ? (
                  <div
                    title={
                      steamUrl
                        ? `Открыть в Steam: ${playing?.name ? playing.name : ''}`.trim()
                        : `Играет в ${playing.name}`
                    }
                    onClick={() => {
                      if (!steamUrl) return
                      try { window.open(steamUrl, '_blank', 'noopener,noreferrer') } catch {}
                    }}
                    style={{
                      cursor: steamUrl ? 'pointer' : 'default',
                      userSelect: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 0,
                      maxWidth: '100%',
                      flexShrink: 0,
                    }}
                  >
                    <img
                      src={playing.imageUrl}
                      alt=""
                      style={{
                        height: 60,
                        maxHeight: 60,
                        width: 'auto',
                        // Keep it large, but allow shrinking to prevent overflow.
                        maxWidth: '100%',
                        // Light rounding like buttons.
                        borderRadius: 10,
                        objectFit: 'contain',
                        display: 'block',
                        flexShrink: 0,
                      }}
                    />
                  </div>
                ) : (
                  <div style={{ minWidth: 0, maxWidth: 320, lineHeight: 1.1 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{baseStatus === 'IN_CALL' ? 'В звонке' : 'Играет'}</div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 650,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {playing.name}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
          {endSecretModalOpen &&
            activeConversation &&
            !!activeConversation.isSecret &&
            (activeConversation.participants?.length ?? 0) <= 2 &&
            typeof document !== 'undefined' &&
            createPortal(
              <div
                style={{
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(10,12,16,0.6)',
                  backdropFilter: 'blur(4px) saturate(110%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: isMobile ? '0 16px' : 0,
                  boxSizing: 'border-box',
                  zIndex: 80,
                }}
                onClick={() => setEndSecretModalOpen(false)}
              >
                <div
                  style={{
                    background: 'var(--surface-200)',
                    padding: isMobile ? 16 : 20,
                    borderRadius: isMobile ? 20 : 16,
                    width: '100%',
                    maxWidth: 420,
                    border: '1px solid var(--surface-border)',
                    boxShadow: 'var(--shadow-medium)',
                    color: 'var(--text-primary)',
                    textAlign: isMobile ? 'center' : 'left',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 12,
                      flexDirection: isMobile ? 'column' : 'row',
                      gap: isMobile ? 8 : 0,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 18, width: '100%' }}>Завершить секретный чат?</div>
                    <button
                      className="btn btn-icon btn-ghost"
                      onClick={() => setEndSecretModalOpen(false)}
                      style={{ alignSelf: isMobile ? 'flex-end' : undefined }}
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
                    Сообщения этого секретного чата будут удалены у всех участников. Это действие необратимо.
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: isMobile ? 'center' : 'flex-end',
                      alignItems: 'center',
                      flexDirection: isMobile ? 'column' : 'row',
                      gap: isMobile ? 12 : 8,
                    }}
                  >
                    <button
                      className="btn btn-ghost"
                      onClick={() => setEndSecretModalOpen(false)}
                      style={isMobile ? { width: '100%' } : undefined}
                    >
                      Отменить
                    </button>
                    <button
                      className="btn btn-primary"
                      style={{
                        background: '#ef4444',
                        borderColor: '#ef4444',
                        width: isMobile ? '100%' : undefined,
                      }}
                      onClick={async () => {
                        if (!activeId) return
                        try {
                          await api.delete(`/conversations/${activeId}`)
                          client.invalidateQueries({ queryKey: ['conversations'] })
                          client.removeQueries({ queryKey: ['messages', activeId] })
                          setEndSecretModalOpen(false)
                          setActiveId(null)
                        } catch (err) {
                          // eslint-disable-next-line no-console
                          console.error('Failed to end secret conversation:', err)
                        }
                      }}
                    >
                      Завершить
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )}
          {activeId && (() => {
                const callEntry = activeCalls[activeId]
                const isActive = callEntry?.active
                const isGroup = activeConversation?.isGroup || (activeConversation?.participants.length ?? 0) > 2
                const othersArr = activeConversation?.participants
                  ?.filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true))
                  .map((p: any) => p.user) ?? []
                const peerUser = othersArr[0]
                const fallbackTimeZone = getFallbackTimeZone()
                const peerTimeZone = (peerUser as any)?.timezone ?? (peerUser as any)?.timeZone ?? fallbackTimeZone
                const peerName = peerUser?.displayName ?? peerUser?.username ?? 'Собеседник'
                const canShowAvailability = !isGroup && !!peerUser?.id
                const hasHeaderGame = (() => {
                  if (isMobile) return false
                  if (isGroup) return false
                  const uid = typeof peerUser?.id === 'string' ? peerUser.id : null
                  if (!uid) return false
                  const base = effectiveUserStatus(peerUser)
                  const g = presenceGameByUserId[uid]?.game
                  return !!(g?.name && (base === 'ONLINE' || base === 'BACKGROUND' || base === 'IN_CALL'))
                })()
                // Show text labels on wide screens; icons-only on narrow desktop.
                // If no game info in header, keep labels (there's space).
                const compactButtons = !isMobile && isNarrowHeaderButtons && hasHeaderGame
                const handleOpenAvailability = () => {
                  if (!activeConversation || !peerUser?.id) return
                  setAvailabilityContext({
                    conversationId: activeConversation.id,
                    peerId: peerUser.id,
                    peerName,
                    peerTimeZone,
                  })
                }
                const isMinimized = minimizedCallConvId === activeId
                // Оверлей открыт, только если callConvId установлен И не минимизирован
                const isOverlayOpen = callConvId === activeId && !isMinimized
                // Участие в звонке
                const myId = me?.id
                // Для групповых: звонок активен И есть в participants
                const isParticipatingInGroup = isGroup && isActive && myId && callEntry?.participants?.includes(myId)
                // Для 1:1: участвуем если минимизирован, или callConvId установлен (означает что начали/приняли звонок),
                // или есть активный звонок в store, или звонок активен и есть связь
                const isParticipatingInDialog = !isGroup && (
                  isMinimized || // Если минимизирован - точно участвуем
                  callConvId === activeId || // Если оверлей был открыт/открыт - участвуем
                  callStore.activeConvId === activeId || // Если есть активный звонок в store - участвуем
                  (isActive && (callStore.activeConvId === activeId || callConvId === activeId)) // Звонок активен и есть связь
                )
                const isParticipating = isParticipatingInGroup || isParticipatingInDialog
                // Показываем кнопку "Развернуть" если участвуем и оверлей не открыт (минимизирован или не развернут)
                // Кнопки управления показываются постоянно, пока пользователь участвует в звонке
                const shouldShowExpand = isParticipating && !isOverlayOpen
                const buttonBaseStyle = {
                  display: 'flex' as const,
                  alignItems: 'center' as const,
                  justifyContent: 'center' as const,
                  gap: compactButtons ? 0 : 6,
                  padding: isMobile ? '8px 12px' : (!compactButtons ? '12px 16px' : '10px'),
                  flex: isMobile ? 1 : 'auto' as const,
                  minWidth: isMobile ? 0 : (!compactButtons ? 'auto' : 44 as any),
                  width: compactButtons ? 44 : undefined,
                  fontSize: isMobile ? '14px' : '15px',
                  fontWeight: isMobile ? 500 : 600,
                  height: isMobile ? '42px' : '46px',
                  minHeight: isMobile ? '42px' : '46px',
                  boxSizing: 'border-box' as const
                }

                const headerStyle = {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: isMobile ? '100%' : 'auto',
                  padding: isMobile ? '0 8px' : '0',
                  justifyContent: isMobile ? 'center' : 'flex-end',
                  marginLeft: isMobile ? 0 : 0,
                  // Desktop header uses 3-column grid; controls live in the right column.
                  gridColumn: isMobile ? undefined : '3 / 4',
                  justifySelf: isMobile ? undefined : 'end',
                }
                
                const menuButtonStyle = {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: isMobile ? 42 : 44,
                  height: isMobile ? 42 : 44,
                  minWidth: isMobile ? 42 : 44,
                  padding: 0,
                  margin: 0,
                  borderRadius: 999,
                }

                const handleStartCall = async () => {
                  if (!activeId) return
                  if (!(await requireMediaAccess(false))) return
                  try {
                    beginOutgoingCallGuard(activeId)
                    inviteCall(activeId, false)
                    callStore.startOutgoing(activeId, false)
                    setActiveCalls((prev) => {
                      const current = prev[activeId]
                      const myId = me?.id
                      if (!current?.active) {
                        return { ...prev, [activeId]: { startedAt: Date.now(), active: true, endedAt: null, participants: myId ? [myId] : [] } }
                      }
                      if (myId && current.participants && !current.participants.includes(myId)) {
                        return { ...prev, [activeId]: { ...current, participants: [...current.participants, myId] } }
                      }
                      return prev
                    })
                    // Проверяем, является ли беседа групповой
                    const conv = conversationsQuery.data?.find((r: any) => r.conversation.id === activeId)?.conversation
                    const isGroup = conv?.isGroup || (conv?.participants?.length ?? 0) > 2
                    if (isGroup) {
                      // Для групповых бесед сразу открываем оверлей, без экрана дозвона
                      setCallConvId(activeId)
                      setMinimizedCallConvId((prev) => (prev === activeId ? null : prev))
                    } else {
                      // Для 1:1 бесед показываем экран дозвона
                      const convId = activeId
                      setOutgoingCall({ conversationId: convId, startedAt: Date.now(), video: false })
                      // Запускаем звук дозвона
                      startDialingSound()
                      // Автоматически закрываем через 30 секунд, если звонок не принят
                      if (outgoingCallTimerRef.current) {
                        window.clearTimeout(outgoingCallTimerRef.current)
                      }
                      outgoingCallTimerRef.current = window.setTimeout(() => {
                        setOutgoingCall((prev) => {
                          if (prev?.conversationId === convId) {
                            stopDialingSound()
                            playEndCallSound()
                            endCall(convId)
                            setActiveCalls((prevCalls) => {
                              const current = prevCalls[convId]
                              if (current?.active) {
                                return { ...prevCalls, [convId]: { ...current, active: false, endedAt: Date.now() } }
                              }
                              const { [convId]: _omit, ...rest } = prevCalls
                              return rest
                            })
                            callStore.endCall()
                            return null
                          }
                          return prev
                        })
                        outgoingCallTimerRef.current = null
                      }, 30000)
                    }
                  } catch (err) {
                    console.error('Error starting call:', err)
                  }
                }

                const handleStartVideoCall = async () => {
                  if (!activeId) return
                  if (!(await requireMediaAccess(true))) return
                  try {
                    beginOutgoingCallGuard(activeId)
                    inviteCall(activeId, true)
                    callStore.startOutgoing(activeId, true)
                    setActiveCalls((prev) => {
                      const current = prev[activeId]
                      const myId = me?.id
                      if (!current?.active) {
                        return { ...prev, [activeId]: { startedAt: Date.now(), active: true, endedAt: null, participants: myId ? [myId] : [] } }
                      }
                      if (myId && current.participants && !current.participants.includes(myId)) {
                        return { ...prev, [activeId]: { ...current, participants: [...current.participants, myId] } }
                      }
                      return prev
                    })
                    // Проверяем, является ли беседа групповой
                    const conv = conversationsQuery.data?.find((r: any) => r.conversation.id === activeId)?.conversation
                    const isGroup = conv?.isGroup || (conv?.participants?.length ?? 0) > 2
                    if (isGroup) {
                      // Для групповых бесед сразу открываем оверлей, без экрана дозвона
                      setCallConvId(activeId)
                      setMinimizedCallConvId((prev) => (prev === activeId ? null : prev))
                    } else {
                      // Для 1:1 бесед показываем экран дозвона
                      const convId = activeId
                      setOutgoingCall({ conversationId: convId, startedAt: Date.now(), video: true })
                      // Запускаем звук дозвона
                      startDialingSound()
                      // Автоматически закрываем через 30 секунд, если звонок не принят
                      if (outgoingCallTimerRef.current) {
                        window.clearTimeout(outgoingCallTimerRef.current)
                      }
                      outgoingCallTimerRef.current = window.setTimeout(() => {
                        setOutgoingCall((prev) => {
                          if (prev?.conversationId === convId) {
                            stopDialingSound()
                            playEndCallSound()
                            endCall(convId)
                            setActiveCalls((prevCalls) => {
                              const current = prevCalls[convId]
                              if (current?.active) {
                                return { ...prevCalls, [convId]: { ...current, active: false, endedAt: Date.now() } }
                              }
                              const { [convId]: _omit, ...rest } = prevCalls
                              return rest
                            })
                            callStore.endCall()
                            return null
                          }
                          return prev
                        })
                        outgoingCallTimerRef.current = null
                      }, 30000)
                    }
                  } catch (err) {
                    console.error('Error starting call:', err)
                  }
                }

                const handleExpandCall = () => {
                  if (!activeId) return
                  setCallConvId(activeId)
                  setMinimizedCallConvId(null)
                }

                const renderCallControls = () => {
                  // Если звонок активен ИЛИ минимизирован (минимизированный звонок все еще активен, просто скрыт)
                  if (isActive || isMinimized) {
                    if (!isParticipating) {
                      return (
                        <>
                          <button 
                            className="btn btn-secondary" 
                            title={!isMobile ? 'Подключиться' : undefined}
                            onClick={() => {
                              const isGroupCall = activeConversation?.isGroup || ((activeConversation?.participants?.length ?? 0) > 2)
                              if (isGroupCall) {
                                setCallConvId(activeId!)
                                setMinimizedCallConvId((prev) => (prev === activeId ? null : prev))
                                callStore.startOutgoing(activeId!, false)
                                try { joinCallRoom(activeId!, false) } catch {}
                              } else {
                                // Для 1:1 звонков устанавливаем callConvId и callStore.activeConvId для показа кнопок управления
                                setCallConvId(activeId!)
                                setMinimizedCallConvId((prev) => (prev === activeId ? null : prev))
                                callStore.startOutgoing(activeId!, false)
                              }
                            }}
                            style={buttonBaseStyle}
                          >
                            <Phone size={isMobile ? 16 : 18} />
                            {isMobile ? 'Подключиться' : (compactButtons ? null : ' Подключиться')}
                          </button>
                          <button 
                            className="btn btn-primary" 
                            title={!isMobile ? 'Подключиться с видео' : undefined}
                            onClick={() => {
                              const isGroupCall = activeConversation?.isGroup || ((activeConversation?.participants?.length ?? 0) > 2)
                              if (isGroupCall) {
                                setCallConvId(activeId!)
                                setMinimizedCallConvId((prev) => (prev === activeId ? null : prev))
                                callStore.startOutgoing(activeId!, true)
                                try { joinCallRoom(activeId!, true) } catch {}
                              } else {
                                // Для 1:1 звонков устанавливаем callConvId и callStore.activeConvId для показа кнопок управления
                                setCallConvId(activeId!)
                                setMinimizedCallConvId((prev) => (prev === activeId ? null : prev))
                                callStore.startOutgoing(activeId!, true)
                              }
                            }}
                            style={buttonBaseStyle}
                          >
                            <Video size={isMobile ? 16 : 18} />
                            {isMobile ? 'Подключиться с видео' : (compactButtons ? null : ' Подключиться с видео')}
                          </button>
                          {canShowAvailability && (
                            <AvailabilityButton
                              onClick={handleOpenAvailability}
                              style={menuButtonStyle}
                            />
                          )}
                          {!isMobile && (
                            <button
                              className="btn btn-icon btn-ghost"
                              title="Меню"
                              onClick={(e) => {
                                setHeaderMenu({ open: true, anchor: e.currentTarget })
                              }}
                              style={menuButtonStyle}
                            >
                              <MoreVertical size={22} />
                            </button>
                          )}
                        </>
                      )
                    }

                    return (
                      <>
                        {/* Показываем кнопку "Развернуть" если оверлей не открыт (минимизирован или не развернут) */}
                        {!isOverlayOpen && (
                          <button 
                            className="btn btn-secondary"
                            title={!isMobile ? 'Развернуть' : undefined}
                            onClick={handleExpandCall}
                            style={buttonBaseStyle}
                          >
                            <Maximize2 size={isMobile ? 16 : 18} />
                            {isMobile ? 'Развернуть' : (compactButtons ? null : ' Развернуть')}
                          </button>
                        )}
                        {/* Кнопка "Сбросить" показывается всегда, пока пользователь участвует в звонке */}
                        <button 
                          className="btn"
                          title={!isMobile ? 'Сбросить' : undefined}
                          onClick={() => {
                            const count = activeConversation?.participants?.length ?? 0
                            const isDialog = count <= 2
                            const isGroupCall = activeConversation?.isGroup || (count > 2)
                            if (isDialog && callConvId) {
                              endCall(callConvId)
                              setActiveCalls((prev) => {
                                const current = prev[callConvId]
                                if (current?.active) {
                                  return { ...prev, [callConvId]: { ...current, active: false, endedAt: Date.now() } }
                                }
                                return prev
                              })
                            } else if (isGroupCall && callConvId) {
                              try { leaveCallRoom(callConvId) } catch {}
                              setActiveCalls((prev) => {
                                const current = prev[callConvId]
                                if (!current) return prev
                                if (!current.participants) return prev
                                const myId = me?.id
                                if (!myId) return prev
                                if (!current.participants.includes(myId)) return prev
                                return { ...prev, [callConvId]: { ...current, participants: current.participants.filter((id: string) => id !== myId) } }
                              })
                            }
                            setCallConvId(null)
                            setMinimizedCallConvId(null)
                            callStore.endCall()
                            stopRingtone()
                          }}
                          style={{ 
                            ...buttonBaseStyle,
                            background: '#ef4444',
                            color: '#fff'
                          }}
                        >
                          <PhoneOff size={isMobile ? 16 : 18} />
                          {isMobile ? 'Сбросить' : (compactButtons ? null : ' Сбросить')}
                        </button>
                        {canShowAvailability && (
                          <AvailabilityButton
                            onClick={handleOpenAvailability}
                            style={menuButtonStyle}
                          />
                        )}
                        {!isMobile && (
                          <button
                            className="btn btn-icon btn-ghost"
                            title="Меню"
                            onClick={(e) => {
                              setHeaderMenu({ open: true, anchor: e.currentTarget })
                            }}
                            style={menuButtonStyle}
                          >
                            <MoreVertical size={22} />
                          </button>
                        )}
                      </>
                    )
                  }

                  return (
                    <>
                      <button 
                        className="btn btn-secondary" 
                        title={!isMobile ? 'Звонок' : undefined}
                        onClick={() => { void handleStartCall() }}
                        style={buttonBaseStyle}
                      >
                        <Phone size={isMobile ? 16 : 18} />
                        {isMobile ? ' Начать звонок' : (compactButtons ? null : ' Звонок')}
                      </button>
                      <button 
                        className="btn btn-primary" 
                        title={!isMobile ? 'Видео' : undefined}
                        onClick={() => { void handleStartVideoCall() }}
                        style={buttonBaseStyle}
                      >
                        <Video size={isMobile ? 16 : 18} />
                        {isMobile ? ' Начать с видео' : (compactButtons ? null : ' Видео')}
                      </button>
                      {canShowAvailability && (
                        <AvailabilityButton
                          onClick={handleOpenAvailability}
                          style={menuButtonStyle}
                        />
                      )}
                      {!isMobile && (
                        <button
                          className="btn btn-icon btn-ghost"
                          title="Меню"
                          onClick={(e) => {
                            setHeaderMenu({ open: true, anchor: e.currentTarget })
                          }}
                          style={menuButtonStyle}
                        >
                          <MoreVertical size={22} />
                        </button>
                      )}
                    </>
                  )
                }

                return (
                  <>
                    <div style={headerStyle}>
                      {renderCallControls()}
                    </div>
                    {callPermissionError && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: '8px 12px',
                          borderRadius: 10,
                          border: '1px solid var(--surface-border)',
                          background: 'rgba(239,68,68,0.08)',
                          color: '#fca5a5',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          maxWidth: isMobile ? '100%' : 420,
                          width: isMobile ? '100%' : 'auto',
                        }}
                      >
                        <span style={{ flex: 1 }}>{callPermissionError}</span>
                        <button
                          type="button"
                          onClick={() => setCallPermissionError(null)}
                          style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 4 }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                  </>
                )
          })()}
        </header>
        {!activeConversation?.isSecret && pendingSecretContext && (
          <div
            style={{
              margin: '12px 12px 0',
              padding: '12px 16px',
              borderRadius: 12,
              border: '1px solid rgba(20,184,166,0.4)',
              background: 'linear-gradient(135deg, rgba(13,148,136,0.15), rgba(6,95,70,0.25))',
              color: '#ccfbf1',
              display: 'flex',
              flexDirection: isMobile ? 'column' : 'row',
              gap: 12,
              alignItems: isMobile ? 'stretch' : 'center',
            }}
          >
            {pendingSecretContext.isInitiator ? (
              <>
                <div style={{ flex: 1 }}>
                  Ждём подтверждения собеседника, чтобы начать секретный чат.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleDeclinePendingSecret(pendingSecretContext.conversationId)}
                    disabled={secretActionLoading}
                    style={{ color: '#f87171' }}
                  >
                    Отменить
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ flex: 1 }}>
                  {pendingSecretContext.initiatorName} предлагает начать секретный чат на этом устройстве.
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => handleAcceptPendingSecret(pendingSecretContext.conversationId)}
                    disabled={secretActionLoading}
                  >
                    Принять
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleDeclinePendingSecret(pendingSecretContext.conversationId)}
                    disabled={secretActionLoading}
                    style={{ color: '#bae6fd' }}
                  >
                    Отказаться
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <div className="messages-container" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '24px',
            background: 'linear-gradient(to bottom, var(--surface-200) 0%, rgba(35, 39, 49, 0) 100%)',
            pointerEvents: 'none',
            zIndex: 10
          }} />
          <div
            ref={messagesRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              padding: 16,
              display: 'block',
            }}
          >
            {activeId && !(activeConversation?.isSecret && (!secretSessionReady || secretInactive)) && (olderMeta.hasMore || olderLoading) && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 14px' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!olderMeta.hasMore || olderLoading}
                  onClick={() => { void loadOlderMessages() }}
                  style={{ opacity: olderLoading ? 0.85 : 1 }}
                >
                  {olderLoading ? 'Загружаем…' : 'Показать более ранние'}
                </button>
              </div>
            )}
            {!activeId ? (
              <div className="messages-empty">Сообщения появятся здесь</div>
            ) : (activeConversation?.isSecret && (!secretSessionReady || secretInactive)) ? (
              <div className="messages-empty">{secretBlockedText}</div>
            ) : (
              (() => {
                const list = (displayedMessages ? [...displayedMessages] : []).
                  filter((m: any) => !m.deletedAt).
                  sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()) as Array<any> | undefined
                const pending = activePendingMessages
                const fullList = [...(list || []), ...pending]
                if (!fullList) return null
                return fullList.map((m: any, i: number) => {
                  if (m.deletedAt) return null
                  
                  // Системные сообщения отображаются по-особому
                  if (m.type === 'SYSTEM') {
                    return (
                      <div key={m.id} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '12px 16px', marginTop: 8 }}>
                        <div style={{ 
                          fontSize: 13, 
                          color: 'var(--text-muted)', 
                          textAlign: 'center',
                          fontStyle: 'italic',
                          opacity: 0.8
                        }}>
                          {renderMessageText(m.content)}
                        </div>
                      </div>
                    )
                  }
                  
                  const prev = fullList[i - 1]
                  const next = fullList[i + 1]
                  const isLastOfRun = !next || next.senderId !== m.senderId
                  const isPrevSame = !!prev && prev.senderId === m.senderId
                  const isMe = m.senderId === me?.id
                  const baseRow = leftAlignAll ? 'msg left' : (isMe ? 'msg me' : 'msg them')
                  const spacingClass = isPrevSame ? 'compact' : 'gap'
                  const rowClass = `${baseRow} ${spacingClass}`
                  const baseBubble = leftAlignAll ? 'msg-bubble left' : (isMe ? 'msg-bubble me' : 'msg-bubble them')
                  const bubbleClass = isLastOfRun ? `${baseBubble} ${isMe && !leftAlignAll ? 'tail-right' : 'tail-left'}` : baseBubble
                  const firstUrl = typeof m.content === 'string' ? extractFirstPreviewableUrl(m.content) : null
                  const hasAnyLink = !!firstUrl
                  const previewMedia = (() => {
                    const p = (m as any)?.metadata?.linkPreview
                    if (p && typeof p === 'object' && typeof p.imageUrl === 'string' && p.imageUrl.trim()) return true
                    if (!firstUrl) return false
                    try {
                      const host = new URL(firstUrl).hostname.toLowerCase()
                      return host.includes('youtube.com') || host === 'youtu.be' || host.includes('spotify.com') || host === 'spoti.fi'
                    } catch {
                      return false
                    }
                  })()
                  const senderUser = usersById[m.senderId]
                  const avatarName = senderUser?.displayName ?? senderUser?.username ?? (isMe ? (me?.displayName ?? me?.username ?? 'Me') : 'User')
                  const avatarId = senderUser?.id ?? (isMe ? (me?.id ?? 'me') : 'user')
                  const bg = isMe ? '#303845' : hashToGray(m.senderId)
                  const fg = isMe ? '#f1f3f6' : '#f1f3f6'
                  const showAvatar = leftAlignAll && isLastOfRun
                  const showSpacer = leftAlignAll
                  const createdAt = m.createdAt ? new Date(m.createdAt) : null
                  const timeLabel = createdAt ? createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
                  const editedAtRaw = (m as any)?.metadata?.editedAt
                  const isEdited = typeof editedAtRaw === 'string' && editedAtRaw.length > 0
                  const otherIds: string[] = (activeConversation?.participants || []).map((p: any) => p.user.id).filter((id: string) => (currentUserId ? id !== currentUserId : true))
                  const receipts = (m.receipts || []) as Array<any>
                  const readByAny = isMe && otherIds.some((uid) => receipts.some((r) => r.userId === uid && (r.status === 'READ' || r.status === 'SEEN')))
                  const isPendingMessage = (() => {
                    try {
                      if (typeof (m as any)?.__pending === 'boolean') return (m as any).__pending
                      if (typeof m.id === 'string' && m.id.startsWith('tmp-')) return true
                      const atts = (m as any)?.attachments
                      if (Array.isArray(atts) && atts.some((a: any) => !!a?.__pending)) return true
                      return false
                    } catch {
                      return false
                    }
                  })()
                  const ackedOnServer = isMe && !!m.id && !isPendingMessage
                  const tickVariant: 'none' | 'ack' | 'read' = isMe ? (readByAny ? 'read' : (ackedOnServer ? 'ack' : 'none')) : 'none'
                  const renderTicks = (opts?: { withLeftMargin?: boolean }) => {
                    if (tickVariant === 'none') return null
                    const color = tickVariant === 'read' ? '#d97706' : '#9aa0a8'
                    const withLeftMargin = opts?.withLeftMargin ?? false
                    const common: React.CSSProperties = {
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color,
                      marginLeft: withLeftMargin ? 6 : 0,
                      lineHeight: 0,
                      transform: 'translateY(1px)',
                      flexShrink: 0,
                    }
                    // Match the look from the screenshot: rounded caps, slightly thicker stroke.
                    const strokeWidth = 2.2
                    return (
                      <span style={common} aria-label={tickVariant === 'read' ? 'Read' : 'Sent'}>
                        {tickVariant === 'read' ? (
                          <svg width="18" height="12" viewBox="0 0 18 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 6.5L4.5 10L11.5 1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M7 6.5L10.5 10L17.5 1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 6.5L4.5 10L11 1.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                    )
                  }
                  const isRecentMessage = i >= fullList.length - 28
                      const openMenuAt = (clientX: number, clientY: number) => {
                        setContextMenu({ open: true, x: clientX, y: clientY, messageId: m.id })
                      }
                      const onContextMenu = (e: React.MouseEvent) => {
                    e.preventDefault()
                        openMenuAt(e.clientX, e.clientY)
                  }
                  const scrollToQuoted = () => {
                    const qid = (m as any).replyTo?.id as string | undefined
                    if (!qid) return
                    const el = nodesByMessageId.current.get(qid)
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                  // Lightbox should be scoped to this message (not the whole chat).
                  const imagesInMessage = (m.attachments || [])
                    .filter((a: any) => a?.type === 'IMAGE')
                    .map((a: any) => resolveAttachmentUrl(a))
                    .filter((u: string | null): u is string => !!u)
                  const openLightbox = (url: string) => {
                    const index = imagesInMessage.findIndex((u: string) => u === url)
                    setLightbox({ open: true, index: index >= 0 ? index : 0, items: imagesInMessage })
                  }
                      const onLongPress = {
                        onPointerDown: (e: any) => {
                          const id = window.setTimeout(() => openMenuAt(e.clientX, e.clientY), 450)
                          const clear = () => { window.clearTimeout(id); window.removeEventListener('pointerup', clear); window.removeEventListener('pointermove', cancel) }
                          const cancel = () => { window.clearTimeout(id); window.removeEventListener('pointerup', clear); window.removeEventListener('pointermove', cancel) }
                          window.addEventListener('pointerup', clear, { passive: true } as any)
                          window.addEventListener('pointermove', cancel, { passive: true } as any)
                        }
                      }
                      const rowHandlers = isMobile ? {} : { onContextMenu, ...onLongPress }
                      return (
                        <div key={m.id} className={rowClass} {...rowHandlers}>
                      {showSpacer && (showAvatar ? (
                        <Avatar name={avatarName} id={avatarId} avatarUrl={(() => {
                          const userAvatar = usersById[m.senderId]?.avatarUrl
                          return userAvatar && userAvatar.trim() ? userAvatar : undefined
                        })()} />
                      ) : (
                        <div className="avatar-spacer" />
                      ))}
                      <div
                        className={hasAnyLink ? `${bubbleClass} has-link-preview${previewMedia ? ' has-link-preview-media' : ''}` : bubbleClass}
                        data-mid={m.id}
                        ref={(el) => {
                          if (!el) { nodesByMessageId.current.delete(m.id); return }
                          nodesByMessageId.current.set(m.id, el)
                          visibleObserver.current?.observe(el)
                        }}
                        style={{ ['--bubble-bg' as any]: bg, ['--bubble-fg' as any]: fg }}
                        onClick={(e) => {
                          if (!isMobile) return
                          const target = e.target as HTMLElement
                          if (target.closest('a, button, input, textarea, img, video, .reaction-emoji')) return
                          const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
                          if (selection && selection.toString()) return
                          openMenuAt(e.clientX, e.clientY)
                        }}
                        onContextMenu={(e) => {
                          const target = e.target as HTMLElement
                          if (target.closest('.reaction-emoji')) {
                            e.preventDefault()
                            e.stopPropagation()
                            return
                          }
                          openMenuAt(e.clientX, e.clientY)
                        }}
                      >
                        {(m.reactions && m.reactions.length > 0) && (() => {
                          const grouped: Record<string, { count: number; hasMine: boolean }> = {}
                          for (const r of m.reactions) {
                            if (!grouped[r.emoji]) {
                              grouped[r.emoji] = { count: 0, hasMine: false }
                            }
                            grouped[r.emoji].count++
                            if (r.userId === me?.id) {
                              grouped[r.emoji].hasMine = true
                            }
                          }
                          return (
                            <div style={{ position: 'absolute', bottom: -18, right: isMe ? 8 : undefined, left: !isMe ? 8 : undefined, display: 'flex', gap: 6, background: 'var(--surface-200)', border: '1px solid var(--surface-border)', borderRadius: 12, padding: '2px 6px', zIndex: 5, pointerEvents: 'auto' }}>
                              {Object.entries(grouped).map(([emo, data], idx) => {
                                const isHeart = emo === '❤️'
                                const color = isHeart ? '#ef4444' : '#ffc46b'
                                return (
                                  <button
                                    key={emo}
                                    type="button"
                                    className="reaction-emoji"
                                    onClick={async (e) => {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      try {
                                        if (data.hasMine) {
                                          await api.post('/messages/unreact', { messageId: m.id, emoji: emo })
                                        } else {
                                          await api.post('/messages/react', { messageId: m.id, emoji: emo })
                                        }
                                        if (activeId) client.invalidateQueries({ queryKey: ['messages', activeId] })
                                      } catch (err) {
                                        console.error('Error toggling reaction:', err)
                                      }
                                    }}
                                    onMouseDown={(e) => {
                                      e.stopPropagation()
                                    }}
                                    style={{
                                      fontSize: 12,
                                      color: color,
                                      display: 'inline-block',
                                      animation: `reactionBounce 0.6s ease ${idx * 0.1}s`,
                                      cursor: 'pointer',
                                      opacity: data.hasMine ? 1 : 0.8,
                                      background: 'transparent',
                                      border: 'none',
                                      padding: 0,
                                      margin: 0,
                                      font: 'inherit',
                                    }}
                                  >
                                    {emo}{data.count > 1 ? ` ${data.count}` : ''}
                                  </button>
                                )
                              })}
                            </div>
                          )
                        })()}
                        {m.replyTo && (
                          <div
                            onClick={scrollToQuoted}
                            style={{
                              cursor: 'pointer',
                              fontSize: 12,
                              padding: '6px 8px',
                              borderRadius: 8,
                              marginBottom: 6,
                              background: isMe ? '#303845' : '#191d23',
                              color: '#f1f3f6',
                              borderLeft: isMe ? '3px solid #ff9e1a' : '3px solid #ff9e1a',
                            }}
                          >
                            Ответ на: {(m.replyTo.content ?? 'сообщение')}
                          </div>
                        )}
                        <>
                          <div style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                            {renderMessageText(m.content)}
                          </div>
                          {(() => {
                            const firstUrl = extractFirstPreviewableUrl(m.content)
                            if (!firstUrl) return null
                            const preview = (m as any)?.metadata?.linkPreview
                            const attemptedAt = typeof (m as any)?.metadata?.linkPreviewAttemptedAt === 'string'
                              ? (m as any).metadata.linkPreviewAttemptedAt
                              : null
                            const attemptedUrl = typeof (m as any)?.metadata?.linkPreviewUrl === 'string'
                              ? (m as any).metadata.linkPreviewUrl
                              : null
                            const attempted = !!attemptedAt && attemptedUrl === firstUrl
                            // In secret chats: show only minimal (derived from URL), never fetch/render rich metadata.
                            if (activeConversation?.isSecret) {
                              return <LinkPreviewCard preview={{ url: firstUrl }} />
                            }
                            // Non-secret: rich if available, otherwise minimal while loading.
                            return <LinkPreviewCard preview={preview ? { ...preview, url: preview.url || firstUrl } : (attempted ? { url: firstUrl } : { url: firstUrl, __loading: true })} />
                          })()}
                          {(() => {
                            const attachments = (m.attachments || []) as any[]
                            const imageAtts = attachments.filter((a) => a?.type === 'IMAGE')
                            const hasText = typeof m.content === 'string' ? m.content.trim().length > 0 : !!m.content
                            const hasNonImage = attachments.some((a) => a?.type && a.type !== 'IMAGE')
                            const imageOnly = imageAtts.length > 0 && !hasText && !hasNonImage
                            const ordered: Array<
                              | { kind: 'imageGroup'; atts: any[] }
                              | { kind: 'single'; att: any; idx: number }
                            > = []

                            let addedImages = false
                            attachments.forEach((att, idx) => {
                              if (att?.type === 'IMAGE') {
                                if (!addedImages) {
                                  ordered.push({ kind: 'imageGroup', atts: imageAtts })
                                  addedImages = true
                                }
                                return
                              }
                              ordered.push({ kind: 'single', att, idx })
                            })

                            const renderImageGroup = (atts: any[]) => {
                              if (!atts.length) return null
                              if (atts.length === 1) {
                                const att = atts[0]
                                const idx = 0
                                const metadata = att.metadata ?? {}
                                const resolvedUrl = resolveAttachmentUrl(att)
                                const needsDecrypt = Boolean(activeConversation?.isSecret && metadata?.e2ee?.kind === 'ciphertext')
                                const decryptState = needsDecrypt ? attachmentDecryptMap[att.url] : undefined
                                const decryptPending = needsDecrypt && !resolvedUrl && (!decryptState || decryptState.status === 'pending')
                                const decryptError = needsDecrypt && decryptState?.status === 'error'

                                const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
                                const isMobile = vw <= 768
                                const maxScreen = isMobile
                                  ? Math.max(320, Math.floor(vw / 2))
                                  : Math.min(600, Math.max(320, Math.floor(vw / 3)))

                                const dimKey = `${att.url || idx}`
                                const loadedDims = imageDimensions[dimKey]
                                const baseW = loadedDims?.width || att.width || att.metadata?.width || maxScreen
                                const baseH =
                                  loadedDims?.height || att.height || att.metadata?.height || Math.round(baseW * 0.75)
                                const ratio = baseH / baseW || 0.75

                                const maxWidth = maxScreen
                                let maxHeight = maxScreen
                                if (ratio < 0.5) {
                                  maxHeight = Math.max(Math.round(maxScreen * 0.6), 200)
                                } else if (ratio < 0.7) {
                                  maxHeight = Math.max(Math.round(maxScreen * 0.75), 200)
                                }

                                const scaleByWidth = baseW > maxWidth ? maxWidth / baseW : 1
                                const scaleByHeight = baseH > maxHeight ? maxHeight / baseH : 1
                                const scale = Math.min(scaleByWidth, scaleByHeight, 1)

                                let targetW = baseW * scale
                                let targetH = baseH * scale
                                if (targetW > maxWidth) {
                                  targetW = maxWidth
                                  targetH = targetW * ratio
                                }
                                if (targetH > maxHeight) {
                                  targetH = maxHeight
                                  targetW = targetH / ratio
                                }

                                targetW = Math.round(targetW)
                                targetH = Math.round(targetH)

                                const placeholderKey = `${att.url || idx}`
                                const isLoaded = !!loadedImages[placeholderKey]
                                const isFailed = !!failedImages[placeholderKey]
                                const showPending = att.__pending || decryptPending || (!isLoaded && !isFailed)

                                return (
                                  <div
                                    key={`images-single-${att.url || idx}`}
                                    style={{
                                      maxWidth: '100%',
                                      maxHeight: targetH,
                                      width: showPending
                                        ? Math.min(targetW, typeof window !== 'undefined' ? window.innerWidth - 100 : targetW)
                                        : 'fit-content',
                                      height: showPending ? targetH : 'auto',
                                      minWidth: 0,
                                      minHeight: showPending ? targetH : 0,
                                      marginTop: 8,
                                      position: 'relative',
                                      borderRadius: 10,
                                      overflow: 'hidden',
                                      display: 'inline-block',
                                      lineHeight: 0,
                                      boxSizing: 'border-box',
                                    }}
                                  >
                                    {imageOnly && (
                                      <div className="msg-media-meta">
                                        <span>{timeLabel}</span>
                                        {renderTicks()}
                                      </div>
                                    )}
                                    {showPending && (
                                      <div
                                        style={{
                                          position: 'absolute',
                                          inset: 0,
                                          width: '100%',
                                          height: '100%',
                                          borderRadius: 10,
                                          background: 'var(--surface-100)',
                                          border: '1px solid var(--surface-border)',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          zIndex: 1,
                                        }}
                                      >
                                        <div
                                          style={{
                                            position: 'absolute',
                                            inset: 0,
                                            background:
                                              'linear-gradient(90deg, transparent 25%, rgba(255,255,255,0.1) 37%, transparent 63%)',
                                            backgroundSize: '400% 100%',
                                            animation: 'eb-shimmer 1.2s ease-in-out infinite',
                                          }}
                                        />
                                        {decryptPending ? (
                                          <div
                                            style={{
                                              position: 'relative',
                                              zIndex: 2,
                                              display: 'flex',
                                              flexDirection: 'column',
                                              alignItems: 'center',
                                              gap: 8,
                                              color: 'var(--text-muted)',
                                              fontSize: 12,
                                            }}
                                          >
                                            Расшифровка изображения...
                                          </div>
                                        ) : typeof att.progress === 'number' && att.progress < 100 ? (
                                          <div
                                            style={{
                                              position: 'relative',
                                              zIndex: 2,
                                              display: 'flex',
                                              flexDirection: 'column',
                                              alignItems: 'center',
                                              gap: 8,
                                            }}
                                          >
                                            <div
                                              style={{
                                                width: 40,
                                                height: 40,
                                                border: '3px solid var(--surface-border)',
                                                borderTopColor: 'var(--brand)',
                                                borderRadius: '50%',
                                                animation: 'spin 1s linear infinite',
                                              }}
                                            />
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
                                              {att.progress}%
                                            </div>
                                          </div>
                                        ) : (
                                          <div
                                            style={{
                                              position: 'relative',
                                              zIndex: 2,
                                              width: 40,
                                              height: 40,
                                              border: '3px solid var(--surface-border)',
                                              borderTopColor: 'var(--brand)',
                                              borderRadius: '50%',
                                              animation: 'spin 1s linear infinite',
                                            }}
                                          />
                                        )}
                                      </div>
                                    )}
                                    {decryptError && (
                                      <div style={{ marginTop: 8, color: '#f87171', fontSize: 12 }}>
                                        Не удалось расшифровать изображение
                                      </div>
                                    )}
                                    {isFailed && !decryptError && (
                                      <div style={{ marginTop: 8, color: '#f87171', fontSize: 12 }}>
                                        Не удалось загрузить изображение
                                      </div>
                                    )}
                                    {resolvedUrl && !decryptError && (
                                      <LazyImage
                                        src={resolvedUrl}
                                        alt="img"
                                        rootRef={messagesRef as any}
                                        rootMargin="900px 0px"
                                        priority={isRecentMessage ? 'high' : 'low'}
                                        style={{
                                          maxWidth: '100%',
                                          maxHeight: targetH,
                                          width: 'auto',
                                          height: 'auto',
                                          objectFit: 'contain',
                                          borderRadius: 10,
                                          cursor: m.id?.startsWith('tmp-') ? 'default' : 'zoom-in',
                                          // Keep element in layout so IntersectionObserver can trigger loading.
                                          // We hide visually until onLoad to avoid flashing broken image icon.
                                          opacity: isLoaded ? (att.__pending ? 0.85 : 1) : 0.001,
                                          display: 'block',
                                          position: 'relative',
                                          zIndex: 0,
                                          background: 'var(--surface-100)',
                                          verticalAlign: 'top',
                                        }}
                                        onLoad={(e) => {
                                          const img = e.target as HTMLImageElement
                                          if ((!att.width && !metadata?.width) && img.naturalWidth && img.naturalHeight) {
                                            setImageDimensions((prev) => ({
                                              ...prev,
                                              [placeholderKey]: { width: img.naturalWidth, height: img.naturalHeight },
                                            }))
                                          }
                                          setFailedImages((prev) => ({ ...prev, [placeholderKey]: false }))
                                          setLoadedImages((prev) => ({ ...prev, [placeholderKey]: true }))
                                          if (messagesRef.current && nearBottomRef.current) {
                                            const el = messagesRef.current
                                            el.scrollTop = el.scrollHeight
                                          }
                                        }}
                                        onError={() => {
                                          setFailedImages((prev) => ({ ...prev, [placeholderKey]: true }))
                                          setLoadedImages((prev) => ({ ...prev, [placeholderKey]: true }))
                                        }}
                                        onClick={() => {
                                          if (!att.__pending && !decryptPending && resolvedUrl) {
                                            openLightbox(resolvedUrl)
                                          }
                                        }}
                                      />
                                    )}
                                    {isLoaded && !decryptPending && typeof att.progress === 'number' && att.progress < 100 && (
                                      <div
                                        style={{
                                          position: 'absolute',
                                          left: 0,
                                          right: 0,
                                          bottom: 0,
                                          height: 6,
                                          background: 'rgba(0,0,0,0.15)',
                                          borderRadius: '0 0 10px 10px',
                                          overflow: 'hidden',
                                          zIndex: 3,
                                        }}
                                      >
                                        <div style={{ width: `${att.progress}%`, height: '100%', background: 'rgba(255,255,255,0.9)' }} />
                                      </div>
                                    )}
                                  </div>
                                )
                              }

                              // Mosaic for 2+ images:
                              // We compute a layout where each tile keeps the image's own aspect ratio (h/w),
                              // so nothing is cropped for any formats. For 2/3/4+ we pick a Telegram-like arrangement,
                              // but column widths are computed from ratios to make heights match.
                              const visible = atts.slice(0, 4)
                              const extra = atts.length - visible.length
                              const getRatio = (a: any, i: number): number => {
                                const md = a?.metadata ?? {}
                                const key = `${a?.url || i}`
                                const dims = imageDimensions[key]
                                const w = dims?.width || a?.width || md?.width
                                const h = dims?.height || a?.height || md?.height
                                const r = typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? h / w : 1
                                // Clamp extreme cases (panoramas / very tall scans) so bubble stays sane.
                                return Math.max(0.2, Math.min(5, Number.isFinite(r) ? r : 1))
                              }

                              const renderTile = (att: any, tileIdx: number, showMore: boolean) => {
                                const metadata = att.metadata ?? {}
                                const resolvedUrl = resolveAttachmentUrl(att)
                                const needsDecrypt = Boolean(activeConversation?.isSecret && metadata?.e2ee?.kind === 'ciphertext')
                                const decryptState = needsDecrypt ? attachmentDecryptMap[att.url] : undefined
                                const decryptPending = needsDecrypt && !resolvedUrl && (!decryptState || decryptState.status === 'pending')
                                const decryptError = needsDecrypt && decryptState?.status === 'error'
                                const placeholderKey = `${att.url || tileIdx}`
                                const isLoaded = !!loadedImages[placeholderKey]
                                const isFailed = !!failedImages[placeholderKey]
                                const showPending = att.__pending || decryptPending || (!isLoaded && !isFailed)
                                const disabled = att.__pending || decryptPending || decryptError || !resolvedUrl
                                const ratio = getRatio(att, tileIdx) // h/w

                                return (
                                  <button
                                    key={`${att.url || tileIdx}`}
                                    type="button"
                                    className="msg-media-tile"
                                    style={{ aspectRatio: 1 / ratio }}
                                    disabled={disabled}
                                    onClick={() => {
                                      if (!disabled && resolvedUrl) openLightbox(resolvedUrl)
                                    }}
                                  >
                                    {resolvedUrl && (
                                      <LazyImage
                                        src={resolvedUrl}
                                        alt="img"
                                        rootRef={messagesRef as any}
                                        rootMargin="900px 0px"
                                        priority={isRecentMessage ? 'high' : 'low'}
                                        style={{ opacity: isLoaded && !showPending ? 1 : 0.001 }}
                                        onLoad={(e) => {
                                          const img = e.target as HTMLImageElement
                                          if ((!att.width && !metadata?.width) && img.naturalWidth && img.naturalHeight) {
                                            setImageDimensions((prev) => ({
                                              ...prev,
                                              [placeholderKey]: { width: img.naturalWidth, height: img.naturalHeight },
                                            }))
                                          }
                                          setFailedImages((prev) => ({ ...prev, [placeholderKey]: false }))
                                          setLoadedImages((prev) => ({ ...prev, [placeholderKey]: true }))
                                        }}
                                        onError={() => {
                                          setFailedImages((prev) => ({ ...prev, [placeholderKey]: true }))
                                          setLoadedImages((prev) => ({ ...prev, [placeholderKey]: true }))
                                        }}
                                      />
                                    )}
                                    {showPending && (
                                      <div className="msg-media-overlay">
                                        <div className="msg-media-overlay-shimmer" />
                                        {decryptPending ? (
                                          <div style={{ position: 'relative', zIndex: 2, color: 'var(--text-muted)', fontSize: 12 }}>
                                            Расшифровка...
                                          </div>
                                        ) : typeof att.progress === 'number' && att.progress < 100 ? (
                                          <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                                            <div style={{ width: 34, height: 34, border: '3px solid var(--surface-border)', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{att.progress}%</div>
                                          </div>
                                        ) : (
                                          <div style={{ position: 'relative', zIndex: 2, width: 34, height: 34, border: '3px solid var(--surface-border)', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                                        )}
                                      </div>
                                    )}
                                    {(decryptError || isFailed) && (
                                      <div className="msg-media-overlay" style={{ background: 'rgba(15, 23, 42, 0.55)' }}>
                                        <div style={{ position: 'relative', zIndex: 2, color: '#f87171', fontSize: 12, padding: 10, textAlign: 'center' }}>
                                          {decryptError ? 'Ошибка расшифровки' : 'Ошибка загрузки'}
                                        </div>
                                      </div>
                                    )}
                                    {showMore && <div className="msg-media-more">+{extra}</div>}
                                  </button>
                                )
                              }

                              return (
                                <div
                                  key="images-mosaic"
                                  className="msg-media-grid"
                                >
                                  {imageOnly && (
                                    <div className="msg-media-meta">
                                      <span>{timeLabel}</span>
                                      {renderTicks()}
                                    </div>
                                  )}
                                  {visible.length === 2 && (() => {
                                    const r0 = getRatio(visible[0], 0)
                                    const r1 = getRatio(visible[1], 1)
                                    // widths proportional to the opposite ratio to equalize heights
                                    const w0 = r1
                                    const w1 = r0
                                    return (
                                      <>
                                        <div style={{ flex: `${w0} 1 0`, minWidth: 0 }}>
                                          {renderTile(visible[0], 0, false)}
                                        </div>
                                        <div style={{ flex: `${w1} 1 0`, minWidth: 0 }}>
                                          {renderTile(visible[1], 1, extra > 0 && 1 === visible.length - 1)}
                                        </div>
                                      </>
                                    )
                                  })()}

                                  {visible.length === 3 && (() => {
                                    const r0 = getRatio(visible[0], 0)
                                    const r1 = getRatio(visible[1], 1)
                                    const r2 = getRatio(visible[2], 2)
                                    // left = big (0), right = stack (1,2)
                                    const wLeft = r1 + r2
                                    const wRight = r0
                                    return (
                                      <>
                                        <div style={{ flex: `${wLeft} 1 0`, minWidth: 0 }}>
                                          {renderTile(visible[0], 0, false)}
                                        </div>
                                        <div className="msg-media-col" style={{ flex: `${wRight} 1 0` }}>
                                          {renderTile(visible[1], 1, false)}
                                          {renderTile(visible[2], 2, extra > 0 && 2 === visible.length - 1)}
                                        </div>
                                      </>
                                    )
                                  })()}

                                  {visible.length >= 4 && (() => {
                                    // 2x2: (0,2) left column; (1,3) right column
                                    const r0 = getRatio(visible[0], 0)
                                    const r1 = getRatio(visible[1], 1)
                                    const r2 = getRatio(visible[2], 2)
                                    const r3 = getRatio(visible[3], 3)
                                    const wLeft = r1 + r3
                                    const wRight = r0 + r2
                                    return (
                                      <>
                                        <div className="msg-media-col" style={{ flex: `${wLeft} 1 0` }}>
                                          {renderTile(visible[0], 0, false)}
                                          {renderTile(visible[2], 2, false)}
                                        </div>
                                        <div className="msg-media-col" style={{ flex: `${wRight} 1 0` }}>
                                          {renderTile(visible[1], 1, false)}
                                          {renderTile(visible[3], 3, extra > 0)}
                                        </div>
                                      </>
                                    )
                                  })()}
                                </div>
                              )
                            }

                            return (
                              <>
                                {ordered.map((item, renderIdx) => {
                                  if (item.kind === 'imageGroup') {
                                    return <Fragment key="images-group">{renderImageGroup(item.atts)}</Fragment>
                                  }

                                  const att = item.att
                                  const idx = item.idx
                                  const metadata = att.metadata ?? {}
                                  const headInfo = attachmentHeadInfoMap[att.url]
                                  const mergedMeta = {
                                    ...metadata,
                                    ...(headInfo?.fileName ? { originalName: headInfo.fileName } : {}),
                                    ...(headInfo?.mime ? { mime: headInfo.mime } : {}),
                                    ...(headInfo?.size ? { size: headInfo.size } : {}),
                                  }
                                  const resolvedUrl = resolveAttachmentUrl(att)
                                  const needsDecrypt = Boolean(
                                    activeConversation?.isSecret && metadata?.e2ee?.kind === 'ciphertext',
                                  )
                                  const decryptState = needsDecrypt ? attachmentDecryptMap[att.url] : undefined
                                  const decryptPending =
                                    needsDecrypt && !resolvedUrl && (!decryptState || decryptState.status === 'pending')
                                  const decryptError = needsDecrypt && decryptState?.status === 'error'
                                  if (att.type === 'AUDIO') {
                                    const duration = m.metadata?.duration || 0
                                    const audioUrl = resolvedUrl || att.url
                                    return (
                                      <div key={`${att.url}-${idx}-${renderIdx}`} style={{ marginTop: 8, minWidth: 200, maxWidth: 300 }}>
                                        {decryptPending ? (
                                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: 'var(--surface-100)', borderRadius: 12, border: '1px solid var(--surface-border)', color: 'var(--text-muted)' }}>
                                            <div style={{ width: 16, height: 16, border: '2px solid var(--surface-border)', borderTopColor: 'var(--brand)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                                            <span style={{ fontSize: 13 }}>Расшифровка аудио...</span>
                                          </div>
                                        ) : decryptError ? (
                                          <div style={{ color: '#f87171', fontSize: 12 }}>Не удалось расшифровать аудио</div>
                                        ) : audioUrl ? (
                                          <VoiceMessagePlayer url={audioUrl} duration={duration} />
                                        ) : (
                                          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Голосовое сообщение</div>
                                        )}
                                      </div>
                                    )
                                  }

                                  // Секрет: только blob (E2EE). Обычный чат: всегда прокси /api/files, чтобы сервер расшифровал хранилище
                                  const fileHref = activeConversation?.isSecret
                                    ? resolvedUrl
                                    : (convertToProxyUrl(att.url) || resolvedUrl || att.url)
                                  const filePresentation = getAttachmentFilePresentation(att, mergedMeta)
                                  const baseSubtitle = filePresentation.sizeText
                                    ? `${filePresentation.description} · ${filePresentation.sizeText}`
                                    : filePresentation.description
                                  const renderFileCard = (statusText?: string) => {
                                    const subtitle = statusText
                                      ? `${baseSubtitle}${baseSubtitle ? ' · ' : ''}${statusText}`
                                      : baseSubtitle
                                    return (
                                      <div
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: 10,
                                          padding: '10px 12px',
                                          borderRadius: 14,
                                          border: '1px solid var(--surface-border)',
                                          background: 'var(--surface-100)',
                                          minWidth: 220,
                                          maxWidth: 360,
                                        }}
                                      >
                                        <div
                                          style={{
                                            width: 40,
                                            height: 40,
                                            borderRadius: 999,
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            flexShrink: 0,
                                            fontSize: 11,
                                            fontWeight: 800,
                                            letterSpacing: 0.3,
                                            textTransform: 'uppercase',
                                            background: filePresentation.ui.bg,
                                            color: filePresentation.ui.fg,
                                          }}
                                        >
                                          {filePresentation.badge}
                                        </div>
                                        <div style={{ minWidth: 0 }}>
                                          <div
                                            style={{
                                              fontSize: 14,
                                              fontWeight: 600,
                                              color: 'var(--text)',
                                              whiteSpace: 'nowrap',
                                              overflow: 'hidden',
                                              textOverflow: 'ellipsis',
                                            }}
                                            title={filePresentation.fileName}
                                          >
                                            {filePresentation.fileName}
                                          </div>
                                          <div
                                            style={{
                                              marginTop: 3,
                                              fontSize: 12,
                                              color: 'var(--text-muted)',
                                              whiteSpace: 'nowrap',
                                              overflow: 'hidden',
                                              textOverflow: 'ellipsis',
                                            }}
                                            title={subtitle}
                                          >
                                            {subtitle}
                                          </div>
                                        </div>
                                      </div>
                                    )
                                  }

                                  return (
                                    <div key={`${att.url}-${idx}-${renderIdx}`} style={{ marginTop: 8 }}>
                                      {att.__pending || decryptPending ? (
                                        renderFileCard(decryptPending ? 'Расшифровка...' : 'Загрузка...')
                                      ) : decryptError ? (
                                        <div style={{ color: '#f87171', fontSize: 12 }}>Не удалось расшифровать файл</div>
                                      ) : fileHref ? (
                                        <a
                                          href={fileHref}
                                          target="_blank"
                                          rel="noreferrer"
                                          download={filePresentation.fileName}
                                          style={{ display: 'inline-block', textDecoration: 'none', color: 'inherit' }}
                                        >
                                          {renderFileCard()}
                                        </a>
                                      ) : (
                                        renderFileCard('Расшифровка...')
                                      )}
                                      {typeof att.progress === 'number' && att.progress < 100 && (
                                        <div style={{ height: 6, background: '#e5e7eb', borderRadius: 6, overflow: 'hidden', marginTop: 6 }}>
                                          <div style={{ width: `${att.progress}%`, height: '100%', background: 'var(--brand)' }} />
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </>
                            )
                          })()}
                        </>
                        {(() => {
                          const attachments = (m.attachments || []) as any[]
                          const hasText = typeof m.content === 'string' ? m.content.trim().length > 0 : !!m.content
                          const hasNonImage = attachments.some((a) => a?.type && a.type !== 'IMAGE')
                          const hasImages = attachments.some((a) => a?.type === 'IMAGE')
                          const imageOnly = hasImages && !hasText && !hasNonImage
                          if (imageOnly) return null
                          return (
                            <div className="msg-meta" style={{ color: '#9aa0a8', display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span>{timeLabel}</span>
                              {isEdited && <span style={{ fontSize: 11, opacity: 0.9 }}>изменено</span>}
                              {renderTicks({ withLeftMargin: false })}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  )
                })
              })()
            )}
          </div>
          {activeId && (
            <button
              className={showJump ? 'jump-bottom jump-bottom--visible' : 'jump-bottom'}
              onClick={() => {
                if (messagesRef.current) {
                  messagesRef.current.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' })
                }
                nearBottomRef.current = true
                userStickyScrollRef.current = false
                setShowJump(false)
              }}
            >
              ↓
            </button>
          )}
          <div className="msg-input-bar"
            style={{ flexShrink: 0 }}
            onDragOver={(e) => { e.preventDefault(); setAttachDragOver(true) }}
            onDragLeave={() => setAttachDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault()
            setAttachDragOver(false)
            const files = Array.from(e.dataTransfer.files || [])
            if (!files.length || !activeId) return
            if (editState) return
            const imageFiles = files.filter((file) => file.type.startsWith('image/'))
            const otherFiles = files.filter((file) => !file.type.startsWith('image/'))
            imageFiles.forEach((file) => addComposerImage(file, 'upload'))
            if (otherFiles.length) {
              await uploadAndSendAttachments(otherFiles)
            }
          }}
          >
            {attachDragOver && !editState && (
              <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '1px dashed var(--surface-border-strong)', background: 'rgba(217,119,6,0.08)', color: 'var(--text-muted)', fontSize: 12 }}>
                Отпустите файлы, чтобы прикрепить
              </div>
            )}
            {activeConversation?.isSecret && (!secretSessionReady || secretInactive) ? (
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-200)', border: '1px solid var(--surface-border)', color: 'var(--text-muted)' }}>
                {secretBlockedText}
              </div>
            ) : (
            <>
            {replyTo && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, background: 'var(--surface-100)', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--surface-border)' }}>
                <Reply size={16} color="var(--text-muted)" />
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Ответ на:</div>
                <div style={{ fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{replyTo.preview}</div>
                <button className="btn btn-icon btn-ghost" onClick={() => setReplyTo(null)} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  <X size={16} />
                </button>
              </div>
            )}
            {pendingImages.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Изображения перед отправкой</div>
                <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 }}>
                  {pendingImages.map((img) => (
                    <div key={img.id} style={{ position: 'relative', flexShrink: 0, width: 132, background: 'var(--surface-100)', borderRadius: 12, border: '1px solid var(--surface-border)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <button
                        className="btn btn-icon btn-ghost"
                        style={{ position: 'absolute', top: 4, right: 4 }}
                        onClick={() => {
                          if (editingImageId === img.id) setEditingImageId(null)
                          removeComposerImage(img.id)
                        }}
                        aria-label="Удалить изображение"
                      >
                        <X size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingImageId(img.id)}
                        style={{ border: 'none', padding: 0, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'transparent' }}
                        aria-label="Редактировать изображение"
                      >
                        <img src={img.previewUrl} alt={img.fileName} style={{ width: '100%', height: 90, objectFit: 'cover', display: 'block' }} />
                      </button>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{img.fileName}</div>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => setEditingImageId(img.id)}
                          style={{ fontSize: 12, padding: '4px 6px', justifyContent: 'center' }}
                        >
                          Редактировать
                        </button>
                        {img.edited && (
                          <div style={{ fontSize: 10, color: '#34d399', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            Отредактировано
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <input type="file" multiple style={{ display: 'none' }} ref={attachInputRef} onChange={async (e) => {
              const files = Array.from(e.target.files || [])
              if (!activeId || files.length === 0) return
              const imageFiles = files.filter((file) => file.type.startsWith('image/'))
              const otherFiles = files.filter((file) => !file.type.startsWith('image/'))
              imageFiles.forEach((file) => addComposerImage(file, 'upload'))
              if (otherFiles.length) {
                await uploadAndSendAttachments(otherFiles)
              }
              e.target.value = ''
            }} />
            {voiceRecording ? (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 16px', background: 'var(--surface-100)', borderRadius: 8, border: '1px solid var(--surface-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                  <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ef4444', animation: 'pulse 1.5s ease-in-out infinite', flexShrink: 0 }} />
                  {/* Фиксированный контейнер для waveform - звук движется справа налево */}
                  <div 
                    ref={waveformContainerRef}
                    style={{ 
                      width: '100%', 
                      ...(isMobile ? { maxWidth: 200 } : {}), 
                      height: 24, 
                      overflow: 'hidden', 
                      position: 'relative',
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {(() => {
                      // Используем фиксированное количество баров (как при воспроизведении)
                      const barWidth = 2
                      const barGap = 2
                      const barTotalWidth = barWidth + barGap
                      const maxBars = isMobile ? 60 : waveformMaxBars
                      
                      // Если данных еще нет, показываем плейсхолдер
                      if (voiceWaveform.length === 0) {
                        return (
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: barGap, 
                            height: 24,
                          }}>
                            {Array(maxBars).fill(0).map((_, i) => (
                              <div
                                key={i}
                                style={{
                                  width: barWidth,
                                  height: 12,
                                  background: 'var(--surface-border)',
                                  borderRadius: 1,
                                  animation: 'pulse 1.5s ease-in-out infinite',
                                  animationDelay: `${i * 0.1}s`,
                                  flexShrink: 0,
                                }}
                              />
                            ))}
                          </div>
                        )
                      }
                      
                      // Показываем waveform данные с прокруткой справа налево (как на ПК)
                      return (
                        <div style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: barGap, 
                          height: 24,
                          position: 'absolute',
                          right: 0,
                          // Сдвигаем влево: когда данных больше maxBars, каждый новый бар сдвигает весь waveform влево
                          transform: voiceWaveform.length > maxBars 
                            ? `translateX(-${(voiceWaveform.length - maxBars) * barTotalWidth}px)` 
                            : 'translateX(0)',
                          transition: 'none', // Убираем transition для мгновенного обновления
                        }}>
                          {/* Показываем последние maxBars баров, новые появляются справа */}
                          {voiceWaveform.slice(-maxBars).map((amplitude, index) => {
                            // Вычисляем высоту бара: минимум 4px, максимум 20px (как при воспроизведении)
                            const height = Math.max(4, (amplitude / 100) * 20)
                            return (
                              <div
                                key={`${voiceWaveform.length - maxBars + index}-${index}`}
                                style={{
                                  width: barWidth,
                                  height: `${height}px`,
                                  background: 'var(--brand)',
                                  borderRadius: 1,
                                  alignSelf: 'flex-end',
                                  flexShrink: 0,
                                }}
                              />
                            )
                          })}
                        </div>
                      )
                    })()}
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {Math.floor(voiceDuration / 60)}:{(voiceDuration % 60).toString().padStart(2, '0')}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={cancelVoiceRecording}
                  style={{ flexShrink: 0 }}
                  aria-label="Отменить запись"
                >
                  <X size={16} />
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={stopVoiceRecording}
                  style={{ flexShrink: 0 }}
                  aria-label="Отправить голосовое сообщение"
                >
                  <Send size={16} />
                </button>
              </div>
            ) : (
              <>
                {(() => {
              const ids = Object.keys(typingByUserId)
              if (!ids.length) return null
              const names = ids
                .filter((uid) => uid !== me?.id)
                .map((uid) => {
                  const u = usersById[uid]
                  return (u?.displayName ?? u?.username ?? 'Пользователь') as string
                })
                .filter(Boolean)
              if (!names.length) return null
              const label =
                names.length === 1
                  ? `Печатает: ${names[0]}`
                  : `Печатают: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` и ещё ${names.length - 3}` : ''}`
              return (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0 2px 8px',
                    color: 'var(--text-muted)',
                    fontSize: 12,
                    userSelect: 'none',
                    minHeight: 18,
                  }}
                  aria-live="polite"
                >
                  <span>{label}</span>
                  <span aria-hidden style={{ letterSpacing: 2, opacity: 0.9 }}>
                    {'.'.repeat(typingDots)}
                  </span>
                </div>
              )
            })()}
            {editState && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '10px 12px',
                  background: 'var(--surface-100)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: 10,
                  marginBottom: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 13, lineHeight: '18px' }}>
                    Редактирование сообщения
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    Esc — отмена · Enter — сохранить · Shift+Enter — перенос строки
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button type="button" className="btn btn-ghost" onClick={cancelEdit} disabled={editBusy}>
                    Отмена
                  </button>
                  <button type="button" className="btn btn-primary" disabled={editBusy} onClick={() => { (inputRef.current?.form as any)?.requestSubmit?.() }}>
                    {editBusy ? 'Сохраняем...' : 'Сохранить'}
                  </button>
                </div>
              </div>
            )}
            <form autoComplete="off" onSubmit={async (e) => {
                    e.preventDefault()
              if (!activeId) return
              stopTyping(activeId)
              if (editBusy) return
              const trimmed = messageText.trim()

              if (editState) {
                const mid = editState.messageId
                if (!trimmed) return
                setEditBusy(true)
                try {
                  await api.post('/messages/update', { messageId: mid, content: messageText })
                  setEditState(null)
                  setMessageText('')
                  setReplyTo(null)
                } catch (err: any) {
                  console.error('Failed to update message:', err)
                  const status = err?.response?.status
                  const serverMsg = err?.response?.data?.message
                  const msg =
                    typeof serverMsg === 'string' && serverMsg.trim()
                      ? serverMsg
                      : status === 404
                        ? 'Сервер не поддерживает редактирование сообщений (обновите/перезапустите backend после сборки).'
                        : err?.message || 'Не удалось сохранить изменения'
                  alert(msg)
                  setEditState(null)
                } finally {
                  setEditBusy(false)
                }
                return
              }

              const value = trimmed
              if (pendingImages.length > 0) {
                const imagesSnapshot = pendingImages.map((img) => ({ file: img.file, previewUrl: img.previewUrl }))
                setPendingImages([])
                setEditingImageId(null)
                imagesSnapshot.forEach((entry) => releasePreviewUrl(entry.previewUrl))
                await uploadAndSendAttachments(imagesSnapshot.map((entry) => entry.file), value || '', replyTo?.id)
                setMessageText('')
                setReplyTo(null)
              } else if (value) {
                    await sendMessageToConversation(activeConversation, { type: 'TEXT', content: value, replyToId: replyTo?.id })
                    setMessageText('')
                    setReplyTo(null)
              }
                    client.invalidateQueries({ queryKey: ['messages', activeId] })
                    setTimeout(() => { if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight }, 0)
            }} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => attachInputRef.current?.click()}
              disabled={!!editState}
              style={{
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: isMobile ? 0 : 6,
                whiteSpace: 'nowrap',
                height: 'var(--control-h)',
                minHeight: 'var(--control-h)',
                padding: '0 12px',
              }}
              aria-label="Прикрепить файлы"
            >
                <Paperclip size={16} />
                {!isMobile && <span>Загрузить</span>}
              </button>
              <textarea
                placeholder={pendingImages.length > 0 ? "Добавьте подпись к изображениям..." : "Напишите сообщение..."}
                value={messageText}
                onChange={(e) => { setMessageText(e.target.value); notifyTyping() }}
                onInput={() => resizeComposer()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && editState) {
                    e.preventDefault()
                    cancelEdit()
                    return
                  }
                  if (e.key === 'ArrowUp' && !editState) {
                    const el = e.currentTarget
                    const isEmpty = (el.value || '').length === 0
                    const caretAtStart = el.selectionStart === 0 && el.selectionEnd === 0
                    const noAttachments = pendingImages.length === 0
                    if (isEmpty && caretAtStart && noAttachments) {
                      const list = (displayedMessages ? [...displayedMessages] : [])
                        .filter((m: any) => !m?.deletedAt)
                        .sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
                      const last = list[list.length - 1]
                      if (last && last.senderId === me?.id && (last.type || 'TEXT') === 'TEXT' && (!last.attachments || last.attachments.length === 0)) {
                        e.preventDefault()
                        startEdit(last)
                        return
                      }
                    }
                  }
                  // Keep familiar behavior: Enter sends, Shift+Enter inserts newline.
                  // This also enables multi-line paste without collapsing line breaks.
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    if (activeId) stopTyping(activeId)
                    // Trigger <form onSubmit />
                    const form = e.currentTarget.form as HTMLFormElement | null
                    if (!form) return
                    const anyForm = form as any
                    if (typeof anyForm.requestSubmit === 'function') {
                      anyForm.requestSubmit()
                      return
                    }
                    // Fallback for older browsers
                    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
                  }
                  if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
                    e.preventDefault()
                    const el = e.currentTarget
                    const start = el.selectionStart ?? 0
                    const end = el.selectionEnd ?? 0
                    const before = el.value.slice(0, start)
                    const selected = el.value.slice(start, end) || 'текст'
                    const after = el.value.slice(end)
                    const next = `${before}**${selected}**${after}`
                    setMessageText(next)
                    requestAnimationFrame(() => {
                      try {
                        const pos = start + 2 + selected.length + 2
                        el.setSelectionRange(pos, pos)
                      } catch {}
                    })
                    return
                  }
                  if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
                    e.preventDefault()
                    const el = e.currentTarget
                    const start = el.selectionStart ?? 0
                    const end = el.selectionEnd ?? 0
                    const before = el.value.slice(0, start)
                    const selected = el.value.slice(start, end) || 'текст'
                    const after = el.value.slice(end)
                    const next = `${before}*${selected}*${after}`
                    setMessageText(next)
                    requestAnimationFrame(() => {
                      try {
                        const pos = start + 1 + selected.length + 1
                        el.setSelectionRange(pos, pos)
                      } catch {}
                    })
                    return
                  }
                }}
                onPaste={(e) => {
                  if (!activeId) return
                  const items = e.clipboardData?.items
                  if (!items) return
                  let hasText = false
                  try {
                    const text = e.clipboardData?.getData('text/plain')
                    hasText = !!(text && text.length)
                  } catch {
                    hasText = false
                  }
                  let pastedImage = false
                  for (let i = 0; i < items.length; i++) {
                    const item = items[i]
                    if (item.type.indexOf('image') !== -1) {
                      const file = item.getAsFile()
                      if (file) {
                        addComposerImage(file, 'paste')
                      }
                      pastedImage = true
                      break
                    }
                  }
                  // If clipboard contains only an image, prevent any stray paste artifacts.
                  // If it contains text too, keep native text paste (incl. newlines) and also attach the image.
                  if (pastedImage && !hasText) {
                    e.preventDefault()
                  }
                }}
                onBlur={() => { if (activeId) stopTyping(activeId) }}
                ref={inputRef}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--surface-border)',
                  background: 'var(--surface-100)',
                  color: 'var(--text-primary)',
                  fontSize: 16,
                  minHeight: 'var(--control-h)',
                  maxHeight: 'var(--composer-max-h)',
                  height: 'var(--control-h)',
                  lineHeight: '20px',
                  resize: 'none',
                  overflowY: 'hidden',
                }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={startVoiceRecording}
                disabled={!!editState}
                style={{
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: isMobile ? 0 : 6,
                  whiteSpace: 'nowrap',
                  height: 'var(--control-h)',
                  minHeight: 'var(--control-h)',
                  padding: '0 12px',
                }}
                aria-label="Записать голосовое сообщение"
              >
                <Mic size={16} />
                {!isMobile && <span>Голос</span>}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={editBusy}
                style={{
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: isMobile ? 0 : 6,
                  height: 'var(--control-h)',
                  minHeight: 'var(--control-h)',
                  padding: '0 12px',
                }}
              >
                <Send size={16} />
                {!isMobile && <span>{editState ? (editBusy ? 'Сохраняем...' : 'Сохранить') : 'Отправить'}</span>}
              </button>
            </form>
              </>
            )}
            {attachUploading && (
              <div style={{ height: 6, background: 'var(--surface-100)', borderRadius: 3, overflow: 'hidden', marginTop: 10 }}>
                <div style={{ width: `${attachProgress}%`, height: '100%', background: 'var(--brand)', transition: 'width 0.2s ease' }} />
              </div>
            )}
            </>
            )}
          </div>
        </div>
        <Suspense fallback={null}>
          {callConvId && (
            <CallOverlay
              open={!!callConvId}
              conversationId={callConvId}
              minimized={minimizedCallConvId === callConvId}
              peerAvatarUrl={(() => {
            // Используем conversation из callConvId, если звонок активен, иначе из activeConversation
            const conv = callConvId ? (conversationsQuery.data?.find((r: any) => r.conversation.id === callConvId)?.conversation) : activeConversation
            const parts = conv?.participants || []
            if (parts.length === 2) {
            const peer = parts.find((p: any) => (currentUserId ? p.user.id !== currentUserId : true))?.user
              return peer?.avatarUrl ?? null
            }
            return null
          })()}
              avatarsByName={(() => {
            // Используем conversation из callConvId, если звонок активен, иначе из activeConversation
            const conv = callConvId ? (conversationsQuery.data?.find((r: any) => r.conversation.id === callConvId)?.conversation) : activeConversation
            const parts = conv?.participants || []
            const map: Record<string, string | null> = {}
            for (const p of parts) {
              const u = p.user
              const name = u.displayName ?? u.username ?? u.id
              map[name] = u.avatarUrl ?? null
            }
            // include me fallback
            if (me) map[me.displayName ?? me.username ?? me.id] = (meInfoQuery.data?.avatarUrl ?? me.avatarUrl ?? null)
            return map
          })()}
              avatarsById={(() => {
            // Используем conversation из callConvId, если звонок активен, иначе из activeConversation
            const conv = callConvId ? (conversationsQuery.data?.find((r: any) => r.conversation.id === callConvId)?.conversation) : activeConversation
            const parts = conv?.participants || []
            const map: Record<string, string | null> = {}
            for (const p of parts) {
              const u = p.user
              map[u.id] = u.avatarUrl ?? null
            }
            if (me) map[me.id] = (meInfoQuery.data?.avatarUrl ?? me.avatarUrl ?? null)
            return map
          })()}
              localUserId={me?.id ?? null}
              isGroup={(() => {
                // Используем conversation из callConvId, если звонок активен, иначе из activeConversation
                const conv = callConvId ? (conversationsQuery.data?.find((r: any) => r.conversation.id === callConvId)?.conversation) : activeConversation
                return !!conv?.isGroup
              })()}
              onMinimize={() => {
                if (callConvId) {
                  // Сохраняем callConvId при минимизации - он должен оставаться установленным
                  const convIdToMinimize = callConvId
                  setMinimizedCallConvId(convIdToMinimize)
                  // Убеждаемся, что callStore.activeConvId установлен при минимизации для 1:1 звонков
                  const conv = getConversationFromCache(convIdToMinimize)
                  const isGroupConv = !!(conv?.isGroup || (conv?.participants?.length ?? 0) > 2)
                  if (!isGroupConv && callStore.activeConvId !== convIdToMinimize) {
                    // Для 1:1 звонков устанавливаем activeConvId, если его нет
                    callStore.startOutgoing(convIdToMinimize, callStore.initialVideo)
                  }
                  // Убеждаемся, что callConvId остается установленным (не сбрасываем его при минимизации)
                  if (callConvId !== convIdToMinimize) {
                    setCallConvId(convIdToMinimize)
                  }
                }
              }}
              onClose={(options) => {
                const convId = callConvId ?? callConvIdRef.current
                if (!convId) return
                // Если оверлей минимизирован, НЕ закрываем его - минимизация не означает закрытие
                // Минимизированный оверлей остается открытым (open=true), но визуально скрыт
                if (minimizedCallConvId === convId) {
                  // При минимизации оверлей НЕ должен закрываться - только визуально скрыт
                  // Поэтому не вызываем finalize
                  return
                }
                const finalize = () => {
                  const conv = getConversationFromCache(convId)
                  const participantsCount = conv?.participants?.length ?? 0
                  const isGroupConv = !!(conv?.isGroup || participantsCount > 2)
                  const isDialog = !isGroupConv
                  if (isDialog) {
                    endCall(convId)
                  }
                  setActiveCalls((prev) => {
                    const current = prev[convId]
                    if (!current) return prev
                    if (isGroupConv) {
                      const participants = (current.participants || []).filter((id: string) => (currentUserId ? id !== currentUserId : true))
                      return { ...prev, [convId]: { ...current, participants } }
                    }
                    if (current.active) {
                      return { ...prev, [convId]: { ...current, active: false, endedAt: Date.now() } }
                    }
                    return prev
                  })
                  setCallConvId((prev) => (prev === convId ? null : prev))
                  setMinimizedCallConvId((prev) => (prev === convId ? null : prev))
                  callStore.endCall()
                  stopRingtone()
                }
                if (!options?.manual && isOneToOneConversation(convId)) {
                  scheduleAfterMinCallDuration(convId, finalize)
                } else {
                  clearMinCallDurationGuard(convId)
                  finalize()
                }
              }}
              initialVideo={callStore.initialVideo}
              initialAudio={callStore.initialAudio}
            />
          )}
        </Suspense>
        <ImageEditorModal
          open={!!editingImage}
          image={editingImage}
          onClose={() => setEditingImageId(null)}
          onApply={({ file, previewUrl }) => {
            if (!editingImage) return
            applyComposerImageEdit(editingImage.id, file, previewUrl)
            setEditingImageId(null)
          }}
        />
        {outgoingCall && (() => {
          const conv = conversationsQuery.data?.find((r: any) => r.conversation.id === outgoingCall.conversationId)?.conversation
          const isGroup = conv?.isGroup || (conv?.participants?.length ?? 0) > 2
          // Не показываем экран дозвона для групповых бесед
          if (isGroup) {
            return null
          }
          let displayName = 'Неизвестный'
          let avatarUrl: string | undefined = undefined
          let avatarId: string = outgoingCall.conversationId
          if (isGroup) {
            displayName = conv?.title ?? 'Группа'
            avatarUrl = conv?.avatarUrl
            avatarId = outgoingCall.conversationId
          } else {
            const otherParticipant = conv?.participants?.find((p: any) => p.user.id !== me?.id)?.user
            if (otherParticipant) {
              displayName = otherParticipant.displayName ?? otherParticipant.username ?? otherParticipant.id ?? 'Неизвестный'
              avatarUrl = otherParticipant.avatarUrl
              avatarId = otherParticipant.id
            } else {
              // Fallback: попробуем получить из contacts
              const contact = contactsQuery.data?.find((c: any) => {
                const convIds = c.conversationIds || []
                return convIds.includes(outgoingCall.conversationId)
              })
              if (contact?.friend) {
                displayName = contact.friend.displayName ?? contact.friend.username ?? contact.friend.id ?? 'Неизвестный'
                avatarUrl = contact.friend.avatarUrl
                avatarId = contact.friend.id
              }
            }
          }
          const elapsed = Math.floor((Date.now() - outgoingCall.startedAt) / 1000)
          const minutes = Math.floor(elapsed / 60)
          const seconds = elapsed % 60
          const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`
          return createPortal(
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
              <div style={{ background: 'var(--surface-200)', borderRadius: 16, border: '1px solid var(--surface-border)', padding: 24, width: 'min(92vw, 440px)', boxShadow: 'var(--shadow-sharp)', transform: 'translateY(-4vh)', color: 'var(--text-primary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div style={{ fontWeight: 700 }}>{outgoingCall.video ? 'Видеозвонок' : 'Звонок'}</div>
                  {!outgoingCall.minimized && (
                    <button
                      className="btn btn-icon btn-ghost"
                      onClick={() => {
                        setOutgoingCall((prev) => prev ? { ...prev, minimized: true } : null)
                      }}
                      style={{ padding: 8 }}
                    >
                      <Minus size={18} />
                    </button>
                  )}
                </div>
                <div className="caller-tile" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--surface-100)', border: '1px solid var(--surface-border)', borderRadius: 12, marginBottom: 16 }}>
                  <Avatar
                    name={displayName}
                    id={avatarId}
                    size={64}
                    avatarUrl={avatarUrl}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 16 }}>{displayName}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>дозвон…</div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {timeStr}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn"
                    style={{ background: '#ef4444', color: '#fff', flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }}
                    onClick={() => {
                      if (outgoingCallTimerRef.current) {
                        window.clearTimeout(outgoingCallTimerRef.current)
                        outgoingCallTimerRef.current = null
                      }
                      stopDialingSound()
                      playEndCallSound()
                      endCall(outgoingCall.conversationId)
                      setOutgoingCall(null)
                      setActiveCalls((prev) => {
                        const current = prev[outgoingCall.conversationId]
                        if (current?.active) {
                          return { ...prev, [outgoingCall.conversationId]: { ...current, active: false, endedAt: Date.now() } }
                        }
                        const { [outgoingCall.conversationId]: _omit, ...rest } = prev
                        return rest
                      })
                      callStore.endCall()
                    }}
                  >
                    <PhoneOff size={18} />
                    <span>Сбросить</span>
                  </button>
                  {outgoingCall.minimized && (
                    <button
                      className="btn btn-primary"
                      style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }}
                      onClick={() => {
                        setOutgoingCall((prev) => prev ? { ...prev, minimized: false } : null)
                      }}
                    >
                      <Maximize2 size={18} />
                      <span>Развернуть</span>
                    </button>
                  )}
                </div>
              </div>
            </div>, document.body)
        })()}
        {callStore.incoming && createPortal(
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
            <div style={{ background: 'var(--surface-200)', borderRadius: 16, border: '1px solid var(--surface-border)', padding: 24, width: 'min(92vw, 440px)', boxShadow: 'var(--shadow-sharp)', transform: 'translateY(-4vh)', color: 'var(--text-primary)' }}>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>{callStore.incoming.video ? 'Входящий видеозвонок' : 'Входящий аудиозвонок'}</div>
              <div className="caller-tile" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--surface-100)', border: '1px solid var(--surface-border)', borderRadius: 12, marginBottom: 12 }}>
                <Avatar
                  name={(callStore.incoming.from.name ?? callStore.incoming.from.id)}
                  id={callStore.incoming.from.id}
                  size={64}
                  avatarUrl={
                    callStore.incoming.from.avatarUrl ??
                    (conversationsQuery.data?.find((r: any) => r.conversation.id === callStore.incoming!.conversationId)?.conversation?.participants?.find((p: any) => p.user.id === callStore.incoming!.from.id)?.user?.avatarUrl) ??
                    (contactsQuery.data?.find((c: any) => c.friend?.id === callStore.incoming!.from.id)?.friend?.avatarUrl) ??
                    undefined
                  }
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>{callStore.incoming.from.name ?? callStore.incoming.from.id}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>звонит…</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }} onClick={() => { void acceptIncomingCall(false) }}>
                    <Phone size={18} />
                    <span>Ответить</span>
                  </button>
                  <button className="btn" style={{ background: 'var(--brand)', color: '#fff', flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }} onClick={() => { void acceptIncomingCall(true) }}>
                    <Video size={18} />
                    <span>Ответить с видео</span>
                  </button>
                </div>
                <div style={{ display: 'flex' }}>
                  <button className="btn" style={{ background: '#ef4444', color: '#fff', width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', minHeight: 48, borderRadius: 12 }} onClick={() => { declineIncomingCall() }}>
                    <PhoneOff size={18} />
                    <span>Отмена</span>
                  </button>
                </div>
                {callPermissionError && (
                  <div style={{ marginTop: 12, fontSize: 13, color: '#fca5a5', textAlign: 'center', lineHeight: 1.4 }}>
                    {callPermissionError}
                  </div>
                )}
              </div>
            </div>
          </div>, document.body)
        }
      </section>
    )
  }

  function appendMessageToCache(conversationId: string, msg: any) {
    if (!msg) return
    client.setQueryData(['messages', conversationId], (old: any) => {
      const list = Array.isArray(old) ? [...old] : []
      if (list.some((m: any) => m.id === msg.id)) return list
      list.push(msg)
      list.sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
      return list
    })
  }

  function updateMessageInCache(conversationId: string, msg: any, opts?: { preserveScroll?: boolean }) {
    if (!msg) return
    const el = messagesRef.current
    const preserve = !!opts?.preserveScroll && !!el && !nearBottomRef.current
    const before = preserve && el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight } : null
    client.setQueryData(['messages', conversationId], (old: any) => {
      if (!Array.isArray(old)) return old
      const idx = old.findIndex((m: any) => m.id === msg.id)
      if (idx === -1) return old
      const next = [...old]
      next[idx] = { ...next[idx], ...msg }
      return next
    })
    if (preserve && before) {
      requestAnimationFrame(() => {
        const el2 = messagesRef.current
        if (!el2) return
        const delta = el2.scrollHeight - before.scrollHeight
        if (delta > 0) {
          el2.scrollTop = before.scrollTop + delta
        }
      })
    }
  }

  return (
    <>
    {showAudioUnlock && (
      <div className="audio-unlock-overlay">
        <button
          type="button"
          className="audio-unlock-button"
          onClick={() => {
            // Optimistically close overlay so UX doesn't "hang" on iOS while audio loads/plays.
            setShowAudioUnlock(false)
            void performAudioUnlock().then((ok) => {
              if (!ok) {
                // If unlock didn't succeed, show the button again so user can retry.
                setShowAudioUnlock(true)
              }
            })
          }}
        >
          Войти
        </button>
        <div className="audio-unlock-hint">Включить звук сообщений и звонков</div>
      </div>
    )}
    <div className={isMobile ? 'chats-page mobile-slider' : 'chats-page'}>
      {isMobile ? (
        <div
          className="slider-inner"
          style={{ transform: `translateX(${mobileView === 'conversation' ? '-100vw' : '0'})` }}
          onTouchStart={(e) => { const t = e.touches[0]; touchStartRef.current = { x: t.clientX, y: t.clientY }; touchDeltaRef.current = 0; }}
          onTouchMove={(e) => { if (!touchStartRef.current) return; const t = e.touches[0]; touchDeltaRef.current = t.clientX - touchStartRef.current.x; }}
          onTouchEnd={() => { const d = touchDeltaRef.current; touchStartRef.current = null; if (Math.abs(d) < 50) return; if (d < 0 && activeId) setMobileView('conversation'); if (d > 0) setMobileView('list'); }}
        >
          {renderConversationList(true)}
          {renderMessagesPane(true)}
        </div>
      ) : (
        <>
          {renderConversationList(false)}
          {renderMessagesPane(false)}
        </>
      )}
    </div>
    {mePopupOpen && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80 }}>
        <div style={{ background: 'var(--surface-200)', padding: 24, borderRadius: 16, width: 440, maxWidth: '90vw', border: '1px solid var(--surface-border)', boxShadow: 'var(--shadow-medium)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>Профиль</div>
            <button className="btn btn-icon btn-ghost" onClick={() => setMePopupOpen(false)}><X size={18} /></button>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center' }}>
            <Avatar name={me?.displayName ?? me?.username ?? 'Me'} id={me?.id ?? 'me'} avatarUrl={avatarPreviewUrl ?? meInfoQuery.data?.avatarUrl ?? undefined} />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{me?.displayName ?? me?.username}</div>
              {(() => {
                const myId = me?.id
                const g = myId ? presenceGameByUserId[myId]?.game : undefined
                if (g?.name) {
                  return (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {g.imageUrl ? <img src={g.imageUrl} alt="" style={{ width: 14, height: 14, borderRadius: 4, objectFit: 'cover' }} /> : null}
                      <span>Играю в {g.name}</span>
                    </div>
                  )
                }
                return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>EBLID: {meInfoQuery.data?.eblid ?? '— — — —'}</div>
              })()}
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setSelectedAvatarFile(file)
            try { setAvatarPreviewUrl(URL.createObjectURL(file)) } catch {}
          }} style={{ display: 'none' }} />
          {!avatarPreviewUrl && (
            <>
              <div style={{ marginBottom: 8, color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>Загрузка аватара</div>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false)
              const file = e.dataTransfer.files?.[0]
              if (file) { setSelectedAvatarFile(file); try { setAvatarPreviewUrl(URL.createObjectURL(file)) } catch {} }
            }}
            style={{
                  border: '2px dashed ' + (dragOver ? 'var(--brand-600)' : 'var(--surface-border)'),
                  borderRadius: 12,
              padding: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              cursor: 'pointer',
                  background: dragOver ? 'rgba(217,119,6,0.1)' : 'var(--surface-100)',
              transition: 'all .2s ease',
                  marginBottom: 16,
            }}
          >
                <UploadCloud size={18} color="var(--text-muted)" />
                <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Перетащите файл сюда или нажмите, чтобы выбрать</div>
          </div>
            </>
          )}
          {avatarPreviewUrl && (
            <div style={{ border: '1px solid var(--surface-border)', borderRadius: 16, padding: 16, marginTop: 16, background: 'var(--surface-100)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12, fontWeight: 600 }}>Настройка аватара</div>
              <div 
                ref={editorRef}
                onWheel={(e) => {
                  e.preventDefault()
                  const delta = -e.deltaY * 0.001
                  const newScale = Math.max(0.1, Math.min(10, crop.scale * (1 + delta)))
                  const rect = editorRef.current?.getBoundingClientRect()
                  if (rect) {
                    const x = e.clientX - rect.left
                    const y = e.clientY - rect.top
                    const scaleChange = newScale / crop.scale
                    const newX = x - (x - crop.x) * scaleChange
                    const newY = y - (y - crop.y) * scaleChange
                    setCrop({ x: newX, y: newY, scale: newScale })
                  }
                }}
                  onPointerDown={(e) => {
                  if (e.pointerType === 'touch') return // Touch обрабатывается в addEventListener
                  const rect = editorRef.current?.getBoundingClientRect()
                  if (!rect) return
                  const editorWidth = rect.width
                  const editorHeight = rect.height
                  const centerX = editorWidth / 2
                  const centerY = editorHeight / 2
                  const cropSizeValue = 240
                  const radius = cropSizeValue / 2
                  const x = e.clientX - rect.left
                  const y = e.clientY - rect.top
                  
                  // Проверяем, что клик внутри круга
                  const dx = x - centerX
                  const dy = y - centerY
                  if (dx * dx + dy * dy > radius * radius) {
                    return
                  }
                  
                    try { (e.currentTarget as any).setPointerCapture?.((e as any).pointerId) } catch {}
                  const startX = e.clientX
                  const startY = e.clientY
                  const start = { ...crop }
                    const onMove = (ev: PointerEvent) => {
                      ev.preventDefault()
                    const deltaX = ev.clientX - startX
                    const deltaY = ev.clientY - startY
                    setCrop({ ...start, x: start.x + deltaX, y: start.y + deltaY })
                    }
                    const onUp = () => {
                      window.removeEventListener('pointermove', onMove as any)
                      window.removeEventListener('pointerup', onUp)
                    }
                    window.addEventListener('pointermove', onMove as any, { passive: false } as any)
                    window.addEventListener('pointerup', onUp, { passive: true } as any)
                }}
                style={{ 
                position: 'relative', 
                width: '100%', 
                height: 320, 
                background: 'var(--surface-200)', 
                overflow: 'hidden', 
                borderRadius: 12, 
                touchAction: 'none',
                border: '1px solid var(--surface-border)',
                boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.1)',
                cursor: 'move'
              }}>
                <img 
                  ref={imageRef}
                  src={avatarPreviewUrl} 
                  alt="preview" 
                  style={{ 
                    position: 'absolute', 
                    left: crop.x, 
                    top: crop.y, 
                    transform: `scale(${crop.scale})`, 
                    transformOrigin: 'top left',
                    willChange: 'transform',
                    pointerEvents: 'none'
                  }} 
                  draggable={false}
                  onLoad={(e) => {
                    const img = e.currentTarget
                    const editor = editorRef.current
                    if (!editor) return
                    const editorWidth = editor.clientWidth
                    const editorHeight = editor.clientHeight
                    const cropSizeValue = 240
                    const imgWidth = img.naturalWidth
                    const imgHeight = img.naturalHeight
                    const centerX = editorWidth / 2
                    const centerY = editorHeight / 2
                    
                    // Рассчитываем масштаб, чтобы изображение максимально заполняло круг
                    const scaleX = cropSizeValue / imgWidth
                    const scaleY = cropSizeValue / imgHeight
                    const initialScale = Math.max(scaleX, scaleY) * 1.2 // 1.2 для запаса
                    
                    // Центрируем изображение относительно центра круга
                    const initialX = centerX - (imgWidth * initialScale) / 2
                    const initialY = centerY - (imgHeight * initialScale) / 2
                    
                    setCrop({ x: initialX, y: initialY, scale: initialScale })
                  }}
                />
                {/* Маска с градиентом для более плавного эффекта */}
                <div style={{ 
                  position: 'absolute', 
                  inset: 0, 
                  pointerEvents: 'none', 
                  borderRadius: '50%', 
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)', 
                  width: 240, 
                  height: 240, 
                  margin: 'auto',
                  border: '2px solid rgba(255,255,255,0.3)',
                  boxSizing: 'border-box'
                }} />
                {/* Сетка для лучшего позиционирования */}
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                  borderRadius: '50%',
                  width: 240,
                  height: 240,
                  margin: 'auto',
                  background: `
                    linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px),
                    linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)
                  `,
                  backgroundSize: '60px 60px',
                  opacity: 0.5
                }} />
              </div>
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>Масштаб</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface-200)', padding: '4px 8px', borderRadius: 6 }}>
                    {Math.round(crop.scale * 100)}%
              </div>
                </div>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setCrop((c) => ({ ...c, scale: Math.max(0.1, c.scale - 0.1) }))}>−</div>
                  <input 
                    type="range" 
                    min={0.1} 
                    max={10} 
                    step={0.05} 
                    value={crop.scale} 
                    onChange={(e) => setCrop((c) => ({ ...c, scale: parseFloat(e.target.value) }))} 
                    style={{ 
                      flex: 1, 
                      height: 6,
                      background: 'var(--surface-200)',
                      borderRadius: 3,
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  />
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setCrop((c) => ({ ...c, scale: Math.min(10, c.scale + 0.1) }))}>+</div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
                  <div style={{ flex: 1, textAlign: 'center', padding: '6px', background: 'var(--surface-200)', borderRadius: 6 }}>
                    {isMobile ? 'Два пальца для масштаба, один для перемещения' : 'Перетащите для перемещения, колесико мыши для масштаба'}
                  </div>
                </div>
              </div>
              <canvas ref={cropCanvasRef} width={240} height={240} style={{ display: 'none' }} />
            </div>
          )}
          {selectedAvatarFile && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn btn-secondary" onClick={() => { setSelectedAvatarFile(null); if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl); setAvatarPreviewUrl(null) }}>Отмена</button>
              <button className="btn btn-primary" disabled={uploadingAvatar} onClick={async () => {
                if (!selectedAvatarFile) return
                setUploadingAvatar(true)
                setUploadProgress(0)
                try {
                  let blobToSend: Blob | null = null
                  if (cropCanvasRef.current && avatarPreviewUrl) {
                    const img = await new Promise<HTMLImageElement>((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.src = avatarPreviewUrl })
                    const ctx = cropCanvasRef.current.getContext('2d')!
                    const size = 240
                    ctx.clearRect(0,0,size,size)
                    ctx.save()
                    ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI*2); ctx.closePath(); ctx.clip()
                    const vw = editorRef.current?.clientWidth ?? 320
                    const vh = editorRef.current?.clientHeight ?? 320
                    const viewportCenter = { x: vw / 2, y: vh / 2 }
                    const viewRect = { x: viewportCenter.x - size/2, y: viewportCenter.y - size/2, w: size, h: size }
                    const srcX = (viewRect.x - crop.x) / crop.scale
                    const srcY = (viewRect.y - crop.y) / crop.scale
                    const srcW = viewRect.w / crop.scale
                    const srcH = viewRect.h / crop.scale
                    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size, size)
                    ctx.restore()
                    blobToSend = await new Promise<Blob | null>((resolve) => cropCanvasRef.current!.toBlob((b) => resolve(b), 'image/png'))
                  }
                  const form = new FormData()
                  form.append('file', blobToSend ?? selectedAvatarFile)
                  const url = await new Promise<string>((resolve, reject) => {
                    const xhr = new XMLHttpRequest()
                    xhr.open('POST', '/api/upload')
                    try { const token = useAppStore.getState().session?.accessToken; if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`) } catch {}
                    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadProgress(Math.round(100 * e.loaded / e.total)) }
                    xhr.onreadystatechange = () => {
                      if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.status < 300) {
                          try { const resp = JSON.parse(xhr.responseText); resolve(resp.url) } catch (err) { reject(err) }
                        } else reject(new Error('upload failed'))
                      }
                    }
                    xhr.send(form)
                  })
                  await api.patch('/status/me', { avatarUrl: url })
                  setSelectedAvatarFile(null)
                  if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl)
                  setAvatarPreviewUrl(null)
                  meInfoQuery.refetch()
                } catch {}
                setUploadingAvatar(false)
                setUploadMessage('Готово')
                setTimeout(() => setUploadMessage(null), 2200)
              }}>{uploadingAvatar ? 'Загрузка...' : 'Загрузить'}</button>
            </div>
          )}
          {uploadingAvatar && (
            <div style={{ height: 8, background: 'var(--surface-100)', borderRadius: 6, overflow: 'hidden', marginTop: 12 }}>
              <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--brand)', transition: 'width 0.2s ease' }} />
            </div>
          )}
          {uploadMessage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: '#16a34a', fontSize: 14 }}>
              <CheckCircle size={16} />
              <span>{uploadMessage}</span>
            </div>
          )}
          <div style={{ borderTop: '1px solid var(--surface-border)', marginTop: 24, paddingTop: 20 }}>
            <button 
              className="btn btn-secondary" 
              onClick={async () => {
                try {
                  await api.post('/auth/logout')
                } catch {
                  // Ignore errors during logout
                }
                useAppStore.getState().setSession(null)
                setMePopupOpen(false)
              }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#f87171' }}
            >
              <LogOut size={18} />
              <span>Выйти из Еблуши</span>
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setMePopupOpen(false)}>Закрыть</button>
          </div>
        </div>
      </div>
    )}
    {newGroupAvatarEditorOpen && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10,12,16,0.55)',
          backdropFilter: 'blur(4px) saturate(110%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 85,
        }}
        onClick={() => setNewGroupAvatarEditorOpen(false)}
      >
        <div
          style={{
            background: 'var(--surface-200)',
            padding: 24,
            borderRadius: 16,
            width: 440,
            maxWidth: '90vw',
            border: '1px solid var(--surface-border)',
            boxShadow: 'var(--shadow-medium)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 20,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>Аватар группы</div>
            <button className="btn btn-icon btn-ghost" onClick={() => setNewGroupAvatarEditorOpen(false)}>
              <X size={18} />
            </button>
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center' }}>
            <Avatar
              name={groupTitle.trim() || '?'}
              id="new-group-avatar-preview"
              avatarUrl={newGroupAvatarPreviewUrl ?? undefined}
              size={60}
            />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{groupTitle || 'Новая группа'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Нажмите, чтобы изменить аватар</div>
            </div>
          </div>

          <input
            ref={newGroupFileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              setNewGroupAvatarFile(file)
              if (newGroupAvatarSourceUrl) {
                try {
                  URL.revokeObjectURL(newGroupAvatarSourceUrl)
                } catch {
                  // ignore
                }
              }
              try {
                const url = URL.createObjectURL(file)
                setNewGroupAvatarSourceUrl(url)
              } catch {
                setNewGroupAvatarSourceUrl(null)
              }
              setNewGroupCrop({ x: 0, y: 0, scale: 1 })
            }}
          />

          {!newGroupAvatarSourceUrl && (
            <>
              <div
                onClick={() => newGroupFileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  setNewGroupDragOver(true)
                }}
                onDragLeave={() => setNewGroupDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setNewGroupDragOver(false)
                  const file = e.dataTransfer.files?.[0]
                  if (file) {
                    setNewGroupAvatarFile(file)
                    if (newGroupAvatarSourceUrl) {
                      try {
                        URL.revokeObjectURL(newGroupAvatarSourceUrl)
                      } catch {
                        // ignore
                      }
                    }
                    try {
                      const url = URL.createObjectURL(file)
                      setNewGroupAvatarSourceUrl(url)
                    } catch {
                      setNewGroupAvatarSourceUrl(null)
                    }
                    setNewGroupCrop({ x: 0, y: 0, scale: 1 })
                  }
                }}
                style={{
                  border: '2px dashed ' + (newGroupDragOver ? 'var(--brand-600)' : 'var(--surface-border)'),
                  borderRadius: 12,
                  padding: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  cursor: 'pointer',
                  background: newGroupDragOver ? 'rgba(217,119,6,0.1)' : 'var(--surface-100)',
                  transition: 'all .2s ease',
                  marginBottom: 16,
                }}
              >
                <UploadCloud size={18} color="var(--text-muted)" />
                <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                  Перетащите файл сюда или нажмите, чтобы выбрать
                </div>
              </div>
            </>
          )}

          {newGroupAvatarSourceUrl && (
            <div
              style={{
                border: '1px solid var(--surface-border)',
                borderRadius: 16,
                padding: 16,
                marginTop: 16,
                background: 'var(--surface-100)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              }}
            >
              <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12, fontWeight: 600 }}>
                Настройка аватара
              </div>
              <div
                ref={newGroupEditorRef}
                onWheel={(e) => {
                  e.preventDefault()
                  const delta = -e.deltaY * 0.001
                  const newScale = Math.max(0.1, Math.min(10, newGroupCrop.scale * (1 + delta)))
                  const rect = newGroupEditorRef.current?.getBoundingClientRect()
                  if (rect) {
                    const x = e.clientX - rect.left
                    const y = e.clientY - rect.top
                    const scaleChange = newScale / newGroupCrop.scale
                    const newX = x - (x - newGroupCrop.x) * scaleChange
                    const newY = y - (y - newGroupCrop.y) * scaleChange
                    setNewGroupCrop({ x: newX, y: newY, scale: newScale })
                  }
                }}
                onPointerDown={(e) => {
                  if (e.pointerType === 'touch') return
                  const rect = newGroupEditorRef.current?.getBoundingClientRect()
                  if (!rect) return
                  const editorWidth = rect.width
                  const editorHeight = rect.height
                  const centerX = editorWidth / 2
                  const centerY = editorHeight / 2
                  const cropSizeValue = 240
                  const radius = cropSizeValue / 2
                  const x = e.clientX - rect.left
                  const y = e.clientY - rect.top
                  const dx = x - centerX
                  const dy = y - centerY
                  if (dx * dx + dy * dy > radius * radius) {
                    return
                  }
                  try {
                    ;(e.currentTarget as any).setPointerCapture?.((e as any).pointerId)
                  } catch {
                    // ignore
                  }
                  const startX = e.clientX
                  const startY = e.clientY
                  const start = { ...newGroupCrop }
                  const onMove = (ev: PointerEvent) => {
                    ev.preventDefault()
                    const deltaX = ev.clientX - startX
                    const deltaY = ev.clientY - startY
                    setNewGroupCrop({ ...start, x: start.x + deltaX, y: start.y + deltaY })
                  }
                  const onUp = () => {
                    window.removeEventListener('pointermove', onMove as any)
                    window.removeEventListener('pointerup', onUp)
                  }
                  window.addEventListener('pointermove', onMove as any, { passive: false } as any)
                  window.addEventListener('pointerup', onUp, { passive: true } as any)
                }}
                style={{
                  position: 'relative',
                  width: '100%',
                  height: 320,
                  background: 'var(--surface-200)',
                  overflow: 'hidden',
                  borderRadius: 12,
                  touchAction: 'none',
                  border: '1px solid var(--surface-border)',
                  boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.1)',
                  cursor: 'move',
                }}
              >
                <img
                  ref={newGroupImageRef}
                  src={newGroupAvatarSourceUrl}
                  alt="preview"
                  style={{
                    position: 'absolute',
                    left: newGroupCrop.x,
                    top: newGroupCrop.y,
                    transform: `scale(${newGroupCrop.scale})`,
                    transformOrigin: 'top left',
                    willChange: 'transform',
                    pointerEvents: 'none',
                  }}
                  draggable={false}
                  onLoad={(e) => {
                    const img = e.currentTarget
                    const editor = newGroupEditorRef.current
                    if (!editor) return
                    const editorWidth = editor.clientWidth
                    const editorHeight = editor.clientHeight
                    const cropSizeValue = 240
                    const imgWidth = img.naturalWidth
                    const imgHeight = img.naturalHeight
                    const centerX = editorWidth / 2
                    const centerY = editorHeight / 2
                    const scaleX = cropSizeValue / imgWidth
                    const scaleY = cropSizeValue / imgHeight
                    const initialScale = Math.max(scaleX, scaleY) * 1.2
                    const initialX = centerX - (imgWidth * initialScale) / 2
                    const initialY = centerY - (imgHeight * initialScale) / 2
                    setNewGroupCrop({ x: initialX, y: initialY, scale: initialScale })
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    borderRadius: '50%',
                    boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)',
                    width: 240,
                    height: 240,
                    margin: 'auto',
                    border: '2px solid rgba(255,255,255,0.3)',
                    boxSizing: 'border-box',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    borderRadius: '50%',
                    width: 240,
                    height: 240,
                    margin: 'auto',
                    background: `
                      radial-gradient(circle at center, transparent 55%, rgba(17,24,39,0.9) 60%),
                      linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px),
                      linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)
                    `,
                    backgroundSize: '100% 100%, 16px 16px, 16px 16px',
                    mixBlendMode: 'soft-light',
                  }}
                />
              </div>

              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Масштаб</div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      fontSize: 18,
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                    onClick={() =>
                      setNewGroupCrop((c) => ({
                        ...c,
                        scale: Math.max(0.1, c.scale - 0.1),
                      }))
                    }
                  >
                    −
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={4}
                    step={0.01}
                    value={newGroupCrop.scale}
                    onChange={(e) => {
                      const next = parseFloat(e.target.value)
                      const rect = newGroupEditorRef.current?.getBoundingClientRect()
                      if (!rect) {
                        setNewGroupCrop((c) => ({ ...c, scale: next }))
                        return
                      }
                      const centerX = rect.width / 2
                      const centerY = rect.height / 2
                      const scaleChange = next / newGroupCrop.scale
                      const newX = centerX - (centerX - newGroupCrop.x) * scaleChange
                      const newY = centerY - (centerY - newGroupCrop.y) * scaleChange
                      setNewGroupCrop({ x: newX, y: newY, scale: next })
                    }}
                    style={{
                      flex: 1,
                      height: 6,
                      background: 'var(--surface-200)',
                      borderRadius: 3,
                      outline: 'none',
                      cursor: 'pointer',
                    }}
                  />
                  <div
                    style={{
                      fontSize: 18,
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                    onClick={() =>
                      setNewGroupCrop((c) => ({
                        ...c,
                        scale: Math.min(10, c.scale + 0.1),
                      }))
                    }
                  >
                    +
                  </div>
                </div>
              </div>

              <canvas
                ref={newGroupCropCanvasRef}
                width={240}
                height={240}
                style={{ display: 'none' }}
              />
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setNewGroupAvatarEditorOpen(false)
              }}
            >
              Отмена
            </button>
            <button
              className="btn btn-primary"
              disabled={!newGroupAvatarSourceUrl}
              onClick={async () => {
                if (!newGroupAvatarSourceUrl || !newGroupCropCanvasRef.current) {
                  setNewGroupAvatarEditorOpen(false)
                  return
                }
                try {
                  const img = await new Promise<HTMLImageElement>((resolve) => {
                    const i = new Image()
                    i.onload = () => resolve(i)
                    i.src = newGroupAvatarSourceUrl
                  })
                  const canvas = newGroupCropCanvasRef.current
                  const ctx = canvas.getContext('2d')
                  if (!ctx) throw new Error('Could not get 2d context')
                  const size = 240
                  ctx.clearRect(0, 0, size, size)
                  ctx.save()
                  ctx.beginPath()
                  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
                  ctx.closePath()
                  ctx.clip()
                  const vw = newGroupEditorRef.current?.clientWidth ?? 320
                  const vh = newGroupEditorRef.current?.clientHeight ?? 320
                  const viewportCenter = { x: vw / 2, y: vh / 2 }
                  const viewRect = {
                    x: viewportCenter.x - size / 2,
                    y: viewportCenter.y - size / 2,
                    w: size,
                    h: size,
                  }
                  const srcX = (viewRect.x - newGroupCrop.x) / newGroupCrop.scale
                  const srcY = (viewRect.y - newGroupCrop.y) / newGroupCrop.scale
                  const srcW = viewRect.w / newGroupCrop.scale
                  const srcH = viewRect.h / newGroupCrop.scale
                  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size, size)
                  ctx.restore()
                  const blob = await new Promise<Blob | null>((resolve) =>
                    canvas.toBlob((b) => resolve(b), 'image/png'),
                  )
                  if (blob) {
                    if (newGroupAvatarPreviewUrl) {
                      try {
                        URL.revokeObjectURL(newGroupAvatarPreviewUrl)
                      } catch {
                        // ignore
                      }
                    }
                    const url = URL.createObjectURL(blob)
                    setNewGroupAvatarBlob(blob)
                    setNewGroupAvatarPreviewUrl(url)
                  }
                } catch {
                  // ignore errors, just close
                } finally {
                  setNewGroupAvatarEditorOpen(false)
                }
              }}
            >
              Сохранить
            </button>
          </div>
        </div>
      </div>
    )}

    {newGroupOpen && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10,12,16,0.55)',
          backdropFilter: 'blur(4px) saturate(110%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 60,
        }}
        onClick={closeNewGroupModal}
      >
        <div
          style={{
            background: 'var(--surface-200)',
            padding: 16,
            borderRadius: 10,
            width: 520,
            border: '1px solid var(--surface-border)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
              color: 'var(--text-primary)',
            }}
          >
            <div style={{ fontWeight: 700 }}>Создать групповой чат</div>
            <button className="btn btn-icon btn-ghost" onClick={closeNewGroupModal}>
              <X size={16} />
            </button>
          </div>

          {(() => {
            const trimmedTitle = groupTitle.trim()
            const avatarName = trimmedTitle ? trimmedTitle : '?'
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <input
                  placeholder="Название"
                  value={groupTitle}
                  onChange={(e) => setGroupTitle(e.target.value)}
                  style={{
                    flex: 1,
                    width: '100%',
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid var(--surface-border)',
                    background: 'var(--surface-100)',
                    color: 'var(--text-primary)',
                  }}
                />
                <input
                  ref={newGroupFileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setNewGroupAvatarFile(file)
                    if (newGroupAvatarSourceUrl) {
                      try {
                        URL.revokeObjectURL(newGroupAvatarSourceUrl)
                      } catch {
                        // ignore
                      }
                    }
                    try {
                      const url = URL.createObjectURL(file)
                      setNewGroupAvatarSourceUrl(url)
                    } catch {
                      setNewGroupAvatarSourceUrl(null)
                    }
                    // Открываем редактор после выбора файла
                    setNewGroupAvatarEditorOpen(true)
                  }}
                />
                <button
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => setNewGroupAvatarEditorOpen(true)}
                  title="Выбрать аватар группы"
                  style={{ borderRadius: '50%', padding: 0, width: 44, height: 44, flexShrink: 0 }}
                >
                  <Avatar
                    name={avatarName}
                    id="new-group-avatar"
                    avatarUrl={newGroupAvatarPreviewUrl ?? undefined}
                    size={40}
                  />
                </button>
              </div>
            )
          })()}

          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Выберите участников</div>
          <div
            style={{
              maxHeight: 280,
              overflow: 'auto',
              display: 'grid',
              gridTemplateColumns: '1fr',
              gap: 8,
            }}
          >
            {contactsQuery.data?.map((c: any) => {
              const u = c.friend
              const checked = selectedIds.includes(u.id)
              return (
                <div
                  key={c.id}
                  className="tile"
                  onClick={() =>
                    setSelectedIds((prev) => (checked ? prev.filter((id) => id !== u.id) : [...prev, u.id]))
                  }
                  style={{ cursor: 'pointer', borderColor: checked ? 'var(--brand-600)' : undefined }}
                >
                  <Avatar
                    name={u.displayName ?? u.username}
                    id={u.id}
                    presence={avatarPresenceForUser(u)}
                    avatarUrl={u.avatarUrl ?? undefined}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>{u.displayName ?? u.username}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      {checked ? 'Выбрано' : 'Нажмите, чтобы выбрать'}
                    </div>
                  </div>
                  <div style={{ marginLeft: 'auto' }}>
                    <input type="checkbox" readOnly checked={checked} />
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              className="btn btn-primary"
              disabled={selectedIds.length === 0 || creatingGroup}
              onClick={async () => {
                if (selectedIds.length === 0 || creatingGroup) return
                setCreatingGroup(true)
                try {
                  const resp = await api.post('/conversations', {
                    participantIds: selectedIds,
                    title: groupTitle || undefined,
                    isGroup: true,
                  })
                  const convId = resp.data?.conversation?.id as string | undefined

                  if (convId && (newGroupAvatarBlob || newGroupAvatarFile)) {
                    try {
                      const form = new FormData()
                      form.append('file', newGroupAvatarBlob ?? newGroupAvatarFile!)
                      const url = await new Promise<string>((resolve, reject) => {
                        const xhr = new XMLHttpRequest()
                        xhr.open('POST', '/api/upload')
                        try {
                          const token = useAppStore.getState().session?.accessToken
                          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
                        } catch {
                          // ignore
                        }
                        xhr.onreadystatechange = () => {
                          if (xhr.readyState === 4) {
                            if (xhr.status >= 200 && xhr.status < 300) {
                              try {
                                const data = JSON.parse(xhr.responseText)
                                resolve(data.url)
                              } catch (err) {
                                reject(err)
                              }
                            } else {
                              reject(new Error(`upload failed: ${xhr.status} ${xhr.statusText}`))
                            }
                          }
                        }
                        xhr.onerror = () => reject(new Error('Network error during upload'))
                        xhr.send(form)
                      })
                      await api.patch(`/conversations/${convId}`, { avatarUrl: url })
                    } catch (avatarErr) {
                      console.error('Error setting group avatar:', avatarErr)
                      // Не блокируем создание беседы из-за ошибок аватара
                    }
                  }

                  client.invalidateQueries({ queryKey: ['conversations'] })
                  if (resp.data?.conversation?.id) {
                    selectConversation(resp.data.conversation.id)
                  }
                  closeNewGroupModal()
                } catch (err: any) {
                  console.error('Error creating group:', err)
                  alert(err?.response?.data?.message || 'Не удалось создать беседу')
                } finally {
                  setCreatingGroup(false)
                }
              }}
            >
              {creatingGroup ? 'Создание...' : 'Создать'}
            </button>
          </div>
        </div>
      </div>
    )}

    {contactsOpen && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 70 }}>
        <div style={{ background: 'var(--surface-200)', padding: 16, borderRadius: 16, width: 520, border: '1px solid var(--surface-border)', boxShadow: 'var(--shadow-sharp)', color: 'var(--text-primary)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontWeight: 700 }}>Контакты</div>
            <button className="btn btn-icon btn-ghost" onClick={() => setContactsOpen(false)}><X size={16} /></button>
          </div>
          {incomingContactsQuery.data && incomingContactsQuery.data.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Новые запросы</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {incomingContactsQuery.data.map((c: any) => (
                  <div key={c.id} className="tile">
            <Avatar
              name={(c.friend.displayName ?? c.friend.username)}
              id={c.friend.id}
              presence={avatarPresenceForUserIdAndStatus(c.friend.id, c.friend.status)}
              avatarUrl={c.friend.avatarUrl ?? undefined}
            />
                    <div>
                      <div style={{ fontWeight: 600 }}>{c.friend.displayName ?? c.friend.username}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>хочет добавить вас</div>
                    </div>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <button className="btn btn-secondary" onClick={async () => { await api.post('/contacts/respond', { contactId: c.id, action: 'reject' }); incomingContactsQuery.refetch() }}>Отклонить</button>
                      <button className="btn btn-primary" onClick={async () => { await api.post('/contacts/respond', { contactId: c.id, action: 'accept' }); contactsQuery.refetch(); incomingContactsQuery.refetch(); conversationsQuery.refetch() }}>Добавить</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ marginBottom: 8, color: 'var(--text-muted)' }}>Поиск по EBLID</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 12 }}>
            {[0,1,2,3].map((i) => (
              <input
                key={i}
                ref={eblRefs[i]}
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                enterKeyHint="done"
                value={eblDigits[i]}
                onChange={(e) => onChangeDigit(i, e.target.value.replace(/\D/g,'').slice(0,1))}
                maxLength={1}
                style={{ width: 52, height: 56, fontSize: 22, textAlign: 'center', borderRadius: 8, border: '1px solid var(--surface-border)', background: 'var(--surface-100)', color: 'var(--text-primary)' }}
              />
            ))}
          </div>
          {foundUser && (
            <div className="tile" style={{ marginBottom: 12 }}>
              <Avatar
                name={foundUser.displayName ?? foundUser.username}
                id={foundUser.id}
                presence={avatarPresenceForUser(foundUser)}
                avatarUrl={foundUser.avatarUrl ?? undefined}
              />
              <div>
                <div style={{ fontWeight: 600 }}>{foundUser.displayName ?? foundUser.username}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Найден по EBLID</div>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <button disabled={sendingInvite} className="btn btn-primary" onClick={sendInvite}>Добавить</button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Мой EBLID:</div>
            <div style={{ fontWeight: 700 }}>{myEblid || '— — — —'}</div>
            <button className="btn btn-secondary btn-icon" onClick={() => { if (myEblid) navigator.clipboard.writeText(myEblid) }} title="Скопировать EBLID"><Copy size={16} /></button>
          </div>

          <div style={{ marginTop: 16, fontWeight: 700 }}>Мои друзья</div>
          <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(contactsQuery.data || []).map((c: any) => {
              const u = c.friend
              return (
                <div key={c.id} className="tile">
                  <Avatar
                    name={u.displayName ?? u.username}
                    id={u.id}
                    presence={avatarPresenceForUser(u)}
                    avatarUrl={u.avatarUrl ?? undefined}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>{u.displayName ?? u.username}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Контакт</div>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={async () => {
                        await api.post('/contacts/remove', { contactId: c.id })
                        contactsQuery.refetch()
                      }}
                    >
                      Удалить
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={async () => {
                        await initiateSecretChat(u.id)
                        setContactsOpen(false)
                        client.invalidateQueries({ queryKey: ['conversations'] })
                      }}
                    >
                      Секретный чат
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={async () => {
                        const resp = await api.post('/conversations', { participantIds: [u.id], isGroup: false })
                        setContactsOpen(false)
                        selectConversation(resp.data.conversation.id)
                        client.invalidateQueries({ queryKey: ['conversations'] })
                      }}
                    >
                      Открыть чат
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )}
    {contextMenu.open && contextMenu.messageId && (
      <div style={{ position: 'fixed', inset: 0, background: 'transparent', zIndex: 45 }} onClick={() => setContextMenu({ open: false, x: 0, y: 0, messageId: null })}>
        <div
          ref={menuRef}
          className="msg-menu"
          style={{ position: 'absolute', left: contextMenu.x, top: contextMenu.y, color: '#ffffff' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: 'flex', gap: 6, padding: 6, borderBottom: '1px solid var(--surface-border)' }}>
            {['👍','❤️','👎','🔥','🤝','😆'].map((emo, idx) => {
              const isHeart = emo === '❤️'
              const color = isHeart ? '#ef4444' : '#ffffff'
              return (
                <button key={emo} onClick={async () => {
                  try {
                    const mid = contextMenu.messageId!
                    // toggle: если уже есть моя реакция этим эмодзи — удаляем
                    const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
                    const mine = (found?.reactions || []).some((r: any) => r.userId === me?.id && r.emoji === emo)
                    if (mine) await api.post('/messages/unreact', { messageId: mid, emoji: emo })
                    else await api.post('/messages/react', { messageId: mid, emoji: emo })
                    if (activeId) client.invalidateQueries({ queryKey: ['messages', activeId] })
                  } catch {}
                  setContextMenu({ open: false, x: 0, y: 0, messageId: null })
                }} style={{ 
                  fontSize: 16, 
                  color: color, 
                  cursor: 'pointer', 
                  transition: 'transform 0.2s ease', 
                  animation: `reactionPop 0.3s ease ${idx * 0.05}s both`
                }} onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.2)' }} onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}>{emo}</button>
              )
            })}
          </div>
          <button style={{ color: '#ffffff' }} onClick={() => {
            const mid = contextMenu.messageId!
            const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
            setReplyTo({ id: mid, preview: (found?.content ?? '').slice(0, 100) })
            setContextMenu({ open: false, x: 0, y: 0, messageId: null })
          }}>Цитировать</button>
          {(() => {
            const mid = contextMenu.messageId!
            const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
            const canEdit =
              !!found &&
              found?.senderId === me?.id &&
              !found?.deletedAt &&
              (found?.type || 'TEXT') === 'TEXT' &&
              (!found?.attachments || found.attachments.length === 0)
            if (!canEdit) return null
            return (
              <button style={{ color: '#ffffff' }} onClick={() => {
                startEdit(found)
                setContextMenu({ open: false, x: 0, y: 0, messageId: null })
              }}>Редактировать</button>
            )
          })()}
          {(() => {
            const mid = contextMenu.messageId!
            const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
            const canDelete = found?.senderId === me?.id
            if (!canDelete) return null
            return (
              <button style={{ color: '#ffffff' }} onClick={async () => {
                try {
                  await api.post('/messages/delete', { messageId: contextMenu.messageId })
                  if (activeId) client.invalidateQueries({ queryKey: ['messages', activeId] })
                } catch {}
                setContextMenu({ open: false, x: 0, y: 0, messageId: null })
              }}>Удалить</button>
            )
          })()}
          <button style={{ color: '#ffffff' }} onClick={async () => {
            const mid = contextMenu.messageId!
            const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
            try { await navigator.clipboard.writeText(found?.content || '') } catch {}
            setContextMenu({ open: false, x: 0, y: 0, messageId: null })
          }}>Копировать</button>
          <button style={{ color: '#ffffff' }} onClick={() => { setForwardModal({ open: true, messageId: contextMenu.messageId }); setContextMenu({ open: false, x: 0, y: 0, messageId: null }) }}>Переслать</button>
        </div>
      </div>
    )}
    <ImageLightbox
      open={lightbox.open}
      items={lightbox.items}
      index={lightbox.index}
      onClose={() => setLightbox((l) => ({ ...l, open: false }))}
      onIndexChange={(nextIndex) => setLightbox((l) => ({ ...l, index: nextIndex }))}
    />
    {forwardModal.open && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80 }} onClick={() => setForwardModal({ open: false, messageId: null })}>
        <div style={{ background: 'var(--surface-200)', padding: 16, borderRadius: 12, width: 420, border: '1px solid var(--surface-border)', boxShadow: 'var(--shadow-sharp)', color: 'var(--text-primary)' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Переслать сообщение</div>
          <div style={{ maxHeight: 320, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(conversationsQuery.data || []).map((row: any) => {
              const c = row.conversation
              const othersArr = c.participants.filter((p: any) => (currentUserId ? p.user.id !== currentUserId : true)).map((p: any) => p.user)
              const fallbackName = othersArr.map((u: any) => u.displayName ?? u.username).join(', ') || 'Диалог'
              const title = c.title ?? fallbackName
              return (
                <div key={c.id} className="tile" onClick={async () => {
                  const mid = forwardModal.messageId!
                  const found = (displayedMessages || []).find((mm: any) => mm.id === mid)
                  if (!found) return
                  await sendMessageToConversation(c, { type: 'TEXT', content: `↪ ${found.content ?? ''}`, replyToId: undefined })
                  setForwardModal({ open: false, messageId: null })
                }}>
                  <div style={{ fontWeight: 600 }}>{title}</div>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn btn-secondary" onClick={() => setForwardModal({ open: false, messageId: null })}>Отмена</button>
          </div>
        </div>
      </div>
    )}
    {addParticipantsModal && activeConversation && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 70 }} onClick={closeAddParticipantsModal}>
        <div style={{ background: 'var(--surface-200)', padding: 24, borderRadius: 16, width: 440, maxWidth: '90vw', border: '1px solid var(--surface-border)', boxShadow: 'var(--shadow-medium)', color: 'var(--text-primary)' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 20 }}>Добавить участников</div>
            <button className="btn btn-icon btn-ghost" onClick={closeAddParticipantsModal}><X size={18} /></button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[
              { key: 'friends', label: 'Из друзей' },
              { key: 'eblid', label: 'По EBLID' },
            ].map((opt) => {
              const active = addParticipantsMode === opt.key
              return (
                <button
                  key={opt.key}
                  className="btn btn-ghost"
                  onClick={() => setAddParticipantsMode(opt.key as 'friends' | 'eblid')}
                  style={{
                    flex: 1,
                    borderRadius: 999,
                    border: active ? '1px solid var(--brand-500)' : '1px solid var(--surface-border)',
                    background: active ? 'var(--surface-100)' : 'transparent',
                    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            {addParticipantsMode === 'friends'
              ? 'Выберите контакты, которых нужно пригласить в эту беседу.'
              : 'Введите EBLID пользователя, чтобы пригласить его в беседу.'}
          </div>
          {addParticipantsMode === 'friends' ? (
            <div style={{ maxHeight: 320, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {eligibleContactsForAdd.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Все ваши контакты уже находятся в этой беседе.</div>
              ) : (
                eligibleContactsForAdd.map((c: any) => {
                  const u = c.friend
                  const checked = addParticipantsSelectedIds.includes(u.id)
                  return (
                    <div
                      key={c.id}
                      className="tile"
                      onClick={() =>
                        setAddParticipantsSelectedIds((prev) => (checked ? prev.filter((id) => id !== u.id) : [...prev, u.id]))
                      }
                      style={{
                        cursor: 'pointer',
                        borderColor: checked ? 'var(--brand-600)' : undefined,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <Avatar
                        name={u.displayName ?? u.username}
                        id={u.id}
                        presence={avatarPresenceForUser(u)}
                        avatarUrl={u.avatarUrl ?? undefined}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{u.displayName ?? u.username}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {formatPresence(u)}
                        </div>
                      </div>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: '2px solid var(--surface-border)', background: checked ? 'var(--brand-600)' : 'transparent' }} />
                    </div>
                  )
                })
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                {[0, 1, 2, 3].map((i) => (
                  <input
                    key={i}
                    ref={addParticipantsEblRefs[i]}
                    type="tel"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="one-time-code"
                    enterKeyHint="done"
                    value={addParticipantsEblDigits[i]}
                    onChange={(e) => onChangeAddParticipantsDigit(i, e.target.value.replace(/\D/g, '').slice(0, 1))}
                    maxLength={1}
                    style={{
                      width: 56,
                      height: 60,
                      fontSize: 24,
                      textAlign: 'center',
                      borderRadius: 10,
                      border: '1px solid var(--surface-border)',
                      background: 'var(--surface-100)',
                      color: 'var(--text-primary)',
                      fontWeight: 600,
                    }}
                  />
                ))}
              </div>
              {addParticipantsSearching && (
                <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>Ищем пользователя…</div>
              )}
              {addParticipantsFoundUser && (
                <div className="tile" style={{ alignItems: 'center', gap: 12 }}>
                  <Avatar
                    name={addParticipantsFoundUser.displayName ?? addParticipantsFoundUser.username}
                    id={addParticipantsFoundUser.id}
                    presence={avatarPresenceForUserIdAndStatus(addParticipantsFoundUser.id, addParticipantsFoundUser.status)}
                    avatarUrl={addParticipantsFoundUser.avatarUrl ?? undefined}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{addParticipantsFoundUser.displayName ?? addParticipantsFoundUser.username}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {addParticipantsFoundUserStatus.alreadyInChat
                        ? 'Уже в беседе'
                        : addParticipantsFoundUserStatus.isSelf
                        ? 'Это вы'
                        : 'Найден по EBLID'}
                    </div>
                  </div>
                </div>
              )}
              {!addParticipantsFoundUser && addParticipantsSearchError && (
                <div style={{ textAlign: 'center', fontSize: 13, color: '#f87171' }}>{addParticipantsSearchError}</div>
              )}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
            <button className="btn btn-secondary" onClick={closeAddParticipantsModal}>Отмена</button>
            <button
              className="btn btn-primary"
              disabled={
                addParticipantsLoading ||
                (addParticipantsMode === 'friends'
                  ? addParticipantsSelectedIds.length === 0
                  : !addParticipantsFoundUser ||
                    addParticipantsFoundUserStatus.alreadyInChat ||
                    addParticipantsFoundUserStatus.isSelf)
              }
              onClick={addParticipantsMode === 'friends' ? handleAddParticipants : handleAddParticipantByEbl}
            >
              {addParticipantsLoading ? 'Добавление...' : 'Добавить'}
            </button>
          </div>
        </div>
      </div>
    )}
    {convMenu.open && convMenu.conversationId && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'transparent',
          zIndex: 45,
        }}
        onClick={() => setConvMenu({ open: false, x: 0, y: 0, conversationId: null })}
      >
        <div
          ref={convMenuRef}
          className="msg-menu"
          style={{ position: 'absolute', left: convMenu.x, top: convMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const row = (conversationsQuery.data || []).find(
              (r: any) => r.conversation.id === convMenu.conversationId
            )
            const c = row?.conversation || (activeId === convMenu.conversationId ? activeConversation : null)
            const isGroup = !!(c && (c.isGroup || (c.participants?.length ?? 0) > 2))

            const handleClick = async () => {
              try {
                if (isGroup) {
                  await api.delete(`/conversations/${convMenu.conversationId}/participants/me`)
                } else {
                  await api.delete(`/conversations/${convMenu.conversationId}`)
                }
                client.invalidateQueries({ queryKey: ['conversations'] })
                if (activeId === convMenu.conversationId) {
                  setActiveId(null)
                  if (isMobile) setMobileView('list')
                }
              } catch {
                // ignore
              }
              setConvMenu({ open: false, x: 0, y: 0, conversationId: null })
            }

            return (
              <button
                onClick={handleClick}
                style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#ef4444' }}
              >
                {isGroup ? <LogOut size={16} /> : <Trash2 size={16} />}
                {isGroup ? 'Выйти из беседы' : 'Удалить беседу'}
              </button>
            )
          })()}
        </div>
      </div>
    )}
    {headerMenu.open && headerMenu.anchor && activeConversation && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'transparent',
          zIndex: 45,
        }}
        onClick={() => setHeaderMenu({ open: false, anchor: null })}
      >
        <div
          ref={headerMenuRef}
          className="msg-menu"
          style={{ position: 'fixed' }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const isGroup = activeConversation.isGroup || (activeConversation.participants?.length ?? 0) > 2
            const isSecret = !!activeConversation.isSecret && !isGroup
            const peer = !isGroup && activeConversation.participants?.find((p: any) => p.user.id !== currentUserId)?.user

            if (isGroup) {
              return (
                <>
                  <button
                    onClick={() => {
                      setAddParticipantsSelectedIds([])
                      setAddParticipantsMode('friends')
                      setAddParticipantsEblDigits(['', '', '', ''])
                      setAddParticipantsFoundUser(null)
                      setAddParticipantsSearchError(null)
                      setAddParticipantsSearching(false)
                      setAddParticipantsModal(true)
                      setHeaderMenu({ open: false, anchor: null })
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <UserPlus size={16} />
                    Добавить участников
                  </button>
                  <button
                    onClick={async () => {
                      if (!activeId) return
                      try {
                        await api.delete(`/conversations/${activeId}/participants/me`)
                        client.invalidateQueries({ queryKey: ['conversations'] })
                        setActiveId(null)
                        if (isMobile) setMobileView('list')
                      } catch (err) {
                        console.error('Failed to leave conversation:', err)
                      }
                      setHeaderMenu({ open: false, anchor: null })
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#ef4444' }}
                  >
                    <LogOut size={16} />
                    Выйти из беседы
                  </button>
                </>
              )
            } else {
              return (
                <>
                  {!isSecret ? (
                    <button
                      onClick={async () => {
                        if (peer?.id) {
                          await initiateSecretChat(peer.id)
                        }
                        setHeaderMenu({ open: false, anchor: null })
                      }}
                      disabled={secretRequestLoading}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <Lock size={16} />
                      Начать секретный чат
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setEndSecretModalOpen(true)
                        setHeaderMenu({ open: false, anchor: null })
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <Unlock size={16} />
                      Завершить секретный чат
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      if (!activeId) return
                      try {
                        await api.delete(`/conversations/${activeId}`)
                        client.invalidateQueries({ queryKey: ['conversations'] })
                        client.removeQueries({ queryKey: ['messages', activeId] })
                        setActiveId(null)
                        if (isMobile) setMobileView('list')
                      } catch (err) {
                        console.error('Failed to delete conversation:', err)
                      }
                      setHeaderMenu({ open: false, anchor: null })
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#ef4444' }}
                  >
                    <Trash2 size={16} />
                    Удалить чат
                  </button>
                </>
              )
            }
          })()}
        </div>
      </div>
    )}
    {groupAvatarEditor && activeConversation && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,16,0.55)', backdropFilter: 'blur(4px) saturate(110%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80 }} onClick={() => setGroupAvatarEditor(false)}>
        <div style={{ background: 'var(--surface-200)', padding: 24, borderRadius: 16, width: 440, maxWidth: '90vw', border: '1px solid var(--surface-border)', boxShadow: 'var(--shadow-medium)' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>Изменить аватар группы</div>
            <button className="btn btn-icon btn-ghost" onClick={() => setGroupAvatarEditor(false)}><X size={18} /></button>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center' }}>
            <Avatar name={activeConversation.title?.trim()?.charAt(0) || 'Г'} id={activeConversation.id} avatarUrl={groupAvatarPreviewUrl ?? activeConversation.avatarUrl ?? undefined} size={60} />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{activeConversation.title || 'Группа'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Нажмите, чтобы изменить аватар</div>
            </div>
          </div>
          <input ref={groupFileInputRef} type="file" accept="image/*" onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setGroupSelectedAvatarFile(file)
            try { setGroupAvatarPreviewUrl(URL.createObjectURL(file)) } catch {}
          }} style={{ display: 'none' }} />
          {!groupAvatarPreviewUrl && (
            <>
              <div style={{ marginBottom: 8, color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>Загрузка аватара</div>
          <div
                onClick={() => groupFileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setGroupDragOver(true) }}
                onDragLeave={() => setGroupDragOver(false)}
            onDrop={(e) => {
                  e.preventDefault(); setGroupDragOver(false)
              const file = e.dataTransfer.files?.[0]
                  if (file) { setGroupSelectedAvatarFile(file); try { setGroupAvatarPreviewUrl(URL.createObjectURL(file)) } catch {} }
            }}
            style={{
                  border: '2px dashed ' + (groupDragOver ? 'var(--brand-600)' : 'var(--surface-border)'),
                  borderRadius: 12,
              padding: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              cursor: 'pointer',
                  background: groupDragOver ? 'rgba(217,119,6,0.1)' : 'var(--surface-100)',
              transition: 'all .2s ease',
                  marginBottom: 16,
            }}
          >
                <UploadCloud size={18} color="var(--text-muted)" />
                <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Перетащите файл сюда или нажмите, чтобы выбрать</div>
          </div>
            </>
          )}
          {groupAvatarPreviewUrl && (
            <div style={{ border: '1px solid var(--surface-border)', borderRadius: 16, padding: 16, marginTop: 16, background: 'var(--surface-100)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12, fontWeight: 600 }}>Настройка аватара</div>
              <div 
                ref={groupEditorRef}
                onWheel={(e) => {
                  e.preventDefault()
                  const delta = -e.deltaY * 0.001
                  const newScale = Math.max(0.1, Math.min(10, groupCrop.scale * (1 + delta)))
                  const rect = groupEditorRef.current?.getBoundingClientRect()
                  if (rect) {
                    const x = e.clientX - rect.left
                    const y = e.clientY - rect.top
                    const scaleChange = newScale / groupCrop.scale
                    const newX = x - (x - groupCrop.x) * scaleChange
                    const newY = y - (y - groupCrop.y) * scaleChange
                    setGroupCrop({ x: newX, y: newY, scale: newScale })
                  }
                }}
                  onPointerDown={(e) => {
                  if (e.pointerType === 'touch') return // Touch обрабатывается в addEventListener
                  const rect = groupEditorRef.current?.getBoundingClientRect()
                  if (!rect) return
                  const editorWidth = rect.width
                  const editorHeight = rect.height
                  const centerX = editorWidth / 2
                  const centerY = editorHeight / 2
                  const cropSizeValue = 240
                  const radius = cropSizeValue / 2
                  const x = e.clientX - rect.left
                  const y = e.clientY - rect.top
                  
                  // Проверяем, что клик внутри круга
                  const dx = x - centerX
                  const dy = y - centerY
                  if (dx * dx + dy * dy > radius * radius) {
                    return
                  }
                  
                    try { (e.currentTarget as any).setPointerCapture?.((e as any).pointerId) } catch {}
                  const startX = e.clientX
                  const startY = e.clientY
                  const start = { ...groupCrop }
                    const onMove = (ev: PointerEvent) => {
                      ev.preventDefault()
                    const deltaX = ev.clientX - startX
                    const deltaY = ev.clientY - startY
                    setGroupCrop({ ...start, x: start.x + deltaX, y: start.y + deltaY })
                    }
                    const onUp = () => {
                      window.removeEventListener('pointermove', onMove as any)
                      window.removeEventListener('pointerup', onUp)
                    }
                    window.addEventListener('pointermove', onMove as any, { passive: false } as any)
                    window.addEventListener('pointerup', onUp, { passive: true } as any)
                }}
                style={{ 
                position: 'relative', 
                width: '100%', 
                height: 320, 
                background: 'var(--surface-200)', 
                overflow: 'hidden', 
                borderRadius: 12, 
                touchAction: 'none',
                border: '1px solid var(--surface-border)',
                boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.1)',
                cursor: 'move'
              }}>
                <img 
                  ref={groupImageRef}
                  src={groupAvatarPreviewUrl} 
                  alt="preview" 
                  style={{ 
                    position: 'absolute', 
                    left: groupCrop.x, 
                    top: groupCrop.y, 
                    transform: `scale(${groupCrop.scale})`, 
                    transformOrigin: 'top left',
                    willChange: 'transform',
                    pointerEvents: 'none'
                  }} 
                  draggable={false}
                  onLoad={(e) => {
                    const img = e.currentTarget
                    const editor = groupEditorRef.current
                    if (!editor) return
                    const editorWidth = editor.clientWidth
                    const editorHeight = editor.clientHeight
                    const cropSizeValue = 240
                    const imgWidth = img.naturalWidth
                    const imgHeight = img.naturalHeight
                    const centerX = editorWidth / 2
                    const centerY = editorHeight / 2
                    
                    // Рассчитываем масштаб, чтобы изображение максимально заполняло круг
                    const scaleX = cropSizeValue / imgWidth
                    const scaleY = cropSizeValue / imgHeight
                    const initialScale = Math.max(scaleX, scaleY) * 1.2 // 1.2 для запаса
                    
                    // Центрируем изображение относительно центра круга
                    const initialX = centerX - (imgWidth * initialScale) / 2
                    const initialY = centerY - (imgHeight * initialScale) / 2
                    
                    setGroupCrop({ x: initialX, y: initialY, scale: initialScale })
                  }}
                />
                {/* Маска с градиентом для более плавного эффекта */}
                <div style={{ 
                  position: 'absolute', 
                  inset: 0, 
                  pointerEvents: 'none', 
                  borderRadius: '50%', 
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)', 
                  width: 240, 
                  height: 240, 
                  margin: 'auto',
                  border: '2px solid rgba(255,255,255,0.3)',
                  boxSizing: 'border-box'
                }} />
                {/* Сетка для лучшего позиционирования */}
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                  borderRadius: '50%',
                  width: 240,
                  height: 240,
                  margin: 'auto',
                  background: `
                    linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px),
                    linear-gradient(to bottom, rgba(255,255,255,0.1) 1px, transparent 1px)
                  `,
                  backgroundSize: '60px 60px',
                  opacity: 0.5
                }} />
              </div>
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>Масштаб</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface-200)', padding: '4px 8px', borderRadius: 6 }}>
                    {Math.round(groupCrop.scale * 100)}%
              </div>
                </div>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setGroupCrop((c) => ({ ...c, scale: Math.max(0.1, c.scale - 0.1) }))}>−</div>
                  <input 
                    type="range" 
                    min={0.1} 
                    max={10} 
                    step={0.01} 
                    value={groupCrop.scale} 
                    onChange={(e) => {
                      const newScale = parseFloat(e.target.value)
                      setGroupCrop((prev) => {
                        const rect = groupEditorRef.current?.getBoundingClientRect()
                        if (!rect) return { ...prev, scale: newScale }
                        const editorWidth = rect.width
                        const editorHeight = rect.height
                        const centerX = editorWidth / 2
                        const centerY = editorHeight / 2
                        const img = groupImageRef.current
                        if (img) {
                          const imgWidth = img.naturalWidth
                          const imgHeight = img.naturalHeight
                          const initialCenterX = prev.x + (imgWidth * prev.scale) / 2
                          const initialCenterY = prev.y + (imgHeight * prev.scale) / 2
                          const vectorX = initialCenterX - centerX
                          const vectorY = initialCenterY - centerY
                          const scaleRatio = newScale / prev.scale
                          const newCenterX = centerX + vectorX * scaleRatio
                          const newCenterY = centerY + vectorY * scaleRatio
                          const newX = newCenterX - (imgWidth * newScale) / 2
                          const newY = newCenterY - (imgHeight * newScale) / 2
                          return { x: newX, y: newY, scale: newScale }
                        }
                        return { ...prev, scale: newScale }
                      })
                    }}
                    style={{ flex: 1, height: 6, background: 'var(--surface-200)', borderRadius: 3, outline: 'none', cursor: 'pointer' }}
                  />
                  <div style={{ fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }} onClick={() => setGroupCrop((c) => ({ ...c, scale: Math.min(10, c.scale + 0.1) }))}>+</div>
                </div>
              </div>
              <canvas ref={groupCropCanvasRef} width={240} height={240} style={{ display: 'none' }} />
            </div>
          )}
          {groupSelectedAvatarFile && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => { 
                setGroupSelectedAvatarFile(null)
                if (groupAvatarPreviewUrl) URL.revokeObjectURL(groupAvatarPreviewUrl)
                setGroupAvatarPreviewUrl(null)
                setGroupCrop({ x: 0, y: 0, scale: 1 })
              }}>Отмена</button>
              <button className="btn btn-primary" disabled={uploadingAvatar} onClick={async () => {
                if (!groupSelectedAvatarFile || !activeConversation) return
                setUploadingAvatar(true)
                setUploadProgress(0)
                try {
                  let blobToSend: Blob | null = null
                  if (groupCropCanvasRef.current && groupAvatarPreviewUrl) {
                    const img = await new Promise<HTMLImageElement>((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.src = groupAvatarPreviewUrl })
                    const ctx = groupCropCanvasRef.current.getContext('2d')!
                    if (!ctx) {
                      throw new Error('Could not get 2d context from canvas')
                    }
                    const size = 240
                    ctx.clearRect(0,0,size,size)
                    ctx.save()
                    ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI*2); ctx.closePath(); ctx.clip()
                    const vw = groupEditorRef.current?.clientWidth ?? 320
                    const vh = groupEditorRef.current?.clientHeight ?? 320
                    const viewportCenter = { x: vw / 2, y: vh / 2 }
                    const viewRect = { x: viewportCenter.x - size/2, y: viewportCenter.y - size/2, w: size, h: size }
                    const srcX = (viewRect.x - groupCrop.x) / groupCrop.scale
                    const srcY = (viewRect.y - groupCrop.y) / groupCrop.scale
                    const srcW = viewRect.w / groupCrop.scale
                    const srcH = viewRect.h / groupCrop.scale
                    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size, size)
                    ctx.restore()
                    blobToSend = await new Promise<Blob | null>((resolve) => groupCropCanvasRef.current!.toBlob((b) => resolve(b), 'image/png'))
                  }
                  if (!blobToSend && !groupSelectedAvatarFile) {
                    throw new Error('No file to upload')
                  }
                  const form = new FormData()
                  form.append('file', blobToSend ?? groupSelectedAvatarFile!)
                  const url = await new Promise<string>((resolve, reject) => {
                    const xhr = new XMLHttpRequest()
                    xhr.open('POST', '/api/upload')
                    try { const token = useAppStore.getState().session?.accessToken; if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`) } catch {}
                    xhr.upload.onprogress = (e) => { 
                      if (e.lengthComputable) {
                        setUploadProgress(Math.round(100 * e.loaded / e.total))
                      }
                    }
                    xhr.onreadystatechange = () => {
                      if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.status < 300) {
                          try { 
                            const resp = JSON.parse(xhr.responseText)
                            resolve(resp.url) 
                          } catch (err) { 
                            reject(err) 
                          }
                        } else {
                          reject(new Error(`upload failed: ${xhr.status} ${xhr.statusText}`))
                      }
                      }
                    }
                    xhr.onerror = () => {
                      reject(new Error('Network error during upload'))
                    }
                    xhr.send(form)
                  })
                  await api.patch(`/conversations/${activeConversation.id}`, { avatarUrl: url })
                  // Обновляем данные беседы оптимистично
                  client.setQueryData(['conversations'], (old: any) => {
                    if (!Array.isArray(old)) return old
                    return old.map((r: any) => {
                      if (r.conversation?.id === activeConversation.id) {
                        return {
                          ...r,
                          conversation: {
                            ...r.conversation,
                            avatarUrl: url
                          }
                        }
                      }
                      return r
                    })
                  })
                  client.invalidateQueries({ queryKey: ['conversations'] })
                  await conversationsQuery.refetch()
                  setGroupSelectedAvatarFile(null)
                  if (groupAvatarPreviewUrl) URL.revokeObjectURL(groupAvatarPreviewUrl)
                  setGroupAvatarPreviewUrl(null)
                  setGroupCrop({ x: 0, y: 0, scale: 1 })
                  setGroupAvatarEditor(false)
                setUploadMessage('Готово')
                setTimeout(() => setUploadMessage(null), 2200)
                } catch (err) {
                  console.error('Error uploading group avatar:', err)
                  setUploadMessage(`Ошибка: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`)
                  setTimeout(() => setUploadMessage(null), 3000)
                } finally {
                  setUploadingAvatar(false)
                }
              }}>{uploadingAvatar ? 'Загрузка...' : 'Загрузить'}</button>
            </div>
          )}
          {uploadingAvatar && (
            <div style={{ height: 6, background: 'var(--surface-100)', borderRadius: 3, overflow: 'hidden', marginTop: 12 }}>
              <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--brand)', transition: 'width 0.2s ease' }} />
            </div>
          )}
          {uploadMessage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: '#16a34a' }}>
              <CheckCircle size={16} />
              <span>{uploadMessage}</span>
            </div>
          )}
        </div>
      </div>
    )}
    {availabilityContext && (
      <AvailabilityOverlay
        isOpen={!!availabilityContext}
        conversationId={availabilityContext.conversationId}
        viewerId={me?.id ?? 'me'}
        peerId={availabilityContext.peerId}
        peerName={availabilityContext.peerName}
        viewerTimeZone={(me as any)?.timezone ?? (me as any)?.timeZone ?? getFallbackTimeZone()}
        peerTimeZone={availabilityContext.peerTimeZone ?? getFallbackTimeZone()}
        onClose={() => setAvailabilityContext(null)}
      />
    )}
    </>
  )
}

function makeParticipantsKey(list: Array<{ user: { id: string } }> | undefined | null): string {
  return (list ?? []).map((p) => p.user.id).sort().join(',')
}



