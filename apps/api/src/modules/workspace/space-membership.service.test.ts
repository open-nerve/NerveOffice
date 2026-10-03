import type { SpaceAccess } from '../documents/index.ts'
import type { SpaceFacts, SpaceMemberRecord, SpaceRecord } from '../spaces/index.ts'
import type { User } from '../users/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { ManagedSpaces } from './managed-space.ts'
import { SpaceMembershipService } from './space-membership.service.ts'

const SPACE = '0199a2c4-0000-7000-8000-0000000000c1'
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const NOW = new Date('2026-09-29T08:00:00.000Z')
const ORIGIN = { source: 'http', requestId: 'req-1' } as const

const RECORD: SpaceRecord = { id: SPACE, type: 'team', name: '市场部', status: 'active', visibleToAll: false, createdAt: NOW }
const FACTS: SpaceFacts = { id: SPACE, type: 'team', name: '市场部', status: 'active', visibleToAll: false, owned: false, memberRole: 'admin' }
const MANAGER: SpaceAccess = { space: FACTS, role: 'admin', permissions: { canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: true, canRename: true, canPurgeTrash: true } }
const VIEWER: SpaceAccess = { space: FACTS, role: 'viewer', permissions: { canCreateDocuments: false, canCreateFolders: false, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false } }

function user(id: string, overrides: Partial<User> = {}): User {
  return { id, username: id === AMY ? 'amy' : 'ben', displayName: id === AMY ? '艾米' : '本', systemRole: 'member', status: 'active', ...overrides }
}

function principal(id: string, systemRole: 'admin' | 'member' = 'member') {
  return { user: user(id, { systemRole }), sessionId: 'session', csrfToken: 'csrf' }
}

function member(userId: string, role: SpaceMemberRecord['role']): SpaceMemberRecord {
  return { userId, role, createdAt: NOW }
}

/** 每一步记进 calls，核对顺序：先判断、再持住账户、再锁空间行、锁下再判断、改、收回写入权、审计。access 为 null：看不到 */
function setup(access: SpaceAccess | null = MANAGER) {
  const calls: string[] = []
  const transaction = { transaction: true }
  const policy = {
    spaceAccessOf: vi.fn(async () => {
      calls.push('check')
      return access ?? undefined
    }),
  }
  const spaces = {
    lockSpace: vi.fn(async () => {
      calls.push('lock')
      return RECORD
    }),
    members: vi.fn(async () => [member(BEN, 'viewer'), member(AMY, 'admin')]),
    addMember: vi.fn(async (_space: SpaceRecord, userId: string, role: SpaceMemberRecord['role']) => {
      calls.push('add')
      return member(userId, role)
    }),
    changeMemberRole: vi.fn(async (_space: SpaceRecord, userId: string, role: SpaceMemberRecord['role']) => {
      calls.push('change')
      return { member: member(userId, role), previousRole: 'viewer' as const, changed: role !== 'viewer' }
    }),
    removeMember: vi.fn(async (_space: SpaceRecord, userId: string) => {
      calls.push('remove')
      return member(userId, 'editor')
    }),
  }
  const users = {
    holdSystemAdmin: vi.fn(async () => {
      calls.push('system-admins')
      return true
    }),
    holdActiveAccount: vi.fn(async (userId: string): Promise<User | undefined> => {
      calls.push('account')
      return user(userId)
    }),
    findByIds: vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, user(id)]))),
  }
  const writeAccess = {
    revoke: vi.fn(async () => {
      calls.push('revoke')
    }),
  }
  const audit = {
    record: vi.fn(async () => {
      calls.push('audit')
    }),
  }
  const transactions = {
    run: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => work(transaction as never)),
    readSnapshot: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => work(transaction as never)),
  }
  const managed = new ManagedSpaces(policy as never, spaces as never, users as never)
  const service = new SpaceMembershipService(policy as never, spaces as never, users as never, managed, writeAccess, audit as never, transactions as never)
  return { service, calls, policy, spaces, users, writeAccess, audit, transaction }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('SpaceMembershipService.add', () => {
  it('先判断（不加锁）→ 持住要添加的账户 → 锁住空间行 → 锁下再判断 → 加 → 审计，都在一个事务里', async () => {
    const { service, calls, audit, spaces, transaction } = setup()
    expect(await service.add(principal(AMY), SPACE, { userId: BEN, role: 'editor' }, ORIGIN)).toMatchObject({ user: { id: BEN }, role: 'editor' })
    expect(calls).toEqual(['check', 'account', 'lock', 'check', 'add', 'audit'])
    expect(spaces.addMember).toHaveBeenCalledWith(RECORD, BEN, 'editor', transaction)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'spaces.member_added', target: { type: 'space', id: SPACE }, details: { userId: BEN, role: 'editor' } }), { transaction })
  })

  it('系统管理员：事务第一步在 system-admins 的锁里复核；把自己加入时审计记为系统管理员加入空间', async () => {
    const { service, calls, users, audit } = setup()
    await service.add(principal(AMY, 'admin'), SPACE, { userId: AMY, role: 'viewer' }, ORIGIN)
    expect(calls[0]).toBe('system-admins')
    expect(users.holdSystemAdmin).toHaveBeenCalledWith(AMY, expect.anything())
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'spaces.admin_joined', details: { role: 'viewer' } }), expect.anything())
  })

  it('普通成员不复核系统角色', async () => {
    const { service, users } = setup()
    await service.add(principal(AMY), SPACE, { userId: BEN, role: 'viewer' }, ORIGIN)
    expect(users.holdSystemAdmin).not.toHaveBeenCalled()
  })

  it('看不到：NOT_FOUND；只能查看：PERMISSION_DENIED；都不持住账户、不锁空间行', async () => {
    for (const [access, code] of [[null, 'NOT_FOUND'], [VIEWER, 'PERMISSION_DENIED']] as const) {
      const { service, calls } = setup(access)
      expect((await rejection(service.add(principal(AMY), SPACE, { userId: BEN, role: 'viewer' }, ORIGIN))).code).toBe(code)
      expect(calls).toEqual(['check'])
    }
  })

  it('要添加的账户不存在或已停用：ACCOUNT_UNAVAILABLE，不锁空间行', async () => {
    const { service, calls, users } = setup()
    users.holdActiveAccount.mockImplementationOnce(async () => {
      calls.push('account')
      return undefined
    })
    expect((await rejection(service.add(principal(AMY), SPACE, { userId: BEN, role: 'viewer' }, ORIGIN))).code).toBe('ACCOUNT_UNAVAILABLE')
    expect(calls).toEqual(['check', 'account'])
  })

  it('锁下再判断不通过（判断之后被降级）：PERMISSION_DENIED，不加', async () => {
    const { service, policy, spaces } = setup()
    policy.spaceAccessOf.mockResolvedValueOnce(MANAGER).mockResolvedValueOnce(VIEWER)
    expect((await rejection(service.add(principal(AMY), SPACE, { userId: BEN, role: 'viewer' }, ORIGIN))).code).toBe('PERMISSION_DENIED')
    expect(spaces.addMember).not.toHaveBeenCalled()
  })
})

describe('SpaceMembershipService.changeRole 与 remove', () => {
  it('调整角色：锁下再判断之后改，在同一个事务里经收回写入权的入口（这个人在这个空间），再记审计；响应里的名字也在这个事务里补', async () => {
    const { service, calls, writeAccess, users, transaction } = setup()
    expect(await service.changeRole(principal(AMY), SPACE, BEN, 'editor', ORIGIN)).toMatchObject({ user: { id: BEN }, role: 'editor' })
    expect(calls).toEqual(['check', 'lock', 'check', 'change', 'revoke', 'audit'])
    expect(writeAccess.revoke).toHaveBeenCalledWith({ kind: 'membership', userId: BEN, spaceId: SPACE }, transaction)
    // M2-P6 第 3 片复验：提交之后不再访问数据库
    expect(users.findByIds).toHaveBeenCalledWith([BEN], transaction)
  })

  it('角色没有变化：不收回、不记审计', async () => {
    const { service, writeAccess, audit } = setup()
    await service.changeRole(principal(AMY), SPACE, BEN, 'viewer', ORIGIN)
    expect(writeAccess.revoke).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('移出：同一个事务里收回写入权，审计带原角色', async () => {
    const { service, calls, writeAccess, audit, transaction } = setup()
    await service.remove(principal(AMY), SPACE, BEN, ORIGIN)
    expect(calls).toEqual(['check', 'lock', 'check', 'remove', 'revoke', 'audit'])
    expect(writeAccess.revoke).toHaveBeenCalledWith({ kind: 'membership', userId: BEN, spaceId: SPACE }, transaction)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'spaces.member_removed', details: { userId: BEN, role: 'editor' } }), { transaction })
  })
})

describe('SpaceMembershipService.list', () => {
  it('先按角色从高到低、再按显示名；带能不能管理', async () => {
    const { service, spaces, users, transaction } = setup()
    const page = await service.list({ userId: AMY, systemAdmin: false }, SPACE)
    expect(page.canManage).toBe(true)
    expect(page.items.map(item => [item.user.id, item.role])).toEqual([[AMY, 'admin'], [BEN, 'viewer']])
    // 判断、读成员与补人名在同一个只读快照里（M2 Codex 评审 CX1）
    expect(spaces.members).toHaveBeenCalledWith(SPACE, { transaction })
    expect(users.findByIds).toHaveBeenCalledWith(expect.anything(), transaction)
  })
})
