import { createBrowserRouter, type RouteObject } from 'react-router-dom'
import { Suspense, lazy, type ReactNode } from 'react'
import { ProtectedRoute } from './ui/components/ProtectedRoute'
import LoadingSpinner from './ui/components/LoadingSpinner'
import { Static404Redirect } from './ui/components/Static404Redirect'
import { cloudRoutes } from './cloud/routes'
import { CLOUD_ROOT_MODE } from './cloud/basePath'
const CloudAuthorize = lazy(() => import('./cloud/pages/CloudAuthorizePage'))

const AppLayout = lazy(() => import('./ui/layouts/AppLayout'))
const ChatsPage = lazy(() => import('./ui/pages/ChatsPage'))
const MobileChatsRoute = lazy(() => import('./ui/web-mobile/MobileChatsRoute').then((module) => ({ default: module.MobileChatsRoute })))
const ContactsPage = lazy(() => import('./ui/pages/ContactsPage'))
const SettingsPage = lazy(() => import('./ui/pages/SettingsPage'))


const withSuspense = (node: ReactNode) => (
  <Suspense fallback={null}>{node}</Suspense>
)

const messengerRoutes: RouteObject[] = [
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
]

/**
 * На выделенном домене (eblusha.cloud) монтируется ТОЛЬКО Cloud: маршруты
 * мессенджера там не нужны и не должны перехватывать корень.
 * Рядом с мессенджером Cloud живёт под /cloud, как и раньше, плюс /cloud-auth —
 * страница выдачи кода, которой место только на origin мессенджера.
 */
export const appRouter = createBrowserRouter(
  CLOUD_ROOT_MODE
    ? cloudRoutes('')
    : [
        ...cloudRoutes('/cloud'),
        {
          path: '/cloud-auth',
          element: <ProtectedRoute />,
          children: [{ index: true, element: withSuspense(<CloudAuthorize />) }],
        },
        ...messengerRoutes,
      ]
)
