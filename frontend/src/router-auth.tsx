import { createBrowserRouter } from 'react-router-dom'
import { Suspense, lazy, type ReactNode } from 'react'
import { PublicRoute } from './ui/components/PublicRoute'

const AuthLayout = lazy(() => import('./ui/layouts/AuthLayout'))
const LoginPage = lazy(() => import('./ui/pages/LoginPage'))
const RegisterPage = lazy(() => import('./ui/pages/RegisterPage'))

const withSuspense = (node: ReactNode) => (
  <Suspense fallback={<div className="page-loading">Загрузка…</div>}>{node}</Suspense>
)

export const authRouter = createBrowserRouter([
  {
    path: '/auth',
    element: <PublicRoute />,
    children: [
      {
        element: withSuspense(<AuthLayout />),
        children: [
          { index: true, element: withSuspense(<LoginPage />) },
          { path: 'register', element: withSuspense(<RegisterPage />) },
        ],
      },
    ],
  },
])







