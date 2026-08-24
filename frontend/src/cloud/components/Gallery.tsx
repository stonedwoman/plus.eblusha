import { memo, useMemo } from 'react'
import { formatBytes, formatDuration } from '../api'
import { UploadTile } from './UploadTile'
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

/**
 * Плитка мемоизирована: при 400+ файлах любое изменение состояния страницы
 * (тик прогресса, приход события) иначе перерисовывало всю сетку целиком.
 * Колбэки сюда обязаны приходить стабильными — см. useCallback в SpacePage.
 */
const Tile = memo(function Tile({
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
      /* Выделение протяжкой читает id и состояние прямо из DOM — см. useDragSelect. */
      data-file-id={file.id}
      data-selected={selected ? '1' : '0'}
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
})

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

/** Элемент таймлайна: готовый файл либо ещё загружающийся. */
export type TimelineEntry =
  | { kind: 'file'; at: number; id: string; file: CloudFile }
  | { kind: 'upload'; at: number; id: string; withPreview: boolean }

/**
 * Загрузки вклиниваются в общий список, а не живут отдельным блоком: плитка
 * стоит в группе того дня, куда файл и попадёт после обработки (сервер до
 * чтения EXIF использует тот же mtime). Поэтому при завершении она просто
 * заменяется настоящим превью, а список не перестраивается.
 */
export function TimelineView({
  files,
  uploads = [],
  selection,
  onOpen,
  onToggleSelect,
  selectMode,
}: {
  files: CloudFile[]
  uploads?: { id: string; at: number }[]
  selection: Set<string>
  onOpen: (file: CloudFile) => void
  onToggleSelect: (id: string, shift: boolean) => void
  selectMode: boolean
}) {
  const groups = useMemo(() => {
    const entries: TimelineEntry[] = [
      ...files.map((f) => ({ kind: 'file' as const, at: new Date(f.takenAt).getTime(), id: f.id, file: f })),
      // Локальные превью — только у первых плиток: держать сотни objectURL и
      // декодировать столько же полноразмерных JPEG браузер не обязан.
      ...uploads.map((u, i) => ({ kind: 'upload' as const, at: u.at, id: u.id, withPreview: i < 40 })),
    ]
    // Хронология вперёд: 26 марта, потом 27-е. Так листают фотоальбом поездки,
    // а не ленту новостей. Порядок совпадает с серверным (takenAt asc).
    entries.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))

    const out: { key: string; label: string; entries: TimelineEntry[] }[] = []
    for (const entry of entries) {
      const d = new Date(entry.at)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const last = out[out.length - 1]
      if (last && last.key === key) last.entries.push(entry)
      else out.push({ key, label: formatDayLabel(d), entries: [entry] })
    }
    return out
  }, [files, uploads])

  return (
    <>
      {groups.map((group) => (
        // data-day читают рельса таймлайна (прыжок к дате) и трекер текущего
        // дня при прокрутке — см. SpacePage.
        <section key={group.key} data-day={group.key}>
          <div className="cl-day-head">
            {group.label}
            <span className="cl-muted">{group.entries.length}</span>
          </div>
          <div className="cl-tiles">
            {group.entries.map((entry) =>
              entry.kind === 'upload' ? (
                <UploadTile key={entry.id} id={entry.id} withPreview={entry.withPreview} />
              ) : (
                <Tile
                  key={entry.id}
                  file={entry.file}
                  selected={selection.has(entry.id)}
                  selectMode={selectMode}
                  onOpen={() => onOpen(entry.file)}
                  onToggle={(shift) => onToggleSelect(entry.id, shift)}
                />
              )
            )}
          </div>
        </section>
      ))}
    </>
  )
}
