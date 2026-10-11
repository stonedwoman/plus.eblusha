/**
 * Навигация «Центра управления» через адрес: ?settings=<раздел|overview> на странице чатов.
 *
 * Зачем адрес, а не useState: «Назад» браузера (и жест «назад» на телефоне) должен делать шаг
 * раздел → обзор → закрыть, как Esc у натива (SPEC §2.2). Открытие центра и переход из обзора в раздел
 * кладут запись в историю; смена раздела из колонки её ЗАМЕНЯЕТ — иначе «Назад» гулял бы по разделам.
 *
 * Глубина (сколько записей мы добавили с момента открытия) лежит в history.state: при закрытии кнопкой
 * возвращаемся на столько шагов назад, чтобы после закрытия «Назад» не открывал центр снова.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export type SettingsSectionId = 'profile' | 'conn' | 'av' | 'security' | 'app'
export type SettingsAvTab = 'dev' | 'proc' | 'video'

/** Порядок плиток и колонки — как у натива (лишние плитки платформы просто выпадают). */
export const SETTINGS_SECTIONS: readonly SettingsSectionId[] = ['profile', 'conn', 'av', 'security', 'app']

export type SettingsView = { kind: 'overview' } | { kind: 'section'; id: SettingsSectionId }

const PARAM = 'settings'
/** Как раздел называется в адресе. */
const TO_URL: Record<SettingsSectionId, string> = { profile: 'profile', conn: 'connection', av: 'av', security: 'security', app: 'app' }
const FROM_URL: Record<string, SettingsSectionId> = {
  profile: 'profile',
  connection: 'conn',
  conn: 'conn',
  av: 'av',
  audio: 'av',
  security: 'security',
  app: 'app',
}

export function parseSettingsParam(raw: string | null | undefined): SettingsView | null {
  if (raw == null) return null
  const v = String(raw).trim().toLowerCase()
  if (v === '' || v === 'overview' || v === '1') return { kind: 'overview' }
  const id = FROM_URL[v]
  return id ? { kind: 'section', id } : { kind: 'overview' }
}

export function settingsParamValue(view: SettingsView): string {
  return view.kind === 'overview' ? 'overview' : TO_URL[view.id]
}

export function viewFromSearch(search: string): SettingsView | null {
  try {
    const p = new URLSearchParams(search)
    return p.has(PARAM) ? parseSettingsParam(p.get(PARAM)) : null
  } catch {
    return null
  }
}

function searchWith(search: string, view: SettingsView | null): string {
  const p = new URLSearchParams(search)
  if (view) p.set(PARAM, settingsParamValue(view))
  else p.delete(PARAM)
  const s = p.toString()
  return s ? `?${s}` : ''
}

type NavState = { ebSettingsDepth?: number; ebSettingsDirect?: boolean } | null

function depthOf(state: unknown): number {
  const n = Number((state as NavState)?.ebSettingsDepth ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Центр был открыт прямо по адресу (/settings/…, закладка): записи «закрыто» под ним в истории нет. */
function directOf(state: unknown): boolean {
  return !!(state as NavState)?.ebSettingsDirect
}

export interface SettingsNav {
  /** null — центр закрыт. */
  view: SettingsView | null
  /** Открыть центр (из закрытого) на обзоре или сразу на разделе. */
  open: (view?: SettingsView) => void
  /** Из обзора в раздел — отдельная запись истории. */
  openSection: (id: SettingsSectionId) => void
  /** Из колонки разделов — запись заменяется. */
  switchSection: (id: SettingsSectionId) => void
  goOverview: () => void
  close: () => void
  /** Закрыть и, когда адрес уже без ?settings, выполнить fn (например, открыть беседу). */
  closeThen: (fn: () => void) => void
}

export function useSettingsNav(): SettingsNav {
  const location = useLocation()
  const navigate = useNavigate()
  const view = useMemo(() => viewFromSearch(location.search), [location.search])
  const depth = depthOf(location.state)
  const direct = directOf(location.state)

  const go = useCallback(
    (next: SettingsView | null, opts: { replace: boolean; depth: number; direct: boolean }) => {
      navigate(
        { pathname: location.pathname, search: searchWith(location.search, next), hash: location.hash },
        { replace: opts.replace, state: { ...(location.state as object | null), ebSettingsDepth: opts.depth, ebSettingsDirect: opts.direct } },
      )
    },
    [navigate, location.pathname, location.search, location.hash, location.state],
  )

  const open = useCallback(
    (v: SettingsView = { kind: 'overview' }) => {
      // уже открыт — просто перейти; из закрытого — новая запись (под ней «закрыто»)
      if (view) go(v, { replace: true, depth, direct })
      else go(v, { replace: false, depth: 1, direct: false })
    },
    [view, depth, direct, go],
  )
  const openSection = useCallback(
    (id: SettingsSectionId) => {
      const v: SettingsView = { kind: 'section', id }
      // центр открыт прямо по адресу — запись, с которой начали, становится «основанием»
      if (depth === 0 && view) go(v, { replace: false, depth: 1, direct: true })
      else go(v, { replace: false, depth: depth + 1, direct })
    },
    [depth, direct, view, go],
  )
  const switchSection = useCallback((id: SettingsSectionId) => go({ kind: 'section', id }, { replace: true, depth, direct }), [go, depth, direct])
  const goOverview = useCallback(() => {
    // под разделом, открытым из обзора, лежит обзор — на него и возвращаемся шагом назад
    const previousIsOverview = direct ? depth >= 1 : depth >= 2
    if (previousIsOverview) navigate(-1)
    else go({ kind: 'overview' }, { replace: true, depth, direct })
  }, [direct, depth, navigate, go])

  // «Закрыть»: вернуться к записи «закрыто». Открыто прямо по адресу — вернуться к первой записи центра и стереть ?settings на месте.
  const pendingStripRef = useRef(false)
  const close = useCallback(() => {
    if (depth === 0) {
      go(null, { replace: true, depth: 0, direct: false })
      return
    }
    if (direct) pendingStripRef.current = true
    navigate(-depth)
  }, [depth, direct, navigate, go])
  useEffect(() => {
    if (pendingStripRef.current && view !== null && depth === 0) {
      pendingStripRef.current = false
      go(null, { replace: true, depth: 0, direct: false })
    }
  }, [view, depth, go])

  // Выход из центра в другое место (открыть беседу): история откатывается асинхронно (history.go),
  // поэтому действие ждёт, пока адрес действительно очистится.
  const afterCloseRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (view === null && afterCloseRef.current) {
      const fn = afterCloseRef.current
      afterCloseRef.current = null
      fn()
    }
  }, [view])
  const closeThen = useCallback(
    (fn: () => void) => {
      afterCloseRef.current = fn
      close()
    },
    [close],
  )

  return { view, open, openSection, switchSection, goOverview, close, closeThen }
}

/**
 * Навигация центра, открытого из панели звонка: адрес не трогаем (звонок живёт на своём экране), состояние —
 * в useState. Закрытие возвращает в звонок (onClose переключает шестерёнку LiveKit).
 */
export function useLocalSettingsNav(initial: SettingsView, onClose: () => void): SettingsNav {
  const [view, setView] = useState<SettingsView | null>(initial)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const close = useCallback(() => {
    setView(null)
    closeRef.current()
  }, [])
  return useMemo<SettingsNav>(
    () => ({
      view,
      open: (v = { kind: 'overview' }) => setView(v),
      openSection: (id) => setView({ kind: 'section', id }),
      switchSection: (id) => setView({ kind: 'section', id }),
      goOverview: () => setView({ kind: 'overview' }),
      close,
      closeThen: (fn) => {
        close()
        window.setTimeout(fn, 0)
      },
    }),
    [view, close],
  )
}
