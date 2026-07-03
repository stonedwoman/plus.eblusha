/**
 * Вложения и файлы в сообщениях: определение типа контента (изображение/видео/
 * аудио/файл), человекочитаемые размер/скорость загрузки, имя файла из URL или
 * Content-Disposition, иконка и подпись для файловой плитки, а также типы
 * «ожидающих» (оптимистичных) вложений/сообщений во время отправки.
 *
 * Всё здесь — чистые функции и типы без привязки к состоянию компонента.
 */

export type AttachmentFileKind =
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

export type AttachmentFileInfo = {
  description: string
  kind: AttachmentFileKind
  badge?: string
}

export const FILE_KIND_UI: Record<
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

export const FILE_EXTENSION_INFO: Record<string, AttachmentFileInfo> = {
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

export function formatAttachmentFileSize(value: unknown): string | null {
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

export const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v']
export const AUDIO_EXTS = ['mp3', 'm4a', 'ogg', 'wav']

export const ATTACH_PROCESSING_MESSAGES = [
  {
    title: '🔐 Шифруем файл (AES-256-GCM)',
    detail: 'Каждый блок защищён отдельной подписью',
  },
  {
    title: '🧩 Разбиваем файл на защищённые блоки',
    detail: 'Каждый блок получает уникальный nonce',
  },
  {
    title: '🛡 Проверяем целостность данных',
    detail: 'Каждый блок имеет криптографический тег',
  },
  {
    title: '💾 Сохраняем зашифрованный файл',
    detail: 'Исходный файл не хранится на сервере',
  },
] as const

export function formatUploadSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  if (unitIndex === 0) return `${Math.round(value)} ${units[unitIndex]}`
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

export function isUploadAbortError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const code = typeof error === 'object' && error && 'code' in error ? String((error as any).code ?? '') : ''
  return /aborted|canceled|cancelled/i.test(message) || code === 'ERR_CANCELED'
}

export function getMediaKind(att: any, metadata?: Record<string, any>): { isVideo: boolean; displayFormat: string } {
  const meta = metadata ?? att?.metadata ?? {}
  const mime = (meta.mime ?? meta.contentType ?? meta.e2ee?.originalType) as string | undefined
  const nameCandidate =
    (meta.originalName ?? meta.name ?? meta.filename ?? att?.key ?? att?.url ?? '') as string
  let ext = (nameCandidate.split('.').pop() || '').toLowerCase()
  if (ext === 'eblusha' && nameCandidate.includes('.')) {
    const withoutEblusha = nameCandidate.slice(0, -('.eblusha'.length))
    ext = (withoutEblusha.split('.').pop() || '').toLowerCase()
  }
  const isVideo =
    (typeof mime === 'string' && mime.toLowerCase().trim().startsWith('video/')) ||
    VIDEO_EXTS.includes(ext)
  let displayFormat = 'VIDEO'
  if (typeof mime === 'string' && mime.trim()) {
    const m = mime.toLowerCase().split(';')[0]?.trim() || ''
    if (m === 'video/mp4') displayFormat = 'MP4'
    else if (m === 'video/webm') displayFormat = 'WEBM'
    else if (m.startsWith('video/')) displayFormat = m.replace('video/', '').toUpperCase().slice(0, 6)
  } else if (ext) {
    displayFormat = ext.toUpperCase()
  }
  return { isVideo, displayFormat }
}

export function inferAttachmentRenderType(att: any, mergedMeta: Record<string, any>): 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE' {
  const t = att?.type
  if (t === 'IMAGE' || t === 'VIDEO' || t === 'AUDIO') return t

  const { isVideo } = getMediaKind(att, mergedMeta)
  if (isVideo) return 'VIDEO'

  const mime = (mergedMeta?.mime ?? att?.metadata?.mime ?? att?.metadata?.e2ee?.originalType) as string | undefined
  if (typeof mime === 'string' && mime.trim()) {
    const m = mime.toLowerCase().trim()
    if (m.startsWith('audio/')) return 'AUDIO'
  }
  const rawName = (mergedMeta?.originalName ?? att?.metadata?.originalName ?? att?.metadata?.e2ee?.originalName) as string | undefined
  const name = (rawName && rawName.trim()) || extractFilenameFromUrl(att?.url) || (typeof att?.url === 'string' ? att.url : '')
  let ext = name.split('.').pop()?.toLowerCase() || ''
  if (ext === 'eblusha' && name.includes('.')) {
    const withoutEblusha = name.slice(0, -('.eblusha'.length))
    ext = withoutEblusha.split('.').pop()?.toLowerCase() || ext
  }
  if (['mp3', 'm4a', 'ogg', 'wav'].includes(ext)) return 'AUDIO'

  return 'FILE'
}

export function extractFilenameFromUrl(rawUrl: string | null | undefined): string | null {
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

export function resolveAttachmentFileName(att: any, metadata: any): string {
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

export function getAttachmentFilePresentation(att: any, metadata: any) {
  const { isVideo, displayFormat } = getMediaKind(att, metadata)
  if (isVideo) {
    const fileName = resolveAttachmentFileName(att, metadata)
    const sizeText = formatAttachmentFileSize(att?.size ?? metadata?.size ?? metadata?.e2ee?.originalSize)
    return { fileName, description: `Видео ${displayFormat}`, sizeText, badge: displayFormat.slice(0, 4), ui: { bg: '#1a1d24', fg: '#94a3b8' } }
  }

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
  const description = info?.description || (ext ? `Файл ${ext.toUpperCase()}` : 'Файл')
  const sizeText = formatAttachmentFileSize(att?.size ?? metadata?.size ?? metadata?.e2ee?.originalSize)
  const displayName = fileName === 'Файл' && ext ? `${fileName}.${ext}` : fileName
  return { fileName: displayName, description, sizeText, badge, ui }
}

export function parseContentDispositionFilename(headerValue: string | null): string | null {
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

export type PendingAttachment = {
  url: string
  type: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO'
  size?: number
  width?: number
  height?: number
  progress?: number
  __pending?: boolean
  metadata?: Record<string, any>
}

export type AttachmentDecryptionEntry = {
  status: 'pending' | 'ready' | 'error'
  url?: string
}

export type AttachmentHeadInfo = {
  fileName?: string
  mime?: string
  size?: number
}

export type PendingComposerImage = {
  id: string
  file: File
  previewUrl: string
  edited: boolean
  fileName: string
  source: 'paste' | 'upload'
}

export type PendingComposerFile = {
  id: string
  file: File
  fileName: string
  size: number
  mime: string
  source: 'drop' | 'upload'
}

export type PendingMessage = {
  id: string
  createdAt: number
  senderId: string
  attachments: PendingAttachment[]
  content?: string
}

export function describeCopyableAttachment(att: any): string | null {
  const metadata = att?.metadata && typeof att.metadata === 'object' ? att.metadata : {}
  const renderType = inferAttachmentRenderType(att, metadata)
  const fileName = resolveAttachmentFileName(att, metadata)

  if (renderType === 'IMAGE') return null
  if (renderType === 'VIDEO') return fileName !== 'Файл' ? `Видео: ${fileName}` : 'Видео'
  if (renderType === 'AUDIO') return fileName !== 'Файл' ? `Аудио: ${fileName}` : 'Аудио'
  return fileName !== 'Файл' ? `Файл: ${fileName}` : 'Файл'
}
