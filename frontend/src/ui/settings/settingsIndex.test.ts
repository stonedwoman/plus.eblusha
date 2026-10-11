import { describe, expect, it } from 'vitest'
import {
  AV_TAB_NAMES,
  INDEX_DEFS,
  WEB_INDEX_IDS,
  buildIndex,
  countBySection,
  excerptFor,
  normalize,
  queryWords,
  searchRows,
  splitHighlight,
} from './settingsIndex'

// Строки веба из SPEC §1.3 (колонка «Веб» не «—»). Сверка с таблицей — отдельный тест на каждой платформе.
const SPEC_WEB_IDS = [
  'p-photo', 'p-name', 'p-eblid', 'p-ltime', 'p-bot',
  'c-server', 'c-relay',
  'a-mic', 'a-spk', 'a-cam', 'a-permmic', 'a-permcam', 'a-echo', 'a-ns', 'a-agc', 'a-shres', 'a-shfps', 'a-shaud',
  's-pass', 's-link', 's-sess',
  'ap-yt',
  'x-exit',
]

describe('указатель поиска веба', () => {
  it('id строк совпадают с таблицей SPEC §1.3 (веб)', () => {
    expect([...WEB_INDEX_IDS].sort()).toEqual([...SPEC_WEB_IDS].sort())
  })

  it('id не повторяются', () => {
    expect(new Set(WEB_INDEX_IDS).size).toBe(WEB_INDEX_IDS.length)
  })

  it('«Чат с Еблушей» есть в указателе, только если бот заведён', () => {
    expect(buildIndex({ hasBot: false }).some((r) => r.id === 'p-bot')).toBe(false)
    expect(buildIndex({ hasBot: true }).some((r) => r.id === 'p-bot')).toBe(true)
  })

  it('«О себе» и выбора статуса в указателе нет (решение владельца 2026-10-11)', () => {
    for (const d of INDEX_DEFS) {
      expect(d.id).not.toMatch(/^p-(bio|status)$/)
      expect(d.title).not.toMatch(/о себе|статус|не беспокоить|невидимк/i)
    }
    expect(WEB_INDEX_IDS).not.toContain('p-bio')
    expect(WEB_INDEX_IDS).not.toContain('p-status')
  })

  it('у строк «Звука и видео» есть вкладка, у остальных нет', () => {
    for (const d of INDEX_DEFS) {
      if (d.sec === 'av') expect(Object.keys(AV_TAB_NAMES)).toContain(d.tab)
      else expect(d.tab).toBeUndefined()
    }
  })
})

describe('совпадение', () => {
  const idx = buildIndex({ hasBot: true })
  const ids = (q: string) => (searchRows(idx, q) ?? []).map((r) => r.id)

  it('«ё» = «е», регистр не важен', () => {
    expect(normalize('ЁЖ')).toBe('еж')
    expect(ids('ШУМ')).toContain('a-ns')
    expect(ids('шумодав')).toContain('a-ns')
    expect(ids('Всёгда')).toEqual(ids('Всегда'))
    expect(ids('Всегда')).toContain('c-relay')
  })

  it('слова короче 2 знаков отбрасываются; из одной буквы поиска нет', () => {
    expect(queryWords('а в  шум')).toEqual(['шум'])
    expect(searchRows(idx, 'а')).toBeNull()
    expect(searchRows(idx, '   ')).toBeNull()
  })

  it('строка подходит, только если найдено КАЖДОЕ слово', () => {
    expect(ids('звонк релей')).toEqual([])
    expect(ids('ретранслятор звонки')).toContain('c-relay')
    expect(ids('ретранслятор пароль')).toEqual([])
  })

  it('ищет по названию раздела и по синониму', () => {
    expect(ids('безопасность')).toEqual(expect.arrayContaining(['s-pass', 's-link', 's-sess']))
    expect(ids('timezone')).toContain('p-ltime')
    expect(ids('webcam')).toContain('a-cam')
  })

  it('поиск «о себе» / «био» / «статус» / «не беспокоить» / «невидимка» ничего не находит', () => {
    for (const q of ['о себе', 'обо мне', 'био', 'bio', 'описание', 'статус', 'статус онлайн', 'не беспокоить', 'невидимка', 'отошёл', 'dnd', 'показывать меня']) {
      expect(ids(q), q).toEqual([])
    }
  })

  it('поиск по «имя» и «время» по-прежнему находит свои строки', () => {
    expect(ids('имя')).toContain('p-name')
    expect(ids('время')).toContain('p-ltime')
  })

  it('поиск по «микрофон» находит и доступ, и строку устройства', () => {
    expect(ids('микрофон')).toEqual(expect.arrayContaining(['a-mic', 'a-permmic']))
  })

  it('запрос режется до 80 знаков', () => {
    const long = 'шум '.repeat(40)
    expect(queryWords(long).length).toBeLessThanOrEqual(20)
  })

  it('countBySection считает по разделам; «выход» без раздела не считается', () => {
    const rows = searchRows(idx, 'выйти')
    expect(rows?.map((r) => r.id)).toContain('x-exit')
    const c = countBySection(rows)
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe((rows ?? []).filter((r) => r.sec).length)
  })
})

describe('подсветка', () => {
  it('режет текст на куски без потери букв', () => {
    const segs = splitHighlight('Эхоподавление и шум', 'шум')
    expect(segs.map((s) => s.t).join('')).toBe('Эхоподавление и шум')
    expect(segs.filter((s) => s.hit).map((s) => s.t)).toEqual(['шум'])
  })

  it('подсвечивает несколько слов и «ё» как «е»', () => {
    const segs = splitHighlight('Всё равно шум', 'все шум')
    expect(segs.filter((s) => s.hit).map((s) => s.t.toLowerCase())).toEqual(['всё', 'шум'])
  })

  it('без запроса — один кусок', () => {
    expect(splitHighlight('Текст', '')).toEqual([{ t: 'Текст', hit: false }])
  })

  it('выдержка подсвечена и содержит найденное слово', () => {
    const row = buildIndex({ hasBot: false }).find((r) => r.id === 'c-relay')!
    const segs = excerptFor(row, 'звонках')
    expect(segs.some((s) => s.hit)).toBe(true)
    expect(segs.map((s) => s.t).join('')).toContain('звонках')
  })

  it('найденное только по синониму — «по слову «…»»', () => {
    const row = buildIndex({ hasBot: false }).find((r) => r.id === 'a-cam')!
    expect(excerptFor(row, 'webcam').map((s) => s.t).join('')).toBe('по слову «webcam»')
  })

  it('найденное по названию во «Звуке и видео» — имя вкладки', () => {
    const row = buildIndex({ hasBot: false }).find((r) => r.id === 'a-agc')!
    // «автоусиление» есть только в названии
    expect(excerptFor(row, 'автоусиление').map((s) => s.t).join('')).toBe('Обработка голоса')
  })
})
