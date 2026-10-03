import type { SpaceRecord } from '../spaces/index.ts'
import type { User } from '../users/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AdminTransferService } from './admin-transfer.service.ts'

// id 的大小决定加锁的顺序：来源账户比目标账户大，来源空间比目标空间大
const SOURCE = '0199a2c4-0000-7000-8000-0000000000f2'
const TARGET_USER = '0199a2c4-0000-7000-8000-0000000000f1'
const SOURCE_SPACE = '0199a2c4-0000-7000-8000-0000000000e2'
const TARGET_SPACE = '0199a2c4-0000-7000-8000-0000000000e1'
const ROOT = '0199a2c4-0000-7000-8000-0000000000aa'
const DOCUMENTS = ['0199a2c4-0000-7000-8000-0000000000d1', '0199a2c4-0000-7000-8000-0000000000d2']
const NOW = new Date('2026-09-29T08:00:00.000Z')
const ORIGIN = { source: 'http', requestId: 'req-1' } as const
const ACTOR = { user: { id: ROOT, username: 'root', displayName: '管理员', systemRole: 'admin', status: 'active' }, sessionId: 'session', csrfToken: 'csrf' } as const

function account(id: string, status: User['status']): User {
  return { id, username: id.slice(-2), displayName: id.slice(-2), systemRole: 'member', status }
}

function space(id: string, overrides: Partial<SpaceRecord> = {}): SpaceRecord {
  return { id, type: 'personal', name: id.slice(-2), status: 'active', visibleToAll: false, createdAt: NOW, ...overrides }
}

function setup() {
  const calls: string[] = []
  const accounts = new Map<string, User>([[SOURCE, account(SOURCE, 'disabled')], [TARGET_USER, account(TARGET_USER, 'active')]])
  const spaces = new Map<string, SpaceRecord>([[SOURCE_SPACE, space(SOURCE_SPACE)], [TARGET_SPACE, space(TARGET_SPACE)]])
  const users = {
    lockActingAdmin: vi.fn(async () => {
      calls.push('acting-admin')
    }),
    holdAccount: vi.fn(async (id: string) => {
      calls.push(`account ${id.slice(-2)}`)
      return accounts.get(id)
    }),
    findByIds: vi.fn(async (ids: readonly string[]) => new Map(ids.flatMap(id => accounts.has(id) ? [[id, accounts.get(id) as User] as const] : []))),
  }
  const spaceService = {
    personalSpaceOf: vi.fn(async (userId: string) => ({ id: userId === SOURCE ? SOURCE_SPACE : TARGET_SPACE, name: '个人空间' })),
    accessFactsOf: vi.fn(async (_userId: string, id: string) => {
      calls.push(`facts ${id.slice(-2)}`)
      const found = spaces.get(id)
      return found === undefined ? undefined : { type: found.type, status: found.status }
    }),
    holdSpace: vi.fn(async (id: string) => {
      calls.push(`space ${id.slice(-2)}`)
      return spaces.get(id)
    }),
  }
  const transfers = {
    titles: vi.fn(async () => ({ items: [], nextCursor: null })),
    transfer: vi.fn(async (ids: readonly string[]) => {
      calls.push('documents')
      return [...ids]
    }),
  }
  const audit = {
    record: vi.fn(async () => {
      calls.push('audit')
    }),
  }
  const transactions = {
    run: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => work({ transaction: true } as never)),
    readSnapshot: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => work({ snapshot: true } as never)),
  }
  const service = new AdminTransferService(users as never, spaceService as never, transfers as never, audit as never, transactions as never)
  return { service, calls, accounts, spaces, transfers, audit }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('AdminTransferService.transfer', () => {
  it('锁的顺序：复核操作者 → 账户行（按 id）→ 空间行（按 id）→ 文档 → 每份一条审计', async () => {
    const { service, calls, transfers, audit } = setup()
    expect(await service.transfer(ACTOR, SOURCE, { documentIds: DOCUMENTS, target: { type: 'personal', userId: TARGET_USER } }, ORIGIN)).toEqual({ transferred: 2 })
    expect(calls).toEqual(['acting-admin', 'account f1', 'account f2', 'space e1', 'space e2', 'documents', 'audit', 'audit'])
    expect(transfers.transfer).toHaveBeenCalledWith(DOCUMENTS, SOURCE_SPACE, TARGET_SPACE, expect.anything())
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'documents.transferred',
      target: { type: 'document', id: DOCUMENTS[0] },
      details: { fromSpaceId: SOURCE_SPACE, toSpaceId: TARGET_SPACE },
    }), expect.anything())
  })

  it('目标是操作者自己的个人空间：PERMISSION_DENIED，不开事务', async () => {
    const { service, calls } = setup()
    const error = await rejection(service.transfer(ACTOR, SOURCE, { documentIds: DOCUMENTS, target: { type: 'personal', userId: ROOT } }, ORIGIN))
    expect(error.code).toBe('PERMISSION_DENIED')
    expect(calls).toEqual([])
  })

  it('来源不是停用的：ACCOUNT_NOT_DISABLED；目标账户不是有效的：ACCOUNT_UNAVAILABLE；都不锁空间、不动文档', async () => {
    for (const [change, code] of [
      [(accounts: Map<string, User>) => accounts.set(SOURCE, account(SOURCE, 'active')), 'ACCOUNT_NOT_DISABLED'],
      [(accounts: Map<string, User>) => accounts.set(TARGET_USER, account(TARGET_USER, 'disabled')), 'ACCOUNT_UNAVAILABLE'],
      [(accounts: Map<string, User>) => accounts.delete(SOURCE), 'NOT_FOUND'],
    ] as const) {
      const { service, calls, accounts } = setup()
      change(accounts)
      expect((await rejection(service.transfer(ACTOR, SOURCE, { documentIds: DOCUMENTS, target: { type: 'personal', userId: TARGET_USER } }, ORIGIN))).code).toBe(code)
      expect(calls.filter(call => call.startsWith('space') || call === 'documents')).toEqual([])
    }
  })

  it('团队空间的目标：已归档 SPACE_ARCHIVED（锁下判断）；不是团队空间或不存在 NOT_FOUND（先判断，不锁空间行，两条路径的步骤相同）；都不动文档', async () => {
    for (const [target, code, spaceCalls] of [
      [space(TARGET_SPACE, { type: 'team', status: 'archived' }), 'SPACE_ARCHIVED', ['facts e1', 'space e1', 'space e2']],
      [space(TARGET_SPACE), 'NOT_FOUND', ['facts e1']],
      [undefined, 'NOT_FOUND', ['facts e1']],
    ] as const) {
      const { service, calls, spaces, transfers } = setup()
      if (target === undefined)
        spaces.delete(TARGET_SPACE)
      else
        spaces.set(TARGET_SPACE, target)
      expect((await rejection(service.transfer(ACTOR, SOURCE, { documentIds: DOCUMENTS, target: { type: 'team', spaceId: TARGET_SPACE } }, ORIGIN))).code).toBe(code)
      expect(calls.filter(call => call.startsWith('facts') || call.startsWith('space'))).toEqual(spaceCalls)
      expect(transfers.transfer).not.toHaveBeenCalled()
    }
  })
})

describe('AdminTransferService.titles', () => {
  it('只对停用的账户：有效的 ACCOUNT_NOT_DISABLED，不存在 NOT_FOUND，都不列标题', async () => {
    const { service, accounts, transfers } = setup()
    await service.titles(SOURCE, {})
    // 账户的状态与标题在同一个只读快照里读（M2 Codex 评审 CX1）
    expect(transfers.titles).toHaveBeenCalledWith(SOURCE_SPACE, undefined, { snapshot: true })
    accounts.set(SOURCE, account(SOURCE, 'active'))
    expect((await rejection(service.titles(SOURCE, {}))).code).toBe('ACCOUNT_NOT_DISABLED')
    expect((await rejection(service.titles(TARGET_SPACE, {}))).code).toBe('NOT_FOUND')
    expect(transfers.titles).toHaveBeenCalledTimes(1)
  })
})
