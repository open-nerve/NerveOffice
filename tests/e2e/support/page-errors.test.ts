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
/** 2026-10-15 WebKit：平台页导航取消 OPFS File.arrayBuffer()，应用已有 catch，浏览器仍报告内部 Blob 的取消。 */
const OPFS_BLOB = 'Cannot load blob:http://127.0.0.1:41997/2bc74b73-be6b-4af9-be35-08b8b144ab47 due to access control checks.'

describe('E2E 的页面错误：浏览器的通知', () => {
  it('WebKit 导航取消同源 OPFS Blob 读取的原始诊断：只识别严格的 HTTP(S) 同源对象地址', () => {
    expect(isBrowserNotice(asPageError(OPFS_BLOB), PAGE)).toBe(true)
    expect(isBrowserNotice(asPageError(OPFS_BLOB.replace('http://127.0.0.1:41997', 'https://localhost:8443')), 'https://localhost:8443/')).toBe(true)
  })

  it('Blob 的异源、未知来源、畸形地址、其它加载器和真实拒绝仍算错误', () => {
    for (const text of [
      OPFS_BLOB.replace(':41997', ':9999'),
      OPFS_BLOB.replace('127.0.0.1:41997', 'evil.example'),
      OPFS_BLOB.replace('blob:http:', 'blob:https:'),
      OPFS_BLOB.replace('blob:http://127.0.0.1:41997', 'blob:null'),
      OPFS_BLOB.replace('/2bc74b73-be6b-4af9-be35-08b8b144ab47', '/not-an-object-url'),
      OPFS_BLOB.replace('127.0.0.1:41997', 'user@127.0.0.1:41997'),
      OPFS_BLOB.replace(' due to', '?query=1 due to'),
      OPFS_BLOB.replace(' due to', '#fragment due to'),
      OPFS_BLOB.replace('Cannot load', 'Fetch API cannot load'),
      OPFS_BLOB.replace('access control checks.', 'a network error.'),
      `${OPFS_BLOB} Extra`,
      `Unhandled Promise Rejection: TypeError: ${OPFS_BLOB}`,
    ]) {
      expect(isBrowserNotice(asPageError(text), PAGE), text).toBe(false)
    }
    expect(isBrowserNotice(asPageError(OPFS_BLOB), undefined)).toBe(false)
    expect(isBrowserNotice(asPageError(OPFS_BLOB), 'about:blank')).toBe(false)
    expect(isBrowserNotice(asPageError(OPFS_BLOB), `blob:${PAGE}`)).toBe(false)
    expect(isBrowserNotice({ name: 'TypeError', message: OPFS_BLOB }, PAGE)).toBe(false)
  })

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

  it('同源 Blob 浏览器通知原文保留，真正没接住的拒绝仍交给 report', () => {
    const { context, emit } = fakeContext()
    const reported: string[] = []
    const ignored: string[] = []
    watchPageErrors(context, error => reported.push(error), notice => ignored.push(notice))
    emit(asPageError(OPFS_BLOB), PAGE)
    emit(asPageError(`Unhandled Promise Rejection: TypeError: ${OPFS_BLOB}`), PAGE)
    expect(ignored).toEqual([`Cannot load blob: ttp://127.0.0.1:41997/2bc74b73-be6b-4af9-be35-08b8b144ab47 due to access control checks.（${PAGE}）`])
    expect(reported).toEqual([`Unhandled Promise Rejection: TypeError: ${OPFS_BLOB}（${PAGE}）`])
  })
})
