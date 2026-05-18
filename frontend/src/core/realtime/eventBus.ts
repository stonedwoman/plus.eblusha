type Listener<T> = (payload: T) => void

export class EventBus<TEventMap extends Record<string, any>> {
  private listeners = new Map<keyof TEventMap, Set<Listener<any>>>()

  on<K extends keyof TEventMap>(event: K, listener: Listener<TEventMap[K]>): () => void {
    const bucket = this.listeners.get(event) ?? new Set()
    bucket.add(listener as Listener<any>)
    this.listeners.set(event, bucket)
    return () => {
      bucket.delete(listener as Listener<any>)
      if (bucket.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  emit<K extends keyof TEventMap>(event: K, payload: TEventMap[K]): void {
    const bucket = this.listeners.get(event)
    if (!bucket) return
    for (const listener of bucket) {
      try {
        listener(payload)
      } catch {
        // ignore listener errors so one bad consumer does not break fan-out
      }
    }
  }
}
