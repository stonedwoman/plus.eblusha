import { WebPlugin } from '@capacitor/core'
import type { IncomingCallPlugin } from './incoming-call-plugin'

type Action = 'accept-audio' | 'accept-video' | 'decline'

declare global {
  interface Window {
    handleIncomingCallAnswer?: (conversationId: string, withVideo: boolean) => void
    handleIncomingCallDecline?: (conversationId: string) => void
    __pendingCallActions?: Array<{ action: 'accept' | 'decline'; conversationId: string; withVideo?: boolean }>
    __flushNativeCallActions?: () => void
  }
}

export class IncomingCallWeb extends WebPlugin implements IncomingCallPlugin {
  private overlay: HTMLDivElement | null = null
  private activeConversationId: string | null = null

  async showIncomingCall(options: { conversationId: string; callerName: string; isVideo: boolean; avatarUrl?: string | undefined }): Promise<void> {
    if (typeof document === 'undefined') return
    this.activeConversationId = options.conversationId
    if (!this.overlay) {
      this.overlay = this.createOverlayRoot()
    }
    this.overlay.style.display = 'flex'
    this.renderCard(options)
  }

  async closeIncomingCall(): Promise<void> {
    if (!this.overlay) return
    this.overlay.style.display = 'none'
    this.overlay.innerHTML = ''
    this.activeConversationId = null
  }

  async ensurePermissions(): Promise<{ granted: boolean }> {
    return { granted: true }
  }

  async ensureBackgroundExecution(): Promise<{ granted: boolean }> {
    return { granted: true }
  }

  private createOverlayRoot(): HTMLDivElement {
    const overlay = document.createElement('div')
    overlay.className = 'incoming-call-overlay'
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:rgba(10,12,16,0.55)',
      'backdrop-filter:blur(4px) saturate(110%)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'z-index:2147483000',
      'transition:opacity 0.2s ease',
      'padding:24px 16px',
    ].join(';')
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        this.closeIncomingCall().catch(() => {})
      }
    })
    document.body.appendChild(overlay)
    return overlay
  }

  private renderCard({ callerName, isVideo, avatarUrl }: { callerName: string; isVideo: boolean; avatarUrl?: string | undefined }): void {
    if (!this.overlay) return
    this.overlay.innerHTML = ''

    const card = document.createElement('div')
    card.style.cssText = 'background:var(--surface-200);border-radius:16px;border:1px solid var(--surface-border);padding:24px;width:min(92vw,440px);box-shadow:var(--shadow-sharp);transform:translateY(-4vh);color:var(--text-primary);display:flex;flex-direction:column;gap:16px'
    card.addEventListener('click', (event) => event.stopPropagation())

    const title = document.createElement('div')
    title.style.fontWeight = '700'
    title.style.marginBottom = '4px'
    title.textContent = isVideo ? 'Входящий видеозвонок' : 'Входящий аудиозвонок'

    const tile = document.createElement('div')
    tile.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px;background:var(--surface-100);border:1px solid var(--surface-border);border-radius:12px'
    tile.appendChild(this.buildAvatar(callerName, avatarUrl))

    const meta = document.createElement('div')
    const nameEl = document.createElement('div')
    nameEl.style.fontWeight = '600'
    nameEl.style.fontSize = '16px'
    nameEl.textContent = callerName

    const subtitle = document.createElement('div')
    subtitle.style.fontSize = '12px'
    subtitle.style.color = 'var(--text-muted)'
    subtitle.textContent = 'звонит…'

    meta.appendChild(nameEl)
    meta.appendChild(subtitle)
    tile.appendChild(meta)

    const actionsColumn = document.createElement('div')
    actionsColumn.style.display = 'flex'
    actionsColumn.style.flexDirection = 'column'
    actionsColumn.style.gap = '8px'

    const answerRow = document.createElement('div')
    answerRow.style.display = 'flex'
    answerRow.style.gap = '8px'

    answerRow.appendChild(
      this.buildActionButton('Ответить', 'var(--brand, #2563eb)', '#fff', 'accept-audio', this.phoneIcon())
    )
    answerRow.appendChild(
      this.buildActionButton('Ответить с видео', 'var(--brand-strong, #0ea5e9)', '#fff', 'accept-video', this.videoIcon())
    )

    const declineRow = document.createElement('div')
    declineRow.style.display = 'flex'
    declineRow.appendChild(
      this.buildActionButton('Отмена', '#ef4444', '#fff', 'decline', this.phoneOffIcon())
    )

    actionsColumn.appendChild(answerRow)
    actionsColumn.appendChild(declineRow)

    card.appendChild(title)
    card.appendChild(tile)
    card.appendChild(actionsColumn)

    this.overlay.appendChild(card)
  }

  private buildAvatar(name: string, avatarUrl?: string): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.style.width = '64px'
    wrapper.style.height = '64px'
    wrapper.style.borderRadius = '50%'
    wrapper.style.overflow = 'hidden'
    wrapper.style.display = 'flex'
    wrapper.style.alignItems = 'center'
    wrapper.style.justifyContent = 'center'
    wrapper.style.background = 'var(--surface-300)'
    wrapper.style.color = '#fff'
    wrapper.style.fontWeight = '600'
    wrapper.style.fontSize = '20px'
    wrapper.style.textTransform = 'uppercase'

    if (avatarUrl) {
      const img = document.createElement('img')
      img.src = avatarUrl
      img.alt = name
      img.style.width = '100%'
      img.style.height = '100%'
      img.style.objectFit = 'cover'
      wrapper.appendChild(img)
      return wrapper
    }

    wrapper.textContent = this.buildInitials(name)
    return wrapper
  }

  private buildInitials(name: string): string {
    const parts = name.trim().split(/\s+/)
    if (parts.length === 0) return '?'
    if (parts.length === 1) return parts[0].charAt(0) || '?'
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase()
  }

  private buildActionButton(label: string, background: string, color: string, action: Action, iconSvg: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.style.cssText = [
      'flex:1',
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'gap:8px',
      'padding:14px 16px',
      'min-height:48px',
      'border-radius:12px',
      'border:none',
      'font-weight:600',
      'font-size:15px',
      `background:${background}`,
      `color:${color}`,
      'cursor:pointer',
      'transition:transform 0.15s ease, filter 0.15s ease',
    ].join(';')
    button.innerHTML = `${iconSvg}<span>${label}</span>`
    button.onmouseenter = () => {
      button.style.filter = 'brightness(1.05)'
    }
    button.onmouseleave = () => {
      button.style.filter = 'none'
    }
    button.onmousedown = () => {
      button.style.transform = 'translateY(1px)'
    }
    button.onmouseup = () => {
      button.style.transform = 'translateY(0)'
    }
    button.onclick = (event) => {
      event.stopPropagation()
      this.dispatchAction(action)
    }
    return button
  }

  private dispatchAction(action: Action): void {
    if (!this.activeConversationId || typeof window === 'undefined') {
      return
    }
    const conversationId = this.activeConversationId
    const win = window as Window
    if (action === 'decline') {
      if (typeof win.handleIncomingCallDecline === 'function') {
        win.handleIncomingCallDecline(conversationId)
      } else {
        this.queueAction({ action: 'decline', conversationId })
      }
      void this.closeIncomingCall()
      return
    }

    const withVideo = action === 'accept-video'
    if (typeof win.handleIncomingCallAnswer === 'function') {
      win.handleIncomingCallAnswer(conversationId, withVideo)
    } else {
      this.queueAction({ action: 'accept', conversationId, withVideo })
    }
    void this.closeIncomingCall()
  }

  private queueAction(payload: { action: 'accept' | 'decline'; conversationId: string; withVideo?: boolean }): void {
    if (typeof window === 'undefined') return
    const win = window as Window
    if (!Array.isArray(win.__pendingCallActions)) {
      win.__pendingCallActions = []
    }
    win.__pendingCallActions.push(payload)
    if (typeof win.__flushNativeCallActions === 'function') {
      win.__flushNativeCallActions()
    }
  }

  private phoneIcon(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.44 12.44 0 0 0 .67 2.73 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.35-1.35a2 2 0 0 1 2.11-.45 12.44 12.44 0 0 0 2.73.67A2 2 0 0 1 22 16.92z"/></svg>`
  }

  private videoIcon(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`
  }

  private phoneOffIcon(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3l2 2m2 2 8 8m-4 4-2 2M3 10l2 2m2 2 8 8m3.6-9.6a16 16 0 0 0-4.2-4.2m-2.8-1.5a16 16 0 0 0-5.6 5.6"/></svg>`
  }
}

