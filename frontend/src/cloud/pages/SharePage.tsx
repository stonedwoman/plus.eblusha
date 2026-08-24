import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import '../cloud.css'
import { cloudApi, formatBytes, toCloudError } from '../api'
import type { CloudFile, CloudSpace } from '../types'
import { TimelineView } from '../components/Gallery'
import { Viewer } from '../components/Viewer'
import { Empty, SkeletonTiles, Toasts, toast } from '../components/ui'
import { fetchCloudMe } from '../auth'

type ShareInfo = {
  share: {
    publicId: string
    targetType: string
    allowPreview: boolean
    allowDownload: boolean
    expiresAt: string | null
    label: string | null
  }
  space: Pick<CloudSpace, 'id' | 'name' | 'description' | 'dateFrom' | 'dateTo'>
  stats?: { photos: number; videos: number; files: number; bytes: number }
}

/**
 * Публичная страница ссылки.
 *
 * Секрет живёт во фрагменте URL (#t=...), который браузер не отправляет серверу.
 * Здесь он один раз обменивается на короткую HttpOnly-сессию, после чего сразу
 * вычищается из адресной строки через history.replaceState — чтобы не утечь ни
 * в Referer, ни в историю, ни в закладку, отправленную кому-то ещё.
 */
export default function SharePage() {
  const { publicId = '' } = useParams()
  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [files, setFiles] = useState<CloudFile[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'password' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [password, setPassword] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [signedIn, setSignedIn] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadFiles = useCallback(
    async (nextCursor: string | null) => {
      const { data } = await cloudApi.get<{ files: CloudFile[]; nextCursor: string | null }>(
        `/public/${publicId}/files`,
        { params: { limit: 80, ...(nextCursor ? { cursor: nextCursor } : {}) } }
      )
      setFiles((prev) => (nextCursor ? [...prev, ...data.files] : data.files))
      setCursor(data.nextCursor)
    },
    [publicId]
  )

  const exchange = useCallback(
    async (rawSecret: string, pwd?: string) => {
      try {
        const { data } = await cloudApi.post<ShareInfo>(`/public/${publicId}/session`, {
          secret: rawSecret,
          ...(pwd ? { password: pwd } : {}),
        })
        // Секрет больше не нужен в URL — стираем его немедленно.
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
        const { data: full } = await cloudApi.get<ShareInfo>(`/public/${publicId}`)
        setInfo(full)
        await loadFiles(null)
        setStatus('ready')
      } catch (err) {
        const e = toCloudError(err)
        if (e.code === 'PASSWORD_REQUIRED') {
          setStatus('password')
          setMessage(pwd ? 'Неверный пароль' : '')
          return
        }
        setStatus('error')
        setMessage(e.message)
      }
    },
    [publicId, loadFiles]
  )

  useEffect(() => {
    const fragment = window.location.hash.startsWith('#t=') ? decodeURIComponent(window.location.hash.slice(3)) : ''
    setSecret(fragment || null)
    void fetchCloudMe()
      .then((me) => setSignedIn(Boolean(me)))
      .catch(() => setSignedIn(false))

    if (fragment) {
      void exchange(fragment)
      return
    }
    // Ссылку открыли без секрета — возможно, сессия просмотра ещё жива.
    cloudApi
      .get<ShareInfo>(`/public/${publicId}`)
      .then(async ({ data }) => {
        setInfo(data)
        await loadFiles(null)
        setStatus('ready')
      })
      .catch(() => {
        setStatus('error')
        setMessage('Ссылка открыта без секретной части. Откройте её целиком — вместе с частью после «#».')
      })
  }, [publicId, exchange, loadFiles])

  const saveToMyCloud = async () => {
    setSaving(true)
    try {
      const { data: scope } = await cloudApi.get<{ shareId: string; fileIds: string[] }>(`/public/${publicId}/fileIds`)
      const { data: spaces } = await cloudApi.get<{ spaces: CloudSpace[] }>('/spaces')
      let target = spaces.spaces?.find?.((s) => s.role === 'OWNER') ?? spaces.spaces?.[0]
      if (!target) {
        const { data: created } = await cloudApi.post<{ space: CloudSpace }>('/spaces', {
          name: info?.space.name ? `${info.space.name} (сохранено)` : 'Сохранённое',
        })
        target = created.space
      }
      await cloudApi.post('/files/save', {
        fileIds: scope.fileIds,
        targetSpaceId: target.id,
        shareId: scope.shareId,
      })
      toast.success(`Сохранено в «${target.name}» — файлы не скачивались на ваш компьютер`)
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setSaving(false)
    }
  }

  if (status === 'loading') {
    return (
      <div className="cl-root">
        <div className="cl-page">
          <div className="cl-skeleton" style={{ height: 80, marginBottom: 18 }} />
          <SkeletonTiles />
        </div>
      </div>
    )
  }

  if (status === 'password') {
    return (
      <div className="cl-root">
        <div className="cl-page narrow">
          <div className="cl-empty">
            <div style={{ fontSize: 40 }}>🔒</div>
            <h3>Ссылка защищена паролем</h3>
            <div style={{ maxWidth: 320, margin: '18px auto 0' }}>
              <input
                className="cl-input"
                type="password"
                autoFocus
                placeholder="Пароль"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && secret && void exchange(secret, password)}
              />
              {message ? <div style={{ color: '#fca5a5', fontSize: 13, marginTop: 8 }}>{message}</div> : null}
              <button
                className="cl-btn primary"
                style={{ marginTop: 12, width: '100%' }}
                onClick={() => secret && void exchange(secret, password)}
              >
                Открыть
              </button>
            </div>
          </div>
        </div>
        <Toasts />
      </div>
    )
  }

  if (status === 'error' || !info) {
    return (
      <div className="cl-root">
        <div className="cl-page narrow">
          <Empty icon="🔗" title="Ссылка недействительна" text={message || 'Возможно, её отозвали или срок действия истёк.'} />
        </div>
      </div>
    )
  }

  return (
    <div className="cl-root">
      <header className="cl-topbar">
        <span className="cl-brand">
          <span className="logo">
            <span>Е</span>
            <span className="b">Б</span>
            <span>луша</span>
          </span>
          <span className="cl-brand-suffix">Cloud</span>
        </span>
        <div className="cl-spacer" />
        {signedIn && info.share.allowDownload ? (
          <button className="cl-btn sm" onClick={() => void saveToMyCloud()} disabled={saving}>
            {saving ? 'Сохраняем…' : 'Сохранить в мой Cloud'}
          </button>
        ) : null}
        {info.share.allowDownload ? (
          <a className="cl-btn sm" href={`/api/cloud/public/${publicId}/zip`}>
            Скачать всё ZIP
          </a>
        ) : null}
      </header>

      <div className="cl-page">
        <h1 className="cl-h1">{info.space.name}</h1>
        {info.space.description ? (
          <div className="cl-muted" style={{ marginTop: 6, fontSize: 14 }}>
            {info.space.description}
          </div>
        ) : null}
        {info.stats ? (
          <div className="cl-muted cl-mono" style={{ fontSize: 13, marginTop: 8, marginBottom: 18 }}>
            {info.stats.photos} фото · {info.stats.videos} видео · {formatBytes(info.stats.bytes)}
            {info.share.expiresAt ? ` · доступ до ${new Date(info.share.expiresAt).toLocaleDateString('ru-RU')}` : ''}
            {info.share.allowDownload ? '' : ' · только просмотр'}
          </div>
        ) : null}

        {files.length === 0 ? (
          <Empty title="Здесь пока пусто" />
        ) : (
          <>
            <TimelineView
              files={files}
              selection={new Set()}
              selectMode={false}
              onOpen={(file) => setViewerIndex(files.findIndex((f) => f.id === file.id))}
              onToggleSelect={() => undefined}
            />
            {cursor ? (
              <div style={{ textAlign: 'center', marginTop: 20 }}>
                <button className="cl-btn" onClick={() => void loadFiles(cursor)}>
                  Показать ещё
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {viewerIndex !== null && files[viewerIndex] ? (
        <Viewer files={files} index={viewerIndex} onIndexChange={setViewerIndex} onClose={() => setViewerIndex(null)} readOnly />
      ) : null}
      <Toasts />
    </div>
  )
}
