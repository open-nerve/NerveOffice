// 测试用：用内存路由渲染整个平台应用（与生产相同的路由表、请求缓存与全局的未登录处理）。
import type { AppRuntime } from './runtime.ts'
import { render } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { App } from './app.tsx'
import { createAppRuntime } from './runtime.ts'

export function renderApp(initialPath: string): AppRuntime {
  const runtime = createAppRuntime(routes => createMemoryRouter(routes, { initialEntries: [initialPath] }))
  render(<App runtime={runtime} />)
  return runtime
}

export function currentPath(runtime: AppRuntime): string {
  const { pathname, search } = runtime.router.state.location
  return `${pathname}${search}`
}
