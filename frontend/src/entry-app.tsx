import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'
import { RouterProvider } from 'react-router-dom'
import { Suspense } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { appRouter } from './router-app'
import { useAppStore } from './domain/store/appStore'
import { connectSocket } from './utils/socket'
import { api } from './utils/api'

const queryClient = new QueryClient()

async function validateStoredSession(): Promise<boolean> {
  const session = useAppStore.getState().session
  if (!session) return false
  try {
    const response = await api.get('/status/me')
    if (response.data?.user) {
      useAppStore.getState().setSession({
        ...session,
        user: {
          id: response.data.user.id,
          username: response.data.user.username,
          displayName: response.data.user.displayName,
          avatarUrl: response.data.user.avatarUrl,
        },
      })
      return true
    }
    return false
  } catch {
    useAppStore.getState().setSession(null)
    return false
  }
}

function AppRoot() {
  const hydrated = useAppStore((s) => s.hydrated)
  const session = useAppStore((s) => s.session)
  const [checking, setChecking] = React.useState(true)

  React.useEffect(() => {
    useAppStore.getState().initFromStorage()
    validateStoredSession().finally(() => setChecking(false))
  }, [])

  React.useEffect(() => {
    if (hydrated && !checking) connectSocket()
  }, [hydrated, checking, session])

  if (checking || !hydrated) return null

  return (
    <Suspense fallback={null}>
      <RouterProvider router={appRouter} />
    </Suspense>
  )
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppRoot />
    </QueryClientProvider>
  </React.StrictMode>,
)







