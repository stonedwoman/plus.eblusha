/**
 * Dev-стенд «местного времени собеседника». Только dev-сборка: /__dev/local-time — в production
 * маршрута и чанка нет.
 *
 * Шапки диалогов 1:1 с настоящим PeerLocalTimeLine под строкой статуса (те же размеры, что в
 * MessagesPane): город, пояс без города («UTC+7»), летнее время, пояс, которого браузер не знает
 * (по смещению с сервера), собеседник с моим временем (строки нет) и группа (строки нет никогда).
 * Кнопки имитируют сокет-событие localtime:update: сменил пояс / скрыл время.
 */
import { useState, type CSSProperties } from 'react'
import { Avatar } from '../components/Avatar'
import { PeerLocalTimeLine } from '../pages/chats/components/PeerLocalTimeLine'
import { setPeerLocalTime } from '../../domain/localTime/localTimeStore'
import { formatPeerLocalTime, type LocalTimeInfo } from '../../domain/localTime/localTime'

const KRSK: LocalTimeInfo = { timeZone: 'Asia/Krasnoyarsk', city: 'Красноярск', offsetMinutes: 420 }
const BUCH: LocalTimeInfo = { timeZone: 'Europe/Bucharest', city: 'Бухарест', offsetMinutes: 180 }
const ROTATION: LocalTimeInfo[] = [
  KRSK,
  BUCH,
  { timeZone: 'Asia/Calcutta', city: 'Калькутта', offsetMinutes: 330 },
  { timeZone: 'America/Sao_Paulo', city: 'Сан-Паулу', offsetMinutes: -180 },
]

function myZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

const SAME_AS_MINE: LocalTimeInfo = { timeZone: myZone(), city: 'Мой город', offsetMinutes: -new Date().getTimezoneOffset() }

const ROWS: Array<{ id: string; name: string; status: string; info: LocalTimeInfo | null; note: string }> = [
  { id: 'demo-lt-krsk', name: 'Катя', status: 'В сети', info: KRSK, note: 'город по-русски' },
  { id: 'demo-lt-gmt7', name: 'Миша', status: 'В фоне', info: { timeZone: 'Etc/GMT-7', city: null, offsetMinutes: 420 }, note: 'пояс без города — смещение' },
  { id: 'demo-lt-buch', name: 'Оля', status: 'был(а) онлайн 5 мин назад', info: BUCH, note: 'летнее время — по базе поясов' },
  { id: 'demo-lt-mars', name: 'Вася', status: 'В сети', info: { timeZone: 'Mars/Olympus_Mons', city: null, offsetMinutes: 330 }, note: 'неизвестный браузеру пояс — по смещению с сервера' },
  { id: 'demo-lt-same', name: 'Дима', status: 'В сети', info: SAME_AS_MINE, note: 'время как у меня — строки нет' },
  { id: 'demo-lt-hidden', name: 'Лена', status: 'В сети', info: null, note: 'скрыла время / не собеседник — строки нет' },
]

const card: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  border: '1px solid var(--surface-border)',
  borderRadius: 14,
  background: 'var(--surface-100)',
  width: 420,
  maxWidth: '100%',
}
const statusCol: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-muted)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  lineHeight: 1.15,
}

export default function LocalTimeDemo() {
  const [step, setStep] = useState(0)
  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--text-primary)', minHeight: '100vh', background: 'var(--surface-50, var(--bg))' }}>
      <div style={{ fontWeight: 800, fontSize: 18 }}>Местное время собеседника (dev)</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Мой пояс: {myZone()}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn btn-secondary"
          onClick={() => {
            const next = (step + 1) % ROTATION.length
            setStep(next)
            setPeerLocalTime('demo-lt-krsk', ROTATION[next]!)
          }}
        >
          Катя сменила пояс
        </button>
        <button className="btn btn-secondary" onClick={() => setPeerLocalTime('demo-lt-krsk', null)}>
          Катя скрыла время
        </button>
        <button className="btn btn-secondary" onClick={() => setPeerLocalTime('demo-lt-krsk', ROTATION[step]!)}>
          Катя снова показывает
        </button>
      </div>
      {ROWS.map((r) => (
        <div key={r.id} style={card}>
          <Avatar name={r.name} id={r.id} size={60} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{r.name}</div>
            <div style={statusCol}>
              <span>{r.status}</span>
              <PeerLocalTimeLine peerId={r.id} listLocalTime={r.info} refresh={false} />
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', width: 150, textAlign: 'right' }}>
            {r.note}
            <br />
            <code>{String(formatPeerLocalTime(r.info, new Date()))}</code>
          </div>
        </div>
      ))}
      <div style={card}>
        <Avatar name="Группа" id="demo-lt-group" size={60} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>Ереванский Городовой</div>
          <div style={statusCol}>
            <span>3 участника</span>
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', width: 150, textAlign: 'right' }}>группа — строки нет никогда</div>
      </div>
    </div>
  )
}
