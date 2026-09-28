import type { AuditEvent, AuditService } from '../audit/index.ts'
import type { Transaction, TransactionRunner } from '../database/index.ts'
import type { SpacesService } from '../spaces/index.ts'
import type { User, UsersService } from '../users/index.ts'
import type { Admission, LoginThrottle, LoginTicket } from './login-throttle.ts'
import type { Principal } from './principal.ts'
import type { SessionService } from './session.service.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { PasswordHashingBusyError } from '../users/index.ts'
import { AuthService } from './auth.service.ts'

const ALICE: User = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member', status: 'active' }
const PRINCIPAL: Principal = { user: ALICE, sessionId: 'session-current', csrfToken: 'csrf' }
const ORIGIN = { source: 'http' as const, requestId: 'req-1', clientIp: '203.0.113.7' }
const TRANSACTION = { opaque: true } as unknown as Transaction
const REQUEST = { currentPassword: 'old-password', newPassword: 'new-password-123' }

function setup(options: { admission?: Admission, currentValid?: boolean, lockedForSeconds?: number, hashBusy?: boolean } = {}) {
  const ticket = {
    lockedForSeconds: options.lockedForSeconds,
    succeeded: vi.fn(async (_transaction?: Transaction) => {}),
    abandoned: vi.fn(async () => {}),
  } satisfies LoginTicket
  const throttle = { admit: vi.fn(async () => options.admission ?? { admitted: true, ticket }), purgeExpired: vi.fn(async () => {}) }
  const users = {
    verifyPasswordOf: vi.fn(async () => options.currentValid ?? true),
    hashPassword: vi.fn(async (password: string) => {
      if (options.hashBusy === true)
        throw new PasswordHashingBusyError(3)
      return `hash:${password}`
    }),
    setPasswordHash: vi.fn(async (_userId: string, _hash: string, _transaction: Transaction) => {}),
  }
  const sessions = { revokeAllOf: vi.fn(async () => {}), purgeExpired: vi.fn(async () => {}) }
  const audit = { record: vi.fn(async (_event: AuditEvent, _options?: { transaction?: Transaction }) => {}) }
  const transactions = { run: vi.fn(async <T>(work: (transaction: Transaction) => Promise<T>) => work(TRANSACTION)) }
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const service = new AuthService(
    users as unknown as UsersService,
    { personalSpaceOf: vi.fn() } as unknown as SpacesService,
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
  it('成功：在一个事务里清除限流计数、更新哈希、撤销其他会话（保留当前会话）、记审计', async () => {
    const { service, ticket, throttle, users, sessions, audit } = setup()
    await service.changePassword(PRINCIPAL, REQUEST, ORIGIN)
    expect(throttle.admit).toHaveBeenCalledWith({ username: 'alice', clientIp: '203.0.113.7' })
    expect(users.verifyPasswordOf).toHaveBeenCalledWith(ALICE.id, 'old-password')
    expect(ticket.succeeded).toHaveBeenCalledWith(TRANSACTION)
    expect(users.setPasswordHash).toHaveBeenCalledWith(ALICE.id, 'hash:new-password-123', TRANSACTION)
    expect(sessions.revokeAllOf).toHaveBeenCalledWith(ALICE.id, 'password_changed', { except: 'session-current', transaction: TRANSACTION })
    expect(audit.record).toHaveBeenCalledWith(
      { action: 'users.password_changed', actor: { type: 'user', id: ALICE.id }, target: { type: 'user', id: ALICE.id }, origin: ORIGIN },
      { transaction: TRANSACTION },
    )
    // 审计里没有密码
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('password-123')
  })

  it('旧密码不对：CURRENT_PASSWORD_INCORRECT，不改密码、不撤销会话，名额不退回（按一次失败计）', async () => {
    const { service, ticket, users, sessions } = setup({ currentValid: false })
    expect((await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))).code).toBe('CURRENT_PASSWORD_INCORRECT')
    expect(users.hashPassword).not.toHaveBeenCalled()
    expect(users.setPasswordHash).not.toHaveBeenCalled()
    expect(sessions.revokeAllOf).not.toHaveBeenCalled()
    expect(ticket.succeeded).not.toHaveBeenCalled()
    expect(ticket.abandoned).not.toHaveBeenCalled()
  })

  it('这次失败使计数达到上限：直接回答 429 与 Retry-After', async () => {
    const error = await errorOf(setup({ currentValid: false, lockedForSeconds: 60 }).service.changePassword(PRINCIPAL, REQUEST, ORIGIN))
    expect(error.code).toBe('TOO_MANY_ATTEMPTS')
    expect(error.headers).toEqual({ 'Retry-After': '60' })
  })

  it('限流拒绝：429，不验证旧密码', async () => {
    const { service, users } = setup({ admission: { admitted: false, retryAfterSeconds: 30 } })
    expect((await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))).code).toBe('TOO_MANY_ATTEMPTS')
    expect(users.verifyPasswordOf).not.toHaveBeenCalled()
  })

  it('计算新哈希时等待的请求太多：503，退回名额（旧密码是对的，不算失败），不改密码', async () => {
    const { service, ticket, users } = setup({ hashBusy: true })
    const error = await errorOf(service.changePassword(PRINCIPAL, REQUEST, ORIGIN))
    expect(error.code).toBe('SERVICE_UNAVAILABLE')
    expect(error.headers).toEqual({ 'Retry-After': '3' })
    expect(ticket.abandoned).toHaveBeenCalledOnce()
    expect(users.setPasswordHash).not.toHaveBeenCalled()
  })
})
