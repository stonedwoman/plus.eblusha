import { describe, expect, it, vi } from 'vitest'
import { callOverlayCoversChat, canReadNow, createInputPresence, READ_IDLE_LIMIT_MS, type ReadGateState } from './readGate'

const seen: ReadGateState = { visible: true, focused: true, onScreen: true, callCovers: false, idleMs: 1_000 }

describe('canReadNow — «прочитано» только когда беседу правда видят', () => {
  it('всё сошлось — ставим', () => {
    expect(canReadNow(seen)).toBe(true)
  })
  it('вкладка скрыта или без фокуса — нет', () => {
    expect(canReadNow({ ...seen, visible: false })).toBe(false)
    expect(canReadNow({ ...seen, focused: false })).toBe(false)
  })
  it('узкий экран: беседа под списком — нет', () => {
    expect(canReadNow({ ...seen, onScreen: false })).toBe(false)
  })
  it('развёрнутый звонок закрывает беседу — нет', () => {
    expect(canReadNow({ ...seen, callCovers: true })).toBe(false)
  })
  it('без ввода минуту и дольше (отошёл от компьютера) — нет, чуть меньше — да', () => {
    expect(canReadNow({ ...seen, idleMs: READ_IDLE_LIMIT_MS })).toBe(false)
    expect(canReadNow({ ...seen, idleMs: 30 * 60_000 })).toBe(false)
    expect(canReadNow({ ...seen, idleMs: READ_IDLE_LIMIT_MS - 1 })).toBe(true)
  })
})

describe('callOverlayCoversChat — как CallOverlayHost', () => {
  it('идёт звонок, не свёрнут — закрывает; свёрнут в миниатюру — нет', () => {
    expect(callOverlayCoversChat({ callConvId: 'c1', minimizedCallConvId: null, outgoingConversationId: null, outgoingIsGroup: false })).toBe(true)
    expect(callOverlayCoversChat({ callConvId: 'c1', minimizedCallConvId: 'c1', outgoingConversationId: null, outgoingIsGroup: false })).toBe(false)
  })
  it('дозвон 1:1 — закрывает; группа (дозвона в оверлее нет) — нет', () => {
    expect(callOverlayCoversChat({ callConvId: null, minimizedCallConvId: null, outgoingConversationId: 'c2', outgoingIsGroup: false })).toBe(true)
    expect(callOverlayCoversChat({ callConvId: null, minimizedCallConvId: null, outgoingConversationId: 'g1', outgoingIsGroup: true })).toBe(false)
  })
  it('звонка нет — нет', () => {
    expect(callOverlayCoversChat({ callConvId: null, minimizedCallConvId: null, outgoingConversationId: null, outgoingIsGroup: false })).toBe(false)
  })
})

describe('createInputPresence — возврат к экрану после простоя', () => {
  it('ввод после минуты простоя зовёт onReturn один раз; частый ввод — нет', () => {
    let t = 1_000_000
    const onReturn = vi.fn()
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const p = createInputPresence({ onReturn, now: () => t, target: target as any })
    expect(target.addEventListener).toHaveBeenCalledTimes(5)
    t += 10_000
    p._input()
    expect(onReturn).not.toHaveBeenCalled()
    expect(p.idleMs()).toBe(0)
    t += READ_IDLE_LIMIT_MS + 5
    expect(p.idleMs()).toBeGreaterThanOrEqual(READ_IDLE_LIMIT_MS)
    p._input()
    expect(onReturn).toHaveBeenCalledTimes(1)
    t += 100
    p._input()
    expect(onReturn).toHaveBeenCalledTimes(1)
    p.dispose()
    expect(target.removeEventListener).toHaveBeenCalledTimes(5)
  })
})
