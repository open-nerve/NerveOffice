// 按需加载的页面的代码没能下载下来（M2-P6 复核 S6）：页头与导航留着，内容区说明"页面没能加载"、可以重试（整页重新加载）；
// 部署了新版本（入口页里的入口脚本变了）时整页重新加载一次，同一个版本不再重新加载。
// 搜索结果页的模块在这个文件里一律加载失败（相当于断网或者旧的分块已经不在）。
import type { SessionResponse } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { settle } from './admin.test-support.ts'
import { checkDeployment, ChunkLoadError, loadChunk, reloadOnceForDeployment } from './chunk-load.ts'
import { renderApp } from './render-app.test-support.tsx'

vi.mock('../features/search/index.ts', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/search-old.js')
})

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

/** 服务端现在的入口页：带着这些模块脚本 */
function entryPage(...scripts: readonly string[]): () => Response {
  return () => new Response(`<!doctype html><html><head>${scripts.map(src => `<script type="module" crossorigin src="${src}"></script>`).join('')}</head><body><div id="root"></div></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } })
}

function loggedIn(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    [documentsKey(SESSION)]: () => json(200, { items: [], nextCursor: null }),
    ...handlers,
  })
}

afterEach(() => {
  sessionStorage.clear()
})

describe('按需加载的页面没能下载下来（M2-P6 复核 S6）', () => {
  it('入口没变（临时没下载下来、断网之后恢复了）：页头与导航留着，内容区说明"页面没能加载，请检查网络后重试"、焦点在标题上；"重试"整页重新加载', async () => {
    loggedIn({ 'GET /': entryPage() })
    const app = renderApp('/search?q=周报')
    const heading = await screen.findByRole('heading', { level: 1, name: '页面没能加载' })
    expect(screen.getByText('请检查网络后重试。')).toBeInTheDocument()
    // 页框还在：可以去别处
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: '空间' })).getByRole('link', { name: '我的空间' })).toBeInTheDocument()
    expect(screen.queryByText(/请求标识/)).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(document.title).toBe('页面没能加载 - NerveOffice')
    expect(app.page.visits).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(app.page.visits).toEqual(['reload'])
  })

  it('连服务端都连不上（断网）：同样说明，不自动重新加载（那样只会换成浏览器的断网页）', async () => {
    // 不登记 GET /：假的 fetch 失败，相当于连不上
    loggedIn()
    const app = renderApp('/search?q=周报')
    expect(await screen.findByRole('heading', { level: 1, name: '页面没能加载' })).toBeInTheDocument()
    await settle()
    expect(app.page.visits).toEqual([])
  })

  it('部署了新版本（入口脚本变了，旧的分块已经不在）：整页重新加载一次；同一个版本再失败时不再重新加载，说明并可以重试', async () => {
    loggedIn({ 'GET /': entryPage('/assets/index-new.js') })
    const first = renderApp('/search?q=周报')
    await waitFor(() => expect(first.page.visits).toEqual(['reload']))

    // 重新加载之后（同一个标签页）还是失败：不再重新加载，免得来回循环
    first.dispose()
    const second = renderApp('/search?q=周报')
    expect(await screen.findAllByRole('heading', { level: 1, name: '页面没能加载' })).not.toHaveLength(0)
    await settle()
    expect(second.page.visits).toEqual([])
  })
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
