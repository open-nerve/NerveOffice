import type { ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import type { AppConfig } from '../config/index.ts'
import type { Principal } from './principal.ts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { CsrfGuard } from './csrf.guard.ts'
import { attachPrincipal } from './principal.ts'
import { csrfTokenFor, generateSessionToken } from './session-token.ts'

const PUBLIC_ORIGIN = 'https://docs.example.com'
const guard = new CsrfGuard({ http: { publicOrigin: PUBLIC_ORIGIN } } as unknown as AppConfig)

function requestOf(method: string, headers: Record<string, string | string[]> = {}, principal?: Principal): Request {
  const request = { method, headers } as unknown as Request
  if (principal !== undefined)
    attachPrincipal(request, principal)
  return request
}

function contextOf(request: Request): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext
}

function codeOf(request: Request): string | undefined {
  try {
    guard.canActivate(contextOf(request))
    return undefined
  }
  catch (error) {
    if (error instanceof AppError)
      return error.code
    throw error
  }
}

const token = generateSessionToken()
const principal: Principal = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', username: 'alice', displayName: '爱丽丝', systemRole: 'member', status: 'active' },
  sessionId: '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f',
  csrfToken: csrfTokenFor(token),
}

describe('CsrfGuard', () => {
  it('安全的方法不检查（没有 Origin 也放行）', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS'])
      expect(codeOf(requestOf(method, {}, principal)), method).toBeUndefined()
  })

  it('状态变更的请求：Origin 缺少、不是本站、写法不同都拒绝', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(codeOf(requestOf(method)), method).toBe('ORIGIN_NOT_ALLOWED')
      for (const origin of ['https://evil.example', 'null', 'https://docs.example.com.evil.example', 'http://docs.example.com', `${PUBLIC_ORIGIN}/`])
        expect(codeOf(requestOf(method, { origin })), `${method} ${origin}`).toBe('ORIGIN_NOT_ALLOWED')
    }
  })

  it('公开的接口（没有登录，例如登录本身）：只查 Origin', () => {
    expect(codeOf(requestOf('POST', { origin: PUBLIC_ORIGIN }))).toBeUndefined()
  })

  it('需要登录的接口：还要带上由会话令牌派生的 CSRF 令牌', () => {
    expect(codeOf(requestOf('POST', { 'origin': PUBLIC_ORIGIN, 'x-csrf-token': principal.csrfToken }, principal))).toBeUndefined()
    expect(codeOf(requestOf('DELETE', { origin: PUBLIC_ORIGIN }, principal))).toBe('CSRF_TOKEN_INVALID')
    expect(codeOf(requestOf('POST', { 'origin': PUBLIC_ORIGIN, 'x-csrf-token': csrfTokenFor(generateSessionToken()) }, principal))).toBe('CSRF_TOKEN_INVALID')
    expect(codeOf(requestOf('POST', { 'origin': PUBLIC_ORIGIN, 'x-csrf-token': '' }, principal))).toBe('CSRF_TOKEN_INVALID')
    // 会话令牌本身不是 CSRF 令牌
    expect(codeOf(requestOf('POST', { 'origin': PUBLIC_ORIGIN, 'x-csrf-token': token }, principal))).toBe('CSRF_TOKEN_INVALID')
    // 同名的请求头出现多次时 Node 给出数组：一律拒绝
    expect(codeOf(requestOf('POST', { 'origin': PUBLIC_ORIGIN, 'x-csrf-token': [principal.csrfToken, principal.csrfToken] }, principal))).toBe('CSRF_TOKEN_INVALID')
  })

  it('Origin 先于 CSRF 令牌检查：跨站请求一律是 ORIGIN_NOT_ALLOWED', () => {
    expect(codeOf(requestOf('POST', { 'origin': 'https://evil.example', 'x-csrf-token': principal.csrfToken }, principal))).toBe('ORIGIN_NOT_ALLOWED')
  })
})
