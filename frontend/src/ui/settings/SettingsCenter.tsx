/**
 * «Центр управления» веба — настройки плитками, как в нативном ПК-клиенте (SPEC settings-unify).
 *
 * Оболочка: слой с затемнением → панель → шапка (логотип, крошки, поиск, крестик) → тело в двух видах:
 *   обзор — плитки с живым состоянием; раздел — колонка разделов слева и страница со строками единого вида.
 * На телефоне (ширина ≤ 768 или панель меньше 880×560) — тот же центр экраном: сетка плиток, раздел отдельным экраном,
 * «назад» — шаг назад по тем же шагам, что Esc (вопрос → форма пароля → подсветка поиска → раздел → обзор → закрыть).
 *
 * Логика, хранение, API, сквозные события и E2EE не менялись — только вид и навигация (useSettingsModel.tsx).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useBlocker } from 'react-router-dom'
import { SettingsUiProvider, Btn, Confirm, Hl, Ic, Kbd, LeaveDialog, modKey, type IconName } from './settingsUi'
import { SettingsModelProvider, useSearchResult, useSettingsModelState, WEB_SECTIONS, type SettingsModel } from './useSettingsModel'
import { SECTION_ICONS, OverviewTiles, ResultGroup, type TilesCtx } from './settingsTiles'
import { OVERVIEW_GRID_AREAS, nearestTile, phoneSpans, useSettingsMode } from './settingsLayout'
import { SECTION_NAMES, type IndexRow } from './settingsIndex'
import { viewFromSearch, type SettingsAvTab, type SettingsNav, type SettingsSectionId, type SettingsView } from './settingsNav'
import { collapseToTile, expandFromTile, prefersReducedMotion } from './settingsMotion'
import { pluralRu } from './settingsFormat'
import { ProfileSection } from './sections/ProfileSection'
import { ConnectionSection } from './sections/ConnectionSection'
import { AvSection } from './sections/AvSection'
import { SecuritySection } from './sections/SecuritySection'
import { AppSection } from './sections/AppSection'
import './settings.css'

declare const __EB_BUILD__: string | undefined
const BUILD = typeof __EB_BUILD__ !== 'undefined' ? String(__EB_BUILD__ || '') : ''
const VERSION_LINE = BUILD ? `Еблуша в браузере · ${BUILD}` : ''

const SUBTITLES: Record<SettingsSectionId, string> = {
  profile: 'Ваше фото и имя видны собеседникам.',
  conn: 'Через какой адрес открыт сайт и как звонки добираются до сервера.',
  av: 'Обработка голоса, показ экрана и доступ к микрофону и камере.',
  security: 'Пароль от аккаунта и устройства, где он открыт.',
  app: 'Как открываются ролики YouTube.',
}

export interface SettingsHost {
  statusText: string
  presence?: string
  pickAvatar?: () => void
  avatarMsg?: string | null
  avatarBusy?: boolean
  /** открыть беседу (после закрытия центра) */
  openChat?: (conversationId: string) => void
  callActive?: boolean
  /** капсула звонка в шапке: «Звонок с Иваном» + начало разговора */
  call?: { label: string; since: number | null } | null
}

export interface SettingsCenterProps {
  nav: SettingsNav
  view: SettingsView
  host: SettingsHost
  /** внутри комнаты звонка LiveKit — на вкладке «Устройства» живые списки */
  inRoom?: boolean
  /** открыт из панели звонка: пометка «Вы пришли из звонка» */
  fromCall?: boolean
  /** монтировать в body (из звонка: центр должен быть поверх оверлея звонка, но внутри контекста комнаты) */
  portal?: boolean
  /** z-index слоя (из звонка выше оверлея звонка) */
  zIndex?: number
  /** «Назад» браузера спрашивает про несохранённый профиль (только когда состояние живёт в адресе) */
  urlGuard?: boolean
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function visible(el: HTMLElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
}

function hasForeignModal(root: HTMLElement | null): boolean {
  const list = document.querySelectorAll('[aria-modal="true"]')
  for (const el of Array.from(list)) {
    if (!root || !root.contains(el)) return true
  }
  return false
}

// ───────────────────────────── капсула звонка ─────────────────────────────

function CallCapsule({ call, compact }: { call: { label: string; since: number | null }; compact: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  let time = ''
  if (call.since) {
    const s = Math.max(0, Math.floor((now - call.since) / 1000))
    time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  return (
    <span className="ebs-callcap" title="Идёт звонок">
      <i aria-hidden="true" />
      {compact ? time || 'Звонок' : `${call.label}${time ? ` · ${time}` : ''}`}
    </span>
  )
}

// ───────────────────────────── поиск ─────────────────────────────

function SearchBox({
  query,
  setQuery,
  count,
  inputRef,
  onEnter,
  wide,
}: {
  query: string
  setQuery: (q: string) => void
  count: number | null
  inputRef: React.RefObject<HTMLInputElement | null>
  onEnter: () => void
  wide: boolean
}) {
  const mod = modKey()
  return (
    <label className="ebs-search">
      <Ic n="search" />
      <input
        ref={inputRef}
        value={query}
        maxLength={80}
        placeholder="Найти настройку"
        aria-label="Поиск по настройкам"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onEnter()
          }
        }}
      />
      {query ? (
        <>
          <span className={`ebs-search__count${count === 0 ? ' is-none' : ''}`} aria-live="polite">
            {count === null ? '' : count === 0 ? 'ничего' : wide ? `${count} ${pluralRu(count, 'настройка', 'настройки', 'настроек')}` : count}
          </span>
          <button type="button" className="ebs-search__clr" aria-label="Сбросить поиск" title="Сбросить · Esc" onClick={() => { setQuery(''); inputRef.current?.focus() }}>
            <Ic n="x" />
          </button>
        </>
      ) : wide ? (
        <>
          <Kbd>{mod}</Kbd>
          <Kbd>F</Kbd>
        </>
      ) : null}
    </label>
  )
}

// ───────────────────────────── оболочка ─────────────────────────────

export function SettingsCenter(props: SettingsCenterProps) {
  const { nav, view, host } = props
  const mode = useSettingsMode()
  const phone = mode === 'phone'
  const [query, setQuery] = useState('')
  const [avTab, setAvTab] = useState<SettingsAvTab>('dev')
  const [flashId, setFlashId] = useState<string | null>(null)
  const [leave, setLeave] = useState<null | { then: () => void }>(null)
  const [animating, setAnimating] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const leavingRef = useRef(false)
  const restoreFocusRef = useRef<HTMLElement | null>(typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null)
  const titleId = useId()

  const model: SettingsModel = useSettingsModelState({
    inRoom: !!props.inRoom,
    fromCall: !!props.fromCall,
    active: true,
    statusText: host.statusText,
    presence: host.presence,
    callActive: host.callActive,
    openBotChat: host.openChat ? (id) => nav.closeThen(() => host.openChat?.(id)) : undefined,
    pickAvatar: host.pickAvatar,
    avatarMsg: host.avatarMsg,
    avatarBusy: host.avatarBusy,
  })
  const search = useSearchResult(model, query)
  const firstHit = search.rows && search.rows.length ? search.rows[0] : null
  const sectionId: SettingsSectionId | null = view.kind === 'section' ? view.id : null

  // из звонка вкладка всегда «Устройства»
  useEffect(() => {
    if (props.fromCall) setAvTab('dev')
  }, [props.fromCall])

  const dirtyRef = useRef(false)
  dirtyRef.current = model.profile.dirty

  // ── закрытие и выход с вопросом о несохранённом профиле ──
  const requestLeave = useCallback(
    (then: () => void) => {
      if (dirtyRef.current) setLeave({ then })
      else then()
    },
    [],
  )
  const doClose = useCallback(() => {
    leavingRef.current = true
    nav.close()
  }, [nav])
  const requestClose = useCallback(() => requestLeave(doClose), [requestLeave, doClose])

  // «Назад» браузера: несохранённый профиль спрашиваем, а не теряем молча
  const blocker = useBlocker(({ nextLocation, historyAction }) => {
    if (!props.urlGuard) return false
    if (leavingRef.current || !dirtyRef.current) return false
    if (historyAction !== 'POP') return false
    return viewFromSearch(nextLocation.search) === null
  })
  const blockedNow = blocker.state === 'blocked'

  // ── переход плитка → раздел и обратно ──
  const openSection = useCallback(
    (id: SettingsSectionId, from: HTMLElement | null) => {
      if (animating) return
      const body = bodyRef.current
      const ov = body?.querySelector<HTMLElement>('.ebs-ov, .ebs-ovphone') ?? null
      if (!from || !body || prefersReducedMotion()) {
        nav.openSection(id)
        return
      }
      setAnimating(true)
      void expandFromTile(body, from, ov).then(() => {
        nav.openSection(id)
        setAnimating(false)
      })
    },
    [animating, nav],
  )

  const prevViewRef = useRef<SettingsView>(view)
  useLayoutEffect(() => {
    const prev = prevViewRef.current
    prevViewRef.current = view
    if (prev.kind === 'section' && view.kind === 'overview') {
      const body = bodyRef.current
      const tile = body?.querySelector<HTMLElement>(`[data-tile="${prev.id}"]`)
      const ov = body?.querySelector<HTMLElement>('.ebs-ov, .ebs-ovphone') ?? null
      if (body && tile && !prefersReducedMotion()) void collapseToTile(body, tile, ov)
      // фокус — на плитку, из которой раскрывали
      const hit = body?.querySelector<HTMLElement>(`[data-tile-hit="${prev.id}"]`)
      hit?.focus({ preventScroll: true })
    }
    if (view.kind === 'section' && prev.kind === 'overview') {
      // конец раскрытия — на активный пункт колонки
      window.setTimeout(() => rootRef.current?.querySelector<HTMLElement>('.ebs-ritem[aria-checked="true"]')?.focus({ preventScroll: true }), 0)
    }
    if (paneRef.current) paneRef.current.scrollTop = 0
  }, [view])

  // ── открыть строку выдачи / первую находку ──
  const openRow = useCallback(
    (row: IndexRow) => {
      if (!row.sec) {
        // «Выйти из Еблуши» — не раздел: фокус на кнопку выхода с кольцом
        setQuery('')
        nav.goOverview()
        window.setTimeout(() => rootRef.current?.querySelector<HTMLElement>('[data-ebs-exit]')?.focus(), 60)
        return
      }
      if (row.tab) setAvTab(row.tab)
      setFlashId(row.id)
      if (view.kind === 'section') nav.switchSection(row.sec)
      else nav.openSection(row.sec)
    },
    [nav, view.kind],
  )
  useEffect(() => {
    if (!flashId) return
    const t1 = window.setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-ebs-id~="${flashId}"]`)
      const pane = paneRef.current
      if (el && pane) pane.scrollTo({ top: Math.max(0, el.offsetTop - 80), behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }, 60)
    const t2 = window.setTimeout(() => setFlashId(null), 1500)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [flashId])

  // ── «назад» по шагам (Esc, кнопка «назад» на телефоне) ──
  const stepBack = useCallback((): void => {
    if (leave || blockedNow) {
      setLeave(null)
      if (blockedNow) blocker.reset?.()
      return
    }
    if (model.exitAsk) return model.setExitAsk(false)
    if (model.sessions.askId) return model.sessions.setAskId(null)
    if (model.sessions.askAll) return model.sessions.setAskAll(false)
    if (model.pwdOpen) {
      if (!model.pwdBusy) model.setPwdOpen(false)
      return
    }
    if (model.pwdBusy) return
    if (query) return setQuery('')
    const input = searchRef.current
    if (input && document.activeElement === input) {
      input.blur()
      const target = rootRef.current?.querySelector<HTMLElement>(sectionId ? '.ebs-ritem[aria-checked="true"]' : '[data-tile-hit="profile"]')
      target?.focus()
      return
    }
    if (view.kind === 'section') return nav.goOverview()
    requestClose()
  }, [leave, blockedNow, blocker, model, query, sectionId, view.kind, nav, requestClose])

  // ── клавиши ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (hasForeignModal(rootRef.current)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
        // пока центр открыт, Ctrl/⌘+F — наш поиск, а не поиск браузера
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (mod && !e.shiftKey && !e.altKey && (e.key === ',' || e.code === 'Comma')) {
        // Ctrl/⌘+, — как у натива: открывает и закрывает (закрытие спросит про несохранённый профиль)
        e.preventDefault()
        if (!model.pwdBusy) requestClose()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        stepBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepBack, requestClose, model.pwdBusy])

  // ── фокус: при открытии — внутрь, при закрытии — туда, где был ──
  useEffect(() => {
    const t = window.setTimeout(() => {
      const root = rootRef.current
      if (!root || root.contains(document.activeElement)) return
      const target = root.querySelector<HTMLElement>(sectionId ? '.ebs-ritem[aria-checked="true"]' : '[data-tile-hit="profile"]') ?? root.querySelector<HTMLElement>(FOCUSABLE)
      target?.focus({ preventScroll: true })
    }, 30)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const el = restoreFocusRef.current
    return () => {
      try {
        if (el && document.contains(el)) el.focus({ preventScroll: true })
      } catch {
        // элемента уже нет
      }
    }
  }, [])

  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const root = rootRef.current
    if (!root) return
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  }

  // ── стрелки между плитками ──
  const onOverviewKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement
    const hitId = t.getAttribute?.('data-tile-hit')
    if (!hitId) return
    const dir = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : null
    const hits = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-tile-hit]'))
    if (dir) {
      e.preventDefault()
      const rects = hits.map((h) => {
        const r = (h.closest('section') as HTMLElement).getBoundingClientRect()
        return { id: h.getAttribute('data-tile-hit') as string, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
      })
      const next = nearestTile(hitId, dir, rects)
      if (next) hits.find((h) => h.getAttribute('data-tile-hit') === next)?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      ;(e.key === 'Home' ? hits[0] : hits[hits.length - 1])?.focus()
    }
  }

  // ── сводный контекст плиток ──
  const tilesCtx: TilesCtx = {
    mode,
    model,
    query,
    rows: search.rows,
    firstHit,
    onOpen: openSection,
    onOpenRow: openRow,
    onOpenPassword: () => {
      model.setPwdMsg(null)
      model.setPwdOpen(true)
      nav.openSection('security')
    },
  }

  const uiState = useMemo(() => ({ mode, query, matchIds: search.ids, flashId }), [mode, query, search.ids, flashId])

  // ───── блоки ─────
  const exitQuestion = (
    <Confirm
      title="Выйти из аккаунта в этом браузере?"
      text={model.inCall ? 'Звонок завершится, откроется экран входа, ключи секретных чатов здесь сотрутся.' : 'Откроется экран входа, ключи секретных чатов здесь сотрутся.'}
      cancelLabel="Остаться"
      okLabel="Выйти"
      okIcon="logout"
      onCancel={() => model.setExitAsk(false)}
      onOk={() => requestLeave(() => void model.logout())}
    />
  )
  const exitButton = (
    <button type="button" className="ebs-foot__exit" data-ebs-exit onClick={() => model.setExitAsk(true)}>
      <Ic n="logout" /> Выйти из Еблуши
    </button>
  )

  const hintsWide = query ? (
    firstHit ? (
      <>
        <Kbd>Enter</Kbd>
        <span className="ebs-hint">открыть первую</span>
        <Kbd>Esc</Kbd>
        <span>сбросить поиск</span>
      </>
    ) : (
      <>
        <Kbd>Esc</Kbd>
        <span>сбросить поиск</span>
      </>
    )
  ) : (
    <>
      <Kbd>{modKey()}</Kbd>
      <Kbd>F</Kbd>
      <span className="ebs-hint">найти</span>
      <Kbd>Esc</Kbd>
      <span>закрыть</span>
    </>
  )

  const noResults =
    search.rows && search.rows.length === 0 ? (
      <div className="ebs-nores" role="status">
        <Ic n="search" className="ebs-amb" />
        <h3>Ничего не нашлось по «{query.trim()}»</h3>
        <p>Поиск идёт по названиям и пояснениям всех настроек. Попробуйте другое слово:</p>
        <div className="ebs-words">
          {['микрофон', 'пароль', 'сервер', 'время'].map((w) => (
            <Btn key={w} sm onClick={() => setQuery(w)}>
              {w}
            </Btn>
          ))}
        </div>
      </div>
    ) : null

  const crumbs =
    view.kind === 'overview' ? (
      <h1 className="ebs-crumbs" id={titleId}>Настройки</h1>
    ) : (
      <nav className="ebs-crumbs" aria-label="Путь">
        <button type="button" className="ebs-crumbs__link" title="К обзору · Esc" aria-label="К обзору настроек" onClick={() => nav.goOverview()}>
          Настройки
        </button>
        <Ic n="chev" />
        <span>{SECTION_NAMES[view.id]}</span>
      </nav>
    )

  const closeLabel = props.fromCall ? 'Вернуться к звонку' : 'Закрыть настройки'
  const header = phone ? (
    <header className="ebs-abar">
      <button type="button" className="ebs-abar__back" aria-label={view.kind === 'section' ? 'К обзору настроек' : props.fromCall ? 'Вернуться к звонку' : 'Назад к беседам'} onClick={stepBack}>
        <Ic n="back" />
      </button>
      {view.kind === 'overview' ? (
        <span className="ebs-abar__t">
          <span className="logo" aria-label="Еблуша">Е<span className="b">Б</span>луша</span>
          <span className="ebs-hdr__sep" />
          <h1>Настройки</h1>
        </span>
      ) : (
        <h1 className="ebs-abar__t">{SECTION_NAMES[view.id]}</h1>
      )}
      {host.call ? <CallCapsule call={host.call} compact /> : null}
    </header>
  ) : (
    <header className="ebs-hdr">
      <span className="logo" aria-label="Еблуша">Е<span className="b">Б</span>луша</span>
      <span className="ebs-hdr__sep" />
      {crumbs}
      <span className="ebs-hdr__fill" />
      {host.call ? <CallCapsule call={host.call} compact={mode === 'cmp'} /> : null}
      <SearchBox query={query} setQuery={setQuery} count={search.rows ? search.rows.length : null} inputRef={searchRef} onEnter={() => firstHit && openRow(firstHit)} wide />
      <button type="button" className="ebs-xbtn" aria-label={closeLabel} title={`${props.fromCall ? 'Вернуться к звонку' : 'Закрыть'} · Esc`} onClick={requestClose}>
        <Ic n="x" />
      </button>
    </header>
  )

  // ── обзор ──
  const gridIds = WEB_SECTIONS
  const spans = phoneSpans(gridIds)
  const overview = phone ? (
    <main className="ebs-content ebs-ovphone" onKeyDown={onOverviewKey}>
      <div className="ebs-psearch">
        <SearchBox query={query} setQuery={setQuery} count={search.rows ? search.rows.length : null} inputRef={searchRef} onEnter={() => firstHit && openRow(firstHit)} wide={false} />
      </div>
      {search.rows ? (
        search.rows.length ? (
          <>
            <div className="ebs-sr" aria-live="polite">Нашлось {search.rows.length} {pluralRu(search.rows.length, 'настройка', 'настройки', 'настроек')}</div>
            {gridIds.filter((id) => search.counts[id] > 0).map((id) => (
              <ResultGroup key={id} id={id} ctx={tilesCtx} />
            ))}
            {gridIds.filter((id) => search.counts[id] === 0).length ? (
              <div className="ebs-faded-note">
                Ещё {gridIds.filter((id) => search.counts[id] === 0).length} {pluralRu(gridIds.filter((id) => search.counts[id] === 0).length, 'раздел', 'раздела', 'разделов')} без совпадений
              </div>
            ) : null}
          </>
        ) : (
          noResults
        )
      ) : (
        <div className="ebs-pgrid">
          <OverviewTiles ctx={tilesCtx} ids={gridIds} spans={spans} />
        </div>
      )}
      {search.rows ? null : (
        <div className="ebs-pexit">
          {model.exitAsk ? exitQuestion : exitButton}
          {VERSION_LINE ? <div className="ebs-pver">{VERSION_LINE}</div> : null}
        </div>
      )}
    </main>
  ) : (
    <div className="ebs-ov" onKeyDown={onOverviewKey}>
      <div className="ebs-ovgrid" role="group" aria-label="Разделы настроек" data-areas={OVERVIEW_GRID_AREAS.length}>
        <OverviewTiles ctx={tilesCtx} ids={gridIds} />
      </div>
      {noResults}
      <footer className="ebs-foot">
        {model.exitAsk ? (
          exitQuestion
        ) : (
          <>
            {exitButton}
            <span className="ebs-foot__fill" />
            {hintsWide}
          </>
        )}
      </footer>
    </div>
  )

  // ── раздел ──
  const sectionPage = sectionId ? (
    <SectionPage
      id={sectionId}
      avTab={avTab}
      setAvTab={setAvTab}
      query={query}
      phone={phone}
      qCount={search.rows ? search.counts[sectionId] : null}
      clearQuery={() => setQuery('')}
    />
  ) : null

  const rail = sectionId ? (
    <aside className="ebs-rail">
      <nav role="radiogroup" aria-label="Разделы настроек" onKeyDown={onRailKey}>
        <button type="button" className="ebs-ritem" onClick={() => nav.goOverview()} aria-label="Обзор: все разделы плитками">
          <span className="ebs-sq ebs-sq--plain">
            <Ic n="grid" />
          </span>
          <span>
            <span className="ebs-ritem__t">Обзор</span>
            <span className="ebs-ritem__s">Все разделы плитками</span>
          </span>
        </button>
        <div className="ebs-rail__sep" />
        {gridIds.map((id) => {
          const st = model.secState(id)
          const n = search.rows ? search.counts[id] : 0
          const mark = search.rows ? (n ? <span className="ebs-count">{n}</span> : null) : model.attention[id] ? <span className="ebs-bang" aria-hidden="true">!</span> : id === 'profile' && model.profile.dirty ? <span className="ebs-adot" aria-hidden="true" /> : null
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={sectionId === id}
              tabIndex={sectionId === id ? 0 : -1}
              className={`ebs-ritem${search.rows && !n ? ' is-faded' : ''}`}
              aria-label={`${SECTION_NAMES[id]}: ${st.text}${model.attention[id] ? ', требует внимания' : ''}`}
              onClick={() => nav.switchSection(id)}
            >
              <span className="ebs-sq">
                <Ic n={SECTION_ICONS[id] as IconName} />
              </span>
              <span>
                <span className="ebs-ritem__t">{SECTION_NAMES[id]}</span>
                <span className={`ebs-ritem__s${st.kind ? ' is-' + st.kind : ''}`}>{st.text}</span>
              </span>
              {mark}
            </button>
          )
        })}
      </nav>
      <div className="ebs-rail__foot">
        {model.exitAsk ? exitQuestion : exitButton}
        {VERSION_LINE ? <div className="ebs-rail__ver">{VERSION_LINE}</div> : null}
      </div>
    </aside>
  ) : null

  function onRailKey(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.ebs-ritem[role="radio"]'))
    const i = items.findIndex((x) => x === document.activeElement)
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]
    next?.focus()
    const idx = items.indexOf(next)
    if (idx >= 0) nav.switchSection(gridIds[idx])
  }

  const body = (
    <div className={`ebs-body${animating ? ' is-animating' : ''}`} ref={bodyRef}>
      {view.kind === 'overview' ? (
        overview
      ) : phone ? (
        <main className="ebs-content" ref={paneRef}>
          {sectionPage}
        </main>
      ) : (
        <div className="ebs-sec">
          {rail}
          <div className="ebs-pane" ref={paneRef}>
            {sectionPage}
          </div>
        </div>
      )}
      {leave || blockedNow ? (
        <LeaveDialog
          onCancel={() => {
            setLeave(null)
            if (blockedNow) blocker.reset?.()
          }}
          onDiscard={() => {
            const then = leave?.then
            leavingRef.current = true
            model.profile.discard()
            setLeave(null)
            if (blockedNow) blocker.proceed?.()
            else then?.()
          }}
          onSave={async () => {
            const ok = await model.profile.save()
            if (!ok) return
            const then = leave?.then
            leavingRef.current = true
            setLeave(null)
            if (blockedNow) blocker.proceed?.()
            else then?.()
          }}
        />
      ) : null}
    </div>
  )

  const root = (
    <SettingsModelProvider value={model}>
      <SettingsUiProvider value={uiState}>
        <div
          ref={rootRef}
          className="ebs"
          data-mode={mode}
          style={props.zIndex ? { zIndex: props.zIndex } : undefined}
          onMouseDown={(e) => {
            // щелчок мимо панели закрывает (на телефоне панель во весь экран)
            if (e.target === e.currentTarget && !phone && !model.pwdBusy) requestClose()
          }}
          onKeyDown={onPanelKeyDown}
        >
          <div className="ebs-panel" role="dialog" aria-modal="true" aria-label="Настройки">
            {header}
            {body}
          </div>
        </div>
      </SettingsUiProvider>
    </SettingsModelProvider>
  )

  return props.portal && typeof document !== 'undefined' ? createPortal(root, document.body) : root
}

// ───────────────────────────── страница раздела ─────────────────────────────

function SectionPage({
  id,
  avTab,
  setAvTab,
  query,
  phone,
  qCount,
  clearQuery,
}: {
  id: SettingsSectionId
  avTab: SettingsAvTab
  setAvTab: (t: SettingsAvTab) => void
  query: string
  phone: boolean
  qCount: number | null
  clearQuery: () => void
}) {
  return (
    <div className="ebs-page" key={id}>
      {phone && query ? (
        <div className="ebs-qchip" role="status">
          <Ic n="search" />
          <span>
            «<b>{query}</b>» · {qCount ?? 0} {pluralRu(qCount ?? 0, 'совпадение', 'совпадения', 'совпадений')}
          </span>
          <button type="button" className="ebs-search__clr" aria-label="Сбросить поиск" onClick={clearQuery}>
            <Ic n="x" />
          </button>
        </div>
      ) : null}
      <div className="ebs-phead">
        <span className="ebs-sq">
          <Ic n={SECTION_ICONS[id]} />
        </span>
        <div>
          <h2 className="ebs-phead__t">{SECTION_NAMES[id]}</h2>
          <div className="ebs-phead__s">
            <Hl text={SUBTITLES[id]} />
          </div>
        </div>
      </div>
      {id === 'profile' ? <ProfileSection /> : null}
      {id === 'conn' ? <ConnectionSection /> : null}
      {id === 'av' ? <AvSection tab={avTab} setTab={setAvTab} query={query} /> : null}
      {id === 'security' ? <SecuritySection /> : null}
      {id === 'app' ? <AppSection /> : null}
    </div>
  )
}
