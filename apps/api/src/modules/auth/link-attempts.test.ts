// 一次性链接的尝试（M2-P6 复核 B3）：只有"没有这个令牌、格式不对"计入失败；找到了记录、只是不能用（过期、已用、已作废）
// 说明拿着的是一条真实的旧链接，退回名额、不计失败。两种都记审计。
import type { LinkInvalidReason } from '@nerve-office/contracts'
import type { AuditEvent, AuditService } from '../audit/index.ts'
import type { AttemptTicket } from './attempt-throttle.ts'
import type { LinkThrottle } from './login-throttle.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { LinkAttempts } from './link-attempts.ts'

const ORIGIN = { source: 'http' as const, requestId: 'req-1', clientIp: '203.0.113.7' }
const TARGET = { type: 'invitation' as const, id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d' }

function setup(lockedForSeconds?: number) {
  const ticket = {
    lockedForSeconds,
    succeeded: vi.fn(async () => {}),
    abandoned: vi.fn(async () => {}),
  } satisfies AttemptTicket
  const audit = { record: vi.fn(async (_event: AuditEvent) => {}) }
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const attempts = new LinkAttempts({ admit: vi.fn() } as unknown as LinkThrottle, audit as unknown as AuditService, logger)
  return { attempts, ticket, audit }
}

describe('LinkAttempts.rejected', () => {
  it('没有这个令牌（invalid）：名额不退回，按一次失败计；LINK_INVALID，记审计', async () => {
    const { attempts, ticket, audit } = setup()
    const error = await attempts.rejected(ticket, 'invitation', 'invalid', undefined, ORIGIN)
    expect([error.code, error.details]).toEqual(['LINK_INVALID', { reason: 'invalid' }])
    expect(ticket.abandoned).not.toHaveBeenCalled()
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledWith({ action: 'auth.link_rejected', actor: { type: 'anonymous' }, origin: ORIGIN, details: { purpose: 'invitation', reason: 'invalid' } })
  })

  it('没有这个令牌、这次失败使计数达到上限：429 与 Retry-After', async () => {
    const { attempts, ticket } = setup(900)
    const error = await attempts.rejected(ticket, 'password_reset', 'invalid', undefined, ORIGIN)
    expect([error.code, error.headers]).toEqual(['TOO_MANY_ATTEMPTS', { 'Retry-After': '900' }])
    expect(ticket.abandoned).not.toHaveBeenCalled()
  })

  it.each(['expired', 'used', 'revoked'] satisfies LinkInvalidReason[])('找到了记录、只是不能用（%s）：退回名额、不计失败，即使占名额时刚好到了上限也不回 429；记审计，带上对象', async (reason) => {
    const { attempts, ticket, audit } = setup(900)
    const error = await attempts.rejected(ticket, 'invitation', reason, TARGET, ORIGIN)
    expect([error.code, error.details]).toEqual(['LINK_INVALID', { reason }])
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(audit.record).toHaveBeenCalledWith({ action: 'auth.link_rejected', actor: { type: 'anonymous' }, target: TARGET, origin: ORIGIN, details: { purpose: 'invitation', reason } })
  })
})
