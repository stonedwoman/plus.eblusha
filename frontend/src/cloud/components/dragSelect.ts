import { useEffect, useRef } from 'react'

/**
 * Выделение протяжкой: зажал и провёл — отметились все плитки по пути.
 *
 * Разбирать поездку в несколько сотен кадров, тыкая в каждую галочку, невозможно.
 * Поведение как в фотоальбомах: направление задаёт ПЕРВАЯ плитка. Начали с
 * неотмеченной — красим в «выбрано», начали с отмеченной — снимаем. Так одним
 * движением и добавляют, и убирают, не переключая никаких режимов.
 *
 * Мышь и палец различаются намеренно:
 *  - мышью протяжка начинается сразу: тянуть мышью нечего, прокрутка от этого
 *    не страдает;
 *  - пальцем сначала долгое нажатие. Иначе выделение отняло бы у пальца
 *    прокрутку — а в режиме выделения плитки занимают почти весь экран, и
 *    листать альбом стало бы нечем.
 *
 * Состояние плитки читаем из DOM (data-selected), а не из React: хук тогда не
 * зависит от того, где живёт множество выделенного, и одинаково работает в
 * хуяпке, в «Файлах» и в сквозных лентах.
 */
export type PaintMode = 'add' | 'remove'

/** Насколько близко к краю нужно подвести курсор, чтобы список поехал сам. */
const EDGE_PX = 96
/** Долгое нажатие пальцем, после которого начинается выделение. */
const LONG_PRESS_MS = 340
/** Сдвиг, после которого нажатие считается протяжкой, а не кликом. */
const DRAG_SLOP_PX = 6

export function useDragSelect({
  enabled,
  onPaint,
}: {
  /** Выделение уже включено: иначе протяжка мешала бы обычному просмотру. */
  enabled: boolean
  onPaint: (id: string, mode: PaintMode) => void
}): void {
  const onPaintRef = useRef(onPaint)
  onPaintRef.current = onPaint
  /*
   * enabled держим в ref, а НЕ в зависимостях эффекта.
   *
   * Первая же покрашенная плитка включает режим выделения, enabled меняется —
   * и эффект с ним в зависимостях пересоздавался прямо посреди жеста: старые
   * слушатели снимались, протяжка умирала на первой плитке. Ловилось только
   * замером: мышь проезжала пять плиток, отмечалась одна.
   */
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.cl-root')
    if (!root) return

    let mode: PaintMode | null = null
    let painting = false
    let pending = false
    let activePointer = -1
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastY = 0
    let longPress: ReturnType<typeof setTimeout> | null = null
    let raf = 0
    /** Была ли протяжка: по ней глушим завершающий click, чтобы не открыть кадр. */
    let dragged = false

    const tileAt = (x: number, y: number): HTMLElement | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      return el?.closest<HTMLElement>('[data-file-id]') ?? null
    }

    const paintAt = (x: number, y: number) => {
      if (!mode) return
      const id = tileAt(x, y)?.dataset.fileId
      if (id) onPaintRef.current(id, mode)
    }

    const stopAutoScroll = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    /*
     * У края списка он едет сам — иначе выделить больше экрана нельзя: другой
     * рукой прокручивать некому, а отпустить палец значит закончить протяжку.
     * Скорость растёт по мере приближения к краю.
     */
    const autoScroll = () => {
      raf = 0
      if (!painting) return
      const box = root.getBoundingClientRect()
      const fromTop = lastY - box.top
      const fromBottom = box.bottom - lastY
      let dy = 0
      if (fromTop < EDGE_PX) dy = -Math.ceil((EDGE_PX - Math.max(0, fromTop)) / 4)
      else if (fromBottom < EDGE_PX) dy = Math.ceil((EDGE_PX - Math.max(0, fromBottom)) / 4)
      if (dy !== 0) {
        const before = root.scrollTop
        root.scrollTop += dy
        // Сдвинулись — под курсором уже другая плитка, её тоже красим.
        if (root.scrollTop !== before) paintAt(lastX, lastY)
      }
      raf = requestAnimationFrame(autoScroll)
    }

    const begin = (x: number, y: number) => {
      const tile = tileAt(x, y)
      if (!tile?.dataset.fileId) return false
      // Направление задаёт первая плитка: с неотмеченной красим, с отмеченной снимаем.
      mode = tile.dataset.selected === '1' ? 'remove' : 'add'
      painting = true
      dragged = true
      document.body.classList.add('cl-dragging-select')
      onPaintRef.current(tile.dataset.fileId, mode)
      raf = requestAnimationFrame(autoScroll)
      return true
    }

    const finish = () => {
      stopAutoScroll()
      if (longPress) clearTimeout(longPress)
      longPress = null
      painting = false
      pending = false
      mode = null
      activePointer = -1
      document.body.classList.remove('cl-dragging-select')
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      if (activePointer !== -1) return
      const tile = tileAt(e.clientX, e.clientY)
      if (!tile) return
      /*
       * Кому позволено начинать.
       *
       * Мышь — только в режиме выделения либо с самой галочки: иначе протяжка
       * отняла бы обычный клик по кадру. Палец — всегда, потому что долгое
       * нажатие и есть общепринятый способ ВОЙТИ в режим выделения на телефоне;
       * галочка там слишком мелкая, чтобы делать её единственной дверью.
       */
      const fromCheckbox = Boolean((e.target as HTMLElement | null)?.closest?.('.cl-tile-check'))
      if (e.pointerType === 'mouse' && !enabledRef.current && !fromCheckbox) return

      activePointer = e.pointerId
      startX = lastX = e.clientX
      startY = lastY = e.clientY
      dragged = false

      if (e.pointerType === 'mouse') {
        pending = true
        return
      }
      // Палец: ждём долгое нажатие, иначе отняли бы у него прокрутку.
      pending = false
      longPress = setTimeout(() => {
        longPress = null
        if (activePointer === e.pointerId) begin(lastX, lastY)
      }, LONG_PRESS_MS)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointer) return
      lastX = e.clientX
      lastY = e.clientY

      if (painting) {
        paintAt(lastX, lastY)
        return
      }
      const far = Math.abs(lastX - startX) + Math.abs(lastY - startY) > DRAG_SLOP_PX
      if (!far) return
      if (pending) {
        pending = false
        // Мышь: сдвинулись — это протяжка, а не клик по плитке.
        if (!begin(startX, startY)) finish()
        else paintAt(lastX, lastY)
        return
      }
      // Палец поехал раньше долгого нажатия — человек листает, не выделяет.
      if (longPress) {
        clearTimeout(longPress)
        longPress = null
        activePointer = -1
      }
    }

    /*
     * Прокрутку пальцем гасим только когда выделение УЖЕ началось: до долгого
     * нажатия жест ещё может оказаться обычным листанием. Слушатель
     * непассивный — иначе preventDefault() не имеет силы.
     */
    const onTouchMove = (e: TouchEvent) => {
      if (painting) e.preventDefault()
    }

    // Долгое нажатие по картинке иначе поднимает системное меню «сохранить
    // изображение» прямо поверх начатого выделения.
    const onContextMenu = (e: Event) => {
      if (painting) e.preventDefault()
    }

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointer) return
      finish()
    }

    // Клик после протяжки не должен ни открыть кадр, ни перещёлкнуть плитку:
    // ту, что под курсором, мы уже покрасили.
    const onClickCapture = (e: MouseEvent) => {
      if (!dragged) return
      dragged = false
      e.preventDefault()
      e.stopPropagation()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    document.addEventListener('click', onClickCapture, true)
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('contextmenu', onContextMenu)
    return () => {
      finish()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerUp, true)
      document.removeEventListener('click', onClickCapture, true)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('contextmenu', onContextMenu)
    }
  }, [])
}
