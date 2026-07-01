import { createBrowserRouter } from 'react-router-dom'
import { Suspense, lazy, type ReactNode } from 'react'
import { ProtectedRoute } from './ui/components/ProtectedRoute'
import LoadingSpinner from './ui/components/LoadingSpinner'
import { Static404Redirect } from './ui/components/Static404Redirect'

const AppLayout = lazy(() => import('./ui/layouts/AppLayout'))
const ChatsPage = lazy(() => import('./ui/pages/ChatsPage'))
const MobileChatsRoute = lazy(() => import('./ui/web-mobile/MobileChatsRoute').then((module) => ({ default: module.MobileChatsRoute })))
const ContactsPage = lazy(() => import('./ui/pages/ContactsPage'))
const SettingsPage = lazy(() => import('./ui/pages/SettingsPage'))

const withSuspense = (node: ReactNode) => (
  <Suspense fallback={null}>{node}</Suspense>
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
          { path: 'chats', element: withSuspense(<MobileChatsRoute />) },
          { path: 'chats/:conversationId', element: withSuspense(<MobileChatsRoute />) },
          { path: 'contacts', element: withSuspense(<ContactsPage />) },
          { path: 'settings', element: withSuspense(<SettingsPage />) },
          { path: '*', element: <Static404Redirect /> },
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
          { path: 'chats', element: withSuspense(<MobileChatsRoute />) },
          { path: 'chats/:conversationId', element: withSuspense(<MobileChatsRoute />) },
          { path: 'contacts', element: withSuspense(<ContactsPage />) },
          { path: 'settings', element: withSuspense(<SettingsPage />) },
          { path: '*', element: <Static404Redirect /> },
        ],
      },
    ],
  },
])


