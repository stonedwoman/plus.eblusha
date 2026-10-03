/**
 * Шифрование звонка: когда оно обязательно и как его честно подписывать (ТЗ E2EE звонков,
 * этап 0: §6.7, §8.4).
 *
 * Сегодня ключ звонка один на один выдаёт сервер Еблуши (GET /calls/:id/e2ee-key). Голос и видео
 * зашифрованы, но ключ есть у сервера — это НЕ сквозное шифрование, и слова «сквозное» в звонках
 * нет, пока ключи не договаривают сами устройства (Еблуша 2.0). Групповые звонки пока не
 * шифрует ни один клиент — так и подписываем. Тексты одинаковые на всех платформах.
 *
 * Без React: модель экрана подключения и стенды берут подписи отсюда, тесты гоняют это в node.
 */

/** server-key — 1:1 на ключе от сервера; none — без шифрования (группы до 2.0). */
export type CallSecurity = 'server-key' | 'none'

/**
 * Звонок один на один шифруется ВСЕГДА: ни флага сборки, ни отката в открытую комнату. Нет
 * ключа — звонок не начинается. Без шифрования идут только групповые звонки (до 2.0).
 */
export function callRequiresE2ee(isGroup: boolean): boolean {
  return !isGroup
}

/** Режим уже идущего звонка. 1:1 до подтверждения шифрования подписывать нечем — null. */
export function callSecurityOf(isGroup: boolean, encryptionConfirmed: boolean): CallSecurity | null {
  if (!callRequiresE2ee(isGroup)) return 'none'
  return encryptionConfirmed ? 'server-key' : null
}

/** Короткая подпись: капсула на экране подключения, плашка звонка, подсказка у значка. */
export const CALL_SECURITY_LABEL: Record<CallSecurity, string> = {
  'server-key': 'Шифрование через сервер',
  none: 'Без шифрования',
}

/** Пояснение по наведению / в подробностях. */
export const CALL_SECURITY_DETAIL: Record<CallSecurity, string> = {
  'server-key':
    'Голос и видео зашифрованы, но ключ разговора выдаёт сервер Еблуши, поэтому сквозным это шифрование не является.',
  none: 'Групповые звонки пока идут без шифрования. Шифрование групп появится в следующей большой версии Еблуши.',
}

/** Сбой включения шифрования до начала разговора: заголовок экрана ошибки. */
export const E2EE_SETUP_FAILED_TITLE = 'Не удалось включить шифрование'

/**
 * Шифрование не включилось ДО начала разговора (нет ключа от сервера, сеть, неверная длина,
 * браузер без E2EE). Звонок 1:1 без шифрования не идёт: открытой комнаты нет, микрофон не
 * публикуется. retry — есть смысл нажать «Повторить».
 */
export function describeE2eeSetupError(err: unknown): { text: string; retry: boolean } {
  const lead = 'Звонок не начат: без шифрования разговор один на один не идёт.'
  const anyErr = err as { response?: { status?: unknown }; isAxiosError?: unknown; request?: unknown } | null | undefined
  const status = typeof anyErr?.response?.status === 'number' ? anyErr.response.status : undefined
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const lower = msg.toLowerCase()
  if (
    lower.includes('unsupported') ||
    lower.includes('not supported') ||
    lower.includes('deviceunsupported') ||
    lower.includes('secure context')
  ) {
    return {
      text: `${lead} Этот браузер не умеет шифровать звонки — откройте Еблушу в другом браузере или в приложении.`,
      retry: false,
    }
  }
  if (status === 403) return { text: `${lead} Сервер не дал ключ шифрования для этой беседы.`, retry: false }
  if (status !== undefined) return { text: `${lead} Сервер не выдал ключ шифрования (ошибка ${status}).`, retry: true }
  if (anyErr?.isAxiosError || anyErr?.request) {
    return { text: `${lead} Нет связи с сервером — ключ шифрования не получен.`, retry: true }
  }
  if (lower.includes('timeout')) return { text: `${lead} Шифрование не подтвердилось вовремя.`, retry: true }
  return { text: `${lead} Ключ шифрования не получен или повреждён.`, retry: true }
}
