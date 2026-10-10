// 运行时的组装：默认用浏览器的实现；与会话无关的请求不触发会话的全局处理；会话复核给组件用；
// 请求得到"登录已过期"时先确认会话（复验 N3），本页的登录、修改密码先等它结束（有上限，M2-P6 复验 一般-1、一般-2）；
// 带原因的确认因网络失败没有结论时，下一个请求成功就再确认一次（M2-P6 复核第五批 G9）；
// 退出用的"换上同一个人的新会话"（M2-P6 复验 一般-4）。流程见 app.test.tsx。
import type { SessionResponse } from '@nerve-office/contracts'
import type { AppRuntime } from './runtime.ts'
import { MutationObserver } from '@tanstack/react-query'
import { createMemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { RENEWS_SESSION, RENEWS_SESSION_AFTER_UNKNOWN, STARTS_SESSION, SYSTEM_ADMIN_ONLY } from '../features/auth/index.ts'
import { ApiError, apiRequest, NetworkError, setCsrfToken } from '../shared/api/index.ts'
import { connectionState } from '../shared/lib/connection-state.ts'
import { apiError, installFakeApi, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { SESSION_CHANGE_TIME_LIMIT_MS } from './query-client.ts'
import { recordingPage, sessionBus } from './render-app.test-support.tsx'
import { createAppRuntime } from './runtime.ts'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'admin' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '爱丽丝' },
  csrfToken: 'csrf-1',
  features: { localDraftsEnabled: true },
}

/** 另一个人的会话：别的标签页换人登录之后，会话 Cookie 属于他 */
const OTHER_SESSION: SessionResponse = { ...SESSION, user: { ...SESSION.user, id: '0199a2c4-1f2e-7a3b-8c4d-000000000002' }, csrfToken: 'csrf-other' }

beforeEach(() => {
  connectionState.setBrowserOnline(false)
  connectionState.setBrowserOnline(true)
  connectionState.succeeded(connectionState.beginRequest())
})

/** bus：同一个浏览器里各个标签页之间的会话消息，要模拟别的标签页时传入同一条 */
function runtimeAt(path: string, bus = sessionBus()) {
  const page = recordingPage()
  const runtime = createAppRuntime({ createRouter: routes => createMemoryRouter(routes, { initialEntries: [path] }), page, sessionChannel: bus.open() })
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

/** 得到 401 的变更（"登录已过期"或"未登录"）：得到"登录已过期"的，发出时带的可能是换令牌之前的旧 Cookie */
async function failWith(runtime: AppRuntime, code: 'SESSION_EXPIRED' | 'UNAUTHENTICATED', meta?: Record<string, unknown>) {
  const mutationFn = vi.fn(async (): Promise<never> => {
    throw new ApiError(401, code, 'x')
  })
  await expect(new MutationObserver(runtime.queryClient, { mutationFn, meta }).mutate()).rejects.toMatchObject({ code })
  return mutationFn
}

/**
 * 本页还在进行的登录或修改密码（meta 是 STARTS_SESSION 或 RENEWS_SESSION）：由测试结束它。
 * done 在它结束时兑现（失败的也兑现，免得成为未处理的拒绝）
 */
function sessionChangeInProgress(runtime: AppRuntime, meta: Record<string, unknown>) {
  let succeed: (session: SessionResponse) => void = () => {}
  let fail: (error: unknown) => void = () => {}
  const done = new MutationObserver(runtime.queryClient, {
    mutationFn: async () => new Promise<SessionResponse>((resolve, reject) => {
      succeed = resolve
      fail = reject
    }),
    meta,
  }).mutate().catch(() => undefined)
  return { succeed: (session: SessionResponse) => succeed(session), fail: (error: unknown) => fail(error), done }
}

function sessionOf(runtime: AppRuntime): SessionResponse | undefined {
  return runtime.queryClient.getQueryData<SessionResponse>(['auth', 'session'])
}

/** 让已经发出的请求与随后的处理都走完：用来断言"没有再发请求""没有跳转" */
async function settle(ms = 20): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('createAppRuntime', () => {
  it('网络失败后受控复核恢复连接，但不采纳探测得到的另一人/CSRF；dispose 后停止复核', async () => {
    vi.useFakeTimers()
    const api = installFakeApi({
      'GET /api/broken': networkFailure,
      'GET /api/auth/session': () => json(200, OTHER_SESSION),
      'POST /api/probe': () => new Response(null, { status: 204 }),
    })
    const { runtime, page } = runtimeAt('/')
    try {
      runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
      setCsrfToken('csrf-original')
      await expect(apiRequest('/api/broken', { schema: z.undefined() })).rejects.toBeInstanceOf(NetworkError)
      await vi.advanceTimersByTimeAsync(1999)
      expect(api.requests.filter(request => request.key === 'GET /api/auth/session')).toHaveLength(0)
      expect(connectionState.view().available).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(connectionState.view().available).toBe(true)
      expect(api.requests.filter(request => request.key === 'GET /api/auth/session')).toHaveLength(1)
      expect(sessionOf(runtime)).toEqual(SESSION)
      expect(page.visits).toEqual([])
      await apiRequest('/api/probe', { method: 'POST', schema: z.undefined() })
      expect(api.requests.at(-1)?.headers['x-csrf-token']).toBe('csrf-original')
      runtime.dispose()
      await expect(apiRequest('/api/broken', { schema: z.undefined() })).rejects.toBeInstanceOf(NetworkError)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(api.requests.filter(request => request.key === 'GET /api/auth/session')).toHaveLength(1)
    }
    finally {
      runtime.dispose()
      vi.useRealTimers()
    }
  })

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
  it('还是同一个人（本页或别的标签页刚换了令牌）：换上新的会话与 CSRF 令牌，页面不动；这个请求照常失败，不自动重试', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, csrfToken: 'csrf-2' }), 'POST /api/probe': () => new Response(null, { status: 204 }) })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const request = await failWith(runtime, 'SESSION_EXPIRED')
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
    await failWith(runtime, 'SESSION_EXPIRED')
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2F%3Fview%3Dlist&reason=expired']))
  })

  it('修改密码的结果未知之后再提交得到"登录已过期"：确认没有会话，回到登录页的原因是 password_changed（M2-P6 复核 G-1）', async () => {
    installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'SESSION_EXPIRED') })
    const { runtime, page } = runtimeAt('/settings/password')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'SESSION_EXPIRED', RENEWS_SESSION_AFTER_UNKNOWN)
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=password_changed']))
  })

  it('几个请求一起得到"登录已过期"，其中一个是修改密码结果未知之后的再提交：只跳转一次，原因是更具体的 password_changed', async () => {
    installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'SESSION_EXPIRED') })
    const { runtime, page } = runtimeAt('/settings/password')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await Promise.all([failWith(runtime, 'SESSION_EXPIRED', RENEWS_SESSION_AFTER_UNKNOWN), failWith(runtime, 'SESSION_EXPIRED')])
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=password_changed']))
    await settle()
    expect(page.visits).toHaveLength(1)
  })

  it('组件带着原因要求确认（为自己生成重置链接的结果未知，M2-P6 复核第三批 R-1）：已经没有会话，按这个原因回到登录页，而不是整页重新加载；确认结束才兑现', async () => {
    const pending = deferredResponse()
    installFakeApi({ 'GET /api/auth/session': pending.handler })
    const { runtime, page } = runtimeAt('/admin/users')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    let settled = false
    const checking = runtime.recheckSession('password_reset').then(() => {
      settled = true
    })
    await settle()
    expect(settled).toBe(false)
    pending.resolve(apiError(401, 'SESSION_EXPIRED'))
    await checking
    expect(page.visits).toEqual(['/login?from=%2Fadmin%2Fusers&reason=password_reset'])
  })

  it('组件带着原因要求确认，会话还在（这一次没有生效）：页面不动；确认期间别的请求先得到普通的"登录已过期"，原因仍是更具体的那个', async () => {
    installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, csrfToken: 'csrf-2' }) })
    const { runtime, page } = runtimeAt('/admin/users')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await runtime.recheckSession('password_reset')
    expect(page.visits).toEqual([])
    expect(sessionOf(runtime)?.csrfToken).toBe('csrf-2')

    // 另一回：会话已经撤销，确认有结论之前账户列表先得到普通的"登录已过期"
    const first = deferredResponse()
    const api = installFakeApi({ 'GET /api/auth/session': first.handler })
    const checking = runtime.recheckSession('password_reset')
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    await failWith(runtime, 'SESSION_EXPIRED')
    api.on('GET /api/auth/session', () => apiError(401, 'SESSION_EXPIRED'))
    first.resolve(apiError(401, 'SESSION_EXPIRED'))
    await checking
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fadmin%2Fusers&reason=password_reset']))
    await settle()
    expect(page.visits).toHaveLength(1)
  })

  it('带着原因的确认断网、没有结论：原因留着；下一个请求成功（连得上服务端了）就再确认一次，会话还在、原因随之清掉——之后会话自然过期，按"已过期"回到登录页（第五批 G9）', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': networkFailure, 'GET /api/probe': () => json(200, { ok: true }) })
    const { runtime, page } = runtimeAt('/admin/users')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const probe = async (key: string) => runtime.queryClient.fetchQuery({ queryKey: [key], queryFn: async () => apiRequest('/api/probe', { schema: z.object({ ok: z.boolean() }) }) })
    // 没有待定的原因时，请求成功不多确认
    await probe('before')
    expect(api.requests.filter(entry => entry.key === 'GET /api/auth/session')).toHaveLength(0)

    await runtime.recheckSession('password_reset')
    expect(page.visits).toEqual([])
    expect(api.requests.filter(entry => entry.key === 'GET /api/auth/session')).toHaveLength(1)

    // 连得上了：会话还在（为自己生成的重置链接没有生效）
    api.on('GET /api/auth/session', () => json(200, { ...SESSION, csrfToken: 'csrf-2' }))
    await probe('after')
    await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-2'))
    expect(api.requests.filter(entry => entry.key === 'GET /api/auth/session')).toHaveLength(2)
    // 已经有了结论：之后的请求成功不再确认
    await probe('later')
    await settle()
    expect(api.requests.filter(entry => entry.key === 'GET /api/auth/session')).toHaveLength(2)

    // 几个小时以后会话自然过期：说"登录已过期"，不再说"刚才……密码可能已经失效"
    api.on('GET /api/auth/session', () => apiError(401, 'SESSION_EXPIRED'))
    await failWith(runtime, 'SESSION_EXPIRED')
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fadmin%2Fusers&reason=expired']))
  })

  it('同上，连得上时会话已经不在了（重置其实已经生效）：按记下的原因回到登录页；断网期间不按时间丢掉原因（第五批 G9）', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': networkFailure })
    const { runtime, page } = runtimeAt('/admin/users')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await runtime.recheckSession('password_reset')
    await settle()
    expect(page.visits).toEqual([])

    // 变更成功同样说明连得上了
    api.on('GET /api/auth/session', () => apiError(401, 'SESSION_EXPIRED'))
    await new MutationObserver(runtime.queryClient, { mutationFn: async () => 'ok' }).mutate()
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fadmin%2Fusers&reason=password_reset']))
    expect(api.requests.filter(entry => entry.key === 'GET /api/auth/session')).toHaveLength(2)
  })

  it('带着原因的确认断网之后，别的事（别的标签页的消息）补上的一轮已经有了结论：之后的请求成功不再多确认一次（第五批 G9）', async () => {
    const bus = sessionBus()
    const otherTab = bus.open()
    const api = installFakeApi({ 'GET /api/auth/session': networkFailure, 'GET /api/probe': () => json(200, { ok: true }) })
    const { runtime, page } = runtimeAt('/admin/users', bus)
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await runtime.recheckSession('password_reset')
    api.on('GET /api/auth/session', () => json(200, { ...SESSION, csrfToken: 'csrf-2' }))
    otherTab.announce()
    await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-2'))
    const checked = api.requests.filter(entry => entry.key === 'GET /api/auth/session').length
    await runtime.queryClient.fetchQuery({ queryKey: ['probe'], queryFn: async () => apiRequest('/api/probe', { schema: z.object({ ok: z.boolean() }) }) })
    await settle()
    expect(api.requests.filter(entry => entry.key === 'GET /api/auth/session')).toHaveLength(checked)
    expect(page.visits).toEqual([])
  })

  it('确认时换了人（别的标签页登录了另一个人）：整页重新加载，新会话的令牌不交给这个页面', async () => {
    installFakeApi({ 'GET /api/auth/session': () => json(200, OTHER_SESSION) })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'SESSION_EXPIRED')
    await vi.waitFor(() => expect(page.visits).toEqual(['reload']))
    expect(sessionOf(runtime)?.csrfToken).toBe('csrf-1')
  })

  it('同一轮确认里先后三个请求得到"登录已过期"，确认看到另一个人：只重新加载一次，另一个人的令牌不交给页面', async () => {
    const pending = deferredResponse()
    const api = installFakeApi({ 'GET /api/auth/session': pending.handler })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'SESSION_EXPIRED')
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    await failWith(runtime, 'SESSION_EXPIRED')
    await failWith(runtime, 'SESSION_EXPIRED')
    api.on('GET /api/auth/session', () => json(200, OTHER_SESSION))
    pending.resolve(json(200, OTHER_SESSION))
    await vi.waitFor(() => expect(page.visits).toEqual(['reload']))
    await settle()
    expect(page.visits).toEqual(['reload'])
    expect(sessionOf(runtime)?.csrfToken).toBe('csrf-1')
  })

  it('得到"登录已过期"之前就开始的一轮确认回"没有会话"：不作数（带的可能还是旧 Cookie），补上一轮，以它为准', async () => {
    const first = deferredResponse()
    const api = installFakeApi({ 'GET /api/auth/session': first.handler })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const checking = runtime.recheckSession()
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    await failWith(runtime, 'SESSION_EXPIRED')
    api.on('GET /api/auth/session', () => json(200, { ...SESSION, csrfToken: 'csrf-3' }))
    first.resolve(apiError(401, 'SESSION_EXPIRED'))
    await checking
    await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-3'))
    expect(api.requests.map(entry => entry.key)).toEqual(['GET /api/auth/session', 'GET /api/auth/session'])
    expect(page.visits).toEqual([])
  })

  it('确认进行中别的标签页发来消息：这一轮看到同一个人（换上新令牌），补上的一轮看到换了人，整页重新加载一次', async () => {
    const bus = sessionBus()
    const otherTab = bus.open()
    const pending = deferredResponse()
    const api = installFakeApi({ 'GET /api/auth/session': pending.handler })
    const { runtime, page } = runtimeAt('/', bus)
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'SESSION_EXPIRED')
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    api.on('GET /api/auth/session', () => json(200, OTHER_SESSION))
    otherTab.announce()
    pending.resolve(json(200, { ...SESSION, csrfToken: 'csrf-2' }))
    await vi.waitFor(() => expect(page.visits).toEqual(['reload']))
    await settle()
    expect(page.visits).toEqual(['reload'])
    expect(api.requests).toHaveLength(2)
  })

  it('确认进行中别的标签页发来消息，这一轮确认没有会话：按"已过期"离开，不再多确认一次', async () => {
    const bus = sessionBus()
    const otherTab = bus.open()
    const pending = deferredResponse()
    const api = installFakeApi({ 'GET /api/auth/session': pending.handler })
    const { runtime, page } = runtimeAt('/', bus)
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'SESSION_EXPIRED')
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    otherTab.announce()
    pending.resolve(apiError(401, 'UNAUTHENTICATED'))
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?reason=expired']))
    await settle()
    expect(api.requests).toHaveLength(1)
  })

  it('确认的请求断网：不下结论，页面不动；之后别的标签页的消息补上一轮，没有会话时按"已过期"离开', async () => {
    const bus = sessionBus()
    const otherTab = bus.open()
    const api = installFakeApi({ 'GET /api/auth/session': networkFailure })
    const { runtime, page } = runtimeAt('/', bus)
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'SESSION_EXPIRED')
    await settle()
    expect(page.visits).toEqual([])
    api.on('GET /api/auth/session', () => apiError(401, 'UNAUTHENTICATED'))
    otherTab.announce()
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?reason=expired']))
  })

  it('一次性链接的公开页面上得到"登录已过期"：不确认；离开这个页面时补上确认，没有会话时按"已过期"离开', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') })
    const { runtime, page } = runtimeAt('/invite')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'SESSION_EXPIRED')
    await settle()
    expect(api.requests).toEqual([])
    await runtime.router.navigate('/')
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?reason=expired']))
    expect(api.requests.map(entry => entry.key)).toEqual(['GET /api/auth/session'])
  })

  it('页面已经在离开（请求得到未登录）：之后得到的"登录已过期"不再确认、不再跳转', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, SESSION) })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'UNAUTHENTICATED')
    await failWith(runtime, 'SESSION_EXPIRED')
    await settle()
    expect(api.requests).toEqual([])
    expect(page.visits).toEqual(['/login'])
  })

  it('请求得到"未登录"（没有带会话 Cookie）：不确认，直接回到登录页', async () => {
    const api = installFakeApi({})
    const { runtime, page } = runtimeAt('/?view=list')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'UNAUTHENTICATED')
    expect(page.visits).toEqual(['/login?from=%2F%3Fview%3Dlist'])
    expect(api.requests).toEqual([])
  })

  it('确认还没有结果时另一个请求得到"未登录"（过期那次的响应已经清除了 Cookie）：不等确认，直接按"已过期"回到登录页（M2-P6 复验 建议-1）', async () => {
    const pending = deferredResponse()
    const api = installFakeApi({ 'GET /api/auth/session': pending.handler })
    const { runtime, page } = runtimeAt('/?view=list')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'SESSION_EXPIRED')
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    await failWith(runtime, 'UNAUTHENTICATED')
    expect(page.visits).toEqual(['/login?from=%2F%3Fview%3Dlist&reason=expired'])
    // 确认的结果随后回来，页面已经在离开：不再跳转
    pending.resolve(apiError(401, 'UNAUTHENTICATED'))
    await settle()
    expect(page.visits).toEqual(['/login?from=%2F%3Fview%3Dlist&reason=expired'])
  })

  it.each([
    ['请求得到"登录已过期"', undefined, 'expired'],
    ['修改密码的结果未知之后再提交得到"登录已过期"', RENEWS_SESSION_AFTER_UNKNOWN, 'password_changed'],
  ] as const)('%s、确认还在等本页的修改密码时另一个请求得到"未登录"：按它的原因回到登录页，原因不等确认就记下（M2-P6 复验 建议-1）', async (_name, meta, reason) => {
    const api = installFakeApi({})
    const { runtime, page } = runtimeAt('/settings/password')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    sessionChangeInProgress(runtime, RENEWS_SESSION)
    await failWith(runtime, 'SESSION_EXPIRED', meta)
    await failWith(runtime, 'UNAUTHENTICATED')
    expect(page.visits).toEqual([`/login?from=%2Fsettings%2Fpassword&reason=${reason}`])
    expect(api.requests).toEqual([])
  })
})

describe('本页的登录、修改密码还在进行：向服务端确认之前先等它结束（复验 N3，M2-P6 复验 一般-1、一般-2）', () => {
  /**
   * 浏览器里的会话 Cookie：修改密码的响应到达之前还是旧的（服务端已经撤销了它，确认得到"登录已过期"），
   * renew 之后是修改密码换上的新的
   */
  function cookieJar() {
    let renewed = false
    const api = installFakeApi({ 'GET /api/auth/session': () => renewed ? json(200, { ...SESSION, csrfToken: 'csrf-renewed' }) : apiError(401, 'SESSION_EXPIRED') })
    return { api, renew: () => {
      renewed = true
    } }
  }

  it.each([
    ['修改密码', RENEWS_SESSION],
    ['登录', STARTS_SESSION],
  ])('本页的%s还在进行时请求得到"登录已过期"：等它结束再确认（它的响应带着新的 Cookie），同一个人，页面不动', async (_name, meta) => {
    const jar = cookieJar()
    const { runtime, page } = runtimeAt('/settings/password')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const change = sessionChangeInProgress(runtime, meta)
    await failWith(runtime, 'SESSION_EXPIRED')
    await settle()
    expect(jar.api.requests).toEqual([])
    jar.renew()
    change.succeed({ ...SESSION, csrfToken: 'csrf-renewed' })
    await change.done
    await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-renewed'))
    expect(jar.api.requests.map(entry => entry.key)).toEqual(['GET /api/auth/session'])
    expect(page.visits).toEqual([])
  })

  it('本页的登录失败了：随后确认，没有会话，按"已过期"回到登录页', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const login = sessionChangeInProgress(runtime, STARTS_SESSION)
    await failWith(runtime, 'SESSION_EXPIRED')
    await settle()
    expect(api.requests).toEqual([])
    login.fail(new ApiError(401, 'INVALID_CREDENTIALS', 'x'))
    await login.done
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?reason=expired']))
  })

  it('本页的修改密码还在进行（服务端已换令牌、响应还没到），别的标签页的消息开始一轮确认：同样等它结束，不带着旧 Cookie 下结论、不重新加载（M2-P6 复验 一般-1）', async () => {
    const bus = sessionBus()
    const otherTab = bus.open()
    const jar = cookieJar()
    const { runtime, page } = runtimeAt('/settings/password', bus)
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const renewal = sessionChangeInProgress(runtime, RENEWS_SESSION)
    otherTab.announce()
    await settle()
    expect(jar.api.requests).toEqual([])
    expect(page.visits).toEqual([])
    jar.renew()
    renewal.succeed({ ...SESSION, csrfToken: 'csrf-renewed' })
    await renewal.done
    await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-renewed'))
    expect(page.visits).toEqual([])
  })

  it('同上，而且之前有请求得到"登录已过期"、它的确认正在等：别的标签页的消息合并进这一轮，修改密码结束之后看到同一个人，页面不动（M2-P6 复验 一般-1）', async () => {
    const bus = sessionBus()
    const otherTab = bus.open()
    const jar = cookieJar()
    const { runtime, page } = runtimeAt('/settings/password', bus)
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const renewal = sessionChangeInProgress(runtime, RENEWS_SESSION)
    await failWith(runtime, 'SESSION_EXPIRED')
    otherTab.announce()
    await settle()
    expect(jar.api.requests).toEqual([])
    expect(page.visits).toEqual([])
    jar.renew()
    renewal.succeed({ ...SESSION, csrfToken: 'csrf-renewed' })
    await renewal.done
    await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-renewed'))
    await settle()
    expect(page.visits).toEqual([])
    expect(jar.api.requests.length).toBeGreaterThan(0)
  })

  it('等的期间页面开始离开（别的请求得到未登录）：修改密码结束之后这一轮不再向服务端确认', async () => {
    const bus = sessionBus()
    const otherTab = bus.open()
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, SESSION) })
    const { runtime, page } = runtimeAt('/settings/password', bus)
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const renewal = sessionChangeInProgress(runtime, RENEWS_SESSION)
    otherTab.announce()
    await failWith(runtime, 'UNAUTHENTICATED')
    expect(page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword'])
    renewal.fail(new ApiError(403, 'CURRENT_PASSWORD_INCORRECT', 'x'))
    await renewal.done
    await settle()
    expect(api.requests).toEqual([])
    expect(page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword'])
  })

  it('一轮确认正在等本页的修改密码时请求得到"登录已过期"，修改密码随后失败、确实没有会话：这一轮就下结论，按"已过期"离开，只确认一次（轮数在等完之后才加一，第三轮复验 一般-B）', async () => {
    const bus = sessionBus()
    const otherTab = bus.open()
    const api = installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') })
    const { runtime, page } = runtimeAt('/settings/password', bus)
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const renewal = sessionChangeInProgress(runtime, RENEWS_SESSION)
    otherTab.announce()
    await settle()
    await failWith(runtime, 'SESSION_EXPIRED')
    renewal.fail(new ApiError(403, 'CURRENT_PASSWORD_INCORRECT', 'x'))
    await renewal.done
    await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=expired']))
    await settle()
    expect(api.requests).toHaveLength(1)
  })

  it('组件调用的复核同样等本页的修改密码结束（M2-P6 复验 一般-1）', async () => {
    const jar = cookieJar()
    const { runtime, page } = runtimeAt('/settings/password')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const renewal = sessionChangeInProgress(runtime, RENEWS_SESSION)
    const checking = runtime.recheckSession()
    await settle()
    expect(jar.api.requests).toEqual([])
    jar.renew()
    renewal.succeed({ ...SESSION, csrfToken: 'csrf-renewed' })
    await checking
    expect(sessionOf(runtime)?.csrfToken).toBe('csrf-renewed')
    expect(page.visits).toEqual([])
  })

  describe('等待的上限（M2-P6 复验 一般-2）', () => {
    function useFakeClock(): void {
      vi.useFakeTimers()
      onTestFinished(() => {
        vi.useRealTimers()
      })
    }

    it('本页的修改密码一直不结束：从它开始算起到了上限就照常确认，没有会话时按"已过期"回到登录页', async () => {
      useFakeClock()
      const api = installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') })
      const { runtime, page } = runtimeAt('/settings/password')
      runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
      sessionChangeInProgress(runtime, RENEWS_SESSION)
      // 修改密码开始之后 30 秒请求才得到"登录已过期"：只再等剩下的 10 秒
      await vi.advanceTimersByTimeAsync(30_000)
      await failWith(runtime, 'SESSION_EXPIRED')
      await vi.advanceTimersByTimeAsync(SESSION_CHANGE_TIME_LIMIT_MS - 30_000 - 1)
      expect(api.requests).toEqual([])
      expect(page.visits).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=expired']))
      expect(api.requests.map(entry => entry.key)).toEqual(['GET /api/auth/session'])
    })

    it('超过上限还没结束的修改密码不再等：之后别的标签页的消息开始的一轮立即确认', async () => {
      useFakeClock()
      const bus = sessionBus()
      const otherTab = bus.open()
      const api = installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, csrfToken: 'csrf-2' }) })
      const { runtime, page } = runtimeAt('/settings/password', bus)
      runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
      sessionChangeInProgress(runtime, RENEWS_SESSION)
      otherTab.announce()
      await vi.advanceTimersByTimeAsync(SESSION_CHANGE_TIME_LIMIT_MS - 1)
      expect(api.requests).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(sessionOf(runtime)?.csrfToken).toBe('csrf-2'))
      expect(api.requests).toHaveLength(1)
      // 修改密码还挂着，但已经超过上限：这一轮不再等，确认的请求随消息立即发出
      otherTab.announce()
      expect(api.requests).toHaveLength(2)
      expect(page.visits).toEqual([])
    })

    it('等的期间又开始了一次登录：一起等，到它自己的上限为止', async () => {
      useFakeClock()
      const api = installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') })
      const { runtime, page } = runtimeAt('/settings/password')
      runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
      sessionChangeInProgress(runtime, RENEWS_SESSION)
      await failWith(runtime, 'SESSION_EXPIRED')
      await vi.advanceTimersByTimeAsync(10_000)
      sessionChangeInProgress(runtime, STARTS_SESSION)
      // 第一个到了上限，第二个还没有
      await vi.advanceTimersByTimeAsync(SESSION_CHANGE_TIME_LIMIT_MS - 10_000)
      expect(api.requests).toEqual([])
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=expired']))
    })
  })
})

describe('换上浏览器里同一个人的新会话（退出用，M2-P6 复验 一般-4）', () => {
  it('还是页面上的这个人：换上新的会话与 CSRF 令牌，兑现为 true；页面不动', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, csrfToken: 'csrf-2' }), 'POST /api/probe': () => new Response(null, { status: 204 }) })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await expect(runtime.adoptRenewedSession()).resolves.toBe(true)
    expect(sessionOf(runtime)?.csrfToken).toBe('csrf-2')
    await apiRequest('/api/probe', { method: 'POST', schema: z.undefined() })
    expect(api.requests.find(entry => entry.key === 'POST /api/probe')?.headers['x-csrf-token']).toBe('csrf-2')
    expect(page.visits).toEqual([])
  })

  it.each([
    ['已经没有会话', () => apiError(401, 'UNAUTHENTICATED')],
    ['会话也失效了', () => apiError(401, 'SESSION_EXPIRED')],
    ['换了人', () => json(200, OTHER_SESSION)],
  ])('%s：兑现为 false，不换令牌、不跳转、不重新加载（由调用方按原来的结果处理）', async (_name, response) => {
    const api = installFakeApi({ 'GET /api/auth/session': response, 'POST /api/probe': () => new Response(null, { status: 204 }) })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    setCsrfToken('csrf-1')
    await expect(runtime.adoptRenewedSession()).resolves.toBe(false)
    expect(sessionOf(runtime)?.csrfToken).toBe('csrf-1')
    await apiRequest('/api/probe', { method: 'POST', schema: z.undefined() })
    expect(api.requests.find(entry => entry.key === 'POST /api/probe')?.headers['x-csrf-token']).toBe('csrf-1')
    expect(page.visits).toEqual([])
  })

  it('网络失败：原样抛出，页面不动', async () => {
    installFakeApi({ 'GET /api/auth/session': networkFailure })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await expect(runtime.adoptRenewedSession()).rejects.toBeInstanceOf(NetworkError)
    expect(page.visits).toEqual([])
  })

  it('本页的修改密码还在进行：等它结束再向服务端要会话', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, { ...SESSION, csrfToken: 'csrf-renewed' }) })
    const { runtime } = runtimeAt('/settings/password')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const renewal = sessionChangeInProgress(runtime, RENEWS_SESSION)
    const adopted = runtime.adoptRenewedSession()
    await settle()
    expect(api.requests).toEqual([])
    renewal.succeed({ ...SESSION, csrfToken: 'csrf-renewed' })
    await expect(adopted).resolves.toBe(true)
    expect(api.requests.map(entry => entry.key)).toEqual(['GET /api/auth/session'])
  })

  it('页面已经在离开：兑现为 false，不再向服务端要会话', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, SESSION) })
    const { runtime, page } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    await failWith(runtime, 'UNAUTHENTICATED')
    await expect(runtime.adoptRenewedSession()).resolves.toBe(false)
    expect(api.requests).toEqual([])
    expect(page.visits).toEqual(['/login'])
  })

  it('确认期间页面开始离开（别的请求得到未登录）：兑现为 false，不换上新的令牌', async () => {
    const pending = deferredResponse()
    installFakeApi({ 'GET /api/auth/session': pending.handler })
    const { runtime } = runtimeAt('/')
    runtime.queryClient.setQueryData(['auth', 'session'], SESSION)
    const adopted = runtime.adoptRenewedSession()
    await failWith(runtime, 'UNAUTHENTICATED')
    pending.resolve(json(200, { ...SESSION, csrfToken: 'csrf-2' }))
    await expect(adopted).resolves.toBe(false)
    expect(sessionOf(runtime)?.csrfToken).toBe('csrf-1')
  })
})
