import type { Transaction } from '../database/index.ts'
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

  async hash(password: string): Promise<string> {
    return `hash:${password}`
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    this.verified.push(passwordHash)
    return passwordHash === `hash:${password}`
  }

  needsRehash(): boolean {
    return false
  }

  async observe(): Promise<void> {}
}

const TX = {} as Transaction
const CREATED = new Date('2026-09-28T00:00:00Z')

function account(overrides: Partial<AccountRecord>): AccountRecord {
  return { id: '0199a2c4-0000-7000-8000-000000000001', username: 'alice', displayName: 'Alice', systemRole: 'member', status: 'active', createdAt: CREATED, ...overrides }
}

/** 假仓储：一个账户，另有若干个"别的有效系统管理员"。按调用的顺序记下加锁与更新 */
function setup(target: AccountRecord | undefined, otherActiveAdmins = 1) {
  const calls: string[] = []
  const repository = {
    lockSystemAdmins: vi.fn(async () => {
      calls.push('lock-admins')
    }),
    findRecordForUpdate: vi.fn(async () => {
      calls.push('lock-row')
      return target
    }),
    countActiveAdminsExcept: vi.fn(async () => otherActiveAdmins),
    setStatus: vi.fn(async (_id: string, status: AccountRecord['status']) => account({ ...target, status })),
    setSystemRole: vi.fn(async (_id: string, systemRole: AccountRecord['systemRole']) => account({ ...target, systemRole })),
    findCredentialsById: vi.fn(async () => (target === undefined ? undefined : { user: target, passwordHash: 'hash:secret' })),
    listRecords: vi.fn(async () => [] as AccountRecord[]),
    passwordHashParameters: vi.fn(async () => []),
  }
  const hasher = new FakeHasher()
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  return { calls, repository, hasher, service: new UsersService(repository as unknown as UsersRepository, hasher, logger) }
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  if (!(error instanceof AppError))
    throw new Error(`期望 AppError，得到 ${String(error)}`)
  return error.code
}

describe('UsersService：停用与启用（M2-P1 设计 §3.5）', () => {
  it('停用：先取管理员的锁，再锁账户的行，然后改状态', async () => {
    const { service, calls, repository } = setup(account({}))
    expect(await service.disable('id', TX)).toMatchObject({ changed: true, account: { status: 'disabled' } })
    expect(calls).toEqual(['lock-admins', 'lock-row'])
    expect(repository.setStatus).toHaveBeenCalledWith(expect.any(String), 'disabled', TX)
  })

  it('已经停用的：原样返回，changed 为假，不更新', async () => {
    const { service, repository } = setup(account({ status: 'disabled' }))
    expect(await service.disable('id', TX)).toMatchObject({ changed: false })
    expect(repository.setStatus).not.toHaveBeenCalled()
  })

  it('停用有效的系统管理员：还有别的有效系统管理员时可以；没有了就是 LAST_ADMIN', async () => {
    expect(await setup(account({ systemRole: 'admin' }), 1).service.disable('id', TX)).toMatchObject({ changed: true })
    expect(await errorCodeOf(setup(account({ systemRole: 'admin' }), 0).service.disable('id', TX))).toBe('LAST_ADMIN')
  })

  it('停用成员不数管理员', async () => {
    const { service, repository } = setup(account({}), 0)
    await service.disable('id', TX)
    expect(repository.countActiveAdminsExcept).not.toHaveBeenCalled()
  })

  it('账户不存在：NOT_FOUND', async () => {
    expect(await errorCodeOf(setup(undefined).service.disable('id', TX))).toBe('NOT_FOUND')
    expect(await errorCodeOf(setup(undefined).service.enable('id', TX))).toBe('NOT_FOUND')
  })

  it('启用：不取管理员的锁；已经有效的原样返回', async () => {
    const disabled = setup(account({ status: 'disabled' }))
    expect(await disabled.service.enable('id', TX)).toMatchObject({ changed: true, account: { status: 'active' } })
    expect(disabled.calls).toEqual(['lock-row'])
    expect(await setup(account({})).service.enable('id', TX)).toMatchObject({ changed: false })
  })
})

describe('UsersService：系统管理员的授予与取消（M2-P1 设计 §3.5）', () => {
  it('授予有效的成员：先取管理员的锁，再锁行', async () => {
    const { service, calls } = setup(account({}))
    expect(await service.changeSystemRole('id', 'admin', TX)).toMatchObject({ changed: true, account: { systemRole: 'admin' } })
    expect(calls).toEqual(['lock-admins', 'lock-row'])
  })

  it('停用的账户不能被授予：ACCOUNT_DISABLED', async () => {
    expect(await errorCodeOf(setup(account({ status: 'disabled' })).service.changeSystemRole('id', 'admin', TX))).toBe('ACCOUNT_DISABLED')
  })

  it('取消有效的系统管理员：没有别的有效系统管理员时 LAST_ADMIN', async () => {
    expect(await errorCodeOf(setup(account({ systemRole: 'admin' }), 0).service.changeSystemRole('id', 'member', TX))).toBe('LAST_ADMIN')
    expect(await setup(account({ systemRole: 'admin' }), 2).service.changeSystemRole('id', 'member', TX)).toMatchObject({ changed: true })
  })

  it('取消停用的系统管理员不数管理员：它本来就不算有效的管理员', async () => {
    const { service, repository } = setup(account({ systemRole: 'admin', status: 'disabled' }), 0)
    expect(await service.changeSystemRole('id', 'member', TX)).toMatchObject({ changed: true })
    expect(repository.countActiveAdminsExcept).not.toHaveBeenCalled()
  })

  it('角色没变：原样返回，changed 为假', async () => {
    const { service, repository } = setup(account({ systemRole: 'admin' }), 0)
    expect(await service.changeSystemRole('id', 'admin', TX)).toMatchObject({ changed: false })
    expect(repository.setSystemRole).not.toHaveBeenCalled()
  })
})

describe('UsersService.verifyPasswordOf（修改密码时的旧密码）', () => {
  it('密码对时通过，错时不通过', async () => {
    const { service } = setup(account({}))
    expect(await service.verifyPasswordOf('id', 'secret')).toBe(true)
    expect(await service.verifyPasswordOf('id', 'wrong')).toBe(false)
  })

  it('账户不存在或已停用：不通过，照样算一次哈希（耗时与密码错误相近）', async () => {
    for (const target of [undefined, account({ status: 'disabled' })]) {
      const { service, hasher } = setup(target)
      expect(await service.verifyPasswordOf('id', 'secret')).toBe(false)
      expect(hasher.verified).toHaveLength(1)
      expect(hasher.verified[0]).not.toBe('hash:secret')
    }
  })
})

describe('UsersService.listAccounts', () => {
  it('多取一条判断下一页；游标是本页最后一条的登录名', async () => {
    const { service, repository } = setup(undefined)
    const rows = Array.from({ length: 51 }, (_, index) => account({ id: `0199a2c4-0000-7000-8000-${String(index).padStart(12, '0')}`, username: `user-${String(index).padStart(2, '0')}` }))
    repository.listRecords.mockResolvedValueOnce(rows)
    const page = await service.listAccounts({ query: '张' })
    expect(repository.listRecords).toHaveBeenCalledWith({ query: '张', status: undefined, afterUsername: undefined, limit: 51 })
    expect(page.items).toHaveLength(50)
    expect(decodeAccountCursor(page.nextCursor ?? '')).toBe('user-49')

    repository.listRecords.mockResolvedValueOnce(rows.slice(0, 3))
    const last = await service.listAccounts({ cursor: encodeAccountCursor('user-49'), status: 'disabled' })
    expect(repository.listRecords).toHaveBeenLastCalledWith({ query: undefined, status: 'disabled', afterUsername: 'user-49', limit: 51 })
    expect(last.nextCursor).toBeNull()
  })

  it('不是我们发的游标：REQUEST_INVALID', async () => {
    expect(await errorCodeOf(setup(undefined).service.listAccounts({ cursor: 'broken' }))).toBe('REQUEST_INVALID')
    expect(await errorCodeOf(setup(undefined).service.listAccounts({ cursor: encodeAccountCursor('Not A Username') }))).toBe('REQUEST_INVALID')
  })
})
