/**
 * Адреса /settings и /settings/<раздел> (и /app/settings…) открывают «Центр управления» поверх чатов:
 * перенаправляют на страницу чатов с ?settings=<раздел>. Прежняя страница /settings (статус, «О себе», имя, привязка
 * устройства, устройства) убрана: её пункты переехали в разделы центра, кроме выбора статуса и «О себе» —
 * их владелец велел убрать совсем (2026-10-11).
 */
import { Navigate, useLocation, useParams } from 'react-router-dom'
import { withAppRoutePrefix } from '../../core/navigation/routes'
import { parseSettingsParam, settingsParamValue } from '../settings/settingsNav'

export default function SettingsRoute() {
  const { section } = useParams<{ section?: string }>()
  const location = useLocation()
  const view = parseSettingsParam(section ?? null) ?? { kind: 'overview' as const }
  const to = `${withAppRoutePrefix(location.pathname, '/chats')}?settings=${settingsParamValue(view)}`
  return <Navigate to={to} replace />
}
