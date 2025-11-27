import { registerPlugin } from '@capacitor/core'

export interface NativeSocketPlugin {
  updateToken(options: { token: string; refreshToken?: string | null }): Promise<{ success: boolean }>
  requestBatteryOptimizationExemption(): Promise<{ granted: boolean; message?: string }>
  setPresenceFocus(options: { focused: boolean }): Promise<{ focused: boolean }>
}

const NativeSocket = registerPlugin<NativeSocketPlugin>('NativeSocket', {
  web: () => ({
    async updateToken() {
      return { success: true }
    },
    async requestBatteryOptimizationExemption() {
      return { granted: true, message: 'Not available on web' }
    },
    async setPresenceFocus({ focused }: { focused: boolean }) {
      return { focused }
    },
  }),
})

export { NativeSocket }
export default NativeSocket

