// 分享的编排（M2-P5 设计 §3.4(3)）：一个业务事务里"不加锁判断 → 被授权人的账户行（只有 PUT）→ 空间行 → documents 锁文档行并写 →
// 审计 → 补人名"，提交之后不再访问数据库；先判断文档、再看被授权人（给自己 400、不可用 409）；同样的角色不记审计；DELETE 不锁账户行。
// 文档这一段（锁下复核、写、收回写入权）在 documents 的 DocumentGrantsService（document-grants.service.test.ts）；锁的确定交错在集成测试。
import type { DocumentGrantRecord, GrantChange } from '../documents/index.ts'
import type { User } from '../users/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentSharingService } from './document-sharing.service.ts'

const DOCUMENT = '0199a2c4-0000-7000-8000-0000000000d1'
const SPACE = '0199a2c4-0000-7000-8000-0000000000c1'
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const CAT = '0199a2c4-0000-7000-8000-00000000000c'
const CREATED = new Date('2026-10-02T08:00:00.000Z')
const UPDATED = new Date('2026-10-02T09:00:00.000Z')
const ORIGIN = { source: 'http', requestId: 'req-1' } as const
const ACTOR = { userId: AMY, systemAdmin: false }

const NAMES: Readonly<Record<string, readonly [string, string]>> = { [AMY]: ['amy', '艾米'], [BEN]: ['ben', '本'], [CAT]: ['cat', '凯特'] }

function user(id: string, overrides: Partial<User> = {}): User {
  const [username, displayName] = NAMES[id] ?? ['someone', '某人']
  return { id, username, displayName, systemRole: 'member', status: 'active', ...overrides }
}

function grant(userId: string, role: DocumentGrantRecord['role'], grantedBy = AMY): DocumentGrantRecord {
  return { documentId: DOCUMENT, userId, role, grantedBy, createdAt: CREATED, updatedAt: UPDATED }
}

/** 每一步记进 calls，核对顺序与"都在事务里"：begin 与 commit 之间的才在业务事务里 */
function setup(change: GrantChange = { kind: 'created', grant: grant(BEN, 'editor') }) {
  const calls: string[] = []
  const transaction = { transaction: true }
  const grants = {
    requireSharing: vi.fn(async () => {
      calls.push('check')
      return { id: DOCUMENT, spaceId: SPACE }
    }),
    set: vi.fn(async (): Promise<GrantChange> => {
      calls.push('set')
      return change
    }),
    remove: vi.fn(async (): Promise<DocumentGrantRecord | undefined> => {
      calls.push('remove')
      return grant(BEN, 'viewer')
    }),
    list: vi.fn(async () => [grant(CAT, 'viewer'), grant(BEN, 'editor', CAT), grant(AMY, 'viewer', CAT)]),
  }
  const spaces = {
    holdSpace: vi.fn(async () => {
      calls.push('space')
    }),
  }
  const users = {
    holdActiveAccount: vi.fn(async (userId: string): Promise<User | undefined> => {
      calls.push('account')
      return user(userId)
    }),
    findByIds: vi.fn(async (ids: readonly string[]) => {
      calls.push('names')
      return new Map(ids.map(id => [id, user(id, id === CAT ? { status: 'disabled' } : {})]))
    }),
  }
  const audit = {
    record: vi.fn(async () => {
      calls.push('audit')
    }),
  }
  const transactions = {
    run: vi.fn(async <T>(work: (transaction: never) => Promise<T>) => {
      calls.push('begin')
      const result = await work(transaction as never)
      calls.push('commit')
      return result
    }),
  }
  const service = new DocumentSharingService(grants as never, spaces as never, users as never, audit as never, transactions as never)
  return { service, calls, grants, spaces, users, audit, transaction }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error('期望抛出 AppError', { cause: error })
  return error
}

describe('DocumentSharingService.set', () => {
  it('一个事务里：判断 → 持住被授权人的账户行 → 持住第一步看到的空间的行 → documents 锁文档行并写 → 审计 → 补人名，之后才提交', async () => {
    const { service, calls, grants, spaces, users, audit, transaction } = setup()
    const response = await service.set(ACTOR, DOCUMENT, BEN, 'editor', ORIGIN)
    expect(calls).toEqual(['begin', 'check', 'account', 'space', 'set', 'audit', 'names', 'commit'])
    expect(grants.requireSharing).toHaveBeenCalledWith(ACTOR, DOCUMENT, transaction)
    expect(users.holdActiveAccount).toHaveBeenCalledWith(BEN, transaction)
    expect(spaces.holdSpace).toHaveBeenCalledWith(SPACE, transaction)
    expect(grants.set).toHaveBeenCalledWith(ACTOR, { id: DOCUMENT, spaceId: SPACE }, BEN, 'editor', transaction)
    expect(audit.record).toHaveBeenCalledWith({
      action: 'documents.shared',
      actor: { type: 'user', id: AMY },
      target: { type: 'document', id: DOCUMENT },
      origin: ORIGIN,
      details: { userId: BEN, role: 'editor' },
    }, { transaction })
    // 补人名用业务事务的连接：提交之后不再访问数据库
    expect(users.findByIds).toHaveBeenCalledWith([BEN, AMY], transaction)
    expect(response).toEqual({
      user: { id: BEN, username: 'ben', displayName: '本' },
      status: 'active',
      role: 'editor',
      grantedBy: { id: AMY, username: 'amy', displayName: '艾米' },
      grantedAt: UPDATED.toISOString(),
    })
  })

  it('调整：记 documents.share_changed（原来的与新的角色）', async () => {
    const { service, audit } = setup({ kind: 'changed', grant: grant(BEN, 'viewer'), previousRole: 'editor' })
    await service.set(ACTOR, DOCUMENT, BEN, 'viewer', ORIGIN)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'documents.share_changed', details: { userId: BEN, from: 'editor', to: 'viewer' } }), expect.anything())
  })

  it('同样的角色：不记审计，照样补人名、给出现有的那一条（设置人是原来的人）', async () => {
    const { service, calls, audit } = setup({ kind: 'unchanged', grant: grant(BEN, 'editor', CAT) })
    const response = await service.set(ACTOR, DOCUMENT, BEN, 'editor', ORIGIN)
    expect(audit.record).not.toHaveBeenCalled()
    expect(calls).toEqual(['begin', 'check', 'account', 'space', 'set', 'names', 'commit'])
    expect(response.grantedBy).toEqual({ id: CAT, username: 'cat', displayName: '凯特' })
  })

  it('先判断文档：看不到或不能分享时，不论被授权人是谁都不往下走（不锁账户行与空间行）', async () => {
    for (const code of ['NOT_FOUND', 'PERMISSION_DENIED'] as const) {
      const { service, calls, grants } = setup()
      grants.requireSharing.mockImplementationOnce(async () => {
        calls.push('check')
        throw new AppError(code)
      })
      expect((await rejection(service.set(ACTOR, DOCUMENT, AMY, 'editor', ORIGIN))).code, code).toBe(code)
      expect(calls, code).toEqual(['begin', 'check'])
    }
  })

  it('给自己：400 REQUEST_INVALID，不锁账户行与空间行、什么也不写', async () => {
    const { service, calls, grants } = setup()
    expect(await rejection(service.set(ACTOR, DOCUMENT, AMY, 'viewer', ORIGIN))).toMatchObject({ code: 'REQUEST_INVALID', message: '不能把文档分享给自己' })
    expect(calls).toEqual(['begin', 'check'])
    expect(grants.set).not.toHaveBeenCalled()
  })

  it('被授权人不存在或已停用：409 ACCOUNT_UNAVAILABLE，不锁空间行、什么也不写（新建与调整都是）', async () => {
    const { service, calls, users, grants } = setup()
    users.holdActiveAccount.mockImplementationOnce(async () => {
      calls.push('account')
      return undefined
    })
    expect((await rejection(service.set(ACTOR, DOCUMENT, BEN, 'viewer', ORIGIN))).code).toBe('ACCOUNT_UNAVAILABLE')
    expect(calls).toEqual(['begin', 'check', 'account'])
    expect(grants.set).not.toHaveBeenCalled()
  })

  it('被授权人用数据库返回的 id（ADR-014）：持住的账户给出的 id 传给 documents', async () => {
    const { service, users, grants } = setup()
    users.holdActiveAccount.mockResolvedValueOnce(user(CAT))
    await service.set(ACTOR, DOCUMENT, BEN, 'viewer', ORIGIN)
    expect(grants.set).toHaveBeenCalledWith(ACTOR, expect.anything(), CAT, 'viewer', expect.anything())
  })
})

describe('DocumentSharingService.remove', () => {
  it('一个事务里：判断 → 持住空间行 → documents 锁文档行并删 → 审计；不锁被授权人的账户行（停用的人的授权也要能取消）', async () => {
    const { service, calls, grants, spaces, users, audit, transaction } = setup()
    await service.remove(ACTOR, DOCUMENT, BEN, ORIGIN)
    expect(calls).toEqual(['begin', 'check', 'space', 'remove', 'audit', 'commit'])
    expect(users.holdActiveAccount).not.toHaveBeenCalled()
    expect(spaces.holdSpace).toHaveBeenCalledWith(SPACE, transaction)
    expect(grants.remove).toHaveBeenCalledWith(ACTOR, { id: DOCUMENT, spaceId: SPACE }, BEN, transaction)
    // 明细是删掉的那一条（数据库返回的）
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'documents.share_revoked', target: { type: 'document', id: DOCUMENT }, details: { userId: BEN, role: 'viewer' } }), { transaction })
  })

  it('没有这条授权：不记审计（按状态幂等）', async () => {
    const { service, grants, audit } = setup()
    grants.remove.mockResolvedValueOnce(undefined)
    await service.remove(ACTOR, DOCUMENT, BEN, ORIGIN)
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('看不到或不能分享：不持住空间行', async () => {
    const { service, calls, grants } = setup()
    grants.requireSharing.mockImplementationOnce(async () => {
      calls.push('check')
      throw new AppError('NOT_FOUND')
    })
    expect((await rejection(service.remove(ACTOR, DOCUMENT, BEN, ORIGIN))).code).toBe('NOT_FOUND')
    expect(calls).toEqual(['begin', 'check'])
  })
})

describe('DocumentSharingService.list', () => {
  it('补上被授权人与设置人的名字、被授权人的账户状态（停用的照样列出）；先按角色、再按显示名排序', async () => {
    const { service, users } = setup()
    const response = await service.list(ACTOR, DOCUMENT)
    expect(response.items.map(item => [item.user.username, item.role, item.status, item.grantedBy.username])).toEqual([
      ['ben', 'editor', 'active', 'cat'],
      ['amy', 'viewer', 'active', 'cat'],
      ['cat', 'viewer', 'disabled', 'amy'],
    ])
    // 一次批量取齐名字
    expect(users.findByIds).toHaveBeenCalledTimes(1)
  })

  it('名字取不到（数据不一致）：按意外错误处理', async () => {
    const { service, users } = setup()
    users.findByIds.mockResolvedValueOnce(new Map())
    await expect(service.list(ACTOR, DOCUMENT)).rejects.toThrow(`账户不存在：${CAT}`)
  })
})
