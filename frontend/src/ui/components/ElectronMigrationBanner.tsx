/**
 * Баннер «Переезжайте на новую Еблушу» — только для старой ПК-версии (Electron, Windows).
 * Логика и тексты — `electronMigration.ts`; стенд — `/__dev/electron-migration` (dev-сборка).
 *
 * Виден, когда всё сразу:
 *   • мы в Electron на Windows и у него есть мост `window.native` с openSettings;
 *   • Electron САМ видит обновление ≥ 2.0.0 (его ответ, не наш запрос к ленте);
 *   • «Позже» не нажимали последние ELECTRON_MIGRATION_SNOOZE_DAYS дней;
 *   • нет звонка (входящий, дозвон, идущий, свёрнутый) и плашки «Новый сеанс».
 * «Перейти» открывает настройки Electron (обновление — их первый блок) и прячет баннер до
 * перезагрузки страницы; «Позже» прячет на N дней.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, KeyRound, Lock } from 'lucide-react'
import { useCallStore } from '../../domain/store/callStore'
import { useSystemUiStore } from '../../domain/store/systemUiStore'
import {
  ELECTRON_MIGRATION_SECRET_NOTE,
  ELECTRON_MIGRATION_TEXT as TEXT,
  defaultMigrationEnv,
  detectMigrationHost,
  isMigrationOffer,
  parseNativeUpdateAnswer,
  readSnooze,
  writeSnooze,
  type MigrationEnv,
  type MigrationHost,
  type NativeUpdateAnswer,
} from './electronMigration'
import './electronMigrationBanner.css'

/** Как часто смотреть на «!» шестерёнки (чтение свойства окна, без IPC). */
const BADGE_POLL_MS = 3000
/** Вопросы к Electron — не чаще. «!» меняется не чаще его проверок ленты (раз в 5 минут),
 *  так что это лишь защита от дребезга. */
const MIN_ASK_GAP_MS = 5_000
/** После смены «!» дать Electron дописать состояние. */
const BADGE_SETTLE_MS = 1500
/** Electron как раз проверяет ленту — спросить ещё раз позже. */
const ASK_AGAIN_CHECKING_MS = 20_000
/** Редкая перепроверка — только там, где «!» ничего не подскажет. */
const ASK_AGAIN_SLOW_MS = 60 * 60_000

export type ElectronMigrationState = {
  host: MigrationHost
  answer: NativeUpdateAnswer | null
  offer: NativeUpdateAnswer | null
  snoozedUntil: number | null
  inCall: boolean
  visible: boolean
  go: () => void
  later: () => void
}

/**
 * Спрашиваем Electron через settingsGetState (без сети: состояние его последней проверки) — но
 * редко: при не заданном в его settings.json autostartEnabled обработчик зовёт `reg query`
 * через exec без windowsHide, и может мелькнуть консоль. Поэтому: один вопрос при загрузке
 * страницы, вопрос при смене «!» на шестерёнке и раз в час — только когда «!» не поможет.
 * settingsCheckUpdate — лишь запасной путь для моста без settingsGetState: явная проверка в
 * Electron сбрасывает «скачано» (обработчик update-available ставит downloaded:false), а свою
 * плановую проверку Electron во время загрузки и после неё сам пропускает.
 */
export function useElectronMigrationOffer(env: MigrationEnv): ElectronMigrationState {
  const host = useMemo(() => detectMigrationHost(env), [env])
  const eligible = host === 'electron-windows'
  const [answer, setAnswer] = useState<NativeUpdateAnswer | null>(null)
  const [snoozedUntil, setSnoozedUntil] = useState<number | null>(() => (eligible ? readSnooze(env.storage, env.now()) : null))
  const [hiddenThisPage, setHiddenThisPage] = useState(false)
  const inCall = useCallStore((s) =>
    Boolean(s.incoming || s.outgoingCall || s.overlayConvId || s.minimizedCallConvId || s.activeConvId),
  )
  const newSessionShown = useSystemUiStore((s) => Boolean(s.newSessionPopup))
  const snoozed = snoozedUntil !== null

  // «Позже» истекает, пока страница открыта.
  useEffect(() => {
    if (snoozedUntil === null) return
    const left = snoozedUntil - env.now()
    if (left <= 0) {
      setSnoozedUntil(null)
      return
    }
    const t = setTimeout(() => setSnoozedUntil(readSnooze(env.storage, env.now())), Math.min(left + 1000, 0x7fffffff))
    return () => clearTimeout(t)
  }, [snoozedUntil, env])

  useEffect(() => {
    if (!eligible || snoozed) return
    const native = env.native
    if (!native) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false
    let askAgain = false
    let lastAskAt = Number.NEGATIVE_INFINITY
    let lastBadge = env.readBadge()

    const plan = (ms: number) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void ask()
      }, Math.max(0, ms))
    }

    const ask = async () => {
      if (disposed) return
      if (inFlight) {
        askAgain = true
        return
      }
      inFlight = true
      lastAskAt = env.now()
      let next: NativeUpdateAnswer | null = null
      try {
        const raw =
          typeof native.settingsGetState === 'function'
            ? await native.settingsGetState()
            : await native.settingsCheckUpdate?.()
        next = parseNativeUpdateAnswer(raw)
      } catch {
        next = null
      }
      inFlight = false
      if (disposed) return
      setAnswer(next)
      if (askAgain) {
        askAgain = false
        plan(MIN_ASK_GAP_MS)
      } else if (next?.status === 'checking') {
        plan(ASK_AGAIN_CHECKING_MS)
      } else if (!next || env.readBadge() === null || (next.available && !isMigrationOffer(next))) {
        // Ошибка моста; «!» нет вовсе; или Electron уже видит другое обновление (0.7.6) — «!» так и
        // останется гореть, когда в ленте появится 2.0.0, и смена версии нам не просигналит.
        plan(ASK_AGAIN_SLOW_MS)
      }
    }

    plan(env.firstAskDelayMs)

    const badgeTimer = setInterval(() => {
      const b = env.readBadge()
      if (b === lastBadge) return
      const prev = lastBadge
      lastBadge = b
      // После перезагрузки страницы preload пишет false, даже если обновление давно найдено (main
      // шлёт updater:badge только при смене) — первое значение, кроме true, событием не считаем.
      if (prev === null && b !== true) return
      plan(Math.max(BADGE_SETTLE_MS, lastAskAt + MIN_ASK_GAP_MS - env.now()))
    }, BADGE_POLL_MS)

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      clearInterval(badgeTimer)
    }
  }, [eligible, snoozed, env])

  const offer = eligible && isMigrationOffer(answer) ? answer : null
  const visible = !!offer && !snoozed && !hiddenThisPage && !inCall && !newSessionShown

  const later = () => {
    setSnoozedUntil(writeSnooze(env.storage, env.now()))
    // Пока отложено, Electron не спрашиваем; по истечении — сначала свежий ответ, не старый.
    setAnswer(null)
  }

  // Без settingsCheckUpdate: состояние «есть обновление» Electron уже знает (иначе баннера бы не
  // было) и сам отдаёт его настройкам при открытии, а явная проверка сбросила бы «скачано».
  const go = () => {
    setHiddenThisPage(true)
    try {
      Promise.resolve(env.native?.openSettings?.()).catch(() => setHiddenThisPage(false))
    } catch {
      setHiddenThisPage(false)
    }
  }

  return { host, answer, offer, snoozedUntil, inCall, visible, go, later }
}

export function ElectronMigrationBanner(props: {
  /** Подставная среда (стенд); в приложении — window.native, navigator, localStorage. */
  env?: MigrationEnv
  onStateChange?: (state: ElectronMigrationState) => void
}) {
  const { env: envProp, onStateChange } = props
  const env = useMemo(() => envProp ?? defaultMigrationEnv(), [envProp])
  const state = useElectronMigrationOffer(env)

  useEffect(() => {
    onStateChange?.(state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.host, state.answer, state.snoozedUntil, state.inCall, state.visible, onStateChange])

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
          <p className="eb-mig__hint">{offer.downloaded ? TEXT.hintDownloaded : TEXT.hint}</p>
        </div>
      </section>
    </div>
  )
}

export default ElectronMigrationBanner
