import { useCallback, useEffect, useState } from 'react'
import { cloudApi, toCloudError } from '../api'
import type { CloudInvite, CloudShare } from '../types'
import { Modal, QrCode, copyToClipboard, toast } from './ui'

/**
 * Два разных вида ссылок в одном окне — потому что путают их постоянно:
 *
 *   «Пригласить» — вход только через Еблушу, даёт роль в Space.
 *   «Публичная ссылка» — read-only, без регистрации, только просмотр/скачивание.
 *
 * Секрет ссылки сервер отдаёт ровно один раз при создании и хранит только его
 * хеш. Восстановить старую ссылку нельзя даже администратору — можно выпустить
 * новую, а старую отозвать.
 */
export function ShareDialog({
  spaceId,
  onClose,
  preselectedFileIds,
}: {
  spaceId: string
  onClose: () => void
  preselectedFileIds?: string[]
}) {
  const [tab, setTab] = useState<'public' | 'invite'>('public')
  return (
    <Modal title="Доступ к хуяпке" onClose={onClose} wide>
      <div className="cl-chips" style={{ marginBottom: 16 }}>
        <button className={`cl-chip${tab === 'public' ? ' is-active' : ''}`} onClick={() => setTab('public')}>
          Публичная ссылка
        </button>
        <button className={`cl-chip${tab === 'invite' ? ' is-active' : ''}`} onClick={() => setTab('invite')}>
          Пригласить в хуяпку
        </button>
      </div>
      {tab === 'public' ? (
        <PublicShareTab spaceId={spaceId} preselectedFileIds={preselectedFileIds} />
      ) : (
        <InviteTab spaceId={spaceId} />
      )}
    </Modal>
  )
}

const EXPIRY_OPTIONS: { label: string; hours: number | null }[] = [
  { label: '24 часа', hours: 24 },
  { label: '7 дней', hours: 24 * 7 },
  { label: '30 дней', hours: 24 * 30 },
  { label: 'Бессрочно', hours: null },
]

function PublicShareTab({ spaceId, preselectedFileIds }: { spaceId: string; preselectedFileIds?: string[] }) {
  const [shares, setShares] = useState<CloudShare[]>([])
  const [allowPreview, setAllowPreview] = useState(true)
  const [allowDownload, setAllowDownload] = useState(true)
  const [allowMetadata, setAllowMetadata] = useState(false)
  const [expiry, setExpiry] = useState<number | null>(24 * 30)
  const [password, setPassword] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await cloudApi.get<{ shares: CloudShare[] }>('/shares', { params: { spaceId } })
      setShares(data.shares)
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }, [spaceId])

  useEffect(() => {
    void load()
  }, [load])

  const create = async () => {
    setBusy(true)
    try {
      const { data } = await cloudApi.post<{ url: string }>('/shares', {
        spaceId,
        targetType: preselectedFileIds?.length ? 'SELECTION' : 'SPACE',
        ...(preselectedFileIds?.length ? { fileIds: preselectedFileIds } : {}),
        allowPreview,
        allowDownload,
        allowMetadata,
        expiresInHours: expiry,
        password: password.trim() || null,
      })
      setCreated(data.url)
      setPassword('')
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    try {
      await cloudApi.delete(`/shares/${id}`)
      toast.success('Ссылка отозвана — доступ прекращён немедленно')
      if (created) setCreated(null)
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }

  if (created) {
    return (
      <div>
        <div className="cl-toast success" style={{ marginBottom: 14 }}>
          Ссылка создана. Секрет показывается один раз — сохраните её сейчас.
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <QrCode text={created} size={168} />
          <div style={{ flex: '1 1 260px', minWidth: 240 }}>
            <textarea className="cl-textarea" readOnly value={created} style={{ minHeight: 84, fontSize: 12.5 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
              <button
                className="cl-btn primary sm"
                onClick={async () => {
                  const ok = await copyToClipboard(created)
                  if (ok) toast.success('Скопировано')
                  else toast.error('Не удалось скопировать — выделите текст вручную')
                }}
              >
                Копировать
              </button>
              <a className="cl-btn sm" href={created} target="_blank" rel="noreferrer">
                Открыть
              </a>
              <button className="cl-btn ghost sm" onClick={() => setCreated(null)}>
                Готово
              </button>
            </div>
            <div className="cl-muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
              Секрет находится после «#», поэтому он не уходит на сервер и не попадает в журналы доступа.
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      {preselectedFileIds?.length ? (
        <div className="cl-muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Ссылка будет открывать выбранные файлы ({preselectedFileIds.length}), а не всю хуяпку.
        </div>
      ) : null}

      <label className="cl-check-row">
        <input type="checkbox" checked={allowPreview} onChange={(e) => setAllowPreview(e.target.checked)} />
        Просмотр превью и видео
      </label>
      <label className="cl-check-row">
        <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
        Скачивание оригиналов и ZIP
      </label>
      <label className="cl-check-row">
        <input type="checkbox" checked={allowMetadata} onChange={(e) => setAllowMetadata(e.target.checked)} />
        Показывать съёмочные данные
      </label>
      <div className="cl-muted" style={{ fontSize: 12, marginTop: -2, marginLeft: 26, lineHeight: 1.45 }}>
        Координаты съёмки, камера и параметры кадра. По умолчанию скрыты: геометка —
        это адрес места, где вы были.
      </div>

      <div className="cl-field" style={{ marginTop: 14 }}>
        <label className="cl-label">Срок действия</label>
        <div className="cl-chips">
          {EXPIRY_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              className={`cl-chip${expiry === opt.hours ? ' is-active' : ''}`}
              onClick={() => setExpiry(opt.hours)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="cl-field">
        <label className="cl-label">Пароль (необязательно)</label>
        <input
          className="cl-input"
          type="password"
          autoComplete="new-password"
          placeholder="без пароля"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <button className="cl-btn primary" onClick={() => void create()} disabled={busy}>
        Создать ссылку
      </button>

      {shares.length > 0 ? (
        <>
          <div className="cl-section-title">Активные ссылки</div>
          {shares.map((share) => (
            <div key={share.id} className="cl-meta-row" style={{ alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13.5 }}>
                  {share.targetType === 'SPACE' ? 'Вся хуяпка' : share.targetType === 'SELECTION' ? `${share.fileCount} файлов` : share.targetType}
                  {share.hasPassword ? ' · с паролем' : ''}
                </div>
                <div className="cl-muted" style={{ fontSize: 11.5 }}>
                  {share.expiresAt ? `до ${new Date(share.expiresAt).toLocaleDateString('ru-RU')}` : 'бессрочно'} ·{' '}
                  просмотров {share.viewCount} · скачиваний {share.downloadCount}
                  {share.allowDownload ? '' : ' · без скачивания'}
                </div>
              </div>
              <button className="cl-btn danger sm" onClick={() => void revoke(share.id)}>
                Отозвать
              </button>
            </div>
          ))}
        </>
      ) : null}
    </div>
  )
}

function InviteTab({ spaceId }: { spaceId: string }) {
  const [invites, setInvites] = useState<CloudInvite[]>([])
  const [role, setRole] = useState<'EDITOR' | 'VIEWER'>('EDITOR')
  const [created, setCreated] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ id: string; username: string; displayName: string | null; avatarUrl: string | null }[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await cloudApi.get<{ invites: CloudInvite[] }>('/invites', { params: { spaceId } })
      setInvites(data.invites)
    } catch (err) {
      toast.error(toCloudError(err).message)
    }
  }, [spaceId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (query.trim().length < 3) {
      setResults([])
      return
    }
    const t = setTimeout(async () => {
      try {
        const { data } = await cloudApi.get<{ users: typeof results }>('/users/search', { params: { q: query.trim() } })
        setResults(data.users)
      } catch {
        setResults([])
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  const addMember = async (userId: string) => {
    setBusy(true)
    try {
      await cloudApi.post(`/spaces/${spaceId}/members`, { userId, role })
      toast.success('Участник добавлен')
      setQuery('')
      setResults([])
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setBusy(false)
    }
  }

  const createLink = async () => {
    setBusy(true)
    try {
      const { data } = await cloudApi.post<{ url: string }>('/invites', { spaceId, role, maxUses: 10, expiresInHours: 24 * 14 })
      setCreated(data.url)
      await load()
    } catch (err) {
      toast.error(toCloudError(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="cl-field">
        <label className="cl-label">Роль</label>
        <div className="cl-chips">
          <button className={`cl-chip${role === 'EDITOR' ? ' is-active' : ''}`} onClick={() => setRole('EDITOR')}>
            EDITOR — может загружать
          </button>
          <button className={`cl-chip${role === 'VIEWER' ? ' is-active' : ''}`} onClick={() => setRole('VIEWER')}>
            VIEWER — только смотрит
          </button>
        </div>
      </div>

      <div className="cl-field">
        <label className="cl-label">Найти пользователя Еблуши</label>
        <input
          className="cl-input"
          placeholder="логин или имя, от 3 символов"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {results.length > 0 ? (
          <div className="cl-list" style={{ marginTop: 8 }}>
            {results.map((user) => (
              <div
                key={user.id}
                className="cl-row"
                style={{ gridTemplateColumns: '1fr auto' }}
                onClick={() => void addMember(user.id)}
              >
                <div>
                  <div className="cl-row-name">{user.displayName || user.username}</div>
                  <div className="cl-row-sub">@{user.username}</div>
                </div>
                <button className="cl-btn sm" disabled={busy}>
                  Добавить
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="cl-section-title">Ссылка-приглашение</div>
      <p className="cl-muted" style={{ fontSize: 13, lineHeight: 1.55, marginTop: 0 }}>
        По такой ссылке нельзя ничего скачать без входа: она всегда требует авторизации через Еблушу и только затем
        добавляет человека в хуяпку.
      </p>

      {created ? (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
          <QrCode text={created} size={148} />
          <div style={{ flex: '1 1 240px' }}>
            <textarea className="cl-textarea" readOnly value={created} style={{ minHeight: 78, fontSize: 12.5 }} />
            <button
              className="cl-btn primary sm"
              style={{ marginTop: 8 }}
              onClick={async () => {
                const ok = await copyToClipboard(created)
                if (ok) toast.success('Скопировано')
                else toast.error('Не удалось скопировать — выделите текст вручную')
              }}
            >
              Копировать
            </button>
          </div>
        </div>
      ) : (
        <button className="cl-btn" onClick={() => void createLink()} disabled={busy}>
          Создать ссылку-приглашение
        </button>
      )}

      {invites.length > 0 ? (
        <>
          <div className="cl-section-title">Активные приглашения</div>
          {invites.map((invite) => (
            <div key={invite.id} className="cl-meta-row" style={{ alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13.5 }}>{invite.role}</div>
                <div className="cl-muted" style={{ fontSize: 11.5 }}>
                  использовано {invite.useCount} из {invite.maxUses}
                  {invite.expiresAt ? ` · до ${new Date(invite.expiresAt).toLocaleDateString('ru-RU')}` : ''}
                </div>
              </div>
              <button
                className="cl-btn danger sm"
                onClick={async () => {
                  try {
                    await cloudApi.delete(`/invites/${invite.id}`)
                    await load()
                  } catch (err) {
                    toast.error(toCloudError(err).message)
                  }
                }}
              >
                Отозвать
              </button>
            </div>
          ))}
        </>
      ) : null}
    </div>
  )
}
