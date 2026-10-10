/**
 * Бот «Еблуша» — общие кусочки интерфейса (docs/bot-system.md):
 *   BotTag                 — метка «бот» рядом с именем;
 *   BotAskChip             — плашка «Спросить Еблушу» в поле ввода (щелчок — обычное сообщение);
 *   BotChatSettingsSection — настройка «Чат с Еблушей» (по умолчанию выключена);
 *   isCaretAtEditorStart   — каретка в самом начале contenteditable (Backspace по плашке).
 * Стили — botUi.css (подключён из Avatar.tsx, который есть на любом экране).
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { MessageCircle } from 'lucide-react'
import { systemToast } from '../../../domain/store/systemUiStore'
import { setBotChatEnabled, useSystemBotQuery } from '../../../domain/bot/useSystemBot'
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

const httpStatus = (err: unknown): number | undefined =>
  (err as { response?: { status?: number } } | null)?.response?.status

/**
 * Настройка «Чат с Еблушей» (PUT /api/bot/settings). Живёт в профиле (десктоп) и на экране
 * «Настройки» (узкий веб). Бот не заведён на сервере — раздела нет.
 */
export function BotChatSettingsSection(props: { onOpenChat?: (conversationId: string) => void }) {
  const client = useQueryClient()
  const q = useSystemBotQuery()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<boolean | null>(null)
  const info = q.data
  if (!info) return null

  const checked = pending ?? info.botChat.botChatEnabled
  const conversationId = info.botChat.conversationId

  const toggle = async (next: boolean) => {
    if (busy) return
    setBusy(true)
    setPending(next)
    try {
      const state = await setBotChatEnabled(client, next)
      systemToast.success(
        state.botChatEnabled
          ? 'Чат с Еблушей включён — он появился в списке бесед'
          : 'Чат с Еблушей выключен. История вернётся, если включить снова',
      )
    } catch (err: unknown) {
      const status = httpStatus(err)
      systemToast.error(status === 429 ? 'Слишком часто — подождите минуту' : 'Не удалось сохранить настройку')
    } finally {
      setPending(null)
      setBusy(false)
    }
  }

  return (
    <div style={{ marginBottom: 18, border: '1px solid var(--surface-border)', borderRadius: 14, background: 'var(--surface-100)', padding: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text-muted)', letterSpacing: 0.2, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="eb-bot-avatar" style={{ width: 16, height: 16, fontSize: 10 }} aria-hidden>
          <span>Б</span>
        </span>
        ЕБЛУША — БОТ МЕССЕНДЖЕРА
      </div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: busy ? 'default' : 'pointer', userSelect: 'none' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(e) => {
            void toggle(e.target.checked)
          }}
          style={{ marginTop: 3 }}
        />
        <span>
          <div style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 600 }}>Чат с Еблушей</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.45, marginTop: 3 }}>
            Личный чат с ботом: там можно писать без обращения. В остальных беседах начните сообщение
            с «Еблуша,» или ответьте на его сообщение — добавлять бота никуда не нужно. В секретных
            чатах бот не работает.
          </div>
        </span>
      </label>
      {checked && !busy && conversationId && props.onOpenChat ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => props.onOpenChat?.(conversationId)}
          style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
        >
          <MessageCircle size={15} /> Открыть чат
        </button>
      ) : null}
    </div>
  )
}
