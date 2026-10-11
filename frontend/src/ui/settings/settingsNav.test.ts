import { describe, expect, it } from 'vitest'
import { SETTINGS_SECTIONS, parseSettingsParam, settingsParamValue, viewFromSearch } from './settingsNav'

describe('адрес центра настроек', () => {
  it('?settings= без значения и «overview» — обзор', () => {
    expect(parseSettingsParam('')).toEqual({ kind: 'overview' })
    expect(parseSettingsParam('overview')).toEqual({ kind: 'overview' })
    expect(parseSettingsParam('1')).toEqual({ kind: 'overview' })
  })

  it('нет параметра — центр закрыт', () => {
    expect(parseSettingsParam(null)).toBeNull()
    expect(viewFromSearch('')).toBeNull()
    expect(viewFromSearch('?foo=1')).toBeNull()
  })

  it('разделы туда и обратно', () => {
    for (const id of SETTINGS_SECTIONS) {
      const v = { kind: 'section' as const, id }
      expect(parseSettingsParam(settingsParamValue(v))).toEqual(v)
    }
    expect(settingsParamValue({ kind: 'overview' })).toBe('overview')
  })

  it('«connection» — это «Соединение»; регистр не важен; незнакомое — обзор', () => {
    expect(parseSettingsParam('Connection')).toEqual({ kind: 'section', id: 'conn' })
    expect(parseSettingsParam('AUDIO')).toEqual({ kind: 'section', id: 'av' })
    expect(parseSettingsParam('чепуха')).toEqual({ kind: 'overview' })
  })

  it('читается из строки адреса среди прочих параметров', () => {
    expect(viewFromSearch('?a=1&settings=security')).toEqual({ kind: 'section', id: 'security' })
  })

  it('порядок разделов — как у натива, пять штук', () => {
    expect([...SETTINGS_SECTIONS]).toEqual(['profile', 'conn', 'av', 'security', 'app'])
  })
})
