import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Loader2, RefreshCw, X } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../../utils/api'
import { copyPlainText } from '../../utils/clipboard'
import { connectSocket, onContactAccepted, onContactRejected, onContactRequest } from '../../core/realtime'
import { withAppRoutePrefix } from '../../core/navigation/routes'

export default function ContactsPage() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const [filter, setFilter] = useState<'accepted' | 'incoming' | 'outgoing' | 'all'>('accepted')
  const [rejectedOutgoing, setRejectedOutgoing] = useState<Array<{ contactId: string; friend?: { id: string; username: string; displayName: string | null } }>>([])
  const [inviteNow, setInviteNow] = useState(() => Date.now())
  const [inviteCopied, setInviteCopied] = useState(false)

  const inviteCodeQuery = useQuery({
    queryKey: ['registration-invite-code'],
    queryFn: async () => {
      const response = await api.get('/auth/register/code')
      return response.data as { code: string; expiresAt: string; digits?: number }
    },
  })

  const contactsQuery = useQuery({
    queryKey: ['contacts', filter],
    queryFn: async () => {
      const response = await api.get('/contacts', { params: { filter } })
      return response.data.contacts as Array<any>
    },
  })

  const outgoingQuery = useQuery({
    queryKey: ['contacts', 'outgoing'],
    queryFn: async () => {
      const response = await api.get('/contacts', { params: { filter: 'outgoing' } })
      return response.data.contacts as Array<{ id: string; status: string; direction: string; friend: { id: string; username: string; displayName: string | null } }>
    },
  })

  const addMutation = useMutation({
    mutationFn: async (identifier: string) => {
      await api.post('/contacts/add', { identifier })
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['contacts'] })
    },
  })

  const respondMutation = useMutation({
    mutationFn: async (payload: { contactId: string; action: 'accept' | 'reject' | 'block' }) => {
      await api.post('/contacts/respond', payload)
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['contacts'] })
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (contactId: string) => {
      await api.post('/contacts/remove', { contactId })
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['contacts'] })
    },
  })

  // realtime updates
  useEffect(() => {
    connectSocket()
    const onNew = () => client.invalidateQueries({ queryKey: ['contacts'] })
    const onAccepted = () => client.invalidateQueries({ queryKey: ['contacts'] })
    onContactRejected((payload) => {
      setRejectedOutgoing((prev) => [...prev, { contactId: payload.contactId, friend: payload.friend ?? undefined }])
      client.invalidateQueries({ queryKey: ['contacts'] })
    })
    onContactRequest(onNew)
    onContactAccepted(onAccepted)
  }, [client])

  const displayOutgoingWithRejected = useMemo(() => {
    const pending = (outgoingQuery.data ?? []).map((c) => ({ id: c.id, rejected: false as const, friend: c.friend }))
    const rejected = rejectedOutgoing.map((r) => ({
      id: r.contactId,
      rejected: true as const,
      friend: r.friend ?? { id: '', username: '', displayName: null },
    }))
    return [...pending, ...rejected]
  }, [outgoingQuery.data, rejectedOutgoing])

  useEffect(() => {
    const interval = window.setInterval(() => setInviteNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    const expiresAtRaw = inviteCodeQuery.data?.expiresAt
    if (!expiresAtRaw) return
    const expiresAtMs = Date.parse(expiresAtRaw)
    if (!Number.isFinite(expiresAtMs)) return
    const timeout = window.setTimeout(() => {
      void inviteCodeQuery.refetch()
    }, Math.max(250, expiresAtMs - Date.now() + 250))
    return () => window.clearTimeout(timeout)
  }, [inviteCodeQuery.data?.expiresAt, inviteCodeQuery.refetch])

  useEffect(() => {
    if (!inviteCopied) return
    const timeout = window.setTimeout(() => setInviteCopied(false), 1600)
    return () => window.clearTimeout(timeout)
  }, [inviteCopied])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const identifier = String(form.get('identifier') ?? '')
    if (!identifier) return
    addMutation.mutate(identifier)
    event.currentTarget.reset()
  }

  const inviteCode = typeof inviteCodeQuery.data?.code === 'string' ? inviteCodeQuery.data.code : ''
  const formattedInviteCode = useMemo(() => {
    if (!inviteCode) return '---- ----'
    return inviteCode.length > 4 ? `${inviteCode.slice(0, 4)} ${inviteCode.slice(4)}` : inviteCode
  }, [inviteCode])

  const inviteRemainingLabel = useMemo(() => {
    const expiresAtRaw = inviteCodeQuery.data?.expiresAt
    if (!expiresAtRaw) return '00:00'
    const expiresAtMs = Date.parse(expiresAtRaw)
    if (!Number.isFinite(expiresAtMs)) return '00:00'
    const remainingSeconds = Math.max(0, Math.ceil((expiresAtMs - inviteNow) / 1000))
    const minutes = Math.floor(remainingSeconds / 60)
    const seconds = remainingSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }, [inviteCodeQuery.data?.expiresAt, inviteNow])

  const handleCopyInviteCode = async () => {
    if (!inviteCode) return
    const copied = await copyPlainText(inviteCode)
    if (copied) {
      setInviteCopied(true)
    }
  }

  const handleRefreshInviteCode = async () => {
    setInviteCopied(false)
    await inviteCodeQuery.refetch()
  }

  return (
    <div className="contacts-page">
      <section className="contacts-page__invite-card">
        <div className="contacts-page__invite-top">
          <div>
            <div className="contacts-page__invite-title">Код регистрации</div>
            <div className="contacts-page__invite-hint">
              Дай этот код новому пользователю. После регистрации вы сразу окажетесь в друзьях.
            </div>
          </div>
          <div className="contacts-page__invite-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleRefreshInviteCode}
              disabled={inviteCodeQuery.isFetching}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13 }}
            >
              <RefreshCw size={16} aria-hidden className={inviteCodeQuery.isFetching ? 'contacts-page__invite-spin' : undefined} />
              Обновить
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleCopyInviteCode}
              disabled={!inviteCode || inviteCodeQuery.isLoading}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13 }}
            >
              {inviteCopied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
              {inviteCopied ? 'Скопировано' : 'Скопировать'}
            </button>
          </div>
        </div>
        <div className="contacts-page__invite-code">
          {inviteCodeQuery.isLoading ? 'Загружаем…' : formattedInviteCode}
        </div>
        <div className="contacts-page__invite-footer">
          {inviteCodeQuery.isError ? (
            <span>Не удалось получить код. Попробуй открыть вкладку еще раз.</span>
          ) : (
            <span>Код обновится через {inviteRemainingLabel}</span>
          )}
        </div>
      </section>
      <header>
        <h2>Контакты</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value as any)}>
            <option value="accepted">Друзья</option>
            <option value="incoming">Входящие</option>
            <option value="outgoing">Исходящие</option>
            <option value="all">Все</option>
          </select>
        </div>
        <form onSubmit={handleSubmit}>
          <input name="identifier" placeholder="ID / логин / email" required />
          <button type="submit" disabled={addMutation.isPending}>
            Добавить
          </button>
        </form>
      </header>

      {filter === 'accepted' && displayOutgoingWithRejected.length > 0 && (
        <div className="contacts-page__pending-wrap">
          {displayOutgoingWithRejected.map((item) =>
            item.rejected ? (
              <div key={item.id} className="contacts-page__pending-card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="contacts-page__pending-text" style={{ flex: 1 }}>
                  <span className="contacts-page__pending-title">{item.friend.displayName ?? item.friend.username ?? 'Пользователь'}</span>
                  <span className="contacts-page__pending-hint">Запрос отклонён</span>
                </div>
                <button
                  type="button"
                  className="btn btn-icon btn-ghost"
                  onClick={() => setRejectedOutgoing((p) => p.filter((r) => r.contactId !== item.id))}
                  aria-label="Убрать"
                >
                  <X size={18} />
                </button>
              </div>
            ) : (
              <div key={item.id} className="contacts-page__pending-card">
                <Loader2 size={20} className="contacts-page__pending-icon" aria-hidden />
                <div className="contacts-page__pending-text">
                  <span className="contacts-page__pending-title">Ожидание подтверждения</span>
                  <span className="contacts-page__pending-hint">Попроси зайти в «Контакты» и подтвердить.</span>
                </div>
              </div>
            )
          )}
        </div>
      )}

      <ul>
        {contactsQuery.data?.map((contact: any) => (
          <li key={contact.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <strong style={{ minWidth: 220 }}>{contact.friend.displayName ?? contact.friend.username}</strong>
            <span style={{ textTransform: 'lowercase' }}>{contact.status.toLowerCase()}</span>
            {contact.status === 'PENDING' && contact.direction === 'incoming' && (
              <>
                <button onClick={() => respondMutation.mutate({ contactId: contact.id, action: 'accept' })}>
                  Принять
                </button>
                <button onClick={() => respondMutation.mutate({ contactId: contact.id, action: 'reject' })}>
                  Отклонить
                </button>
              </>
            )}
            {contact.status === 'PENDING' && contact.direction === 'outgoing' && (
              <span>ожидание подтверждения…</span>
            )}
            {contact.status === 'ACCEPTED' && (
              <>
                <button
                  className="btn btn-icon btn-secondary"
                  title="Удалить из друзей"
                  onClick={() => removeMutation.mutate(contact.id)}
                  disabled={removeMutation.isPending}
                >
                  <X size={16} />
                </button>
                <button
                  onClick={async () => {
                    const response = await api.post('/conversations/with', { userId: contact.friend.id })
                    const conversationId = String(response.data?.conversation?.id ?? response.data?.id ?? '').trim()
                    client.invalidateQueries({ queryKey: ['conversations'] })
                    if (conversationId) {
                      navigate(withAppRoutePrefix(location.pathname, `/chats/${conversationId}`))
                    }
                  }}
                >
                  Начать чат
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}




