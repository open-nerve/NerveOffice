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
import { SessionResponses } from './session-response.ts'
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

/** 数据库繁忙（等锁超时）：与 pg 的 DatabaseError 同样的形状，包在 drizzle 的错误里 */
function lockTimeout(): Error {
  return new Error('Failed query', { cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03', severity: 'ERROR' }) })
}

/** verifyFails：读凭据出错；createFails：新建会话（成功的那个事务里）出错；auditFails：写审计出错 */
function setup(options: { admission?: Admission, currentValid?: boolean, stillCurrent?: boolean, sessionActive?: boolean, lockedForSeconds?: number, hashBusy?: boolean, verifyFails?: Error, createFails?: Error, auditFails?: Error } = {}) {
  const ticket = {
    lockedForSeconds: options.lockedForSeconds,
    succeeded: vi.fn(async (_transaction?: Transaction) => {}),
    abandoned: vi.fn(async () => {}),
  } satisfies LoginTicket
  const throttle = { admit: vi.fn(async () => options.admission ?? { admitted: true, ticket }), purgeExpired: vi.fn(async () => {}) }
  const users = {
    verifyPasswordOf: vi.fn(async () => {
      if (options.verifyFails !== undefined)
        throw options.verifyFails
      return (options.currentValid ?? true) ? CREDENTIALS : undefined
    }),
    hashPassword: vi.fn(async (password: string) => {
      if (options.hashBusy === true)
        throw new PasswordHashingBusyError(3)
      return `hash:${password}`
    }),
    replacePassword: vi.fn(async (_credentials: VerifiedCredentials, _hash: string, _transaction: Transaction) => options.stillCurrent ?? true),
  }
  const sessions = {
    revokeForPasswordChange: vi.fn(async (_userId: string, _currentSessionId: string, _transaction: Transaction) => options.sessionActive ?? true),
    create: vi.fn(async (_userId: string, _transaction?: Transaction) => {
      if (options.createFails !== undefined)
        throw options.createFails
      return { id: 'session-new', token: NEW_TOKEN }
    }),
    purgeExpired: vi.fn(async () => {}),
  }
  const audit = { record: vi.fn(async (_event: AuditEvent, _options?: { transaction?: Transaction }) => {
    if (options.auditFails !== undefined)
      throw options.auditFails
  }) }
  /** work 正常返回算提交，抛出算回滚 */
  const committed = { count: 0 }
  const transactions = { run: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => {
    const result = await work(TRANSACTION)
    committed.count += 1
    return result
  }) }
  const spaces = { personalSpaceOf: vi.fn(async (_userId: string, _options?: { transaction?: Transaction }) => ({ id: PERSONAL_SPACE, name: '爱丽丝' })) }
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const service = new AuthService(
    users as unknown as UsersService,
    new SessionResponses(spaces as unknown as SpacesService),
    sessions as unknown as SessionService,
    throttle as unknown as LoginThrottle,
    audit as unknown as AuditService,
    transactions as unknown as TransactionRunner,
    logger,
  )
  return { service, ticket, throttle, users, sessions, spaces, audit, committed, warn }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw error instanceof Error ? error : new Error('期望抛出 AppError')
  return error
}

describe('AuthService.changePassword（US-M2-02）', () => {
  it('成功：在一个事务里先锁账户行复核并更新哈希，再清除限流计数、撤销本人的全部会话（当前这个按换成新的撤销，M2-P6 复验 一般-3）、为当前页面新建会话、记审计', async () => {
    const { service, ticket, throttle, users, sessions, spaces, audit } = setup()
    const result = await service.changePassword(PRINCIPAL, REQUEST, ORIGIN)
    // 响应在同一个事务里拼好（M2-P6 第 3 片复验）：提交之后不再访问数据库
    expect(spaces.personalSpaceOf).toHaveBeenCalledWith(ALICE.id, { transaction: TRANSACTION })
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
    const { service, ticket, sessions, audit, committed } = setup({ stillCurrent: false })
    expect((await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))).code).toBe('CURRENT_PASSWORD_INCORRECT')
    // 这个事务什么也没改：回滚而不是提交，不留下一次提交（M2-P6 第 3 片复验）
    expect(committed.count).toBe(0)
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(ticket.abandoned).not.toHaveBeenCalled()
    // 事务回滚之后才记（审计不在事务里）
    expect(audit.record.mock.calls[0]?.[1]).toBeUndefined()
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

  it('当前的会话已经结束而退回名额失败：仍然按登录已过期回答，记一条告警（退回尽力而为）', async () => {
    const { service, ticket, warn } = setup({ sessionActive: false })
    ticket.abandoned.mockRejectedValueOnce(lockTimeout())
    expect((await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))).code).toBe('SESSION_EXPIRED')
    expect(warn).toHaveBeenCalledWith('退回登录限流的名额失败，这次尝试按一次失败计', expect.objectContaining({ err: expect.any(Error) as unknown }))
  })

  it('读凭据时数据库繁忙（还没有比对旧密码）：退回名额，原样抛出（异常过滤器回 503），不记审计（M2-P6 第 3 片复验 建议 1）', async () => {
    const busy = lockTimeout()
    const { service, ticket, users, audit } = setup({ verifyFails: busy })
    await expect(service.changePassword(PRINCIPAL, REQUEST, ORIGIN)).rejects.toBe(busy)
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(users.hashPassword).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('成功的那个事务里数据库繁忙（旧密码已经确认是对的）：退回名额，原样抛出', async () => {
    const busy = lockTimeout()
    const { service, ticket } = setup({ createFails: busy })
    await expect(service.changePassword(PRINCIPAL, REQUEST, ORIGIN)).rejects.toBe(busy)
    expect(ticket.abandoned).toHaveBeenCalledOnce()
  })

  it('旧密码不对之后写审计时数据库繁忙：照样按一次失败计（名额不退回）', async () => {
    const busy = lockTimeout()
    const { service, ticket } = setup({ currentValid: false, auditFails: busy })
    await expect(service.changePassword(PRINCIPAL, REQUEST, ORIGIN)).rejects.toBe(busy)
    expect(ticket.abandoned).not.toHaveBeenCalled()
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
