import QRCode from 'qrcode'

type QrEbLogoOpts = {
  margin?: number
  sizePx?: number
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/**
 * Generate a QR dataURL with a centered "ЕБ" mark (brand-colored).
 * Uses error correction level H so overlay doesn't break scanning.
 */
export async function qrDataUrlWithEbLogo(payload: string, opts?: QrEbLogoOpts): Promise<string> {
  const sizePx = typeof opts?.sizePx === 'number' && opts.sizePx > 64 ? Math.floor(opts.sizePx) : 320
  const margin = typeof opts?.margin === 'number' ? Math.max(0, Math.floor(opts.margin)) : 1

  const canvas = document.createElement('canvas')
  await QRCode.toCanvas(canvas, payload, {
    margin,
    width: sizePx,
    errorCorrectionLevel: 'H',
    color: { dark: '#0b0d12', light: '#ffffff' },
  })

  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return canvas.toDataURL()

  // Center badge
  const W = canvas.width
  const H = canvas.height
  const badgeSize = Math.round(Math.min(W, H) * 0.26)
  const bx = Math.round((W - badgeSize) / 2)
  const by = Math.round((H - badgeSize) / 2)
  const br = Math.round(badgeSize * 0.28)

  // A subtle "quiet zone" behind the badge.
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  drawRoundedRect(ctx, bx, by, badgeSize, badgeSize, br)
  ctx.fillStyle = 'rgba(255,255,255,0.98)'
  ctx.fill()

  // Border (matches app surface border vibes)
  ctx.lineWidth = Math.max(2, Math.round(badgeSize * 0.04))
  ctx.strokeStyle = 'rgba(15,17,23,0.20)'
  ctx.stroke()

  // Letters
  const fontSize = Math.round(badgeSize * 0.54)
  ctx.font = `900 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`
  ctx.textBaseline = 'middle'
  // "Е" and "Б" with a clear *edge-to-edge* gap (12–16px)
  const cx = bx + badgeSize / 2
  const cy = by + badgeSize / 2 + Math.round(badgeSize * 0.02)
  // Keep a subtle, readable gap between glyph edges.
  const gapPx = 0
  ctx.fillStyle = '#0f1117'
  ctx.textAlign = 'right'
  ctx.fillText('Е', cx - gapPx / 2, cy)
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--brand')?.trim() || '#f59e0b'
  ctx.textAlign = 'left'
  ctx.fillText('Б', cx + gapPx / 2, cy)
  ctx.restore()

  return canvas.toDataURL()
}

