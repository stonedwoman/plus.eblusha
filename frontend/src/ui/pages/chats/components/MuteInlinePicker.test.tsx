import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MuteInlinePicker } from './MuteInlinePicker'

// Встроенный выбор срока на телефонной ширине: те же пункты, что у листа Android и диалога iOS (контракт §7),
// в том числе «Отмена».
describe('MuteInlinePicker', () => {
  const html = renderToStaticMarkup(<MuteInlinePicker onBack={() => {}} onChoose={() => {}} onCancel={() => {}} />)
  const texts = Array.from(html.matchAll(/data-testid="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)</g)).map((m) => [m[1], m[2]])

  it('заголовок, пять сроков по порядку и «Отмена» последней', () => {
    expect(texts).toEqual([
      ['mute-picker-back', 'Без звука на…'],
      ['mute-preset-1h', '1 час'],
      ['mute-preset-8h', '8 часов'],
      ['mute-preset-1d', '1 день'],
      ['mute-preset-1w', '1 неделю'],
      ['mute-preset-forever', 'Навсегда'],
      ['mute-picker-cancel', 'Отмена'],
    ])
  })
})
