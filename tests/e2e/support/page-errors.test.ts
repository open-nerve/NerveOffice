// E2E 的页面错误里哪些是浏览器的通知（page-errors.ts）：排除的写法要严格，别的页面错误一律算错误。
// 真实的浏览器里的行为由 specs/foundation/page-errors.spec.ts 核对，这里核对写法的边界。
import { describe, expect, it } from 'vitest'
import { isBrowserNotice } from './page-errors.ts'

const PAGE = 'http://127.0.0.1:53785/documents/0199a2c4-0000-7000-8000-000000000001'

/** WebKit 控制台里的这句，按 Playwright（WebKit）的拆法拆成名称与说明：在第一个冒号处拆开、再跳过两个字符 */
function asPageError(text: string): { name: string, message: string } {
  const separator = text.indexOf(':')
  return { name: text.slice(0, separator), message: text.slice(separator + 2) }
}

function cancelledFetch(url: string): { name: string, message: string } {
  return asPageError(`Fetch API cannot load ${url} due to access control checks.`)
}

describe('E2E 的页面错误：浏览器的通知', () => {
  it('WebKit 在整页跳转时取消同源请求的诊断：排除（地址可以带查询串）', () => {
    expect(isBrowserNotice(cancelledFetch('http://127.0.0.1:53785/api/auth/session'), PAGE)).toBe(true)
    expect(isBrowserNotice(cancelledFetch('http://127.0.0.1:53785/api/documents/x/content'), 'http://127.0.0.1:53785/')).toBe(true)
    expect(isBrowserNotice(cancelledFetch('https://localhost:8443/api/search?q=a'), 'https://localhost:8443/search')).toBe(true)
  })

  it('别的源（主机、端口、协议不同）、不知道页面的地址：不排除', () => {
    expect(isBrowserNotice(cancelledFetch('http://127.0.0.1:9999/api/auth/session'), PAGE)).toBe(false)
    expect(isBrowserNotice(cancelledFetch('http://evil.example/api/auth/session'), PAGE)).toBe(false)
    expect(isBrowserNotice(cancelledFetch('https://127.0.0.1:53785/api/auth/session'), PAGE)).toBe(false)
    expect(isBrowserNotice(cancelledFetch('http://127.0.0.1:53785/api/auth/session'), undefined)).toBe(false)
    expect(isBrowserNotice(cancelledFetch('http://127.0.0.1:53785/api/auth/session'), 'about:blank')).toBe(false)
  })

  it('应用里真正没接住的拒绝（WebKit 带"Unhandled Promise Rejection"）、说法不同的：不排除', () => {
    const unhandled = asPageError('Unhandled Promise Rejection: TypeError: Fetch API cannot load http://127.0.0.1:53785/api/x due to access control checks.')
    expect(isBrowserNotice(unhandled, PAGE)).toBe(false)
    expect(isBrowserNotice(asPageError('Fetch API cannot load http://127.0.0.1:53785/api/x due to a network error.'), PAGE)).toBe(false)
    expect(isBrowserNotice(asPageError('Fetch API cannot load http://127.0.0.1:53785/api/x due to access control checks. Extra'), PAGE)).toBe(false)
    expect(isBrowserNotice({ name: 'TypeError', message: 'Load failed' }, PAGE)).toBe(false)
  })

  it('ResizeObserver 的通知照旧排除（与页面的地址无关），说法不同的不排除', () => {
    expect(isBrowserNotice({ name: '', message: 'ResizeObserver loop completed with undelivered notifications.' }, undefined)).toBe(true)
    expect(isBrowserNotice({ name: '', message: 'ResizeObserver loop limit exceeded' }, PAGE)).toBe(true)
    expect(isBrowserNotice({ name: 'Error', message: 'ResizeObserver loop limit exceeded in our code' }, PAGE)).toBe(false)
  })
})
