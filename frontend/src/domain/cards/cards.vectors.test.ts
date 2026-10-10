/**
 * Общие векторы карточек бота (vectors/*.json): конверт и права, таймер обещания, «поделиться перепиской».
 * Те же файлы — эталон для натива, Android и iOS (формат описан в поле about каждого файла).
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { botCardOfMessage, visibleActions, type BotCard } from './cardEnvelope'
import { _resetCardStoreForTests, getStoredCard, offerCard } from './cardStore'
import { buildPromiseCard } from './promiseCard'
import { buildShareCard } from './shareCard'
import { richText } from './cardFormat'

const load = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/${name}`, import.meta.url), 'utf8'))

function caseCard(defaults: any, c: any): BotCard {
  const base = defaults.card
  const over = c.card ?? {}
  const state = over.state ?? base.state
  return {
    v: 1,
    type: base.type,
    id: over.id ?? base.id,
    rev: over.rev ?? base.rev,
    state,
    closed: over.closed ?? !['running', 'pending', 'granted'].includes(state),
    actions: over.actions ?? defaults.actionsByState[state] ?? [],
    data: { ...base.data, ...(over.data ?? {}) },
    source: 'card',
  }
}

/** Сравнить только поля из expect (вложенные объекты/массивы — тоже частично). */
function expectSubset(actual: any, expected: any, path = ''): void {
  if (expected === null || typeof expected !== 'object') {
    expect(actual, path).toEqual(expected)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} — массив`).toBe(true)
    expect(actual.length, `${path}.length`).toBe(expected.length)
    expected.forEach((e: any, i: number) => expectSubset(actual[i], e, `${path}[${i}]`))
    return
  }
  expect(actual, path).toBeTruthy()
  for (const k of Object.keys(expected)) expectSubset(actual[k], expected[k], path ? `${path}.${k}` : k)
}

describe('bot-card-vectors: конверт', () => {
  const v = load('bot-card-vectors.json')
  for (const c of v.parse) {
    it(`разбор: ${c.name}`, () => {
      const card = botCardOfMessage(c.message)
      expect(!!card).toBe(c.expect.render)
      if (!card) return
      if (c.expect.type) expect(card.type).toBe(c.expect.type)
      if (c.expect.rev != null) expect(card.rev).toBe(c.expect.rev)
      if (c.expect.source) expect(card.source).toBe(c.expect.source)
      if (c.expect.closed != null) expect(card.closed).toBe(c.expect.closed)
      if (c.expect.actions) expect(card.actions.map((a) => a.id)).toEqual(c.expect.actions)
    })
  }
  for (const c of v.actions) {
    it(`права: ${c.name}`, () => {
      const card: BotCard = { v: 1, type: 'share', id: 'x', rev: 1, state: 's', closed: c.card.closed, actions: c.card.actions, data: {}, source: 'card' }
      expect(visibleActions(card, c.viewer, Date.parse(c.now))).toEqual(c.expect)
    })
  }
  describe('порядок версий', () => {
    beforeEach(() => _resetCardStoreForTests())
    for (const c of v.rev) {
      it(`rev: ${c.name}`, () => {
        const accepted = c.offers.map((rev: number) => offerCard('m', { v: 1, type: 'share', id: 'x', rev, state: 'pending', closed: false, actions: [], data: {}, source: 'card' }))
        expect(accepted).toEqual(c.expect.accepted)
        expect(getStoredCard('m')?.rev).toBe(c.expect.final)
      })
    }
  })
})

describe('promise-card-vectors: таймер обещания', () => {
  const v = load('promise-card-vectors.json')
  for (const c of v.cases) {
    it(c.name, () => {
      const card = caseCard(v.defaults, c)
      const names = { ...v.defaults.people, ...(c.names ?? {}) }
      const model = buildPromiseCard(card, Date.parse(c.now), {
        id: c.viewer,
        zone: c.zone ?? v.defaults.zone,
        resolveName: c.names ? (id: string) => names[id] ?? null : undefined,
      })
      expectSubset(model, c.expect)
    })
  }
})

describe('share-card-vectors: поделиться перепиской', () => {
  const v = load('share-card-vectors.json')
  for (const c of v.cases) {
    it(c.name, () => {
      const card = caseCard(v.defaults, c)
      const names = { ...v.defaults.people, ...(c.names ?? {}) }
      const model = buildShareCard(
        card,
        Date.parse(c.now ?? v.defaults.now),
        { id: c.viewer, zone: c.zone ?? v.defaults.zone, resolveName: c.names ? (id: string) => names[id] ?? null : undefined },
        c.local ?? {},
      )
      const projected = { ...model, lines: model.lines.map(richText) }
      expectSubset(projected, c.expect)
    })
  }
})
