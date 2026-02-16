function envEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (import.meta as any).env ?? {}
    const v = String(env?.VITE_SECRET_ENGINE_V2 ?? '').trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'yes'
  } catch {
    return false
  }
}

function queryEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const q = new URLSearchParams(window.location.search).get('SECRET_ENGINE_V2')
    if (!q) return false
    const v = q.trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'yes'
  } catch {
    return false
  }
}

function localStorageEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const raw = String(window.localStorage.getItem('SECRET_ENGINE_V2') ?? '').trim().toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes'
  } catch {
    return false
  }
}

export function isSecretEngineV2Enabled(): boolean {
  return queryEnabled() || localStorageEnabled() || envEnabled()
}

