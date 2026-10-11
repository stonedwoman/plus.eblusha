/**
 * Dev-стенд «Настройки» из панели звонка: настоящий CallSettings (центр настроек внутри комнаты LiveKit, раздел
 * «Звук и видео», вкладка «Устройства») в офлайн-комнате — без сервера звонков. Только dev-сборка:
 * /__dev/settings-call — в production маршрута и чанка нет. Кнопка с шестерёнкой — штатная кнопка LiveKit.
 */
import { LiveKitRoom, VideoConference } from '@livekit/components-react'
import '@livekit/components-styles'
import { CallSettings } from '../components/CallOverlay'

export default function SettingsCallDemo() {
  return (
    <div className="call-container" style={{ position: 'fixed', inset: 0, background: '#0f1217' }}>
      <LiveKitRoom serverUrl="ws://127.0.0.1:9" token="demo" connect={false} audio={false} video={false} data-lk-theme="default" style={{ height: '100%' }}>
        <VideoConference SettingsComponent={CallSettings} />
      </LiveKitRoom>
    </div>
  )
}
