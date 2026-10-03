import type { Request, Response } from 'express'
import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { User, UsersService } from '../users/index.ts'
import type { RequestIdentity } from './request-identity.ts'
import type { SessionService } from './session.service.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { RequestIdentities, SnapshotIdentityCheck } from './request-identity.ts'

const ALICE: User = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member', status: 'active' }
/** 守卫认证过的那条会话 */
const SESSION_ID = '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f'
const SNAPSHOT = { snapshot: true } as unknown as Transaction

/** 守卫记下的身份：Alice 的这条会话，systemAdmin 是守卫读到的系统角色是不是管理员 */
function aliceAs(systemAdmin: boolean): RequestIdentity {
  return { userId: ALICE.id, sessionId: SESSION_ID, systemAdmin }
}

/** 在一个请求的记录里执行 work：与 HTTP 管线里同一个中间件 */
async function inRequest<T>(identities: RequestIdentities, work: () => Promise<T>): Promise<T> {
  let pending: Promise<T> | undefined
  identities.middleware()({} as Request, {} as Response, () => {
    pending = work()
  })
  if (pending === undefined)
    throw new Error('中间件没有往下走')
  return pending
}

describe('RequestIdentities：每个请求一份会话守卫判断过的身份（M2 Codex 评审 CX1）', () => {
  it('守卫记下之后，同一个请求里（之后的异步步骤）取得到；别的请求取不到', async () => {
    const identities = new RequestIdentities()
    const identity = aliceAs(false)
    const seen = await inRequest(identities, async () => {
      expect(identities.current()).toBeUndefined()
      identities.record(identity)
      await Promise.resolve()
      return identities.current()
    })
    expect(seen).toEqual(identity)
    expect(await inRequest(identities, async () => identities.current())).toBeUndefined()
  })

  it('不在请求里（命令行、定时任务）：取不到；记录就是接线错了（HTTP 管线没装中间件），直接报错', () => {
    const identities = new RequestIdentities()
    expect(identities.current()).toBeUndefined()
    expect(() => identities.record(aliceAs(false))).toThrow('请求级的身份记录不在')
  })
})

/** user：快照里读到的账户；sessionActive：快照里那条会话是不是仍然有效（没有撤销、没有过期） */
function checkWith(user: User | undefined, sessionActive = true) {
  const identities = new RequestIdentities()
  const sessions = { isActive: vi.fn(async (_sessionId: string, _transaction: Transaction) => sessionActive) }
  const users = { findById: vi.fn(async (_id: string, _transaction?: Transaction) => user) }
  const transactions = { registerSnapshotOpening: vi.fn() }
  const check = new SnapshotIdentityCheck(identities, sessions as unknown as SessionService, users as unknown as UsersService, transactions as unknown as TransactionRunner)
  return { identities, sessions, users, transactions, check }
}

/** 在一个请求里按守卫记下的身份执行开场核对，返回拒绝的错误码（通过时为 undefined） */
async function recheckAs(user: User | undefined, identity: RequestIdentity | undefined, sessionActive = true): Promise<{ code: string | undefined } & Pick<ReturnType<typeof checkWith>, 'sessions' | 'users'>> {
  const { identities, sessions, users, check } = checkWith(user, sessionActive)
  const code = await inRequest(identities, async () => {
    if (identity !== undefined)
      identities.record(identity)
    return check.recheck(SNAPSHOT).then(() => undefined, (error: unknown) => {
      if (error instanceof AppError)
        return error.code
      throw error
    })
  })
  return { code, sessions, users }
}

describe('SnapshotIdentityCheck：只读快照的开场核对（M2 Codex 评审 CX1）', () => {
  it('应用初始化时向 database 登记一次（控制反转：database 不依赖 auth、users）', async () => {
    const { identities, sessions, users, transactions, check } = checkWith(ALICE)
    check.onModuleInit()
    expect(transactions.registerSnapshotOpening).toHaveBeenCalledTimes(1)
    const opening = transactions.registerSnapshotOpening.mock.calls[0]?.[0] as (transaction: Transaction) => Promise<void>
    await inRequest(identities, async () => {
      identities.record(aliceAs(false))
      await opening(SNAPSHOT)
    })
    expect(sessions.isActive).toHaveBeenCalledExactlyOnceWith(SESSION_ID, SNAPSHOT)
    expect(users.findById).toHaveBeenCalledExactlyOnceWith(ALICE.id, SNAPSHOT)
  })

  it('会话与账户都仍然有效：通过；都在快照的事务里读，先会话（第一条语句，确定快照的时刻）、后账户', async () => {
    const { code, sessions, users } = await recheckAs(ALICE, aliceAs(false))
    expect(code).toBeUndefined()
    expect(sessions.isActive).toHaveBeenCalledExactlyOnceWith(SESSION_ID, SNAPSHOT)
    expect(users.findById).toHaveBeenCalledExactlyOnceWith(ALICE.id, SNAPSHOT)
    expect(sessions.isActive.mock.invocationCallOrder[0]).toBeLessThan(users.findById.mock.invocationCallOrder[0] ?? 0)
  })

  it('守卫之后会话被撤销或过期（退出、签发重置撤销全部会话、换令牌），账户仍然有效：SESSION_EXPIRED，不再读账户（M2 Codex 评审复验的建议 3）', async () => {
    const { code, users } = await recheckAs(ALICE, aliceAs(false), false)
    expect(code).toBe('SESSION_EXPIRED')
    expect(users.findById).not.toHaveBeenCalled()
    // 系统管理员同样：先按登录已过期
    expect((await recheckAs({ ...ALICE, systemRole: 'admin' }, aliceAs(true), false)).code).toBe('SESSION_EXPIRED')
  })

  it('守卫之后账户被停用（或者不在了）：SESSION_EXPIRED，与守卫的说法一致', async () => {
    expect((await recheckAs({ ...ALICE, status: 'disabled' }, aliceAs(false))).code).toBe('SESSION_EXPIRED')
    expect((await recheckAs(undefined, aliceAs(false))).code).toBe('SESSION_EXPIRED')
    // 停用的系统管理员同样先按登录已过期
    expect((await recheckAs({ ...ALICE, systemRole: 'admin', status: 'disabled' }, aliceAs(true))).code).toBe('SESSION_EXPIRED')
  })

  it('守卫读到是系统管理员、快照里已经不是：PERMISSION_DENIED（只给系统管理员的接口与没有加入的系统管理员看团队空间的成员都靠它）', async () => {
    expect((await recheckAs(ALICE, aliceAs(true))).code).toBe('PERMISSION_DENIED')
    expect((await recheckAs({ ...ALICE, systemRole: 'admin' }, aliceAs(true))).code).toBeUndefined()
  })

  it('守卫读到是普通成员、快照里已经是系统管理员：通过（调用者仍按普通成员判断，看到的只会更少）', async () => {
    expect((await recheckAs({ ...ALICE, systemRole: 'admin' }, aliceAs(false))).code).toBeUndefined()
  })

  it('守卫没有记下身份（公开的接口）、不在请求里（命令行、定时任务）：什么也不查', async () => {
    const { code, sessions, users } = await recheckAs(ALICE, undefined)
    expect(code).toBeUndefined()
    expect(sessions.isActive).not.toHaveBeenCalled()
    expect(users.findById).not.toHaveBeenCalled()
    const outside = checkWith(ALICE)
    await outside.check.recheck(SNAPSHOT)
    expect(outside.sessions.isActive).not.toHaveBeenCalled()
    expect(outside.users.findById).not.toHaveBeenCalled()
  })
})
