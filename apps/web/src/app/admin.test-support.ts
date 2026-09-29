// 测试用：管理界面的夹具（admin.test.tsx、admin-audit.test.tsx 共用）。
import type { AdminUser, AuditEventItem, Invitation, SessionResponse } from '@nerve-office/contracts'
import type { Handler } from '../shared/testing/fake-api.test-support.ts'
import { screen } from '@testing-library/react'
import { spaceRoutes } from '../shared/testing/spaces.test-support.ts'

export const ROOT_ID = '0199a2c4-0000-7000-8000-000000000001'

export function session(systemRole: 'admin' | 'member', csrfToken = 'csrf-1'): SessionResponse {
  return {
    user: { id: ROOT_ID, username: 'root', displayName: '管理员', systemRole },
    personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000aa', name: '管理员' },
    csrfToken,
  }
}

/** 页框的导航与首页的页头（M2-P2）：两种角色的会话共用同一个个人空间 */
export const SPACES = spaceRoutes(session('admin'))

export const AMY: AdminUser = { id: '0199a2c4-0000-7000-8000-000000000002', username: 'amy', displayName: '艾米', systemRole: 'member', status: 'active', createdAt: '2026-09-28T01:00:00.000Z' }
export const ROOT: AdminUser = { id: ROOT_ID, username: 'root', displayName: '管理员', systemRole: 'admin', status: 'active', createdAt: '2026-09-27T01:00:00.000Z' }

export const INVITATION: Invitation = {
  id: '0199a2c4-0000-7000-8000-000000000010',
  username: 'bea',
  displayName: '贝亚',
  status: 'pending',
  createdAt: '2026-09-28T02:00:00.000Z',
  expiresAt: '2026-10-05T02:00:00.000Z',
  createdBy: { id: ROOT_ID, username: 'root', displayName: '管理员' },
  acceptedAt: null,
  revokedAt: null,
  superseded: false,
}

export const EVENT: AuditEventItem = {
  id: '0199a2c4-0000-7000-8000-000000000020',
  occurredAt: '2026-09-28T03:00:00.000Z',
  action: 'users.disabled',
  actor: { type: 'user', id: ROOT_ID, username: 'root', displayName: '管理员' },
  target: { type: 'user', id: AMY.id, label: '艾米（amy）' },
  source: 'http',
  requestId: 'req-1',
  clientIp: '192.0.2.1',
  details: {},
}

/** 一页列表 */
export function listPage<T>(items: readonly T[], nextCursor: string | null = null): { items: readonly T[], nextCursor: string | null } {
  return { items, nextCursor }
}

/** 先挂起、由测试决定何时返回的响应：用来观察"进行中"的界面 */
export function deferred(): { handler: Handler, resolve: (response: Response) => void } {
  let resolve: (response: Response) => void = () => {}
  const promise = new Promise<Response>((settle) => {
    resolve = settle
  })
  return { handler: async () => promise, resolve }
}

/** 表格里含这段文字的那一行 */
export async function rowOf(text: string): Promise<HTMLTableRowElement> {
  const row = (await screen.findByText(text)).closest('tr')
  if (row === null)
    throw new Error(`找不到含"${text}"的行`)
  return row
}

/** 让已经发出的请求与随后的渲染都走完：用来断言"没有再发请求" */
export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}
