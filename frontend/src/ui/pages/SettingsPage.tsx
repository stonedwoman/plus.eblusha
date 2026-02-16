import { useMutation, useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { api } from '../../utils/api'
import { LinkDeviceModal } from '../components/LinkDeviceModal'

export default function SettingsPage() {
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const response = await api.get('/status/me')
      return response.data.user
    },
  })

  const devicesQuery = useQuery({
    queryKey: ['my-devices-settings'],
    queryFn: async () => {
      const r = await api.get('/devices')
      return (r.data?.devices ?? []) as any[]
    },
  })

  const mutation = useMutation({
    mutationFn: async (payload: { displayName?: string; bio?: string; status?: string }) => {
      const response = await api.patch('/status/me', payload)
      return response.data.user
    },
    onSuccess: () => {
      meQuery.refetch()
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      displayName: String(form.get('displayName') ?? ''),
      bio: String(form.get('bio') ?? ''),
      status: String(form.get('status') ?? ''),
    })
  }

  const user = meQuery.data
  const normalizedStatus = user?.status === 'BACKGROUND' ? 'ONLINE' : (user?.status ?? 'ONLINE')
  const [linkOpen, setLinkOpen] = useState(false)

  return (
    <div className="settings-page">
      <h2>Профиль</h2>
      <form onSubmit={handleSubmit}>
        <label>
          Имя
          <input name="displayName" defaultValue={user?.displayName ?? ''} />
        </label>
        <label>
          Статус
          <select name="status" defaultValue={normalizedStatus}>
            <option value="ONLINE">Онлайн</option>
            <option value="AWAY">Отошел</option>
            <option value="DND">Не беспокоить</option>
            <option value="OFFLINE">Оффлайн</option>
          </select>
        </label>
        <label>
          О себе
          <textarea name="bio" defaultValue={user?.bio ?? ''} />
        </label>
        <button type="submit" disabled={mutation.isPending}>
          Сохранить
        </button>
      </form>

      <div style={{ height: 24 }} />
      <h2>Устройства</h2>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Привязанные устройства получают доступ к секретной истории.
          </div>
          <button className="btn btn-primary" onClick={() => setLinkOpen(true)}>
            Привязать новое устройство
          </button>
        </div>

        <div
          style={{
            border: '1px solid var(--surface-border)',
            borderRadius: 14,
            background: 'var(--surface-100)',
            overflow: 'hidden',
          }}
        >
          {(devicesQuery.data || []).map((d: any) => (
            <div
              key={d.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '12px 14px',
                borderBottom: '1px solid var(--surface-border)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{d.name ?? d.id}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {d.platform ? String(d.platform) : '—'} · {d.lastSeenAt ? `last seen ${new Date(d.lastSeenAt).toLocaleString()}` : 'never'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  className="btn btn-secondary"
                  onClick={async () => {
                    if (!confirm('Отключить устройство?')) return
                    await api.delete(`/devices/${d.id}`)
                    devicesQuery.refetch()
                  }}
                >
                  Отключить
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <LinkDeviceModal open={linkOpen} onClose={() => setLinkOpen(false)} mode="trusted" />
    </div>
  )
}





