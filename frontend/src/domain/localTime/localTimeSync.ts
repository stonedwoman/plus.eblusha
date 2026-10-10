/**
 * Местное время — подключение к сокету браузера/Electron (utils/socket.ts зовёт installLocalTimeSync
 * один раз при загрузке модуля). Что делает:
 *  - сообщает серверу пояс этого устройства (localTimeReporter: на каждом connect после presence:state
 *    и при смене пояса);
 *  - принимает localtime:update {userId, localTime} — пояс собеседника сменился или он его скрыл (null);
 *  - принимает localtime:settings {shareLocalTime, shareLocalTimeAt} — своя настройка поменялась
 *    (в том числе с другого устройства);
 *  - на каждом connect поднимает «эпоху»: открытый диалог перезапросит пояс собеседника.
 */
import type { Socket } from 'socket.io-client'
import {
  detectDeviceTimeZone,
  normalizeLocalTimeInfo,
  normalizeShareState,
  type LocalTimeShareState,
} from './localTime'
import {
  createLocalTimeReporter,
  LOCALTIME_REPORT_EVENT,
  LOCALTIME_SETTINGS_EVENT,
  LOCALTIME_UPDATE_EVENT,
  TIME_ZONE_CHECK_MS,
  type LocalTimeReporter,
} from './localTimeReporter'
import { bumpLocalTimeEpoch, clearPeerLocalTimes, setOwnShareState, setPeerLocalTime } from './localTimeStore'

const SHARE_KEY_PREFIX = 'eb_localtime_share_v1:'
const REPORT_ACK_TIMEOUT_MS = 10_000

export function loadStoredShareState(userId: string): LocalTimeShareState | null {
  try {
    const raw = window.localStorage.getItem(SHARE_KEY_PREFIX + userId)
    return raw ? normalizeShareState(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function saveStoredShareState(userId: string, state: LocalTimeShareState): void {
  try {
    window.localStorage.setItem(SHARE_KEY_PREFIX + userId, JSON.stringify(state))
  } catch {
    /* приватный режим / квота — напоминание просто не переживёт перезапуск */
  }
}

let reporter: LocalTimeReporter | null = null

export type LocalTimeSyncDeps = {
  socket: Socket
  /** Подписка на «presence:state ушёл»; возвращает отписку. */
  onPresenceStateSent: (cb: () => void) => () => void
  getUserId: () => string | null
  /** Подписка на смену вошедшего человека (выход/вход другим). */
  onUserChange: (cb: (userId: string | null) => void) => () => void
}

export function installLocalTimeSync(deps: LocalTimeSyncDeps): void {
  if (reporter) return
  if (typeof window === 'undefined') return
  const { socket } = deps

  reporter = createLocalTimeReporter({
    isConnected: () => socket.connected,
    emitReport: (payload, cb) => {
      socket.timeout(REPORT_ACK_TIMEOUT_MS).emit(LOCALTIME_REPORT_EVENT, payload, (err: unknown, ack: unknown) => cb(err, ack))
    },
    detectTimeZone: detectDeviceTimeZone,
    getUserId: deps.getUserId,
    loadShare: loadStoredShareState,
    saveShare: saveStoredShareState,
    onShareState: setOwnShareState,
  })
  const r = reporter

  socket.on('connect', () => {
    bumpLocalTimeEpoch()
    r.onConnect()
  })
  socket.on('disconnect', () => r.onDisconnect())
  deps.onPresenceStateSent(() => r.onPresenceSent())

  socket.on(LOCALTIME_UPDATE_EVENT, (p: unknown) => {
    const userId = typeof (p as { userId?: unknown })?.userId === 'string' ? ((p as { userId: string }).userId) : ''
    if (!userId) return
    const info = normalizeLocalTimeInfo((p as { localTime?: unknown }).localTime)
    setPeerLocalTime(userId, info ?? null)
  })
  socket.on(LOCALTIME_SETTINGS_EVENT, (p: unknown) => {
    r.applyServerShare(p)
  })

  const check = () => {
    try {
      r.checkTimeZone()
    } catch {
      /* ignore */
    }
  }
  setInterval(check, TIME_ZONE_CHECK_MS)
  try {
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check()
    })
  } catch {
    /* ignore */
  }

  deps.onUserChange((userId) => {
    clearPeerLocalTimes()
    setOwnShareState(userId ? loadStoredShareState(userId) : null)
  })
  if (socket.connected) r.onConnect()
}

/** Ответ GET/PUT /status/me/local-time (экран настроек) → сохранить и, если надо, напомнить серверу. */
export function applyOwnLocalTimeStateFromServer(raw: unknown): LocalTimeShareState | null {
  if (reporter) return reporter.applyServerShare(raw)
  const s = normalizeShareState(raw)
  if (s) setOwnShareState(s)
  return s
}
