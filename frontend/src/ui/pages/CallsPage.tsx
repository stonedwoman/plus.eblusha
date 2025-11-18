import { type FormEvent, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../utils/api'
import { useAppStore } from '../../domain/store/appStore'
import { LiveKitRoom, VideoConference } from '@livekit/components-react'
import '@livekit/components-styles'

type TokenResponse = { token: string; url: string }

export default function CallsPage() {
  const user = useAppStore((s) => s.session?.user)
  const [room, setRoom] = useState<string>('demo-room')
  const [token, setToken] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)

  const preferredUrl = useMemo(() => {
    const envUrl = (import.meta as any).env?.VITE_LIVEKIT_URL as string | undefined
    return envUrl ?? serverUrl ?? 'ws://eblusha.org:7880'
  }, [serverUrl])

  const joinMutation = useMutation({
    mutationFn: async (payload: { room: string }) => {
      const resp = await api.post<TokenResponse>('/livekit/token', {
        room: payload.room,
        participantName: user?.displayName ?? user?.username ?? 'guest',
        participantMetadata: { app: 'eblusha', userId: user?.id },
      })
      return resp.data
    },
    onSuccess: (data) => {
      setToken(data.token)
      setServerUrl(data.url)
    },
  })

  const handleJoin = (e: FormEvent) => {
    e.preventDefault()
    if (!room) return
    joinMutation.mutate({ room })
  }

  const handleLeave = () => {
    setToken(null)
  }

  return (
    <div className="calls-page">
      {!token ? (
        <form onSubmit={handleJoin} className="auth-form" style={{ maxWidth: 420 }}>
          <h2>Подключиться к комнате</h2>
          <label>
            Комната
            <input
              name="room"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="room-id"
              required
            />
          </label>
          <button type="submit" disabled={joinMutation.isPending}>
            {joinMutation.isPending ? 'Подключаемся…' : 'Войти'}
          </button>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Сервер: {(import.meta as any).env?.VITE_LIVEKIT_URL || serverUrl || '—'}
          </div>
        </form>
      ) : (
        preferredUrl && (
          <LiveKitRoom
            serverUrl={preferredUrl}
            token={token}
            connect
            video
            audio
            onDisconnected={handleLeave}
            style={{ height: 'calc(100vh - 120px)' }}
         >
            <VideoConference />
          </LiveKitRoom>
        )
      )}
    </div>
  )
}




