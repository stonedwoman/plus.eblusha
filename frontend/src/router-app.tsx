import { createBrowserRouter } from 'react-router-dom'
import { Suspense, lazy, type ReactNode } from 'react'
import { ProtectedRoute } from './ui/components/ProtectedRoute'

const AppLayout = lazy(() => import('./ui/layouts/AppLayout'))
const ChatsPage = lazy(() => import('./ui/pages/ChatsPage'))
const ContactsPage = lazy(() => import('./ui/pages/ContactsPage'))
const CallsPage = lazy(() => import('./ui/pages/CallsPage'))
const SettingsPage = lazy(() => import('./ui/pages/SettingsPage'))

const withSuspense = (node: ReactNode) => (
  <Suspense fallback={<div className="page-loading">Загрузка…</div>}>{node}</Suspense>
)

export const appRouter = createBrowserRouter([
  // Serve app under /app
  {
    path: '/app',
    element: <ProtectedRoute />,
    children: [
      {
        element: withSuspense(<AppLayout />),
        children: [
          { index: true, element: withSuspense(<ChatsPage />) },
          { path: 'contacts', element: withSuspense(<ContactsPage />) },
          { path: 'calls', element: withSuspense(<CallsPage />) },
          { path: 'settings', element: withSuspense(<SettingsPage />) },
        ],
      },
    ],
  },
  // Also serve the same app at /
  {
    path: '/',
    element: <ProtectedRoute />,
    children: [
      {
        element: withSuspense(<AppLayout />),
        children: [
          { index: true, element: withSuspense(<ChatsPage />) },
          { path: 'contacts', element: withSuspense(<ContactsPage />) },
          { path: 'calls', element: withSuspense(<CallsPage />) },
          { path: 'settings', element: withSuspense(<SettingsPage />) },
        ],
      },
    ],
  },
])


