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


