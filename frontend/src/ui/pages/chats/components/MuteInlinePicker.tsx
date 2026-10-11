/**
 * Встроенный выбор срока «Без звука» (телефонная ширина и тач-экраны, где подменю по наведению не работает) —
 * часть MuteMenuSection (ConversationMuteUi.tsx), вынесена без зависимостей от сети и сокета, чтобы её можно было
 * проверить отдельно. Как лист на Android и диалог на iOS (docs/conversation-mute.md §7): заголовок «Без звука на…»
 * (он же «назад» к меню), пять сроков и «Отмена» — закрыть меню, ничего не меняя.
 */
import { ArrowLeft } from 'lucide-react'
import { MUTE_PRESET_OPTIONS, MUTE_TEXT, type MutePreset } from '../../../../domain/mute/muteRules'

const MUTED_COLOR = 'var(--text-muted)'
const itemStyle = { display: 'flex', alignItems: 'center', gap: 8 } as const

export function MuteInlinePicker(props: {
  /** «← Без звука на…» — вернуться к пунктам меню. */
  onBack: () => void
  onChoose: (preset: MutePreset) => void
  /** «Отмена» — закрыть всё меню. */
  onCancel: () => void
}) {
  const { onBack, onChoose, onCancel } = props
  return (
    <>
      <button type="button" data-testid="mute-picker-back" onClick={onBack} style={{ ...itemStyle, color: MUTED_COLOR, fontWeight: 600 }}>
        <ArrowLeft size={16} />
        {MUTE_TEXT.pickTitle}
      </button>
      {MUTE_PRESET_OPTIONS.map((o) => (
        <button key={o.preset} type="button" data-testid={`mute-preset-${o.preset}`} onClick={() => onChoose(o.preset)} style={{ ...itemStyle, paddingLeft: 34 }}>
          {o.label}
        </button>
      ))}
      <button type="button" data-testid="mute-picker-cancel" onClick={onCancel} style={{ ...itemStyle, paddingLeft: 34, color: MUTED_COLOR }}>
        {MUTE_TEXT.cancel}
      </button>
    </>
  )
}
