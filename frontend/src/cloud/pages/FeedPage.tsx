import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { cloudApi, toCloudError } from '../api'
import type { CloudFile } from '../types'
import { Tiles } from '../components/Gallery'
import { useDragSelect, type PaintMode } from '../components/dragSelect'
import { Viewer } from '../components/Viewer'
import { Empty, SkeletonTiles, useInfiniteSentinel, toast } from '../components/ui'
import { UploadsPage } from './UploadsPage'

type FeedFile = CloudFile & { spaceName?: string | null }

/** Сквозные экраны поверх всех Space: недавние, избранное, корзина, загрузки. */
export default function FeedPage() {
  const { pathname } = useLocation()
  const view = pathname.endsWith('/trash') ? 'trash' : pathname.endsWith('/uploads') ? 'uploads' : 'recent'

  if (view === 'uploads') return <UploadsPage />
  return <FilesFeed key={view} view={view} />
}

const TITLES: Record<string, { title: string; empty: string }> = {
  recent: { title: 'Недавние', empty: 'Здесь появятся последние загруженные файлы из всех ваших хуяпок.' },
  trash: { title: 'Корзина', empty: 'Удалённые файлы попадают сюда и хранятся 30 дней, после чего исчезают навсегда.' },
}

function FilesFeed({ view }: { view: 'recent' | 'trash' }) {
  const [files, setFiles] = useState<FeedFile[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [done, setDone] = useState(false)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Та же протяжка, что и в хуяпке: сквозные ленты — первое место, где хочется
  // разом отметить десяток кадров.
  const paintSelect = useCallback((id: string, mode: PaintMode) => {
    setSelection((prev) => {
      if (mode === 'add' ? prev.has(id) : !prev.has(id)) return prev
      const next = new Set(prev)
      if (mode === 'add') next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  useDragSelect({ enabled: selection.size > 0, onPaint: paintSelect })

  // Стабильные колбэки: плитка мемоизирована, и новая стрелка на каждый рендер
  // обесценивала бы memo при сотнях плиток в ленте.
  const filesRef = useRef<FeedFile[]>([])
  filesRef.current = files
  const openFile = useCallback((file: CloudFile) => {
    setViewerIndex(filesRef.current.findIndex((f) => f.id === file.id))
  }, [])
  const toggleSelect = useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const load = useCallback(
    async (nextCursor: string | null) => {
      try {
        const { data } = await cloudApi.get<{ files: FeedFile[]; nextCursor: string | null }>('/files/feed', {
          params: { view, limit: 60, ...(nextCursor ? { cursor: nextCursor } : {}) },
        })
        setFiles((prev) => {
          if (!nextCursor) return data.files
          const seen = new Set(prev.map((f) => f.id))
          return [...prev, ...data.files.filter((f) => !seen.has(f.id))]
        })
        setCursor(data.nextCursor)
        setError(null)
        if (!data.nextCursor) setDone(true)
      } catch (err) {
        setError(toCloudError(err).message)
        setDone(true)
      } finally {
        setLoading(false)
      }
    },
    [view]
  )

  useEffect(() => {
    setLoading(true)
    setDone(false)
    void load(null)
  }, [load])

  const sentinel = useInfiniteSentinel(() => {
    if (cursor && !loading) void load(cursor)
  }, Boolean(cursor) && !done)

  const restore = async () => {
    try {
      await cloudApi.post('/files/restore', { ids: Array.from(selection) })
      setFiles((prev) => prev.filter((f) => !selection.has(f.id)))
      setSelection(new Set())
      toast.success('Восстановлено')
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const purge = async () => {
    if (!confirm('Удалить безвозвратно? Это действие нельзя отменить.')) return
    try {
      await cloudApi.post('/files/purge', { ids: Array.from(selection) })
      setFiles((prev) => prev.filter((f) => !selection.has(f.id)))
      setSelection(new Set())
      toast.success('Удалено безвозвратно')
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const meta = TITLES[view]!

  return (
    <div className="cl-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <h1 className="cl-h1">{meta.title}</h1>
        <div className="cl-spacer" />
        {view === 'trash' && files.length > 0 ? (
          <span className="cl-muted" style={{ fontSize: 13 }}>Хранится 30 дней</span>
        ) : null}
      </div>

      {loading ? (
        <SkeletonTiles />
      ) : error ? (
        <Empty
          icon="⚠"
          title="Не удалось загрузить"
          text={error}
          action={
            <button className="cl-btn primary" onClick={() => { setError(null); setLoading(true); void load(null) }}>
              Повторить
            </button>
          }
        />
      ) : files.length === 0 ? (
        <Empty title="Пусто" text={meta.empty} />
      ) : (
        <div className="cl-tl-main">
          <Tiles
            files={files}
            selection={selection}
            selectMode={selection.size > 0}
            onOpen={openFile}
            onToggleSelect={toggleSelect}
          />
          <div ref={sentinel} />
        </div>
      )}

      {selection.size > 0 ? (
        <div className="cl-selbar">
          <span>Выбрано: {selection.size}</span>
          {view === 'trash' ? (
            <>
              <button className="cl-btn sm" onClick={() => void restore()}>
                Восстановить
              </button>
              <button className="cl-btn danger sm" onClick={() => void purge()}>
                Удалить навсегда
              </button>
            </>
          ) : null}
          <button className="cl-btn ghost sm" onClick={() => setSelection(new Set())}>
            Снять
          </button>
        </div>
      ) : null}

      {viewerIndex !== null && files[viewerIndex] ? (
        <Viewer
          files={files}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onFileChanged={(file) => setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, ...file } : f)))}
          readOnly={view === 'trash'}
        />
      ) : null}
    </div>
  )
}
