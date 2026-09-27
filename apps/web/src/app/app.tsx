import type { AppRuntime } from './runtime.ts'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { PageLocationContext } from '../shared/lib/page-location.ts'

/**
 * 平台页面的根组件：整页跳转、请求缓存与路由。运行时在 React 之外建好传进来（entries/platform/mount.tsx；测试用内存路由建）：
 * 在组件里建的话，StrictMode 的开发模式会多建一份路由且不释放（审查 B22）。
 */
export function App({ runtime }: { runtime: AppRuntime }) {
  return (
    <PageLocationContext value={runtime.page}>
      <QueryClientProvider client={runtime.queryClient}>
        <RouterProvider router={runtime.router} />
      </QueryClientProvider>
    </PageLocationContext>
  )
}
