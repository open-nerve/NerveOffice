// 修改密码页（US-M2-02）：与生产相同的路由表与请求缓存，接口用假的 fetch。
// 成功时当前页面换成新的会话（M2-P6 复核 B1）；结果未知时的提示与之后再提交的说法（复核 G-1）；
// 结果未知时立即带着"新密码可能已经生效"的原因确认会话（第五批 G2）。
import type { SessionResponse } from '@nerve-office/contracts'
import type { Handler } from '../shared/testing/fake-api.test-support.ts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_QUERY_KEY } from '../features/auth/index.ts'
import { apiError, installFakeApi, inTurn, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { renderApp, sessionBus } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '爱丽丝' },
  csrfToken: 'csrf-1',
}

/** 改完密码之后当前页面的新会话：同一个人，新的 CSRF 令牌 */
const RENEWED: SessionResponse = { ...SESSION, csrfToken: 'csrf-2' }

const CHANGE = 'PUT /api/auth/password'

function fill(current: string, next: string, confirmation: string): void {
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: current } })
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: next } })
  fireEvent.change(screen.getByLabelText('再输入一次新密码'), { target: { value: confirmation } })
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
}

async function openPage(handlers: Record<string, Handler>, options: Parameters<typeof renderApp>[1] = {}) {
  const api = installFakeApi({ ...spaceRoutes(SESSION), 'GET /api/auth/session': () => json(200, SESSION), ...handlers })
  const app = renderApp('/settings/password', options)
  await screen.findByLabelText('当前密码')
  return { api, app }
}

const UNKNOWN_TEXT = /没能确认密码是否已经改好.*新密码可能已经生效/

describe('修改密码页', () => {
  it('页头有入口；成功后清空表单，提示其他设备上的登录已经退出；请求带 CSRF 令牌', async () => {
    const { api } = await openPage({ [CHANGE]: () => json(200, RENEWED) })
    expect(await screen.findByRole('link', { name: '修改密码' })).toHaveAttribute('href', '/settings/password')
    fill('old password', 'a brand new password', 'a brand new password')
    const button = screen.getByRole('button', { name: '修改密码' })
    button.focus()
    submit()
    // 按文字找（页框的导航加载时也有 role="status" 的占位，M2-P2），提示条是它外层 role="status" 的元素
    const changed = (await screen.findByText('密码已修改。你在其他设备上的登录已经退出。')).closest('[role="status"]')
    expect(changed).not.toBeNull()
    expect(screen.getByLabelText('当前密码')).toHaveValue('')
    // 清空之后提交按钮变成 disabled：焦点移到成功的提示，不落到 body（审查 B9）
    expect(button).toBeDisabled()
    await waitFor(() => expect(document.activeElement).toBe(changed))
    const request = api.requests.find(entry => entry.key === CHANGE)
    expect(request?.body).toEqual({ currentPassword: 'old password', newPassword: 'a brand new password' })
    expect(request?.headers['x-csrf-token']).toBe('csrf-1')
  })

  it('成功之后当前页面换上新的会话（M2-P6 复核 B1）：下一次状态变更带新的 CSRF 令牌，请求缓存里是新的会话，其他标签页收到通知', async () => {
    const bus = sessionBus()
    const otherTab = vi.fn()
    bus.open().subscribe(otherTab)
    const { api, app } = await openPage({ [CHANGE]: inTurn(() => json(200, RENEWED), () => json(200, { ...RENEWED, csrfToken: 'csrf-3' })) }, { sessionChannel: bus.open() })
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    await screen.findByText('密码已修改。你在其他设备上的登录已经退出。')
    expect(app.queryClient.getQueryData<SessionResponse>(SESSION_QUERY_KEY)?.csrfToken).toBe('csrf-2')
    expect(otherTab).toHaveBeenCalledTimes(1)

    // 再改一次：旧的 CSRF 令牌随旧会话失效了，这次必须带新的
    fill('a brand new password', 'another new password', 'another new password')
    submit()
    await waitFor(() => expect(api.requests.filter(entry => entry.key === CHANGE)).toHaveLength(2))
    expect(api.requests.filter(entry => entry.key === CHANGE).map(entry => entry.headers['x-csrf-token'])).toEqual(['csrf-1', 'csrf-2'])
  })

  it('新密码太短、两次不一致：在前端就提示，不发请求', async () => {
    const { api } = await openPage({})
    fill('old password', 'short', 'short')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('密码至少 12 个字符')
    fill('old password', 'a brand new password', 'a different password')
    submit()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('两次输入的新密码不一致'))
    expect(api.requests.some(entry => entry.key === CHANGE)).toBe(false)
  })

  it('当前密码不对：按错误码提示', async () => {
    await openPage({ [CHANGE]: () => apiError(403, 'CURRENT_PASSWORD_INCORRECT') })
    fill('wrong password', 'a brand new password', 'a brand new password')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent(/^当前密码不正确$/)
  })

  it('尝试次数过多：按 Retry-After 提示几分钟后再试', async () => {
    await openPage({ [CHANGE]: () => apiError(429, 'TOO_MANY_ATTEMPTS', '说明', { 'retry-after': '600' }) })
    fill('wrong password', 'a brand new password', 'a brand new password')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('请 10 分钟后再试')
  })
})

describe('修改密码：结果未知时（M2-P6 复核 G-1）', () => {
  it.each([
    ['断网', networkFailure, '网络连接失败'],
    ['服务端出错（500）', () => apiError(500, 'INTERNAL_ERROR'), '服务器出了点问题'],
    ['代理的错误页（502，不是约定的格式）', () => new Response('<html>Bad Gateway</html>', { status: 502 }), '出了点问题'],
    ['回包读不出来（与契约不一致）', () => new Response(null, { status: 204 }), '出了点问题'],
  ])('%s：说明新密码可能已经生效，带上原因', async (_case, failure, reason) => {
    await openPage({ [CHANGE]: failure })
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(UNKNOWN_TEXT)
    expect(alert).toHaveTextContent(reason)
  })

  it('结果未知（代理的 502），服务端其实已经改好、当前会话随之撤销（新会话的 Cookie 随回包一起丢了）：随即带着 password_changed 确认会话、回到登录页，不等再提交（第五批 G2）', async () => {
    let changed = false
    const { api, app } = await openPage({
      'GET /api/auth/session': () => (changed ? apiError(401, 'SESSION_EXPIRED') : json(200, SESSION)),
      [CHANGE]: () => {
        changed = true
        return new Response('<html>Bad Gateway</html>', { status: 502 })
      },
    })
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    // 原来要等别处的请求得到"登录已过期"才离开，一换页就只说"登录已过期"
    await waitFor(() => expect(app.page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=password_changed']))
    expect(api.requests.filter(entry => entry.key === CHANGE)).toHaveLength(1)
    expect(api.requests.filter(entry => entry.key === 'GET /api/auth/session').length).toBeGreaterThan(1)
  })

  it('结果未知，确认之后会话还在（没有改成，或者新会话的 Cookie 已经到了）：留在页面上说明新密码可能已经生效，页面不动', async () => {
    const { api, app } = await openPage({ [CHANGE]: networkFailure })
    const checked = api.requests.filter(entry => entry.key === 'GET /api/auth/session').length
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent(UNKNOWN_TEXT)
    await waitFor(() => expect(api.requests.filter(entry => entry.key === 'GET /api/auth/session').length).toBeGreaterThan(checked))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(app.page.visits).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN_TEXT)
  })

  it('服务端自己回答的"服务繁忙"（503）：在写入之前就拒绝了，结果是确定的，照常提示', async () => {
    await openPage({ [CHANGE]: () => apiError(503, 'SERVICE_UNAVAILABLE', '说明', { 'retry-after': '3' }) })
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/^服务暂时不可用，请稍后重试$/)
  })

  it('结果未知之后再提交，当前密码不对：说明上一次可能已经改好了', async () => {
    await openPage({ [CHANGE]: inTurn(networkFailure, () => apiError(403, 'CURRENT_PASSWORD_INCORRECT')) })
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent(UNKNOWN_TEXT)
    submit()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('上一次提交可能已经把密码改好了'))
  })

  it('结果未知之后又成功了一次：之后当前密码不对照常说"当前密码不正确"', async () => {
    await openPage({ [CHANGE]: inTurn(networkFailure, () => json(200, RENEWED), () => apiError(403, 'CURRENT_PASSWORD_INCORRECT')) })
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent(UNKNOWN_TEXT)
    submit()
    await screen.findByText('密码已修改。你在其他设备上的登录已经退出。')
    fill('guess', 'another new password', 'another new password')
    submit()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^当前密码不正确$/))
  })

  it('结果未知之后再提交，登录已过期（多半是上一次已经改好、当前会话随之撤销了）：向服务端确认已经没有会话，整页回到登录页，原因是 password_changed', async () => {
    const { api, app } = await openPage({ [CHANGE]: inTurn(networkFailure, () => apiError(401, 'SESSION_EXPIRED')) })
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent(UNKNOWN_TEXT)
    // 上一次的响应没收到：浏览器里还是旧的 Cookie，它随那次修改撤销了（服务端不清除它，复验 N3）
    api.on('GET /api/auth/session', () => apiError(401, 'SESSION_EXPIRED'))
    submit()
    await waitFor(() => expect(app.page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=password_changed']))
  })

  it('没有结果未知在前，登录已过期：向服务端确认已经没有会话，照常回到登录页，原因是 expired', async () => {
    const { api, app } = await openPage({ [CHANGE]: () => apiError(401, 'SESSION_EXPIRED') })
    api.on('GET /api/auth/session', () => apiError(401, 'UNAUTHENTICATED'))
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    await waitFor(() => expect(app.page.visits).toEqual(['/login?from=%2Fsettings%2Fpassword&reason=expired']))
  })

  it('登录已过期，但确认时还是同一个人（本人刚在别的标签页改过密码，这个请求带的是旧 Cookie，复验 N3）：页面不动，说明这次没有改成，可以再提交', async () => {
    const { api, app } = await openPage({ [CHANGE]: inTurn(() => apiError(401, 'SESSION_EXPIRED'), () => json(200, RENEWED)) })
    api.on('GET /api/auth/session', () => json(200, { ...SESSION, csrfToken: 'csrf-from-other-tab' }))
    fill('old password', 'a brand new password', 'a brand new password')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('登录状态刚刚变化，这次操作没有完成，请重试')
    await waitFor(() => expect(app.queryClient.getQueryData<SessionResponse>(SESSION_QUERY_KEY)?.csrfToken).toBe('csrf-from-other-tab'))
    expect(app.page.visits).toEqual([])
    // 不自动重试：只发了一次；再提交时带着换上的令牌
    expect(api.requests.filter(entry => entry.key === CHANGE)).toHaveLength(1)
    submit()
    await screen.findByText('密码已修改。你在其他设备上的登录已经退出。')
    expect(api.requests.filter(entry => entry.key === CHANGE).map(entry => entry.headers['x-csrf-token'])).toEqual(['csrf-1', 'csrf-from-other-tab'])
  })

  it('登录页按 password_changed 提示新密码可能已经生效', async () => {
    installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') })
    renderApp('/login?from=%2Fsettings%2Fpassword&reason=password_changed')
    expect(await screen.findByText('刚才修改密码时没能确认结果，随后登录失效了：新密码可能已经生效，请试试用新密码登录。')).toBeInTheDocument()
    expect(screen.queryByText('登录已过期，请重新登录')).toBeNull()
  })
})
