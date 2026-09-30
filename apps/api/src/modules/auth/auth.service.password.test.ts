import type { AuditEvent, AuditService } from '../audit/index.ts'
import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { SpacesService } from '../spaces/index.ts'
import type { User, UsersService, VerifiedCredentials } from '../users/index.ts'
import type { Admission, LoginThrottle, LoginTicket } from './login-throttle.ts'
import type { Principal } from './principal.ts'
import type { SessionService } from './session.service.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { PasswordHashingBusyError } from '../users/index.ts'
import { AuthService } from './auth.service.ts'
import { csrfTokenFor } from './session-token.ts'

const ALICE: User = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member', status: 'active' }
const PRINCIPAL: Principal = { user: ALICE, sessionId: 'session-current', csrfToken: 'csrf' }
const ORIGIN = { source: 'http' as const, requestId: 'req-1', clientIp: '203.0.113.7' }
const TRANSACTION = { opaque: true } as unknown as Transaction
const REQUEST = { currentPassword: 'old-password', newPassword: 'new-password-123' }
const CREDENTIALS: VerifiedCredentials = { user: ALICE, passwordVersion: 1 }
const PERSONAL_SPACE = '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f'
/** 改完密码之后给当前页面的新会话令牌 */
const NEW_TOKEN = 'n'.repeat(43)

function setup(options: { admission?: Admission, currentValid?: boolean, stillCurrent?: boolean, sessionActive?: boolean, lockedForSeconds?: number, hashBusy?: boolean } = {}) {
  const ticket = {
    lockedForSeconds: options.lockedForSeconds,
    succeeded: vi.fn(async (_transaction?: Transaction) => {}),
    abandoned: vi.fn(async () => {}),
  } satisfies LoginTicket
  const throttle = { admit: vi.fn(async () => options.admission ?? { admitted: true, ticket }), purgeExpired: vi.fn(async () => {}) }
  const users = {
    verifyPasswordOf: vi.fn(async () => (options.currentValid ?? true) ? CREDENTIALS : undefined),
    hashPassword: vi.fn(async (password: string) => {
      if (options.hashBusy === true)
        throw new PasswordHashingBusyError(3)
      return `hash:${password}`
    }),
    replacePassword: vi.fn(async (_credentials: VerifiedCredentials, _hash: string, _transaction: Transaction) => options.stillCurrent ?? true),
  }
  const sessions = {
    revokeForPasswordChange: vi.fn(async (_userId: string, _currentSessionId: string, _transaction: Transaction) => options.sessionActive ?? true),
    create: vi.fn(async (_userId: string, _transaction?: Transaction) => ({ id: 'session-new', token: NEW_TOKEN })),
    purgeExpired: vi.fn(async () => {}),
  }
  const audit = { record: vi.fn(async (_event: AuditEvent, _options?: { transaction?: Transaction }) => {}) }
  const transactions = { run: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => work(TRANSACTION)) }
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const service = new AuthService(
    users as unknown as UsersService,
    { personalSpaceOf: vi.fn(async () => ({ id: PERSONAL_SPACE, name: '爱丽丝' })) } as unknown as SpacesService,
    sessions as unknown as SessionService,
    throttle as unknown as LoginThrottle,
    audit as unknown as AuditService,
    transactions as unknown as TransactionRunner,
    logger,
  )
  return { service, ticket, throttle, users, sessions, audit }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw error instanceof Error ? error : new Error('期望抛出 AppError')
  return error
}

describe('AuthService.changePassword（US-M2-02）', () => {
  it('成功：在一个事务里先锁账户行复核并更新哈希，再清除限流计数、撤销本人的全部会话（当前这个按换成新的撤销，M2-P6 复验 一般-3）、为当前页面新建会话、记审计', async () => {
    const { service, ticket, throttle, users, sessions, audit } = setup()
    const result = await service.changePassword(PRINCIPAL, REQUEST, ORIGIN)
    expect(throttle.admit).toHaveBeenCalledWith({ username: 'alice', clientIp: '203.0.113.7' })
    expect(users.verifyPasswordOf).toHaveBeenCalledWith(ALICE.id, 'old-password')
    expect(users.replacePassword).toHaveBeenCalledWith(CREDENTIALS, 'hash:new-password-123', TRANSACTION)
    expect(users.replacePassword.mock.invocationCallOrder[0]).toBeLessThan(ticket.succeeded.mock.invocationCallOrder[0] ?? 0)
    expect(ticket.succeeded).toHaveBeenCalledWith(TRANSACTION)
    // 不保留当前的会话（M2-P6 复核 B1）：全部撤销之后再新建，都在同一个事务里。撤销时交出当前这条会话，
    // 由会话服务按"换成了新的"记下它，别的设备上的另记（M2-P6 复验 一般-3）
    expect(sessions.revokeForPasswordChange).toHaveBeenCalledWith(ALICE.id, PRINCIPAL.sessionId, TRANSACTION)
    expect(sessions.create).toHaveBeenCalledWith(ALICE.id, TRANSACTION)
    expect(sessions.revokeForPasswordChange.mock.invocationCallOrder[0]).toBeLessThan(sessions.create.mock.invocationCallOrder[0] ?? 0)
    expect(audit.record).toHaveBeenCalledWith(
      { action: 'users.password_changed', actor: { type: 'user', id: ALICE.id }, target: { type: 'user', id: ALICE.id }, origin: ORIGIN },
      { transaction: TRANSACTION },
    )
    // 当前页面换上新的会话：新令牌交给 Cookie，响应与登录相同，CSRF 令牌由新令牌派生
    expect(result.token).toBe(NEW_TOKEN)
    expect(result.session).toEqual({
      user: { id: ALICE.id, username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
      personalSpace: { id: PERSONAL_SPACE, name: '爱丽丝' },
      csrfToken: csrfTokenFor(NEW_TOKEN),
    })
    expect(result.session.csrfToken).not.toBe(PRINCIPAL.csrfToken)
    // 审计里没有密码
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('password-123')
  })

  it('旧密码不对：CURRENT_PASSWORD_INCORRECT，不改密码、不撤销会话，名额不退回（按一次失败计），记审计（审查 A6）', async () => {
    const { service, ticket, users, sessions, audit } = setup({ currentValid: false })
    expect((await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))).code).toBe('CURRENT_PASSWORD_INCORRECT')
    expect(users.hashPassword).not.toHaveBeenCalled()
    expect(users.replacePassword).not.toHaveBeenCalled()
    expect(sessions.revokeForPasswordChange).not.toHaveBeenCalled()
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(ticket.abandoned).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledWith({
      action: 'users.password_change_failed',
      actor: { type: 'user', id: ALICE.id },
      target: { type: 'user', id: ALICE.id },
      origin: ORIGIN,
      details: { reason: 'current_password_incorrect' },
    })
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('old-password')
  })

  it('这次失败使计数达到上限：直接回答 429 与 Retry-After，审计记下锁定的秒数', async () => {
    const { service, audit } = setup({ currentValid: false, lockedForSeconds: 60 })
    const error = await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))
    expect(error.code).toBe('TOO_MANY_ATTEMPTS')
    expect(error.headers).toEqual({ 'Retry-After': '60' })
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ details: { reason: 'current_password_incorrect', lockedForSeconds: 60 } }))
  })

  it('复核不通过（验证旧密码之后密码被改过、重置过，或账户停用了）：按旧密码不对回答，不撤销会话，名额不退回；审计的原因另记（复验 N6）', async () => {
    const { service, ticket, sessions, audit } = setup({ stillCurrent: false })
    expect((await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))).code).toBe('CURRENT_PASSWORD_INCORRECT')
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(sessions.revokeForPasswordChange).not.toHaveBeenCalled()
    expect(sessions.create).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledOnce()
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'users.password_change_failed', details: { reason: 'credentials_changed' } }))
  })

  it('当前的会话在认证之后已经结束（同一个浏览器刚退出，或刚重新登录换成了新的会话，M2-P6）：回滚，按登录已过期回答，不新建会话、不记审计，名额退回', async () => {
    const { service, ticket, sessions, audit } = setup({ sessionActive: false })
    expect((await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))).code).toBe('SESSION_EXPIRED')
    // 限流计数的清除先于会话行（锁的顺序），随事务一起回滚；事务之外把占的名额退回——密码是对的，不算猜错
    expect(ticket.succeeded.mock.invocationCallOrder[0]).toBeLessThan(sessions.revokeForPasswordChange.mock.invocationCallOrder[0] ?? 0)
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(sessions.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('限流拒绝：429，不验证旧密码、不写审计', async () => {
    const { service, users, audit } = setup({ admission: { admitted: false, retryAfterSeconds: 30 } })
    expect((await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))).code).toBe('TOO_MANY_ATTEMPTS')
    expect(users.verifyPasswordOf).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('计算新哈希时等待的请求太多：503，退回名额（旧密码是对的，不算失败），不改密码', async () => {
    const { service, ticket, users } = setup({ hashBusy: true })
    const error = await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))
    expect(error.code).toBe('SERVICE_UNAVAILABLE')
    expect(error.headers).toEqual({ 'Retry-After': '3' })
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(users.replacePassword).not.toHaveBeenCalled()
  })
})
