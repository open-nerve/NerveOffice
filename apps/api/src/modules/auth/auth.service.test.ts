import type { AuditEvent, AuditService } from '../audit/index.ts'
import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { SpacesService } from '../spaces/index.ts'
import type { CredentialCheck, User, UsersService, VerifiedCredentials } from '../users/index.ts'
import type { Admission, LoginThrottle, LoginTicket } from './login-throttle.ts'
import type { SessionService } from './session.service.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { PasswordHashingBusyError } from '../users/index.ts'
import { AuthService } from './auth.service.ts'
import { SessionResponses } from './session-response.ts'
import { csrfTokenFor, generateSessionToken } from './session-token.ts'

const ALICE: User = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member', status: 'active' }
const SPACE = { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '爱丽丝' }
const ORIGIN = { source: 'http' as const, requestId: 'req-1', clientIp: '203.0.113.7' }
const TRANSACTION = { opaque: true } as unknown as Transaction
const TOKEN = generateSessionToken()
const CREDENTIALS: VerifiedCredentials = { user: ALICE, passwordVersion: 1 }

/** 数据库繁忙（等锁超时）：与 pg 的 DatabaseError 同样的形状，包在 drizzle 的错误里 */
function lockTimeout(): Error {
  return new Error('Failed query', { cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03', severity: 'ERROR' }) })
}

/** createFails：新建会话（成功的那个事务里）出错；auditFails：写审计出错（失败的审计在事务之外） */
function setup(options: { admission?: Admission, check?: CredentialCheck | Error, purgeFails?: boolean, stillValid?: boolean, createFails?: Error, auditFails?: Error } = {}) {
  const ticket = {
    lockedForSeconds: undefined,
    succeeded: vi.fn(async (_transaction?: Transaction) => {}),
    abandoned: vi.fn(async () => {}),
  } satisfies LoginTicket
  const admission: Admission = options.admission ?? { admitted: true, ticket }
  const throttle = {
    admit: vi.fn(async () => admission),
    purgeExpired: vi.fn(async () => {
      if (options.purgeFails === true)
        throw new Error('数据库不可用')
    }),
  }
  const users = {
    verifyCredentials: vi.fn(async (): Promise<CredentialCheck> => {
      const check = options.check ?? { valid: true, credentials: CREDENTIALS }
      if (check instanceof Error)
        throw check
      return check
    }),
    holdCredentials: vi.fn(async (_credentials: VerifiedCredentials, _transaction: Transaction) => options.stillValid ?? true),
  }
  const sessions = {
    create: vi.fn(async (_userId: string, _transaction?: Transaction) => {
      if (options.createFails !== undefined)
        throw options.createFails
      return { id: 'session-1', token: TOKEN }
    }),
    replace: vi.fn(async (_token: string, _transaction?: Transaction) => {}),
    purgeExpired: vi.fn(async () => {}),
  }
  const spaces = { personalSpaceOf: vi.fn(async (_userId: string, _options?: { transaction?: Transaction }) => SPACE) }
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
  return { service, ticket, throttle, users, sessions, spaces, audit, transactions, committed, warn }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw error instanceof Error ? error : new Error('期望抛出 AppError')
  return error
}

const REQUEST = { username: ' Alice ', password: 'secret' }

describe('AuthService.login', () => {
  it('限流拒绝：429 与 Retry-After，不验证密码、不写审计，只记日志', async () => {
    const { service, users, audit, warn } = setup({ admission: { admitted: false, retryAfterSeconds: 42 } })
    const error = await errorOf(service.login(REQUEST, ORIGIN))
    expect(error.code).toBe('TOO_MANY_ATTEMPTS')
    expect(error.headers).toEqual({ 'Retry-After': '42' })
    expect(users.verifyCredentials).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('登录被限流拒绝', { lockedForSeconds: 42 })
  })

  it('按规范化之后的用户名与客户端地址限流', async () => {
    const { service, throttle } = setup()
    await service.login(REQUEST, ORIGIN)
    expect(throttle.admit).toHaveBeenCalledWith({ username: 'alice', clientIp: '203.0.113.7' })
  })

  it('密码错误：401，写审计（对象是这个账户），名额不退回；事务之外清理过期的记录', async () => {
    const { service, ticket, audit, throttle, sessions, transactions } = setup({ check: { valid: false, user: ALICE } })
    expect((await errorOf(service.login(REQUEST, ORIGIN))).code).toBe('INVALID_CREDENTIALS')
    expect(audit.record).toHaveBeenCalledWith({
      action: 'auth.login_failed',
      actor: { type: 'anonymous' },
      target: { type: 'user', id: ALICE.id },
      origin: ORIGIN,
      details: { reason: 'invalid_credentials' },
    })
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(transactions.run).not.toHaveBeenCalled()
    expect(throttle.purgeExpired).toHaveBeenCalled()
    expect(sessions.purgeExpired).toHaveBeenCalled()
  })

  it('这次失败触发了锁定：429 与 Retry-After，审计记下锁定的秒数；用户名不存在时审计没有对象', async () => {
    const ticket = { lockedForSeconds: 900, succeeded: vi.fn(async () => {}), abandoned: vi.fn(async () => {}) }
    const { service, audit } = setup({ admission: { admitted: true, ticket }, check: { valid: false } })
    const error = await errorOf(service.login(REQUEST, ORIGIN))
    expect(error.code).toBe('TOO_MANY_ATTEMPTS')
    expect(error.headers).toEqual({ 'Retry-After': '900' })
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ details: { reason: 'invalid_credentials', lockedForSeconds: 900 } }))
    expect(audit.record.mock.calls[0]?.[0]).not.toHaveProperty('target')
  })

  it('成功：在一个事务里先复核凭据，再交回名额、作废原来的会话、新建会话、写审计、拼好响应；事务之外清理；返回会话与 CSRF 令牌', async () => {
    const { service, ticket, users, sessions, spaces, audit, throttle } = setup()
    const result = await service.login(REQUEST, ORIGIN, 'previous-token')
    // 响应在同一个事务里拼好（M2-P6 第 3 片复验）：提交之后不再访问数据库
    expect(spaces.personalSpaceOf).toHaveBeenCalledWith(ALICE.id, { transaction: TRANSACTION })
    expect(users.holdCredentials).toHaveBeenCalledWith(CREDENTIALS, TRANSACTION)
    expect(users.holdCredentials.mock.invocationCallOrder[0]).toBeLessThan(ticket.succeeded.mock.invocationCallOrder[0] ?? 0)
    expect(ticket.succeeded).toHaveBeenCalledWith(TRANSACTION)
    expect(sessions.replace).toHaveBeenCalledWith('previous-token', TRANSACTION)
    expect(sessions.create).toHaveBeenCalledWith(ALICE.id, TRANSACTION)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login_succeeded', actor: { type: 'user', id: ALICE.id } }), { transaction: TRANSACTION })
    expect(throttle.purgeExpired.mock.invocationCallOrder[0]).toBeGreaterThan(audit.record.mock.invocationCallOrder[0] ?? Infinity)
    expect(result).toEqual({
      token: TOKEN,
      session: {
        user: { id: ALICE.id, username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
        personalSpace: SPACE,
        csrfToken: csrfTokenFor(TOKEN),
      },
    })
  })

  it('复核不通过（验证之后改了密码、签发或完成了重置、停用了，审查 A1）：事务回滚，按凭据无效处理，不建会话，名额不退回，事务之外写审计（原因另记，复验 N6）', async () => {
    const { service, ticket, sessions, audit, committed } = setup({ stillValid: false })
    expect((await errorOf(service.login(REQUEST, ORIGIN, 'previous-token'))).code).toBe('INVALID_CREDENTIALS')
    // 这个事务什么也没改：回滚而不是提交，不留下一次提交（M2-P6 第 3 片复验）
    expect(committed.count).toBe(0)
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(ticket.abandoned).not.toHaveBeenCalled()
    expect(sessions.replace).not.toHaveBeenCalled()
    expect(sessions.create).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledWith({
      action: 'auth.login_failed',
      actor: { type: 'anonymous' },
      target: { type: 'user', id: ALICE.id },
      origin: ORIGIN,
      details: { reason: 'credentials_changed' },
    })
  })

  it('复核不通过而这次失败触发了锁定：429', async () => {
    const ticket = { lockedForSeconds: 900, succeeded: vi.fn(async () => {}), abandoned: vi.fn(async () => {}) }
    const { service } = setup({ admission: { admitted: true, ticket }, stillValid: false })
    expect(await errorOf(service.login(REQUEST, ORIGIN))).toMatchObject({ code: 'TOO_MANY_ATTEMPTS', headers: { 'Retry-After': '900' } })
  })

  it('没有带原来的会话：不作废任何会话', async () => {
    const { service, sessions } = setup()
    await service.login(REQUEST, ORIGIN)
    expect(sessions.replace).not.toHaveBeenCalled()
  })

  it('清理失败只记日志，不影响登录的结果', async () => {
    const success = setup({ purgeFails: true })
    expect((await success.service.login(REQUEST, ORIGIN)).token).toBe(TOKEN)
    expect(success.warn).toHaveBeenCalledWith(expect.stringContaining('清理过期'), expect.objectContaining({ err: expect.any(Error) as unknown }))

    const failure = setup({ purgeFails: true, check: { valid: false } })
    expect((await errorOf(failure.service.login(REQUEST, ORIGIN))).code).toBe('INVALID_CREDENTIALS')
  })

  it('验证本身出错（例如库里的哈希损坏）：原样抛出，名额不退回、不写审计', async () => {
    const { service, ticket, audit } = setup({ check: new Error('哈希格式不对') })
    await expect(service.login(REQUEST, ORIGIN)).rejects.toThrow('哈希格式不对')
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(ticket.abandoned).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('等待哈希的请求太多时退回名额失败：仍然 503 与 Retry-After，记一条告警（审查 A11）', async () => {
    const { service, ticket, warn } = setup({ check: new PasswordHashingBusyError(5) })
    ticket.abandoned.mockRejectedValueOnce(new Error('数据库不可用'))
    const error = await errorOf(service.login(REQUEST, ORIGIN))
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', headers: { 'Retry-After': '5' } })
    expect(warn).toHaveBeenCalledWith('退回登录限流的名额失败，这次尝试按一次失败计', expect.objectContaining({ err: expect.any(Error) as unknown }))
  })

  it('读凭据时数据库繁忙（还没有比对密码）：退回名额，原样抛出（异常过滤器回 503），不写审计、不开事务（M2-P6 第 3 片复验 建议 1）', async () => {
    const busy = lockTimeout()
    const { service, ticket, audit, transactions } = setup({ check: busy })
    await expect(service.login(REQUEST, ORIGIN)).rejects.toBe(busy)
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(audit.record).not.toHaveBeenCalled()
    expect(transactions.run).not.toHaveBeenCalled()
  })

  it('成功的那个事务里数据库繁忙（密码已经确认是对的）：退回名额，原样抛出，不清理', async () => {
    const busy = lockTimeout()
    const { service, ticket, throttle } = setup({ createFails: busy })
    await expect(service.login(REQUEST, ORIGIN)).rejects.toBe(busy)
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(throttle.purgeExpired).not.toHaveBeenCalled()
  })

  it('成功的那个事务里别的错误：名额不退回（只有繁忙才退回）', async () => {
    const { service, ticket } = setup({ createFails: new Error('约束冲突') })
    await expect(service.login(REQUEST, ORIGIN)).rejects.toThrow('约束冲突')
    expect(ticket.abandoned).not.toHaveBeenCalled()
  })

  it('密码不对之后写审计时数据库繁忙：照样按一次失败计（名额不退回），谁也不能借繁忙多猜一次', async () => {
    const busy = lockTimeout()
    const { service, ticket } = setup({ check: { valid: false, user: ALICE }, auditFails: busy })
    await expect(service.login(REQUEST, ORIGIN)).rejects.toBe(busy)
    expect(ticket.abandoned).not.toHaveBeenCalled()
  })

  it('等待哈希的请求太多（DEF-015）：503 与 Retry-After，退回名额，不写审计、不清理，只记日志', async () => {
    const busy = new PasswordHashingBusyError(5)
    const { service, ticket, audit, throttle, transactions, warn } = setup({ check: busy })
    const error = await errorOf(service.login(REQUEST, ORIGIN))
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', headers: { 'Retry-After': '5' }, cause: busy })
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
    expect(transactions.run).not.toHaveBeenCalled()
    expect(throttle.purgeExpired).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('等待密码哈希的请求太多，拒绝这次请求', { retryAfterSeconds: 5 })
  })
})
