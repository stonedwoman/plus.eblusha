/**
 * Кнопки под сообщением бота (docs/bot-system.md §2): «Да» / «Нет» под вопросом-подтверждением,
 * «Уточнить» и «Подумай лучше» под последней частью ответа.
 *
 * «Подумай лучше» СРАЗУ отправляет ответ (reply) на первую часть ответа бота текстом
 * «Еблуша, подумай лучше» (в «Чате с Еблушей» — «Подумай лучше») — без нового API: бот сам
 * распознаёт просьбу и отвечает заново самой мощной моделью (metadata.bot.depth = "deep"; под таким
 * ответом кнопки нет). Где показывать — botThinkBetterTarget (domain/bot/systemBot.ts).
 */
import { Brain, Reply } from 'lucide-react'
import './botCards.css'

export function BotAnswerActions(props: {
  confirm?: { busy: boolean; onAnswer: (answer: 'да' | 'нет') => void } | null
  clarify?: (() => void) | null
  think?: { busy: boolean; onThink: () => void } | null
}) {
  const { confirm, clarify, think } = props
  if (!confirm && !clarify && !think) return null
  return (
    <div className="eb-bot-actions">
      {confirm ? (
        <>
          <button
            type="button"
            className="eb-bot-action eb-bot-action--yes"
            disabled={confirm.busy}
            onClick={(e) => {
              e.stopPropagation()
              confirm.onAnswer('да')
            }}
          >
            Да
          </button>
          <button
            type="button"
            className="eb-bot-action"
            disabled={confirm.busy}
            onClick={(e) => {
              e.stopPropagation()
              confirm.onAnswer('нет')
            }}
          >
            Нет
          </button>
        </>
      ) : null}
      {clarify ? (
        <button
          type="button"
          className="eb-bot-action"
          title="Задать Еблуше уточняющий вопрос — ответом на его сообщение"
          onClick={(e) => {
            e.stopPropagation()
            clarify()
          }}
        >
          <Reply size={13} strokeWidth={2.4} /> Уточнить
        </button>
      ) : null}
      {think ? (
        <button
          type="button"
          className="eb-bot-action eb-bot-action--think"
          title="Еблуша ответит заново — подумает дольше и как следует"
          aria-label="Подумай лучше: Еблуша ответит заново, подумав как следует"
          aria-busy={think.busy}
          disabled={think.busy}
          onClick={(e) => {
            e.stopPropagation()
            think.onThink()
          }}
        >
          {think.busy ? <span className="eb-card-spin" aria-hidden /> : <Brain size={13} strokeWidth={2.4} aria-hidden />} Подумай лучше
        </button>
      ) : null}
    </div>
  )
}
