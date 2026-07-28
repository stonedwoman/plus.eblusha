import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'
import { RouterProvider } from 'react-router-dom'
import { Suspense } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { appRouter } from './router-app'
import { useAppStore } from './domain/store/appStore'
import { connectSocket } from './core/realtime'
import { validateStoredSession } from './core/auth'
import { appLifecycle } from './core/lifecycle/appLifecycle'
import { nativeBridge } from './platform/native-bridge/bridge'

// Пробуждение вкладки раньше запускало ~10 одновременных рефетчей (голый клиент =
// staleTime 0 + refetchOnWindowFocus), и КАЖДЫЙ ответ дёргал каскад рендеров тяжёлой
// страницы чатов. Свежесть на возврате обеспечивает syncAfterResume (адресные
// invalidate + socket-события), поэтому автo-рефетч по фокусу выключен, а короткий
// staleTime гасит дубли запросов, летящие подряд.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
})
appLifecycle.bindBrowserLifecycle()
nativeBridge.installGlobals()

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







