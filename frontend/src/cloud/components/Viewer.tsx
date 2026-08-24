import { useCallback, useEffect, useRef, useState } from 'react'
import { cloudApi, formatBytes, formatDuration, toCloudError } from '../api'
import type { CloudComment, CloudFile } from '../types'
import { onCloudEvent } from '../realtime'
import { Avatar, toast } from './ui'

const EMOJI = ['👍', '❤️', '😂', '😮', '😢']

/**
 * Просмотрщик файла: фото с зумом, видео с перемоткой, метаданные и обсуждение.
 *
 * Комментарий к таймкоду — не украшение: клик по «03:42» перематывает плеер
 * ровно туда, и обсуждать длинное видео становится возможно.
 */
export function Viewer({
  files,
  index,
  onClose,
  onIndexChange,
  onFileChanged,
  readOnly,
  spaceId,
  canComment,
  hasMore,
  onNeedMore,
}: {
  files: CloudFile[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
  onFileChanged?: (file: CloudFile) => void
  readOnly?: boolean
  spaceId?: string
  canComment?: boolean
  /** Есть ли ещё непрогруженные файлы дальше по списку. */
  hasMore?: boolean
  /** Догрузить следующую страницу — вызывается на последнем кадре. */
  onNeedMore?: () => void
}) {
  const file = files[index]
  const [panel, setPanel] = useState<'info' | 'comments' | null>(readOnly ? 'info' : 'comments')
  const [zoom, setZoom] = useState(1)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const go = useCallback(
    (delta: number) => {
      const next = index + delta
      if (next >= 0 && next < files.length) {
        setZoom(1)
        onIndexChange(next)
        // Подтягиваем следующую страницу заранее, за пару кадров до конца:
        // иначе на последнем снимке стрелка «вперёд» упиралась в пустоту, хотя
        // в хуяпке оставались сотни файлов.
        if (hasMore && next >= files.length - 3) onNeedMore?.()
        return
      }
      if (delta > 0 && hasMore) onNeedMore?.()
    },
    [index, files.length, onIndexChange, hasMore, onNeedMore]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === ' ' && videoRef.current) {
        e.preventDefault()
        if (videoRef.current.paused) void videoRef.current.play()
        else videoRef.current.pause()
      } else if (e.key === 'i') setPanel((p) => (p === 'info' ? null : 'info'))
      else if (e.key === 'f' && !readOnly && file) void toggleFavorite(file)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, onClose, file, readOnly])

  const toggleFavorite = useCallback(
    async (target: CloudFile) => {
      try {
        const { data } = await cloudApi.post<{ favorite: boolean }>('/favorites', { fileId: target.id })
        onFileChanged?.({ ...target, favorite: data.favorite })
      } catch (err) {
        toast.error(toCloudError(err).message)
      }
    },
    [onFileChanged]
  )

  const react = useCallback(
    async (target: CloudFile, emoji: string) => {
      try {
        const { data } = await cloudApi.post<{ reactions: Record<string, number>; myReactions: string[] }>('/reactions', {
          targetType: 'FILE',
          targetId: target.id,
          emoji,
        })
        onFileChanged?.({ ...target, reactions: data.reactions, myReactions: data.myReactions })
      } catch (err) {
        toast.error(toCloudError(err).message)
      }
    },
    [onFileChanged]
  )

  const seekTo = useCallback((ms: number) => {
    if (!videoRef.current) return
    videoRef.current.currentTime = ms / 1000
    void videoRef.current.play()
  }, [])

  if (!file) return null

  return (
    <div className={`cl-viewer${panel ? ' with-panel' : ''}`}>
      <div className="cl-viewer-stage">
        <div className="cl-viewer-top">
          <button className="cl-btn ghost icon sm" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
          <div className="cl-viewer-title">{file.name}</div>
          <span className="cl-muted" style={{ fontSize: 12.5 }}>
            {index + 1} / {files.length}
          </span>
          <div className="cl-spacer" />
          {!readOnly ? (
            <button
              className="cl-btn ghost icon sm"
              onClick={() => void toggleFavorite(file)}
              title="В избранное (F)"
              style={file.favorite ? { color: '#fbbf24' } : undefined}
            >
              {file.favorite ? '★' : '☆'}
            </button>
          ) : null}
          {file.urls.download ? (
            <a className="cl-btn ghost sm" href={file.urls.download} download>
              Скачать
            </a>
          ) : null}
          <button className={`cl-btn ghost sm${panel === 'info' ? ' primary' : ''}`} onClick={() => setPanel(panel === 'info' ? null : 'info')}>
            Инфо
          </button>
          {!readOnly ? (
            <button
              className={`cl-btn ghost sm${panel === 'comments' ? ' primary' : ''}`}
              onClick={() => setPanel(panel === 'comments' ? null : 'comments')}
            >
              💬 {file.commentCount || ''}
            </button>
          ) : null}
        </div>

        {index > 0 ? (
          <button className="cl-viewer-nav prev" onClick={() => go(-1)} aria-label="Предыдущий">
            ‹
          </button>
        ) : null}
        {index < files.length - 1 || hasMore ? (
          <button className="cl-viewer-nav next" onClick={() => go(1)} aria-label="Следующий">
            ›
          </button>
        ) : null}

        <MediaStage file={file} zoom={zoom} setZoom={setZoom} videoRef={videoRef} />
      </div>

      {panel ? (
        <aside className="cl-viewer-panel">
          <div className="cl-panel-tabs">
            <button className={panel === 'info' ? 'is-active' : ''} onClick={() => setPanel('info')}>
              Метаданные
            </button>
            {!readOnly ? (
              <button className={panel === 'comments' ? 'is-active' : ''} onClick={() => setPanel('comments')}>
                Обсуждение
              </button>
            ) : null}
          </div>
          <div className="cl-panel-body">
            {panel === 'info' ? (
              <MetadataPanel file={file} onReact={!readOnly ? (emoji) => void react(file, emoji) : undefined} />
            ) : (
              <CommentsPanel
                file={file}
                spaceId={spaceId ?? file.spaceId}
                onSeek={file.kind === 'VIDEO' ? seekTo : undefined}
                currentTimeMs={() => Math.round((videoRef.current?.currentTime ?? 0) * 1000)}
                canComment={canComment !== false}
                onCountChange={(count) => onFileChanged?.({ ...file, commentCount: count })}
              />
            )}
          </div>
        </aside>
      ) : null}
    </div>
  )
}

function MediaStage({
  file,
  zoom,
  setZoom,
  videoRef,
}: {
  file: CloudFile
  zoom: number
  setZoom: (z: number) => void
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
}) {
  if (file.kind === 'IMAGE') {
    const src = file.urls.preview ?? file.urls.content
    if (!src) return <div className="cl-muted">Превью недоступно</div>
    return (
      <img
        src={src}
        alt={file.name}
        className={zoom > 1 ? 'zoomed' : ''}
        style={zoom > 1 ? { transform: `scale(${zoom})`, transformOrigin: 'center' } : undefined}
        onClick={() => setZoom(zoom > 1 ? 1 : 2.5)}
        onWheel={(e) => {
          if (!e.ctrlKey) return
          e.preventDefault()
          setZoom(Math.min(6, Math.max(1, zoom * (e.deltaY < 0 ? 1.15 : 0.87))))
        }}
        draggable={false}
      />
    )
  }

  if (file.kind === 'VIDEO') {
    if (!file.urls.playback) {
      return (
        <div className="cl-empty">
          <h3>Видео готовится</h3>
          <p>
            Формат не воспроизводится браузером напрямую, поэтому сервер делает web-версию. Оригинал уже сохранён и
            доступен для скачивания.
          </p>
        </div>
      )
    }
    return (
      <video
        ref={videoRef}
        src={file.urls.playback}
        poster={file.urls.poster ?? undefined}
        controls
        playsInline
        preload="metadata"
        style={{ width: '100%', height: '100%' }}
      />
    )
  }

  if (file.kind === 'AUDIO' && file.urls.content) {
    return (
      <div style={{ textAlign: 'center', padding: 24 }}>
        <div style={{ fontSize: 56, marginBottom: 14 }}>🎵</div>
        <div style={{ marginBottom: 14 }}>{file.name}</div>
        <audio src={file.urls.content} controls style={{ width: 'min(520px, 80vw)' }} />
      </div>
    )
  }

  return (
    <div className="cl-empty">
      <div style={{ fontSize: 46 }}>📄</div>
      <h3>{file.name}</h3>
      <p>
        {formatBytes(file.size)} · {file.mime}
      </p>
      {file.urls.download ? (
        <div style={{ marginTop: 16 }}>
          <a className="cl-btn primary" href={file.urls.download} download>
            Скачать оригинал
          </a>
        </div>
      ) : null}
    </div>
  )
}

function MetadataPanel({ file, onReact }: { file: CloudFile; onReact?: (emoji: string) => void }) {
  const rows: [string, string | null][] = [
    ['Имя файла', file.name],
    ['Загрузил', file.uploader?.displayName || file.uploader?.username || null],
    ['Загружено', new Date(file.createdAt).toLocaleString('ru-RU')],
    [
      'Снято',
      `${new Date(file.takenAt).toLocaleString('ru-RU')}${
        file.takenAtSource === 'exif' ? ' (EXIF)' : file.takenAtSource === 'client' ? ' (файл)' : ' (загрузка)'
      }`,
    ],
    ['Размеры', file.width && file.height ? `${file.width} × ${file.height}` : null],
    ['Длительность', file.durationMs ? formatDuration(file.durationMs) : null],
    ['Размер', formatBytes(file.size)],
    ['Тип', file.mime],
    ['Камера', [file.cameraMake, file.cameraModel].filter(Boolean).join(' ') || null],
    ['Кодек', [file.videoCodec, file.audioCodec].filter(Boolean).join(' / ') || null],
    ['Битрейт', file.bitrate ? `${Math.round(file.bitrate / 1000)} кбит/с` : null],
    ['GPS', file.latitude && file.longitude ? `${file.latitude.toFixed(5)}, ${file.longitude.toFixed(5)}` : null],
  ]
  const extra = (file.metadata ?? {}) as Record<string, unknown>
  const lens = typeof extra.lensModel === 'string' ? extra.lensModel : null
  const iso = typeof extra.iso === 'number' ? `ISO ${extra.iso}` : null
  const aperture = typeof extra.fNumber === 'number' ? `f/${extra.fNumber}` : null
  const shutter =
    typeof extra.exposureTime === 'number'
      ? extra.exposureTime >= 1
        ? `${extra.exposureTime}s`
        : `1/${Math.round(1 / extra.exposureTime)}s`
      : null
  const shot = [aperture, shutter, iso, lens].filter(Boolean).join(' · ')

  return (
    <>
      {onReact ? (
        <div className="cl-reactions" style={{ marginBottom: 14 }}>
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              className={`cl-reaction${file.myReactions.includes(emoji) ? ' mine' : ''}`}
              onClick={() => onReact(emoji)}
            >
              {emoji} {file.reactions[emoji] ?? ''}
            </button>
          ))}
        </div>
      ) : null}

      {file.status === 'FAILED' ? (
        <div className="cl-toast error" style={{ marginBottom: 12 }}>
          Обработка не удалась: {file.processingError ?? 'неизвестная ошибка'}
        </div>
      ) : null}

      <dl style={{ margin: 0 }}>
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div className="cl-meta-row" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        {shot ? (
          <div className="cl-meta-row">
            <dt>Съёмка</dt>
            <dd>{shot}</dd>
          </div>
        ) : null}
        {file.playbackSource ? (
          <div className="cl-meta-row">
            <dt>Воспроизведение</dt>
            <dd>{file.playbackSource === 'original' ? 'оригинал' : 'web-версия'}</dd>
          </div>
        ) : null}
      </dl>
    </>
  )
}

function CommentsPanel({
  file,
  spaceId,
  onSeek,
  currentTimeMs,
  canComment,
  onCountChange,
}: {
  file: CloudFile
  spaceId: string
  onSeek?: (ms: number) => void
  currentTimeMs: () => number
  canComment: boolean
  onCountChange?: (count: number) => void
}) {
  const [comments, setComments] = useState<CloudComment[]>([])
  const [text, setText] = useState('')
  const [withTimestamp, setWithTimestamp] = useState(Boolean(onSeek))
  const [replyTo, setReplyTo] = useState<CloudComment | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await cloudApi.get<{ comments: CloudComment[] }>('/comments', {
        params: { spaceId, fileId: file.id },
      })
      setComments(data.comments)
      onCountChange?.(data.comments.filter((c) => !c.deletedAt).length)
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, file.id])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    const offs = [
      onCloudEvent('cloud.comment.created', (p) => {
        const payload = p as { comment: CloudComment }
        if (payload.comment.fileId === file.id) {
          setComments((prev) => (prev.some((c) => c.id === payload.comment.id) ? prev : [...prev, payload.comment]))
        }
      }),
      onCloudEvent('cloud.comment.updated', (p) => {
        const payload = p as { comment: CloudComment }
        setComments((prev) => prev.map((c) => (c.id === payload.comment.id ? payload.comment : c)))
      }),
      onCloudEvent('cloud.comment.deleted', (p) => {
        const payload = p as { commentId: string }
        setComments((prev) => prev.filter((c) => c.id !== payload.commentId))
      }),
      onCloudEvent('cloud.reaction.changed', (p) => {
        const payload = p as { targetType: string; targetId: string; reactions: Record<string, number> }
        if (payload.targetType !== 'COMMENT') return
        setComments((prev) => prev.map((c) => (c.id === payload.targetId ? { ...c, reactions: payload.reactions } : c)))
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [file.id])

  const submit = async () => {
    const body = text.trim()
    if (!body) return
    try {
      await cloudApi.post('/comments', {
        spaceId,
        fileId: file.id,
        parentCommentId: replyTo?.id ?? null,
        body,
        videoTimestampMs: withTimestamp && onSeek ? currentTimeMs() : null,
      })
      setText('')
      setReplyTo(null)
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const saveEdit = async (id: string, body: string) => {
    try {
      await cloudApi.patch(`/comments/${id}`, { body })
      setEditing(null)
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const remove = async (id: string) => {
    try {
      await cloudApi.delete(`/comments/${id}`)
      setComments((prev) => prev.filter((c) => c.id !== id))
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const toggleReaction = async (comment: CloudComment, emoji: string) => {
    try {
      const { data } = await cloudApi.post<{ reactions: Record<string, number>; myReactions: string[] }>('/reactions', {
        targetType: 'COMMENT',
        targetId: comment.id,
        emoji,
      })
      setComments((prev) =>
        prev.map((c) => (c.id === comment.id ? { ...c, reactions: data.reactions, myReactions: data.myReactions } : c))
      )
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  const byId = new Map(comments.map((c) => [c.id, c]))

  return (
    <>
      {loading ? (
        <div className="cl-muted">Загружаем обсуждение…</div>
      ) : comments.length === 0 ? (
        <div className="cl-muted" style={{ fontSize: 13.5, padding: '10px 0' }}>
          Пока никто ничего не написал.
        </div>
      ) : (
        comments
          .filter((c) => !c.deletedAt)
          .map((comment) => (
            <div className="cl-comment" key={comment.id}>
              <Avatar user={comment.author} />
              <div className="cl-comment-main">
                <div className="cl-comment-head">
                  <span className="cl-comment-author">
                    {comment.author?.displayName || comment.author?.username || 'Кто-то'}
                  </span>
                  {comment.videoTimestampMs !== null && onSeek ? (
                    <button className="cl-ts-chip" onClick={() => onSeek(comment.videoTimestampMs as number)}>
                      ▶ {formatDuration(comment.videoTimestampMs)}
                    </button>
                  ) : null}
                  <span className="cl-muted">{new Date(comment.createdAt).toLocaleString('ru-RU')}</span>
                  {comment.editedAt ? <span className="cl-muted">(изменено)</span> : null}
                </div>

                {comment.parentCommentId && byId.get(comment.parentCommentId) ? (
                  <div className="cl-reply-quote">
                    {byId.get(comment.parentCommentId)?.author?.displayName ??
                      byId.get(comment.parentCommentId)?.author?.username}
                    : {byId.get(comment.parentCommentId)?.body?.slice(0, 80)}
                  </div>
                ) : null}

                {editing === comment.id ? (
                  <EditBox initial={comment.body ?? ''} onCancel={() => setEditing(null)} onSave={(v) => void saveEdit(comment.id, v)} />
                ) : (
                  /* Текст рендерится как текстовый узел — никакого dangerouslySetInnerHTML. */
                  <div className="cl-comment-body">{comment.body}</div>
                )}

                <div className="cl-reactions">
                  {EMOJI.map((emoji) =>
                    comment.reactions[emoji] || comment.myReactions.includes(emoji) ? (
                      <button
                        key={emoji}
                        className={`cl-reaction${comment.myReactions.includes(emoji) ? ' mine' : ''}`}
                        onClick={() => void toggleReaction(comment, emoji)}
                      >
                        {emoji} {comment.reactions[emoji] ?? 0}
                      </button>
                    ) : null
                  )}
                  {canComment ? (
                    <>
                      <button className="cl-btn ghost sm" onClick={() => void toggleReaction(comment, '👍')}>
                        + 👍
                      </button>
                      <button className="cl-btn ghost sm" onClick={() => setReplyTo(comment)}>
                        Ответить
                      </button>
                      <button className="cl-btn ghost sm" onClick={() => setEditing(comment.id)}>
                        Изменить
                      </button>
                      <button className="cl-btn ghost sm" onClick={() => void remove(comment.id)}>
                        Удалить
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          ))
      )}

      {canComment ? (
        <div style={{ marginTop: 14, position: 'sticky', bottom: 0, background: 'var(--surface-100)', paddingTop: 8 }}>
          {replyTo ? (
            <div className="cl-reply-quote" style={{ marginBottom: 6 }}>
              Ответ: {replyTo.author?.displayName ?? replyTo.author?.username} · {replyTo.body?.slice(0, 60)}
              <button className="cl-btn ghost sm" onClick={() => setReplyTo(null)}>
                ✕
              </button>
            </div>
          ) : null}
          <textarea
            className="cl-textarea"
            placeholder="Написать комментарий…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
            }}
            style={{ minHeight: 62 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 8 }}>
            {onSeek ? (
              <label className="cl-check-row" style={{ padding: 0, fontSize: 13 }}>
                <input type="checkbox" checked={withTimestamp} onChange={(e) => setWithTimestamp(e.target.checked)} />
                привязать к {formatDuration(currentTimeMs())}
              </label>
            ) : null}
            <div className="cl-spacer" />
            <button className="cl-btn primary sm" onClick={() => void submit()} disabled={!text.trim()}>
              Отправить
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  return (
    <div style={{ marginTop: 5 }}>
      <textarea className="cl-textarea" value={value} onChange={(e) => setValue(e.target.value)} style={{ minHeight: 56 }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button className="cl-btn primary sm" onClick={() => onSave(value.trim())} disabled={!value.trim()}>
          Сохранить
        </button>
        <button className="cl-btn ghost sm" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  )
}
