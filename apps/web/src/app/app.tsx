import type { AppRuntime } from './runtime.ts'
import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { RouterProvider } from 'react-router'
import { createAppRuntime } from './runtime.ts'

/** 平台页面的根组件：请求缓存与路由。 */
export function App({ runtime }: { runtime?: AppRuntime }) {
  const [{ router, queryClient }] = useState(() => runtime ?? createAppRuntime())
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
