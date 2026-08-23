import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { cloudApi, toCloudError } from '../api'
import type { CloudSpace, CloudUserLite } from '../types'
import { Avatar, Empty, toast } from '../components/ui'
import { cloudPath } from '../basePath'

type Peek = {
  space: CloudSpace
  role: string
  inviter: CloudUserLite | null
  alreadyMember: boolean
}

/**
 * Приглашение в Space. В отличие от публичной ссылки, здесь ВСЕГДА нужен вход
 * через Еблушу: каркас Cloud уже установил сессию до того, как мы сюда попали.
 * Секрет приглашения тоже лежит во фрагменте и на сервер в открытом виде не идёт.
 */
export default function JoinPage() {
  const { publicId = '' } = useParams()
  const navigate = useNavigate()
  const [peek, setPeek] = useState<Peek | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState('')

  useEffect(() => {
    const fragment = window.location.hash.startsWith('#t=') ? decodeURIComponent(window.location.hash.slice(3)) : ''
    if (!fragment) {
      setError('Ссылка неполная: секретная часть после «#» потерялась при копировании.')
      return
    }
    setSecret(fragment)
    cloudApi
      .post<Peek>(`/invites/${publicId}/peek`, { secret: fragment })
      .then(({ data }) => {
        setPeek(data)
        window.history.replaceState(null, '', window.location.pathname)
      })
      .catch((err) => setError(toCloudError(err).message))
  }, [publicId])

  const accept = useCallback(async () => {
    setBusy(true)
    try {
      const { data } = await cloudApi.post<{ spaceId: string }>(`/invites/${publicId}/accept`, { secret })
      toast.success('Вы присоединились к Space')
      navigate(cloudPath(`/space/${data.spaceId}`), { replace: true })
    } catch (err) {
      toast.error(toCloudError(err).message)
      setBusy(false)
    }
  }, [publicId, secret, navigate])

  if (error) {
    return (
      <div className="cl-page narrow">
        <Empty icon="🔗" title="Приглашение недействительно" text={error} />
      </div>
    )
  }

  if (!peek) {
    return (
      <div className="cl-page narrow">
        <div className="cl-skeleton" style={{ height: 180 }} />
      </div>
    )
  }

  if (peek.alreadyMember) {
    return (
      <div className="cl-page narrow">
        <Empty
          title={`Вы уже в «${peek.space.name}»`}
          action={
            <button className="cl-btn primary" onClick={() => navigate(cloudPath(`/space/${peek.space.id}`))}>
              Открыть Space
            </button>
          }
        />
      </div>
    )
  }

  return (
    <div className="cl-page narrow">
      <div className="cl-modal" style={{ margin: '40px auto', width: 'min(480px, 100%)' }}>
        <div className="cl-modal-body" style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <Avatar user={peek.inviter} size="lg" />
          </div>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 660 }}>
            {peek.inviter?.displayName || peek.inviter?.username || 'Кто-то'} приглашает вас в «{peek.space.name}»
          </h2>
          <p className="cl-muted" style={{ fontSize: 14, lineHeight: 1.55, margin: '0 0 20px' }}>
            {peek.role === 'EDITOR'
              ? 'Вы сможете просматривать файлы и добавлять свои.'
              : 'Вы сможете просматривать и скачивать файлы.'}
          </p>
          <button className="cl-btn primary" style={{ width: '100%' }} onClick={() => void accept()} disabled={busy}>
            Присоединиться
          </button>
        </div>
      </div>
    </div>
  )
}
