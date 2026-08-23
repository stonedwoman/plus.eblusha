import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatBytes, toCloudError } from '../api'
import {
  attachFileToUpload,
  cancelUpload,
  hydrateServerUploads,
  resumeUpload,
  useUploadStore,
} from '../uploads/manager'
import { Empty, toast } from '../components/ui'
import { cloudPath } from '../basePath'

/**
 * Экран незавершённых загрузок.
 *
 * Сервер не может волшебным образом достать локальный файл с другого компьютера,
 * и интерфейс говорит об этом прямо: он показывает, сколько байт уже принято, и
 * просит выбрать исходный файл заново. Отпечаток проверяется до того, как в
 * старую загрузку допишется хоть один байт нового файла.
 */
export function UploadsPage() {
  const items = useUploadStore((s) => s.items)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    hydrateServerUploads()
      .catch((err) => toast.error(toCloudError(err).message))
      .finally(() => setLoading(false))
  }, [])

  const unfinished = items.filter((i) => i.phase !== 'done' && i.phase !== 'cancelled')

  return (
    <div className="cl-page narrow">
      <h1 className="cl-h1" style={{ marginBottom: 18 }}>
        Загрузки
      </h1>

      {loading ? (
        <div className="cl-skeleton" style={{ height: 120 }} />
      ) : unfinished.length === 0 ? (
        <Empty
          title="Незавершённых загрузок нет"
          text="Если закрыть вкладку во время большой загрузки, она появится здесь — и продолжится с того места, где остановилась."
        />
      ) : (
        <div className="cl-list">
          {unfinished.map((item) => (
            <UploadResumeRow key={item.id} id={item.id} />
          ))}
        </div>
      )}
    </div>
  )
}

function UploadResumeRow({ id }: { id: string }) {
  const item = useUploadStore((s) => s.items.find((i) => i.id === id))
  const inputRef = useRef<HTMLInputElement | null>(null)
  if (!item) return null

  const percent = item.size > 0 ? Math.round((item.uploaded / item.size) * 100) : 0

  return (
    <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--surface-border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 7 }}>
        <strong style={{ fontSize: 14.5 }}>{item.name}</strong>
        {item.spaceName ? (
          <Link className="cl-muted" style={{ fontSize: 12.5 }} to={cloudPath(`/space/${item.spaceId}`)}>
            {item.spaceName}
          </Link>
        ) : null}
        <div className="cl-spacer" />
        <span className="cl-mono cl-muted" style={{ fontSize: 13 }}>
          {percent}%
        </span>
      </div>

      <div className="cl-progress">
        <i style={{ width: `${percent}%` }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9 }}>
        <span className="cl-muted cl-mono" style={{ fontSize: 12.5 }}>
          {formatBytes(item.uploaded)} / {formatBytes(item.size)}
        </span>
        <div className="cl-spacer" />
        {item.phase === 'needs-file' ? (
          <button className="cl-btn primary sm" onClick={() => inputRef.current?.click()}>
            Выбрать файл и продолжить
          </button>
        ) : item.phase === 'paused' || item.phase === 'error' ? (
          <button className="cl-btn sm" onClick={() => resumeUpload(item.id)}>
            Продолжить
          </button>
        ) : (
          <span className="cl-muted" style={{ fontSize: 12.5 }}>
            {item.phase === 'uploading' ? 'идёт передача' : 'обработка'}
          </span>
        )}
        <button className="cl-btn ghost danger sm" onClick={() => void cancelUpload(item.id)}>
          Удалить
        </button>
      </div>

      {item.phase === 'needs-file' ? (
        <div className="cl-muted" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>
          Браузер потерял доступ к исходному файлу. Выберите тот же файл — мы сверим размер и отпечаток и продолжим
          передачу с {formatBytes(item.uploaded)}, не начиная заново.
        </div>
      ) : null}

      {item.error ? <div style={{ color: '#fca5a5', fontSize: 12.5, marginTop: 6 }}>{item.error}</div> : null}

      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          const res = await attachFileToUpload(item.id, file)
          if (!res.ok) toast.error(res.reason ?? 'Файл не подошёл')
          else toast.success('Продолжаем загрузку')
        }}
      />
    </div>
  )
}

export default UploadsPage
