// E2E 的页面错误里哪些是浏览器的通知（page-errors.ts）：排除的写法要严格，别的页面错误一律算错误；按浏览器上下文收集的接线。
// WebKit 的取消加载靠时机，E2E 里构造不稳（2026-10-02 CI 上 20 次跳转一次也没碰上），所以用 CI 日志里的原文在这里核对。
import type { BrowserContext, WebError } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { isBrowserNotice, watchPageErrors } from './page-errors.ts'

const PAGE = 'http://127.0.0.1:41997/documents/01a0fb60-a504-7c95-8bdf-8aeaec893aaf'

/** WebKit 控制台里的这句，按 Playwright（WebKit）的拆法拆成名称与说明：在第一个冒号处拆开、再跳过两个字符 */
function asPageError(text: string): { name: string, message: string } {
  const separator = text.indexOf(':')
  return { name: text.slice(0, separator), message: text.slice(separator + 2) }
}

/** 2026-10-02 CI 的 WebKit 上原样出现过的两种（地址换成这里的页面同源） */
const CI_FETCH = 'Fetch API cannot load http://127.0.0.1:41997/api/documents/01a0fb60-a504-7c95-8bdf-8aeaec893aaf due to access control checks.'
const CI_WORKER = 'Cannot load http://127.0.0.1:41997/assets/formula.worker-BJbyZyJk.js due to access control checks.'

describe('E2E 的页面错误：浏览器的通知', () => {
  it('WebKit 在整页跳转时取消同源加载的诊断：fetch 的"Fetch API cannot load"与子资源的"Cannot load"都排除', () => {
    expect(isBrowserNotice(asPageError(CI_FETCH), PAGE)).toBe(true)
    expect(isBrowserNotice(asPageError(CI_WORKER), PAGE)).toBe(true)
    expect(isBrowserNotice(asPageError('Fetch API cannot load http://127.0.0.1:41997/api/auth/session due to access control checks.'), 'http://127.0.0.1:41997/')).toBe(true)
    expect(isBrowserNotice(asPageError('Fetch API cannot load https://localhost:8443/api/search?q=a due to access control checks.'), 'https://localhost:8443/search')).toBe(true)
  })

  it('别的源（主机、端口、协议不同）、不知道页面的地址：不排除', () => {
    const otherPort = CI_FETCH.replace(':41997', ':9999')
    expect(isBrowserNotice(asPageError(otherPort), PAGE)).toBe(false)
    expect(isBrowserNotice(asPageError(CI_WORKER.replace('127.0.0.1:41997', 'evil.example')), PAGE)).toBe(false)
    expect(isBrowserNotice(asPageError(CI_FETCH.replace('http:', 'https:')), PAGE)).toBe(false)
    expect(isBrowserNotice(asPageError(CI_FETCH), undefined)).toBe(false)
    expect(isBrowserNotice(asPageError(CI_FETCH), 'about:blank')).toBe(false)
  })

  it('应用里真正没接住的拒绝（WebKit 带"Unhandled Promise Rejection"）、别的加载器、说法不同的：不排除', () => {
    expect(isBrowserNotice(asPageError(`Unhandled Promise Rejection: TypeError: ${CI_FETCH}`), PAGE)).toBe(false)
    expect(isBrowserNotice(asPageError(CI_FETCH.replace('Fetch API', 'Something')), PAGE)).toBe(false)
    expect(isBrowserNotice(asPageError(CI_FETCH.replace('access control checks.', 'a network error.')), PAGE)).toBe(false)
    expect(isBrowserNotice(asPageError(`${CI_WORKER} Extra`), PAGE)).toBe(false)
    expect(isBrowserNotice({ name: 'TypeError', message: 'Load failed' }, PAGE)).toBe(false)
  })

  it('ResizeObserver 的通知照旧排除（与页面的地址无关），说法不同的不排除', () => {
    expect(isBrowserNotice({ name: '', message: 'ResizeObserver loop completed with undelivered notifications.' }, undefined)).toBe(true)
    expect(isBrowserNotice({ name: '', message: 'ResizeObserver loop limit exceeded' }, PAGE)).toBe(true)
    expect(isBrowserNotice({ name: 'Error', message: 'ResizeObserver loop limit exceeded in our code' }, PAGE)).toBe(false)
  })
})

describe('E2E 的页面错误：按浏览器上下文收集的接线', () => {
  /** 假的浏览器上下文：记下 weberror 的监听，测试里逐条交给它 */
  function fakeContext(): { readonly context: Pick<BrowserContext, 'on'>, readonly emit: (error: { name: string, message: string }, pageUrl: string | null) => void } {
    let listener: ((webError: WebError) => void) | undefined
    const context = {
      on: (event: string, handler: (webError: WebError) => void) => {
        expect(event).toBe('weberror')
        listener = handler
      },
    } as unknown as Pick<BrowserContext, 'on'>
    const emit = (error: { name: string, message: string }, pageUrl: string | null): void => {
      const thrown = Object.assign(new Error(error.message), { name: error.name })
      listener?.({ error: () => thrown, page: () => (pageUrl === null ? null : { url: () => pageUrl }) } as unknown as WebError)
    }
    return { context, emit }
  }

  it('浏览器的通知交给 ignore、别的交给 report，都带报告时页面的地址；判断同源用的就是这个地址', () => {
    const { context, emit } = fakeContext()
    const reported: string[] = []
    const ignored: string[] = []
    watchPageErrors(context, error => reported.push(error), notice => ignored.push(notice))
    emit(asPageError(CI_WORKER), PAGE)
    emit(asPageError(CI_FETCH), 'http://127.0.0.1:9999/')
    emit({ name: 'TypeError', message: '应用的错误' }, PAGE)
    expect(ignored).toEqual([`Cannot load http: /127.0.0.1:41997/assets/formula.worker-BJbyZyJk.js due to access control checks.（${PAGE}）`])
    expect(reported).toEqual([
      'Fetch API cannot load http: /127.0.0.1:41997/api/documents/01a0fb60-a504-7c95-8bdf-8aeaec893aaf due to access control checks.（http://127.0.0.1:9999/）',
      `TypeError: 应用的错误（${PAGE}）`,
    ])
  })

  it('页面已经关了（不知道地址）：取消加载的诊断也交给 report', () => {
    const { context, emit } = fakeContext()
    const reported: string[] = []
    watchPageErrors(context, error => reported.push(error), () => {})
    emit(asPageError(CI_FETCH), null)
    expect(reported).toEqual(['Fetch API cannot load http: /127.0.0.1:41997/api/documents/01a0fb60-a504-7c95-8bdf-8aeaec893aaf due to access control checks.（页面已关闭）'])
  })
})
