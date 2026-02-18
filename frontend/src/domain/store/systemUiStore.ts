import { create } from 'zustand'

export type ToastVariant = 'success' | 'error' | 'info'

export type ToastItem = {
  id: string
  variant: ToastVariant
  title?: string
  message: string
  createdAt: number
  ttlMs: number
}

export type ConfirmRequest = {
  id: string
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export type NewSessionPayload = {
  deviceId: string
  deviceName?: string
  platform?: string
}

type State = {
  toasts: ToastItem[]
  confirm: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null
  newSessionPopup: (NewSessionPayload & { resolve: (action: 'ok' | 'forbid') => void }) | null
  pushToast: (t: Omit<ToastItem, 'id' | 'createdAt'> & Partial<Pick<ToastItem, 'id' | 'createdAt'>>) => string
  dismissToast: (id: string) => void
  requestConfirm: (req: Omit<ConfirmRequest, 'id'> & Partial<Pick<ConfirmRequest, 'id'>>) => Promise<boolean>
  resolveConfirm: (ok: boolean) => void
  requestNewSessionPopup: (payload: NewSessionPayload) => Promise<'ok' | 'forbid'>
  resolveNewSessionPopup: (action: 'ok' | 'forbid') => void
}

function rid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const useSystemUiStore = create<State>((set, get) => ({
  toasts: [],
  confirm: null,
  newSessionPopup: null,
  pushToast: (t) => {
    const id = String(t.id ?? rid())
    const item: ToastItem = {
      id,
      variant: t.variant,
      title: t.title,
      message: String(t.message ?? ''),
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      ttlMs: typeof t.ttlMs === 'number' ? t.ttlMs : 3200,
    }
    set((s) => ({ toasts: [...s.toasts, item].slice(-6) }))
    return id
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  requestConfirm: (req) => {
    const id = String(req.id ?? rid())
    return new Promise<boolean>((resolve) => {
      set({
        confirm: {
          id,
          title: String(req.title ?? '').trim() || 'Подтвердите действие',
          message: req.message ? String(req.message) : undefined,
          confirmText: req.confirmText ? String(req.confirmText) : undefined,
          cancelText: req.cancelText ? String(req.cancelText) : undefined,
          danger: !!req.danger,
          resolve,
        },
      })
    })
  },
  resolveConfirm: (ok) => {
    const c = get().confirm
    if (!c) return
    try {
      c.resolve(!!ok)
    } catch {}
    set({ confirm: null })
  },
  requestNewSessionPopup: (payload) =>
    new Promise<'ok' | 'forbid'>((resolve) => {
      set({ newSessionPopup: { ...payload, resolve } })
    }),
  resolveNewSessionPopup: (action) => {
    const popup = get().newSessionPopup
    if (!popup) return
    try {
      popup.resolve(action)
    } catch {}
    set({ newSessionPopup: null })
  },
}))

export const systemToast = {
  success(message: string, opts?: { title?: string; ttlMs?: number }) {
    useSystemUiStore.getState().pushToast({ variant: 'success', message, title: opts?.title, ttlMs: opts?.ttlMs ?? 3200 })
  },
  error(message: string, opts?: { title?: string; ttlMs?: number }) {
    useSystemUiStore.getState().pushToast({ variant: 'error', message, title: opts?.title, ttlMs: opts?.ttlMs ?? 4200 })
  },
  info(message: string, opts?: { title?: string; ttlMs?: number }) {
    useSystemUiStore.getState().pushToast({ variant: 'info', message, title: opts?.title, ttlMs: opts?.ttlMs ?? 3200 })
  },
}

export function systemConfirm(req: Omit<ConfirmRequest, 'id'> & Partial<Pick<ConfirmRequest, 'id'>>): Promise<boolean> {
  return useSystemUiStore.getState().requestConfirm(req)
}

