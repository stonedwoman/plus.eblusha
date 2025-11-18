import { Navigate, Outlet } from 'react-router-dom'
import { useAppStore } from '../../domain/store/appStore'

export function PublicRoute() {
  const session = useAppStore((state) => state.session)

  if (session) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}




