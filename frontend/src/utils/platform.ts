const ANDROID_APK_UA_MARKER = 'EblushaAndroidAPK/1'

declare global {
  interface Window {
    __EBLUSHA_ANDROID_APK__?: boolean
  }
}

export function isAndroidApkShell(): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgent.includes(ANDROID_APK_UA_MARKER)) {
      return true
    }
  } catch {}

  try {
    if (typeof window !== 'undefined' && window.__EBLUSHA_ANDROID_APK__ === true) {
      return true
    }
  } catch {}

  return false
}

export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const capacitor = (window as any).Capacitor
    if (!capacitor || typeof capacitor.isNativePlatform !== 'function') return false
    return Boolean(capacitor.isNativePlatform())
  } catch {
    return false
  }
}

export function isNativeAppRuntime(): boolean {
  return isNativePlatform() || isAndroidApkShell()
}

export function isIosBrowserRuntime(): boolean {
  if (isNativeAppRuntime()) return false
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /iP(ad|hone|od)/i.test(ua)
}


