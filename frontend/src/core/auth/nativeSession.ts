import { Capacitor } from '@capacitor/core'
import NativeSocket, { type NativeSocketPlugin } from '../../capacitor/plugins/native-socket-plugin'

export type NativeStoredTokens = {
  accessToken: string | null
  refreshToken: string | null
}

function normalizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function isAndroidNativeSessionRuntime(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

function resolveWindowNativeSocket(): NativeSocketPlugin | null {
  if (typeof window === 'undefined') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (window as any).Capacitor?.Plugins?.NativeSocket
    return plugin ?? null
  } catch {
    return null
  }
}

function resolveNativeSocketPlugin(): NativeSocketPlugin | null {
  return resolveWindowNativeSocket() ?? NativeSocket ?? null
}

export async function syncNativeTokens(accessToken: string, refreshToken?: string | null): Promise<boolean> {
  if (!isAndroidNativeSessionRuntime()) return false
  const plugin = resolveNativeSocketPlugin()
  if (!plugin || typeof plugin.updateToken !== 'function') return false
  await plugin.updateToken({
    token: accessToken,
    refreshToken: refreshToken ?? undefined,
  })
  return true
}

export async function clearNativeTokens(): Promise<boolean> {
  if (!isAndroidNativeSessionRuntime()) return false
  const plugin = resolveNativeSocketPlugin()
  if (!plugin) return false
  if (typeof plugin.clearTokens === 'function') {
    await plugin.clearTokens()
    return true
  }
  if (typeof plugin.updateToken === 'function') {
    await plugin.updateToken({ token: '', refreshToken: '' })
    return true
  }
  return false
}

export async function getNativeStoredTokens(): Promise<NativeStoredTokens | null> {
  if (!isAndroidNativeSessionRuntime()) return null
  const plugin = resolveNativeSocketPlugin()
  if (!plugin || typeof plugin.getStoredTokens !== 'function') return null
  const result = await plugin.getStoredTokens()
  return {
    accessToken: normalizeToken(result?.token),
    refreshToken: normalizeToken(result?.refreshToken),
  }
}
