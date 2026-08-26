import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import TurndownService from 'turndown'

// HTML → Markdown for WYSIWYG composer (getComposerValue).
const turndownService = new TurndownService({
  headingStyle: 'atx',
  // Блок кода — заборчиком из ``` (по умолчанию turndown отдаёт отступ в 4 пробела,
  // а телефон такой блок кодом не считает и показывает его обычным текстом).
  codeBlockStyle: 'fenced',
  fence: '```',
  bulletListMarker: '-',
  hr: '---',
})
turndownService.addRule('bold', {
  filter: ['b', 'strong'],
  replacement: (content: string) => `**${content}**`,
})
turndownService.addRule('italic', {
  filter: ['i', 'em'],
  replacement: (content: string) => `_${content}_`,
})
turndownService.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: (content: string) => `~~${content}~~`,
})

// Turndown по умолчанию экранирует markdown-символы: "ld_src" превращается в "ld\_src".
// Для обычного текста это правильно, но ссылку это ломает — а в query-параметрах "_" и "*"
// встречаются постоянно (base64, подписи). Поэтому куски, похожие на URL, не экранируем.
const defaultEscape = (TurndownService as any).prototype.escape as (s: string) => string
;(turndownService as any).escape = function (text: string): string {
  if (!text) return text
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/gi)
  return parts
    .map((part, i) => (i % 2 === 1 ? part : defaultEscape.call(this, part)))
    .join('')
}

// Таблица → GFM-разметка. Без этого правила turndown вываливает содержимое ячеек
// сплошным текстом, и отправленное перестаёт совпадать с тем, что человек видел в
// поле ввода.
turndownService.addRule('table', {
  filter: 'table',
  replacement: (_content: string, node: any) => {
    const rows: any[] = Array.from(node.querySelectorAll?.('tr') ?? [])
    if (!rows.length) return ''
    const cellsOf = (row: any): string[] =>
      Array.from(row.querySelectorAll?.('th,td') ?? []).map((cell: any) =>
        String(cell.textContent ?? '')
          .replace(/\|/g, '\\|')
          .replace(/\s+/g, ' ')
          .trim(),
      )
    const matrix = rows.map(cellsOf).filter((cells) => cells.length > 0)
    if (!matrix.length) return ''
    const width = matrix.reduce((max, cells) => Math.max(max, cells.length), 0)
    const pad = (cells: string[]) => {
      const out = cells.slice()
      while (out.length < width) out.push('')
      return out
    }
    const line = (cells: string[]) => `| ${pad(cells).join(' | ')} |`
    const separator = `| ${new Array(width).fill('---').join(' | ')} |`
    return `\n\n${[line(matrix[0]), separator, ...matrix.slice(1).map(line)].join('\n')}\n\n`
  },
})

// Части таблицы обрабатываются правилом выше целиком; сами по себе они ничего не выводят.
turndownService.addRule('tableParts', {
  filter: ['thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
  replacement: () => '',
})

export function htmlToMarkdown(html: string): string {
  if (!html || typeof html !== 'string') return ''
  try {
    return turndownService.turndown(html).trim()
  } catch {
    return ''
  }
}

// Markdown-lite renderer for chat messages.
// UI remains ours; this module only provides safe HTML rendering.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true, // single line breaks -> <br>, Discord-like
  typographer: false,
})

// Ссылки из разметки открываем в новой вкладке. Без этого в ПК-клиенте (Electron)
// переход по ссылке в сообщении уводил ИЗ приложения — в обычном тексте это давно
// сделано правильно, а в размеченном забыли.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens: any, idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens: any, idx: number, options: any, env: any, self: any) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer nofollow')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  's',
  'del',
  'code',
  'pre',
  'blockquote',
  'a',
  'ul',
  'ol',
  'li',
  // Заголовки и таблицы: люди присылают в чат готовые куски текста с разметкой
  // (сводки, списки проверок), и раньше DOMPurify вырезал теги, оставляя всё
  // сплошной строкой — таблица превращалась в кашу из слов.
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]

function sanitizeChatHtml(raw: string): string {
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    // Force safe links.
    ADD_ATTR: ['target', 'rel'],
  })
}

export function renderChatMarkdownToHtml(text: string): string {
  const raw = md.render(text || '')
  // Defensive: sanitize all output, allow only basic formatting tags.
  return sanitizeChatHtml(raw)
}

/** Блочная разметка: заголовки, списки, цитаты, таблицы, ограда кода. */
const BLOCK_MARKDOWN: RegExp[] = [
  /^\s{0,3}#{1,6}\s+\S/m, // # заголовок
  /^\s{0,3}([-*+])\s+\S/m, // - список
  /^\s{0,3}\d+[.)]\s+\S/m, // 1. список
  /^\s{0,3}>\s+\S/m, // > цитата
  /^\s{0,3}\|.*\|\s*$/m, // | таблица |
  /^\s{0,3}```/m, // блок кода
]

/**
 * Свободная проверка «в сообщении есть разметка» — для ПОКАЗА полученных сообщений.
 * Намеренно широкая: лучше лишний раз пропустить текст через markdown-рендер (он
 * ничего не портит), чем потерять форматирование, которое человек прислал.
 */
export function looksLikeMarkdown(text: string): boolean {
  const value = String(text || '')
  if (!value) return false
  if (value.includes('`') || value.includes('**') || /(^|\s)\*\S/.test(value)) return true
  if (/\[[^\]\n]+\]\((https?:\/\/|\/)[^)\s]+\)/.test(value)) return true
  return BLOCK_MARKDOWN.some((re) => re.test(value))
}

/**
 * Строгая проверка — для ВСТАВКИ в поле ввода. Здесь ошибиться дороже: текст,
 * который человек вставил, не должен незаметно перекроиться из-за одиночной
 * обратной кавычки или звёздочки в слове. Поэтому требуем либо ПАРНЫЕ маркеры,
 * либо честную блочную разметку.
 */
export function hasRichMarkdown(text: string): boolean {
  const value = String(text || '')
  if (!value.trim()) return false
  const paired: RegExp[] = [
    /\*\*[^\s*][\s\S]*?\*\*/, // **жирный**
    /__[^\s_][\s\S]*?__/, // __жирный__
    /~~[^\s~][\s\S]*?~~/, // ~~зачёркнутый~~
    /`[^`\n]+`/, // `код`
    /\[[^\]\n]+\]\((https?:\/\/|\/)[^)\s]+\)/, // [текст](ссылка)
  ]
  return paired.some((re) => re.test(value)) || BLOCK_MARKDOWN.some((re) => re.test(value))
}

/**
 * Разметка → HTML для ПОЛЯ ВВОДА (оно у нас «как в Ворде», contenteditable).
 * Вставлять размеченный текст как есть нельзя: при отправке turndown экранирует
 * звёздочки, и собеседник получает палки вместо форматирования.
 */
export function markdownToComposerHtml(text: string): string {
  if (!text) return ''
  try {
    return sanitizeChatHtml(md.render(text))
  } catch {
    return ''
  }
}

