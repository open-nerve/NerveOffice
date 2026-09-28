// 邀请注册与重置密码的公开页面（M2-P1 设计 §3.8，US-M2-01、03）：令牌在 # 之后，读出后从地址里去掉、放进请求体；
// 成功后已登录，进入个人空间；链接不能用时按原因说下一步。
import type { SessionResponse } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

const TOKEN = `${'t'.repeat(40)}-_x`
const SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'zhang.san', displayName: '张三', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '张三' },
  csrfToken: 'csrf-new',
}
const INSPECTED = { username: 'zhang.san', displayName: '张三', expiresAt: '2026-10-05T00:00:00.000Z' }

function fillPasswords(label: string, password: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: password } })
  fireEvent.change(screen.getByLabelText('再输入一次新密码'), { target: { value: password } })
}

describe('接受邀请页', () => {
  it('令牌从 # 部分读出、从地址里去掉、放进请求体；显示登录名，可以改显示名；设置密码后进入个人空间', async () => {
    const api = installFakeApi({
      'POST /api/auth/invitations/inspect': () => json(200, INSPECTED),
      'POST /api/auth/invitations/accept': () => json(200, SESSION),
      'GET /api/documents?limit=50': () => json(200, { items: [], nextCursor: null }),
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
  })

  it('链接里没有令牌：直接说链接无效，不发请求', async () => {
    const api = installFakeApi({})
    renderApp('/invite')
    expect(await screen.findByRole('alert')).toHaveTextContent('邀请链接无效')
    expect(api.requests).toEqual([])
  })

  it('已经接受过的邀请：说明原因并给出登录的入口', async () => {
    installFakeApi({ 'POST /api/auth/invitations/inspect': () => json(410, { error: { code: 'LINK_INVALID', message: '说明', requestId: 'req-1', details: { reason: 'used' } } }) })
    renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByRole('alert')).toHaveTextContent('这个邀请已经接受过了，请直接登录')
    expect(screen.getByRole('link', { name: '去登录' })).toHaveAttribute('href', '/login')
  })

  it('新密码不符合规则：前端就提示，不发接受的请求', async () => {
    const api = installFakeApi({ 'POST /api/auth/invitations/inspect': () => json(200, INSPECTED) })
    renderApp(`/invite#${TOKEN}`)
    await screen.findByText('zhang.san')
    fillPasswords('设置密码', 'short')
    fireEvent.click(screen.getByRole('button', { name: '设置密码并登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('密码至少 12 个字符')
    expect(api.requests.some(request => request.key === 'POST /api/auth/invitations/accept')).toBe(false)
  })

  it('尝试次数过多：按 Retry-After 提示，可以重试', async () => {
    installFakeApi({ 'POST /api/auth/invitations/inspect': () => apiError(429, 'TOO_MANY_ATTEMPTS', '说明', { 'retry-after': '120' }) })
    renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByRole('alert')).toHaveTextContent('请 2 分钟后再试')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('重置密码页', () => {
  it('显示登录名；设置新密码后进入个人空间', async () => {
    const api = installFakeApi({
      'POST /api/auth/password-resets/inspect': () => json(200, INSPECTED),
      'POST /api/auth/password-resets/complete': () => json(200, SESSION),
      'GET /api/documents?limit=50': () => json(200, { items: [], nextCursor: null }),
    })
    const app = renderApp(`/reset-password#${TOKEN}`)
    expect(await screen.findByText('zhang.san')).toBeInTheDocument()
    expect(screen.queryByLabelText('显示名')).toBeNull()
    fillPasswords('新密码', 'the new long password')
    fireEvent.click(screen.getByRole('button', { name: '设置新密码并登录' }))
    await waitFor(() => expect(currentPath(app)).toBe('/'))
    expect(api.requests.find(request => request.key === 'POST /api/auth/password-resets/complete')?.body).toEqual({ token: TOKEN, password: 'the new long password' })
  })

  it('提交时链接已被作废（别处又签发了新的）：说明原因，不再显示表单', async () => {
    installFakeApi({
      'POST /api/auth/password-resets/inspect': () => json(200, INSPECTED),
      'POST /api/auth/password-resets/complete': () => json(410, { error: { code: 'LINK_INVALID', message: '说明', requestId: 'req-2', details: { reason: 'revoked' } } }),
    })
    renderApp(`/reset-password#${TOKEN}`)
    await screen.findByText('zhang.san')
    fillPasswords('新密码', 'the new long password')
    fireEvent.click(screen.getByRole('button', { name: '设置新密码并登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('重置链接已作废，请管理员重新发送')
    expect(screen.queryByRole('button', { name: '设置新密码并登录' })).toBeNull()
  })
})
