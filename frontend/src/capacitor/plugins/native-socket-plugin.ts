import { registerPlugin } from '@capacitor/core'

export interface NativeSocketPlugin {
  updateToken(options: { token: string }): Promise<{ success: boolean }>
  requestBatteryOptimizationExemption(): Promise<{ granted: boolean; message?: string }>
}

const NativeSocket = registerPlugin<NativeSocketPlugin>('NativeSocket', {
  web: () => ({
    async updateToken() {
      return { success: true }
    },
    async requestBatteryOptimizationExemption() {
      return { granted: true, message: 'Not available on web' }
    },
  }),
})

export { NativeSocket }
export default NativeSocket

