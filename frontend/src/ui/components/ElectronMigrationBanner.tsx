/**
 * Баннер «Переезжайте на новую Еблушу» — только для старой ПК-версии (Electron, Windows).
 * Логика, тексты и «когда спрашивать Electron» — `electronMigration.ts`; стенд — `/__dev/electron-migration`.
 *
 * Виден, когда всё сразу:
 *   • мы в Electron на Windows (не Mac) и у него есть мост `window.native` с settingsGetState и openSettings;
 *   • Windows не старше 10 1809 (иначе новая там не запустится);
 *   • Electron САМ видит обновление ≥ 2.0.0 (его ответ, не наш запрос к ленте);
 *   • «Позже» не нажимали недавно (3 дня, потом 14, потом по 30);
 *   • нет звонка (входящий, дозвон, идущий, свёрнутый) и плашки «Новый сеанс»;
 *   • нет плашки «Запросы в друзья» — она стоит там же, сверху по центру (это — в CSS).
 * Слой — НИЖЕ всех окон, меню и плашек приложения: открытое окно всегда поверх баннера.
 * «Перейти» открывает настройки Electron (обновление — их первый блок) и прячет баннер до
 * перезагрузки страницы; «Позже» прячет на срок.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, KeyRound, Lock } from 'lucide-react'
import { useCallStore } from '../../domain/store/callStore'
import { useSystemUiStore } from '../../domain/store/systemUiStore'
import {
  ELECTRON_MIGRATION_SECRET_NOTE,
  ELECTRON_MIGRATION_TEXT as TEXT,
  NO_SNOOZE,
  defaultMigrationEnv,
  detectMigrationHost,
  isMigrationOffer,
  readSnooze,
  startMigrationWatcher,
  writeSnooze,
  type MigrationEnv,
  type MigrationHost,
  type MigrationWatcher,
  type NativeUpdateAnswer,
  type SnoozeState,
} from './electronMigration'
import './electronMigrationBanner.css'

export type ElectronMigrationState = {
  host: MigrationHost
  answer: NativeUpdateAnswer | null
  offer: NativeUpdateAnswer | null
  snooze: SnoozeState
  osTooOld: boolean
  inCall: boolean
  visible: boolean
  go: () => void
  later: () => void
}

export function useElectronMigrationOffer(env: MigrationEnv): ElectronMigrationState {
  const host = useMemo(() => detectMigrationHost(env), [env])
  const eligible = host === 'electron-windows'
  const [answer, setAnswer] = useState<NativeUpdateAnswer | null>(null)
  const [snooze, setSnooze] = useState<SnoozeState>(() => (eligible ? readSnooze(env.storage, env.now()) : { ...NO_SNOOZE }))
  const [osTooOld, setOsTooOld] = useState(false)
  const [hiddenThisPage, setHiddenThisPage] = useState(false)
  const inCall = useCallStore((s) =>
    Boolean(s.incoming || s.outgoingCall || s.overlayConvId || s.minimizedCallConvId || s.activeConvId),
  )
  const newSessionShown = useSystemUiStore((s) => Boolean(s.newSessionPopup))
  const snoozed = snooze.until !== null
  const snoozedRef = useRef(snoozed)
  snoozedRef.current = snoozed
  const watcherRef = useRef<MigrationWatcher | null>(null)

  // «Позже» истекает, пока страница открыта. Таймер не длиннее ~24 дней (предел setTimeout) —
  // для 30-дневного срока перечитаем и заведём заново (новый объект состояния → эффект ещё раз).
  useEffect(() => {
    if (snooze.until === null) return
    const left = snooze.until - env.now()
    const reread = () => setSnooze(readSnooze(env.storage, env.now()))
    if (left <= 0) {
      setSnooze((s) => ({ until: null, count: s.count }))
      return
    }
    const t = setTimeout(reread, Math.min(left + 1000, 0x7fffffff))
    return () => clearTimeout(t)
  }, [snooze, env])

  // Наблюдатель: «!» шестерёнки + редкие вопросы к Electron (правила — startMigrationWatcher).
  useEffect(() => {
    if (!eligible || osTooOld) return
    const w = startMigrationWatcher(env, {
      snoozed: snoozedRef.current,
      onAnswer: setAnswer,
      onTooOld: () => setOsTooOld(true),
    })
    watcherRef.current = w
    return () => {
      w.stop()
      if (watcherRef.current === w) watcherRef.current = null
    }
  }, [eligible, osTooOld, env])

  useEffect(() => {
    watcherRef.current?.setSnoozed(snoozed)
  }, [snoozed])

  const offer = eligible && !osTooOld && isMigrationOffer(answer) ? answer : null
  const visible = !!offer && !snoozed && !hiddenThisPage && !inCall && !newSessionShown

  const later = () => {
    setSnooze(writeSnooze(env.storage, env.now()))
    // По истечении — сначала свежий ответ Electron, не старый.
    setAnswer(null)
  }

  // Без settingsCheckUpdate: «есть обновление» Electron уже знает (иначе баннера бы не было) и сам
  // отдаёт его настройкам при открытии, а внеплановая проверка сбросила бы «скачано».
  const go = () => {
    setHiddenThisPage(true)
    try {
      Promise.resolve(env.native?.openSettings?.()).catch(() => setHiddenThisPage(false))
    } catch {
      setHiddenThisPage(false)
    }
  }

  return { host, answer, offer, snooze, osTooOld, inCall, visible, go, later }
}

export function ElectronMigrationBanner(props: {
  /** Подставная среда (стенд); в приложении — window.native, navigator, localStorage, sessionStorage. */
  env?: MigrationEnv
  onStateChange?: (state: ElectronMigrationState) => void
}) {
  const { env: envProp, onStateChange } = props
  const env = useMemo(() => envProp ?? defaultMigrationEnv(), [envProp])
  const state = useElectronMigrationOffer(env)

  useEffect(() => {
    onStateChange?.(state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.host, state.answer, state.snooze, state.osTooOld, state.inCall, state.visible, onStateChange])

  const offer = state.offer
  if (!state.visible || !offer) return null
  const version = offer.latestVersion ?? ''

  return (
    <div className="eb-mig-dock">
      {/* Не dialog: ПК-оболочка растягивает любой [role="dialog"] на всё окно. */}
      <section className="eb-mig" role="region" aria-label={TEXT.region}>
        <div className="eb-mig__bar">
          <span className="eb-mig__brand" aria-hidden="true">
            <span>Е</span>
            <span className="eb-mig__b">Б</span>
            <span>луша</span>
          </span>
          <span className="eb-mig__bar-text">{TEXT.barText}</span>
          <ul className="eb-mig__pills">
            {version ? (
              <li className="eb-mig__pill">
                <span>{TEXT.pillVersion(version)}</span>
              </li>
            ) : null}
            {offer.downloaded ? (
              <li className="eb-mig__pill eb-mig__pill--ready">
                <span>{TEXT.pillDownloaded}</span>
              </li>
            ) : null}
          </ul>
        </div>
        <div className="eb-mig__body">
          <h2 className="eb-mig__title">{TEXT.title}</h2>
          <p className="eb-mig__lead">{TEXT.lead}</p>
          <ul className="eb-mig__facts">
            <li>
              <KeyRound aria-hidden="true" />
              <span>{TEXT.login}</span>
            </li>
            <li>
              <Lock aria-hidden="true" />
              <span>{ELECTRON_MIGRATION_SECRET_NOTE}</span>
            </li>
          </ul>
          <div className="eb-mig__actions">
            <button type="button" className="eb-mig__go" onClick={state.go}>
              <span>{TEXT.go}</span>
              <ArrowRight aria-hidden="true" />
            </button>
            <button type="button" className="eb-mig__later" onClick={state.later}>
              {TEXT.later}
            </button>
          </div>
          <p className="eb-mig__hint">{TEXT.hint}</p>
        </div>
      </section>
    </div>
  )
}

export default ElectronMigrationBanner
