import type { AuditEvent, AuditService } from '../audit/index.ts'
import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { SpacesService } from '../spaces/index.ts'
import type { CredentialCheck, User, UsersService } from '../users/index.ts'
import type { Admission, LoginThrottle, LoginTicket } from './login-throttle.ts'
import type { SessionService } from './session.service.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { AuthService } from './auth.service.ts'
import { csrfTokenFor, generateSessionToken } from './session-token.ts'

const ALICE: User = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member', status: 'active' }
const SPACE = { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', name: '爱丽丝' }
const ORIGIN = { source: 'http' as const, requestId: 'req-1', clientIp: '203.0.113.7' }
const TRANSACTION = { opaque: true } as unknown as Transaction
const TOKEN = generateSessionToken()

function setup(options: { admission?: Admission, check?: CredentialCheck | Error, purgeFails?: boolean } = {}) {
  const ticket = { lockedForSeconds: undefined, succeeded: vi.fn(async (_transaction?: Transaction) => {}) } satisfies LoginTicket
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
      const check = options.check ?? { valid: true, user: ALICE }
      if (check instanceof Error)
        throw check
      return check
    }),
  }
  const sessions = {
    create: vi.fn(async (_userId: string, _transaction?: Transaction) => ({ id: 'session-1', token: TOKEN })),
    replace: vi.fn(async (_token: string, _transaction?: Transaction) => {}),
    purgeExpired: vi.fn(async () => {}),
  }
  const spaces = { personalSpaceOf: vi.fn(async () => SPACE) }
  const audit = { record: vi.fn(async (_event: AuditEvent, _options?: { transaction?: Transaction }) => {}) }
  const transactions = { run: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => work(TRANSACTION)) }
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const service = new AuthService(
    users as unknown as UsersService,
    spaces as unknown as SpacesService,
    sessions as unknown as SessionService,
    throttle as unknown as LoginThrottle,
    audit as unknown as AuditService,
    transactions as unknown as TransactionRunner,
    logger,
  )
  return { service, ticket, throttle, users, sessions, audit, transactions, warn }
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
    const ticket = { lockedForSeconds: 900, succeeded: vi.fn(async () => {}) }
    const { service, audit } = setup({ admission: { admitted: true, ticket }, check: { valid: false } })
    const error = await errorOf(service.login(REQUEST, ORIGIN))
    expect(error.code).toBe('TOO_MANY_ATTEMPTS')
    expect(error.headers).toEqual({ 'Retry-After': '900' })
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ details: { reason: 'invalid_credentials', lockedForSeconds: 900 } }))
    expect(audit.record.mock.calls[0]?.[0]).not.toHaveProperty('target')
  })

  it('成功：在一个事务里交回名额、作废原来的会话、新建会话、写审计；事务之外清理；返回会话与 CSRF 令牌', async () => {
    const { service, ticket, sessions, audit, throttle } = setup()
    const result = await service.login(REQUEST, ORIGIN, 'previous-token')
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
    expect(audit.record).not.toHaveBeenCalled()
  })
})
