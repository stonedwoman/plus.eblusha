/**
 * Когда веб/Electron сам ставит «прочитано» (облачные квитанции READ, mark-conversation-read, сигнал секретки).
 *
 * Любое «прочитано» гасит уведомления беседы на ВСЕХ устройствах человека (read-sync: сокет read-self, FCM и APNs),
 * поэтому — только пока беседу правда видят:
 *  - вкладка/окно видно и в фокусе;
 *  - на узком экране открыта сама беседа, а не список поверх неё;
 *  - человек у экрана: ввод (мышь, клавиатура, колесо, касание) был меньше READ_IDLE_LIMIT_MS назад — иначе окно,
 *    оставленное «на виду» ушедшим от компьютера человеком, гасило бы уведомление на телефоне в его кармане;
 *  - беседу не закрывает развёрнутый звонок (оверлей звонка или дозвона 1:1; свёрнутая миниатюра не мешает).
 * Не сошлось — «прочитано» уходит, когда сойдётся (вернулся ввод, свернули звонок, фокус, вернулись из списка).
 * То же правило у натива ПК (ReadSyncRules.CanReadNow), iOS (ChatReadGate) и Android (экран RESUMED, звонок свёрнут).
 */

export const READ_IDLE_LIMIT_MS = 60_000

export type ReadGateState = {
  visible: boolean
  focused: boolean
  /** Беседа на экране (узкий экран: mobileView === 'conversation'). */
  onScreen: boolean
  /** Развёрнутый оверлей звонка/дозвона закрывает беседу. */
  callCovers: boolean
  /** Сколько мс прошло с последнего ввода. */
  idleMs: number
}

export function canReadNow(s: ReadGateState): boolean {
  return s.visible && s.focused && s.onScreen && !s.callCovers && s.idleMs < READ_IDLE_LIMIT_MS
}

/**
 * Закрывает ли беседу оверлей звонка (то же условие, по которому CallOverlayHost рисует развёрнутый CallOverlay):
 * идёт звонок и он не свёрнут в миниатюру, или идёт дозвон 1:1 (у групп дозвона в оверлее нет).
 */
export function callOverlayCoversChat(opts: {
  callConvId: string | null | undefined
  minimizedCallConvId: string | null | undefined
  outgoingConversationId: string | null | undefined
  outgoingIsGroup: boolean
}): boolean {
  if (opts.callConvId) return opts.minimizedCallConvId !== opts.callConvId
  if (!opts.outgoingConversationId) return false
  return !opts.outgoingIsGroup
}

/** События, которые считаются «человек у экрана». */
export const READ_PRESENCE_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

/**
 * Следит за вводом: lastInputAt() — момент последнего ввода; onReturn — человек вернулся после простоя
 * (READ_IDLE_LIMIT_MS и дольше без ввода): пора дочитать то, что пришло без него.
 */
export function createInputPresence(opts: {
  onReturn: () => void
  now?: () => number
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}) {
  const now = opts.now ?? (() => Date.now())
  let last = now()
  const onInput = () => {
    const t = now()
    const wasIdle = t - last >= READ_IDLE_LIMIT_MS
    last = t
    if (wasIdle) {
      try {
        opts.onReturn()
      } catch {
        /* ignore */
      }
    }
  }
  const target = opts.target ?? (typeof window !== 'undefined' ? window : null)
  const listenerOpts: AddEventListenerOptions = { passive: true, capture: true }
  if (target) for (const ev of READ_PRESENCE_EVENTS) target.addEventListener(ev, onInput, listenerOpts)
  return {
    lastInputAt: () => last,
    idleMs: () => now() - last,
    /** Для тестов: как будто пришёл ввод. */
    _input: onInput,
    dispose(): void {
      if (target) for (const ev of READ_PRESENCE_EVENTS) target.removeEventListener(ev, onInput, listenerOpts)
    },
  }
}
