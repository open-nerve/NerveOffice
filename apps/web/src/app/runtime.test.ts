// 运行时的组装：默认用浏览器的实现；与会话无关的请求不触发会话的全局处理；会话复核给组件用。流程见 app.test.tsx。
import type { SessionResponse } from '@nerve-office/contracts'
import { MutationObserver } from '@tanstack/react-query'
import { createMemoryRouter } from 'react-router'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SYSTEM_ADMIN_ONLY } from '../features/auth/index.ts'
import { ApiError } from '../shared/api/index.ts'
import { installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { recordingPage, sessionBus } from './render-app.test-support.tsx'
import { createAppRuntime } from './runtime.ts'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'admin' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '爱丽丝' },
  csrfToken: 'csrf-1',
}

function runtimeAt(path: string) {
  const page = recordingPage()
  const runtime = createAppRuntime({ createRouter: routes => createMemoryRouter(routes, { initialEntries: [path] }), page, sessionChannel: sessionBus().open() })
  onTestFinished(() => runtime.dispose())
  return { runtime, page }
}

/** 由测试决定何时返回的响应 */
function deferredResponse(): { handler: () => Promise<Response>, resolve: (response: Response) => void } {
  let resolve: (response: Response) => void = () => {}
  const promise = new Promise<Response>((settle) => {
    resolve = settle
  })
  return { handler: async () => promise, resolve }
}

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

describe('会话复核（M2-P1 审查 B3、B4）', () => {
  it('只给系统管理员的请求得到 PERMISSION_DENIED：重新确认会话（系统角色可能被取消了）；其他请求的 PERMISSION_DENIED 不确认', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, user: { ...SESSION.user, systemRole: 'member' } }) })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const denied = async () => {
      throw new ApiError(403, 'PERMISSION_DENIED', 'x')
    }
    await expect(new MutationObserver(runtime.queryClient, { mutationFn: denied }).mutate()).rejects.toBeInstanceOf(ApiError)
    expect(api.requests).toEqual([])
    await expect(new MutationObserver(runtime.queryClient, { mutationFn: denied, meta: SYSTEM_ADMIN_ONLY }).mutate()).rejects.toBeInstanceOf(ApiError)
    await vi.waitFor(() => expect(runtime.queryClient.getQueryData<SessionResponse>(['auth', 'session'])?.user.systemRole).toBe('member'))
    expect(api.requests.map(request => request.key)).toEqual(['GET /api/auth/session'])
    expect(page.visits).toEqual([])
  })

  it('组件调用的复核：确认结束时兑现；确认期间再调用，合并进这一次，结束前再确认一次', async () => {
    const first = deferredResponse()
    const api = installFakeApi({ 'GET /api/auth/session': first.handler })
    const { runtime } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    let settled = false
    const checking = runtime.recheckSession().then(() => {
      settled = true
    })
    let mergedSettled = false
    const merged = runtime.recheckSession().then(() => {
      mergedSettled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    const second = deferredResponse()
    api.on('GET /api/auth/session', second.handler)
    first.resolve(json(200, { ...SESSION, csrfToken: 'csrf-2' }))
    // 第一次确认的结果已经回来，补上的那次还没有：合并进来的调用仍在等（复验 N4）
    await vi.waitFor(() => expect(api.requests).toHaveLength(2))
    expect(mergedSettled).toBe(false)
    expect(settled).toBe(false)
    second.resolve(json(200, { ...SESSION, csrfToken: 'csrf-3' }))
    await Promise.all([checking, merged])
    expect(mergedSettled).toBe(true)
    expect(api.requests.map(request => request.key)).toEqual(['GET /api/auth/session', 'GET /api/auth/session'])
    expect(runtime.queryClient.getQueryData<SessionResponse>(['auth', 'session'])?.csrfToken).toBe('csrf-3')
  })

  it('一次性链接的公开页面：不确认会话，不重新加载（令牌已经从地址里去掉了）', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, SESSION) })
    for (const path of ['/invite', '/Reset-Password/']) {
      const { runtime, page } = runtimeAt(path)
      await runtime.recheckSession()
      expect(page.visits).toEqual([])
    }
    expect(api.requests).toEqual([])
  })

  it('公开页面上跳过的复核，离开这个页面时补上：接受邀请之后进入个人空间时发现 Cookie 已经属于别人，整页重新加载（复验 N6）', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, user: { ...SESSION.user, id: '0199a2c4-1f2e-7a3b-8c4d-000000000002' } }) })
    const { runtime, page } = runtimeAt('/invite')
    // 接受成功：页面写入新账户的会话；这时别的标签页登录了另一个人，消息在公开页上被跳过
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await runtime.recheckSession()
    expect(api.requests).toEqual([])
    await runtime.router.navigate('/')
    await vi.waitFor(() => expect(page.visits).toEqual(['reload']))
    expect(api.requests.map(request => request.key)).toEqual(['GET /api/auth/session'])
  })

  it('公开页面上没有跳过复核时，离开这个页面不多确认一次', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, SESSION) })
    const { runtime, page } = runtimeAt('/reset-password')
    await runtime.router.navigate('/')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api.requests).toEqual([])
    expect(page.visits).toEqual([])
  })
})
