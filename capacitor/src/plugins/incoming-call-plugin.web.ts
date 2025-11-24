import { WebPlugin } from '@capacitor/core'
import type { IncomingCallPlugin } from './incoming-call-plugin'

export class IncomingCallWeb extends WebPlugin implements IncomingCallPlugin {
  async showIncomingCall(): Promise<void> {
    // На веб-платформе ничего не делаем
    console.log('[IncomingCallWeb] showIncomingCall called on web platform')
  }

  async closeIncomingCall(): Promise<void> {
    // На веб-платформе ничего не делаем
    console.log('[IncomingCallWeb] closeIncomingCall called on web platform')
  }

  async ensurePermissions(): Promise<{ granted: boolean }> {
    console.log('[IncomingCallWeb] ensurePermissions called on web platform')
    return { granted: true }
  }
}


