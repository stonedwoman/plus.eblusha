import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { cloudApi, formatBytes, toCloudError } from '../api'
import type { CloudActivity, CloudFile, CloudFolder, CloudSpace, PresenceEntry } from '../types'
import { joinSpaceRoom, onCloudEvent } from '../realtime'
import { enqueueFiles, parseUploadRefs, useSpaceUploads } from '../uploads/manager'
import { UploadTile } from '../components/UploadTile'
import { TimelineView, Tiles } from '../components/Gallery'
import { Viewer } from '../components/Viewer'
import { MapView } from '../components/MapView'
import { ShareDialog } from '../components/ShareDialog'
import { Avatar, Empty, Modal, SkeletonTiles, useInfiniteSentinel, toast } from '../components/ui'
import type { CloudContext } from './CloudLayout'

type View = 'timeline' | 'files' | 'map' | 'activity'

/** Столько id уходит в один запрос: совпадает с лимитом валидации на сервере. */
const BATCH = 1000

/** Главный экран Space: галерея, файлы, карта, активность — и всё это realtime. */
export default function SpacePage() {
  const { spaceId = '' } = useParams()
  const { me } = useOutletContext<CloudContext>()
  const [params, setParams] = useSearchParams()
  const view = (params.get('view') as View) || 'timeline'
  const folderId = params.get('folder')

  const [space, setSpace] = useState<CloudSpace | null>(null)
  const [presence, setPresence] = useState<PresenceEntry[]>([])
  const [files, setFiles] = useState<CloudFile[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<'' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'>('')
  const [onlyFavorites, setOnlyFavorites] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const dirInput = useRef<HTMLInputElement | null>(null)

  // Только id и дата: список стабилен, пока не изменился состав очереди, поэтому
  // тик прогресса не перерисовывает страницу целиком.
  const uploadRefs = useSpaceUploads(spaceId)
  const uploads = useMemo(() => parseUploadRefs(uploadRefs), [uploadRefs])

  const canEdit = space?.role === 'OWNER' || space?.role === 'EDITOR'
  const isOwner = space?.role === 'OWNER'

  // ── Загрузка данных ──────────────────────────────────────────────────────
  const loadSpace = useCallback(async () => {
    try {
      const { data } = await cloudApi.get<{ space: CloudSpace; presence: PresenceEntry[] }>(`/spaces/${spaceId}`)
      setSpace(data.space)
      setPresence(data.presence)
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }, [spaceId])

  const loadFiles = useCallback(
    async (nextCursor: string | null) => {
      try {
        const { data } = await cloudApi.get<{ files: CloudFile[]; nextCursor: string | null }>('/files', {
          params: {
            spaceId,
            view: onlyFavorites ? 'favorites' : view === 'files' ? 'files' : 'timeline',
            ...(view === 'files' && !onlyFavorites ? { folderId: folderId ?? 'root' } : {}),
            ...(kindFilter ? { kind: kindFilter } : {}),
            ...(query.trim() ? { q: query.trim() } : {}),
            limit: 80,
            ...(nextCursor ? { cursor: nextCursor } : {}),
          },
        })
        // Дедуп по id обязателен: файл мог уже прилететь realtime-событием, и
        // тогда страница пагинации привозит его второй раз. Именно из-за этого
        // «Выбрать все» насчитывало больше файлов, чем есть в хуяпке.
        setFiles((prev) => {
          if (!nextCursor) return data.files
          const seen = new Set(prev.map((f) => f.id))
          return [...prev, ...data.files.filter((f) => !seen.has(f.id))]
        })
        setCursor(data.nextCursor)
      } catch (err) {
        toast.error(toCloudError(err).message)
      } finally {
        setLoading(false)
      }
    },
    [spaceId, view, folderId, kindFilter, query, onlyFavorites]
  )

  useEffect(() => {
    void loadSpace()
  }, [loadSpace])

  useEffect(() => {
    if (view === 'map' || view === 'activity') return
    setLoading(true)
    const t = setTimeout(() => void loadFiles(null), query ? 280 : 0)
    return () => clearTimeout(t)
  }, [loadFiles, view, query])

  // Счётчики «842 фото · 37 видео» пересчитываются пачкой, а не на каждый файл.
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleStatsRefresh = useCallback(() => {
    if (statsTimer.current) return
    statsTimer.current = setTimeout(() => {
      statsTimer.current = null
      void loadSpace()
    }, 4000)
  }, [loadSpace])
  useEffect(() => () => { if (statsTimer.current) clearTimeout(statsTimer.current) }, [])

  const sentinel = useInfiniteSentinel(() => {
    if (cursor && !loading) void loadFiles(cursor)
  }, Boolean(cursor))

  // ── Realtime ─────────────────────────────────────────────────────────────
  useEffect(() => {
    joinSpaceRoom(spaceId)
    const offs = [
      onCloudEvent('cloud.file.created', (p) => {
        const payload = p as { spaceId: string; file: CloudFile }
        if (payload.spaceId !== spaceId) return
        // Вставляем НА СВОЁ МЕСТО по времени съёмки, а не в начало списка:
        // таймлайн группирует по дням в порядке массива, и файл 2023 года,
        // приклеенный сверху, создавал вторую группу той же даты и выглядел
        // как «ничего не появилось».
        setFiles((prev) => (prev.some((f) => f.id === payload.file.id) ? prev : insertByTakenAt(prev, payload.file)))
        // НЕ дёргаем loadSpace() на каждый файл: при заливке пачки в 400+ штук
        // это 400 запросов с агрегацией по БД — именно они и подвешивали и
        // браузер, и сервер. Счётчики в шапке обновляем пачкой, с задержкой.
        scheduleStatsRefresh()
      }),
      onCloudEvent('cloud.file.ready', (p) => {
        const payload = p as { spaceId: string; file: CloudFile }
        if (payload.spaceId !== spaceId) return
        setFiles((prev) => prev.map((f) => (f.id === payload.file.id ? { ...f, ...payload.file } : f)))
      }),
      onCloudEvent('cloud.file.updated', (p) => {
        const payload = p as { file: CloudFile }
        setFiles((prev) => prev.map((f) => (f.id === payload.file.id ? { ...f, ...payload.file } : f)))
      }),
      onCloudEvent('cloud.file.deleted', (p) => {
        const payload = p as { spaceId: string; fileIds: string[] }
        if (payload.spaceId !== spaceId) return
        setFiles((prev) => prev.filter((f) => !payload.fileIds.includes(f.id)))
      }),
      onCloudEvent('cloud.presence.changed', (p) => {
        const payload = p as { spaceId: string; users: PresenceEntry[] }
        if (payload.spaceId === spaceId) setPresence(payload.users)
      }),
      onCloudEvent('cloud.member.joined', () => void loadSpace()),
      onCloudEvent('cloud.member.left', () => void loadSpace()),
    ]
    return () => {
      offs.forEach((off) => off())
      joinSpaceRoom(null)
    }
  }, [spaceId, loadSpace])

  // ── Drag & drop / вставка из буфера ──────────────────────────────────────
  useEffect(() => {
    if (!canEdit) return
    let depth = 0
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      setDragging(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const dropped = await collectFiles(e.dataTransfer)
      if (dropped.length) void enqueueFiles(dropped, { spaceId, spaceName: space?.name, folderId })
    }
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.files ?? [])
      if (items.length) void enqueueFiles(items, { spaceId, spaceName: space?.name, folderId })
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [canEdit, spaceId, folderId, space?.name])

  const setView = (next: View) => {
    const p = new URLSearchParams(params)
    p.set('view', next)
    if (next !== 'files') p.delete('folder')
    setParams(p, { replace: true })
    setSelection(new Set())
  }

  const onlineIds = useMemo(() => new Set(presence.map((p) => p.userId)), [presence])

  const deleteSelected = async () => {
    const ids = Array.from(selection)
    try {
      // Пачками: запрос на тысячи id упирался в лимит валидации, и удаление
      // молча не срабатывало («Нужен список ids»).
      for (let i = 0; i < ids.length; i += BATCH) {
        await cloudApi.post('/files/delete', { ids: ids.slice(i, i + BATCH) })
      }
      setFiles((prev) => prev.filter((f) => !selection.has(f.id)))
      setSelection(new Set())
      toast.success(ids.length > 1 ? `В корзину: ${ids.length}` : 'Перенесено в корзину')
      void loadSpace()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const downloadSelected = () => {
    const ids = Array.from(selection)
    // URL с тысячами id упрётся в лимит длины строки запроса у nginx. Если
    // выбрано слишком много — честнее отдать архив всей хуяпки целиком.
    if (ids.length > 300) {
      toast.info('Выбрано слишком много — скачиваем архив хуяпки целиком')
      window.location.href = `/api/cloud/files/zip?spaceId=${encodeURIComponent(spaceId)}&all=1`
      return
    }
    window.location.href = `/api/cloud/files/zip?spaceId=${encodeURIComponent(spaceId)}&ids=${ids.join(',')}`
  }

  if (!space) {
    return (
      <div className="cl-page">
        <div className="cl-skeleton" style={{ height: 96, marginBottom: 18 }} />
        <SkeletonTiles />
      </div>
    )
  }

  return (
    <div className="cl-page">
      {/* ── Шапка Space ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <h1 className="cl-h1">{space.name}</h1>
          {space.description ? (
            <div className="cl-muted" style={{ marginTop: 5, fontSize: 14 }}>
              {space.description}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <div className="cl-ava-stack">
              {space.members.map((m) => (
                <Avatar key={m.id} user={m} online={onlineIds.has(m.id)} />
              ))}
            </div>
            <span className="cl-muted" style={{ fontSize: 13 }}>
              {space.members.map((m) => m.displayName || m.username).join(' · ')}
            </span>
          </div>
          {space.stats ? (
            <div className="cl-muted cl-mono" style={{ fontSize: 13, marginTop: 8 }}>
              {space.stats.photos} фото · {space.stats.videos} видео
              {space.stats.others > 0 ? ` · ${space.stats.others} файлов` : ''} · {formatBytes(space.stats.bytes)}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit ? (
            <>
              <button className="cl-btn primary" onClick={() => fileInput.current?.click()}>
                Загрузить
              </button>
              <button className="cl-btn" onClick={() => dirInput.current?.click()} title="Загрузить папку целиком">
                Папку
              </button>
            </>
          ) : null}
          {isOwner ? (
            <button className="cl-btn" onClick={() => setShareOpen(true)}>
              Поделиться
            </button>
          ) : null}
          <a className="cl-btn" href={`/api/cloud/files/zip?spaceId=${encodeURIComponent(spaceId)}&all=1`}>
            Скачать всё
          </a>
        </div>
      </div>

      {/* ── Вкладки и фильтры ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="cl-chips">
          {(['timeline', 'files', 'map', 'activity'] as View[]).map((v) => (
            <button key={v} className={`cl-chip${view === v ? ' is-active' : ''}`} onClick={() => setView(v)}>
              {v === 'timeline' ? 'Таймлайн' : v === 'files' ? 'Файлы' : v === 'map' ? 'Карта' : 'Активность'}
            </button>
          ))}
        </div>
        <div className="cl-spacer" />
        {view !== 'activity' && view !== 'map' ? (
          <>
            <input
              className="cl-input"
              style={{ width: 220 }}
              placeholder="Поиск по имени…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="cl-chips">
              {([['', 'Все'], ['IMAGE', 'Фото'], ['VIDEO', 'Видео'], ['DOCUMENT', 'Документы']] as const).map(([value, label]) => (
                <button
                  key={label}
                  className={`cl-chip${kindFilter === value ? ' is-active' : ''}`}
                  onClick={() => setKindFilter(value as typeof kindFilter)}
                >
                  {label}
                </button>
              ))}
              <button className={`cl-chip${onlyFavorites ? ' is-active' : ''}`} onClick={() => setOnlyFavorites((v) => !v)}>
                ★ Избранное
              </button>
            </div>
          </>
        ) : null}
      </div>

      {/* ── Содержимое ──────────────────────────────────────────────────── */}
      {view === 'activity' ? (
        <ActivityView spaceId={spaceId} />
      ) : view === 'map' ? (
        <MapView
          spaceId={spaceId}
          tileUrl={me.map.tileUrl}
          attribution={me.map.attribution}
          onOpen={(fileId) => {
            const idx = files.findIndex((f) => f.id === fileId)
            if (idx >= 0) setViewerIndex(idx)
            else void openSingle(fileId, setFiles, setViewerIndex)
          }}
        />
      ) : loading ? (
        <SkeletonTiles />
      ) : files.length === 0 ? (
        <Empty
          icon="📷"
          title={query || kindFilter || onlyFavorites ? 'Ничего не найдено' : 'В хуяпке пока нет файлов'}
          text={
            query || kindFilter || onlyFavorites
              ? 'Попробуйте изменить фильтры.'
              : canEdit
                ? 'Перетащите сюда фотографии и видео или нажмите «Загрузить». Порядок в таймлайне строится по времени съёмки, а не по времени загрузки.'
                : 'Владелец ещё ничего не загрузил.'
          }
          action={
            canEdit ? (
              <button className="cl-btn primary" onClick={() => fileInput.current?.click()}>
                Загрузить файлы
              </button>
            ) : null
          }
        />
      ) : view === 'files' ? (
        <FilesBrowser
          spaceId={spaceId}
          folderId={folderId}
          files={files}
          uploads={uploads}
          selection={selection}
          canEdit={canEdit}
          onNavigate={(id) => {
            const p = new URLSearchParams(params)
            p.set('view', 'files')
            if (id) p.set('folder', id)
            else p.delete('folder')
            setParams(p, { replace: true })
          }}
          onOpen={(file) => setViewerIndex(files.findIndex((f) => f.id === file.id))}
          onToggleSelect={(id) => toggleSelect(id, setSelection)}
        />
      ) : (
        <>
          <TimelineView
            files={files}
            uploads={uploads}
            selection={selection}
            selectMode={selection.size > 0}
            onOpen={(file) => setViewerIndex(files.findIndex((f) => f.id === file.id))}
            onToggleSelect={(id) => toggleSelect(id, setSelection)}
          />
          <div ref={sentinel} />
        </>
      )}

      {/* ── Панель выбора ───────────────────────────────────────────────── */}
      {selection.size > 0 ? (
        <div className="cl-selbar">
          <span>Выбрано: {selection.size}</span>
          <button className="cl-btn sm" onClick={() => setSelection(new Set(files.map((f) => f.id)))}>
            Выбрать все
          </button>
          <button className="cl-btn sm" onClick={downloadSelected}>
            Скачать ZIP
          </button>
          {isOwner ? (
            <button className="cl-btn sm" onClick={() => setShareOpen(true)}>
              Поделиться
            </button>
          ) : null}
          {canEdit ? (
            <button className="cl-btn danger sm" onClick={() => void deleteSelected()}>
              Удалить
            </button>
          ) : null}
          <button className="cl-btn ghost sm" onClick={() => setSelection(new Set())}>
            Снять
          </button>
        </div>
      ) : null}

      {dragging ? (
        <div className="cl-drop-overlay">
          <div>Хуяк — и в «{space.name}»</div>
        </div>
      ) : null}

      {viewerIndex !== null && files[viewerIndex] ? (
        <Viewer
          files={files}
          index={viewerIndex}
          spaceId={spaceId}
          canComment={space.role === 'OWNER' || space.role === 'EDITOR' || space.viewerCanComment}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onFileChanged={(file) => setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, ...file } : f)))}
        />
      ) : null}

      {shareOpen ? (
        <ShareDialog
          spaceId={spaceId}
          preselectedFileIds={selection.size > 0 ? Array.from(selection) : undefined}
          onClose={() => setShareOpen(false)}
        />
      ) : null}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (picked.length) void enqueueFiles(picked, { spaceId, spaceName: space.name, folderId })
        }}
      />
      <input
        ref={dirInput}
        type="file"
        multiple
        hidden
        // @ts-expect-error нестандартный атрибут выбора каталога, поддержан всеми актуальными браузерами
        webkitdirectory=""
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (picked.length) void enqueueFiles(picked, { spaceId, spaceName: space.name, folderId })
        }}
      />
    </div>
  )
}

/** Вставка с сохранением хронологии таймлайна (takenAt asc, затем id asc). */
function insertByTakenAt(list: CloudFile[], file: CloudFile): CloudFile[] {
  const at = new Date(file.takenAt).getTime()
  const idx = list.findIndex((f) => {
    const t = new Date(f.takenAt).getTime()
    return t > at || (t === at && f.id > file.id)
  })
  if (idx === -1) return [...list, file]
  return [...list.slice(0, idx), file, ...list.slice(idx)]
}

function toggleSelect(id: string, setSelection: React.Dispatch<React.SetStateAction<Set<string>>>) {
  setSelection((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
}

async function openSingle(
  fileId: string,
  setFiles: React.Dispatch<React.SetStateAction<CloudFile[]>>,
  setViewerIndex: (i: number) => void
) {
  try {
    const { data } = await cloudApi.get<{ file: CloudFile }>(`/files/${fileId}`)
    setFiles((prev) => {
      const next = [data.file, ...prev.filter((f) => f.id !== fileId)]
      return next
    })
    setViewerIndex(0)
  } catch {
    toast.error('Не удалось открыть файл')
  }
}

/** Рекурсивный обход перетащенных каталогов (там, где браузер это умеет). */
async function collectFiles(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return []
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(dt.items ?? [])) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) return Array.from(dt.files ?? [])

  const out: File[] = []
  const walk = async (entry: FileSystemEntry, depth: number): Promise<void> => {
    if (depth > 12 || out.length > 2000) return
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
      )
      if (file) out.push(file)
      return
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])))
        if (batch.length === 0) break
        for (const child of batch) await walk(child, depth + 1)
      }
    }
  }
  for (const entry of entries) await walk(entry, 0)
  return out
}

// ── Файловый браузер с папками ───────────────────────────────────────────────

function FilesBrowser({
  spaceId,
  folderId,
  files,
  uploads,
  selection,
  canEdit,
  onNavigate,
  onOpen,
  onToggleSelect,
}: {
  spaceId: string
  folderId: string | null
  files: CloudFile[]
  uploads: { id: string; at: number }[]
  selection: Set<string>
  canEdit: boolean
  onNavigate: (folderId: string | null) => void
  onOpen: (file: CloudFile) => void
  onToggleSelect: (id: string) => void
}) {
  const [folders, setFolders] = useState<CloudFolder[]>([])
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    try {
      const [foldersRes, crumbsRes] = await Promise.all([
        cloudApi.get<{ folders: CloudFolder[] }>('/folders', { params: { spaceId, parentId: folderId ?? 'root' } }),
        folderId
          ? cloudApi.get<{ breadcrumbs: { id: string; name: string }[] }>(`/folders/${folderId}/breadcrumbs`)
          : Promise.resolve({ data: { breadcrumbs: [] } }),
      ])
      setFolders(foldersRes.data.folders)
      setBreadcrumbs(crumbsRes.data.breadcrumbs)
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }, [spaceId, folderId])

  useEffect(() => {
    void load()
  }, [load])

  const createFolder = async () => {
    if (!newName.trim()) return
    try {
      await cloudApi.post('/folders', { spaceId, parentId: folderId, name: newName.trim() })
      setNewName('')
      setCreating(false)
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="cl-breadcrumbs">
          <button onClick={() => onNavigate(null)}>Корень</button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.id}>
              <span className="cl-muted">/</span>
              <button onClick={() => onNavigate(crumb.id)}>{crumb.name}</button>
            </span>
          ))}
        </div>
        <div className="cl-spacer" />
        {canEdit ? (
          <button className="cl-btn sm" onClick={() => setCreating(true)}>
            + Папка
          </button>
        ) : null}
      </div>

      {folders.length > 0 ? (
        <div className="cl-list" style={{ marginBottom: 16 }}>
          {folders.map((folder) => (
            <div className="cl-row" key={folder.id} onClick={() => onNavigate(folder.id)}>
              <div className="cl-row-thumb">📁</div>
              <div>
                <div className="cl-row-name">{folder.name}</div>
                <div className="cl-row-sub">
                  {folder.fileCount} файлов{folder.childCount ? `, ${folder.childCount} папок` : ''}
                </div>
              </div>
              <div className="cl-row-hide" />
              <div className="cl-row-hide" />
              <div />
            </div>
          ))}
        </div>
      ) : null}

      <div className="cl-tiles dense">
        {uploads.slice(0, 60).map((u) => (
          <UploadTile key={u.id} id={u.id} withPreview={false} />
        ))}
      </div>
      <Tiles
        files={files}
        selection={selection}
        selectMode={selection.size > 0}
        onOpen={onOpen}
        onToggleSelect={onToggleSelect}
        dense
      />

      {creating ? (
        <Modal
          title="Новая папка"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="cl-btn ghost" onClick={() => setCreating(false)}>
                Отмена
              </button>
              <button className="cl-btn primary" onClick={() => void createFolder()} disabled={!newName.trim()}>
                Создать
              </button>
            </>
          }
        >
          <input
            className="cl-input"
            autoFocus
            placeholder="Название папки"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createFolder()}
          />
        </Modal>
      ) : null}
    </>
  )
}

// ── Лента активности ─────────────────────────────────────────────────────────

const ACTIVITY_TEXT: Record<string, (payload: Record<string, unknown>) => string> = {
  SPACE_CREATED: () => 'создал хуяпку',
  SPACE_UPDATED: () => 'изменил настройки хуяпки',
  MEMBER_ADDED: (p) => `добавил участника${p.name ? ` ${p.name}` : ''}`,
  MEMBER_REMOVED: (p) => (p.self ? 'вышел из хуяпки' : 'исключил участника'),
  MEMBER_ROLE_CHANGED: (p) => `изменил роль на ${p.role}`,
  FILES_UPLOADED: (p) => `загрузил ${p.count ?? 1} файл(ов)`,
  FILES_DELETED: (p) => `удалил ${p.count ?? 1} файл(ов)`,
  FILES_RESTORED: (p) => `восстановил ${p.count ?? 1} файл(ов)`,
  FILES_SAVED: (p) => `сохранил к себе ${p.count ?? 1} файл(ов)`,
  FOLDER_CREATED: (p) => `создал папку «${p.name}»`,
  FOLDER_RENAMED: (p) => `переименовал папку в «${p.to}»`,
  FOLDER_DELETED: (p) => `удалил папку «${p.name}»`,
  COMMENT_CREATED: (p) => `оставил комментарий${p.preview ? `: «${String(p.preview).slice(0, 60)}»` : ''}`,
  SHARE_CREATED: () => 'создал публичную ссылку',
  SHARE_REVOKED: () => 'отозвал публичную ссылку',
}

function ActivityView({ spaceId }: { spaceId: string }) {
  const [events, setEvents] = useState<CloudActivity[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    cloudApi
      .get<{ events: CloudActivity[] }>('/activity', { params: { spaceId, limit: 100 } })
      .then(({ data }) => setEvents(data.events))
      .catch((err) => toast.error(toCloudError(err).message))
      .finally(() => setLoading(false))
  }, [spaceId])

  useEffect(() => {
    return onCloudEvent('cloud.activity.created', (p) => {
      const payload = p as { spaceId: string; event: CloudActivity }
      if (payload.spaceId !== spaceId) return
      setEvents((prev) => [payload.event, ...prev.filter((e) => e.id !== payload.event.id)])
    })
  }, [spaceId])

  if (loading) return <div className="cl-skeleton" style={{ height: 200 }} />
  if (events.length === 0) return <Empty title="Активности пока нет" text="Здесь появятся загрузки, комментарии и изменения состава." />

  return (
    <div className="cl-list" style={{ padding: '4px 16px' }}>
      {events.map((event) => (
        <div className="cl-activity-item" key={event.id}>
          <Avatar user={event.actor} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div>
              <strong>{event.actor?.displayName || event.actor?.username || 'Кто-то'}</strong>{' '}
              {(ACTIVITY_TEXT[event.type] ?? (() => event.type))((event.payload ?? {}) as Record<string, unknown>)}
            </div>
            <div className="cl-muted" style={{ fontSize: 12 }}>
              {new Date(event.createdAt).toLocaleString('ru-RU')}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
