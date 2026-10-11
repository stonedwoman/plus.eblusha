/**
 * Охрана решения владельца 2026-10-11: поле «О себе» и ручной выбор статуса (в сети / отошёл / не беспокоить /
 * невидимка) убраны из интерфейса веба целиком — из настроек, плитки «Профиль» и чужой карточки.
 * Автоматическое присутствие («В сети», значок устройства) остаётся и здесь не проверяется.
 * Тест читает исходники: вернуть поле незаметно не выйдет.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const here = (rel: string) => new URL(rel, import.meta.url)
/** Без комментариев: они вправе объяснять, что «О себе» убрано, — проверяется только живой код. */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const read = (rel: string) => stripComments(readFileSync(here(rel), 'utf8'))

function sourcesIn(relDir: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = []
  for (const e of readdirSync(here(relDir), { withFileTypes: true })) {
    if (e.isDirectory()) {
      for (const s of sourcesIn(`${relDir}${e.name}/`)) out.push({ name: `${e.name}/${s.name}`, text: s.text })
    } else if (/\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push({ name: e.name, text: read(`${relDir}${e.name}`) })
    }
  }
  return out
}

const BIO = /\bbio\b|bioDraft|srvBio|setBio|p-bio|ebs-tp__bio|ebs-field--block|<textarea|«О себе»|"О себе"|'О себе'/
const STATUS_PICKER = /Не беспокоить|Невидимка|Показывать меня|p-status|status:\s*'(?:DND|AWAY)'|"status"\s*:/

describe('«О себе» и выбор статуса убраны из веба', () => {
  const settings = sourcesIn('./')

  it('в исходниках центра настроек нет поля «О себе»', () => {
    expect(settings.length).toBeGreaterThan(5)
    for (const f of settings) {
      const m = BIO.exec(f.text)
      expect(m, `${f.name}: ${m?.[0]}`).toBeNull()
    }
  })

  it('в исходниках центра настроек нет выбора статуса', () => {
    for (const f of settings) {
      const m = STATUS_PICKER.exec(f.text)
      expect(m, `${f.name}: ${m?.[0]}`).toBeNull()
    }
  })

  it('карточка человека больше не рисует «о себе»', () => {
    expect(read('../components/UserProfileCard.tsx')).not.toMatch(/\bbio\b/)
  })

  it('профиль бота не несёт bio', () => {
    expect(read('../../domain/bot/systemBot.ts')).not.toMatch(/\bbio\b/)
  })

  it('PATCH /status/me из центра настроек не шлёт ни bio, ни status', () => {
    const patches = read('./useSettingsModel.tsx').match(/api\.patch\('\/status\/me'[^\n]*/g) ?? []
    expect(patches.length).toBe(1)
    expect(patches[0]).toContain('profilePatchBody(')
    expect(patches[0]).not.toMatch(/bio|status:/)
  })
})
