import type { ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { Request, Response } from 'express'
import type { User, UsersService } from '../users/index.ts'
import type { AuthenticatedSession, SessionService } from './session.service.ts'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { PUBLIC_ROUTE } from '../../shared/public.ts'
import { SYSTEM_ADMIN_ROUTE } from '../../shared/system-admin-only.ts'
import { requestUserId } from '../logging/index.ts'
import { principalOf, sessionCookieOf } from './principal.ts'
import { SessionCookieSettings } from './session-cookie.ts'
import { csrfTokenFor, generateSessionToken } from './session-token.ts'
import { SessionGuard } from './session.guard.ts'

const ALICE: User = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member', status: 'active' }
const SESSION: AuthenticatedSession = { id: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f', userId: ALICE.id, stale: true }

function setup(options: { isPublic?: boolean, adminOnly?: boolean, session?: AuthenticatedSession, user?: User, rotated?: boolean } = {}) {
  const reflector = { getAllAndOverride: vi.fn((key: string) => (key === PUBLIC_ROUTE ? options.isPublic : key === SYSTEM_ADMIN_ROUTE ? options.adminOnly : undefined)) }
  const sessions = {
    authenticate: vi.fn(async (_token: string) => options.session),
    keepAlive: vi.fn(async (_session: AuthenticatedSession) => {}),
    revoke: vi.fn(async (_id: string, _reason: string) => {}),
    invalidatedByRotation: vi.fn(async (_token: string) => options.rotated ?? false),
  }
  const users = { findActiveById: vi.fn(async (_id: string) => options.user) }
  const cookie = new SessionCookieSettings('http://127.0.0.1:4100', 60_000)
  const guard = new SessionGuard(reflector as unknown as Reflector, sessions as unknown as SessionService, users as unknown as UsersService, cookie)
  return { guard, sessions, users }
}

function exchange(cookieHeader?: string) {
  const logChild = vi.fn(() => ({ child: vi.fn() }))
  const request = { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader }, log: { child: logChild } } as unknown as Request
  const response = { cookie: vi.fn(), clearCookie: vi.fn() }
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response as unknown as Response }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext
  return { request, response, context, logChild }
}

async function codeOf(promise: Promise<boolean>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  }
  catch (error) {
    if (error instanceof AppError)
      return error.code
    throw error
  }
}

describe('SessionGuard', () => {
  it('公开的接口：直接放行，但先挂上 Cookie 的读写（登录要用它读原来的会话、写新的会话）', async () => {
    const previous = generateSessionToken()
    const { guard, sessions } = setup({ isPublic: true })
    const { context, request, response } = exchange(`nerve_session=${previous}`)
    expect(await guard.canActivate(context)).toBe(true)
    expect(sessions.authenticate).not.toHaveBeenCalled()
    const jar = sessionCookieOf(request)
    expect(jar?.token).toBe(previous)
    jar?.write('new-token')
    expect(response.cookie).toHaveBeenCalledWith('nerve_session', 'new-token', expect.objectContaining({ httpOnly: true, maxAge: 60_000 }))
  })

  it('没有会话 Cookie：UNAUTHENTICATED，不清除 Cookie', async () => {
    const { guard } = setup()
    const { context, response } = exchange('theme=dark')
    expect(await codeOf(guard.canActivate(context))).toBe('UNAUTHENTICATED')
    expect(response.clearCookie).not.toHaveBeenCalled()
  })

  it('Cookie 的值不是我们发的令牌：SESSION_EXPIRED 并清除，不查库', async () => {
    const { guard, sessions } = setup({ session: SESSION, user: ALICE, rotated: true })
    const { context, response } = exchange('nerve_session=not-a-token')
    expect(await codeOf(guard.canActivate(context))).toBe('SESSION_EXPIRED')
    expect(response.clearCookie).toHaveBeenCalledWith('nerve_session', expect.objectContaining({ httpOnly: true, path: '/' }))
    expect(sessions.authenticate).not.toHaveBeenCalled()
    expect(sessions.invalidatedByRotation).not.toHaveBeenCalled()
  })

  it('会话无效（过期、撤销），不是因为换令牌：SESSION_EXPIRED 并清除', async () => {
    const token = generateSessionToken()
    const { guard, users, sessions } = setup({ session: undefined, user: ALICE })
    const { context, response } = exchange(`nerve_session=${token}`)
    expect(await codeOf(guard.canActivate(context))).toBe('SESSION_EXPIRED')
    expect(response.clearCookie).toHaveBeenCalledWith('nerve_session', expect.objectContaining({ httpOnly: true, path: '/' }))
    expect(sessions.invalidatedByRotation).toHaveBeenCalledWith(token)
    expect(users.findActiveById).not.toHaveBeenCalled()
  })

  it('会话因为换令牌而失效（修改密码、同一个浏览器重新登录，复验 N3）：仍是 SESSION_EXPIRED，但不清除 Cookie（浏览器多半已经拿到了新的）', async () => {
    const token = generateSessionToken()
    const { guard, sessions } = setup({ session: undefined, user: ALICE, rotated: true })
    const { context, response } = exchange(`nerve_session=${token}`)
    expect(await codeOf(guard.canActivate(context))).toBe('SESSION_EXPIRED')
    expect(sessions.invalidatedByRotation).toHaveBeenCalledWith(token)
    expect(response.clearCookie).not.toHaveBeenCalled()
    expect(response.cookie).not.toHaveBeenCalled()
  })

  it('会话有效但账户已不可用（停用或删除）：SESSION_EXPIRED 并清除；会话一并撤销、不顺延（审查 A1）；不问撤销的原因', async () => {
    const { guard, users, sessions } = setup({ session: SESSION, user: undefined, rotated: true })
    const { context, response } = exchange(`nerve_session=${generateSessionToken()}`)
    expect(await codeOf(guard.canActivate(context))).toBe('SESSION_EXPIRED')
    expect(users.findActiveById).toHaveBeenCalledWith(ALICE.id)
    expect(response.clearCookie).toHaveBeenCalled()
    expect(sessions.revoke).toHaveBeenCalledWith(SESSION.id, 'disabled')
    expect(sessions.keepAlive).not.toHaveBeenCalled()
    expect(sessions.invalidatedByRotation).not.toHaveBeenCalled()
  })

  it('有效：挂上当前用户、会话与派生的 CSRF 令牌，请求日志带上 userId', async () => {
    const token = generateSessionToken()
    const { guard, sessions } = setup({ session: SESSION, user: ALICE })
    const { context, request, logChild } = exchange(`theme=dark; nerve_session=${token}`)
    const requestLog = request.log
    expect(await guard.canActivate(context)).toBe(true)
    expect(sessions.authenticate).toHaveBeenCalledWith(token)
    expect(sessions.keepAlive).toHaveBeenCalledWith(SESSION)
    expect(sessions.revoke).not.toHaveBeenCalled()
    expect(sessions.invalidatedByRotation).not.toHaveBeenCalled()
    expect(principalOf(request)).toEqual({ user: ALICE, sessionId: SESSION.id, csrfToken: csrfTokenFor(token) })
    expect(requestUserId(request)).toBe(ALICE.id)
    expect(logChild).toHaveBeenCalledWith({ userId: ALICE.id })
    expect(request.log).not.toBe(requestLog)
  })

  it('只给系统管理员的接口：成员得到 PERMISSION_DENIED，系统管理员放行（M2-P1）', async () => {
    const token = generateSessionToken()
    expect(await codeOf(setup({ adminOnly: true, session: SESSION, user: ALICE }).guard.canActivate(exchange(`nerve_session=${token}`).context))).toBe('PERMISSION_DENIED')
    const admin: User = { ...ALICE, systemRole: 'admin' }
    expect(await setup({ adminOnly: true, session: SESSION, user: admin }).guard.canActivate(exchange(`nerve_session=${token}`).context)).toBe(true)
  })

  it('只给系统管理员的接口：没有登录时仍然先要求登录（UNAUTHENTICATED），不暴露它是管理接口', async () => {
    expect(await codeOf(setup({ adminOnly: true }).guard.canActivate(exchange().context))).toBe('UNAUTHENTICATED')
  })
})
