import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { connectSocket, onContactAccepted, onContactRequest } from '../../utils/socket'

export default function ContactsPage() {
  const client = useQueryClient()
  const [filter, setFilter] = useState<'accepted' | 'incoming' | 'outgoing' | 'all'>('accepted')

  const contactsQuery = useQuery({
    queryKey: ['contacts', filter],
    queryFn: async () => {
      const response = await api.get('/contacts', { params: { filter } })
      return response.data.contacts as Array<any>
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
              <button
                onClick={async () => {
                  const resp = await api.post('/conversations/with', { userId: contact.friend.id })
                  // TODO: переход на страницу конкретного чата (роутинг)
                  client.invalidateQueries({ queryKey: ['conversations'] })
                }}
              >
                Начать чат
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}




