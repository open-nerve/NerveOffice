// 会话服务：令牌是不是因为换令牌而失效的（复验 N3）；修改密码时怎么撤销本人的会话（M2-P6 复验 一般-3）；写事务里再核对这次登录（M3-P6）。
// 仓储用假的，只核对问了什么、怎么解读、按什么顺序做；库里的查询由集成测试覆盖（session.test.ts、change-password.test.ts）。
import type { Buffer } from 'node:buffer'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { SessionsRepository } from './sessions.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { generateSessionToken, sessionTokenDigest } from './session-token.ts'
import { SessionService } from './session.service.ts'

const CONFIG = { session: { idleTimeoutMinutes: 720, absoluteTimeoutMinutes: 10_080 } } as unknown as AppConfig
const TRANSACTION = { opaque: true } as unknown as Transaction

/** revoked：仓储回答"这条会话是不是因为给出的原因之一被撤销的"；currentActive：撤销当前这条时它还没被撤销过（这次撤销了它） */
function setup(revoked: boolean, currentActive = true) {
  const repository = {
    isActiveById: vi.fn(async (_id: string, _transaction: Transaction) => currentActive),
    revokedFor: vi.fn(async (_tokenHash: Buffer, _reasons: readonly string[], _transaction?: Transaction) => revoked),
    revoke: vi.fn(async (_where: { id: string } | { tokenHash: Buffer }, _reason: string, _transaction?: Transaction) => currentActive),
    revokeAllOfUser: vi.fn(async (_userId: string, _reason: string, _transaction?: Transaction) => {}),
  }
  const service = new SessionService(repository as unknown as SessionsRepository, CONFIG)
  return { service, repository }
}

describe('SessionService.invalidatedByRotation（复验 N3）', () => {
  it('按令牌的摘要问：是不是因为换成了新的会话（同一个浏览器重新登录、在这个浏览器里修改密码）而撤销的；是的话为真', async () => {
    const token = generateSessionToken()
    const { service, repository } = setup(true)
    expect(await service.invalidatedByRotation(token)).toBe(true)
    expect(repository.revokedFor).toHaveBeenCalledTimes(1)
    const [tokenHash, reasons] = repository.revokedFor.mock.calls[0] ?? []
    expect(tokenHash?.equals(sessionTokenDigest(token))).toBe(true)
    // 只有 replaced 算换令牌：退出、停用、重置密码、修改密码时别的设备上的会话（password_changed）之后都不会有新的 Cookie，
    // 照旧清除（M2-P6 复验 一般-3）
    expect(reasons).toEqual(['replaced'])
  })

  it('不是因为换令牌撤销的（退出、停用、重置密码、修改密码时别的设备上的）、还没撤销（只是过期）、没有这条会话：为假', async () => {
    const { service } = setup(false)
    expect(await service.invalidatedByRotation(generateSessionToken())).toBe(false)
  })

  it('退出时在退出的事务里问：事务交给仓储（M2-P6 第 3 片复验：提交之后不再访问数据库）', async () => {
    const token = generateSessionToken()
    const { service, repository } = setup(true)
    expect(await service.invalidatedByRotation(token, TRANSACTION)).toBe(true)
    expect(repository.revokedFor.mock.calls[0]?.[2]).toBe(TRANSACTION)
  })

  it('令牌的格式不对（不是我们发的）：不查库，为假', async () => {
    const { service, repository } = setup(true)
    expect(await service.invalidatedByRotation('not-a-token')).toBe(false)
    expect(repository.revokedFor).not.toHaveBeenCalled()
  })
})

describe('SessionService.revokeForPasswordChange（M2-P6 复验 一般-3）', () => {
  it('先把当前这条按 replaced 撤销（它换成了新的），再把本人其余的按 password_changed 撤销，都在调用方的事务里', async () => {
    const { service, repository } = setup(false)
    expect(await service.revokeForPasswordChange('user-1', 'session-current', TRANSACTION)).toBe(true)
    expect(repository.revoke).toHaveBeenCalledExactlyOnceWith({ id: 'session-current' }, 'replaced', TRANSACTION)
    expect(repository.revokeAllOfUser).toHaveBeenCalledExactlyOnceWith('user-1', 'password_changed', TRANSACTION)
    // 反过来的话，当前这条会被"其余的"一并记成 password_changed
    expect(repository.revoke.mock.invocationCallOrder[0]).toBeLessThan(repository.revokeAllOfUser.mock.invocationCallOrder[0] ?? 0)
  })

  it('当前这条在认证之后已经结束（同一个浏览器刚退出、刚重新登录，撤销时它已经撤销过）：返回假，其余的不动，由调用方回滚（M2-P6）', async () => {
    const { service, repository } = setup(false, false)
    expect(await service.revokeForPasswordChange('user-1', 'session-current', TRANSACTION)).toBe(false)
    expect(repository.revoke).toHaveBeenCalledExactlyOnceWith({ id: 'session-current' }, 'replaced', TRANSACTION)
    expect(repository.revokeAllOfUser).not.toHaveBeenCalled()
  })
})

describe('SessionService.requireActive（M3-P1 审查 A1 的口径，M3-P6 收进 auth）', () => {
  it('这次登录仍然有效：在调用方的事务里按 id 查一条，什么也不抛', async () => {
    const { service, repository } = setup(false, true)
    await expect(service.requireActive('session-1', TRANSACTION)).resolves.toBeUndefined()
    expect(repository.isActiveById.mock.calls).toEqual([['session-1', TRANSACTION]])
  })

  it('已经失效（撤销、过期）：401 SESSION_EXPIRED（不动 Cookie 由守卫之外的这条路径保证：它只抛业务错误）', async () => {
    const { service } = setup(false, false)
    const failure = await service.requireActive('session-1', TRANSACTION).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AppError)
    expect((failure as AppError).code).toBe('SESSION_EXPIRED')
  })
})
