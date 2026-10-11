/**
 * Движение «Центра управления» (SPEC §3.12): плитка раскрывается в раздел призраком — прямоугольник растёт из
 * плитки на всё тело, радиус 16→0, обзор гаснет и сжимается до .985 (340 мс, кривая snap); обратный ход к плитке —
 * 280 мс. Web Animations API, без библиотек. «Меньше движения» (prefers-reduced-motion) — без призрака.
 */

export const SNAP = 'cubic-bezier(.2,.8,.2,1)'
export const FOLD = 'cubic-bezier(.4,0,.2,1)'
export const EXPAND_MS = 340
export const COLLAPSE_MS = 280

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function makeGhost(body: HTMLElement, tile: HTMLElement): { ghost: HTMLElement; tr: DOMRect; br: DOMRect } {
  const br = body.getBoundingClientRect()
  const tr = tile.getBoundingClientRect()
  const ghost = document.createElement('div')
  ghost.className = 'ebs-ghost'
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, {
    left: `${tr.left - br.left}px`,
    top: `${tr.top - br.top}px`,
    width: `${tr.width}px`,
    height: `${tr.height}px`,
  })
  // копия головы плитки: квадрат-значок и имя
  const head = tile.querySelector('.ebs-tile__head')
  if (head) {
    const copy = head.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.ebs-bang, .ebs-adot, .ebs-tile__exp, .ebs-count, .ebs-cap').forEach((n) => n.remove())
    copy.style.padding = '16px 18px'
    ghost.appendChild(copy)
  }
  body.appendChild(ghost)
  return { ghost, tr, br }
}

/** Плитка → раздел. Промис выполняется, когда призрак дорос до всего тела. */
export function expandFromTile(body: HTMLElement, tile: HTMLElement, overview: HTMLElement | null): Promise<void> {
  return new Promise((resolve) => {
    if (prefersReducedMotion() || typeof body.animate !== 'function') {
      resolve()
      return
    }
    const { ghost, tr, br } = makeGhost(body, tile)
    const from = { left: ghost.style.left, top: ghost.style.top, width: ghost.style.width, height: ghost.style.height }
    overview?.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.985)' }], { duration: 320, easing: SNAP, fill: 'forwards' })
    const a = ghost.animate(
      [
        { ...from, borderRadius: '16px', background: '#2b303a' },
        { left: '0px', top: '0px', width: `${br.width}px`, height: `${br.height}px`, borderRadius: '0px', background: '#1b1f27' },
      ],
      { duration: EXPAND_MS, easing: SNAP, fill: 'forwards' },
    )
    void tr
    const done = () => {
      ghost.remove()
      resolve()
    }
    a.onfinish = done
    a.oncancel = done
  })
}

/** Раздел → плитка. Вызывается, когда обзор уже на экране: призрак сжимается из всего тела в плитку, обзор проявляется. */
export function collapseToTile(body: HTMLElement, tile: HTMLElement, overview: HTMLElement | null): Promise<void> {
  return new Promise((resolve) => {
    if (prefersReducedMotion() || typeof body.animate !== 'function') {
      resolve()
      return
    }
    const { ghost, tr, br } = makeGhost(body, tile)
    const to = { left: ghost.style.left, top: ghost.style.top, width: ghost.style.width, height: ghost.style.height }
    ghost.style.left = '0px'
    ghost.style.top = '0px'
    ghost.style.width = `${br.width}px`
    ghost.style.height = `${br.height}px`
    overview?.animate([{ opacity: 0, transform: 'scale(.985)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 220, easing: FOLD })
    void tr
    const a = ghost.animate(
      [
        { left: '0px', top: '0px', width: `${br.width}px`, height: `${br.height}px`, borderRadius: '0px', background: '#1b1f27', opacity: 1 },
        { ...to, borderRadius: '16px', background: '#2b303a', opacity: 0 },
      ],
      { duration: COLLAPSE_MS, easing: FOLD, fill: 'forwards' },
    )
    const done = () => {
      ghost.remove()
      resolve()
    }
    a.onfinish = done
    a.oncancel = done
  })
}
