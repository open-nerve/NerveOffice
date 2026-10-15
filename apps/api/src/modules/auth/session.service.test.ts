// 会话服务：修改密码时怎么撤销本人的会话；写事务里再核对这次登录。失效原因与令牌分类见 session-expiration.test.ts。
// 仓储用假的，只核对问了什么、怎么解读、按什么顺序做；库里的查询由集成测试覆盖（session.test.ts、change-password.test.ts）。
import type { Buffer } from 'node:buffer'
import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { SessionsRepository } from './sessions.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { SessionService } from './session.service.ts'

const CONFIG = { session: { idleTimeoutMinutes: 720, absoluteTimeoutMinutes: 10_080 } } as unknown as AppConfig
const TRANSACTION = { opaque: true } as unknown as Transaction

/** currentActive：撤销当前这条时它还没被撤销过（这次撤销了它）。 */
function setup(currentActive = true) {
  const repository = {
    stateById: vi.fn(async (_id: string, _transaction: Transaction) => ({ userId: 'user-1', active: currentActive, revokedReason: currentActive ? null : 'logout' })),
    revoke: vi.fn(async (_where: { id: string } | { tokenHash: Buffer }, _reason: string, _transaction?: Transaction) => currentActive),
    revokeAllOfUser: vi.fn(async (_userId: string, _reason: string, _transaction?: Transaction) => {}),
  }
  const service = new SessionService(repository as unknown as SessionsRepository, CONFIG)
  return { service, repository }
}

describe('SessionService.revokeForPasswordChange（M2-P6 复验 一般-3）', () => {
  it('先把当前这条按 replaced 撤销（它换成了新的），再把本人其余的按 password_changed 撤销，都在调用方的事务里', async () => {
    const { service, repository } = setup(true)
    expect(await service.revokeForPasswordChange('user-1', 'session-current', TRANSACTION)).toBe(true)
    expect(repository.revoke).toHaveBeenCalledExactlyOnceWith({ id: 'session-current' }, 'replaced', TRANSACTION)
    expect(repository.revokeAllOfUser).toHaveBeenCalledExactlyOnceWith('user-1', 'password_changed', TRANSACTION)
    // 反过来的话，当前这条会被"其余的"一并记成 password_changed
    expect(repository.revoke.mock.invocationCallOrder[0]).toBeLessThan(repository.revokeAllOfUser.mock.invocationCallOrder[0] ?? 0)
  })

  it('当前这条在认证之后已经结束（同一个浏览器刚退出、刚重新登录，撤销时它已经撤销过）：返回假，其余的不动，由调用方回滚（M2-P6）', async () => {
    const { service, repository } = setup(false)
    expect(await service.revokeForPasswordChange('user-1', 'session-current', TRANSACTION)).toBe(false)
    expect(repository.revoke).toHaveBeenCalledExactlyOnceWith({ id: 'session-current' }, 'replaced', TRANSACTION)
    expect(repository.revokeAllOfUser).not.toHaveBeenCalled()
  })
})

describe('SessionService.requireActive（M3-P1 审查 A1 的口径，M3-P6 收进 auth）', () => {
  it('这次登录仍然有效：在调用方的事务里按 id 查一条，什么也不抛', async () => {
    const { service, repository } = setup(true)
    await expect(service.requireActive('session-1', TRANSACTION)).resolves.toBeUndefined()
    expect(repository.stateById.mock.calls).toEqual([['session-1', TRANSACTION]])
  })

  it('已经失效（撤销、过期）：401 SESSION_EXPIRED（不动 Cookie 由守卫之外的这条路径保证：它只抛业务错误）', async () => {
    const { service } = setup(false)
    const failure = await service.requireActive('session-1', TRANSACTION).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AppError)
    expect((failure as AppError).code).toBe('SESSION_EXPIRED')
  })
})
