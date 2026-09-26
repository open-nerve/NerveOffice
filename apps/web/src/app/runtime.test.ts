// 运行时的组装：默认用浏览器的实现；与会话无关的请求不触发会话的全局处理。流程见 app.test.tsx。
import { MutationObserver } from '@tanstack/react-query'
import { createMemoryRouter } from 'react-router'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ApiError } from '../shared/api/index.ts'
import { recordingPage, sessionBus } from './render-app.test-support.tsx'
import { createAppRuntime } from './runtime.ts'

describe('createAppRuntime', () => {
  it('默认用浏览器的路由、整页跳转与 BroadcastChannel', () => {
    const runtime = createAppRuntime()
    onTestFinished(() => runtime.dispose())
    expect(runtime.router.state.location.pathname).toBe(window.location.pathname)
  })

  it('与会话无关的变更：成功与失败（不是未登录、不是 CSRF）都不触发会话的处理', async () => {
    const page = recordingPage()
    const bus = sessionBus()
    const otherTab = vi.fn()
    bus.open().subscribe(otherTab)
    const runtime = createAppRuntime({ createRouter: routes => createMemoryRouter(routes, { initialEntries: ['/'] }), page, sessionChannel: bus.open() })
    onTestFinished(() => runtime.dispose())

    await new MutationObserver(runtime.queryClient, { mutationFn: async () => 'ok' }).mutate()
    const failing = new MutationObserver(runtime.queryClient, {
      mutationFn: async () => {
        throw new ApiError(404, 'NOT_FOUND', '不存在')
      },
    })
    await expect(failing.mutate()).rejects.toBeInstanceOf(ApiError)
    expect(page.visits).toEqual([])
    expect(otherTab).not.toHaveBeenCalled()
  })
})
