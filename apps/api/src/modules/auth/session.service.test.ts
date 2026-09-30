// 会话服务：令牌是不是因为换令牌而失效的（复验 N3）。仓储用假的，只核对问了什么、怎么解读；库里的查询由集成测试覆盖（session.test.ts）。
import type { Buffer } from 'node:buffer'
import type { AppConfig } from '../config/index.ts'
import type { SessionsRepository } from './sessions.repository.ts'
import { describe, expect, it, vi } from 'vitest'
import { generateSessionToken, sessionTokenDigest } from './session-token.ts'
import { SessionService } from './session.service.ts'

const CONFIG = { session: { idleTimeoutMinutes: 720, absoluteTimeoutMinutes: 10_080 } } as unknown as AppConfig

/** revoked：仓储回答"这条会话是不是因为给出的原因之一被撤销的" */
function setup(revoked: boolean) {
  const repository = { revokedFor: vi.fn(async (_tokenHash: Buffer, _reasons: readonly string[]) => revoked) }
  const service = new SessionService(repository as unknown as SessionsRepository, CONFIG)
  return { service, repository }
}

describe('SessionService.invalidatedByRotation（复验 N3）', () => {
  it('按令牌的摘要问：是不是因为修改密码或同一个浏览器重新登录（换令牌）而撤销的；是的话为真', async () => {
    const token = generateSessionToken()
    const { service, repository } = setup(true)
    expect(await service.invalidatedByRotation(token)).toBe(true)
    expect(repository.revokedFor).toHaveBeenCalledTimes(1)
    const [tokenHash, reasons] = repository.revokedFor.mock.calls[0] ?? []
    expect(tokenHash?.equals(sessionTokenDigest(token))).toBe(true)
    // 只有这两个原因算换令牌：退出、停用、重置密码之后不会有新的 Cookie，照旧清除
    expect([...(reasons ?? [])].sort()).toEqual(['password_changed', 'replaced'])
  })

  it('不是因为这两个原因撤销的（退出、停用、重置密码）、还没撤销（只是过期）、没有这条会话：为假', async () => {
    const { service } = setup(false)
    expect(await service.invalidatedByRotation(generateSessionToken())).toBe(false)
  })

  it('令牌的格式不对（不是我们发的）：不查库，为假', async () => {
    const { service, repository } = setup(true)
    expect(await service.invalidatedByRotation('not-a-token')).toBe(false)
    expect(repository.revokedFor).not.toHaveBeenCalled()
  })
})
