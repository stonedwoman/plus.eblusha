import { io, type Socket } from 'socket.io-client'
import { applyServerUploadEvent } from './uploads/manager'

/**
 * Realtime Cloud: отдельный namespace /cloud на том же Socket.IO-сервере.
 * Аутентификация — по HttpOnly-куке cloud_sid из рукопожатия, поэтому токены
 * через query не передаются вообще.
 *
 * Через сокет ходит только состояние. Файлы — никогда.
 */
type Listener = (payload: unknown) => void

let socket: Socket | null = null
const listeners = new Map<string, Set<Listener>>()
let currentSpace: string | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null

const EVENTS = [
  'cloud.upload.updated',
  'cloud.file.created',
  'cloud.file.processing',
  'cloud.file.ready',
  'cloud.file.updated',
  'cloud.file.deleted',
  'cloud.file.restored',
  'cloud.comment.created',
  'cloud.comment.updated',
  'cloud.comment.deleted',
  'cloud.reaction.changed',
  'cloud.member.joined',
  'cloud.member.left',
  'cloud.presence.changed',
  'cloud.activity.created',
  'cloud.space.updated',
  'cloud.folder.changed',
] as const

export function connectCloudSocket(): Socket {
  if (socket) return socket
  socket = io('/cloud', {
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnectionDelay: 800,
    reconnectionDelayMax: 8000,
  })

  for (const event of EVENTS) {
    socket.on(event, (payload: unknown) => {
      if (event === 'cloud.upload.updated') {
        applyServerUploadEvent(payload as Parameters<typeof applyServerUploadEvent>[0])
      }
      listeners.get(event)?.forEach((fn) => fn(payload))
    })
  }

  socket.on('connect', () => {
    // После реконнекта заново входим в комнату Space, иначе перестанут
    // приходить чужие загрузки и комментарии.
    if (currentSpace) socket?.emit('space:join', currentSpace)
    listeners.get('__connected')?.forEach((fn) => fn(true))
  })
  socket.on('disconnect', () => listeners.get('__connected')?.forEach((fn) => fn(false)))

  heartbeat = setInterval(() => socket?.emit('presence:ping'), 30_000)
  return socket
}

export function disconnectCloudSocket() {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  socket?.disconnect()
  socket = null
  currentSpace = null
}

export function joinSpaceRoom(spaceId: string | null) {
  const s = connectCloudSocket()
  if (currentSpace && currentSpace !== spaceId) s.emit('space:leave', currentSpace)
  currentSpace = spaceId
  if (spaceId) s.emit('space:join', spaceId)
}

export function onCloudEvent(event: string, fn: Listener): () => void {
  const set = listeners.get(event) ?? new Set<Listener>()
  set.add(fn)
  listeners.set(event, set)
  return () => set.delete(fn)
}
