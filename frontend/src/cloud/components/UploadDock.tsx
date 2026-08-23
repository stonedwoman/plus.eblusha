import { memo, useRef, useState } from 'react'
import { formatBytes, formatEta } from '../api'
import {
  attachFileToUpload,
  cancelUpload,
  clearFinished,
  pauseAll,
  pauseUpload,
  resumeAll,
  resumeUpload,
  useUploadIds,
  useUploadItem,
  useUploadStore,
  useUploadSummary,
  type UploadItem,
} from '../uploads/manager'
import { toast } from './ui'

/**
 * Док загрузок — теперь сводка, а не список.
 *
 * Раньше он рендерил КАЖДЫЙ элемент очереди и был подписан на весь массив: при
 * заливке четырёхсот фотографий любой тик прогресса перерисовывал четыреста
 * строк, и интерфейс закономерно вставал. Сами файлы теперь видно плитками в
 * галерее (UploadTile), а здесь остаётся общий прогресс и управление пачкой.
 *
 * Развёрнутый список показывает только то, что требует внимания: активные
 * передачи, ошибки и загрузки, ждущие повторного выбора файла.
 */
export function UploadDock() {
  const summary = useUploadSummary()
  const globallyPaused = useUploadStore((s) => s.paused)
  const [expanded, setExpanded] = useState(false)

  if (summary.total === 0) return null

  const overall = summary.totalBytes > 0 ? (summary.bytes / summary.totalBytes) * 100 : 0
  const busy = summary.active > 0
  const etaSeconds =
    summary.speed > 1024 ? Math.max(0, summary.totalBytes - summary.bytes) / summary.speed : 0

  return (
    <div className="cl-dock">
      <div className="cl-dock-head" onClick={() => setExpanded((v) => !v)}>
        <span>
          {busy
            ? `Загрузка — ${summary.done} из ${summary.total}`
            : summary.failed > 0
              ? `Ошибок: ${summary.failed}`
              : 'Загрузки завершены'}
        </span>
        <div className="cl-spacer" />
        {summary.speed > 0 ? (
          <span className="cl-muted cl-mono" style={{ fontWeight: 400, fontSize: 12 }}>
            ↑ {formatBytes(summary.speed)}/с
          </span>
        ) : null}
        <button className="cl-btn ghost icon sm" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}>
          {expanded ? '▼' : '▲'}
        </button>
      </div>

      <div style={{ padding: '10px 13px' }}>
        <div className="cl-progress">
          <i style={{ width: `${overall}%` }} />
        </div>
        <div className="cl-up-meta" style={{ marginTop: 7 }}>
          <span>
            {formatBytes(summary.bytes)} / {formatBytes(summary.totalBytes)}
          </span>
          {etaSeconds > 0 ? <span>осталось ~{formatEta(etaSeconds)}</span> : null}
          {summary.needsFile > 0 ? <span style={{ color: 'var(--brand)' }}>нужен файл: {summary.needsFile}</span> : null}
          <div className="cl-up-actions">
            {busy ? (
              <button className="cl-btn ghost sm" onClick={() => (globallyPaused ? resumeAll() : pauseAll())}>
                {globallyPaused ? 'Продолжить все' : 'Пауза всех'}
              </button>
            ) : (
              <button className="cl-btn ghost sm" onClick={clearFinished}>
                Очистить
              </button>
            )}
          </div>
        </div>
      </div>

      {expanded ? <DockList /> : null}
    </div>
  )
}

/** Разворот: только проблемные и активные элементы, а не вся очередь. */
function DockList() {
  const ids = useUploadIds()
  return (
    <div className="cl-dock-body">
      {ids.map((id) => (
        <DockRow key={id} id={id} />
      ))}
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

const DockRow = memo(function DockRow({ id }: { id: string }) {
  const item = useUploadItem(id)
  const inputRef = useRef<HTMLInputElement | null>(null)
  if (!item) return null

  // Ждущие своей очереди и уже готовые в списке не показываем: их сотни, и
  // ничего полезного они не сообщают. Сводка выше уже всё сказала.
  const interesting =
    item.phase === 'uploading' || item.phase === 'error' || item.phase === 'needs-file' || item.phase === 'paused'
  if (!interesting) return null

  const percent = item.size > 0 ? Math.min(100, (item.uploaded / item.size) * 100) : 0

  return (
    <div className="cl-up-item">
      <div className="cl-up-name" title={item.name}>
        {item.name}
      </div>
      <div className="cl-progress">
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="cl-up-meta">
        {item.phase === 'uploading' ? (
          <>
            <span>{Math.round(percent)}%</span>
            {item.speed > 0 ? <span>↑ {formatBytes(item.speed)}/с</span> : null}
            {item.etaSeconds > 0 ? <span>~{formatEta(item.etaSeconds)}</span> : null}
          </>
        ) : (
          <span>{PHASE_LABEL[item.phase]}</span>
        )}
        <div className="cl-up-actions">
          {item.phase === 'uploading' ? (
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
          <button className="cl-btn ghost sm" onClick={() => void cancelUpload(item.id)}>
            ✕
          </button>
        </div>
      </div>

      {item.phase === 'needs-file' ? (
        <div className="cl-muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.4 }}>
          Принято {formatBytes(item.uploaded)} из {formatBytes(item.size)}. Браузер потерял доступ к исходному файлу —
          выберите его заново, передача продолжится с этого места.
        </div>
      ) : null}
      {item.error ? <div style={{ color: '#fca5a5', fontSize: 11.5, marginTop: 5 }}>{item.error}</div> : null}

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
})
