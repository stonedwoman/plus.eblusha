import { memo, useEffect, useState } from 'react'
import { formatBytes } from '../api'
import { cancelUpload, resumeUpload, useUploadItem } from '../uploads/manager'

/**
 * Плитка загружаемого файла прямо в галерее.
 *
 * Так честнее, чем всплывающее окно со списком: файл появляется там, где он в
 * итоге и окажется, а кольцо показывает реальный прогресс. После передачи
 * кольцо сменяется пульсацией — сервер в этот момент считает SHA-256 и строит
 * превью, и делать вид, что «уже 100%», нельзя.
 *
 * Подписка идёт на КОНКРЕТНЫЙ элемент по id: при 400+ файлах в очереди тик
 * прогресса одной передачи не должен перерисовывать соседей.
 */
export const UploadTile = memo(function UploadTile({ id }: { id: string }) {
  const item = useUploadItem(id)
  const [thumb, setThumb] = useState<string | null>(null)

  // Локальное превью из самого файла: показываем картинку до того, как сервер
  // построит настоящую миниатюру. Для крупных файлов пропускаем — createObjectURL
  // дешёвый, но декодирование сотни полноразмерных JPEG в сетке уже нет.
  useEffect(() => {
    const file = item?.localPreviewFile
    if (!file || !file.type.startsWith('image/') || file.size > 12 * 1024 * 1024) return
    const url = URL.createObjectURL(file)
    setThumb(url)
    return () => URL.revokeObjectURL(url)
  }, [item?.localPreviewFile])

  if (!item) return null

  const percent = item.size > 0 ? Math.min(100, (item.uploaded / item.size) * 100) : 0
  const transferring = item.phase === 'uploading' || item.phase === 'queued' || item.phase === 'paused'
  const preparing = item.phase === 'verifying' || item.phase === 'processing'
  const failed = item.phase === 'error'
  const needsFile = item.phase === 'needs-file'

  return (
    <div className={`cl-tile cl-uptile${preparing ? ' preparing' : ''}`} title={item.name}>
      {thumb ? <img src={thumb} alt="" className="cl-uptile-bg" /> : null}
      <div className="cl-uptile-veil" />

      <div className="cl-uptile-center">
        {failed || needsFile ? (
          <button
            className="cl-uptile-retry"
            onClick={() => (needsFile ? undefined : resumeUpload(item.id))}
            title={item.error ?? 'Повторить'}
          >
            {needsFile ? '📄' : '↻'}
          </button>
        ) : preparing ? (
          <div className="cl-uptile-spinner" />
        ) : (
          <Ring percent={percent} paused={item.phase === 'paused'} />
        )}
      </div>

      <div className="cl-uptile-caption">
        <span className="cl-uptile-name">{item.name}</span>
        <span className="cl-uptile-sub">
          {failed
            ? 'ошибка'
            : needsFile
              ? 'нужен файл'
              : preparing
                ? item.phase === 'verifying'
                  ? 'проверяем'
                  : 'делаем превью'
                : item.phase === 'paused'
                  ? 'пауза'
                  : item.phase === 'queued'
                    ? 'в очереди'
                    : `${formatBytes(item.uploaded, 0)} / ${formatBytes(item.size, 0)}`}
        </span>
      </div>

      {transferring || failed ? (
        <button
          className="cl-uptile-cancel"
          onClick={() => void cancelUpload(item.id)}
          title="Отменить"
          aria-label="Отменить загрузку"
        >
          ✕
        </button>
      ) : null}
    </div>
  )
})

/** Кольцевой индикатор. SVG, без внешних зависимостей. */
function Ring({ percent, paused }: { percent: number; paused: boolean }) {
  const r = 20
  const c = 2 * Math.PI * r
  return (
    <svg className="cl-ring" viewBox="0 0 48 48" width="48" height="48" aria-hidden>
      <circle cx="24" cy="24" r={r} className="cl-ring-track" />
      <circle
        cx="24"
        cy="24"
        r={r}
        className={`cl-ring-value${paused ? ' paused' : ''}`}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - percent / 100)}
      />
      <text x="24" y="28" className="cl-ring-text">
        {paused ? '❚❚' : `${Math.round(percent)}`}
      </text>
    </svg>
  )
}
