import { describe, expect, it } from 'vitest'
import { isSafeRedirect, loginPath, redirectTarget } from './login-path.ts'

describe('登录页的地址', () => {
  it('带上登录后回到的地址与原因', () => {
    expect(loginPath(undefined)).toBe('/login')
    expect(loginPath('/')).toBe('/login')
    expect(loginPath('/documents?x=1')).toBe('/login?from=%2Fdocuments%3Fx%3D1')
    expect(loginPath('/', 'expired')).toBe('/login?reason=expired')
  })

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example', 'evil', '/login', '/login?from=/'])('不安全的地址 %s 不带上，登录后去首页', (path) => {
    expect(isSafeRedirect(path)).toBe(false)
    expect(redirectTarget(path)).toBe('/')
  })

  it('站内的路径原样回去', () => {
    expect(redirectTarget('/documents')).toBe('/documents')
    expect(redirectTarget(null)).toBe('/')
  })
})
