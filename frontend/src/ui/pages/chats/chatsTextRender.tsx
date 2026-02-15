import { Fragment } from 'react'
import { detectLinks } from '../../../js/link-detect'
import { renderChatMarkdownToHtml } from '../../lib/chatMarkdown'

export function decodeUrlForDisplay(raw: string) {
  // decodeURI keeps reserved characters (/, ?, #, &) intact while decoding %XX sequences.
  // This is ideal for showing human-readable paths like /wiki/Трофей:...
  try {
    return decodeURI(raw)
  } catch {
    return raw
  }
}

export function renderLinkifiedText(value: unknown) {
  if (typeof value !== 'string') return value as any
  if (!value) return value

  const links = detectLinks(value)
  if (!links.length) {
    // Preserve newlines
    const lines = value.split('\n')
    return (
      <>
        {lines.map((line, idx) => (
          <Fragment key={`t-${idx}`}>
            {line}
            {idx < lines.length - 1 ? <br /> : null}
          </Fragment>
        ))}
      </>
    )
  }

  const nodes: any[] = []
  let last = 0
  for (const l of links) {
    if (l.start > last) nodes.push(value.slice(last, l.start))
    const displayText = decodeUrlForDisplay(value.slice(l.start, l.end))
    nodes.push(
      <a
        key={`u-${l.start}-${l.end}`}
        href={l.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        style={{ color: 'inherit', textDecoration: 'underline', overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {displayText}
      </a>,
    )
    last = l.end
  }
  if (last < value.length) nodes.push(value.slice(last))

  // Convert \n into <br/> while keeping anchors intact.
  const out: any[] = []
  let key = 0
  for (const part of nodes) {
    if (typeof part !== 'string') {
      out.push(<Fragment key={`p-${key++}`}>{part}</Fragment>)
      continue
    }
    const lines = part.split('\n')
    lines.forEach((line, idx) => {
      out.push(<Fragment key={`s-${key++}`}>{line}</Fragment>)
      if (idx < lines.length - 1) out.push(<br key={`br-${key++}`} />)
    })
  }
  return <>{out}</>
}

export function isMarkdownLike(text: string): boolean {
  const s = text || ''
  if (!s) return false
  // Keep this intentionally small: we only switch renderer when user clearly uses markers.
  return (
    s.includes('```') ||
    s.includes('`') ||
    s.includes('**') ||
    // italic marker is ambiguous; require space+* or *_ to avoid false positives
    /(^|\s)\*(\S)/.test(s) ||
    /(^|\n)>\s/.test(s) ||
    /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/.test(s)
  )
}

export function renderMessageText(value: unknown) {
  if (typeof value !== 'string') return value as any
  const s = value || ''
  if (!s) return s
  if (!isMarkdownLike(s)) return renderLinkifiedText(s)
  const html = renderChatMarkdownToHtml(s)
  // eslint-disable-next-line react/no-danger
  return <div className="chat-md" dangerouslySetInnerHTML={{ __html: html }} />
}

