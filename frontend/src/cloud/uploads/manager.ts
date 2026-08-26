import * as tus from 'tus-js-client'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { cloudApi, getCloudCsrf } from '../api'
import { identify } from './fingerprint'

/**
 * Очередь загрузок поверх tus-js-client.
 *
 * Что тут важно и почему:
 *  - протокол tus, а не самодельный: клиент сам умеет ретраи с backoff, докачку
 *    после обрыва сети и хранение URL между перезагрузками страницы;
 *  - перед созданием новой загрузки спрашиваем сервер, нет ли уже начатой с тем
 *    же отпечатком, — это и есть докачка «после повторного логина» и «на другом
 *    устройстве»;
 *  - одновременных передач немного (3): 150 параллельных потоков не ускоряют
 *    заливку, а убивают и канал, и сервер;
 *  - скорость сглаживаем EMA, иначе цифра прыгает и ETA бесполезен.
 */
export type UploadPhase =
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'verifying'
  | 'processing'
  | 'done'
  | 'error'
  | 'cancelled'
  /** Файл потерян браузером (перезагрузка/новая сессия) — нужно выбрать заново */
  | 'needs-file'

export type UploadItem = {
  id: string
  name: string
  size: number
  uploaded: number
  phase: UploadPhase
  spaceId: string
  spaceName?: string | null
  folderId: string | null
  /** байт/сек, сглаженная */
  speed: number
  etaSeconds: number
  error?: string | null
  fileId?: string | null
  /** серверный id CloudUploadSession */
  sessionId?: string | null
  uploadUrl?: string | null
  fingerprint?: string | null
  createdAt: number
  /**
   * Сам File — только для локальной миниатюры в плитке. В стор попадает ссылка
   * на уже существующий объект, копирования данных не происходит; после
   * завершения загрузки очищается вместе с элементом очереди.
   */
  localPreviewFile?: File | null
  /**
   * Ориентир для таймлайна, пока сервер не прочитал EXIF: mtime файла. Сервер
   * кладёт в takenAt ровно его же (takenAtSource='client'), поэтому плитка
   * стоит там, где потом появится готовый файл, и не прыгает.
   */
  takenAtGuess: number
}

type UploadInternal = {
  upload?: tus.Upload
  file?: File
  lastTick?: { at: number; bytes: number }
  lastUiAt?: number
}

/*
 * iOS держит выбранные из Photos файлы через временные file-provider handles,
 * а каждый активный XHR ещё буферизует текущий chunk. Три передачи по 16 MiB
 * плюс декодирование локальных миниатюр легко выбивают вкладку из памяти при
 * выборе 100+ фото. На телефонах делаем chunks меньше и оставляем два потока;
 * десктопный быстрый путь не меняется.
 */
const CONSTRAINED_MOBILE =
  typeof navigator !== 'undefined' &&
  (navigator.maxTouchPoints > 1 || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent))

const MAX_PARALLEL = CONSTRAINED_MOBILE ? 2 : 3
const CHUNK_SIZE = (CONSTRAINED_MOBILE ? 4 : 16) * 1024 * 1024
/** Сколько выбранных оригиналов разрешено одновременно декодировать в сетке. */
export const LOCAL_UPLOAD_PREVIEW_LIMIT = CONSTRAINED_MOBILE ? 8 : 40
const SPEED_SMOOTHING = 0.25
/**
 * Как часто прогресс попадает в стор. tus вызывает onProgress десятки раз в
 * секунду на каждую активную передачу; без троттлинга при большой очереди
 * интерфейс уходит в постоянный ререндер и подвисает.
 */
const PROGRESS_UI_THROTTLE_MS = 300

const internals = new Map<string, UploadInternal>()

type UploadStore = {
  items: UploadItem[]
  paused: boolean
  upsert: (item: UploadItem) => void
  /** Вся пачка одним обновлением стора — см. enqueueFiles. */
  upsertMany: (items: UploadItem[]) => void
  patch: (id: string, patch: Partial<UploadItem>) => void
  remove: (id: string) => void
  setPausedAll: (paused: boolean) => void
}

export const useUploadStore = create<UploadStore>((set) => ({
  items: [],
  paused: false,
  upsert: (item) =>
    set((s) => {
      const idx = s.items.findIndex((i) => i.id === item.id)
      if (idx === -1) return { items: [item, ...s.items] }
      const next = s.items.slice()
      next[idx] = { ...next[idx], ...item }
      return { items: next }
    }),
  upsertMany: (incoming) =>
    set((s) => {
      if (incoming.length === 0) return s
      const known = new Set(s.items.map((i) => i.id))
      return { items: [...incoming.filter((i) => !known.has(i.id)).reverse(), ...s.items] }
    }),
  patch: (id, patch) =>
    set((s) => {
      const idx = s.items.findIndex((i) => i.id === id)
      if (idx === -1) return s
      const next = s.items.slice()
      next[idx] = { ...next[idx], ...patch }
      return { items: next }
    }),
  remove: (id) =>
    set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  setPausedAll: (paused) => set({ paused }),
}))

function store() {
  return useUploadStore.getState()
}

/**
 * Сколько файлов пачки оказались уже загруженными. Показываем одним итогом, а
 * не тостом на каждый снимок: при перезаливке папки их бывают сотни.
 */
let duplicatesSeen = 0
export function takeDuplicateCount(): number {
  const n = duplicatesSeen
  duplicatesSeen = 0
  return n
}

function activeCount(): number {
  return store().items.filter((i) => i.phase === 'uploading').length
}

function pump() {
  if (store().paused) return
  /*
   * Стор держит свежие элементы сверху (так их видно на странице загрузок), но
   * передавать надо в порядке выбора. Без reverse() пачка из четырёхсот
   * снимков заливалась с конца: в галерее плитки появлялись вразнобой, и
   * казалось, что порядок случайный.
   */
  const queued = store().items.filter((i) => i.phase === 'queued').reverse()
  let slots = MAX_PARALLEL - activeCount()
  for (const item of queued) {
    if (slots <= 0) break
    const internal = internals.get(item.id)
    if (!internal?.file) {
      store().patch(item.id, { phase: 'needs-file' })
      continue
    }
    slots--
    void startTransfer(item.id)
  }
}

async function startTransfer(id: string) {
  try {
    await startTransferInner(id)
  } catch (err) {
    // Без этого один нечитаемый файл (удалён с диска, отозван доступ, отвалился
    // внешний носитель) навсегда занимал слот очереди: исключение улетало в
    // никуда, фаза оставалась uploading, pump() больше не вызывался.
    store().patch(id, { phase: 'error', error: err instanceof Error ? err.message : 'Не удалось начать передачу' })
    pump()
  }
}

/** Жив ли ещё элемент очереди: пользователь мог отменить его, пока мы ждали ответ. */
function alive(id: string): boolean {
  return internals.has(id)
}

async function startTransferInner(id: string) {
  const item = store().items.find((i) => i.id === id)
  const internal = internals.get(id)
  if (!item || !internal?.file) return
  const file = internal.file

  store().patch(id, { phase: 'uploading', error: null })

  const identity = await identify(file)
  if (!alive(id)) return
  store().patch(id, { fingerprint: identity.fingerprint })

  // Уже начатая загрузка того же файла? Тогда продолжаем её, а не начинаем заново.
  let uploadUrl = item.uploadUrl ?? null
  if (!uploadUrl) {
    try {
      const { data } = await cloudApi.post<{ upload: { id: string; uploadUrl: string; offset: number } | null }>(
        '/uploads/resolve',
        {
          spaceId: item.spaceId,
          folderId: item.folderId,
          fingerprint: identity.fingerprint,
          size: identity.size,
        }
      )
      if (data.upload) {
        uploadUrl = data.upload.uploadUrl
        store().patch(id, { sessionId: data.upload.id, uploaded: data.upload.offset })
      }
    } catch {
      // Сервер не ответил — не беда, создадим новую загрузку
    }
    if (!alive(id)) return
  }

  const csrf = getCloudCsrf() ?? ''
  const upload = new tus.Upload(file, {
    endpoint: '/api/cloud/uploads/tus',
    ...(uploadUrl ? { uploadUrl } : {}),
    chunkSize: CHUNK_SIZE,
    retryDelays: [0, 1000, 3000, 5000, 10_000, 20_000, 30_000],
    removeFingerprintOnSuccess: true,
    metadata: {
      filename: identity.name,
      filetype: identity.type,
      spaceId: item.spaceId,
      folderId: item.folderId ?? 'root',
      fingerprint: identity.fingerprint,
      mtime: String(identity.lastModified),
    },
    headers: { 'X-Cloud-CSRF': csrf },
    onShouldRetry(err) {
      const status = (err as { originalResponse?: { getStatus(): number } }).originalResponse?.getStatus?.() ?? 0
      // 4xx (кроме 409/423/429) — это отказ по существу, повтор ничего не изменит.
      if (status === 409 || status === 423 || status === 429) return true
      if (status >= 400 && status < 500) return false
      return true
    },
    onProgress(bytesUploaded, bytesTotal) {
      const now = Date.now()
      const internalNow = internals.get(id)
      if (!internalNow) return
      const prev = internalNow.lastTick
      let speed = store().items.find((i) => i.id === id)?.speed ?? 0
      if (prev && now > prev.at) {
        const instant = ((bytesUploaded - prev.bytes) * 1000) / (now - prev.at)
        speed = speed > 0 ? speed + SPEED_SMOOTHING * (instant - speed) : instant
      }
      internalNow.lastTick = { at: now, bytes: bytesUploaded }

      // Последний байт показываем всегда, промежуточные — не чаще раза в 300 мс.
      const complete = bytesUploaded >= bytesTotal
      if (!complete && now - (internalNow.lastUiAt ?? 0) < PROGRESS_UI_THROTTLE_MS) return
      internalNow.lastUiAt = now

      const remaining = Math.max(0, bytesTotal - bytesUploaded)
      store().patch(id, {
        uploaded: bytesUploaded,
        size: bytesTotal,
        speed: Math.max(0, speed),
        etaSeconds: speed > 1024 ? remaining / speed : 0,
      })
    },
    onSuccess() {
      // Сеть закончилась, но файл ещё не «готов»: сервер считает SHA-256,
      // определяет тип и строит превью. Прогресс-бар не должен врать про 100%.
      store().patch(id, { phase: 'verifying', speed: 0, etaSeconds: 0, uploaded: file.size })
      pump()
    },
    onError(error) {
      const status = (error as { originalResponse?: { getStatus(): number } }).originalResponse?.getStatus?.() ?? 0
      let message = error.message
      if (status === 507) message = 'В хранилище не хватает места'
      else if (status === 413) message = 'Файл больше разрешённого лимита'
      else if (status === 403) message = 'Нет прав на загрузку в этот Space'
      else if (status === 0) message = 'Связь потеряна — загрузка приостановлена'
      store().patch(id, {
        phase: status === 0 ? 'paused' : 'error',
        error: message || 'Ошибка загрузки',
        speed: 0,
      })
      pump()
    },
    onAfterResponse(req, resp) {
      const location = resp.getHeader('Location')
      if (location) store().patch(id, { uploadUrl: location })
      const session = resp.getHeader('X-Cloud-Upload-Session')
      if (session) store().patch(id, { sessionId: session })
      void req
    },
  })

  const internalRef = internals.get(id)
  if (internalRef) internalRef.upload = upload
  upload.start()
}

/** Добавить файлы в очередь. */
export async function enqueueFiles(
  files: File[],
  ctx: { spaceId: string; spaceName?: string | null; folderId: string | null }
): Promise<void> {
  /*
   * Один и тот же файл, попавший в очередь дважды, — это две передачи одних и
   * тех же байт и две плитки в галерее. Ловим по имени, размеру и mtime: те же
   * три поля, по которым строится отпечаток докачки. Сравниваем и с тем, что
   * уже в очереди (перетащили папку повторно), и внутри самой пачки (файл
   * попал и из каталога, и отдельно).
   */
  const keyOf = (f: { name: string; size: number; lastModified: number }) =>
    `${ctx.spaceId}|${ctx.folderId ?? ''}|${f.name}|${f.size}|${f.lastModified}`
  const known = new Set<string>()
  for (const item of store().items) {
    if (item.phase === 'done' || item.phase === 'cancelled') continue
    const internal = internals.get(item.id)
    if (internal?.file) known.add(keyOf(internal.file))
  }

  const now = Date.now()
  const batch: UploadItem[] = []
  let skipped = 0
  for (const file of files) {
    const key = keyOf(file)
    if (known.has(key)) {
      skipped++
      continue
    }
    known.add(key)
    const id = `up-${now}-${Math.random().toString(36).slice(2, 9)}`
    internals.set(id, { file })
    batch.push({
      id,
      name: file.name,
      size: file.size,
      uploaded: 0,
      phase: 'queued',
      localPreviewFile: file.type.startsWith('image/') ? file : null,
      takenAtGuess: file.lastModified || now,
      spaceId: ctx.spaceId,
      spaceName: ctx.spaceName ?? null,
      folderId: ctx.folderId,
      speed: 0,
      etaSeconds: 0,
      createdAt: now,
    })
  }
  if (skipped > 0) duplicatesSeen += skipped

  /*
   * Одно обновление стора на всю пачку. Прежний upsert в цикле давал 400
   * подписочных уведомлений подряд ещё ДО начала передачи — интерфейс замирал
   * на несколько секунд ровно в момент, когда человек бросил папку в окно.
   */
  store().upsertMany(batch)
  pump()
}

export function pauseUpload(id: string) {
  const internal = internals.get(id)
  internal?.upload?.abort()
  store().patch(id, { phase: 'paused', speed: 0, etaSeconds: 0 })
  const sessionId = store().items.find((i) => i.id === id)?.sessionId
  if (sessionId) void cloudApi.post(`/uploads/${sessionId}/pause`).catch(() => undefined)
  pump()
}

export function resumeUpload(id: string) {
  const item = store().items.find((i) => i.id === id)
  if (!item) return
  const internal = internals.get(id)
  if (!internal?.file) {
    store().patch(id, { phase: 'needs-file' })
    return
  }
  store().patch(id, { phase: 'queued', error: null })
  pump()
}

export function cancelUpload(id: string) {
  const item = store().items.find((i) => i.id === id)
  const internal = internals.get(id)

  /*
   * Состояние чистим СИНХРОННО, до сетевых вызовов.
   *
   * Раньше отмена ждала abort() и DELETE сессии, и всё это время элемент
   * оставался в фазе uploading: слот очереди числился занятым, pump() ничего
   * нового не запускал. Отмена десятка зависших передач подряд заклинивала
   * очередь на минуты, а плитки продолжали висеть на экране.
   */
  internals.delete(id)
  store().remove(id)
  pump()

  void (async () => {
    try {
      await internal?.upload?.abort(true)
    } catch {
      // передача уже мертва — состояние всё равно очищено
    }
    if (item?.sessionId) await cloudApi.delete(`/uploads/${item.sessionId}`).catch(() => undefined)
  })()
}

export function pauseAll() {
  store().setPausedAll(true)
  for (const item of store().items) {
    if (item.phase === 'uploading') {
      internals.get(item.id)?.upload?.abort()
      store().patch(item.id, { phase: 'paused', speed: 0 })
    }
  }
}

export function resumeAll() {
  store().setPausedAll(false)
  for (const item of store().items) {
    if (item.phase === 'paused' || item.phase === 'error') {
      if (internals.get(item.id)?.file) store().patch(item.id, { phase: 'queued', error: null })
      else store().patch(item.id, { phase: 'needs-file' })
    }
  }
  pump()
}

/**
 * Сколько завершённых элементов держим в очереди. Ровно чтобы человек увидел,
 * что последняя пачка дошла, — не больше.
 */
const KEEP_FINISHED = 40

/**
 * Выкинуть лишние завершённые элементы.
 *
 * Завершённые копились в сторе без конца: после заливки трёх тысяч снимков
 * массив items оставался трёхтысячным, а каждый patch() прогресса делает по
 * нему findIndex и slice. К концу большой заливки интерфейс тормозил тем
 * сильнее, чем больше уже загружено, — притом что на экране этих элементов
 * давно не было.
 */
function pruneFinished() {
  const items = store().items
  const finished = items.filter((i) => i.phase === 'done' || i.phase === 'cancelled')
  if (finished.length <= KEEP_FINISHED) return
  // items идут от свежих к старым, значит лишние — хвост списка завершённых.
  for (const item of finished.slice(KEEP_FINISHED)) {
    internals.delete(item.id)
    store().remove(item.id)
  }
}

export function clearFinished() {
  for (const item of store().items) {
    if (item.phase === 'done' || item.phase === 'cancelled') {
      internals.delete(item.id)
      store().remove(item.id)
    }
  }
}

/**
 * Незавершённые загрузки с сервера. Браузер потерял доступ к локальному файлу
 * (перезагрузка, другой компьютер), поэтому такие элементы ждут, пока
 * пользователь выберет исходный файл заново.
 */
export type ServerUpload = {
  id: string
  spaceId: string
  spaceName: string | null
  folderId: string | null
  name: string
  expectedSize: number
  bytesReceived: number
  status: string
  fingerprint: string
  uploadUrl: string
  createdAt: string
  updatedAt: string
  error: string | null
}

export async function loadServerUploads(): Promise<ServerUpload[]> {
  const { data } = await cloudApi.get<{ uploads: ServerUpload[] }>('/uploads')
  return data.uploads
}

/** Подтянуть незавершённые загрузки в очередь как «нужен файл». */
export async function hydrateServerUploads(): Promise<number> {
  const uploads = await loadServerUploads()
  const known = new Set(store().items.map((i) => i.sessionId).filter(Boolean))
  let added = 0
  for (const u of uploads) {
    if (known.has(u.id)) continue
    if (u.status === 'UPLOADED' || u.status === 'VERIFYING') continue
    const id = `srv-${u.id}`
    if (store().items.some((i) => i.id === id)) continue
    internals.set(id, {})
    store().upsert({
      id,
      name: u.name,
      size: u.expectedSize,
      uploaded: u.bytesReceived,
      phase: 'needs-file',
      spaceId: u.spaceId,
      spaceName: u.spaceName,
      folderId: u.folderId,
      speed: 0,
      etaSeconds: 0,
      sessionId: u.id,
      uploadUrl: u.uploadUrl,
      takenAtGuess: new Date(u.createdAt).getTime(),
      fingerprint: u.fingerprint,
      createdAt: new Date(u.createdAt).getTime(),
    })
    added++
  }
  return added
}

/**
 * Пользователь выбрал файл заново для незавершённой загрузки.
 * Проверяем отпечаток — иначе можно молча дописать в старый объект байты
 * совершенно другого файла и получить нечитаемую мешанину.
 */
export async function attachFileToUpload(id: string, file: File): Promise<{ ok: boolean; reason?: string }> {
  const item = store().items.find((i) => i.id === id)
  if (!item) return { ok: false, reason: 'Загрузка не найдена' }
  if (file.size !== item.size) {
    return { ok: false, reason: `Размер не совпадает: ожидается ${item.size} байт` }
  }
  const identity = await identify(file)
  if (item.fingerprint && identity.fingerprint !== item.fingerprint) {
    return { ok: false, reason: 'Это другой файл — отпечаток не совпал' }
  }
  const internal = internals.get(id) ?? {}
  internal.file = file
  internals.set(id, internal)
  store().patch(id, { phase: 'queued', error: null })
  pump()
  return { ok: true }
}

/** Обновление статуса из realtime-события cloud.upload.updated. */
export function applyServerUploadEvent(payload: {
  id: string
  status: string
  bytesReceived?: number
  expectedSize?: number
  fileId?: string
  error?: string
  /** Такой снимок уже лежал в хуяпке — новой карточки не появится. */
  duplicate?: boolean
}) {
  const item = store().items.find((i) => i.sessionId === payload.id || i.id === `srv-${payload.id}`)
  if (!item) return
  const map: Record<string, UploadPhase> = {
    UPLOADING: 'uploading',
    PAUSED: 'paused',
    UPLOADED: 'verifying',
    VERIFYING: 'verifying',
    // PROCESSING = CloudFile уже создан и уехал в галерею отдельным событием.
    // Держать поверх него ещё и плитку загрузки незачем: получилось бы два
    // изображения одного файла. Превью дорисует сама плитка файла.
    PROCESSING: 'done',
    READY: 'done',
    FAILED: 'error',
    CANCELLED: 'cancelled',
  }
  const phase = map[payload.status]
  if (!phase) return
  // Серверный UPLOADING не должен перебивать то, что человек только что сделал
  // локально: событие могло быть отправлено до паузы и прийти после неё.
  if (phase === 'uploading' && item.phase !== 'uploading' && item.phase !== 'queued') return
  if (phase === item.phase && !payload.fileId && !payload.error) return
  store().patch(item.id, {
    phase,
    ...(payload.fileId ? { fileId: payload.fileId } : {}),
    ...(payload.error ? { error: payload.error } : {}),
    ...(phase === 'done' ? { uploaded: item.size, speed: 0, etaSeconds: 0 } : {}),
  })
  // Готовый файл больше не нуждается в локальном превью: отпускаем ссылку на
  // File, иначе браузер держит хендлы на сотни выбранных файлов до перезагрузки.
  if (phase === 'done') {
    store().patch(item.id, { localPreviewFile: null })
    if (payload.duplicate) duplicatesSeen++
    internals.delete(item.id)
    pruneFinished()
  }
  if (phase === 'done' || phase === 'error' || phase === 'cancelled') pump()
}

// ── Селекторы ────────────────────────────────────────────────────────────────
// Компоненты подписываются на СВОЙ элемент по id, а списки получают только
// массив идентификаторов. Иначе любой тик прогресса менял бы ссылку на items
// и перерисовывал всю очередь целиком — при 400+ файлах это заметно на глаз.

export function useUploadItem(id: string): UploadItem | undefined {
  return useUploadStore((s) => s.items.find((i) => i.id === id))
}

/**
 * Что показывать плиткой в галерее: сюда входят и паузы, и ошибки, и ждущие
 * повторного выбора файла — их человек должен видеть.
 */
const ACTIVE_PHASES: UploadPhase[] = ['queued', 'uploading', 'paused', 'verifying', 'processing', 'error', 'needs-file']

/**
 * Что означает «работа идёт»: только фазы, которые сами по себе завершатся.
 * Пауза, ошибка и «нужен файл» ждут человека — считать их занятостью нельзя,
 * иначе фоновый опрос списка крутится вечно, а шапка вечно пишет «загрузка».
 */
const BUSY_PHASES: UploadPhase[] = ['queued', 'uploading', 'verifying', 'processing']

/** Идёт ли заливка хоть куда-нибудь. Булев селектор — не вызывает лишних ререндеров. */
export function useUploadBusy(): boolean {
  return useUploadStore((s) => s.items.some((i) => BUSY_PHASES.includes(i.phase)))
}

/** Идёт ли заливка в конкретную хуяпку. */
export function useSpaceUploadsBusy(spaceId: string): boolean {
  return useUploadStore((s) => s.items.some((i) => i.spaceId === spaceId && BUSY_PHASES.includes(i.phase)))
}

/**
 * Незавершённые загрузки хуяпки: id + дата для места в таймлайне.
 * Прогресс сюда намеренно не входит — иначе список пересобирался бы на каждый
 * тик и перерисовывал всю галерею.
 */
export function useSpaceUploads(spaceId: string): string[] {
  // Строки, а не объекты: useShallow сравнивает элементы по Object.is, и свежие
  // объекты {id, at} на каждом вызове считались бы изменением — мемоизация
  // не работала бы вовсе. Строку компонент разбирает сам, один раз.
  return useUploadStore(
    useShallow((s) =>
      s.items
        .filter((i) => i.spaceId === spaceId && ACTIVE_PHASES.includes(i.phase))
        .map((i) => `${i.id}|${i.takenAtGuess}`)
    )
  )
}

/** Разбор строк селектора в вид, понятный таймлайну. */
export function parseUploadRefs(refs: string[]): { id: string; at: number }[] {
  return refs.map((ref) => {
    const cut = ref.lastIndexOf('|')
    return { id: ref.slice(0, cut), at: Number(ref.slice(cut + 1)) || Date.now() }
  })
}

export function useUploadIds(): string[] {
  return useUploadStore(useShallow((s) => s.items.map((i) => i.id)))
}

export type UploadSummary = {
  total: number
  active: number
  done: number
  failed: number
  needsFile: number
  bytes: number
  totalBytes: number
  speed: number
}

/** Сводка одним объектом: сравнивается поверхностно, ререндер только по факту. */
export function useUploadSummary(): UploadSummary {
  return useUploadStore(
    useShallow((s) => {
      let active = 0
      let done = 0
      let failed = 0
      let needsFile = 0
      let bytes = 0
      let totalBytes = 0
      let speed = 0
      for (const i of s.items) {
        if (i.phase === 'done') done++
        else if (i.phase === 'error') failed++
        else if (i.phase === 'needs-file') needsFile++
        else active++
        bytes += i.uploaded
        totalBytes += i.size
        if (i.phase === 'uploading') speed += i.speed
      }
      return { total: s.items.length, active, done, failed, needsFile, bytes, totalBytes, speed }
    })
  )
}

// ── Сверка с сервером ────────────────────────────────────────────────────────

/**
 * Периодическая сверка незавершённых загрузок с сервером.
 *
 * Realtime — ускоритель, а не источник истины. Если браузер был занят (или
 * вкладка спала, или сокет переподключался), событие о готовности могло не
 * дойти, и плитка висела бы в «проверяем» вечно, хотя сервер давно всё сделал.
 *
 * GET /uploads отдаёт ТОЛЬКО незавершённые сессии. Значит элемент, которого в
 * ответе нет, — уже готов: это и есть надёжный признак завершения, без опроса
 * каждого файла по отдельности.
 */
const RECONCILE_INTERVAL_MS = 6000
let reconcileTimer: ReturnType<typeof setInterval> | null = null

async function reconcileOnce(): Promise<void> {
  const pending = store().items.filter(
    (i) => i.phase === 'verifying' || i.phase === 'processing' || i.phase === 'uploading' || i.phase === 'paused'
  )
  if (pending.length === 0) return

  let server: ServerUpload[]
  try {
    server = await loadServerUploads()
  } catch {
    return // сеть моргнула — попробуем на следующем тике
  }
  const alive = new Map(server.map((u) => [u.id, u]))

  for (const item of pending) {
    if (!item.sessionId) continue
    const row = alive.get(item.sessionId)
    if (!row) {
      // Сессии нет среди незавершённых → сервер её закрыл.
      if (item.phase === 'verifying' || item.phase === 'processing') {
        store().patch(item.id, { phase: 'done', uploaded: item.size, speed: 0, etaSeconds: 0, localPreviewFile: null })
        internals.delete(item.id)
        pruneFinished()
      }
      continue
    }
    if (row.status === 'FAILED') {
      store().patch(item.id, { phase: 'error', error: row.error ?? 'Сервер не смог принять файл' })
    } else if (row.bytesReceived > item.uploaded) {
      store().patch(item.id, { uploaded: row.bytesReceived })
    }
  }
  pump()
}

/*
 * Автовозобновление оборванных сетью загрузок.
 *
 * onError уже переводит элемент в phase='paused' при статусе 0 (обрыв связи —
 * см. выше), но дальше ничего не происходит: pump() пропускает всё, что не в
 * 'queued'. На мобильном сети такое обычное дело (переключение вышки, уход в
 * фон, блокировка экрана), а кнопка «Продолжить» живёт в .cl-head-fold и
 * прячется вместе с шапкой при скролле — застрявшая загрузка была
 * недостижима физически. Здесь же phase='error' НЕ трогаем: это отдельные
 * постоянные причины (413/403/507), их молчаливый повтор при каждом возврате
 * на вкладку был бы просто спамом бесполезных попыток.
 */
function resumeStuck() {
  if (store().paused) return // пользователь поставил на паузу сам — не перебиваем
  let any = false
  for (const item of store().items) {
    if (item.phase !== 'paused') continue
    any = true
    if (internals.get(item.id)?.file) store().patch(item.id, { phase: 'queued', error: null })
    else store().patch(item.id, { phase: 'needs-file' })
  }
  if (any) pump()
}

export function startUploadReconciler(): () => void {
  if (reconcileTimer) return () => undefined
  reconcileTimer = setInterval(() => void reconcileOnce(), RECONCILE_INTERVAL_MS)
  // Возврат к вкладке — самый частый момент, когда состояние успело разойтись.
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      void reconcileOnce()
      resumeStuck()
    }
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', resumeStuck)
  return () => {
    if (reconcileTimer) clearInterval(reconcileTimer)
    reconcileTimer = null
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', resumeStuck)
  }
}
