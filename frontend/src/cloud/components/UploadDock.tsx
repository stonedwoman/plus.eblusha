import { useMemo, useRef, useState } from 'react'
import { formatBytes, formatEta } from '../api'
import {
  attachFileToUpload,
  cancelUpload,
  clearFinished,
  pauseAll,
  pauseUpload,
  resumeAll,
  resumeUpload,
  useUploadStore,
  type UploadItem,
} from '../uploads/manager'
import { toast } from './ui'

/**
 * Док загрузок. Показывает подтверждённые сервером байты, сглаженную скорость и
 * ETA, а после окончания передачи — конвейер обработки: прогресс-бар не имеет
 * права висеть на 100%, пока файл ещё считается и превью не построены.
 */
export function UploadDock() {
  const items = useUploadStore((s) => s.items)
  const globallyPaused = useUploadStore((s) => s.paused)
  const [collapsed, setCollapsed] = useState(false)

  const stats = useMemo(() => {
    let active = 0
    let done = 0
    let failed = 0
    let bytes = 0
    let total = 0
    let speed = 0
    for (const i of items) {
      if (i.phase === 'done') done++
      else if (i.phase === 'error') failed++
      else active++
      bytes += i.uploaded
      total += i.size
      speed += i.phase === 'uploading' ? i.speed : 0
    }
    return { active, done, failed, bytes, total, speed }
  }, [items])

  if (items.length === 0) return null

  return (
    <div className="cl-dock">
      <div className="cl-dock-head" onClick={() => setCollapsed((c) => !c)}>
        <span>
          {stats.active > 0 ? `Загрузка — ${stats.active}` : stats.failed > 0 ? `Ошибок: ${stats.failed}` : 'Загрузки завершены'}
        </span>
        {stats.speed > 0 ? <span className="cl-muted cl-mono" style={{ fontWeight: 400, fontSize: 12 }}>↑ {formatBytes(stats.speed)}/с</span> : null}
        <div className="cl-spacer" />
        {stats.active > 0 ? (
          <button
            className="cl-btn ghost sm"
            onClick={(e) => {
              e.stopPropagation()
              globallyPaused ? resumeAll() : pauseAll()
            }}
          >
            {globallyPaused ? 'Продолжить все' : 'Пауза всех'}
          </button>
        ) : (
          <button
            className="cl-btn ghost sm"
            onClick={(e) => {
              e.stopPropagation()
              clearFinished()
            }}
          >
            Очистить
          </button>
        )}
        <button className="cl-btn ghost icon sm" onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c) }}>
          {collapsed ? '▲' : '▼'}
        </button>
      </div>
      {!collapsed ? (
        <div className="cl-dock-body">
          {items.map((item) => (
            <UploadRow key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

const PHASE_LABEL: Record<UploadItem['phase'], string> = {
  queued: 'В очереди',
  uploading: '',
  paused: 'Пауза',
  verifying: 'Проверяем файл',
  processing: 'Готовим превью',
  done: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменено',
  'needs-file': 'Нужен исходный файл',
}

function UploadRow({ item }: { item: UploadItem }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const percent = item.size > 0 ? Math.min(100, (item.uploaded / item.size) * 100) : 0
  const inFlight = item.phase === 'uploading'
  const postTransfer = item.phase === 'verifying' || item.phase === 'processing'

  return (
    <div className="cl-up-item">
      <div className="cl-up-name" title={item.name}>
        {item.name}
      </div>
      <div className={`cl-progress${postTransfer ? ' indeterminate' : ''}`}>
        <i style={{ width: `${item.phase === 'done' ? 100 : percent}%` }} />
      </div>
      <div className="cl-up-meta">
        {inFlight ? (
          <>
            <span>{Math.round(percent)}%</span>
            {item.speed > 0 ? <span>↑ {formatBytes(item.speed)}/с</span> : null}
            <span>
              {formatBytes(item.uploaded)} / {formatBytes(item.size)}
            </span>
            {item.etaSeconds > 0 ? <span>осталось ~{formatEta(item.etaSeconds)}</span> : null}
          </>
        ) : (
          <>
            <span>{PHASE_LABEL[item.phase]}</span>
            {item.phase !== 'done' && item.phase !== 'needs-file' ? (
              <span>
                {formatBytes(item.uploaded)} / {formatBytes(item.size)}
              </span>
            ) : null}
          </>
        )}

        <div className="cl-up-actions">
          {inFlight ? (
            <button className="cl-btn ghost sm" onClick={() => pauseUpload(item.id)}>
              Пауза
            </button>
          ) : null}
          {item.phase === 'paused' || item.phase === 'error' ? (
            <button className="cl-btn ghost sm" onClick={() => resumeUpload(item.id)}>
              Продолжить
            </button>
          ) : null}
          {item.phase === 'needs-file' ? (
            <button className="cl-btn sm" onClick={() => inputRef.current?.click()}>
              Выбрать файл
            </button>
          ) : null}
          {item.phase !== 'done' ? (
            <button className="cl-btn ghost sm" onClick={() => void cancelUpload(item.id)}>
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {item.phase === 'needs-file' ? (
        <div className="cl-muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.4 }}>
          Загружено {formatBytes(item.uploaded)} из {formatBytes(item.size)}. Браузер больше не имеет доступа к
          исходному файлу — выберите его заново, и передача продолжится с этого места.
        </div>
      ) : null}

      {postTransfer || item.phase === 'done' ? (
        <div className="cl-pipeline">
          <div className="done">✓ Загружено</div>
          <div className={item.phase === 'verifying' ? 'active' : 'done'}>
            {item.phase === 'verifying' ? '→' : '✓'} Проверяем файл
          </div>
          <div className={item.phase === 'processing' ? 'active' : item.phase === 'done' ? 'done' : ''}>
            {item.phase === 'processing' ? '→' : item.phase === 'done' ? '✓' : '·'} Создаём превью
          </div>
          <div className={item.phase === 'done' ? 'done' : ''}>{item.phase === 'done' ? '✓ Готово' : '· Готово'}</div>
        </div>
      ) : null}

      {item.error ? (
        <div style={{ color: '#fca5a5', fontSize: 11.5, marginTop: 5 }}>{item.error}</div>
      ) : null}

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
          else toast.success('Загрузка продолжена')
        }}
      />
    </div>
  )
}
