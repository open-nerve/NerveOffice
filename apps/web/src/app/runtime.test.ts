// 运行时的组装：默认用浏览器的实现；与会话无关的请求不触发会话的全局处理；会话复核给组件用；
// 请求得到"登录已过期"时先确认会话（复验 N3）。流程见 app.test.tsx。
import type { SessionResponse } from '@nerve-office/contracts'
import type { AppRuntime } from './runtime.ts'
import { MutationObserver } from '@tanstack/react-query'
import { createMemoryRouter } from 'react-router'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { RENEWS_SESSION, RENEWS_SESSION_AFTER_UNKNOWN, STARTS_SESSION, SYSTEM_ADMIN_ONLY } from '../features/auth/index.ts'
import { ApiError, apiRequest } from '../shared/api/index.ts'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
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

describe('请求得到"登录已过期"：先向服务端确认会话（复验 N3）', () => {
  /** 得到"登录已过期"的变更：发出时带的可能是换令牌之前的旧 Cookie */
  async function failWithExpired(runtime: AppRuntime, meta?: Record<string, unknown>) {
    const mutationFn = vi.fn(async (): Promise<never> => {
      throw new ApiError(401, 'SESSION_EXPIRED', 'x')
    })
    await expect(new MutationObserver(runtime.queryClient, { mutationFn, meta }).mutate()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    return mutationFn
  }

  function sessionOf(runtime: AppRuntime): SessionResponse | undefined {
    return runtime.queryClient.getQueryData<SessionResponse>(['auth', 'session'])
  }

  it('还是同一个人（本页或别的标签页刚换了令牌）：换上新的会话与 CSRF 令牌，页面不动；这个请求照常失败，不自动重试', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, csrfToken: 'csrf-2' }), 'POST /api/probe': () => new Response(null, { status: 204 }) })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const request = await failWithExpired(runtime)
    await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-2'))
    expect(page.visits).toEqual([])
    expect(request).toHaveBeenCalledTimes(1)
    // 之后的状态变更带着新的令牌
    await apiRequest('/api/probe', { method: 'POST', schema: z.undefined() })
    expect(api.requests.find(entry => entry.key === 'POST /api/probe')?.headers['x-csrf-token']).toBe('csrf-2')
  })

  it('已经没有会话（过期那次的响应清除了 Cookie，确认得到"未登录"）：按"已过期"回到登录页，保留原来的地址，不是"请先登录"', async () => {
    installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') })
    const { runtime, page } = runtimeAt('/?view=list')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWithExpired(runtime)
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2F%3Fview%3Dlist&reason=expired']))
  })

  it('修改密码的结果未知之后再提交得到"登录已过期"：确认没有会话，回到登录页的原因是 password_changed（M2-P6 复核 G-1）', async () => {
    installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'SESSION_EXPIRED') })
    const { runtime, page } = runtimeAt('/settings/password')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWithExpired(runtime, RENEWS_SESSION_AFTER_UNKNOWN)
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=password_changed']))
  })

  it('几个请求一起得到"登录已过期"，其中一个是修改密码结果未知之后的再提交：只跳转一次，原因是更具体的 password_changed', async () => {
    installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'SESSION_EXPIRED') })
    const { runtime, page } = runtimeAt('/settings/password')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await Promise.all([failWithExpired(runtime, RENEWS_SESSION_AFTER_UNKNOWN), failWithExpired(runtime)])
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=password_changed']))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(page.visits).toHaveLength(1)
  })

  it('确认时换了人（别的标签页登录了另一个人）：整页重新加载，新会话的令牌不交给这个页面', async () => {
    installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, user: { ...SESSION.user, id: '0199a2c4-1f2e-7a3b-8c4d-000000000002' }, csrfToken: 'csrf-other' }) })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWithExpired(runtime)
    await vi.waitFor(() => expect(page.visits).toEqual(['reload']))
    expect(sessionOf(runtime)?.csrfToken).toBe('csrf-1')
  })

  it('得到"登录已过期"之前就开始的一轮确认回"没有会话"：不作数（带的可能还是旧 Cookie），补上一轮，以它为准', async () => {
    const first = deferredResponse()
    const api = installFakeApi({ 'GET /api/auth/session': first.handler })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const checking = runtime.recheckSession()
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    await failWithExpired(runtime)
    api.on('GET /api/auth/session', () => json(200, { ...SESSION, csrfToken: 'csrf-3' }))
    first.resolve(apiError(401, 'SESSION_EXPIRED'))
    await checking
    await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-3'))
    expect(api.requests.map(entry => entry.key)).toEqual(['GET /api/auth/session', 'GET /api/auth/session'])
    expect(page.visits).toEqual([])
  })

  it.each([
    ['修改密码', RENEWS_SESSION],
    ['登录', STARTS_SESSION],
  ])('本页的%s还在进行：等它结束再确认（它的响应带着新的 Cookie），同一个人，页面不动', async (_name, meta) => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, csrfToken: 'csrf-renewed' }) })
    const { runtime, page } = runtimeAt('/settings/password')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    let finishRenewal: (session: SessionResponse) => void = () => {}
    const renewal = new MutationObserver(runtime.queryClient, {
      mutationFn: async () => new Promise<SessionResponse>((resolve) => {
        finishRenewal = resolve
      }),
      meta,
    }).mutate()
    await failWithExpired(runtime)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api.requests).toEqual([])
    finishRenewal({ ...SESSION, csrfToken: 'csrf-renewed' })
    await renewal
    await vi.waitFor(() => expect(api.requests.map(entry => entry.key)).toEqual(['GET /api/auth/session']))
    await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-renewed'))
    expect(page.visits).toEqual([])
  })

  it('请求得到"未登录"（没有带会话 Cookie）：不确认，直接回到登录页', async () => {
    const api = installFakeApi({})
    const { runtime, page } = runtimeAt('/?view=list')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const unauthenticated = async (): Promise<never> => {
      throw new ApiError(401, 'UNAUTHENTICATED', 'x')
    }
    await expect(new MutationObserver(runtime.queryClient, { mutationFn: unauthenticated }).mutate()).rejects.toBeInstanceOf(ApiError)
    expect(page.visits).toEqual(['/login?from=%2F%3Fview%3Dlist'])
    expect(api.requests).toEqual([])
  })
})
