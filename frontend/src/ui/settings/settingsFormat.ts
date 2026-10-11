/**
 * Чистые функции настроек: склонения, подписи сеансов, группировка устройств, «сервер» по адресу сайта.
 * Без React и без обращений к браузеру — тесты в settingsFormat.test.ts.
 */

export const pluralRu = (n: number, one: string, few: string, many: string): string => {
  const m10 = Math.abs(n) % 10
  const m100 = Math.abs(n) % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

export const deviceWord = (n: number): string => pluralRu(n, 'устройство', 'устройства', 'устройств')
export const deviceCount = (n: number): string => `${n} ${deviceWord(n)}`

/** «Напрямую» / «Через СПб» по адресу, с которого открыт сайт. */
export type ServerRoute = { kind: 'direct' | 'spb' | 'other'; label: string; host: string }

export function serverRoute(hostname: string): ServerRoute {
  const host = String(hostname || '').trim().toLowerCase()
  if (host === 'eblusha.org' || host === 'www.eblusha.org') return { kind: 'direct', label: 'Напрямую', host }
  if (host === 'ru.eblusha.org') return { kind: 'spb', label: 'Через СПб', host }
  return { kind: 'other', label: host || 'Этот адрес', host }
}

/** Пояснение в строке «Сервер» на вебе: у сайта адрес задаёт домен, переключателя нет. */
export function serverHint(route: ServerRoute): string {
  if (route.kind === 'direct') return 'Сайт открыт напрямую. Если eblusha.org не открывается, заходите через ru.eblusha.org — это «Через СПб».'
  if (route.kind === 'spb') return 'Сайт открыт через СПб. Если ru.eblusha.org не открывается, заходите через eblusha.org — это «Напрямую».'
  return `Сайт открыт по адресу ${route.host || 'без имени'}. Основные адреса — eblusha.org («Напрямую») и ru.eblusha.org («Через СПб»).`
}

// ───────────────────────────── сеансы ─────────────────────────────

export type DeviceRecord = {
  id: string
  name?: string | null
  platform?: string | null
  createdAt?: string | Date | null
  lastSeenAt?: string | Date | null
  revokedAt?: string | Date | null
  lastIp?: string | null
  lastCountry?: string | null
  lastCity?: string | null
  availablePrekeys?: number | null
}

export type SessionKind = 'phone' | 'tablet' | 'desktop' | 'browser'
export type SessionRow = {
  device: DeviceRecord
  /** сколько записей с такими же данными склеено (1 — одна) */
  count: number
  isCurrent: boolean
  kind: SessionKind
  name: string
  /** «Android · Бухарест, Румыния · 95.76.10.12» */
  meta: string
  keysReady: boolean
}

const PLATFORM_NAMES: Record<string, string> = {
  ios: 'iOS',
  iphone: 'iOS',
  ipados: 'iPadOS',
  android: 'Android',
  windows: 'Windows',
  win32: 'Windows',
  macos: 'macOS',
  mac: 'macOS',
  darwin: 'macOS',
  linux: 'Linux',
  web: 'Браузер',
  browser: 'Браузер',
}

export function platformLabel(raw: unknown): string {
  const p = String(raw ?? '').trim()
  if (!p) return ''
  const hit = PLATFORM_NAMES[p.toLowerCase()]
  if (hit) return hit
  return p.charAt(0).toUpperCase() + p.slice(1)
}

export function sessionKind(platformRaw: unknown): SessionKind {
  const p = String(platformRaw ?? '').toLowerCase()
  if (p.includes('ipad') || p.includes('tablet')) return 'tablet'
  if (p.includes('ios') || p.includes('iphone') || p.includes('android')) return 'phone'
  if (p === 'web' || p === 'browser' || p.includes('browser')) return 'browser'
  return 'desktop'
}

const tsOf = (v: unknown): number => {
  if (!v) return 0
  const t = new Date(v as string).getTime()
  return Number.isFinite(t) ? t : 0
}
const pickTs = (d: DeviceRecord): number => Math.max(tsOf(d.lastSeenAt), tsOf(d.createdAt))
const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase()

/**
 * Список сеансов для показа: отозванные скрыты; записи с одинаковыми «имя|платформа|IP|город|страна»
 * склеены (остаётся самая свежая, число — в count); свой — первым, дальше по свежести.
 * Склейка и порядок — прежние, из окна «Профиль».
 */
export function groupSessions(devices: readonly DeviceRecord[] | null | undefined, currentId: string | null | undefined): SessionRow[] {
  const cur = String(currentId ?? '').trim()
  const live = (devices ?? []).filter((d) => d && !d.revokedAt)
  const grouped = new Map<string, { device: DeviceRecord; count: number }>()
  for (const d of live) {
    const id = String(d.id ?? '').trim()
    const base = `${norm(d.name)}|${norm(d.platform)}|${norm(d.lastIp)}|${norm(d.lastCity)}|${norm(d.lastCountry)}`
    const key = base === '||||' ? `id:${id}` : base
    const prev = grouped.get(key)
    if (!prev) {
      grouped.set(key, { device: d, count: 1 })
      continue
    }
    const keep = pickTs(d) >= pickTs(prev.device) ? d : prev.device
    grouped.set(key, { device: keep, count: prev.count + 1 })
  }
  // «Это устройство» — если среди склеенных есть своё, показываем его
  const rows = Array.from(grouped.values()).map(({ device, count }) => {
    const own = cur ? live.find((d) => String(d.id).trim() === cur && keyOf(d) === keyOf(device)) : undefined
    const shown = own ?? device
    const isCurrent = !!cur && String(shown.id ?? '').trim() === cur
    const loc = [String(shown.lastCity ?? '').trim(), String(shown.lastCountry ?? '').trim()].filter(Boolean).join(', ')
    const ip = String(shown.lastIp ?? '').trim()
    const meta = [platformLabel(shown.platform), loc, ip].filter(Boolean).join(' · ')
    const prekeys = typeof shown.availablePrekeys === 'number' ? shown.availablePrekeys : null
    return {
      device: shown,
      count,
      isCurrent,
      kind: sessionKind(shown.platform),
      name: String(shown.name ?? '').trim() || String(shown.id ?? ''),
      meta,
      keysReady: prekeys != null && prekeys > 0,
    } satisfies SessionRow
  })
  rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    return pickTs(b.device) - pickTs(a.device)
  })
  return rows
}

function keyOf(d: DeviceRecord): string {
  const base = `${norm(d.name)}|${norm(d.platform)}|${norm(d.lastIp)}|${norm(d.lastCity)}|${norm(d.lastCountry)}`
  return base === '||||' ? `id:${String(d.id ?? '').trim()}` : base
}

/** Есть ли своё устройство среди живых записей (а не только «в списке что-то есть»). */
export function hasOwnDevice(devices: readonly DeviceRecord[] | null | undefined, currentId: string | null | undefined): boolean {
  const cur = String(currentId ?? '').trim()
  if (!cur) return false
  return (devices ?? []).some((d) => d && !d.revokedAt && String(d.id ?? '').trim() === cur)
}

/** Другие (не своё) живые устройства. */
export function otherDevices(devices: readonly DeviceRecord[] | null | undefined, currentId: string | null | undefined): DeviceRecord[] {
  const cur = String(currentId ?? '').trim()
  return (devices ?? []).filter((d) => d && !d.revokedAt && String(d.id ?? '').trim() && String(d.id).trim() !== cur)
}

/**
 * «Отключить все другие» доступна, только если среди устройств есть своё: иначе revoke-others отзовёт
 * ВСЕ устройства, включая этот браузер (его запись ещё не появилась, пока не завершена регистрация).
 */
export function canRevokeOthers(devices: readonly DeviceRecord[] | null | undefined, currentId: string | null | undefined): boolean {
  return hasOwnDevice(devices, currentId) && otherDevices(devices, currentId).length > 0
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** «был в сети сегодня, 11:52» / «вчера, 23:05» / «02.10.2026, 18:52». */
export function lastSeenLabel(value: string | Date | null | undefined, now: Date = new Date()): string {
  if (!value) return ''
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return ''
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (days === 0) return `был в сети сегодня, ${hm}`
  if (days === 1) return `был в сети вчера, ${hm}`
  return `был в сети ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}, ${hm}`
}

// ───────────────────────────── прочее ─────────────────────────────

/** Подпись пары «разрешение показа экрана» для строки плитки: «1080p · 30 кадр/с · со звуком». */
export function shareSummary(resolutionLabel: string, fps: number, audio: boolean): string {
  return `${resolutionLabel} · ${fps} кадр/с${audio ? ' · со звуком' : ''}`
}

/** «вкл: эхо · шум · усиление» / «всё выключено». */
export function voiceSummary(aec: boolean, ns: boolean, agc: boolean): string {
  const on = [aec ? 'эхо' : '', ns ? 'шум' : '', agc ? 'усиление' : ''].filter(Boolean)
  return on.length ? `вкл: ${on.join(' · ')}` : 'всё выключено'
}

/** Имя устройства звонка без служебных частей: «Default - Name (0bda:0567)» → «Name». */
export function cleanDeviceLabel(raw: string): string {
  let s = String(raw ?? '')
  s = s.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*|Default\s*-\s*)/i, '').trim()
  s = s.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g, ' ').trim()
  s = s.replace(/\s*\([0-9a-fA-F]{4}:\s*$/, '').trim()
  return s
}
