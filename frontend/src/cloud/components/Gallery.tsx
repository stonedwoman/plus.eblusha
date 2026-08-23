import { useMemo } from 'react'
import { formatBytes, formatDuration } from '../api'
import type { CloudFile } from '../types'

/**
 * Плиточная галерея. Плитки квадратные и с известным aspect-ratio, поэтому при
 * подгрузке превью раскладка не «прыгает» — это самая заметная разница между
 * приятной галереей и раздражающей.
 */
export function Tiles({
  files,
  selection,
  onOpen,
  onToggleSelect,
  dense,
  selectMode,
}: {
  files: CloudFile[]
  selection: Set<string>
  onOpen: (file: CloudFile) => void
  onToggleSelect: (id: string, shiftKey: boolean) => void
  dense?: boolean
  selectMode: boolean
}) {
  return (
    <div className={`cl-tiles${dense ? ' dense' : ''}`}>
      {files.map((file) => (
        <Tile
          key={file.id}
          file={file}
          selected={selection.has(file.id)}
          selectMode={selectMode}
          onOpen={() => onOpen(file)}
          onToggle={(shift) => onToggleSelect(file.id, shift)}
        />
      ))}
    </div>
  )
}

function Tile({
  file,
  selected,
  selectMode,
  onOpen,
  onToggle,
}: {
  file: CloudFile
  selected: boolean
  selectMode: boolean
  onOpen: () => void
  onToggle: (shift: boolean) => void
}) {
  const thumb = file.urls.thumb
  const processing = file.status === 'PROCESSING'
  const failed = file.status === 'FAILED'

  return (
    <div
      className={`cl-tile${selected ? ' selected' : ''}${processing && !thumb ? ' pending' : ''}`}
      onClick={(e) => {
        if (selectMode || e.ctrlKey || e.metaKey) onToggle(e.shiftKey)
        else onOpen()
      }}
      title={file.name}
    >
      {thumb ? (
        <img src={thumb} alt={file.name} loading="lazy" decoding="async" draggable={false} />
      ) : file.kind === 'IMAGE' || file.kind === 'VIDEO' ? (
        processing ? null : (
          <div className="cl-tile-generic">
            <span style={{ fontSize: 22 }}>{file.kind === 'VIDEO' ? '🎬' : '🖼'}</span>
            <span>{file.name}</span>
          </div>
        )
      ) : (
        <div className="cl-tile-generic">
          <span style={{ fontSize: 22 }}>{file.kind === 'AUDIO' ? '🎵' : '📄'}</span>
          <span>{file.name}</span>
        </div>
      )}

      {failed ? <div className="cl-tile-failed" title={file.processingError ?? 'Обработка не удалась'}>⚠</div> : null}
      {file.favorite ? <div className="cl-tile-fav">★</div> : null}

      <button
        className="cl-tile-check"
        onClick={(e) => {
          e.stopPropagation()
          onToggle(e.shiftKey)
        }}
        aria-label={selected ? 'Снять выбор' : 'Выбрать'}
      >
        ✓
      </button>

      {file.kind === 'VIDEO' && file.durationMs ? (
        <div className="cl-tile-badge">▶ {formatDuration(file.durationMs)}</div>
      ) : file.kind !== 'IMAGE' && file.kind !== 'VIDEO' ? (
        <div className="cl-tile-badge">{formatBytes(file.size, 0)}</div>
      ) : null}

      {file.commentCount > 0 ? (
        <div className="cl-tile-badge" style={{ left: 7, right: 'auto' }}>
          💬 {file.commentCount}
        </div>
      ) : null}
    </div>
  )
}

/** Группировка по дню съёмки — сердце таймлайна поездки. */
export function groupByDay(files: CloudFile[]): { key: string; label: string; files: CloudFile[] }[] {
  const groups = new Map<string, CloudFile[]>()
  for (const file of files) {
    const d = new Date(file.takenAt)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(file)
    else groups.set(key, [file])
  }
  return Array.from(groups.entries()).map(([key, list]) => ({
    key,
    label: formatDayLabel(new Date(list[0]!.takenAt)),
    files: list,
  }))
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

export function formatDayLabel(date: Date): string {
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${sameYear ? '' : ` ${date.getFullYear()}`}`
}

export function useDayGroups(files: CloudFile[]) {
  return useMemo(() => groupByDay(files), [files])
}

export function TimelineView({
  files,
  selection,
  onOpen,
  onToggleSelect,
  selectMode,
}: {
  files: CloudFile[]
  selection: Set<string>
  onOpen: (file: CloudFile) => void
  onToggleSelect: (id: string, shift: boolean) => void
  selectMode: boolean
}) {
  const groups = useDayGroups(files)
  return (
    <>
      {groups.map((group) => (
        <section key={group.key}>
          <div className="cl-day-head">
            {group.label}
            <span className="cl-muted">{group.files.length}</span>
          </div>
          <Tiles
            files={group.files}
            selection={selection}
            onOpen={onOpen}
            onToggleSelect={onToggleSelect}
            selectMode={selectMode}
          />
        </section>
      ))}
    </>
  )
}
