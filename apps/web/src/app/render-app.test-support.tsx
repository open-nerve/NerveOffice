// 测试用：用内存路由渲染整个平台应用（与生产相同的路由表、请求缓存与会话的全局处理）。
// 整页跳转与标签页之间的消息换成假实现：jsdom 不支持整页跳转；另一个"标签页"由同一条假的消息通道上的另一端模拟。
import type { PageLocation } from '../shared/lib/page-location.ts'
import type { SessionChannel } from '../shared/lib/session-channel.ts'
import type { AppRuntime } from './runtime.ts'
import { render } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { onTestFinished } from 'vitest'
import { App } from './app.tsx'
import { createAppRuntime } from './runtime.ts'

/** 整页跳转的记录：replace 记下地址，reload 记为 'reload' */
export interface RecordedPage extends PageLocation {
  readonly visits: readonly string[]
}

export function recordingPage(): RecordedPage {
  const visits: string[] = []
  return { visits, replace: url => visits.push(url), reload: () => visits.push('reload') }
}

/** 同一个浏览器里各个标签页之间的会话消息。与 BroadcastChannel 相同：发出的一端自己收不到 */
export function sessionBus(): { open: () => SessionChannel } {
  const listeners = new Map<symbol, Set<() => void>>()
  return {
    open: () => {
      const endpoint = Symbol('标签页')
      const own = new Set<() => void>()
      listeners.set(endpoint, own)
      return {
        announce: () => {
          for (const [other, set] of listeners) {
            if (other !== endpoint)
              set.forEach(listener => listener())
          }
        },
        subscribe: (listener) => {
          own.add(listener)
          return () => own.delete(listener)
        },
        close: () => listeners.delete(endpoint),
      }
    },
  }
}

export interface RenderedApp extends AppRuntime {
  readonly page: RecordedPage
}

export function renderApp(initialPath: string, options: { sessionChannel?: SessionChannel } = {}): RenderedApp {
  const page = recordingPage()
  const runtime = createAppRuntime({
    createRouter: routes => createMemoryRouter(routes, { initialEntries: [initialPath] }),
    page,
    sessionChannel: options.sessionChannel ?? sessionBus().open(),
  })
  render(<App runtime={runtime} />)
  onTestFinished(() => runtime.dispose())
  return { ...runtime, page }
}

export function currentPath(runtime: AppRuntime): string {
  const { pathname, search } = runtime.router.state.location
  return `${pathname}${search}`
}
