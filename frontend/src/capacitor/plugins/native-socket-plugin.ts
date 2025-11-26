import { registerPlugin } from '@capacitor/core'

export interface NativeSocketPlugin {
  updateToken(options: { token: string }): Promise<{ success: boolean }>
}

const NativeSocket = registerPlugin<NativeSocketPlugin>('NativeSocket', {
  web: () => ({
    async updateToken() {
      return { success: true }
    },
  }),
})

export default NativeSocket

