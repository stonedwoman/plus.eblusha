import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLAPSE_MS, EXPAND_MS, SETTLE_SLACK_MS, collapseToTile, expandFromTile } from './settingsMotion'

// DOM в тестах нет (окружение node): подставляем ровно то, что трогают переходы — призрак, тело, плитку, анимации.
type FakeAnim = { onfinish: null | (() => void); oncancel: null | (() => void) }
function fakeAnim(): FakeAnim {
  return { onfinish: null, oncancel: null }
}

function setup() {
  const ghostAnim = fakeAnim()
  const overviewAnim = fakeAnim()
  const ghost = {
    className: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    appendChild: vi.fn(),
    remove: vi.fn(),
    animate: vi.fn(() => ghostAnim),
  }
  const rect = { left: 0, top: 0, width: 800, height: 500 }
  const body = { getBoundingClientRect: () => rect, appendChild: vi.fn(), animate: vi.fn() }
  const tile = { getBoundingClientRect: () => ({ left: 40, top: 60, width: 200, height: 120 }), querySelector: () => null }
  const overview = { animate: vi.fn(() => overviewAnim) }
  vi.stubGlobal('document', { createElement: () => ghost })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
  return { ghost, ghostAnim, overviewAnim, body, tile, overview }
}

describe('переходы плитка ↔ раздел', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('раскрытие завершается по событию finish: призрак убран, промис выполнен', async () => {
    const t = setup()
    const done = vi.fn()
    void expandFromTile(t.body as never, t.tile as never, t.overview as never).then(done)
    expect(t.body.appendChild).toHaveBeenCalledTimes(1)
    t.ghostAnim.onfinish?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledTimes(1)
    expect(t.ghost.remove).toHaveBeenCalledTimes(1)
    // таймер запаса после этого ничего не делает второй раз
    await vi.advanceTimersByTimeAsync(EXPAND_MS + SETTLE_SLACK_MS + 100)
    expect(done).toHaveBeenCalledTimes(1)
    expect(t.ghost.remove).toHaveBeenCalledTimes(1)
  })

  it('событие finish не пришло (скрытая вкладка): раскрытие всё равно заканчивается, флаг «идёт переход» не залипает', async () => {
    const t = setup()
    const done = vi.fn()
    void expandFromTile(t.body as never, t.tile as never, t.overview as never).then(done)
    await vi.advanceTimersByTimeAsync(EXPAND_MS)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SETTLE_SLACK_MS + 1)
    expect(done).toHaveBeenCalledTimes(1)
    expect(t.ghost.remove).toHaveBeenCalledTimes(1)
  })

  it('отмена анимации (oncancel) тоже завершает раскрытие', async () => {
    const t = setup()
    const done = vi.fn()
    void expandFromTile(t.body as never, t.tile as never, t.overview as never).then(done)
    t.ghostAnim.oncancel?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('обратный ход к плитке: по событию и по таймеру запаса', async () => {
    const a = setup()
    const doneA = vi.fn()
    void collapseToTile(a.body as never, a.tile as never, a.overview as never).then(doneA)
    a.ghostAnim.onfinish?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(doneA).toHaveBeenCalledTimes(1)

    const b = setup()
    const doneB = vi.fn()
    void collapseToTile(b.body as never, b.tile as never, b.overview as never).then(doneB)
    await vi.advanceTimersByTimeAsync(COLLAPSE_MS + SETTLE_SLACK_MS + 1)
    expect(doneB).toHaveBeenCalledTimes(1)
    expect(b.ghost.remove).toHaveBeenCalledTimes(1)
  })

  it('«меньше движения»: без призрака, промис выполнен сразу', async () => {
    const t = setup()
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    const done = vi.fn()
    void expandFromTile(t.body as never, t.tile as never, t.overview as never).then(done)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledTimes(1)
    expect(t.body.appendChild).not.toHaveBeenCalled()
  })
})
