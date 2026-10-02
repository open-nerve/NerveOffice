// 一次性链接的尝试：只有"没有这个令牌、格式不对"计入按地址的失败（M2-P6 复核 B3）；找到了记录、只是不能用（过期、已用、已作废）
// 说明拿着的是一条真实的旧链接，退回按地址的名额，另按这条记录计数（M2-P6）：到上限之后 429、只记日志、不再写审计。
import type { LinkInvalidReason } from '@nerve-office/contracts'
import type { AuditEvent, AuditService } from '../audit/index.ts'
import type { AttemptAdmission, AttemptTicket } from './attempt-throttle.ts'
import type { LinkThrottle } from './login-throttle.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { LinkAttempts } from './link-attempts.ts'

const ORIGIN = { source: 'http' as const, requestId: 'req-1', clientIp: '203.0.113.7' }
const RECORD_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const TARGET = { type: 'invitation' as const, id: RECORD_ID }

function ticketOf(lockedForSeconds?: number) {
  return {
    lockedForSeconds,
    succeeded: vi.fn(async () => {}),
    abandoned: vi.fn(async () => {}),
  } satisfies AttemptTicket
}

/** recordAdmission：按记录计数的结果（找到了但不能用时才会问） */
function setup(options: { addressLockedForSeconds?: number, recordAdmission?: AttemptAdmission } = {}) {
  const ticket = ticketOf(options.addressLockedForSeconds)
  const recordTicket = ticketOf()
  const throttle = {
    admit: vi.fn(),
    admitRejectedRecord: vi.fn(async (): Promise<AttemptAdmission> => options.recordAdmission ?? { admitted: true, ticket: recordTicket }),
  }
  const audit = { record: vi.fn(async (_event: AuditEvent) => {}) }
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const attempts = new LinkAttempts(throttle as unknown as LinkThrottle, audit as unknown as AuditService, logger)
  return { attempts, ticket, recordTicket, throttle, audit, warn }
}

describe('LinkAttempts.rejected：没有这个令牌', () => {
  it('invalid：按地址的名额不退回，计一次失败；不按记录计数；LINK_INVALID，记审计（没有对象）', async () => {
    const { attempts, ticket, throttle, audit } = setup()
    const error = await attempts.rejected(ticket, 'invitation', { reason: 'invalid' }, ORIGIN)
    expect([error.code, error.details]).toEqual(['LINK_INVALID', { reason: 'invalid' }])
    expect(ticket.abandoned).not.toHaveBeenCalled()
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(throttle.admitRejectedRecord).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledWith({ action: 'auth.link_rejected', actor: { type: 'anonymous' }, origin: ORIGIN, details: { purpose: 'invitation', reason: 'invalid' } })
  })

  it('invalid、这次失败使按地址的计数达到上限：429 与 Retry-After，照样记审计', async () => {
    const { attempts, ticket, audit } = setup({ addressLockedForSeconds: 900 })
    const error = await attempts.rejected(ticket, 'password_reset', { reason: 'invalid' }, ORIGIN)
    expect([error.code, error.headers]).toEqual(['TOO_MANY_ATTEMPTS', { 'Retry-After': '900' }])
    expect(ticket.abandoned).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledOnce()
  })

  it('事务里复核时记录不见了（invalid，带着已知的对象）：同样按地址计失败，审计带上对象', async () => {
    const { attempts, ticket, audit } = setup()
    await attempts.rejected(ticket, 'invitation', { reason: 'invalid', target: TARGET }, ORIGIN)
    expect(ticket.abandoned).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ target: TARGET, details: { purpose: 'invitation', reason: 'invalid' } }))
  })
})

describe('LinkAttempts.rejected：找到了记录、只是不能用', () => {
  it.each(['expired', 'used', 'revoked'] satisfies LinkInvalidReason[])('%s：退回按地址的名额（即使占名额时刚好到了上限），按这条记录计一次；LINK_INVALID 与原因，记审计，带上对象', async (reason) => {
    const { attempts, ticket, throttle, audit } = setup({ addressLockedForSeconds: 900 })
    const error = await attempts.rejected(ticket, 'invitation', { reason, recordId: RECORD_ID, target: TARGET }, ORIGIN)
    expect([error.code, error.details]).toEqual(['LINK_INVALID', { reason }])
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(throttle.admitRejectedRecord).toHaveBeenCalledWith('invitation', RECORD_ID)
    expect(audit.record).toHaveBeenCalledWith({ action: 'auth.link_rejected', actor: { type: 'anonymous' }, target: TARGET, origin: ORIGIN, details: { purpose: 'invitation', reason } })
  })

  it('这一次使这条记录的计数达到上限：照样记审计，回 429 与 Retry-After', async () => {
    const { attempts, ticket, audit } = setup({ recordAdmission: { admitted: true, ticket: ticketOf(600) } })
    const error = await attempts.rejected(ticket, 'password_reset', { reason: 'used', recordId: RECORD_ID, target: { type: 'user', id: RECORD_ID } }, ORIGIN)
    expect([error.code, error.headers]).toEqual(['TOO_MANY_ATTEMPTS', { 'Retry-After': '600' }])
    expect(audit.record).toHaveBeenCalledOnce()
  })

  it('这条记录已经锁定：429 与 Retry-After，只记日志、不写审计；按地址的名额照样退回', async () => {
    const { attempts, ticket, audit, warn } = setup({ recordAdmission: { admitted: false, retryAfterSeconds: 420 } })
    const error = await attempts.rejected(ticket, 'invitation', { reason: 'expired', recordId: RECORD_ID, target: TARGET }, ORIGIN)
    expect([error.code, error.headers]).toEqual(['TOO_MANY_ATTEMPTS', { 'Retry-After': '420' }])
    expect(audit.record).not.toHaveBeenCalled()
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('同一条一次性链接反复被打开，这条链接暂时一律拒绝', { purpose: 'invitation', reason: 'expired', lockedForSeconds: 420 })
  })
})
