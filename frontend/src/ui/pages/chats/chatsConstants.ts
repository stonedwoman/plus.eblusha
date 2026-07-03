/** Общие числовые/строковые константы страницы чатов (без привязки к состоянию). */

/** Ключ localStorage: id последней открытой беседы (восстановление при входе). */
export const LAST_ACTIVE_CONVERSATION_KEY = 'eblusha:last-active-conversation'
/** Мин. «длительность» исходящего звонка, ниже которой он считается несостоявшимся. */
export const MIN_OUTGOING_CALL_DURATION_MS = 30_000
/** Максимум изображений, прикрепляемых за один раз. */
export const MAX_PENDING_IMAGES = 10
/** Максимум файлов, прикрепляемых за один раз. */
export const MAX_PENDING_FILES = 10
/** Размер страницы при подгрузке истории сообщений. */
export const MESSAGES_PAGE_SIZE = 80
/** Пустое значение для 4-значного EBLID-ввода. */
export const EMPTY_EBLID_DIGITS = ['', '', '', '']
