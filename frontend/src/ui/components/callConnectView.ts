/**
 * Модель экрана установления звонка.
 *
 * Экран — не постановка, а зеркало: каждый этап и каждый факт на нём выводится из
 * реального состояния звонка (пропуск получен, ключи готовы, комната подключена,
 * шифрование подтверждено, микрофон опубликован, собеседник слышен). Здесь нет таймеров
 * и процентов: быстрый этап проскакивает мгновенно, долгий честно висит.
 *
 * Сборка модели не зависит от React, чтобы её можно было прогнать на фиксированных
 * состояниях (см. ui/dev/CallConnectingDemo).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CALL_SECURITY_LABEL } from './callSecurity'

export type ConnectStepId = 'ring' | 'signaling' | 'crypto-prepare' | 'route' | 'crypto-enable' | 'publish' | 'wait-peer'
export type ConnectStepStatus = 'done' | 'active' | 'waiting'
export type ConnectNodeId = 'you' | 'relay' | 'server' | 'peer'
/** ringing — исходящий вызов: собеседнику звонит, он ещё не ответил. */
export type ConnectNodeState = 'waiting' | 'active' | 'ready' | 'ringing'
export type ConnectLinkState = 'idle' | 'searching' | 'ready'
/** settling — собеседник уже слышен, но у него ещё дорисовывается своя картина подключения. */
export type ConnectPeerPresence = 'absent' | 'joining' | 'settling' | 'ready'

/** Каким путём легло соединение с сервером звонков — из живой статистики WebRTC. */
export type ConnectRoute = {
  /** true — через ретранслятор, false — напрямую, null — ещё неизвестно. */
  relayed: boolean | null
  rttMs: number | null
  relayName: string | null
  relayHost: string | null
}

/** Что наблюдатель внутри комнаты сообщает наружу. */
export type ConnectProgress = {
  micPublished: boolean
  peerPresence: ConnectPeerPresence
  /** Сколько людей в комнате кроме нас. */
  peerCount: number
  peerName: string | null
  /** Собеседник дорисовал свою картину (или сигнала от него не ждём) — можно открывать разговор. */
  peerSettled: boolean
  /** Звук собеседника идёт, а шифрование он так и не подтвердил — это уже ошибка E2EE. */
  peerEncryptionTimeout: boolean
  route: ConnectRoute
}

export const EMPTY_CONNECT_PROGRESS: ConnectProgress = {
  micPublished: false,
  peerPresence: 'absent',
  peerCount: 0,
  peerName: null,
  peerSettled: false,
  peerEncryptionTimeout: false,
  route: { relayed: null, rttMs: null, relayName: null, relayHost: null },
}

/** Реальные состояния звонка, из которых собирается экран. */
export type ConnectSignals = {
  isGroup: boolean
  /**
   * Звонок обязан быть зашифрован (разговоры один на один — всегда). Ключ пока выдаёт сервер,
   * поэтому подпись — «Шифрование через сервер», а не «сквозное» (callSecurity.ts).
   */
  encrypted: boolean
  /** Человек вошёл с выключенным микрофоном — публикации голоса ждать нечего. */
  muted: boolean
  /** Сервер выдал пропуск в комнату. */
  hasToken: boolean
  /** Ключ разговора получен, шифратор готов. Это ещё не включённое шифрование. */
  keysReady: boolean
  /** Соединение с сервером звонков установлено. */
  connected: boolean
  /** Шифрование подтверждено на нашем соединении. */
  e2eeEnabled: boolean
  micPublished: boolean
  /** Через ретрансляторы не вышло — идёт повторная попытка напрямую. */
  routeSwitching: boolean
  route: ConnectRoute
  peer: {
    presence: ConnectPeerPresence
    count: number
    name: string | null
    id: string | null
    avatarUrl: string | null
  }
  /** Ошибка, после которой звонок продолжать нельзя. */
  error: string | null
  /** Заголовок для ошибки; по умолчанию — про защищённый звонок. */
  errorTitle?: string | null
  /** Ошибку можно повторить: шифрование не включилось ещё до начала разговора. */
  errorRetry?: boolean
  /** Микрофон не удалось получить — входим без него и честно это показываем. */
  micUnavailable?: boolean
  /**
   * Исходящий вызов: true — собеседник ещё не ответил, false — ответил (ступень «Ждём
   * ответа» остаётся в списке сделанной), undefined — у звонка не было дозвона.
   */
  ringing?: boolean
  /** Сколько секунд идёт дозвон — для подписи под заголовком. */
  ringingSeconds?: number | null
}

export type ConnectStep = { id: ConnectStepId; title: string; status: ConnectStepStatus; hint: string }

export type ConnectNode = {
  id: ConnectNodeId
  label: string
  sub: string | null
  state: ConnectNodeState
  avatarUrl: string | null
  avatarId: string | null
  /** Узел обозначает группу, а не одного человека. */
  group: boolean
  /** Что показать по нажатию на узел. */
  detail: string
}

export type ConnectLink = { from: ConnectNodeId; to: ConnectNodeId; state: ConnectLinkState }

/** e2ee — шифрование через сервер включено; plain — звонок без шифрования (группы до 2.0). */
export type ConnectFact = { id: 'e2ee' | 'plain' | 'relay' | 'direct' | 'rtt'; text: string }

export type ConnectView = {
  mode: 'connecting' | 'done' | 'error'
  title: string
  subtitle: string
  steps: ConnectStep[]
  nodes: ConnectNode[]
  links: ConnectLink[]
  facts: ConnectFact[]
  /** retry — показать «Повторить» (звонок ещё не начат, можно попробовать снова). */
  error: { title: string; text: string; retry: boolean } | null
  /** Наша часть готова и собеседник слышен — экран можно убирать. */
  ready: boolean
}

const ERROR_TITLE = 'Защищённый звонок недоступен'

/** Монотонные часы: перевод системного времени не должен стопорить темп и таймауты. */
export function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

function pluralParticipants(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} участник`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} участника`
  return `${n} участников`
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${sec < 10 ? '0' : ''}${sec}`
}

function relayFact(name: string | null): string {
  if (!name) return 'Через ретранслятор'
  if (name === 'Наш ретранслятор') return 'Через наш ретранслятор'
  return `Через ретранслятор ${name}`
}

export function buildConnectView(s: ConnectSignals): ConnectView {
  if (s.error) {
    const title = s.errorTitle || ERROR_TITLE
    return {
      mode: 'error',
      title,
      subtitle: '',
      steps: [],
      nodes: [],
      links: [],
      facts: [],
      error: { title, text: s.error, retry: !!s.errorRetry },
      ready: false,
    }
  }

  const { isGroup, encrypted } = s
  const dialed = s.ringing !== undefined
  const ringing = s.ringing === true
  const signalingDone = s.hasToken
  const keysDone = !encrypted || s.keysReady
  const routeDone = s.connected
  const e2eeDone = !encrypted || s.e2eeEnabled
  const micSkipped = s.muted || !!s.micUnavailable
  const publishDone = micSkipped || s.micPublished
  const localReady = signalingDone && keysDone && routeDone && e2eeDone && publishDone
  // В группе ждать некого, если в комнате пусто: мы первые, остальные подтянутся в
  // обычный интерфейс. Если кто-то уже есть — ждём, пока хоть один станет слышен.
  // Кто в комнате, известно только после подключения — до него ничего не решаем.
  const peerDone = isGroup ? s.connected && (s.peer.count === 0 || s.peer.presence === 'ready') : s.peer.presence === 'ready'
  const ready = localReady && peerDone

  const rtt = s.connected && typeof s.route.rttMs === 'number' && s.route.rttMs > 0 ? Math.round(s.route.rttMs) : null
  const relayShown = s.connected && s.route.relayed === true
  const relayLabel = s.route.relayName || 'Ретранслятор'
  const peerLabel = isGroup ? s.peer.name || 'Группа' : s.peer.name || 'Собеседник'

  // Этап активен, когда его предпосылки выполнены, а сам он — ещё нет.
  const status = (done: boolean, gate: boolean): ConnectStepStatus => (done ? 'done' : gate ? 'active' : 'waiting')

  const steps: ConnectStep[] = []
  if (dialed) {
    steps.push({
      id: 'ring',
      title: 'Ждём ответа',
      status: ringing ? 'active' : 'done',
      hint: ringing ? 'Собеседнику звонит — он ещё не ответил на вызов.' : 'Собеседник ответил на вызов.',
    })
  }
  steps.push({
    id: 'signaling',
    title: 'Согла­суем звонок',
    status: status(signalingDone, !ringing),
    hint: signalingDone ? 'Сервер знает о звонке и выдал нам пропуск в комнату.' : 'Просим у сервера пропуск в комнату звонка.',
  })
  if (encrypted) {
    steps.push({
      id: 'crypto-prepare',
      title: 'Готовим шифро­вание',
      status: status(s.keysReady, signalingDone),
      hint: s.keysReady
        ? 'Ключ разговора получен от сервера, шифратор готов. Само шифрование включится после подключения.'
        : 'Получаем у сервера ключ разговора и готовим шифратор. Без ключа звонок не начнётся.',
    })
  }
  steps.push({
    id: 'route',
    title: 'Ищем путь к серверу',
    status: status(routeDone, signalingDone && keysDone),
    hint: routeDone
      ? relayShown
        ? `Путь к серверу проложен через ${relayLabel}${s.route.relayHost ? ` (${s.route.relayHost})` : ''}.`
        : 'Путь к серверу проложен напрямую, без ретранслятора.'
      : s.routeSwitching
        ? 'Через ретрансляторы не вышло — пробуем соединиться с сервером напрямую.'
        : 'Подбираем путь к серверу звонков: через ближайший ретранслятор или напрямую.',
  })
  if (encrypted) {
    steps.push({
      id: 'crypto-enable',
      title: 'Включаем шифро­вание',
      status: status(s.e2eeEnabled, routeDone),
      hint: s.e2eeEnabled
        ? 'Шифрование включено: голос уходит зашифрованным. Ключ выдал сервер Еблуши, поэтому сквозным это шифрование не является.'
        : 'Включаем шифрование на этом соединении и ждём подтверждения. До этого голос не передаётся.',
    })
  }
  steps.push({
    id: 'publish',
    title: s.micUnavailable ? 'Микрофон недо­ступен' : s.muted ? 'Микрофон выклю­чен' : 'Передаём ваш голос',
    status: status(publishDone, routeDone && e2eeDone),
    hint: s.micUnavailable
      ? 'Не удалось получить доступ к микрофону — вас не будет слышно. Проверьте разрешения браузера.'
      : s.muted
      ? 'Вы вошли с выключенным микрофоном: вас не будет слышно, пока не включите его.'
      : publishDone
        ? 'Ваш голос уходит в звонок.'
        : 'Отдаём ваш микрофон в звонок. До этого момента вас не слышно.',
  })
  steps.push({
    id: 'wait-peer',
    title: isGroup ? 'Подключаем участ­ников' : 'Ждём собесед­ника',
    status: status(peerDone, localReady),
    hint: isGroup
      ? s.peer.count === 0
        ? s.connected
          ? 'В разговоре пока никого нет — вы первые. Остальные появятся по мере подключения.'
          : 'Кто уже в разговоре, узнаем после подключения к серверу.'
        : peerDone
          ? 'Участники слышны.'
          : 'Участники в комнате, ждём их звук.'
      : s.peer.presence === 'ready'
        ? 'Собеседник слышен — можно говорить.'
        : s.peer.presence === 'settling'
          ? 'Собеседник уже слышен, у него дорисовывается картина подключения.'
          : s.peer.presence === 'joining'
          ? encrypted
            ? 'Собеседник в комнате, ждём его звук и подтверждение шифрования.'
            : 'Собеседник в комнате, ждём его звук.'
          : 'Собеседник ещё не подключился к комнате звонка.',
  })

  let title = 'Соединение установлено'
  let subtitle = 'Начинаем разговор'
  if (!ready) {
    const active = steps.find((st) => st.status === 'active')
    switch (active?.id) {
      case 'ring':
        title = 'Звоним…'
        subtitle = `Ждём ответа собеседника${typeof s.ringingSeconds === 'number' ? ` · ${formatSeconds(s.ringingSeconds)}` : ''}`
        break
      case 'signaling':
        // После дозвона важнее сказать, что собеседник ответил, чем что мы договариваемся.
        title = dialed ? 'Собеседник ответил' : 'Подключаем звонок…'
        subtitle = 'Договариваемся о соединении'
        break
      case 'crypto-prepare':
        title = 'Готовим защиту…'
        subtitle = 'Подготавливаем шифрование'
        break
      case 'route':
        if (s.routeSwitching) {
          title = 'Меняем маршрут…'
          subtitle = 'Пробуем соединиться с сервером напрямую'
        } else {
          title = 'Прокладываем путь…'
          subtitle = 'Ищем соединение с сервером Еблуши'
        }
        break
      case 'crypto-enable':
        title = 'Включаем шифрование…'
        subtitle = 'Проверяем защищённое соединение'
        break
      case 'publish':
        title = 'Подключаем микрофон…'
        subtitle = 'Готовим передачу вашего голоса'
        break
      case 'wait-peer':
        if (isGroup) {
          title = 'Подключаем участников…'
          subtitle = 'Ждём звук от участников разговора'
        } else if (s.peer.presence === 'settling') {
          title = 'Синхронизируемся…'
          subtitle = 'Собеседник вот-вот подключится'
        } else if (s.peer.presence === 'joining') {
          title = 'Собеседник подключается…'
          subtitle = encrypted ? 'Ждём звук и подтверждение шифрования с той стороны' : 'Ждём звук с той стороны'
        } else {
          title = 'Ждём собеседника…'
          subtitle = 'Собеседник ещё не в комнате звонка'
        }
        break
      default:
        title = 'Подключаем звонок…'
        subtitle = 'Договариваемся о соединении'
    }
  }

  const routeActive = steps.some((st) => st.id === 'route' && st.status === 'active')

  const nodes: ConnectNode[] = []
  nodes.push({
    id: 'you',
    label: 'Вы',
    sub: null,
    state: 'ready',
    avatarUrl: null,
    avatarId: null,
    group: false,
    detail: s.micUnavailable
      ? 'Вы. Микрофон недоступен — вас не будет слышно.'
      : s.muted
      ? 'Вы. Микрофон выключен.'
      : s.micPublished
        ? 'Вы. Микрофон передаётся в звонок.'
        : 'Вы. Микрофон ещё не подключён к звонку.',
  })
  if (relayShown) {
    nodes.push({
      id: 'relay',
      label: relayLabel,
      sub: s.route.relayHost,
      state: 'ready',
      avatarUrl: null,
      avatarId: null,
      group: false,
      detail: `${relayLabel}${s.route.relayHost ? ` (${s.route.relayHost})` : ''}: через него идёт ваш путь к серверу.`,
    })
  }
  nodes.push({
    id: 'server',
    label: 'Сервер Еблуши',
    sub: rtt !== null ? `${rtt} мс` : null,
    state: s.connected ? 'ready' : routeActive ? 'active' : 'waiting',
    avatarUrl: null,
    avatarId: null,
    group: false,
    detail: s.connected
      ? `Сервер Еблуши: соединение установлено${rtt !== null ? `, задержка ${rtt} мс` : ''}.`
      : routeActive
        ? 'Сервер Еблуши: ищем соединение.'
        : 'Сервер Еблуши: ждём своей очереди.',
  })
  const peerState: ConnectNodeState = ringing
    ? 'ringing'
    : isGroup
    ? s.peer.count === 0
      ? 'waiting'
      : s.peer.presence === 'ready'
        ? 'ready'
        : 'active'
    : s.peer.presence === 'ready'
      ? 'ready'
      : s.peer.presence === 'joining' || s.peer.presence === 'settling'
        ? 'active'
        : 'waiting'
  const peerNote = ' Показан ваш путь к серверу; данные о сети собеседника недоступны.'
  nodes.push({
    id: 'peer',
    label: peerLabel,
    sub: isGroup ? (s.peer.count > 0 ? pluralParticipants(s.peer.count) : 'пока никого') : null,
    state: peerState,
    avatarUrl: s.peer.avatarUrl,
    avatarId: s.peer.id,
    group: isGroup,
    detail: isGroup
      ? s.peer.count === 0
        ? s.connected
          ? `${peerLabel}: в разговоре пока никого нет.`
          : `${peerLabel}: узнаем состав после подключения.`
        : peerState === 'ready'
          ? `${peerLabel}: участники слышны.`
          : `${peerLabel}: подключаем участников.`
      : (peerState === 'ringing'
          ? `${peerLabel}: вызываем, ответа пока нет.`
          : peerState === 'ready'
          ? `${peerLabel}: в звонке, звук идёт.`
          : s.peer.presence === 'settling'
            ? `${peerLabel}: почти готов, дорисовывает картину.`
            : peerState === 'active'
              ? `${peerLabel}: подключается.`
            : `${peerLabel}: ещё не подключился к звонку.`) + peerNote,
  })

  const links: ConnectLink[] = []
  const firstHop: ConnectNodeId = relayShown ? 'relay' : 'server'
  links.push({ from: 'you', to: firstHop, state: s.connected ? 'ready' : routeActive ? 'searching' : 'idle' })
  if (relayShown) links.push({ from: 'relay', to: 'server', state: 'ready' })
  links.push({
    from: 'server',
    to: 'peer',
    state: peerState === 'ready' ? 'ready' : peerState === 'active' ? 'searching' : 'idle',
  })

  const facts: ConnectFact[] = []
  // Честная подпись: ключ 1:1 выдаёт сервер — «Шифрование через сервер»; группа — «Без шифрования».
  if (encrypted && s.e2eeEnabled) facts.push({ id: 'e2ee', text: CALL_SECURITY_LABEL['server-key'] })
  if (!encrypted) facts.push({ id: 'plain', text: CALL_SECURITY_LABEL.none })
  if (relayShown) facts.push({ id: 'relay', text: relayFact(s.route.relayName) })
  if (s.connected && s.route.relayed === false) facts.push({ id: 'direct', text: 'Прямой путь' })
  if (rtt !== null) facts.push({ id: 'rtt', text: `${rtt} мс до сервера` })

  return {
    mode: ready ? 'done' : 'connecting',
    title,
    subtitle,
    steps,
    nodes,
    links,
    facts,
    error: null,
    ready,
  }
}

/**
 * Синхронизация с собеседником: его звук уже идёт, но свою картину он ещё дорисовывает —
 * показываем «синхронизируемся», а не готовность, чтобы разговор открылся у обоих разом.
 */
export function withPeerSync(s: ConnectSignals, peerSettled: boolean): ConnectSignals {
  if (s.isGroup || peerSettled || s.peer.presence !== 'ready') return s
  return { ...s, peer: { ...s.peer, presence: 'settling' } }
}

/**
 * Держит элемент смонтированным ещё [ms] после того, как его попросили убрать, —
 * чтобы успела отыграть анимация ухода. При «меньше движения» задержки нет.
 */
export function useDelayedUnmount(show: boolean, ms: number): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(show)
  const mountedRef = useRef(show)
  mountedRef.current = mounted
  useEffect(() => {
    if (show) {
      setMounted(true)
      return
    }
    if (!mountedRef.current) return
    const reduced =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
    const timer = setTimeout(() => setMounted(false), reduced ? 0 : ms)
    return () => clearTimeout(timer)
  }, [show, ms])
  return { mounted: show || mounted, leaving: !show && mounted }
}

/* ── Темп показа ──────────────────────────────────────────────────────────── */

/**
 * Настоящее подключение часто укладывается в доли секунды, и вместо картины человек
 * видел бы вспышку. Темп не задерживает ни одно реальное событие — звонок под экраном
 * идёт как шёл. Он лишь показывает УЖЕ случившиеся ступени по очереди, каждую не короче
 * одной паузы, так что вся картина занимает около PACING_TARGET_TOTAL_MS. Если
 * подключение само идёт медленнее — темп не вмешивается: ни одна ступень не
 * показывается сделанной раньше, чем сделана на самом деле, а откат реальности
 * (обрыв до готовности) отражается сразу.
 */
export const PACING_TARGET_TOTAL_MS = 3000
export const PACING_MIN_DWELL_MS = 400

/** Ступени в порядке показа; которых в этом звонке нет — пропускаются. */
function milestoneFlags(s: ConnectSignals): boolean[] {
  const flags: boolean[] = []
  if (s.ringing !== undefined) flags.push(!s.ringing)
  flags.push(s.hasToken)
  if (s.encrypted) flags.push(s.keysReady)
  flags.push(s.connected)
  if (s.encrypted) flags.push(s.e2eeEnabled)
  if (!s.muted && !s.micUnavailable) flags.push(s.micPublished)
  if (!s.isGroup) flags.push(s.peer.presence === 'ready')
  else if (s.peer.count > 0) flags.push(s.peer.presence === 'ready')
  else flags.push(s.connected)
  return flags
}

/** Сколько ступеней подряд с начала действительно сделаны. */
function leadingTrue(flags: boolean[]): number {
  let n = 0
  while (n < flags.length && flags[n]) n++
  return n
}

/** Сигналы, в которых сделанными показаны только первые [shown] ступеней. */
export function applyPacing(s: ConnectSignals, shown: number): ConnectSignals {
  if (s.error) return s
  let i = 0
  const next = (real: boolean) => {
    const k = i++
    return real && k < shown
  }
  let ringing = s.ringing
  if (s.ringing !== undefined) {
    const answered = next(!s.ringing)
    ringing = s.ringing || !answered
  }
  const hasToken = next(s.hasToken)
  const keysReady = s.encrypted ? next(s.keysReady) : s.keysReady
  const connected = next(s.connected)
  const e2eeEnabled = s.encrypted ? next(s.e2eeEnabled) : s.e2eeEnabled
  const micPublished = s.muted || s.micUnavailable ? s.micPublished : next(s.micPublished)
  const waitsForPeer = !s.isGroup || s.peer.count > 0
  // В пустой группе последняя ступень — «узнали, что никого нет», она наступает с подключением.
  const peerShown = waitsForPeer ? next(s.peer.presence === 'ready') : next(s.connected) && s.peer.presence === 'ready'
  // Собеседник уже слышен, но его ступень ещё не показана — он «подключается».
  const presence: ConnectPeerPresence = s.peer.presence === 'ready' && !peerShown ? 'joining' : s.peer.presence
  return { ...s, ringing, hasToken, keysReady, connected, e2eeEnabled, micPublished, peer: { ...s.peer, presence } }
}

/**
 * [resetKey] — новый звонок начинает темп с нуля. settled — показаны все ступени и
 * выдержана заключительная пауза на «Соединение установлено»: только теперь экран
 * можно убирать.
 */
export function usePacedConnectSignals(
  signals: ConnectSignals,
  resetKey: string | null,
): { signals: ConnectSignals; settled: boolean } {
  const flags = milestoneFlags(signals)
  const total = flags.length
  const realCount = leadingTrue(flags)
  // Заключительная пауза — тоже ступень, отсюда +1.
  const dwell = Math.max(PACING_MIN_DWELL_MS, Math.round(PACING_TARGET_TOTAL_MS / (total + 1)))
  const goal = realCount === total ? total + 1 : realCount

  const [revealed, setRevealed] = useState(0)
  const lastRevealRef = useRef(monotonicNow())
  const keyRef = useRef(resetKey)
  if (keyRef.current !== resetKey) {
    keyRef.current = resetKey
    lastRevealRef.current = monotonicNow()
  }
  useEffect(() => {
    setRevealed(0)
  }, [resetKey])

  useEffect(() => {
    if (revealed > goal) {
      setRevealed(goal)
      return
    }
    if (revealed === goal) return
    const wait = Math.max(0, lastRevealRef.current + dwell - monotonicNow())
    const timer = setTimeout(() => {
      lastRevealRef.current = monotonicNow()
      setRevealed((r) => r + 1)
    }, wait)
    return () => clearTimeout(timer)
  }, [revealed, goal, dwell])

  const shown = Math.min(revealed, goal)
  const paced = useMemo(() => applyPacing(signals, shown), [signals, shown])
  return { signals: paced, settled: shown > total }
}
