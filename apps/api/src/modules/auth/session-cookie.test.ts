import type { Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { SessionCookieSettings } from './session-cookie.ts'
import { generateSessionToken } from './session-token.ts'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function fakeResponse() {
  return { cookie: vi.fn(), clearCookie: vi.fn() }
}

describe('SessionCookieSettings', () => {
  it('HTTPS：__Host- 前缀，HttpOnly、Secure、SameSite=Lax、Path=/，Max-Age 取绝对过期', () => {
    const settings = new SessionCookieSettings('https://docs.example.com', WEEK_MS)
    const response = fakeResponse()
    settings.write(response as unknown as Response, 'token')
    expect(response.cookie).toHaveBeenCalledWith('__Host-nerve_session', 'token', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: WEEK_MS })
  })

  it('本机调试的 HTTP：不带 Secure，名称没有前缀', () => {
    const settings = new SessionCookieSettings('http://127.0.0.1:5173', WEEK_MS)
    const response = fakeResponse()
    settings.write(response as unknown as Response, 'token')
    expect(response.cookie).toHaveBeenCalledWith('nerve_session', 'token', expect.objectContaining({ secure: false, httpOnly: true }))
  })

  it('清除时带同样的属性（浏览器按名称与属性匹配要删的 Cookie）', () => {
    const settings = new SessionCookieSettings('https://docs.example.com', WEEK_MS)
    const response = fakeResponse()
    settings.clear(response as unknown as Response)
    expect(response.clearCookie).toHaveBeenCalledWith('__Host-nerve_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
  })

  it('从 Cookie 头里读取：只认自己的名称与合法的令牌', () => {
    const settings = new SessionCookieSettings('https://docs.example.com', WEEK_MS)
    const token = generateSessionToken()
    expect(settings.read(`theme=dark; __Host-nerve_session=${token}; lang=zh`)).toBe(token)
    expect(settings.read(`nerve_session=${token}`)).toBeUndefined()
    expect(settings.read('__Host-nerve_session=not-a-token')).toBeUndefined()
    expect(settings.read(undefined)).toBeUndefined()
    expect(settings.isPresent('__Host-nerve_session=not-a-token')).toBe(true)
    expect(settings.isPresent('theme=dark')).toBe(false)
  })
})
