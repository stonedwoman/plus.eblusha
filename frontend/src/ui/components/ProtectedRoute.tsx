import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAppStore } from '../../domain/store/appStore'

export function ProtectedRoute() {
  const session = useAppStore((state) => state.session)
  const hydrated = useAppStore((state) => state.hydrated)
  const location = useLocation()

  if (!hydrated) return null
  if (!session) {
    return <Navigate to="/auth" replace state={{ from: location }} />
  }

  return <Outlet />
}




