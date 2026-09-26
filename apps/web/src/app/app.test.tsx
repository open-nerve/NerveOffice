// 平台页面的流程（P3 设计 §3.7）：与生产相同的路由表、请求缓存与全局的未登录处理，接口用假的 fetch。
import type { DocumentSummary, SessionResponse } from '@nerve-office/contracts'
import type { Handler } from '../shared/testing/fake-api.test-support.ts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '爱丽丝' },
  csrfToken: 'csrf-1',
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

const LOGGED_OUT = { 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') }
const LOGGED_IN = { 'GET /api/auth/session': () => json(200, SESSION) }

async function fillLogin(username: string, password: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText('用户名'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
}

describe('US-M1-02 登录与退出', () => {
  it('未登录访问首页：转到登录页', async () => {
    installFakeApi(LOGGED_OUT)
    const runtime = renderApp('/')
    expect(await screen.findByRole('form', { name: '登录' })).toBeInTheDocument()
    expect(currentPath(runtime)).toBe('/login')
  })

  it('登录成功：回到首页，显示我的空间与当前用户', async () => {
    const api = installFakeApi({ ...LOGGED_OUT, 'POST /api/auth/login': () => json(200, SESSION), 'GET /api/documents': () => json(200, { items: [document(1)], nextCursor: null }) })
    const runtime = renderApp('/login')
    await fillLogin('alice', 'correct horse')
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()
    expect(screen.getByText('爱丽丝')).toBeInTheDocument()
    expect(currentPath(runtime)).toBe('/')
    expect(api.requests.find(request => request.key === 'POST /api/auth/login')?.body).toEqual({ username: 'alice', password: 'correct horse' })
  })

  it('用户名或密码错误：统一的提示；提交中按钮不可用，不能重复提交', async () => {
    const pending = deferred()
    const api = installFakeApi({ ...LOGGED_OUT, 'POST /api/auth/login': pending.handler })
    renderApp('/login')
    await fillLogin('alice', 'wrong')
    const button = await screen.findByRole('button', { name: '正在登录…' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    pending.resolve(apiError(401, 'INVALID_CREDENTIALS'))
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误')
    expect(api.requests.filter(request => request.key === 'POST /api/auth/login')).toHaveLength(1)
  })

  it('尝试次数过多：提示要等多久', async () => {
    installFakeApi({ ...LOGGED_OUT, 'POST /api/auth/login': () => apiError(429, 'TOO_MANY_ATTEMPTS', 'x', { 'retry-after': '600' }) })
    renderApp('/login')
    await fillLogin('alice', 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent('尝试次数过多，请 10 分钟后再试')
  })

  it('登录后回到原来要去的地址', async () => {
    installFakeApi({ ...LOGGED_OUT, 'POST /api/auth/login': () => json(200, SESSION), 'GET /api/documents': () => json(200, { items: [], nextCursor: null }) })
    const runtime = renderApp('/?view=list')
    await screen.findByRole('form', { name: '登录' })
    expect(currentPath(runtime)).toBe('/login?from=%2F%3Fview%3Dlist')
    await fillLogin('alice', 'correct horse')
    await screen.findByRole('heading', { name: '我的空间' })
    expect(currentPath(runtime)).toBe('/?view=list')
  })

  it('已登录时打开登录页：直接回到首页', async () => {
    installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => json(200, { items: [], nextCursor: null }) })
    const runtime = renderApp('/login')
    await screen.findByRole('heading', { name: '我的空间' })
    expect(currentPath(runtime)).toBe('/')
  })

  it('退出：带上 CSRF 令牌，回到登录页，缓存的数据都清掉', async () => {
    const api = installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => json(200, { items: [document(1)], nextCursor: null }), 'POST /api/auth/logout': () => new Response(null, { status: 204 }) })
    const runtime = renderApp('/')
    await screen.findByText('文档 1')
    api.on('GET /api/auth/session', () => apiError(401, 'UNAUTHENTICATED'))
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    expect(await screen.findByRole('form', { name: '登录' })).toBeInTheDocument()
    expect(currentPath(runtime)).toBe('/login')
    expect(api.requests.find(request => request.key === 'POST /api/auth/logout')?.headers['x-csrf-token']).toBe('csrf-1')
    expect(screen.queryByText('文档 1')).not.toBeInTheDocument()
    expect(runtime.queryClient.getQueryData(['documents', 'personal'])).toBeUndefined()
  })

  it('退出失败（网络）：留在原页面，提示重试', async () => {
    installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => json(200, { items: [], nextCursor: null }), 'POST /api/auth/logout': () => {
      throw new TypeError('Failed to fetch')
    } })
    const runtime = renderApp('/')
    await screen.findByRole('heading', { name: '我的空间' })
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('退出失败，请重试')
    expect(currentPath(runtime)).toBe('/')
  })

  it('会话过期（其他请求得到 SESSION_EXPIRED）：回到登录页，提示过期', async () => {
    const api = installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => apiError(401, 'SESSION_EXPIRED') })
    const runtime = renderApp('/')
    api.on('GET /api/auth/session', () => apiError(401, 'SESSION_EXPIRED'))
    expect(await screen.findByText('登录已过期，请重新登录')).toBeInTheDocument()
    expect(currentPath(runtime)).toBe('/login?reason=expired')
  })

  it('打开页面时会话已过期：回到登录页，提示过期', async () => {
    installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'SESSION_EXPIRED') })
    const runtime = renderApp('/')
    expect(await screen.findByText('登录已过期，请重新登录')).toBeInTheDocument()
    expect(currentPath(runtime)).toBe('/login?reason=expired')
  })

  it('查询会话时网络失败：提示并可以重试', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => {
      throw new TypeError('Failed to fetch')
    } })
    renderApp('/')
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('网络连接失败')
    api.on('GET /api/auth/session', () => json(200, SESSION))
    api.on('GET /api/documents', () => json(200, { items: [], nextCursor: null }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()
  })
})

describe('US-M1-03 个人空间的文档列表', () => {
  it('加载中显示骨架屏，随后显示文档：标题、类型与更新时间', async () => {
    const pending = deferred()
    installFakeApi({ ...LOGGED_IN, 'GET /api/documents': pending.handler })
    renderApp('/')
    expect(await screen.findByRole('status', { name: '正在加载…' })).toBeInTheDocument()
    pending.resolve(json(200, { items: [document(1), document(2)], nextCursor: null }))
    const list = await screen.findByRole('list', { name: '文档列表' })
    const items = within(list).getAllByRole('listitem').map(item => item.textContent)
    expect(items).toEqual([expect.stringContaining('文档 1'), expect.stringContaining('文档 2')])
    // 时间按浏览器的时区显示（测试环境是 UTC）
    expect(items[0]).toMatch(/表格 · 更新于 2026年9月26日/)
  })

  it('空列表：明确的说明', async () => {
    installFakeApi({ ...LOGGED_IN, 'GET /api/documents': () => json(200, { items: [], nextCursor: null }) })
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

  it('加载更多：按游标取下一页；下一页失败时保留已加载的列表并提示', async () => {
    const api = installFakeApi({
      ...LOGGED_IN,
      'GET /api/documents': () => json(200, { items: [document(1)], nextCursor: 'c1' }),
      'GET /api/documents?cursor=c1': () => json(200, { items: [document(2)], nextCursor: 'c2' }),
      'GET /api/documents?cursor=c2': () => apiError(404, 'NOT_FOUND'),
    })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('文档 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('内容不存在'))
    expect(screen.getByText('文档 1')).toBeInTheDocument()
    expect(api.requests.map(request => request.key)).toContain('GET /api/documents?cursor=c2')
  })
})

describe('页面不存在', () => {
  it('没有这个页面：说明，并能回到首页', async () => {
    installFakeApi(LOGGED_IN)
    renderApp('/no-such-page')
    expect(await screen.findByRole('heading', { name: '页面不存在' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '回到首页' })).toHaveAttribute('href', '/')
  })
})
