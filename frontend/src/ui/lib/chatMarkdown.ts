import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

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

