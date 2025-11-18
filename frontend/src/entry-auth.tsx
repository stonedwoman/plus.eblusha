import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'
import { RouterProvider } from 'react-router-dom'
import { Suspense } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { authRouter } from './router-auth'

const queryClient = new QueryClient()

function Root() {
  return (
    <Suspense fallback={null}>
      <RouterProvider router={authRouter} />
    </Suspense>
  )
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </React.StrictMode>,
)







