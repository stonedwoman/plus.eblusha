import { registerPlugin } from '@capacitor/core'

export interface IncomingCallPlugin {
  showIncomingCall(options: {
    conversationId: string
    callerName: string
    isVideo: boolean
    avatarUrl?: string
  }): Promise<void>
  closeIncomingCall(): Promise<void>
  ensurePermissions(): Promise<{ granted: boolean }>
  ensureBackgroundExecution(): Promise<{ granted: boolean }>
}

const IncomingCall = registerPlugin<IncomingCallPlugin>('IncomingCall', {
  web: () => import('./incoming-call-plugin.web').then(m => new m.IncomingCallWeb()),
})

export default IncomingCall

