function hashStringToUint(s: string | null | undefined): number {
  if (!s) return 0
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export function hashToGray(_userId: string | null | undefined) {
  return '#191d23'
}

/** Стабильный пастельный цвет имени, как в Telegram-группах */
export function nameColorForUser(userId: string | null | undefined): string {
  const palette = [
    '#b39ddb',
    '#a5d6a7',
    '#90caf9',
    '#ffcc80',
    '#f48fb1',
    '#80cbc4',
    '#ce93d8',
    '#ffab91',
    '#9fa8da',
    '#aed581',
    '#ffecb3',
    '#ef9a9a',
    '#81d4fa',
  ]
  return palette[hashStringToUint(userId) % palette.length]
}

/**
 * Фон входящих/пересланных по участнику: намеренно разные hue при тёмной яркости,
 * чтобы отличать авторов; часть тонов тёплая (умбра / медь) в духе бренда Eblusha.
 */
export function groupIncomingBubbleBg(userId: string | null | undefined): string {
  const bases = [
    '#2a1f16',
    '#1a2836',
    '#152820',
    '#281a2c',
    '#162a2e',
    '#2d2418',
    '#1f2440',
    '#223016',
    '#301c22',
    '#14222c',
    '#2f2218',
    '#241c30',
  ]
  return bases[hashStringToUint(userId) % bases.length]
}
