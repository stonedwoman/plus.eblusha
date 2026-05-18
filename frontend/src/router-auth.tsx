import { createBrowserRouter } from 'react-router-dom'
import { Suspense, lazy, type ReactNode } from 'react'
import { PublicRoute } from './ui/components/PublicRoute'
import LoadingSpinner from './ui/components/LoadingSpinner'
import { Static404Redirect } from './ui/components/Static404Redirect'

const AuthLayout = lazy(() => import('./ui/layouts/AuthLayout'))
const LoginPage = lazy(() => import('./ui/pages/LoginPage'))
const RegisterPage = lazy(() => import('./ui/pages/RegisterPage'))

const withSuspense = (node: ReactNode) => (
  <Suspense fallback={null}>{node}</Suspense>
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
          { path: '*', element: <Static404Redirect /> },
        ],
      },
    ],
  },
])







