/**
 * Бот «Еблуша» — общие кусочки интерфейса (docs/bot-system.md):
 *   BotTag                 — метка «бот» рядом с именем;
 *   BotAskChip             — плашка «Спросить Еблушу» в поле ввода (щелчок — обычное сообщение);
 *   (настройка «Чат с Еблушей» теперь строка раздела «Профиль» центра настроек — ui/settings, useBotChatSetting);
 *   isCaretAtEditorStart   — каретка в самом начале contenteditable (Backspace по плашке).
 * Стили — botUi.css (подключён из Avatar.tsx, который есть на любом экране).
 */
import './botUi.css'

export function BotTag({ title }: { title?: string }) {
  return (
    <span className="eb-bot-tag" title={title ?? 'Бот мессенджера — не участник беседы'}>
      бот
    </span>
  )
}

export function BotAskChip(props: { name?: string; onDismiss: () => void }) {
  const name = props.name || 'Еблуша'
  return (
    <button
      type="button"
      className="eb-bot-ask-chip"
      // Фокус остаётся в поле ввода: иначе Enter после щелчка ушёл бы в кнопку.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        props.onDismiss()
      }}
      title="Вопрос боту. Щелчок или Backspace в начале поля — отправить обычным сообщением"
      aria-label="Спросить Еблушу. Нажмите, чтобы отправить обычным сообщением"
    >
      <span className="eb-bot-avatar" aria-hidden>
        <span>Б</span>
      </span>
      <span className="eb-bot-ask-chip__label">{name}</span>
    </button>
  )
}

/** Каретка стоит в самом начале поля и ничего не выделено. */
export function isCaretAtEditorStart(el: HTMLElement | null): boolean {
  if (!el) return false
  try {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
    const r = sel.getRangeAt(0)
    if (!el.contains(r.startContainer)) return false
    const before = document.createRange()
    before.selectNodeContents(el)
    before.setEnd(r.startContainer, r.startOffset)
    return before.toString().length === 0
  } catch {
    return false
  }
}
