/**
 * Выбор пути соединения для звонков.
 *
 * Обычно связь сама решает, как добираться до сервера звонков: сначала пробует
 * короткий путь, а ретранслятор берёт, только если короткий не сложился. На рваных
 * каналах короткий путь бывает хуже — он молча разваливается посреди разговора, —
 * поэтому человеку нужна возможность приказать «всегда через ретранслятор».
 *
 * Настройка живёт у каждого своя, в этом браузере, и читается в момент подключения:
 * менять её посреди разговора смысла нет, применится со следующего звонка.
 */

const RELAY_ONLY_KEY = 'eb.lk.webrtc.relayOnly'

/**
 * По умолчанию ВКЛЮЧЕНО. Короткий путь к серверу выглядит выгоднее, но на деле он идёт
 * по обычному интернету и непредсказуем: у одних он рвётся посреди разговора, у других
 * голос сыплется на транзитном участке. Путь через ретранслятор длиннее, зато почти
 * целиком проходит по сети Cloudflare, до ближайшего узла которой у всех единицы или
 * десятки миллисекунд. Кому короткий путь заведомо лучше — выключают в профиле.
 */
const RELAY_ONLY_DEFAULT = true

export function isRelayOnlyEnabled(): boolean {
  if (typeof window === 'undefined') return RELAY_ONLY_DEFAULT
  try {
    const raw = window.localStorage.getItem(RELAY_ONLY_KEY)
    if (raw === null) return RELAY_ONLY_DEFAULT
    return raw === '1' || raw === 'true'
  } catch {
    return RELAY_ONLY_DEFAULT
  }
}

export function setRelayOnlyEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RELAY_ONLY_KEY, enabled ? '1' : '0')
  } catch {
    // приватный режим браузера — настройка просто не сохранится
  }
}

/**
 * Опции подключения к комнате звонка.
 *
 * [allowDirect] — аварийный откат: если через ретрансляторы подключиться не вышло
 * (оба недоступны — например, провайдер режет), звонок обязан состояться хоть как-то,
 * поэтому ограничение снимается и разрешается короткий путь.
 */
export function callConnectOptions(allowDirect = false): { rtcConfig?: RTCConfiguration } {
  if (allowDirect || !isRelayOnlyEnabled()) return {}
  return { rtcConfig: { iceTransportPolicy: 'relay' } }
}
