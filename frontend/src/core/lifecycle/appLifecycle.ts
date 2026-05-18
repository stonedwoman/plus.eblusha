export type NetworkChangePayload = {
  online: boolean
  transport?: 'wifi' | 'cellular' | 'none'
  metered?: boolean
}

type LifecycleEventMap = {
  foreground: undefined
  background: undefined
  focus: undefined
  blur: undefined
  networkChange: NetworkChangePayload
}

type EventName = keyof LifecycleEventMap
type Listener<K extends EventName> = (payload: LifecycleEventMap[K]) => void

class AppLifecycle {
  private listeners: {
    [K in EventName]: Set<Listener<K>>
  } = {
    foreground: new Set(),
    background: new Set(),
    focus: new Set(),
    blur: new Set(),
    networkChange: new Set(),
  }

  private browserBound = false

  on<K extends EventName>(event: K, listener: Listener<K>): () => void {
    const bucket = this.listeners[event] as Set<Listener<K>>
    bucket.add(listener)
    return () => {
      bucket.delete(listener)
    }
  }

  emit<K extends EventName>(event: K, payload: LifecycleEventMap[K]): void {
    const bucket = this.listeners[event] as Set<Listener<K>>
    for (const listener of bucket) {
      try {
        listener(payload)
      } catch {
        // ignore listener errors so lifecycle fan-out stays resilient
      }
    }
  }

  bindBrowserLifecycle(): void {
    if (this.browserBound || typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }
    this.browserBound = true

    const emitVisibility = () => {
      if (document.visibilityState === 'visible') {
        this.emit('foreground', undefined)
      } else {
        this.emit('background', undefined)
      }
    }

    const emitOnline = () => {
      this.emit('networkChange', {
        online: navigator.onLine,
        transport: navigator.onLine ? undefined : 'none',
      })
    }

    document.addEventListener('visibilitychange', emitVisibility)
    window.addEventListener('focus', () => this.emit('focus', undefined))
    window.addEventListener('blur', () => this.emit('blur', undefined))
    window.addEventListener('online', emitOnline)
    window.addEventListener('offline', emitOnline)
  }
}

export const appLifecycle = new AppLifecycle()
