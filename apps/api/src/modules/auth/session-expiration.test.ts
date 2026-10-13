import type { AppConfig } from '../config/index.ts'
import type { Transaction } from '../database/index.ts'
import type { SessionsRepository, SessionState } from './sessions.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { generateSessionToken, sessionTokenDigest } from './session-token.ts'
import { SessionService } from './session.service.ts'

const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const TRANSACTION = { opaque: true } as unknown as Transaction
const CONFIG = { session: { idleTimeoutMinutes: 720, absoluteTimeoutMinutes: 10_080 } } as unknown as AppConfig

function setup(state: SessionState | undefined) {
  const repository = {
    isActiveById: vi.fn(async () => state?.active ?? false),
    stateById: vi.fn(async () => state),
    stateByTokenHash: vi.fn(async () => state),
  }
  return { repository, service: new SessionService(repository as unknown as SessionsRepository, CONFIG) }
}

describe('会话失效事实：同一状态读取同时决定是否放行与原因', () => {
  it.each([
    ['disabled', 'account_disabled'],
    ['password_reset', 'password_reset'],
    ['password_changed', 'password_changed'],
    ['replaced', 'replaced'],
    ['logout', 'logout'],
    [null, 'expired'],
  ] as const)('事务内 %s 映射为 %s，绑定同一行的用户', async (revokedReason, reason) => {
    const { service, repository } = setup({ userId: USER_ID, active: false, revokedReason })
    await expect(service.requireActive('session', TRANSACTION)).rejects.toMatchObject({ code: 'SESSION_EXPIRED', details: { reason, userId: USER_ID } })
    expect(repository.stateById).toHaveBeenCalledExactlyOnceWith('session', TRANSACTION)
  })

  it('不存在的会话不带用户；有效会话不抛失效', async () => {
    await expect(setup(undefined).service.requireActive('missing', TRANSACTION)).rejects.toMatchObject({ details: { reason: 'expired' } })
    await expect(setup({ userId: USER_ID, active: true, revokedReason: null }).service.requireActive('active', TRANSACTION)).resolves.toBeUndefined()
  })

  it('只按令牌摘要查已识别的会话，不把令牌本身传给仓储', async () => {
    const { service, repository } = setup({ userId: USER_ID, active: false, revokedReason: 'replaced' })
    const token = generateSessionToken()
    expect(await service.expiredDetailsForToken(token, TRANSACTION)).toEqual({ reason: 'replaced', userId: USER_ID })
    expect(repository.stateByTokenHash).toHaveBeenCalledExactlyOnceWith(sessionTokenDigest(token), TRANSACTION)
  })

  it('未提供或畸形令牌不查询数据库', async () => {
    const { service, repository } = setup({ userId: USER_ID, active: false, revokedReason: 'disabled' })
    for (const token of [undefined, '', 'bad'])
      expect(await service.expiredDetailsForToken(token)).toEqual({ reason: 'expired' })
    expect(repository.stateByTokenHash).not.toHaveBeenCalled()
  })

  it('分类读取失败原样向外传播，不能让页面以为停用/到期', async () => {
    const { service, repository } = setup(undefined)
    const failure = new Error('database unavailable')
    repository.stateById.mockRejectedValue(failure)
    repository.stateByTokenHash.mockRejectedValue(failure)
    await expect(service.requireActive('session', TRANSACTION)).rejects.toBe(failure)
    await expect(service.expiredDetails('session', TRANSACTION)).rejects.toBe(failure)
    await expect(service.expiredDetailsForToken(generateSessionToken())).rejects.toBe(failure)
  })
})
