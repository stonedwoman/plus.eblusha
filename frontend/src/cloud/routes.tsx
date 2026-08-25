import { Suspense, lazy, type ReactNode } from 'react'
import type { RouteObject } from 'react-router-dom'

/**
 * Маршруты Cloud, собираемые под нужным префиксом.
 *
 *   cloudRoutes('')        → eblusha.cloud/, /space/:id, /s/:publicId
 *   cloudRoutes('/cloud')  → eblusha.org/cloud, /cloud/space/:id, …
 *
 * Дети объявлены относительными путями, поэтому один и тот же список работает
 * в обоих раскладах без дублирования.
 */
const CloudLayout = lazy(() => import('./pages/CloudLayout'))
const CloudHome = lazy(() => import('./pages/CloudHome'))
const CloudSpace = lazy(() => import('./pages/SpacePage'))
const CloudFeed = lazy(() => import('./pages/FeedPage'))
const CloudJoin = lazy(() => import('./pages/JoinPage'))
const CloudShare = lazy(() => import('./pages/SharePage'))
const CloudAdminStorage = lazy(() => import('./pages/AdminStoragePage'))
const CloudCallback = lazy(() => import('./pages/CloudCallbackPage'))

const withSuspense = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>

/**
 * Свой экран падения вместо стандартного белого «Unexpected Application Error!»
 * react-router. Ошибка рендера любой страницы Cloud не должна выглядеть как
 * смерть всего приложения: даём перезагрузить или вернуться к списку хуяпок.
 */
function CloudErrorPage() {
  return (
    <div className="cl-root">
      <div className="cl-page narrow">
        <div className="cl-empty" style={{ marginTop: 60 }}>
          <div style={{ fontSize: 44 }}>💥</div>
          <h3>Что-то сломалось</h3>
          <p>Страница упала с ошибкой. Это наша вина, не ваша.</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
            <button className="cl-btn primary" onClick={() => window.location.reload()}>
              Перезагрузить
            </button>
            <button className="cl-btn" onClick={() => (window.location.href = '/')}>
              К хуяпкам
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function cloudRoutes(prefix: '' | '/cloud'): RouteObject[] {
  return [
    // Публичная share-ссылка: открывают люди без Еблуши, никакого гейта.
    { path: `${prefix}/s/:publicId`, element: withSuspense(<CloudShare />), errorElement: <CloudErrorPage /> },
    // Возврат с кодом: сессии Cloud тут ещё нет, она здесь и создаётся.
    { path: `${prefix}/callback`, element: withSuspense(<CloudCallback />) },
    {
      // Под ProtectedRoute НЕ ставим: на выделенном домене токена мессенджера
      // в localStorage нет и быть не может. Гейт — CloudLayout.
      path: prefix || '/',
      element: withSuspense(<CloudLayout />),
      errorElement: <CloudErrorPage />,
      children: [
        { index: true, element: withSuspense(<CloudHome />) },
        { path: 'space/:spaceId', element: withSuspense(<CloudSpace />) },
        { path: 'recent', element: withSuspense(<CloudFeed />) },
        { path: 'uploads', element: withSuspense(<CloudFeed />) },
        { path: 'trash', element: withSuspense(<CloudFeed />) },
        { path: 'join/:publicId', element: withSuspense(<CloudJoin />) },
        { path: 'admin/storage', element: withSuspense(<CloudAdminStorage />) },
      ],
    },
  ]
}
