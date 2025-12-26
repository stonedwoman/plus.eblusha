import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { connectSocket, onContactAccepted, onContactRequest } from '../../utils/socket'
import { Avatar } from '../components/Avatar'
import { ProfileOverlay } from '../components/profile/ProfileOverlay'

export default function ContactsPage() {
  const client = useQueryClient()
  const [filter, setFilter] = useState<'accepted' | 'incoming' | 'outgoing' | 'all'>('accepted')
  const [isMobile, setIsMobile] = useState(false)
  const [profileOverlay, setProfileOverlay] = useState<{ open: boolean; user: any | null; contact: any | null }>(() => ({ open: false, user: null, contact: null }))

  useEffect(() => {
    const measure = () => setIsMobile(typeof window !== 'undefined' ? window.innerWidth <= 768 : false)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const contactsQuery = useQuery({
    queryKey: ['contacts', filter],
    queryFn: async () => {
      const response = await api.get('/contacts', { params: { filter } })
      return response.data.contacts as Array<any>
    },
  })

  const meQuery = useQuery({
    queryKey: ['me-info'],
    queryFn: async () => {
      const r = await api.get('/status/me')
      return r.data.user as any
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

  // realtime updates
  useEffect(() => {
    connectSocket()
    const onNew = () => client.invalidateQueries({ queryKey: ['contacts'] })
    const onAccepted = () => client.invalidateQueries({ queryKey: ['contacts'] })
    onContactRequest(onNew)
    onContactAccepted(onAccepted)
  }, [client])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const identifier = String(form.get('identifier') ?? '')
    if (!identifier) return
    addMutation.mutate(identifier)
    event.currentTarget.reset()
  }

  return (
    <div className="contacts-page">
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
          <input name="identifier" placeholder="ID / ник / email" required />
          <button type="submit" disabled={addMutation.isPending}>
            Добавить
          </button>
        </form>
      </header>
      <ul>
        {contactsQuery.data?.map((contact: any) => (
          <li key={contact.id} style={{ listStyle: 'none' }}>
            <div
              className="contacts-nav-item"
              style={{ cursor: 'default' }}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const u = contact.friend
                  setProfileOverlay((prev) =>
                    prev.open && prev.user?.id === u.id
                      ? { open: false, user: null, contact: null }
                      : { open: true, user: u, contact }
                  )
                }}
                style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
                aria-label="Открыть профиль"
              >
                <Avatar
                  name={contact.friend.displayName ?? contact.friend.username}
                  id={contact.friend.id}
                  presence={contact.friend.status}
                  avatarUrl={contact.friend.avatarUrl ?? undefined}
                />
              </button>
              <div className="contacts-nav-item__main">
                <div className="contacts-nav-item__name-row">
                  <div className="contacts-nav-item__name">
                    {contact.friend.displayName ?? contact.friend.username}
                  </div>
                </div>
                <div className="contacts-nav-item__status" style={{ textTransform: 'lowercase' }}>
                  {contact.status.toLowerCase()}
                </div>
              </div>
              {/* actions are intentionally not inside the row per UI rules */}
              {contact.status === 'PENDING' && contact.direction === 'outgoing' && (
                <div style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 13 }}>ожидание…</div>
              )}
            </div>
          </li>
        ))}
      </ul>

      <ProfileOverlay
        open={profileOverlay.open}
        isMobile={isMobile}
        user={profileOverlay.user}
        meId={meQuery.data?.id ?? null}
        statusText={profileOverlay.user ? (profileOverlay.user.status === 'IN_CALL' ? 'В ЗВОНКЕ' : (profileOverlay.user.status || '').toString()) : ''}
        idLabel={profileOverlay.user?.eblid ? 'EBLID' : 'ID'}
        idValue={(profileOverlay.user?.eblid ?? profileOverlay.user?.id ?? '').toString()}
        isContact={true}
        canBlock={!!profileOverlay.contact?.id}
        contactRequest={{
          incoming: !!(profileOverlay.contact && profileOverlay.contact.status === 'PENDING' && profileOverlay.contact.direction === 'incoming'),
        }}
        secret={{ enabled: false, canOpen: false }}
        commonGroups={[]}
        onClose={() => setProfileOverlay({ open: false, user: null, contact: null })}
        onAcceptContact={() => {
          const c = profileOverlay.contact
          if (!c?.id) return
          respondMutation.mutate({ contactId: c.id, action: 'accept' })
          setProfileOverlay({ open: false, user: null, contact: null })
        }}
        onRejectContact={() => {
          const c = profileOverlay.contact
          if (!c?.id) return
          respondMutation.mutate({ contactId: c.id, action: 'reject' })
          setProfileOverlay({ open: false, user: null, contact: null })
        }}
        onCopyId={async () => {
          const value = (profileOverlay.user?.eblid ?? profileOverlay.user?.id ?? '').toString()
          if (!value) return
          try {
            await navigator.clipboard.writeText(value)
          } catch {
            // ignore
          }
        }}
        onWrite={async () => {
          const uid = profileOverlay.user?.id
          if (!uid) return
          const resp = await api.post('/conversations', { participantIds: [uid], isGroup: false })
          const cid = resp?.data?.conversation?.id
          if (cid) {
            try {
              window.localStorage.setItem('eblusha:last-active-conversation', cid)
            } catch {
              // ignore
            }
          }
          window.location.assign('/')
        }}
        onRemoveContact={async () => {
          const c = profileOverlay.contact
          if (!c?.id) return
          await api.post('/contacts/remove', { contactId: c.id })
          client.invalidateQueries({ queryKey: ['contacts'] })
          setProfileOverlay({ open: false, user: null, contact: null })
        }}
        onBlock={async () => {
          const c = profileOverlay.contact
          if (!c?.id) return
          await api.post('/contacts/respond', { contactId: c.id, action: 'block' })
          client.invalidateQueries({ queryKey: ['contacts'] })
          setProfileOverlay({ open: false, user: null, contact: null })
        }}
      />
    </div>
  )
}




