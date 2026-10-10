/**
 * Настройка «Показывать моё местное время» (по умолчанию включена). Живёт в профиле (десктоп) и на
 * экране «Настройки» (узкий веб).
 *
 * Сервер: GET/PUT /status/me/local-time → {shareLocalTime, shareLocalTimeAt, localTime}. Выключено —
 * сервер не отдаёт мой пояс никому. Переключение с другого устройства приходит событием
 * localtime:settings (localTimeSync кладёт его в стор — переключатель обновится сам).
 * Старый сервер (404) — раздела не показываем вовсе.
 */
import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { api } from '../../utils/api'
import { systemToast } from '../../domain/store/systemUiStore'
import { formatLocalTimeLabel, normalizeLocalTimeInfo, type LocalTimeInfo } from '../../domain/localTime/localTime'
import { useMinuteTick, useOwnShareState } from '../../domain/localTime/localTimeStore'
import { applyOwnLocalTimeStateFromServer } from '../../domain/localTime/localTimeSync'

type LoadState = 'loading' | 'ready' | 'unsupported'

export function LocalTimeSettingsSection() {
  const share = useOwnShareState()
  const [load, setLoad] = useState<LoadState>('loading')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<boolean | null>(null)
  const [visibleAs, setVisibleAs] = useState<LocalTimeInfo | null>(null)
  useMinuteTick()

  useEffect(() => {
    let cancelled = false
    api
      .get('/status/me/local-time')
      .then((res) => {
        if (cancelled) return
        applyOwnLocalTimeStateFromServer(res?.data)
        setVisibleAs(normalizeLocalTimeInfo((res?.data as { localTime?: unknown } | undefined)?.localTime) ?? null)
        setLoad('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const status = (err as { response?: { status?: number } } | null)?.response?.status
        setLoad(status === 404 ? 'unsupported' : 'ready')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Включили на другом устройстве, а мы знаем только «выключено» (тогда сервер пояс не отдаёт) —
  // дочитать, какой пояс теперь видят собеседники.
  const sharedNow = share?.shareLocalTime === true
  useEffect(() => {
    if (load !== 'ready' || busy || !sharedNow || visibleAs) return
    let cancelled = false
    api
      .get('/status/me/local-time')
      .then((res) => {
        if (!cancelled) setVisibleAs(normalizeLocalTimeInfo((res?.data as { localTime?: unknown } | undefined)?.localTime) ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, sharedNow])

  if (load === 'unsupported') return null

  const checked = pending ?? (share ? share.shareLocalTime : true)

  const toggle = async (next: boolean) => {
    if (busy) return
    setBusy(true)
    setPending(next)
    try {
      const res = await api.put('/status/me/local-time', { shareLocalTime: next })
      applyOwnLocalTimeStateFromServer(res?.data)
      setVisibleAs(normalizeLocalTimeInfo((res?.data as { localTime?: unknown } | undefined)?.localTime) ?? null)
      systemToast.success(next ? 'Собеседники снова видят ваше местное время' : 'Ваше местное время больше никому не видно')
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status
      systemToast.error(status === 429 ? 'Слишком часто — подождите минуту' : 'Не удалось сохранить настройку')
    } finally {
      setPending(null)
      setBusy(false)
    }
  }

  const seen = checked && !busy ? formatLocalTimeLabel(visibleAs, new Date()) : null

  return (
    <div style={{ marginBottom: 18, border: '1px solid var(--surface-border)', borderRadius: 14, background: 'var(--surface-100)', padding: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text-muted)', letterSpacing: 0.2, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Clock size={14} /> МЕСТНОЕ ВРЕМЯ
      </div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: busy || load === 'loading' ? 'default' : 'pointer', userSelect: 'none' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={busy || load === 'loading'}
          onChange={(e) => {
            void toggle(e.target.checked)
          }}
          style={{ marginTop: 3 }}
        />
        <span>
          <div style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 600 }}>Показывать моё местное время</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.45, marginTop: 3 }}>
            В личных чатах собеседник видит под вашим статусом, который у вас час, и город — например, «14:30, Красноярск».
            Берётся часовой пояс устройства, которым вы пользовались последним. В группах время не показывается.
            Выключите — и его не увидит никто.
          </div>
          {seen ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>
              Сейчас видно: <span style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{seen}</span>
            </div>
          ) : null}
        </span>
      </label>
    </div>
  )
}
