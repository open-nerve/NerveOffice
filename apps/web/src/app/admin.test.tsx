// 管理界面（M2-P1 设计 §3.8，US-M2-01、03、04、13）：只给系统管理员；账户的操作先确认；一次性链接只显示一次；审计的筛选。
import type { AdminUser, AuditEventItem, Invitation, SessionResponse } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

function session(systemRole: 'admin' | 'member'): SessionResponse {
  return {
    user: { id: '0199a2c4-0000-7000-8000-000000000001', username: 'root', displayName: '管理员', systemRole },
    personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000aa', name: '管理员' },
    csrfToken: 'csrf-1',
  }
}

const AMY: AdminUser = { id: '0199a2c4-0000-7000-8000-000000000002', username: 'amy', displayName: '艾米', systemRole: 'member', status: 'active', createdAt: '2026-09-28T01:00:00.000Z' }
const ROOT: AdminUser = { id: '0199a2c4-0000-7000-8000-000000000001', username: 'root', displayName: '管理员', systemRole: 'admin', status: 'active', createdAt: '2026-09-27T01:00:00.000Z' }

const INVITATION: Invitation = {
  id: '0199a2c4-0000-7000-8000-000000000010',
  username: 'bea',
  displayName: '贝亚',
  status: 'pending',
  createdAt: '2026-09-28T02:00:00.000Z',
  expiresAt: '2026-10-05T02:00:00.000Z',
  createdBy: { id: ROOT.id, username: 'root', displayName: '管理员' },
  acceptedAt: null,
  revokedAt: null,
}

const EVENT: AuditEventItem = {
  id: '0199a2c4-0000-7000-8000-000000000020',
  occurredAt: '2026-09-28T03:00:00.000Z',
  action: 'users.disabled',
  actor: { type: 'user', id: ROOT.id, username: 'root', displayName: '管理员' },
  target: { type: 'user', id: AMY.id, label: '艾米（amy）' },
  source: 'http',
  requestId: 'req-1',
  clientIp: '192.0.2.1',
  details: {},
}

describe('管理界面：访问', () => {
  it('成员：页头没有"管理"入口；直接打开看到无权限的说明，不请求管理接口', async () => {
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, session('member')),
    })
    renderApp('/admin/users')
    expect(await screen.findByText('只有系统管理员能打开管理界面。')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '管理' })).toBeNull()
    expect(api.requests.some(request => request.key.includes('/api/admin/'))).toBe(false)
  })

  it('系统管理员：页头有"管理"入口，/admin 打开账户页', async () => {
    installFakeApi({
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, { items: [ROOT, AMY], nextCursor: null }),
    })
    const app = renderApp('/admin')
    await waitFor(() => expect(currentPath(app)).toBe('/admin/users'))
    expect(await screen.findByRole('table', { name: '账户列表' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '管理' })).toHaveAttribute('href', '/admin')
  })
})

describe('管理界面：账户', () => {
  it('停用先确认后果；确认之后请求、刷新列表', async () => {
    let disabled = false
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, { items: [ROOT, { ...AMY, status: disabled ? 'disabled' : 'active' }], nextCursor: null }),
      [`POST /api/admin/users/${AMY.id}/disable`]: () => {
        disabled = true
        return json(200, { ...AMY, status: 'disabled' })
      },
    })
    renderApp('/admin/users')
    const row = (await screen.findByText('amy')).closest('tr')
    if (row === null)
      throw new Error('找不到这一行')
    fireEvent.click(within(row).getByRole('button', { name: '停用' }))
    const dialog = await screen.findByRole('dialog', { name: '停用 艾米（amy）？' })
    expect(within(dialog).getByText(/停用后，这个人立即不能访问/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.requests.some(request => request.key === `POST /api/admin/users/${AMY.id}/disable`)).toBe(true)
    // 状态的筛选里也有"已停用"这个选项：只在这一行里找
    await waitFor(() => expect(within(screen.getByText('amy').closest('tr') ?? document.body).getByText('已停用')).toBeInTheDocument())
  })

  it('取消最后一个系统管理员：弹窗里说明原因，弹窗留着', async () => {
    installFakeApi({
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, { items: [ROOT], nextCursor: null }),
      [`PUT /api/admin/users/${ROOT.id}/system-role`]: () => apiError(409, 'LAST_ADMIN'),
    })
    renderApp('/admin/users')
    fireEvent.click(await screen.findByRole('button', { name: '取消系统管理员' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消系统管理员' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('至少要保留一个有效的系统管理员')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('生成重置链接：确认之后弹出链接（只显示这一次）与到期时间；可以复制', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    installFakeApi({
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, { items: [AMY], nextCursor: null }),
      [`POST /api/admin/users/${AMY.id}/password-reset`]: () => json(201, { url: 'https://docs.example.com/reset-password#token', expiresAt: '2026-09-29T03:00:00.000Z' }),
    })
    renderApp('/admin/users')
    fireEvent.click(await screen.findByRole('button', { name: '生成重置链接' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '生成重置链接' }))
    const linkDialog = await screen.findByRole('dialog', { name: '重置链接：艾米（amy）' })
    expect(within(linkDialog).getByLabelText('链接')).toHaveValue('https://docs.example.com/reset-password#token')
    expect(within(linkDialog).getByText(/链接只显示这一次/)).toBeInTheDocument()
    fireEvent.click(within(linkDialog).getByRole('button', { name: '复制链接' }))
    expect(await within(linkDialog).findByText('已复制')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('https://docs.example.com/reset-password#token')
  })

  it('搜索与状态过滤：带着条件请求', async () => {
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, { items: [ROOT, AMY], nextCursor: null }),
      'GET /api/admin/users?status=disabled': () => json(200, { items: [], nextCursor: null }),
      'GET /api/admin/users?query=zzz&status=disabled': () => json(200, { items: [], nextCursor: null }),
    })
    renderApp('/admin/users')
    await screen.findByText('amy')
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'disabled' } })
    expect(await screen.findByText('没有符合条件的账户')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('按名字或登录名搜索'), { target: { value: 'zzz' } })
    await waitFor(() => expect(api.requests.some(request => request.key === 'GET /api/admin/users?query=zzz&status=disabled')).toBe(true))
  })
})

describe('管理界面：邀请', () => {
  it('签发：登录名不合规时在前端说明；合规时请求，弹出只显示一次的链接', async () => {
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, { items: [], nextCursor: null }),
      'POST /api/admin/invitations': () => json(201, { invitation: { ...INVITATION, username: 'zhang.san', displayName: '张三' }, url: 'https://docs.example.com/invite#token' }),
    })
    renderApp('/admin/invitations')
    await screen.findByText('还没有邀请')
    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: '张三' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '张三' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名为 3–32 个字符')
    expect(api.requests.some(request => request.key === 'POST /api/admin/invitations')).toBe(false)

    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'Zhang.San' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    const dialog = await screen.findByRole('dialog', { name: '邀请链接：张三（zhang.san）' })
    expect(within(dialog).getByLabelText('链接')).toHaveValue('https://docs.example.com/invite#token')
    expect(api.requests.find(request => request.key === 'POST /api/admin/invitations')?.body).toEqual({ username: 'zhang.san', displayName: '张三' })
  })

  it('列表显示状态与签发人；待接受的可以作废（先确认）', async () => {
    let revoked = false
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, { items: [{ ...INVITATION, status: revoked ? 'revoked' : 'pending' }], nextCursor: null }),
      [`POST /api/admin/invitations/${INVITATION.id}/revoke`]: () => {
        revoked = true
        return json(200, { ...INVITATION, status: 'revoked', revokedAt: '2026-09-28T04:00:00.000Z' })
      },
    })
    renderApp('/admin/invitations')
    const row = (await screen.findByText('bea')).closest('tr')
    if (row === null)
      throw new Error('找不到这一行')
    expect(within(row).getByText('待接受')).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: '作废' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '作废' }))
    expect(await screen.findByText('已作废')).toBeInTheDocument()
    expect(api.requests.some(request => request.key === `POST /api/admin/invitations/${INVITATION.id}/revoke`)).toBe(true)
  })
})

describe('管理界面：审计', () => {
  it('显示操作者、动作、对象、来源；按动作筛选、点对象只看这个对象', async () => {
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/audit-events': () => json(200, { items: [EVENT], nextCursor: null }),
      'GET /api/admin/audit-events?action=users.disabled': () => json(200, { items: [EVENT], nextCursor: null }),
      [`GET /api/admin/audit-events?action=users.disabled&targetId=${AMY.id}&targetType=user`]: () => json(200, { items: [EVENT], nextCursor: null }),
    })
    renderApp('/admin/audit')
    const table = await screen.findByRole('table', { name: '审计事件' })
    expect(within(table).getByText('管理员（root）')).toBeInTheDocument()
    expect(within(table).getByText('停用账户')).toBeInTheDocument()
    expect(within(table).getByText('网页 · 192.0.2.1')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('动作'), { target: { value: 'users.disabled' } })
    await waitFor(() => expect(api.requests.some(request => request.key === 'GET /api/admin/audit-events?action=users.disabled')).toBe(true))
    fireEvent.click(await screen.findByRole('button', { name: '账户：艾米（amy）' }))
    expect(await screen.findByText('对象：账户：艾米（amy）')).toBeInTheDocument()
    await waitFor(() => expect(api.requests.some(request => request.key.includes(`targetId=${AMY.id}`))).toBe(true))
  })
})
