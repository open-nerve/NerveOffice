// 平台页面的流程（P3 设计 §3.7）：与生产相同的路由表、请求缓存与会话的全局处理，接口用假的 fetch。
// 整页跳转（会话结束、换了人）记在 page.visits 里：跳转之后是一个新页面，由另一个用例从那个地址重新渲染。
import type { DocumentSummary, SessionResponse } from '@nerve-office/contracts'
import type { SessionChannel } from '../shared/lib/session-channel.ts'
import type { FakeApi, Handler } from '../shared/testing/fake-api.test-support.ts'
import type { RenderedApp } from './render-app.test-support.tsx'
import { onlineManager } from '@tanstack/react-query'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { apiRequest } from '../shared/api/index.ts'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { currentPath, renderApp, sessionBus } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '爱丽丝' },
  csrfToken: 'csrf-1',
}

/** 另一个人的会话：别的标签页换人登录之后，会话 Cookie 属于他 */
const OTHER_SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-000000000002', username: 'bob', displayName: '鲍勃', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-000000000002', name: '鲍勃' },
  csrfToken: 'csrf-bob',
}

function document(index: number): DocumentSummary {
  return {
    id: `0199a2c4-1f2e-7a3b-8c4d-${String(index).padStart(12, '0')}`,
    title: `文档 ${index}`,
    type: 'sheet',
    createdAt: '2026-09-26T01:00:00.000Z',
    updatedAt: '2026-09-26T02:00:00.000Z',
  }
}

/** 先挂起、由测试决定何时返回的响应：用来观察"进行中"的界面。 */
function deferred(): { handler: Handler, resolve: (response: Response) => void } {
  let resolve: (response: Response) => void = () => {}
  const promise = new Promise<Response>((settle) => {
    resolve = settle
  })
  return { handler: async () => promise, resolve }
}

function networkFailure(): never {
  throw new TypeError('Failed to fetch')
}

/** 浏览器认为离线（navigator.onLine 为 false）；用例结束时恢复 */
function goOffline(): void {
  onlineManager.setOnline(false)
  onTestFinished(() => onlineManager.setOnline(true))
}

/** 让已经发出的请求与随后的渲染都走完：用来断言"没有再发请求" */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

const LOGGED_OUT = { 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') }
const LOGGED_IN = { 'GET /api/auth/session': () => json(200, SESSION) }
const NO_DOCUMENTS = { 'GET /api/documents': () => json(200, { items: [], nextCursor: null }) }

async function fillLogin(username: string, password: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText('用户名'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
}

function requestCount(api: FakeApi, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

describe('US-M1-02 登录与退出', () => {
  it('未登录访问首页：转到登录页；登录页用已经取到的会话结果，不再请求一次', async () => {
    const api = installFakeApi(LOGGED_OUT)
    const app = renderApp('/')
    expect(await screen.findByRole('form', { name: '登录' })).toBeInTheDocument()
    expect(currentPath(app)).toBe('/login')
    await settle()
    expect(requestCount(api, 'GET /api/auth/session')).toBe(1)
  })

  it('登录成功：回到首页，显示我的空间与当前用户；通知其他标签页', async () => {
    const bus = sessionBus()
    const otherTab = vi.fn()
    bus.open().subscribe(otherTab)
    const api = installFakeApi({ ...LOGGED_OUT, 'POST /api/auth/login': () => json(200, SESSION), 'GET /api/documents': () => json(200, { items: [document(1)], nextCursor: null }) })
    const app = renderApp('/login', { sessionChannel: bus.open() })
    await fillLogin('alice', 'correct horse')
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()
    expect(screen.getByText('爱丽丝')).toBeInTheDocument()
    expect(currentPath(app)).toBe('/')
    expect(api.requests.find(request => request.key === 'POST /api/auth/login')?.body).toEqual({ username: 'alice', password: 'correct horse' })
    expect(otherTab).toHaveBeenCalledTimes(1)
  })

  it('用户名或密码错误：统一的提示；提交中按钮标为不可用，不能重复提交', async () => {
    const pending = deferred()
    const api = installFakeApi({ ...LOGGED_OUT, 'POST /api/auth/login': pending.handler })
    renderApp('/login')
    await fillLogin('alice', 'wrong')
    const button = await screen.findByRole('button', { name: '正在登录…' })
    // aria-disabled 而不是 disabled：焦点不会被浏览器丢到 body（审查 B13）
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    pending.resolve(apiError(401, 'INVALID_CREDENTIALS'))
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误')
    expect(requestCount(api, 'POST /api/auth/login')).toBe(1)
    expect(screen.getByRole('button', { name: '登录' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('尝试次数过多：提示要等多久', async () => {
    installFakeApi({ ...LOGGED_OUT, 'POST /api/auth/login': () => apiError(429, 'TOO_MANY_ATTEMPTS', 'x', { 'retry-after': '600' }) })
    renderApp('/login')
    await fillLogin('alice', 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent('尝试次数过多，请 10 分钟后再试')
  })

  it('浏览器认为离线时登录：请求照常发出，失败时提示网络错误（审查 B4）', async () => {
    installFakeApi({ ...LOGGED_OUT, 'POST /api/auth/login': networkFailure })
    renderApp('/login')
    await screen.findByRole('form', { name: '登录' })
    goOffline()
    await fillLogin('alice', 'correct horse')
    expect(await screen.findByRole('alert')).toHaveTextContent('网络连接失败，请检查网络后重试')
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument()
  })

  it('登录后回到原来要去的地址', async () => {
    installFakeApi({ ...LOGGED_OUT, 'POST /api/auth/login': () => json(200, SESSION), ...NO_DOCUMENTS })
    const app = renderApp('/?view=list')
    await screen.findByRole('form', { name: '登录' })
    expect(currentPath(app)).toBe('/login?from=%2F%3Fview%3Dlist')
    await fillLogin('alice', 'correct horse')
    await screen.findByRole('heading', { name: '我的空间' })
    expect(currentPath(app)).toBe('/?view=list')
  })

  it('已登录时打开登录页：确认会话之前显示骨架屏、不显示表单，随后直接回到首页（审查 B14）', async () => {
    const pending = deferred()
    installFakeApi({ 'GET /api/auth/session': pending.handler, ...NO_DOCUMENTS })
    const app = renderApp('/login')
    expect(await screen.findByRole('status', { name: '正在确认登录状态…' })).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: '登录' })).not.toBeInTheDocument()
    pending.resolve(json(200, SESSION))
    await screen.findByRole('heading', { name: '我的空间' })
    expect(currentPath(app)).toBe('/')
  })

  it('退出：带上 CSRF 令牌；通知其他标签页；整页回到登录页（上一个会话的数据随页面丢弃），之后不再带令牌', async () => {
    const bus = sessionBus()
    const otherTab = vi.fn()
    bus.open().subscribe(otherTab)
    const api = installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => json(200, { items: [document(1)], nextCursor: null }), 'POST /api/auth/logout': () => new Response(null, { status: 204 }), 'POST /api/probe': () => new Response(null, { status: 204 }) })
    const app = renderApp('/', { sessionChannel: bus.open() })
    await screen.findByText('文档 1')
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    await waitFor(() => expect(app.page.visits).toEqual(['/login']))
    expect(api.requests.find(request => request.key === 'POST /api/auth/logout')?.headers['x-csrf-token']).toBe('csrf-1')
    expect(otherTab).toHaveBeenCalledTimes(1)
    // 页面离开之前按钮一直是"正在退出"，再点也不重复请求
    const leaving = screen.getByRole('button', { name: '正在退出…' })
    expect(leaving).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(leaving)
    expect(requestCount(api, 'POST /api/auth/logout')).toBe(1)
    await apiRequest('/api/probe', { method: 'POST', schema: z.undefined() })
    expect(api.requests.find(request => request.key === 'POST /api/probe')?.headers['x-csrf-token']).toBeUndefined()
  })

  it('退出时会话已经不在了（401）：按退出成功处理，不提示失败', async () => {
    installFakeApi({ ...LOGGED_IN, ...NO_DOCUMENTS, 'POST /api/auth/logout': () => apiError(401, 'SESSION_EXPIRED') })
    const app = renderApp('/')
    await screen.findByRole('heading', { name: '我的空间' })
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    await waitFor(() => expect(app.page.visits).toEqual(['/login']))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('退出失败（网络）：留在原页面，说明原因，可以重试', async () => {
    const api = installFakeApi({ ...LOGGED_IN, ...NO_DOCUMENTS, 'POST /api/auth/logout': networkFailure })
    const app = renderApp('/')
    await screen.findByRole('heading', { name: '我的空间' })
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('退出失败：网络连接失败，请检查网络后重试')
    expect(currentPath(app)).toBe('/')
    expect(app.page.visits).toEqual([])
    api.on('POST /api/auth/logout', () => new Response(null, { status: 204 }))
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    await waitFor(() => expect(app.page.visits).toEqual(['/login']))
  })

  it('浏览器认为离线时退出：请求照常发出，失败时提示网络错误，不会一直停在"正在退出"（审查 B4）', async () => {
    const api = installFakeApi({ ...LOGGED_IN, ...NO_DOCUMENTS, 'POST /api/auth/logout': networkFailure })
    renderApp('/')
    await screen.findByRole('heading', { name: '我的空间' })
    goOffline()
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('退出失败：网络连接失败')
    expect(screen.getByRole('button', { name: '退出' })).toHaveAttribute('aria-disabled', 'false')
    expect(requestCount(api, 'POST /api/auth/logout')).toBe(1)
  })

  it('页面打开期间会话过期（加载更多得到 SESSION_EXPIRED）：整页回到登录页并提示过期，不再多发请求（审查 B7）', async () => {
    const api = installFakeApi({
      ...LOGGED_IN,
      'GET /api/documents': () => json(200, { items: [document(1)], nextCursor: 'c1' }),
      'GET /api/documents?cursor=c1': () => apiError(401, 'SESSION_EXPIRED'),
    })
    const app = renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(app.page.visits).toEqual(['/login?reason=expired']))
    await settle()
    // 不在单页里清空缓存：还挂着的列表不会立即重新请求（原来多出一次 GET /api/documents，它的 401 还可能把"已过期"改成"未登录"）
    expect(api.requests.map(request => request.key)).toEqual(['GET /api/auth/session', 'GET /api/documents', 'GET /api/documents?cursor=c1'])
    expect(app.page.visits).toEqual(['/login?reason=expired'])
  })

  it('其他请求得到 UNAUTHENTICATED（不是过期）：整页回到登录页，保留原来的地址；页面离开之前就不再带 CSRF 令牌', async () => {
    const api = installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => apiError(401, 'UNAUTHENTICATED'), 'POST /api/probe': () => new Response(null, { status: 204 }) })
    const app = renderApp('/?view=list')
    await waitFor(() => expect(app.page.visits).toEqual(['/login?from=%2F%3Fview%3Dlist']))
    await apiRequest('/api/probe', { method: 'POST', schema: z.undefined() })
    expect(api.requests.find(request => request.key === 'POST /api/probe')?.headers['x-csrf-token']).toBeUndefined()
  })

  it('登录页的地址带 reason=expired（会话过期后整页回到这里）：提示过期', async () => {
    installFakeApi(LOGGED_OUT)
    renderApp('/login?reason=expired')
    expect(await screen.findByText('登录已过期，请重新登录')).toBeInTheDocument()
  })

  it('打开页面时会话已过期：回到登录页，提示过期', async () => {
    installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'SESSION_EXPIRED') })
    const app = renderApp('/')
    expect(await screen.findByText('登录已过期，请重新登录')).toBeInTheDocument()
    expect(currentPath(app)).toBe('/login?reason=expired')
  })

  it('查询会话时网络失败：自动重试一次，仍失败时提示并可以重试', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': networkFailure })
    renderApp('/')
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('网络连接失败')
    expect(requestCount(api, 'GET /api/auth/session')).toBe(2)
    api.on('GET /api/auth/session', () => json(200, SESSION))
    api.on('GET /api/documents', () => json(200, { items: [], nextCursor: null }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()
  })
})

describe('会话的全局处理', () => {
  it('停在登录页时其他请求得到未登录：不再跳转', async () => {
    installFakeApi({ ...LOGGED_OUT, 'GET /api/other': () => apiError(401, 'UNAUTHENTICATED') })
    const app = renderApp('/login')
    await screen.findByRole('form', { name: '登录' })
    await expect(app.queryClient.fetchQuery({ queryKey: ['other'], queryFn: async () => apiRequest('/api/other', { schema: z.object({}) }) })).rejects.toThrow()
    expect(app.page.visits).toEqual([])
  })

  it('同时有几个请求得到未登录：只跳转一次', async () => {
    installFakeApi({ ...LOGGED_IN, ...NO_DOCUMENTS, 'GET /api/a': () => apiError(401, 'SESSION_EXPIRED'), 'GET /api/b': () => apiError(401, 'SESSION_EXPIRED') })
    const app = renderApp('/')
    await screen.findByRole('heading', { name: '我的空间' })
    const fetchOther = async (path: string) => app.queryClient.fetchQuery({ queryKey: [path], queryFn: async () => apiRequest(path, { schema: z.object({}) }) }).catch(() => undefined)
    await Promise.all([fetchOther('/api/a'), fetchOther('/api/b')])
    expect(app.page.visits).toEqual(['/login?reason=expired'])
  })
})

describe('多个标签页（审查 B6）', () => {
  /** 本页显示着爱丽丝的列表；otherTab 是同一个浏览器里的另一个标签页 */
  async function openList(): Promise<{ api: FakeApi, app: RenderedApp, otherTab: SessionChannel }> {
    const bus = sessionBus()
    const api = installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => json(200, { items: [document(1)], nextCursor: 'c1' }), 'POST /api/auth/logout': () => new Response(null, { status: 204 }) })
    const app = renderApp('/', { sessionChannel: bus.open() })
    await screen.findByText('文档 1')
    return { api, app, otherTab: bus.open() }
  }

  it('别的标签页退出后换人登录：本页向服务端确认，换了人就整页重新加载，不再显示上一个人的列表', async () => {
    const { api, app, otherTab } = await openList()
    api.on('GET /api/auth/session', () => json(200, OTHER_SESSION))
    otherTab.announce()
    await waitFor(() => expect(app.page.visits).toEqual(['reload']))
    // 页面离开期间别的消息不再处理
    otherTab.announce()
    await settle()
    expect(requestCount(api, 'GET /api/auth/session')).toBe(2)
  })

  it('别的标签页退出了：本页向服务端确认，已经未登录，整页重新加载（随后转到登录页）', async () => {
    const { api, app, otherTab } = await openList()
    api.on('GET /api/auth/session', () => apiError(401, 'UNAUTHENTICATED'))
    otherTab.announce()
    await waitFor(() => expect(app.page.visits).toEqual(['reload']))
  })

  it('别的标签页登录的是同一个人（新的会话）：换上新的会话与 CSRF 令牌，页面不动，之后的退出用新的令牌', async () => {
    const { api, app, otherTab } = await openList()
    api.on('GET /api/auth/session', () => json(200, { ...SESSION, csrfToken: 'csrf-2' }))
    otherTab.announce()
    await waitFor(() => expect(requestCount(api, 'GET /api/auth/session')).toBe(2))
    await settle()
    expect(app.page.visits).toEqual([])
    expect(screen.getByText('文档 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    await waitFor(() => expect(app.page.visits).toEqual(['/login']))
    expect(api.requests.find(request => request.key === 'POST /api/auth/logout')?.headers['x-csrf-token']).toBe('csrf-2')
  })

  it('确认期间又来了几条消息：合并成一次，这次确认结束后再补确认一次；确认失败（服务不可用、网络）时页面不动', async () => {
    const { api, app, otherTab } = await openList()
    const pending = deferred()
    api.on('GET /api/auth/session', pending.handler)
    otherTab.announce()
    otherTab.announce()
    otherTab.announce()
    api.on('GET /api/auth/session', () => apiError(503, 'SERVICE_UNAVAILABLE'))
    pending.resolve(apiError(503, 'SERVICE_UNAVAILABLE'))
    await waitFor(() => expect(requestCount(api, 'GET /api/auth/session')).toBe(3))
    await settle()
    expect(requestCount(api, 'GET /api/auth/session')).toBe(3)
    api.on('GET /api/auth/session', networkFailure)
    otherTab.announce()
    await waitFor(() => expect(requestCount(api, 'GET /api/auth/session')).toBe(4))
    await settle()
    expect(app.page.visits).toEqual([])
  })

  it('确认期间别的标签页又换了人：这次确认看到的还是原来的人，结束后再确认一次，发现换了人就整页重新加载（复验 R10）', async () => {
    const { api, app, otherTab } = await openList()
    const pending = deferred()
    api.on('GET /api/auth/session', pending.handler)
    otherTab.announce()
    api.on('GET /api/auth/session', () => json(200, OTHER_SESSION))
    otherTab.announce()
    pending.resolve(json(200, SESSION))
    await waitFor(() => expect(app.page.visits).toEqual(['reload']))
    expect(requestCount(api, 'GET /api/auth/session')).toBe(3)
  })

  it('退出得到 CSRF_TOKEN_INVALID（别的标签页换了人）：提示页面已失效；向服务端确认后换了人，整页重新加载', async () => {
    const { api, app } = await openList()
    api.on('POST /api/auth/logout', () => apiError(403, 'CSRF_TOKEN_INVALID'))
    api.on('GET /api/auth/session', () => json(200, OTHER_SESSION))
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('退出失败：页面已失效，请刷新后重试')
    await waitFor(() => expect(app.page.visits).toEqual(['reload']))
  })

  it('停在登录页时别的标签页登录了：整页重新加载，由登录页转到原来要去的地址', async () => {
    const bus = sessionBus()
    const api = installFakeApi(LOGGED_OUT)
    const app = renderApp('/login?from=%2F%3Fview%3Dlist', { sessionChannel: bus.open() })
    await screen.findByRole('form', { name: '登录' })
    api.on('GET /api/auth/session', () => json(200, SESSION))
    bus.open().announce()
    await waitFor(() => expect(app.page.visits).toEqual(['reload']))
  })

  it('停在登录页时别的标签页退出了：确认之后仍是未登录，页面不动', async () => {
    const bus = sessionBus()
    const api = installFakeApi(LOGGED_OUT)
    const app = renderApp('/login', { sessionChannel: bus.open() })
    await screen.findByRole('form', { name: '登录' })
    bus.open().announce()
    await waitFor(() => expect(requestCount(api, 'GET /api/auth/session')).toBe(2))
    await settle()
    expect(app.page.visits).toEqual([])
    expect(screen.getByRole('form', { name: '登录' })).toBeInTheDocument()
  })

  it('确认会话的过程中页面已经在离开（会话过期）：不再重新加载', async () => {
    const { api, app, otherTab } = await openList()
    const pending = deferred()
    api.on('GET /api/auth/session', pending.handler)
    api.on('GET /api/documents?cursor=c1', () => apiError(401, 'SESSION_EXPIRED'))
    otherTab.announce()
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(app.page.visits).toEqual(['/login?reason=expired']))
    pending.resolve(json(200, OTHER_SESSION))
    await settle()
    expect(app.page.visits).toEqual(['/login?reason=expired'])
  })
})

describe('US-M1-03 个人空间的文档列表', () => {
  it('确认会话时与加载列表时各有自己的骨架屏，随后显示文档：标题、类型与更新时间（审查 B10）', async () => {
    const session = deferred()
    const list = deferred()
    installFakeApi({ 'GET /api/auth/session': session.handler, 'GET /api/documents': list.handler })
    renderApp('/')
    expect(await screen.findByRole('status', { name: '正在确认登录状态…' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '正在加载文档列表…' })).not.toBeInTheDocument()
    session.resolve(json(200, SESSION))
    expect(await screen.findByRole('status', { name: '正在加载文档列表…' })).toBeInTheDocument()
    list.resolve(json(200, { items: [document(1), document(2)], nextCursor: null }))
    const items = within(await screen.findByRole('list', { name: '文档列表' })).getAllByRole('listitem').map(item => item.textContent)
    expect(items).toEqual([expect.stringContaining('文档 1'), expect.stringContaining('文档 2')])
    // 时间按浏览器的时区显示（测试环境是 UTC）
    expect(items[0]).toMatch(/表格 · 更新于 2026年9月26日/)
    expect(screen.queryByRole('status', { name: '正在加载文档列表…' })).not.toBeInTheDocument()
  })

  it('空列表：明确的说明', async () => {
    installFakeApi({ ...LOGGED_IN, ...NO_DOCUMENTS })
    renderApp('/')
    expect(await screen.findByText('这里还没有文档')).toBeInTheDocument()
  })

  it('加载失败：提示原因，可以重试', async () => {
    const api = installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => apiError(500, 'INTERNAL_ERROR') })
    renderApp('/')
    // 5xx 自动重试一次，之后才显示失败
    expect(await screen.findByText('文档列表加载失败', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText('服务器出了点问题，请稍后重试')).toBeInTheDocument()
    api.on('GET /api/documents', () => json(200, { items: [document(1)], nextCursor: null }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('文档 1')).toBeInTheDocument()
  })

  it('加载更多：按游标取下一页，焦点移到第一个新条目；下一页失败时保留已加载的列表并提示，焦点留在按钮上', async () => {
    const next = deferred()
    const api = installFakeApi({
      ...LOGGED_IN,
      'GET /api/documents': () => json(200, { items: [document(1)], nextCursor: 'c1' }),
      'GET /api/documents?cursor=c1': next.handler,
      'GET /api/documents?cursor=c2': () => apiError(404, 'NOT_FOUND'),
    })
    renderApp('/')
    const button = await screen.findByRole('button', { name: '加载更多' })
    button.focus()
    fireEvent.click(button)
    // 加载中：aria-disabled，焦点不丢；再点一次也不重复请求（审查 B13）
    expect(await screen.findByRole('button', { name: '正在加载…' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: '正在加载…' }))
    next.resolve(json(200, { items: [document(2)], nextCursor: 'c2' }))
    expect(await screen.findByText('文档 2')).toBeInTheDocument()
    await waitFor(() => expect(window.document.activeElement).toHaveTextContent('文档 2'))
    expect(requestCount(api, 'GET /api/documents?cursor=c1')).toBe(1)

    const again = screen.getByRole('button', { name: '加载更多' })
    again.focus()
    fireEvent.click(again)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('内容不存在'))
    expect(screen.getByText('文档 1')).toBeInTheDocument()
    expect(window.document.activeElement).toBe(screen.getByRole('button', { name: '加载更多' }))
  })

  it('浏览器认为离线时加载更多：请求照常发出，失败时提示网络错误，保留已加载的列表（审查 B4）', async () => {
    const api = installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => json(200, { items: [document(1)], nextCursor: 'c1' }), 'GET /api/documents?cursor=c1': networkFailure })
    renderApp('/')
    const button = await screen.findByRole('button', { name: '加载更多' })
    goOffline()
    fireEvent.click(button)
    // 网络失败自动重试一次，之后才显示
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('网络连接失败，请检查网络后重试')
    expect(screen.getByText('文档 1')).toBeInTheDocument()
    expect(requestCount(api, 'GET /api/documents?cursor=c1')).toBe(2)
  })
})

describe('页面不存在', () => {
  it('已登录：在页面框架里说明，并能回到首页', async () => {
    installFakeApi(LOGGED_IN)
    renderApp('/no-such-page')
    expect(await screen.findByRole('heading', { name: '页面不存在' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '回到首页' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('button', { name: '退出' })).toBeInTheDocument()
    expect(screen.getAllByRole('main')).toHaveLength(1)
  })

  it('未登录：先转到登录页，登录后回到原来的地址，看不出这个地址存不存在（审查 B23）', async () => {
    installFakeApi(LOGGED_OUT)
    const app = renderApp('/no-such-page')
    expect(await screen.findByRole('form', { name: '登录' })).toBeInTheDocument()
    expect(currentPath(app)).toBe('/login?from=%2Fno-such-page')
  })
})
