import { createBrowserRouter } from 'react-router-dom'
import { Suspense, lazy, type ReactNode } from 'react'
import { ProtectedRoute } from './ui/components/ProtectedRoute'
import { PublicRoute } from './ui/components/PublicRoute'
import LoadingSpinner from './ui/components/LoadingSpinner'

const AppLayout = lazy(() => import('./ui/layouts/AppLayout'))
const AuthLayout = lazy(() => import('./ui/layouts/AuthLayout'))
const LoginPage = lazy(() => import('./ui/pages/LoginPage'))
const RegisterPage = lazy(() => import('./ui/pages/RegisterPage'))
const ChatsPage = lazy(() => import('./ui/pages/ChatsPage'))
const ContactsPage = lazy(() => import('./ui/pages/ContactsPage'))
const CallsPage = lazy(() => import('./ui/pages/CallsPage'))
const SettingsPage = lazy(() => import('./ui/pages/SettingsPage'))

const withSuspense = (node: ReactNode) => (
  <Suspense fallback={null}>{node}</Suspense>
)

export const router = createBrowserRouter([
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




