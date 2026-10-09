import { describe, expect, it } from 'vitest'
import { createSecretReadSignal, newestIncomingMessageId, SECRET_READ_THROTTLE_MS } from './secretReadSignal'

const ME = 'u-me'
const PEER = 'u-peer'
const C = 'conv-1'

/** Ручные часы и таймеры: тест управляет временем сам, без реальных ожиданий. */
function harness(over: { eligible?: (cid: string) => boolean } = {}) {
  let t = 1_000_000
  const timers = new Map<number, { at: number; fn: () => void }>()
  let nextHandle = 1
  const sent: string[] = []
  let eligible = over.eligible ?? (() => true)
  const sig = createSecretReadSignal({
    send: (cid) => sent.push(cid),
    isEligible: (cid) => eligible(cid),
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
  function advance(ms: number) {
    const target = t + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      t = due[1].at
      due[1].fn()
    }
    t = target
  }
  return {
    sig,
    sent,
    advance,
    timers,
    setEligible: (fn: (cid: string) => boolean) => {
      eligible = fn
    },
  }
}

const msg = (id: string, senderId: string) => ({ id, senderId })

describe('newestIncomingMessageId', () => {
  it('берёт последнее чужое сообщение, свои пропускает', () => {
    expect(newestIncomingMessageId([msg('a', PEER), msg('b', ME), msg('c', ME)], ME)).toBe('a')
    expect(newestIncomingMessageId([msg('a', PEER), msg('b', PEER), msg('c', ME)], ME)).toBe('b')
  })

  it('пусто / нет входящих / мусор / неизвестен я — null', () => {
    expect(newestIncomingMessageId([], ME)).toBeNull()
    expect(newestIncomingMessageId([msg('a', ME)], ME)).toBeNull()
    expect(newestIncomingMessageId(undefined, ME)).toBeNull()
    expect(newestIncomingMessageId({} as unknown, ME)).toBeNull()
    expect(newestIncomingMessageId([msg('a', PEER)], null)).toBeNull()
    expect(newestIncomingMessageId([null, { senderId: PEER }, { id: 'x' }], ME)).toBeNull()
  })
})

describe('createSecretReadSignal.request', () => {
  it('первый вызов уходит сразу и несёт только id беседы', () => {
    const h = harness()
    h.sig.request(C)
    expect(h.sent).toEqual([C])
  })

  it('пустой id игнорируется', () => {
    const h = harness()
    h.sig.request('')
    h.sig.request('   ')
    expect(h.sent).toEqual([])
  })

  it('не отправляет, пока беседа не читаема / не на экране', () => {
    const h = harness({ eligible: () => false })
    h.sig.request(C)
    h.sig.request(C, { trailing: true })
    h.advance(10_000)
    expect(h.sent).toEqual([])
    expect(h.timers.size).toBe(0)
  })

  it('«состояние» внутри окна троттла отбрасывается без хвоста', () => {
    const h = harness()
    h.sig.request(C)
    h.advance(500)
    h.sig.request(C)
    h.sig.request(C)
    h.advance(10_000)
    expect(h.sent).toEqual([C])
  })

  it('после окна — снова передний вызов', () => {
    const h = harness()
    h.sig.request(C)
    h.advance(SECRET_READ_THROTTLE_MS)
    h.sig.request(C)
    expect(h.sent).toEqual([C, C])
  })

  it('«новое входящее» внутри окна даёт ровно один хвост в конце окна', () => {
    const h = harness()
    h.sig.request(C)
    h.advance(400)
    h.sig.request(C, { trailing: true })
    h.sig.request(C, { trailing: true })
    h.sig.request(C, { trailing: true })
    expect(h.sent).toEqual([C])
    h.advance(SECRET_READ_THROTTLE_MS - 400 - 1)
    expect(h.sent).toEqual([C])
    h.advance(1)
    expect(h.sent).toEqual([C, C])
    h.advance(10_000)
    expect(h.sent).toEqual([C, C])
  })

  it('хвост перепроверяет готовность: закрыли беседу / ушло окно — не отправляем', () => {
    const h = harness()
    h.sig.request(C)
    h.advance(300)
    h.sig.request(C, { trailing: true })
    h.setEligible(() => false)
    h.advance(10_000)
    expect(h.sent).toEqual([C])
  })

  it('беседы независимы: у каждой своё окно', () => {
    const h = harness()
    h.sig.request('a')
    h.sig.request('b')
    h.sig.request('a')
    expect(h.sent).toEqual(['a', 'b'])
  })

  it('часы ушли назад — хвост ждёт не дольше одного окна', () => {
    let t = 5_000_000
    const delays: number[] = []
    const sig = createSecretReadSignal({
      send: () => {},
      isEligible: () => true,
      now: () => t,
      setTimer: (_fn, ms) => {
        delays.push(ms)
        return 1
      },
      clearTimer: () => {},
    })
    sig.request(C)
    t -= 60_000
    sig.request(C, { trailing: true })
    expect(delays).toEqual([SECRET_READ_THROTTLE_MS])
  })

  it('ошибка send не роняет вызывающего и не ломает троттл', () => {
    let t = 0
    let calls = 0
    const sig = createSecretReadSignal({
      send: () => {
        calls++
        throw new Error('boom')
      },
      isEligible: () => true,
      now: () => t,
    })
    expect(() => sig.request(C)).not.toThrow()
    sig.request(C)
    expect(calls).toBe(1)
    t += SECRET_READ_THROTTLE_MS
    sig.request(C)
    expect(calls).toBe(2)
  })

  it('cancel снимает отложенный хвост', () => {
    const h = harness()
    h.sig.request(C)
    h.sig.request(C, { trailing: true })
    expect(h.timers.size).toBe(1)
    h.sig.cancel()
    expect(h.timers.size).toBe(0)
    h.advance(10_000)
    expect(h.sent).toEqual([C])
  })
})

describe('createSecretReadSignal.observeMessages', () => {
  it('первое наблюдение ленты только запоминается — «открыли» сообщает request', () => {
    const h = harness()
    h.sig.observeMessages(C, [msg('a', PEER)], ME)
    expect(h.sent).toEqual([])
  })

  it('периодический refetch тех же данных ничего не шлёт', () => {
    const h = harness()
    h.sig.observeMessages(C, [msg('a', PEER)], ME)
    h.advance(20_000)
    h.sig.observeMessages(C, [msg('a', PEER)], ME)
    h.advance(20_000)
    h.sig.observeMessages(C, [msg('a', PEER)], ME)
    expect(h.sent).toEqual([])
  })

  it('новое входящее — вызов; своё сообщение — нет', () => {
    const h = harness()
    h.sig.observeMessages(C, [msg('a', PEER)], ME)
    h.sig.observeMessages(C, [msg('a', PEER), msg('b', ME)], ME)
    expect(h.sent).toEqual([])
    h.sig.observeMessages(C, [msg('a', PEER), msg('b', ME), msg('c', PEER)], ME)
    expect(h.sent).toEqual([C])
  })

  it('входящие пачкой внутри окна: передний + один хвост', () => {
    const h = harness()
    h.sig.observeMessages(C, [msg('a', PEER)], ME)
    h.sig.observeMessages(C, [msg('a', PEER), msg('b', PEER)], ME)
    h.advance(200)
    h.sig.observeMessages(C, [msg('a', PEER), msg('b', PEER), msg('c', PEER)], ME)
    h.advance(200)
    h.sig.observeMessages(C, [msg('a', PEER), msg('b', PEER), msg('c', PEER), msg('d', PEER)], ME)
    expect(h.sent).toEqual([C])
    h.advance(SECRET_READ_THROTTLE_MS)
    expect(h.sent).toEqual([C, C])
  })

  it('входящее, пока окно не в фокусе, не шлёт; возврат в окно — это request', () => {
    const h = harness({ eligible: () => false })
    h.sig.observeMessages(C, [msg('a', PEER)], ME)
    h.sig.observeMessages(C, [msg('a', PEER), msg('b', PEER)], ME)
    h.advance(5_000)
    expect(h.sent).toEqual([])
    h.setEligible(() => true)
    h.sig.request(C)
    expect(h.sent).toEqual([C])
  })

  it('не массив (данные ещё не загружены) — игнор, первое наблюдение останется впереди', () => {
    const h = harness()
    h.sig.observeMessages(C, undefined, ME)
    h.sig.observeMessages(C, [msg('a', PEER)], ME)
    expect(h.sent).toEqual([])
  })

  it('forgetSeen: после повторного входа накопившееся входящее не даёт второй вызов', () => {
    const h = harness()
    h.sig.observeMessages(C, [msg('a', PEER)], ME)
    h.sig.forgetSeen(C)
    h.sig.observeMessages(C, [msg('a', PEER), msg('b', PEER)], ME)
    expect(h.sent).toEqual([])
  })
})
