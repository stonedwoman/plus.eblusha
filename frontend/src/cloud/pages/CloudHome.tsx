import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { cloudApi, formatBytes, toCloudError } from '../api'
import type { CloudSpace } from '../types'
import { Avatar, Empty, Modal, toast } from '../components/ui'
import { cloudPath } from '../basePath'

/** Домашний экран: мои Space и те, куда позвали. */
export default function CloudHome() {
  const [spaces, setSpaces] = useState<CloudSpace[] | null>(null)
  const [creating, setCreating] = useState(false)
  // Ошибку держим отдельно: раньше сбой сети подменялся пустым массивом, и
  // человек видел «здесь пока пусто» вместо «не удалось загрузить». Разница
  // принципиальная — во втором случае у него есть что нажать.
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await cloudApi.get<{ spaces: CloudSpace[] }>('/spaces')
      setSpaces(data.spaces)
      setError(null)
    } catch (err) {
      setError(toCloudError(err).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const mine = (spaces ?? []).filter((s) => s.role === 'OWNER')
  const shared = (spaces ?? []).filter((s) => s.role !== 'OWNER')

  return (
    <div className="cl-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
        <h1 className="cl-h1">Хуяпки</h1>
        <div className="cl-spacer" />
        <button className="cl-btn primary" onClick={() => setCreating(true)}>
          + Новая хуяпка
        </button>
      </div>

      {error ? (
        <Empty
          icon="⚠"
          title="Не удалось загрузить список"
          text={error}
          action={
            <button className="cl-btn primary" onClick={() => void load()}>
              Повторить
            </button>
          }
        />
      ) : spaces === null ? (
        <div className="cl-space-grid">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="cl-skeleton" style={{ height: 250 }} />
          ))}
        </div>
      ) : spaces.length === 0 ? (
        <Empty
          icon="☁"
          title="Здесь пока пусто"
          text="Хуяпка — это общий альбом: поездка, событие, проект. Хуяк — и всё лежит вместе. Создайте первую, позовите друзей и загрузите фотографии."
          action={
            <button className="cl-btn primary" onClick={() => setCreating(true)}>
              Создать хуяпку
            </button>
          }
        />
      ) : (
        <>
          {mine.length > 0 ? (
            <>
              <div className="cl-section-title">Мои хуяпки</div>
              <SpaceGrid spaces={mine} />
            </>
          ) : null}
          {shared.length > 0 ? (
            <>
              <div className="cl-section-title">Общие хуяпки</div>
              <SpaceGrid spaces={shared} />
            </>
          ) : null}
        </>
      )}

      {creating ? (
        <CreateSpaceModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}

function SpaceGrid({ spaces }: { spaces: CloudSpace[] }) {
  return (
    <div className="cl-space-grid">
      {spaces.map((space) => (
        <Link className="cl-space-card" key={space.id} to={cloudPath(`/space/${space.id}`)}>
          <div className={`cl-space-cover${space.coverUrl ? '' : ' empty'}`}>
            {space.coverUrl ? (
              /* Обложка могла умереть (файл удалён, кэш производных подрезан):
                 битая картинка превращает карточку в сломанную — прячем её и
                 остаётся нейтральный фон с пиктограммой. */
              <img
                src={space.coverUrl}
                alt=""
                loading="lazy"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                  e.currentTarget.parentElement?.classList.add('empty')
                }}
              />
            ) : (
              <span style={{ fontSize: 34 }}>🗂</span>
            )}
          </div>
          <div className="cl-space-body">
            <div className="cl-space-name">{space.name}</div>
            <div className="cl-space-meta">
              {space.stats ? (
                <>
                  {space.stats.photos > 0 ? <span>{space.stats.photos} фото</span> : null}
                  {space.stats.videos > 0 ? <span>{space.stats.videos} видео</span> : null}
                  {space.stats.others > 0 ? <span>{space.stats.others} файлов</span> : null}
                  {space.stats.files > 0 ? <span>{formatBytes(space.stats.bytes)}</span> : <span>пусто</span>}
                </>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10 }}>
              <div className="cl-ava-stack">
                {space.members.slice(0, 4).map((m) => (
                  <Avatar key={m.id} user={m} />
                ))}
              </div>
              {space.members.length > 4 ? <span className="cl-muted" style={{ fontSize: 12 }}>+{space.members.length - 4}</span> : null}
              <div className="cl-spacer" />
              {space.role !== 'OWNER' ? <span className="cl-muted" style={{ fontSize: 11.5 }}>{space.role}</span> : null}
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}

function CreateSpaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await cloudApi.post('/spaces', { name: name.trim(), description: description.trim() || undefined })
      toast.success('Хуяпка создана')
      onCreated()
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Новая хуяпка"
      onClose={onClose}
      footer={
        <>
          <button className="cl-btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="cl-btn primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            Создать
          </button>
        </>
      }
    >
      <div className="cl-field">
        <label className="cl-label">Название</label>
        <input
          className="cl-input"
          autoFocus
          placeholder="Армения 2026"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </div>
      <div className="cl-field">
        <label className="cl-label">Описание (необязательно)</label>
        <textarea
          className="cl-textarea"
          placeholder="Поездка втроём, август"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
    </Modal>
  )
}
