/**
 * E2EE звонков, этап 0 (веб): звонок 1:1 шифруется всегда, при сбое ключа не начинается,
 * подписи честные («Шифрование через сервер» / «Без шифрования», слова «сквозное» нет).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildConnectView, EMPTY_CONNECT_PROGRESS, type ConnectSignals, type ConnectView } from './callConnectView'
import {
  CALL_MODE_CHANGED_TEXT,
  CALL_SECURITY_DETAIL,
  CALL_SECURITY_LABEL,
  E2EE_SETUP_FAILED_TITLE,
  PEER_UNENCRYPTED_TEXT,
  callModeChanged,
  callRequiresE2ee,
  callSecurityOf,
  describeE2eeSetupError,
  isUnencryptedMediaPublication,
  nextPinnedCallMode,
} from './callSecurity'

const base: ConnectSignals = {
  isGroup: false,
  encrypted: true,
  muted: false,
  hasToken: false,
  keysReady: false,
  connected: false,
  e2eeEnabled: false,
  micPublished: false,
  routeSwitching: false,
  route: EMPTY_CONNECT_PROGRESS.route,
  peer: { presence: 'absent', count: 0, name: 'Катя', id: 'p', avatarUrl: null },
  error: null,
}
const s = (patch: Partial<ConnectSignals>): ConnectSignals => ({ ...base, ...patch })

/** Все тексты экрана подключения одной строкой — для проверок «что человек может прочитать». */
function allText(v: ConnectView): string {
  return [
    v.title,
    v.subtitle,
    ...v.steps.flatMap((st) => [st.title, st.hint]),
    ...v.nodes.flatMap((n) => [n.label, n.sub ?? '', n.detail]),
    ...v.facts.map((f) => f.text),
    v.error?.title ?? '',
    v.error?.text ?? '',
  ].join('\n')
}

const STAGES: Array<Partial<ConnectSignals>> = [
  {},
  { hasToken: true },
  { hasToken: true, keysReady: true },
  { hasToken: true, keysReady: true, connected: true },
  { hasToken: true, keysReady: true, connected: true, e2eeEnabled: true },
  { hasToken: true, keysReady: true, connected: true, e2eeEnabled: true, micPublished: true },
  {
    hasToken: true,
    keysReady: true,
    connected: true,
    e2eeEnabled: true,
    micPublished: true,
    peer: { ...base.peer, presence: 'joining', count: 1 },
  },
  {
    hasToken: true,
    keysReady: true,
    connected: true,
    e2eeEnabled: true,
    micPublished: true,
    peer: { ...base.peer, presence: 'ready', count: 1 },
  },
]

describe('звонок 1:1 шифруется всегда', () => {
  it('callRequiresE2ee: 1:1 — да, группа — нет (до 2.0)', () => {
    expect(callRequiresE2ee(false)).toBe(true)
    expect(callRequiresE2ee(true)).toBe(false)
  })

  it('callSecurityOf: 1:1 подписывается только после подтверждения шифрования', () => {
    expect(callSecurityOf(false, true)).toBe('server-key')
    expect(callSecurityOf(false, false)).toBeNull()
    expect(callSecurityOf(true, false)).toBe('none')
    expect(callSecurityOf(true, true)).toBe('none')
  })
})

describe('честные подписи', () => {
  it('тексты подписей — одинаковые на всех платформах', () => {
    expect(CALL_SECURITY_LABEL['server-key']).toBe('Шифрование через сервер')
    expect(CALL_SECURITY_LABEL.none).toBe('Без шифрования')
    expect(E2EE_SETUP_FAILED_TITLE).toBe('Не удалось включить шифрование')
    expect(CALL_SECURITY_DETAIL['server-key']).toMatch(/сервер/)
  })

  it('1:1 с включённым шифрованием: капсула «Шифрование через сервер», не «сквозное»', () => {
    const v = buildConnectView(s(STAGES[5]!))
    expect(v.facts).toContainEqual({ id: 'e2ee', text: 'Шифрование через сервер' })
    expect(v.facts.some((f) => f.id === 'plain')).toBe(false)
  })

  it('1:1 до подтверждения шифрования: капсулы шифрования нет', () => {
    const v = buildConnectView(s(STAGES[3]!))
    expect(v.facts.some((f) => f.id === 'e2ee' || f.id === 'plain')).toBe(false)
  })

  it('группа: капсула «Без шифрования» с самого начала', () => {
    for (const st of STAGES) {
      const v = buildConnectView(s({ ...st, isGroup: true, encrypted: false, e2eeEnabled: false }))
      expect(v.facts).toContainEqual({ id: 'plain', text: 'Без шифрования' })
      expect(v.facts.some((f) => f.id === 'e2ee')).toBe(false)
    }
  })

  it('ни на одном этапе экран не обещает «сквозное шифрование»', () => {
    for (const isGroup of [false, true]) {
      for (const st of STAGES) {
        const text = allText(buildConnectView(s({ ...st, isGroup, encrypted: !isGroup })))
        expect(text).not.toMatch(/сквозное шифрование/i)
        expect(text).not.toMatch(/E2EE/)
      }
    }
  })
})

describe('сбой ключа: звонок не начат, «Повторить»', () => {
  it('ошибка с retry → view.error.retry; без него — нет', () => {
    const withRetry = buildConnectView(s({ error: 'x', errorTitle: E2EE_SETUP_FAILED_TITLE, errorRetry: true }))
    expect(withRetry.mode).toBe('error')
    expect(withRetry.error).toEqual({ title: 'Не удалось включить шифрование', text: 'x', retry: true })
    expect(buildConnectView(s({ error: 'y' })).error?.retry).toBe(false)
  })

  it.each([
    [{ response: { status: 404 } }, true, /ошибка 404/],
    [{ response: { status: 500 } }, true, /ошибка 500/],
    [{ response: { status: 403 } }, false, /не дал ключ/],
    [{ isAxiosError: true, request: {} }, true, /Нет связи с сервером/],
    [new Error('Invalid E2EE key length: expected 32 bytes, got 16'), true, /не получен или повреждён/],
    [new Error('E2EE enable timeout'), true, /не подтвердилось вовремя/],
    [new Error('DeviceUnsupportedError: E2EE not supported'), false, /браузер не умеет/],
  ])('%o → retry=%s', (err, retry, re) => {
    const r = describeE2eeSetupError(err)
    expect(r.retry).toBe(retry)
    expect(r.text).toMatch(/^Звонок не начат: без шифрования разговор один на один не идёт\./)
    expect(r.text).toMatch(re)
    expect(r.text).not.toMatch(/E2EE/)
  })
})

describe('статическая проверка: путей без шифрования для 1:1 нет (ТЗ §10.2)', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const overlay = read('./CallOverlay.tsx')

  it('нет флага сборки VITE_E2EE_1TO1 — шифрование 1:1 решает только callRequiresE2ee', () => {
    expect(overlay).not.toMatch(/env\??\.VITE_E2EE/)
    expect(overlay).not.toMatch(/readEnvBool/)
    expect(overlay).toMatch(/const shouldUseE2ee = pinnedMode \? pinnedMode\.e2ee : callRequiresE2ee\(isGroup\)/)
  })

  it('нигде не выключаем шифрование вызовом SDK', () => {
    for (const rel of ['./CallOverlay.tsx', './CallMini.tsx', '../../utils/e2ee.ts']) {
      expect(read(rel)).not.toMatch(/setE2EEEnabled\(\s*false\s*\)/)
    }
  })

  it('в интерфейсе звонка нет строки «Сквозное шифрование»', () => {
    for (const rel of ['./CallOverlay.tsx', './CallMini.tsx', './CallConnecting.tsx', './callConnectView.ts', './callSecurity.ts']) {
      const src = read(rel)
      expect(src).not.toMatch(/['"`]Сквозное шифрование/)
      expect(src).not.toMatch(/aria-label="Сквозное/)
    }
  })
})

describe('затвор приёма: дорожку собеседника без шифрования не играем (ревью этапа 0)', () => {
  it('isUnencryptedMediaPublication: только звук/видео с меткой «не зашифровано»', () => {
    expect(isUnencryptedMediaPublication({ kind: 'audio', isEncrypted: false })).toBe(true)
    expect(isUnencryptedMediaPublication({ kind: 'video', isEncrypted: false })).toBe(true)
    expect(isUnencryptedMediaPublication({ kind: 'audio', isEncrypted: true })).toBe(false)
    expect(isUnencryptedMediaPublication({ kind: 'video', isEncrypted: true })).toBe(false)
    // Неизвестная метка (нет поля) — не повод рвать звонок: решает только явное false.
    expect(isUnencryptedMediaPublication({ kind: 'audio' })).toBe(false)
    expect(isUnencryptedMediaPublication({ kind: 'unknown', isEncrypted: false })).toBe(false)
    expect(isUnencryptedMediaPublication(null)).toBe(false)
    expect(isUnencryptedMediaPublication(undefined)).toBe(false)
  })

  it('текст ошибки — без «E2EE» и «сквозного»', () => {
    expect(PEER_UNENCRYPTED_TEXT).toMatch(/без шифрования/)
    expect(PEER_UNENCRYPTED_TEXT).not.toMatch(/E2EE|сквозн/i)
  })

  it('CallOverlay вешает затвор на комнату до connect: публикация, подписка, вход участника, подключение', () => {
    const overlay = readFileSync(new URL('./CallOverlay.tsx', import.meta.url), 'utf8')
    const gate = overlay.slice(overlay.indexOf('// Затвор приёма'), overlay.indexOf('// Затвор приёма') + 4000)
    expect(gate).toMatch(/isUnencryptedMediaPublication\(pub\)/)
    expect(gate).toMatch(/setSubscribed\?\.\(false\)/)
    expect(gate).toMatch(/\.detach\?\.\(\)/)
    expect(gate).toMatch(/mst\.enabled = false/)
    for (const ev of ['TrackPublished', 'TrackSubscribed', 'ParticipantConnected', 'Connected']) {
      expect(gate).toContain(`room.on(RoomEvent.${ev},`)
    }
    expect(gate).toMatch(/setE2eeError\(PEER_UNENCRYPTED_TEXT\)/)
    expect(gate).toMatch(/cleanupE2eeResources\(\)/)
  })
})

describe('режим шифрования закреплён за звонком (ревью этапа 0)', () => {
  it('закрепляется, только когда тип беседы известен', () => {
    expect(nextPinnedCallMode(null, true, 'c1', false, false)).toBeNull()
    expect(nextPinnedCallMode(null, true, 'c1', false, true)).toEqual({ conversationId: 'c1', e2ee: true })
    expect(nextPinnedCallMode(null, true, 'c1', true, true)).toEqual({ conversationId: 'c1', e2ee: false })
    expect(nextPinnedCallMode(null, false, 'c1', false, true)).toBeNull()
    expect(nextPinnedCallMode(null, true, null, false, true)).toBeNull()
  })

  it('посреди звонка не пересчитывается; новый звонок/беседа — заново', () => {
    const pinned = { conversationId: 'c1', e2ee: true }
    expect(nextPinnedCallMode(pinned, true, 'c1', true, true)).toBe(pinned)
    expect(nextPinnedCallMode(pinned, true, 'c1', false, false)).toBe(pinned)
    expect(nextPinnedCallMode(pinned, true, 'c2', true, true)).toEqual({ conversationId: 'c2', e2ee: false })
    expect(nextPinnedCallMode(pinned, false, 'c1', false, true)).toBeNull()
  })

  it('1:1 → «группа» посреди звонка — фатально; беседа пропала из списка — нет', () => {
    const one = { conversationId: 'c1', e2ee: true }
    expect(callModeChanged(one, true, true)).toBe(true)
    expect(callModeChanged(one, false, true)).toBe(false)
    expect(callModeChanged(one, false, false)).toBe(false)
    expect(callModeChanged(one, true, false)).toBe(false)
    const group = { conversationId: 'g1', e2ee: false }
    expect(callModeChanged(group, false, true)).toBe(true)
    expect(callModeChanged(group, true, true)).toBe(false)
    expect(callModeChanged(null, true, true)).toBe(false)
    expect(CALL_MODE_CHANGED_TEXT).not.toMatch(/E2EE|сквозн/i)
  })

  it('CallOverlay: при смене режима — экран ошибки, а не ветка без шифрования', () => {
    const overlay = readFileSync(new URL('./CallOverlay.tsx', import.meta.url), 'utf8')
    expect(overlay).toMatch(/\{callModeError \? \(\s*<CallConnecting/)
    expect(overlay).toMatch(/setCallModeError\(CALL_MODE_CHANGED_TEXT\)/)
  })
})
