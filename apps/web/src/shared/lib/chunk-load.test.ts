// 按需加载的代码没能下载下来（M2-P6 复核 S6；M2-P5 S3 从 app/ 挪到 shared/lib，组件级的按需加载也用）：下载的包装、
// 部署检测（入口页里的入口脚本变没变）、只为同一个版本重新加载一次，以及据此判断原因（diagnoseChunkLoad，路由级与组件级共用）。
// 路由级的界面见 app/route-chunk.test.tsx，组件级的见 shared/lib/use-lazy-chunk.test.tsx。
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { installFakeApi } from '../testing/fake-api.test-support.ts'
import { checkDeployment, ChunkLoadError, DEPLOYMENT_CHECK_TIMEOUT_MS, diagnoseChunkLoad, loadChunk, reloadOnceForDeployment } from './chunk-load.ts'

/** 服务端现在的入口页：带着这些模块脚本 */
function entryPage(...scripts: readonly string[]): () => Response {
  return () => new Response(`<!doctype html><html><head>${scripts.map(src => `<script type="module" crossorigin src="${src}"></script>`).join('')}</head><body><div id="root"></div></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } })
}

afterEach(() => {
  sessionStorage.clear()
})

describe('chunk-load 的各个部分', () => {
  it('loadChunk：成功原样给出；失败换成 ChunkLoadError，原因挂在 cause 上', async () => {
    await expect(loadChunk(async () => 42)).resolves.toBe(42)
    const cause = new TypeError('Failed to fetch dynamically imported module')
    const error = await loadChunk(async () => Promise.reject(cause)).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ChunkLoadError)
    expect((error as ChunkLoadError).cause).toBe(cause)
  })

  it('checkDeployment：入口页的模块脚本与当前页面的比较；入口页取不到（非 2xx、断网）是 unreachable', async () => {
    const current = document.implementation.createHTMLDocument('当前')
    current.head.innerHTML = '<script type="module" src="/assets/index-a.js"></script>'
    installFakeApi({ 'GET /': entryPage('/assets/index-a.js') })
    expect(await checkDeployment(current)).toEqual({ kind: 'same' })
    installFakeApi({ 'GET /': entryPage('/assets/index-b.js') })
    expect(await checkDeployment(current)).toEqual({ kind: 'deployed', version: '/assets/index-b.js' })
    installFakeApi({ 'GET /': () => new Response('', { status: 502 }) })
    expect(await checkDeployment(current)).toEqual({ kind: 'unreachable' })
    installFakeApi({})
    expect(await checkDeployment(current)).toEqual({ kind: 'unreachable' })
  })

  it('checkDeployment：取回来的页面里没有模块脚本（代理或认证网关自己的 200 页面）不是部署了新版本，按连不上处理，不去整页重新加载（第二批 S-2 的 C2）', async () => {
    const current = document.implementation.createHTMLDocument('当前')
    current.head.innerHTML = '<script type="module" src="/assets/index-a.js"></script>'
    installFakeApi({ 'GET /': () => new Response('<!doctype html><html><body><h1>请先登录公司网络</h1></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) })
    expect(await checkDeployment(current)).toEqual({ kind: 'unreachable' })
  })

  it('checkDeployment：服务端挂起时不一直等，到了时限按连不上处理（第二批 G-4）', async () => {
    const current = document.implementation.createHTMLDocument('当前')
    current.head.innerHTML = '<script type="module" src="/assets/index-a.js"></script>'
    let aborted = false
    // 像真的 fetch 一样：请求被取消（signal）时以 AbortError 失败；否则一直不回来
    installFakeApi({
      'GET /': async init => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('请求被取消', 'AbortError'))
        })
      }),
    })
    expect(await checkDeployment(current, 20)).toEqual({ kind: 'unreachable' })
    expect(aborted).toBe(true)
    expect(DEPLOYMENT_CHECK_TIMEOUT_MS).toBe(10_000)
  })

  it('reloadOnceForDeployment：同一个版本只重新加载一次；存不进 sessionStorage 时不重新加载', () => {
    const reload = vi.fn()
    expect(reloadOnceForDeployment('v2', reload)).toBe(true)
    expect(reloadOnceForDeployment('v2', reload)).toBe(false)
    expect(reloadOnceForDeployment('v3', reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(reloadOnceForDeployment('v4', reload)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(2)
    setItem.mockRestore()
  })
})

describe('diagnoseChunkLoad：判断原因（路由级与组件级共用）', () => {
  function currentScripts(...scripts: readonly string[]): void {
    document.head.innerHTML = scripts.map(src => `<script type="module" src="${src}"></script>`).join('')
    onTestFinished(() => {
      document.head.innerHTML = ''
    })
  }

  it('连不上服务器是 offline；服务器连得上、版本也没变是 missing', async () => {
    currentScripts('/assets/index-a.js')
    installFakeApi({})
    expect(await diagnoseChunkLoad()).toBe('offline')
    installFakeApi({ 'GET /': entryPage('/assets/index-a.js') })
    expect(await diagnoseChunkLoad()).toBe('missing')
  })

  it('部署了新版本：没给 onDeployed（组件级，不自动整页重新加载）是 updated', async () => {
    currentScripts('/assets/index-a.js')
    installFakeApi({ 'GET /': entryPage('/assets/index-b.js') })
    expect(await diagnoseChunkLoad()).toBe('updated')
  })

  it('部署了新版本：onDeployed 发起了重新加载时不必说明（undefined）；没能发起时是 updated', async () => {
    currentScripts('/assets/index-a.js')
    installFakeApi({ 'GET /': entryPage('/assets/index-b.js') })
    const reload = vi.fn()
    expect(await diagnoseChunkLoad(version => reloadOnceForDeployment(version, reload))).toBeUndefined()
    expect(reload).toHaveBeenCalledTimes(1)
    // 同一个版本再失败：不再重新加载，说明服务器上已是新版本
    expect(await diagnoseChunkLoad(version => reloadOnceForDeployment(version, reload))).toBe('updated')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
