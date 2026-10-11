/**
 * «Без звука» — состояние веба вне React-дерева (как localTimeStore): кто из моих бесед заглушён и до когда.
 * Контракт сервера — docs/conversation-mute.md; правила — ./muteRules.ts.
 *
 * Источники и их asOf (момент по часам СЕРВЕРА, к которому значение верно):
 *   - GET /api/conversations — serverNow ответа (старый сервер без serverNow — местное время отправки запроса);
 *   - сокет conversation:mute:snapshot — serverNow; ЗАМЕНА целиком: беседа не из items — не заглушена;
 *   - сокет conversation:mute — at;
 *   - ответ своего POST /conversations/:id/mute — serverNow.
 * Значение применяется, только если его asOf не старше сохранённого (тот же приём, что у местного времени):
 * ответ списка, начатого ДО события, событие не затрёт.
 *
 * Почему отдельное хранилище, а не строки кэша ['conversations']: список перечитывается на каждое новое
 * сообщение, и его ответ (посчитанный раньше пришедшего события) иначе откатывал бы свежее «Без звука».
 * Строки списка лишь кормят хранилище — со своим asOf.
 *
 * Истечение: один таймер на ближайший конкретный срок (+50 мс) перерисовывает плитку и шапку; при возврате
 * во вкладку, фокусе и выходе в сеть — пересчёт. Отображение — всегда isMuted(until, now) с поправкой на
 * расхождение часов с сервером (оценка по serverNow ответов списка/POST: середина запроса, лучший — с
 * наименьшим временем ответа за 10 минут).
 */
import { useSyncExternalStore } from 'react'
import { isForever, isMuted, MUTE_FOREVER_MS, nextExpiry, parseMuteInstant } from './muteRules'

export const MUTE_EVENT = 'conversation:mute'
export const MUTE_SNAPSHOT_EVENT = 'conversation:mute:snapshot'

/** Таймер истечения — ближайший срок + столько (чтобы сравнение «until > now» уже дало false). */
export const EXPIRY_SLACK_MS = 50
/** Дальше этого таймер не ставим за раз (setTimeout ограничен ~24,8 сут; и часы могут уйти). */
export const MAX_TIMER_MS = 6 * 3_600_000
/** Сколько живёт выборка для оценки расхождения часов. */
export const SKEW_SAMPLE_TTL_MS = 10 * 60_000

type Entry = {
  /** Срок по часам сервера (мс); null — звук включён. */
  untilMs: number | null
  /** Момент по часам сервера, к которому значение верно. */
  asOf: number
}

type SkewSample = { offset: number; rtt: number; at: number }

export type MuteStoreDeps = {
  /** Местное время (мс). */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type MuteStore = ReturnType<typeof createMuteStore>

/** Срок из полей контракта {mutedUntil, mutedForever}; null — звук включён (или мусор). */
export function untilFromWire(mutedUntil: unknown, mutedForever: unknown): number | null {
  if (mutedForever === true) return MUTE_FOREVER_MS
  const t = parseMuteInstant(mutedUntil)
  if (t === null) return null
  return isForever(t) ? MUTE_FOREVER_MS : t
}

function idOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k)
}

export function createMuteStore(deps: MuteStoreDeps = {}) {
  const localNow = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  const entries = new Map<string, Entry>()
  /** Снапшот — полное утверждение на свой serverNow: всё, чего в нём нет, не заглушено. Старее — не берём. */
  let floorAsOf = Number.NEGATIVE_INFINITY
  let version = 0
  let skewMs = 0
  let skewSamples: SkewSample[] = []
  let timer: unknown = null
  /** Набор заглушённых сейчас — чтобы на тиках/фокусе перерисовывать только при настоящей смене. */
  let mutedSignature = ''
  const listeners = new Set<() => void>()

  function serverNow(): number {
    return localNow() + skewMs
  }

  function computeSignature(nowMs: number): string {
    const ids: string[] = []
    entries.forEach((e, id) => {
      if (isMuted(e.untilMs, nowMs)) ids.push(id)
    })
    return ids.sort().join('|')
  }

  function emit(): void {
    version += 1
    listeners.forEach((fn) => {
      try {
        fn()
      } catch {
        /* подписчик отвалился — остальных не роняем */
      }
    })
  }

  function rearm(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    const nowMs = serverNow()
    const untils: Array<number | null> = []
    entries.forEach((e) => untils.push(e.untilMs))
    const next = nextExpiry(untils, nowMs)
    if (next === null) return
    const delay = Math.min(Math.max(0, next - nowMs + EXPIRY_SLACK_MS), MAX_TIMER_MS)
    timer = setTimer(() => {
      timer = null
      recheck()
    }, delay)
  }

  /** Изменилось хранимое — перерисовать и перевзвести таймер. */
  function changed(): void {
    mutedSignature = computeSignature(serverNow())
    emit()
    rearm()
  }

  /** Время шло (таймер, фокус, возврат во вкладку): перерисовать, только если чей-то срок истёк. */
  function recheck(): void {
    const sig = computeSignature(serverNow())
    if (sig !== mutedSignature) {
      mutedSignature = sig
      emit()
    }
    rearm()
  }

  /** Одно значение; true — видимое изменение. */
  function put(conversationId: string, untilMs: number | null, asOf: number): boolean {
    if (!conversationId || !Number.isFinite(asOf)) return false
    const prev = entries.get(conversationId)
    const prevAsOf = prev ? prev.asOf : floorAsOf
    if (asOf < prevAsOf) return false
    if (prev && prev.untilMs === untilMs) {
      prev.asOf = asOf
      return false
    }
    entries.set(conversationId, { untilMs, asOf })
    // Новая запись «звук включён» ничего не меняет на экране, но держит asOf от старых ответов.
    return !(prev === undefined && untilMs === null)
  }

  function noteServerClock(serverNowMs: number | null, sentLocalMs: number, recvLocalMs: number): void {
    if (serverNowMs === null || !Number.isFinite(sentLocalMs) || !Number.isFinite(recvLocalMs)) return
    const rtt = Math.max(0, recvLocalMs - sentLocalMs)
    const sample: SkewSample = { offset: serverNowMs - (sentLocalMs + recvLocalMs) / 2, rtt, at: recvLocalMs }
    skewSamples = [...skewSamples.filter((s) => recvLocalMs - s.at <= SKEW_SAMPLE_TTL_MS), sample].slice(-20)
    let best = skewSamples[0]
    for (const s of skewSamples) if (s.rtt < best.rtt) best = s
    skewMs = Math.round(best.offset)
  }

  return {
    serverNow,

    /** Срок, если беседа заглушена СЕЙЧАС; иначе null. */
    mutedUntil(conversationId: string | null | undefined, nowMs: number = serverNow()): number | null {
      if (!conversationId) return null
      const e = entries.get(conversationId)
      return e && isMuted(e.untilMs, nowMs) ? e.untilMs : null
    },

    isMuted(conversationId: string | null | undefined, nowMs: number = serverNow()): boolean {
      if (!conversationId) return false
      const e = entries.get(conversationId)
      return !!e && isMuted(e.untilMs, nowMs)
    },

    /** Ответ GET /api/conversations целиком ({conversations, serverNow?}); sentLocalMs — когда ушёл запрос. */
    applyListResponse(data: unknown, sentLocalMs: number, recvLocalMs: number = localNow()): void {
      if (!data || typeof data !== 'object') return
      const d = data as { conversations?: unknown; serverNow?: unknown }
      if (!Array.isArray(d.conversations)) return
      const srv = parseMuteInstant(d.serverNow)
      noteServerClock(srv, sentLocalMs, recvLocalMs)
      // Старый сервер (нет serverNow): asOf — местное время отправки запроса.
      const asOf = srv ?? sentLocalMs
      let any = false
      for (const row of d.conversations) {
        if (!row || typeof row !== 'object') continue
        const r = row as { conversation?: { id?: unknown } | null; mutedUntil?: unknown; mutedForever?: unknown }
        if (!hasOwn(r, 'mutedUntil') && !hasOwn(r, 'mutedForever')) continue
        const id = idOf(r.conversation?.id)
        if (put(id, untilFromWire(r.mutedUntil, r.mutedForever), asOf)) any = true
      }
      if (any) changed()
    },

    /** conversation:mute:snapshot {items, serverNow} — замена целиком. */
    applySnapshot(payload: unknown): void {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { items?: unknown; serverNow?: unknown }
      if (!Array.isArray(p.items)) return
      const asOf = parseMuteInstant(p.serverNow) ?? serverNow()
      const seen = new Set<string>()
      let any = false
      for (const it of p.items) {
        if (!it || typeof it !== 'object') continue
        const i = it as { conversationId?: unknown; mutedUntil?: unknown; mutedForever?: unknown }
        const id = idOf(i.conversationId)
        if (!id) continue
        seen.add(id)
        if (put(id, untilFromWire(i.mutedUntil, i.mutedForever), asOf)) any = true
      }
      entries.forEach((_e, id) => {
        if (!seen.has(id) && put(id, null, asOf)) any = true
      })
      if (asOf > floorAsOf) floorAsOf = asOf
      if (any) changed()
      else recheck()
    },

    /** conversation:mute {conversationId, mutedUntil, mutedForever, at, byDeviceId?}. */
    applyEvent(payload: unknown): void {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { conversationId?: unknown; mutedUntil?: unknown; mutedForever?: unknown; at?: unknown }
      const id = idOf(p.conversationId)
      if (!id) return
      const asOf = parseMuteInstant(p.at) ?? serverNow()
      if (put(id, untilFromWire(p.mutedUntil, p.mutedForever), asOf)) changed()
    },

    /** Ответ своего POST …/mute {conversationId, mutedUntil, mutedForever, serverNow}. */
    applyMuteResponse(data: unknown, sentLocalMs?: number, recvLocalMs: number = localNow()): void {
      if (!data || typeof data !== 'object') return
      const d = data as { conversationId?: unknown; mutedUntil?: unknown; mutedForever?: unknown; serverNow?: unknown }
      const id = idOf(d.conversationId)
      if (!id) return
      const srv = parseMuteInstant(d.serverNow)
      if (typeof sentLocalMs === 'number') noteServerClock(srv, sentLocalMs, recvLocalMs)
      if (put(id, untilFromWire(d.mutedUntil, d.mutedForever), srv ?? serverNow())) changed()
    },

    /** Время шло (фокус, возврат во вкладку, сеть): пересчитать истёкшие. */
    recheck,

    /** Выход / вход другим человеком: всё забыть. */
    reset(): void {
      const had = entries.size > 0
      entries.clear()
      floorAsOf = Number.NEGATIVE_INFINITY
      skewSamples = []
      skewMs = 0
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      mutedSignature = ''
      if (had) emit()
    },

    getVersion(): number {
      return version
    },

    getSkewMs(): number {
      return skewMs
    },

    subscribe(fn: () => void): () => void {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    /** Все записи (для отладки и тестов). */
    debugEntries(): Array<{ conversationId: string; untilMs: number | null; asOf: number }> {
      const out: Array<{ conversationId: string; untilMs: number | null; asOf: number }> = []
      entries.forEach((e, id) => out.push({ conversationId: id, untilMs: e.untilMs, asOf: e.asOf }))
      return out
    },
  }
}

/* ---------------------------- общий экземпляр веба ---------------------------- */

export const muteStore = createMuteStore()

export function useMuteVersion(): number {
  return useSyncExternalStore(muteStore.subscribe, muteStore.getVersion, muteStore.getVersion)
}

/** Срок, если беседа заглушена сейчас (перерисовка — на изменение и на истечение). */
export function useMutedUntil(conversationId: string | null | undefined): number | null {
  return useSyncExternalStore(
    muteStore.subscribe,
    () => muteStore.mutedUntil(conversationId),
    () => null,
  )
}

export type MuteSyncDeps = {
  /** Подписка на событие сокета; возвращает отписку. */
  on: (event: string, cb: (payload: unknown) => void) => () => void
  /** Подписка на смену вошедшего человека (выход/вход другим). */
  onUserChange: (cb: (userId: string | null) => void) => () => void
}

let installed = false

/**
 * Подключение к сокету браузера/Electron (utils/socket.ts зовёт один раз при загрузке модуля — снапшот
 * приходит на connect, ещё до монтирования ChatsPage). Нативный сокет Capacitor подписывает
 * useConversationMute.
 */
export function installMuteSync(deps: MuteSyncDeps): void {
  if (installed) return
  installed = true
  deps.on(MUTE_EVENT, (p) => muteStore.applyEvent(p))
  deps.on(MUTE_SNAPSHOT_EVENT, (p) => muteStore.applySnapshot(p))
  deps.onUserChange(() => muteStore.reset())
  if (typeof window === 'undefined') return
  const recheck = () => {
    try {
      muteStore.recheck()
    } catch {
      /* ignore */
    }
  }
  try {
    // Фоновая вкладка душит таймеры — при возврате значки должны быть верными сразу.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') recheck()
    })
    window.addEventListener('focus', recheck)
    window.addEventListener('online', recheck)
  } catch {
    /* ignore */
  }
}

/** Ответ GET /api/conversations → хранилище (зовут queryFn списка бесед). */
export function ingestConversationsResponse(data: unknown, sentLocalMs: number): void {
  try {
    muteStore.applyListResponse(data, sentLocalMs)
  } catch {
    /* список важнее значка — не роняем запрос */
  }
}
