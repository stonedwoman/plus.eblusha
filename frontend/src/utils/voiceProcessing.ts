/**
 * Обработка голоса в звонке: эхоподавление, шумоподавление, автоусиление (WebRTC, на уровне браузера).
 *
 * Ключи localStorage те же, что всегда: eb.lk.webrtc.aec / ns / agc, по умолчанию всё включено. Раньше их
 * переключали только в окне «Настройки» внутри звонка; теперь — в разделе «Звук и видео» центра настроек,
 * и звонок должен узнать об изменении сразу (CallSettings перезапускает микрофон с новыми параметрами).
 * Поэтому у хранилища есть подписка: и своя вкладка (событие), и другие вкладки (storage).
 */
import { useSyncExternalStore } from 'react'

export type VoiceKey = 'aec' | 'ns' | 'agc'

export const VOICE_KEYS: Record<VoiceKey, string> = {
  aec: 'eb.lk.webrtc.aec',
  ns: 'eb.lk.webrtc.ns',
  agc: 'eb.lk.webrtc.agc',
}

const EVENT = 'eb:voice-processing'

export function readVoiceKey(key: VoiceKey): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(VOICE_KEYS[key])
    if (raw === null) return true
    return raw === '1' || raw === 'true'
  } catch {
    return true
  }
}

/** true — записано и прочиталось обратно. */
export function writeVoiceKey(key: VoiceKey, value: boolean): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(VOICE_KEYS[key], value ? '1' : '0')
  } catch {
    return false
  }
  const ok = readVoiceKey(key) === value
  try {
    window.dispatchEvent(new Event(EVENT))
  } catch {
    // нет window.Event — нечего оповещать
  }
  return ok
}

export type VoiceState = { aec: boolean; ns: boolean; agc: boolean }

function snapshot(): string {
  return `${readVoiceKey('aec') ? 1 : 0}${readVoiceKey('ns') ? 1 : 0}${readVoiceKey('agc') ? 1 : 0}`
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function parseVoiceSnapshot(s: string): VoiceState {
  return { aec: s[0] === '1', ns: s[1] === '1', agc: s[2] === '1' }
}

/** Текущие значения; перерисовывается при изменении из любого места (центр настроек, другая вкладка). */
export function useVoiceProcessing(): VoiceState {
  const s = useSyncExternalStore(subscribe, snapshot, () => '111')
  return parseVoiceSnapshot(s)
}
