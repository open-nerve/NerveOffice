import type { SpaceRecord, TeamSpaceOverview } from '../spaces/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AdminSpacesService } from './admin-spaces.service.ts'
import { AdminUsersService } from './admin-users.service.ts'

const SPACE = '0199a2c4-0000-7000-8000-0000000000c1'
const ROOT = '0199a2c4-0000-7000-8000-0000000000aa'
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const NOW = new Date('2026-09-29T08:00:00.000Z')
const ORIGIN = { source: 'http', requestId: 'req-1' } as const
const ACTOR = { user: { id: ROOT, username: 'root', displayName: '管理员', systemRole: 'admin', status: 'active' }, sessionId: 'session', csrfToken: 'csrf' } as const

function record(overrides: Partial<SpaceRecord> = {}): SpaceRecord {
  return { id: SPACE, type: 'team', name: '市场部', status: 'active', visibleToAll: false, createdAt: NOW, ...overrides }
}

function overview(space: SpaceRecord): TeamSpaceOverview {
  return { ...space, memberCount: 1, myRole: null, position: NOW.toISOString() }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

/** locked 为 null：锁不到这一行（不存在） */
function setup(locked: SpaceRecord | null = record()) {
  const calls: string[] = []
  const transaction = { transaction: true }
  let current = locked ?? undefined
  const users = {
    lockActingAdmin: vi.fn(async () => {
      calls.push('acting-admin')
    }),
    holdActiveAccount: vi.fn(async (): Promise<unknown> => {
      calls.push('account')
      return { id: AMY }
    }),
  }
  const spaces = {
    accessFactsOf: vi.fn(async () => {
      calls.push('facts')
      return current === undefined ? undefined : { type: current.type, status: current.status }
    }),
    lockSpace: vi.fn(async () => {
      calls.push('lock')
      return current
    }),
    setStatus: vi.fn(async (space: SpaceRecord, status: SpaceRecord['status']) => {
      calls.push('status')
      current = { ...space, status }
      return { space: current, changed: space.status !== status }
    }),
    setVisibility: vi.fn(async (space: SpaceRecord, visibleToAll: boolean) => {
      calls.push('visibility')
      current = { ...space, visibleToAll }
      return { space: current, changed: space.visibleToAll !== visibleToAll }
    }),
    createTeamSpace: vi.fn(async () => {
      calls.push('create')
      return record()
    }),
    teamSpaceOverview: vi.fn(async () => (current === undefined ? undefined : overview(current))),
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
  const transactions = { run: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => work(transaction as never)) }
  const service = new AdminSpacesService(users as never, spaces as never, writeAccess, audit as never, transactions as never)
  return { service, calls, users, spaces, writeAccess, audit, transaction }
}

describe('AdminSpacesService', () => {
  it('创建：先复核操作者，再持住首个空间管理员，再建；记审计', async () => {
    const { service, calls, spaces, audit } = setup()
    expect(await service.create(ACTOR, { name: '市场部', adminUserId: AMY, visibleToAll: false }, ORIGIN)).toMatchObject({ id: SPACE, name: '市场部' })
    expect(calls).toEqual(['acting-admin', 'account', 'create', 'audit'])
    expect(spaces.createTeamSpace).toHaveBeenCalledWith({ name: '市场部', adminUserId: AMY, visibleToAll: false, createdBy: ROOT }, expect.anything())
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'spaces.created', details: { adminUserId: AMY, visibleToAll: false } }), expect.anything())
  })

  it('首个空间管理员不可用：ACCOUNT_UNAVAILABLE，不建', async () => {
    const { service, users, spaces } = setup()
    users.holdActiveAccount.mockResolvedValueOnce(undefined)
    expect((await rejection(service.create(ACTOR, { name: '市场部', adminUserId: AMY, visibleToAll: false }, ORIGIN))).code).toBe('ACCOUNT_UNAVAILABLE')
    expect(spaces.createTeamSpace).not.toHaveBeenCalled()
  })

  it('归档：复核操作者 → 判断是团队空间（不加锁）→ 锁住空间行 → 改状态 → 同一个事务里收回写入权（整个空间）→ 审计', async () => {
    const { service, calls, writeAccess, transaction } = setup()
    expect(await service.setStatus(ACTOR, SPACE, 'archived', ORIGIN)).toMatchObject({ status: 'archived' })
    expect(calls).toEqual(['acting-admin', 'facts', 'lock', 'status', 'revoke', 'audit'])
    expect(writeAccess.revoke).toHaveBeenCalledWith({ kind: 'space', spaceId: SPACE }, transaction)
  })

  it('恢复与全员可见：不收回写入权；没有变化时不记审计', async () => {
    const { service, writeAccess, audit } = setup(record({ status: 'archived' }))
    await service.setStatus(ACTOR, SPACE, 'active', ORIGIN)
    await service.setVisibility(ACTOR, SPACE, true, ORIGIN)
    await service.setVisibility(ACTOR, SPACE, true, ORIGIN)
    expect(writeAccess.revoke).not.toHaveBeenCalled()
    expect(audit.record.mock.calls.map(call => (call as unknown[])[0])).toEqual([
      expect.objectContaining({ action: 'spaces.restored' }),
      expect.objectContaining({ action: 'spaces.visibility_changed', details: { visibleToAll: true } }),
    ])
  })

  it('个人空间与不存在的空间：NOT_FOUND（个人空间对系统管理员始终看不到），执行同样的步骤，都不在空间行上取锁', async () => {
    for (const locked of [record({ type: 'personal' }), null]) {
      const { service, calls, spaces } = setup(locked)
      expect((await rejection(service.setStatus(ACTOR, SPACE, 'archived', ORIGIN))).code).toBe('NOT_FOUND')
      expect(calls).toEqual(['acting-admin', 'facts'])
      expect(spaces.setStatus).not.toHaveBeenCalled()
    }
  })

  it('判断之后、加锁之前空间行变了（锁下再判断）：NOT_FOUND，不改', async () => {
    const { service, spaces } = setup()
    spaces.lockSpace.mockImplementationOnce(async () => undefined)
    expect((await rejection(service.setVisibility(ACTOR, SPACE, true, ORIGIN))).code).toBe('NOT_FOUND')
    expect(spaces.setVisibility).not.toHaveBeenCalled()
  })
})

describe('AdminUsersService.disable', () => {
  function disableSetup(changed: boolean) {
    const calls: string[] = []
    const users = {
      disable: vi.fn(async () => {
        calls.push('disable')
        return { account: { id: AMY, username: 'amy', displayName: '艾米', systemRole: 'member', status: 'disabled', createdAt: NOW }, changed }
      }),
    }
    const sessions = {
      revokeAllOf: vi.fn(async () => {
        calls.push('sessions')
      }),
    }
    const resets = {
      revokeOpenOf: vi.fn(async () => {
        calls.push('resets')
      }),
      revokeIssuedBy: vi.fn(async () => {
        calls.push('issued-resets')
      }),
    }
    const invitations = {
      revokeIssuedBy: vi.fn(async () => {
        calls.push('issued-invitations')
      }),
    }
    const lockouts = { locksOf: vi.fn(async () => new Map()) }
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
    const transaction = { transaction: true }
    const transactions = { run: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => work(transaction as never)) }
    const localKeys = { statesOf: vi.fn(async () => new Map()) }
    const service = new AdminUsersService(users as never, sessions as never, resets as never, invitations as never, lockouts as never, writeAccess, localKeys as never, audit as never, transactions as never)
    return { service, calls, writeAccess, resets, invitations, lockouts, transaction }
  }

  it('停用：在同一个事务里作废这个人的重置、他签发给别人的重置与邀请（M2-P6 复核 A2），撤销会话之后经收回写入权的入口（这个人），再记审计', async () => {
    const { service, calls, writeAccess, resets, invitations, lockouts, transaction } = disableSetup(true)
    await service.disable(ACTOR, AMY, ORIGIN)
    // 响应里的登录锁定在同一个事务里读（M2-P6 第 3 片复验：提交之后不再访问数据库）
    expect(lockouts.locksOf).toHaveBeenCalledWith(['amy'], transaction)
    expect(calls).toEqual(['disable', 'resets', 'issued-resets', 'issued-invitations', 'sessions', 'revoke', 'audit'])
    expect(writeAccess.revoke).toHaveBeenCalledWith({ kind: 'user', userId: AMY }, transaction)
    expect(resets.revokeIssuedBy).toHaveBeenCalledWith({ type: 'user', id: ACTOR.user.id }, AMY, 'issuer_disabled', ORIGIN, transaction)
    expect(invitations.revokeIssuedBy).toHaveBeenCalledWith(ACTOR.user, AMY, 'issuer_disabled', ORIGIN, transaction)
  })

  it('已经停用（没有变化）：不收回、不记审计', async () => {
    const { service, calls } = disableSetup(false)
    await service.disable(ACTOR, AMY, ORIGIN)
    expect(calls).toEqual(['disable'])
  })
})

describe('AdminUsersService：响应里的登录锁定与本机密钥的摘要（M3-P6）在同一个事务里读（M2-P6 第 3 片复验：提交之后不再访问数据库）', () => {
  const ACCOUNT = { id: AMY, username: 'amy', displayName: '艾米', systemRole: 'member', status: 'active', createdAt: NOW } as const

  function viewSetup() {
    const transaction = { transaction: true }
    const users = {
      enable: vi.fn(async () => ({ account: ACCOUNT, changed: true })),
      changeSystemRole: vi.fn(async () => ({ account: { ...ACCOUNT, systemRole: 'admin' }, changed: true })),
      lockActingAdmin: vi.fn(async () => {}),
      lockAccount: vi.fn(async () => ACCOUNT),
    }
    const lockouts = { locksOf: vi.fn(async () => new Map()), clear: vi.fn(async () => true) }
    const localKeys = { statesOf: vi.fn(async () => new Map([[AMY, { version: 2, createdAt: NOW }]])) }
    const audit = { record: vi.fn(async () => {}) }
    const transactions = { run: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => work(transaction as never)) }
    const service = new AdminUsersService(users as never, {} as never, {} as never, {} as never, lockouts as never, {} as never, localKeys as never, audit as never, transactions as never)
    return { service, lockouts, localKeys, transaction }
  }

  it.each([
    ['启用', async (service: AdminUsersService) => service.enable(ACTOR, AMY, ORIGIN)],
    ['改系统角色', async (service: AdminUsersService) => service.changeSystemRole(ACTOR, AMY, 'admin', ORIGIN)],
    ['解除登录锁定', async (service: AdminUsersService) => service.unlockLogin(ACTOR, AMY, ORIGIN)],
  ])('%s', async (_name, run) => {
    const { service, lockouts, localKeys, transaction } = viewSetup()
    const account = await run(service)
    expect(lockouts.locksOf).toHaveBeenCalledWith(['amy'], transaction)
    expect(localKeys.statesOf).toHaveBeenCalledWith([AMY], transaction)
    expect(account.localKey).toEqual({ version: 2, createdAt: NOW.toISOString() })
  })
})
