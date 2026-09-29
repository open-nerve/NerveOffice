// 邀请注册与重置密码的公开页面（M2-P1 设计 §3.8，US-M2-01、03）：令牌在 # 之后，读出后从地址里去掉、放进请求体；
// 成功后已登录，进入个人空间；链接不能用时按原因说下一步。
import type { SessionResponse } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { currentPath, renderApp, sessionBus } from './render-app.test-support.tsx'

const TOKEN = `${'t'.repeat(40)}-_x`
const NEW_TOKEN = `${'n'.repeat(40)}-_y`
const SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'zhang.san', displayName: '张三', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '张三' },
  csrfToken: 'csrf-new',
}
/** 别的标签页登录的人 */
const OTHER_SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-000000000009', username: 'admin', displayName: '管理员', systemRole: 'admin' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-000000000009', name: '管理员' },
  csrfToken: 'csrf-admin',
}
const INSPECTED = { username: 'zhang.san', displayName: '张三', expiresAt: '2026-10-05T00:00:00.000Z' }
const NO_DOCUMENTS = { [documentsKey(SESSION)]: () => json(200, { items: [], nextCursor: null }) }

function linkInvalid(reason: string): Response {
  return json(410, { error: { code: 'LINK_INVALID', message: '说明', requestId: 'req-1', details: { reason } } })
}

function fillPasswords(label: string, password: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: password } })
  fireEvent.change(screen.getByLabelText('再输入一次新密码'), { target: { value: password } })
}

/** 让已经发出的请求与随后的渲染都走完：用来断言"没有再发请求" */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

describe('接受邀请页', () => {
  it('令牌从 # 部分读出、从地址里去掉、放进请求体；显示登录名，可以改显示名；设置密码后进入个人空间', async () => {
    const api = installFakeApi({
      ...spaceRoutes(SESSION),
      'POST /api/auth/invitations/inspect': () => json(200, INSPECTED),
      'POST /api/auth/invitations/accept': () => json(200, SESSION),
      ...NO_DOCUMENTS,
    })
    const app = renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByText('zhang.san')).toBeInTheDocument()
    expect(app.router.state.location.hash).toBe('')
    expect(api.requests.find(request => request.key === 'POST /api/auth/invitations/inspect')?.body).toEqual({ token: TOKEN })

    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '张三丰' } })
    fillPasswords('设置密码', 'a good long password')
    fireEvent.click(screen.getByRole('button', { name: '设置密码并登录' }))
    await waitFor(() => expect(currentPath(app)).toBe('/'))
    expect(api.requests.find(request => request.key === 'POST /api/auth/invitations/accept')?.body).toEqual({ token: TOKEN, displayName: '张三丰', password: 'a good long password' })
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()
  })

  it('地址里没有令牌（例如令牌去掉之后刷新了页面）：请重新打开发来的链接，说明打开后会从地址栏去掉；不发请求（审查 B10）', async () => {
    const api = installFakeApi({})
    renderApp('/invite')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('请重新打开发给你的邀请链接')
    expect(alert).toHaveTextContent('链接打开之后会从地址栏里去掉')
    expect(alert).not.toHaveTextContent('请检查链接是否完整')
    expect(screen.queryByRole('link', { name: '去登录' })).toBeNull()
    expect(api.requests).toEqual([])
  })

  it('已经接受过的邀请：说明原因并给出登录的入口', async () => {
    installFakeApi({ ...spaceRoutes(SESSION), 'POST /api/auth/invitations/inspect': () => linkInvalid('used') })
    renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByRole('alert')).toHaveTextContent('这个邀请已经接受过了，请直接登录')
    expect(screen.getByRole('link', { name: '去登录' })).toHaveAttribute('href', '/login')
  })

  it.each([
    ['expired', '邀请链接已过期，请管理员重新发送'],
    ['revoked', '邀请链接已作废，请管理员重新发送'],
    ['invalid', '邀请链接无效：请检查链接是否完整，或者请管理员重新发送'],
  ])('邀请链接不能用（%s）：请管理员重新发送，不给"去登录"（受邀人还没有账户，审查 B10）', async (reason, message) => {
    installFakeApi({ ...spaceRoutes(SESSION), 'POST /api/auth/invitations/inspect': () => linkInvalid(reason) })
    renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByRole('link', { name: '去登录' })).toBeNull()
  })

  it('显示名清空：按显示名的规则说明（不是"请求的内容不合法"），不发接受的请求（审查 B10）', async () => {
    const api = installFakeApi({ ...spaceRoutes(SESSION), 'POST /api/auth/invitations/inspect': () => json(200, INSPECTED) })
    renderApp(`/invite#${TOKEN}`)
    await screen.findByText('zhang.san')
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '   ' } })
    fillPasswords('设置密码', 'a good long password')
    fireEvent.click(screen.getByRole('button', { name: '设置密码并登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('显示名为 1–64 个字符')
    expect(api.requests.some(request => request.key === 'POST /api/auth/invitations/accept')).toBe(false)
  })

  it('新密码不符合规则：前端就提示，不发接受的请求', async () => {
    const api = installFakeApi({ ...spaceRoutes(SESSION), 'POST /api/auth/invitations/inspect': () => json(200, INSPECTED) })
    renderApp(`/invite#${TOKEN}`)
    await screen.findByText('zhang.san')
    fillPasswords('设置密码', 'short')
    fireEvent.click(screen.getByRole('button', { name: '设置密码并登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('密码至少 12 个字符')
    expect(api.requests.some(request => request.key === 'POST /api/auth/invitations/accept')).toBe(false)
  })

  it('尝试次数过多：按 Retry-After 提示，可以重试', async () => {
    installFakeApi({ ...spaceRoutes(SESSION), 'POST /api/auth/invitations/inspect': () => apiError(429, 'TOO_MANY_ATTEMPTS', '说明', { 'retry-after': '120' }) })
    renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByRole('alert')).toHaveTextContent('请 2 分钟后再试')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('同一个标签页里只改 # 部分（粘贴重新发来的链接）：换上新的令牌，重新查看；上一个令牌的结果与填了一半的表单都不留下（审查 B3）', async () => {
    const api = installFakeApi({
      ...spaceRoutes(SESSION),
      'POST /api/auth/invitations/inspect': (init) => {
        const { token } = JSON.parse(String(init?.body)) as { token: string }
        return token === TOKEN ? linkInvalid('revoked') : json(200, { ...INSPECTED, username: 'li.si', displayName: '李四' })
      },
      'POST /api/auth/invitations/accept': () => json(200, SESSION),
      ...NO_DOCUMENTS,
    })
    const app = renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByRole('alert')).toHaveTextContent('邀请链接已作废，请管理员重新发送')
    await waitFor(() => expect(app.router.state.location.hash).toBe(''))

    // 片段导航：页面组件不重建
    await app.router.navigate(`/invite#${NEW_TOKEN}`)
    expect(await screen.findByText('li.si')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(app.router.state.location.hash).toBe(''))
    expect(api.requests.filter(request => request.key === 'POST /api/auth/invitations/inspect').map(request => request.body)).toEqual([{ token: TOKEN }, { token: NEW_TOKEN }])
    expect(screen.getByLabelText('显示名')).toHaveValue('李四')

    fillPasswords('设置密码', 'a good long password')
    fireEvent.click(screen.getByRole('button', { name: '设置密码并登录' }))
    await waitFor(() => expect(currentPath(app)).toBe('/'))
    expect(api.requests.find(request => request.key === 'POST /api/auth/invitations/accept')?.body).toEqual({ token: NEW_TOKEN, displayName: '李四', password: 'a good long password' })
  })

  it('别的标签页登录了（会话复核看到"换了人"）：公开页面不重新加载，令牌与表单都还在，照常接受（审查 B3）', async () => {
    const bus = sessionBus()
    const api = installFakeApi({
      ...spaceRoutes(SESSION),
      'POST /api/auth/invitations/inspect': () => json(200, INSPECTED),
      'POST /api/auth/invitations/accept': () => json(200, SESSION),
      'GET /api/auth/session': () => json(200, OTHER_SESSION),
      ...NO_DOCUMENTS,
    })
    const app = renderApp(`/invite#${TOKEN}`, { sessionChannel: bus.open() })
    await screen.findByText('zhang.san')
    fillPasswords('设置密码', 'a good long password')
    bus.open().announce()
    await settle()
    expect(app.page.visits).toEqual([])
    expect(api.requests.some(request => request.key === 'GET /api/auth/session')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '设置密码并登录' }))
    await waitFor(() => expect(currentPath(app)).toBe('/'))
    expect(api.requests.find(request => request.key === 'POST /api/auth/invitations/accept')?.body).toEqual({ token: TOKEN, displayName: '张三', password: 'a good long password' })
  })
})

describe('重置密码页', () => {
  it('显示登录名；设置新密码后进入个人空间', async () => {
    const api = installFakeApi({
      ...spaceRoutes(SESSION),
      'POST /api/auth/password-resets/inspect': () => json(200, INSPECTED),
      'POST /api/auth/password-resets/complete': () => json(200, SESSION),
      ...NO_DOCUMENTS,
    })
    const app = renderApp(`/reset-password#${TOKEN}`)
    expect(await screen.findByText('zhang.san')).toBeInTheDocument()
    expect(screen.queryByLabelText('显示名')).toBeNull()
    fillPasswords('新密码', 'the new long password')
    fireEvent.click(screen.getByRole('button', { name: '设置新密码并登录' }))
    await waitFor(() => expect(currentPath(app)).toBe('/'))
    expect(api.requests.find(request => request.key === 'POST /api/auth/password-resets/complete')?.body).toEqual({ token: TOKEN, password: 'the new long password' })
  })

  it('提交时链接已被作废（别处又签发了新的）：说明原因，不再显示表单，不给"去登录"', async () => {
    installFakeApi({
      ...spaceRoutes(SESSION),
      'POST /api/auth/password-resets/inspect': () => json(200, INSPECTED),
      'POST /api/auth/password-resets/complete': () => json(410, { error: { code: 'LINK_INVALID', message: '说明', requestId: 'req-2', details: { reason: 'revoked' } } }),
    })
    renderApp(`/reset-password#${TOKEN}`)
    await screen.findByText('zhang.san')
    fillPasswords('新密码', 'the new long password')
    fireEvent.click(screen.getByRole('button', { name: '设置新密码并登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('重置链接已作废，请管理员重新发送')
    expect(screen.queryByRole('button', { name: '设置新密码并登录' })).toBeNull()
    expect(screen.queryByRole('link', { name: '去登录' })).toBeNull()
  })

  it('已经用过的重置链接：说明原因并给出登录的入口', async () => {
    installFakeApi({ ...spaceRoutes(SESSION), 'POST /api/auth/password-resets/inspect': () => linkInvalid('used') })
    renderApp(`/reset-password#${TOKEN}`)
    expect(await screen.findByRole('alert')).toHaveTextContent('这个重置链接已经用过了，请直接用新密码登录')
    expect(screen.getByRole('link', { name: '去登录' })).toHaveAttribute('href', '/login')
  })

  it('地址里没有令牌：请重新打开发来的重置链接（审查 B10）', async () => {
    const api = installFakeApi({})
    renderApp('/reset-password')
    expect(await screen.findByRole('alert')).toHaveTextContent('请重新打开发给你的重置链接')
    expect(api.requests).toEqual([])
  })
})
