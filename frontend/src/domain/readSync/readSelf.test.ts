import { describe, expect, it } from 'vitest'
import {
  allConversationsRead,
  createReadSelfSync,
  INCOMING_GRACE_MS,
  isFromOtherDevice,
  parseReadSelf,
  READ_SELF_REFRESH_DEBOUNCE_MS,
} from './readSelf'

const MY_DEVICE = 'dev-web'
const C = 'conv-1'

describe('parseReadSelf', () => {
  it('разбирает событие сервера', () => {
    expect(parseReadSelf({ conversationId: C, readAt: 1700, byDeviceId: 'dev-ios' })).toEqual({
      conversationId: C,
      readAt: 1700,
      byDeviceId: 'dev-ios',
      replay: false,
    })
    expect(parseReadSelf({ conversationId: C, readAt: 1700, replay: true })).toEqual({
      conversationId: C,
      readAt: 1700,
      byDeviceId: null,
      replay: true,
    })
  })
  it('мусор — null; кривые поля — null внутри', () => {
    expect(parseReadSelf(null)).toBeNull()
    expect(parseReadSelf({ readAt: 1 })).toBeNull()
    expect(parseReadSelf({ conversationId: '  ' })).toBeNull()
    expect(parseReadSelf({ conversationId: C, readAt: 'x', byDeviceId: '' })).toEqual({
      conversationId: C,
      readAt: null,
      byDeviceId: null,
      replay: false,
    })
  })
})

describe('isFromOtherDevice', () => {
  it('своё устройство — нет; чужое и неизвестное — да', () => {
    const ev = (byDeviceId: string | null) => ({ conversationId: C, readAt: 1, byDeviceId, replay: false })
    expect(isFromOtherDevice(ev(MY_DEVICE), MY_DEVICE)).toBe(false)
    expect(isFromOtherDevice(ev('dev-ios'), MY_DEVICE)).toBe(true)
    expect(isFromOtherDevice(ev(null), MY_DEVICE)).toBe(true)
    expect(isFromOtherDevice(ev(MY_DEVICE), null)).toBe(true)
  })
})

describe('allConversationsRead', () => {
  it('только когда нигде нет непрочитанного; нет списка — «не знаем»', () => {
    expect(allConversationsRead([{ unreadCount: 0 }, { unreadCount: 0 }])).toBe(true)
    expect(allConversationsRead([{ unreadCount: 0 }, {}])).toBe(true)
    expect(allConversationsRead([{ unreadCount: 0 }, { unreadCount: 2 }])).toBe(false)
    expect(allConversationsRead([])).toBe(false)
    expect(allConversationsRead(undefined)).toBe(false)
    expect(allConversationsRead([null])).toBe(false)
    expect(allConversationsRead([{ unreadCount: 'много' }])).toBe(false)
  })
})

function harness(over: {
  electron?: boolean
  rows?: unknown
  calls?: boolean
  refreshFails?: boolean
  incomingDuringRefresh?: boolean
} = {}) {
  let t = 5_000_000
  const timers = new Map<number, { at: number; fn: () => void }>()
  let nextHandle = 1
  let rows: unknown = over.rows ?? [{ unreadCount: 0 }]
  let lastIncoming = 0
  let refreshes = 0
  let hides = 0
  const sync = createReadSelfSync({
    myDeviceId: () => MY_DEVICE,
    refreshConversations: async () => {
      refreshes += 1
      if (over.incomingDuringRefresh) lastIncoming = t + 10
      if (over.refreshFails) throw new Error('offline')
    },
    getConversationRows: () => rows,
    hasCallActivity: () => !!over.calls,
    lastIncomingMessageAt: () => lastIncoming,
    hideAllOverlays: over.electron === false ? null : () => {
      hides += 1
    },
    now: () => t,
    setTimer: (fn, ms) => {
      const h = nextHandle++
      timers.set(h, { at: t + ms, fn })
      return h
    },
    clearTimer: (h) => {
      timers.delete(h as number)
    },
  })
  async function advance(ms: number) {
    const target = t + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      t = due[1].at
      due[1].fn()
    }
    t = target
    // дать промисам refresh → проверка выполниться
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return {
    sync,
    advance,
    refreshes: () => refreshes,
    hides: () => hides,
    setRows: (r: unknown) => {
      rows = r
    },
    setLastIncoming: (v: number) => {
      lastIncoming = v
    },
    now: () => t,
  }
}

describe('createReadSelfSync', () => {
  it('пачка событий (догон при подключении) — один запрос списка', async () => {
    const h = harness({ electron: false })
    for (let i = 0; i < 50; i++) h.sync.handle({ conversationId: `c${i}`, readAt: 1, replay: true })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS - 1)
    expect(h.refreshes()).toBe(0)
    await h.advance(1)
    expect(h.refreshes()).toBe(1)
  })

  it('мусор не трогает ничего', async () => {
    const h = harness()
    expect(h.sync.handle({ nope: true })).toBeNull()
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS * 2)
    expect(h.refreshes()).toBe(0)
    expect(h.hides()).toBe(0)
  })

  it('веб (не Electron): только перечитать счётчики', async () => {
    const h = harness({ electron: false })
    h.sync.handle({ conversationId: C, readAt: 1, byDeviceId: 'dev-ios' })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.refreshes()).toBe(1)
    expect(h.hides()).toBe(0)
  })

  it('Electron: прочитали на другом устройстве, всё прочитано, звонков нет — прячем плашки', async () => {
    const h = harness()
    h.sync.handle({ conversationId: C, readAt: 1, byDeviceId: 'dev-ios' })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.refreshes()).toBe(1)
    expect(h.hides()).toBe(1)
  })

  it('Electron: догон (устройство неизвестно) — тоже, если всё прочитано', async () => {
    const h = harness()
    h.sync.handle({ conversationId: C, readAt: 1, replay: true })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.hides()).toBe(1)
  })

  it('Electron: прочитали ЗДЕСЬ — плашки не трогаем (как натив), счётчики перечитываем', async () => {
    const h = harness()
    h.sync.handle({ conversationId: C, readAt: 1, byDeviceId: MY_DEVICE })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.refreshes()).toBe(1)
    expect(h.hides()).toBe(0)
  })

  it('Electron: где-то ещё есть непрочитанное — не прячем (мост умеет только «всё сразу»)', async () => {
    const h = harness({ rows: [{ unreadCount: 0 }, { unreadCount: 1 }] })
    h.sync.handle({ conversationId: C, readAt: 1, byDeviceId: 'dev-ios' })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.hides()).toBe(0)
  })

  it('Electron: идёт звонок — не прячем (звонковая плашка общая)', async () => {
    const h = harness({ calls: true })
    h.sync.handle({ conversationId: C, readAt: 1, byDeviceId: 'dev-ios' })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.hides()).toBe(0)
  })

  it('Electron: пришло входящее, пока перечитывали, — не прячем', async () => {
    const h = harness({ incomingDuringRefresh: true })
    h.sync.handle({ conversationId: C, readAt: 1, byDeviceId: 'dev-ios' })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.hides()).toBe(0)
  })

  it('Electron: входящее незадолго до перечитывания — не прячем; давнее — прячем', async () => {
    const h = harness()
    h.setLastIncoming(h.now() + READ_SELF_REFRESH_DEBOUNCE_MS - INCOMING_GRACE_MS + 10)
    h.sync.handle({ conversationId: C, readAt: 1, byDeviceId: 'dev-ios' })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.hides()).toBe(0)
    h.setLastIncoming(h.now() - INCOMING_GRACE_MS * 3)
    h.sync.handle({ conversationId: C, readAt: 2, byDeviceId: 'dev-ios' })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.hides()).toBe(1)
  })

  it('Electron: список не перечитался — не прячем', async () => {
    const h = harness({ refreshFails: true })
    h.sync.handle({ conversationId: C, readAt: 1, byDeviceId: 'dev-ios' })
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS)
    expect(h.hides()).toBe(0)
  })

  it('после dispose ничего не делает', async () => {
    const h = harness()
    h.sync.handle({ conversationId: C, readAt: 1, byDeviceId: 'dev-ios' })
    h.sync.dispose()
    await h.advance(READ_SELF_REFRESH_DEBOUNCE_MS * 2)
    expect(h.refreshes()).toBe(0)
    expect(h.sync.handle({ conversationId: C, readAt: 1 })).toBeNull()
  })
})
