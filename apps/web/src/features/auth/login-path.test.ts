import { describe, expect, it } from 'vitest'
import { isLoginPage, loginPath, redirectTarget, safeRedirectPath } from './login-path.ts'

/** 登录页从地址栏读出的 from：URLSearchParams 会先解码，%09 成了真正的制表符 */
function fromParameter(query: string): string | null {
  return new URLSearchParams(query).get('from')
}

describe('登录页的地址', () => {
  it('带上登录后回到的地址与原因', () => {
    expect(loginPath(undefined)).toBe('/login')
    expect(loginPath('/')).toBe('/login')
    expect(loginPath('/documents?x=1')).toBe('/login?from=%2Fdocuments%3Fx%3D1')
    expect(loginPath('/', 'expired')).toBe('/login?reason=expired')
    expect(loginPath('//evil.example', 'expired')).toBe('/login?reason=expired')
  })

  it.each(['//evil.example', '/\\evil.example', '//[', 'https://evil.example', 'evil', '', '/login', '/login?from=/', '/LOGIN', '/login/'])('不安全的地址 %j 不带上，登录后去首页', (path) => {
    expect(safeRedirectPath(path)).toBeUndefined()
    expect(redirectTarget(path)).toBe('/')
    expect(loginPath(path)).toBe('/login')
  })

  // 浏览器解析地址时去掉制表符与换行：/<制表符>/evil.example 成了 //evil.example（审查 B5）
  it.each([
    'from=%2F%09%2Fevil.example',
    'from=/%09/evil.example',
    'from=/%0A/evil.example',
    'from=/%0D%0A/evil.example',
    'from=/%09%5Cevil.example',
    'from=%09/documents',
    'from=/documents%00',
    'from=/documents%20x',
    'from=/documents%E2%80%A8',
  ])('from 里有控制字符或空白（%s）：拒绝，登录后去首页', (query) => {
    const from = fromParameter(query)
    expect(from).not.toBeNull()
    expect(safeRedirectPath(from ?? '')).toBeUndefined()
    expect(redirectTarget(from)).toBe('/')
  })

  // 解析会去掉 . 与 .. 这样的路径段、把反斜杠换成斜杠：解析之后的路径以 // 开头，再被当作地址用就是另一个站点（复验 R1）
  it.each(['/.//evil.example', '/%2e//evil.example', '/x/..//evil.example', '/./\\evil.example', '/a/b/../..//evil.example/x?y=1'])('解析之后路径以 // 开头（%j）：拒绝，登录后去首页', (path) => {
    expect(safeRedirectPath(path)).toBeUndefined()
    expect(redirectTarget(path)).toBe('/')
    expect(loginPath(path)).toBe('/login')
  })

  it('站内的路径回去，用解析后的规范写法；编码过的字符留在路径里，仍是站内地址', () => {
    expect(redirectTarget('/documents')).toBe('/documents')
    expect(redirectTarget('/?view=list#top')).toBe('/?view=list#top')
    expect(redirectTarget('/a/../documents')).toBe('/documents')
    expect(redirectTarget(fromParameter('from=/%2509/evil'))).toBe('/%09/evil')
    expect(redirectTarget('/%2F%2Fevil.example')).toBe('/%2F%2Fevil.example')
    expect(redirectTarget('/login-help')).toBe('/login-help')
    expect(redirectTarget(null)).toBe('/')
  })

  it('登录页：不区分大小写，不管末尾的斜杠', () => {
    expect(isLoginPage('/login')).toBe(true)
    expect(isLoginPage('/Login/')).toBe(true)
    expect(isLoginPage('/login-help')).toBe(false)
    expect(isLoginPage('/')).toBe(false)
  })
})
