/**
 * Шапка диалога 1:1: под строкой статуса мелкой серой строкой — местное время собеседника
 * («14:30, Красноярск»). Правила — в domain/localTime/localTime.ts.
 *
 * Откуда берётся пояс (по убыванию свежести):
 *  1) живое значение из стора: событие localtime:update или ответ GET /users/:id/local-time —
 *     его запрашиваем при открытии диалога и после каждого переподключения сокета;
 *  2) пока живого нет — то, что пришло в списке бесед (participants[].user.localTime).
 * Старый сервер не присылает ни того, ни другого (404 на запрос) — строки просто нет.
 */
import { useEffect } from 'react'
import { api } from '../../../../utils/api'
import { formatPeerLocalTime, normalizeLocalTimeInfo, type LocalTimeInfo } from '../../../../domain/localTime/localTime'
import {
  setPeerLocalTime,
  useLocalTimeEpoch,
  useMinuteTick,
  usePeerLocalTime,
} from '../../../../domain/localTime/localTimeStore'

/** Пользователи, для которых сервер ответил 404 (старый сервер) — до следующего переподключения. */
const unsupportedAtEpoch = new Map<string, number>()

function usePeerLocalTimeRefresh(peerId: string | null): void {
  const epoch = useLocalTimeEpoch()
  useEffect(() => {
    if (!peerId) return
    if (unsupportedAtEpoch.get(peerId) === epoch) return
    let cancelled = false
    const startedAt = Date.now()
    api
      .get(`/users/${encodeURIComponent(peerId)}/local-time`)
      .then((res) => {
        if (cancelled) return
        const info = normalizeLocalTimeInfo((res?.data as { localTime?: unknown } | undefined)?.localTime)
        if (info === undefined) return // ответ без поля — не наш сервер, ничего не знаем
        // Событие, пришедшее, пока летел запрос, новее ответа — setPeerLocalTime его не затрёт.
        setPeerLocalTime(peerId, info, startedAt)
      })
      .catch((err: unknown) => {
        const status = (err as { response?: { status?: number } } | null)?.response?.status
        if (status === 404) unsupportedAtEpoch.set(peerId, epoch)
      })
    return () => {
      cancelled = true
    }
  }, [peerId, epoch])
}

export function PeerLocalTimeLine(props: {
  peerId: string | null | undefined
  listLocalTime?: unknown
  /** false — не запрашивать сервер (dev-стенд). */
  refresh?: boolean
}) {
  const peerId = typeof props.peerId === 'string' && props.peerId ? props.peerId : null
  usePeerLocalTimeRefresh(props.refresh === false ? null : peerId)
  const live = usePeerLocalTime(peerId)
  useMinuteTick()
  const fromList = normalizeLocalTimeInfo(props.listLocalTime)
  const info: LocalTimeInfo | null | undefined = live ? live.info : fromList
  const text = formatPeerLocalTime(info, new Date())
  if (!text) return null
  return (
    <span
      className="eb-peer-localtime"
      title="Местное время собеседника"
      style={{
        fontSize: 11.5,
        color: 'var(--text-muted)',
        opacity: 0.85,
        fontWeight: 400,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
      }}
    >
      {text}
    </span>
  )
}
