/**
 * Режимы раскладки «Центра управления» (SPEC §2.1) и сетка плиток на телефоне (§2.3).
 * Чистые функции — тесты в settingsLayout.test.ts.
 */
import { useEffect, useState } from 'react'
import type { SettingsSectionId } from './settingsNav'

export type SettingsMode = 'wide' | 'cmp' | 'phone'

/** Тот же порог, что isMobile в useChatsResponsive.ts — не дублируем число, а держим рядом. */
export const PHONE_MAX_WIDTH = 768

/** Панель на вебе: min(1240, W − 48) × min(760, H − 48). */
export function panelSize(W: number, H: number): { w: number; h: number } {
  return { w: Math.min(1240, W - 48), h: Math.min(760, H - 48) }
}

export function computeMode(W: number, H: number): SettingsMode {
  if (W <= PHONE_MAX_WIDTH) return 'phone'
  const { w, h } = panelSize(W, H)
  if (w < 880 || h < 560) return 'phone'
  if (w < 1060 || h < 640) return 'cmp'
  return 'wide'
}

export function useSettingsMode(): SettingsMode {
  const read = (): SettingsMode => (typeof window === 'undefined' ? 'wide' : computeMode(window.innerWidth, window.innerHeight))
  const [mode, setMode] = useState<SettingsMode>(read)
  useEffect(() => {
    const on = () => setMode(read())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return mode
}

/**
 * Какие плитки на телефоне идут во всю ширину. «Профиль» (и «Обновления», если бы были) — всегда;
 * остальные парами в порядке разделов; если их нечётное число — последняя тоже во всю ширину.
 */
export function phoneSpans(ids: readonly SettingsSectionId[]): Record<string, 1 | 2> {
  const out: Record<string, 1 | 2> = {}
  const rest = ids.filter((id) => {
    if (id === 'profile') {
      out[id] = 2
      return false
    }
    return true
  })
  rest.forEach((id, i) => {
    out[id] = rest.length % 2 === 1 && i === rest.length - 1 ? 2 : 1
  })
  return out
}

/** Сколько строк выдачи поиска помещается в плитку (SPEC §3.9): «Профиль» — 6, широкие 3, компакт 2. */
export function resultsPerTile(id: SettingsSectionId, mode: SettingsMode): number {
  if (mode === 'phone') return 99
  if (id === 'profile') return 6
  return mode === 'cmp' ? 2 : 3
}

/** Порядок плиток в сетке 4×2 — для стрелок между плитками (центры в строках/колонках). */
export const OVERVIEW_GRID_AREAS: readonly (readonly SettingsSectionId[])[] = [
  ['profile', 'conn', 'av', 'av'],
  ['profile', 'security', 'security', 'app'],
]

/**
 * Ближайшая плитка в направлении стрелки (SPEC/REF §11): по центрам, поперечное смещение ×2;
 * при равенстве — верхняя, потом левая. rects — центры плиток {id, cx, cy}.
 */
export function nearestTile(
  fromId: string,
  dir: 'left' | 'right' | 'up' | 'down',
  rects: ReadonlyArray<{ id: string; cx: number; cy: number }>,
): string | null {
  const from = rects.find((r) => r.id === fromId)
  if (!from) return null
  let best: { id: string; score: number; cy: number; cx: number } | null = null
  for (const r of rects) {
    if (r.id === fromId) continue
    const dx = r.cx - from.cx
    const dy = r.cy - from.cy
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy
    if (along <= 1) continue
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
    const score = along + across * 2
    if (
      !best ||
      score < best.score - 0.5 ||
      (Math.abs(score - best.score) <= 0.5 && (r.cy < best.cy - 0.5 || (Math.abs(r.cy - best.cy) <= 0.5 && r.cx < best.cx)))
    ) {
      best = { id: r.id, score, cy: r.cy, cx: r.cx }
    }
  }
  return best ? best.id : null
}
