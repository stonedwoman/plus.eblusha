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
    let activePointer = -1
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastY = 0
    let longPress: ReturnType<typeof setTimeout> | null = null
    let raf = 0
    /** Была ли протяжка: по ней глушим завершающий click, чтобы не открыть кадр. */
    let dragged = false

    /*
     * Рамка выделения — как на рабочем столе: тянешь, и всё, что попало в
     * прямоугольник, отмечается. Прямоугольник считаем в координатах
     * ДОКУМЕНТА, а не окна: иначе автопрокрутка у края съезжала бы
     * относительно уже отмеченного.
     *
     * Рамка НАКАПЛИВАЕТ: каждая новая добавляется к тому, что уже отмечено.
     * Разбирают альбом по кускам — сначала один ряд, потом другой, — и
     * сбрасывать предыдущее на каждой протяжке значит заставлять держать всё
     * в одном движении. Чтобы внутри ОДНОЙ протяжки рамку можно было сжать
     * обратно, запоминаем состояние каждой плитки на момент начала (was):
     * вышла из прямоугольника — возвращается к нему, а не гаснет.
     */
    let marquee: { x0: number; y0: number } | null = null
    let box: HTMLElement | null = null
    // on — последнее применённое состояние: по нему гасим лишние вызовы.
    let cache: { id: string; l: number; t: number; r: number; b: number; was: boolean; on: boolean | null }[] = []

    const TILES = '[data-file-id]'

    const buildCache = () => {
      const rootBox = root.getBoundingClientRect()
      // Состояние «было отмечено до протяжки» переносим по id: пересборка не
      // должна забыть, что человек уже отметил.
      const prevWas = new Map(cache.map((c) => [c.id, c.was]))
      cache = []
      for (const el of root.querySelectorAll<HTMLElement>(TILES)) {
        const r = el.getBoundingClientRect()
        const id = el.dataset.fileId
        if (!id) continue
        cache.push({
          id,
          l: r.left,
          t: r.top - rootBox.top + root.scrollTop,
          r: r.right,
          b: r.bottom - rootBox.top + root.scrollTop,
          was: prevWas.get(id) ?? el.dataset.selected === '1',
          on: null,
        })
      }
    }

    /*
     * Во время протяжки список живёт своей жизнью: автопрокрутка у края доводит
     * до часового пагинации и приезжает следующая страница; realtime вставляет
     * свежий снимок ПО ВРЕМЕНИ СЪЁМКИ, сдвигая всё ниже точки вставки. Без
     * пересборки рамка визуально накрывала новые ряды, а выделялись старые.
     *
     * Следим наблюдателем за разметкой, а не считаем узлы: вставка и удаление
     * в одном такте оставляют количество прежним, а координаты уже уехали.
     * Пересборку откладываем на кадр — миниатюры доезжают пачками, и на каждую
     * подмену <img> обмерять всю ленту незачем.
     */
    let mo: MutationObserver | null = null
    let rebuildRaf = 0
    const scheduleRebuild = () => {
      if (rebuildRaf || !marquee) return
      rebuildRaf = requestAnimationFrame(() => {
        rebuildRaf = 0
        if (!marquee) return
        buildCache()
        // Переприменяем СРАЗУ: если палец стоит и прокрутка уже упёрлась в низ,
        // следующего движения может не быть вовсе, и новые плитки так и
        // остались бы невыделенными под нарисованным прямоугольником.
        drawMarquee(lastX, lastY)
        applyMarquee(lastX, lastY)
      })
    }

    const drawMarquee = (x1: number, y1: number) => {
      if (!marquee || !box) return
      const rootBox = root.getBoundingClientRect()
      const x0 = marquee.x0
      const y0 = marquee.y0 - root.scrollTop + rootBox.top
      const vy1 = y1
      box.style.left = `${Math.min(x0, x1)}px`
      box.style.top = `${Math.min(y0, vy1)}px`
      box.style.width = `${Math.abs(x1 - x0)}px`
      box.style.height = `${Math.abs(vy1 - y0)}px`
    }

    const applyMarquee = (x1: number, y1: number) => {
      if (!marquee) return
      const rootBox = root.getBoundingClientRect()
      const dy1 = y1 - rootBox.top + root.scrollTop
      const l = Math.min(marquee.x0, x1)
      const r = Math.max(marquee.x0, x1)
      const t = Math.min(marquee.y0, dy1)
      const b = Math.max(marquee.y0, dy1)
      for (const tile of cache) {
        // Пересечение, а не полное вхождение: на рабочем столе задетый краем
        // значок тоже выделяется.
        const hit = tile.l < r && tile.r > l && tile.t < b && tile.b > t
        // Отмечено = было отмечено ДО протяжки ИЛИ попало в прямоугольник.
        const want = hit || tile.was
        /*
         * Дёргаем только изменившиеся. Раньше на каждое движение мыши уходил
         * вызов на КАЖДУЮ плитку кэша: реально менялись единицы, а в очередь
         * хука React ложились сотни обновлений, и он прогонял их все на рендере.
         */
        if (want === tile.on) continue
        tile.on = want
        onPaintRef.current(tile.id, want ? 'add' : 'remove')
      }
    }

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
      if (!painting && !marquee) return
      const box = root.getBoundingClientRect()
      const fromTop = lastY - box.top
      const fromBottom = box.bottom - lastY
      let dy = 0
      if (fromTop < EDGE_PX) dy = -Math.ceil((EDGE_PX - Math.max(0, fromTop)) / 4)
      else if (fromBottom < EDGE_PX) dy = Math.ceil((EDGE_PX - Math.max(0, fromBottom)) / 4)
      if (dy !== 0) {
        const before = root.scrollTop
        root.scrollTop += dy
        if (root.scrollTop !== before) {
          // Сдвинулись — под курсором уже другая плитка, её тоже красим.
          if (painting) paintAt(lastX, lastY)
          if (marquee) {
            drawMarquee(lastX, lastY)
            applyMarquee(lastX, lastY)
          }
        }
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
      mo?.disconnect()
      mo = null
      if (rebuildRaf) cancelAnimationFrame(rebuildRaf)
      rebuildRaf = 0
      marquee = null
      box?.remove()
      box = null
      cache = []
      if (longPress) clearTimeout(longPress)
      longPress = null
      painting = false
      mode = null
      activePointer = -1
      document.body.classList.remove('cl-dragging-select')
    }

    const onPointerDown = (e: PointerEvent) => {
      /*
       * Флаг «была протяжка» гасим в самом начале, ДО любых проверок: после
       * пальцевой покраски завершающий click браузер не присылает (touchmove
       * отменён, палец ушёл далеко), флаг оставался поднятым и глушил
       * следующий обычный клик по кадру.
       */
      dragged = false
      if (e.button !== 0 && e.pointerType === 'mouse') return
      if (activePointer !== -1) return
      const target = e.target as HTMLElement | null
      const tile = tileAt(e.clientX, e.clientY)
      const fromCheckbox = Boolean(target?.closest?.('.cl-tile-check'))

      /*
       * МЫШЬ — всегда рамка, как на рабочем столе: отмечается всё, что попало
       * в прямоугольник, а не только то, по чему прошёл курсор. В плотной
       * сетке это принципиально: протяжкой по диагонали захватываешь пять
       * рядов разом, а покраска по пути брала лишь тонкую полоску под курсором.
       *
       * Пускаем в режиме выделения, с самой галочки и с пустого места ленты.
       * Интерактивные элементы пропускаем, иначе кнопка тянула бы рамку
       * вместо нажатия.
       */
      if (e.pointerType === 'mouse') {
        // Сквозные ленты рисуют плитки без обёртки
        // хуяпки — привязка к её классу оставляла их вовсе без рамки.
        if (!target || !target.closest('.cl-tl-main, .cl-tiles, .cl-page')) return
        if (target.closest('button, a, input, textarea, select, .cl-space-head, .cl-timenav')) {
          if (!fromCheckbox) return
        }
        if (!enabledRef.current && !fromCheckbox && tile) return

        const rootBox = root.getBoundingClientRect()
        activePointer = e.pointerId
        startX = lastX = e.clientX
        startY = lastY = e.clientY
        dragged = false
        marquee = { x0: e.clientX, y0: e.clientY - rootBox.top + root.scrollTop }
        // Кэш строим не здесь, а при первом движении: обмер всех плиток —
        // это getBoundingClientRect на каждую, и делать его на КАЖДЫЙ клик в
        // режиме выделения незачем.
        return
      }

      // ПАЛЕЦ: долгое нажатие и покраска по пути — привычный жест телефона.
      if (!tile) return
      activePointer = e.pointerId
      startX = lastX = e.clientX
      startY = lastY = e.clientY
      dragged = false
      // Палец: ждём долгое нажатие, иначе отняли бы у него прокрутку.
      longPress = setTimeout(() => {
        longPress = null
        if (activePointer === e.pointerId) begin(lastX, lastY)
      }, LONG_PRESS_MS)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointer) return
      lastX = e.clientX
      lastY = e.clientY

      if (marquee) {
        if (!box) {
          // Прямоугольник создаём при первом же движении: одиночный клик по
          // пустому месту не должен мигать рамкой.
          if (Math.abs(lastX - startX) + Math.abs(lastY - startY) <= DRAG_SLOP_PX) return
          buildCache()
          /* Область берём от .cl-root, а не от цели движения: курсор к этому
             моменту мог уйти за пределы сетки, и наблюдатель повис бы не там. */
          const area = root.querySelector<HTMLElement>('.cl-tl-main') ?? root
          mo = new MutationObserver(scheduleRebuild)
          mo.observe(area, { childList: true, subtree: true })
          box = document.createElement('div')
          box.className = 'cl-marquee'
          document.body.appendChild(box)
          document.body.classList.add('cl-dragging-select')
          dragged = true
          raf = requestAnimationFrame(autoScroll)
        }
        drawMarquee(lastX, lastY)
        applyMarquee(lastX, lastY)
        return
      }
      if (painting) {
        paintAt(lastX, lastY)
        return
      }
      const far = Math.abs(lastX - startX) + Math.abs(lastY - startY) > DRAG_SLOP_PX
      if (!far) return
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
