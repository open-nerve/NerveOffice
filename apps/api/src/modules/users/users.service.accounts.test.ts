import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { AccountRecord } from './user.ts'
import type { UsersRepository } from './users.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { decodeAccountCursor, encodeAccountCursor } from './account-cursor.ts'
import { PasswordHasher } from './password-hasher.ts'
import { UsersService } from './users.service.ts'

class FakeHasher extends PasswordHasher {
  readonly verified: string[] = []
  /** reject 的次数（没有可以比对的哈希） */
  rejected = 0

  async hash(password: string): Promise<string> {
    return `hash:${password}`
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    this.verified.push(passwordHash)
    return passwordHash === `hash:${password}`
  }

  async reject(): Promise<false> {
    this.rejected += 1
    return false
  }

  needsRehash(): boolean {
    return false
  }

  observe(): void {}
}

const TX = {} as Transaction
/** 假的事务运行器：只读快照直接执行（同事目录在快照里读） */
const TRANSACTIONS = { readSnapshot: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => work(TX)) } as unknown as TransactionRunner
const CREATED = new Date('2026-09-28T00:00:00Z')
const ACTOR_ID = '0199a2c4-0000-7000-8000-0000000000ad'

function account(overrides: Partial<AccountRecord>): AccountRecord {
  return { id: '0199a2c4-0000-7000-8000-000000000001', username: 'alice', displayName: 'Alice', systemRole: 'member', status: 'active', createdAt: CREATED, ...overrides }
}

/** 假仓储：一个账户，另有若干个"别的有效系统管理员"；操作者默认是有效的系统管理员。按调用的顺序记下加锁与更新 */
function setup(target: AccountRecord | undefined, otherActiveAdmins = 1, actor: AccountRecord | null = account({ id: ACTOR_ID, username: 'boss', systemRole: 'admin' })) {
  const calls: string[] = []
  let locked = target === undefined ? undefined : { status: target.status, passwordVersion: 1 }
  const repository = {
    lockSystemAdmins: vi.fn(async () => {
      calls.push('lock-admins')
    }),
    lockSystemAdminsShared: vi.fn(async () => {
      calls.push('lock-admins-shared')
    }),
    findById: vi.fn(async (id: string) => {
      calls.push(`read:${id}`)
      return id === ACTOR_ID ? actor ?? undefined : target
    }),
    lockRecord: vi.fn(async () => {
      calls.push('lock-row')
      return target
    }),
    lockCredentials: vi.fn(async (_id: string, strength: string) => {
      calls.push(`lock-credentials:${strength}`)
      return locked
    }),
    changeCredentials: vi.fn(async (_id: string, _passwordHash: string) => {
      calls.push('update-hash')
      if (locked !== undefined)
        locked = { ...locked, passwordVersion: locked.passwordVersion + 1 }
    }),
    countActiveAdminsExcept: vi.fn(async () => otherActiveAdmins),
    setStatus: vi.fn(async (_id: string, status: AccountRecord['status']) => account({ ...target, status })),
    setSystemRole: vi.fn(async (_id: string, systemRole: AccountRecord['systemRole']) => account({ ...target, systemRole })),
    findCredentialsById: vi.fn(async () => (target === undefined ? undefined : { user: target, passwordHash: 'hash:secret', passwordVersion: 1 })),
    listRecords: vi.fn(async () => [] as AccountRecord[]),
    passwordHashParameters: vi.fn(async () => []),
  }
  const hasher = new FakeHasher()
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  return {
    calls,
    repository,
    hasher,
    /** 模拟别处改了密码（修改、签发或完成重置）：凭据的版本加一 */
    changeCredentialsElsewhere: () => {
      if (locked !== undefined)
        locked = { ...locked, passwordVersion: locked.passwordVersion + 1 }
    },
    service: new UsersService(repository as unknown as UsersRepository, hasher, TRANSACTIONS, logger),
  }
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  if (!(error instanceof AppError))
    throw new Error(`期望 AppError，得到 ${String(error)}`)
  return error.code
}

describe('UsersService：停用与启用（M2-P1 设计 §3.5）', () => {
  it('停用：先取管理员的锁，在锁里复核操作者，再锁账户的行，然后改状态', async () => {
    const { service, calls, repository } = setup(account({}))
    expect(await service.disable('id', ACTOR_ID, TX)).toMatchObject({ changed: true, account: { status: 'disabled' } })
    expect(calls).toEqual(['lock-admins', `read:${ACTOR_ID}`, 'lock-row'])
    expect(repository.findById).toHaveBeenCalledWith(ACTOR_ID, TX)
    expect(repository.setStatus).toHaveBeenCalledWith(expect.any(String), 'disabled', TX)
  })

  it('操作者在取到锁之前已被取消或停用（审查 A12）：PERMISSION_DENIED，不锁账户的行', async () => {
    for (const actor of [account({ id: ACTOR_ID, systemRole: 'member' }), account({ id: ACTOR_ID, systemRole: 'admin', status: 'disabled' }), null]) {
      const { service, calls } = setup(account({}), 1, actor)
      expect(await errorCodeOf(service.disable('id', ACTOR_ID, TX))).toBe('PERMISSION_DENIED')
      expect(await errorCodeOf(service.changeSystemRole('id', 'admin', ACTOR_ID, TX))).toBe('PERMISSION_DENIED')
      expect(calls).not.toContain('lock-row')
    }
  })

  it('已经停用的：原样返回，changed 为假，不更新', async () => {
    const { service, repository } = setup(account({ status: 'disabled' }))
    expect(await service.disable('id', ACTOR_ID, TX)).toMatchObject({ changed: false })
    expect(repository.setStatus).not.toHaveBeenCalled()
  })

  it('停用有效的系统管理员：还有别的有效系统管理员时可以；没有了就是 LAST_ADMIN', async () => {
    expect(await setup(account({ systemRole: 'admin' }), 1).service.disable('id', ACTOR_ID, TX)).toMatchObject({ changed: true })
    expect(await errorCodeOf(setup(account({ systemRole: 'admin' }), 0).service.disable('id', ACTOR_ID, TX))).toBe('LAST_ADMIN')
  })

  it('停用成员不数管理员', async () => {
    const { service, repository } = setup(account({}), 0)
    await service.disable('id', ACTOR_ID, TX)
    expect(repository.countActiveAdminsExcept).not.toHaveBeenCalled()
  })

  it('账户不存在：NOT_FOUND', async () => {
    expect(await errorCodeOf(setup(undefined).service.disable('id', ACTOR_ID, TX))).toBe('NOT_FOUND')
    expect(await errorCodeOf(setup(undefined).service.enable('id', ACTOR_ID, TX))).toBe('NOT_FOUND')
  })

  it('启用：取管理员的共享锁、复核操作者，再锁行（复验 N3）；已经有效的原样返回', async () => {
    const disabled = setup(account({ status: 'disabled' }))
    expect(await disabled.service.enable('id', ACTOR_ID, TX)).toMatchObject({ changed: true, account: { status: 'active' } })
    expect(disabled.calls).toEqual(['lock-admins-shared', `read:${ACTOR_ID}`, 'lock-row'])
    expect(await setup(account({})).service.enable('id', ACTOR_ID, TX)).toMatchObject({ changed: false })
    expect(await errorCodeOf(setup(account({ status: 'disabled' }), 1, account({ id: ACTOR_ID, systemRole: 'member' })).service.enable('id', ACTOR_ID, TX))).toBe('PERMISSION_DENIED')
  })

  it('lockActingAdmin：取共享锁再复核操作者（其他管理操作的事务第一步，复验 N3）', async () => {
    const ok = setup(account({}))
    await ok.service.lockActingAdmin(ACTOR_ID, TX)
    expect(ok.calls).toEqual(['lock-admins-shared', `read:${ACTOR_ID}`])
    for (const actor of [account({ id: ACTOR_ID, systemRole: 'member' }), account({ id: ACTOR_ID, systemRole: 'admin', status: 'disabled' }), null])
      expect(await errorCodeOf(setup(account({}), 1, actor).service.lockActingAdmin(ACTOR_ID, TX))).toBe('PERMISSION_DENIED')
  })
})

describe('UsersService：系统管理员的授予与取消（M2-P1 设计 §3.5）', () => {
  it('授予有效的成员：先取管理员的锁，复核操作者，再锁行', async () => {
    const { service, calls } = setup(account({}))
    expect(await service.changeSystemRole('id', 'admin', ACTOR_ID, TX)).toMatchObject({ changed: true, account: { systemRole: 'admin' } })
    expect(calls).toEqual(['lock-admins', `read:${ACTOR_ID}`, 'lock-row'])
  })

  it('停用的账户不能被授予：ACCOUNT_DISABLED', async () => {
    expect(await errorCodeOf(setup(account({ status: 'disabled' })).service.changeSystemRole('id', 'admin', ACTOR_ID, TX))).toBe('ACCOUNT_DISABLED')
  })

  it('取消有效的系统管理员：没有别的有效系统管理员时 LAST_ADMIN', async () => {
    expect(await errorCodeOf(setup(account({ systemRole: 'admin' }), 0).service.changeSystemRole('id', 'member', ACTOR_ID, TX))).toBe('LAST_ADMIN')
    expect(await setup(account({ systemRole: 'admin' }), 2).service.changeSystemRole('id', 'member', ACTOR_ID, TX)).toMatchObject({ changed: true })
  })

  it('取消停用的系统管理员不数管理员：它本来就不算有效的管理员', async () => {
    const { service, repository } = setup(account({ systemRole: 'admin', status: 'disabled' }), 0)
    expect(await service.changeSystemRole('id', 'member', ACTOR_ID, TX)).toMatchObject({ changed: true })
    expect(repository.countActiveAdminsExcept).not.toHaveBeenCalled()
  })

  it('角色没变：原样返回，changed 为假', async () => {
    const { service, repository } = setup(account({ systemRole: 'admin' }), 0)
    expect(await service.changeSystemRole('id', 'admin', ACTOR_ID, TX)).toMatchObject({ changed: false })
    expect(repository.setSystemRole).not.toHaveBeenCalled()
  })
})

describe('UsersService.verifyPasswordOf 与 replacePassword（修改密码，审查 A1、A2）', () => {
  it('旧密码对时返回验证过的凭据（带验证时凭据的版本，不带哈希），错时不通过', async () => {
    const { service } = setup(account({}))
    expect(await service.verifyPasswordOf('id', 'secret')).toEqual({ user: account({}), passwordVersion: 1 })
    expect(await service.verifyPasswordOf('id', 'wrong')).toBeUndefined()
  })

  it('账户不存在或已停用：不通过，按没有账户的做法计算（reject，与密码错误的计算相同），不比对账户的哈希', async () => {
    for (const target of [undefined, account({ status: 'disabled' })]) {
      const { service, hasher } = setup(target)
      expect(await service.verifyPasswordOf('id', 'secret')).toBeUndefined()
      expect(hasher.rejected).toBe(1)
      expect(hasher.verified).toEqual([])
    }
  })

  it('旧密码错误、账户不存在或已停用：比对之后不再访问数据库，同 verifyCredentials（M2-P6 第 3 片复验）', async () => {
    for (const target of [account({}), undefined, account({ status: 'disabled' })]) {
      const { service, repository, hasher } = setup(target)
      const accesses = (): number => Object.values(repository).reduce((total, method) => total + method.mock.calls.length, 0)
      const compare = hasher.verify.bind(hasher)
      let accessesWhenCompared: number | undefined
      vi.spyOn(hasher, 'verify').mockImplementation(async (passwordHash, password) => {
        accessesWhenCompared = accesses()
        return compare(passwordHash, password)
      })
      vi.spyOn(hasher, 'reject').mockImplementation(async () => {
        accessesWhenCompared = accesses()
        return false
      })
      expect(await service.verifyPasswordOf('id', 'wrong')).toBeUndefined()
      expect(accessesWhenCompared).toBeGreaterThan(0)
      expect(accesses()).toBe(accessesWhenCompared)
    }
  })

  it('replacePassword：锁住账户行（no key update），凭据的版本还是验证时的那个才更新', async () => {
    const { service, calls, repository } = setup(account({}))
    const credentials = await service.verifyPasswordOf('id', 'secret')
    if (credentials === undefined)
      throw new Error('旧密码应当验证通过')
    expect(await service.replacePassword(credentials, 'hash:next', TX)).toBe(true)
    expect(calls).toEqual(['lock-credentials:no key update', 'update-hash'])
    expect(repository.changeCredentials).toHaveBeenCalledWith(credentials.user.id, 'hash:next', TX)
  })

  it('replacePassword：验证之后别处改过密码（修改、签发或完成重置），不更新', async () => {
    const { service, repository, changeCredentialsElsewhere } = setup(account({}))
    const credentials = await service.verifyPasswordOf('id', 'secret')
    if (credentials === undefined)
      throw new Error('旧密码应当验证通过')
    changeCredentialsElsewhere()
    expect(await service.replacePassword(credentials, 'hash:next', TX)).toBe(false)
    expect(repository.changeCredentials).not.toHaveBeenCalled()
  })

  it('replacePassword：验证之后账户被停用，不更新', async () => {
    const target = account({})
    const { service, repository } = setup(target)
    const credentials = await service.verifyPasswordOf('id', 'secret')
    if (credentials === undefined)
      throw new Error('旧密码应当验证通过')
    repository.lockCredentials.mockResolvedValueOnce({ status: 'disabled', passwordVersion: 1 })
    expect(await service.replacePassword(credentials, 'hash:next', TX)).toBe(false)
    expect(repository.changeCredentials).not.toHaveBeenCalled()
  })
})

describe('UsersService.holdCredentials（登录的事务里复核，审查 A1）', () => {
  it('FOR SHARE 锁住账户行；有效且凭据的版本没变时通过', async () => {
    const { service, calls } = setup(account({}))
    const credentials = { user: account({}), passwordVersion: 1 }
    expect(await service.holdCredentials(credentials, TX)).toBe(true)
    expect(calls).toEqual(['lock-credentials:share'])
  })

  it('凭据的版本变了、账户停用了、账户不在了：不通过', async () => {
    const credentials = { user: account({}), passwordVersion: 1 }
    const changed = setup(account({}))
    changed.changeCredentialsElsewhere()
    expect(await changed.service.holdCredentials(credentials, TX)).toBe(false)
    expect(await setup(account({ status: 'disabled' })).service.holdCredentials(credentials, TX)).toBe(false)
    expect(await setup(undefined).service.holdCredentials(credentials, TX)).toBe(false)
  })
})

describe('UsersService：签发重置用到的账户操作（审查 A2、A7）', () => {
  it('lockAccount 锁住账户的行再读', async () => {
    const target = account({})
    const { service, repository } = setup(target)
    expect(await service.lockAccount(target.id, TX)).toBe(target)
    expect(repository.lockRecord).toHaveBeenCalledWith(target.id, TX)
  })

  it('unusablePasswordHash：每次对新的随机秘密算哈希，谁也不知道对应的密码', async () => {
    const { service } = setup(account({}))
    const [first, second] = [await service.unusablePasswordHash(), await service.unusablePasswordHash()]
    expect(first).toMatch(/^hash:[\w-]{43}$/)
    expect(second).not.toBe(first)
  })
})

describe('UsersService.listAccounts', () => {
  it('多取一条判断下一页；游标是本页最后一条的登录名', async () => {
    const { service, repository } = setup(undefined)
    const rows = Array.from({ length: 51 }, (_, index) => account({ id: `0199a2c4-0000-7000-8000-${String(index).padStart(12, '0')}`, username: `user-${String(index).padStart(2, '0')}` }))
    repository.listRecords.mockResolvedValueOnce(rows)
    const page = await service.listAccounts({ query: '张' }, TX)
    expect(repository.listRecords).toHaveBeenCalledWith({ query: '张', status: undefined, afterUsername: undefined, limit: 51 }, TX)
    expect(page.items).toHaveLength(50)
    expect(decodeAccountCursor(page.nextCursor ?? '')).toBe('user-49')

    repository.listRecords.mockResolvedValueOnce(rows.slice(0, 3))
    const last = await service.listAccounts({ cursor: encodeAccountCursor('user-49'), status: 'disabled' }, TX)
    expect(repository.listRecords).toHaveBeenLastCalledWith({ query: undefined, status: 'disabled', afterUsername: 'user-49', limit: 51 }, TX)
    expect(last.nextCursor).toBeNull()
  })

  it('不是我们发的游标：REQUEST_INVALID', async () => {
    expect(await errorCodeOf(setup(undefined).service.listAccounts({ cursor: 'broken' }, TX))).toBe('REQUEST_INVALID')
    expect(await errorCodeOf(setup(undefined).service.listAccounts({ cursor: encodeAccountCursor('Not A Username') }, TX))).toBe('REQUEST_INVALID')
  })
})
