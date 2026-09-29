// 修改密码页（US-M2-02）：与生产相同的路由表与请求缓存，接口用假的 fetch。
import type { SessionResponse } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '爱丽丝' },
  csrfToken: 'csrf-1',
}

function fill(current: string, next: string, confirmation: string): void {
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: current } })
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: next } })
  fireEvent.change(screen.getByLabelText('再输入一次新密码'), { target: { value: confirmation } })
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
}

describe('修改密码页', () => {
  it('页头有入口；成功后清空表单，提示其他设备上的登录已经退出；请求带 CSRF 令牌', async () => {
    const api = installFakeApi({
      ...spaceRoutes(SESSION),
      'GET /api/auth/session': () => json(200, SESSION),
      'PUT /api/auth/password': () => new Response(null, { status: 204 }),
    })
    renderApp('/settings/password')
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
    const request = api.requests.find(entry => entry.key === 'PUT /api/auth/password')
    expect(request?.body).toEqual({ currentPassword: 'old password', newPassword: 'a brand new password' })
    expect(request?.headers['x-csrf-token']).toBe('csrf-1')
  })

  it('新密码太短、两次不一致：在前端就提示，不发请求', async () => {
    const api = installFakeApi({ ...spaceRoutes(SESSION), 'GET /api/auth/session': () => json(200, SESSION) })
    renderApp('/settings/password')
    await screen.findByLabelText('当前密码')
    fill('old password', 'short', 'short')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('密码至少 12 个字符')
    fill('old password', 'a brand new password', 'a different password')
    submit()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('两次输入的新密码不一致'))
    expect(api.requests.some(entry => entry.key === 'PUT /api/auth/password')).toBe(false)
  })

  it('当前密码不对：按错误码提示', async () => {
    installFakeApi({
      ...spaceRoutes(SESSION),
      'GET /api/auth/session': () => json(200, SESSION),
      'PUT /api/auth/password': () => apiError(403, 'CURRENT_PASSWORD_INCORRECT'),
    })
    renderApp('/settings/password')
    await screen.findByLabelText('当前密码')
    fill('wrong password', 'a brand new password', 'a brand new password')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('当前密码不正确')
  })

  it('尝试次数过多：按 Retry-After 提示几分钟后再试', async () => {
    installFakeApi({
      ...spaceRoutes(SESSION),
      'GET /api/auth/session': () => json(200, SESSION),
      'PUT /api/auth/password': () => apiError(429, 'TOO_MANY_ATTEMPTS', '说明', { 'retry-after': '600' }),
    })
    renderApp('/settings/password')
    await screen.findByLabelText('当前密码')
    fill('wrong password', 'a brand new password', 'a brand new password')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('请 10 分钟后再试')
  })
})
