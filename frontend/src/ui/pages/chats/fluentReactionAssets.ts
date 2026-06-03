// Fluent Emoji Flat runtime helpers. Metadata is lazy-loaded from public/fluent-emoji/reactions.json.
export type FluentReactionEmojiEntry = { emoji: string; search: string }

let fluentReactionEmojiEntriesPromise: Promise<readonly FluentReactionEmojiEntry[]> | null = null

function stripEmojiVariation(value: string): string {
  return Array.from(value).filter((char) => {
    const code = char.codePointAt(0)
    return code !== 0xfe0f && code !== 0xfe0e
  }).join('')
}

function emojiAssetKey(emoji: string): string {
  return Array.from(stripEmojiVariation(emoji)).map((char) => char.codePointAt(0)?.toString(16)).filter(Boolean).join('-')
}

export function normalizeFluentReactionSearch(value: string): string {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/\u0451/g, '\u0435')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\-\u2013\u2014]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fluentReactionEmojiAsset(emoji: string): string | undefined {
  const key = emojiAssetKey(emoji)
  return key ? `/fluent-emoji/flat/${key}.svg` : undefined
}

export function loadFluentReactionEmojiEntries(): Promise<readonly FluentReactionEmojiEntry[]> {
  if (!fluentReactionEmojiEntriesPromise) {
    fluentReactionEmojiEntriesPromise = fetch('/fluent-emoji/reactions.json')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load emoji index: ${res.status}`)
        return res.json() as Promise<[string, string][]>
      })
      .then((rows) => rows.map(([emoji, search]) => ({ emoji, search })))
  }
  return fluentReactionEmojiEntriesPromise
}
