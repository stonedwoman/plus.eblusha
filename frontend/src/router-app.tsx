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

// Eblusha Cloud (см. router.tsx) — те же маршруты в сборке под /app.
const CloudLayout = lazy(() => import('./cloud/pages/CloudLayout'))
const CloudHome = lazy(() => import('./cloud/pages/CloudHome'))
const CloudSpace = lazy(() => import('./cloud/pages/SpacePage'))
const CloudFeed = lazy(() => import('./cloud/pages/FeedPage'))
const CloudJoin = lazy(() => import('./cloud/pages/JoinPage'))
const CloudShare = lazy(() => import('./cloud/pages/SharePage'))
const CloudAdminStorage = lazy(() => import('./cloud/pages/AdminStoragePage'))
const CloudAuthorize = lazy(() => import('./cloud/pages/CloudAuthorizePage'))
const CloudCallback = lazy(() => import('./cloud/pages/CloudCallbackPage'))

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
  // Публичная share-ссылка: без входа вообще — её открывают люди без Еблуши.
  {
    path: '/cloud/s/:publicId',
    element: withSuspense(<CloudShare />),
  },
  // Возврат с кодом: сессии Cloud тут ещё нет, она здесь и создаётся.
  {
    path: '/cloud/callback',
    element: withSuspense(<CloudCallback />),
  },
  // Выдача кода живёт на origin МЕССЕНДЖЕРА, поэтому только здесь нужен
  // ProtectedRoute: без сессии Еблуши код взять неоткуда.
  {
    path: '/cloud-auth',
    element: <ProtectedRoute />,
    children: [{ index: true, element: withSuspense(<CloudAuthorize />) }],
  },
  // Сам Cloud под ProtectedRoute НЕ ставим: на отдельном поддомене токена
  // мессенджера в localStorage нет и быть не может. Гейт — CloudLayout, он
  // умеет и быстрый путь (один origin), и редирект за кодом (поддомен).
  {
    path: '/cloud',
    element: withSuspense(<CloudLayout />),
    children: [
      { index: true, element: withSuspense(<CloudHome />) },
      { path: 'space/:spaceId', element: withSuspense(<CloudSpace />) },
      { path: 'recent', element: withSuspense(<CloudFeed />) },
      { path: 'favorites', element: withSuspense(<CloudFeed />) },
      { path: 'uploads', element: withSuspense(<CloudFeed />) },
      { path: 'trash', element: withSuspense(<CloudFeed />) },
      { path: 'join/:publicId', element: withSuspense(<CloudJoin />) },
      { path: 'admin/storage', element: withSuspense(<CloudAdminStorage />) },
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


