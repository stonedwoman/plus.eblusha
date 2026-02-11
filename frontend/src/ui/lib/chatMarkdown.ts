import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import TurndownService from 'turndown'

// HTML → Markdown for WYSIWYG composer (getComposerValue).
const turndownService = new TurndownService({ headingStyle: 'atx' })
turndownService.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: (content: string) => `~~${content}~~`,
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

// Keep code blocks simple and predictable.
md.set({
  highlight: (str: string) => {
    // Escape is handled by markdown-it by default when html=false; return as-is.
    // We'll wrap in <pre><code> via renderer.
    return str
  },
})

export function renderChatMarkdownToHtml(text: string): string {
  const raw = md.render(text || '')
  // Defensive: sanitize all output, allow only basic formatting tags.
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
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
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    // Force safe links.
    ADD_ATTR: ['target', 'rel'],
  })
}

