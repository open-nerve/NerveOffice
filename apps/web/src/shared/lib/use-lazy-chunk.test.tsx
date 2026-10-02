// 组件级的按需加载（M2-P5 S3）：点了入口才下载；下载中只下载一次；下载好了直接给出；没能下载下来时判断原因（与路由级共用），
// 不自动整页重新加载（不给 onDeployed）；卸载之后不再更新。入口上的说明见 app/sharing-chunk.test.tsx。
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { installFakeApi } from '../testing/fake-api.test-support.ts'
import { useLazyChunk } from './use-lazy-chunk.ts'

/** 服务端现在的入口页：带着这些模块脚本 */
function entryPage(...scripts: readonly string[]): () => Response {
  return () => new Response(`<!doctype html><html><head>${scripts.map(src => `<script type="module" src="${src}"></script>`).join('')}</head></html>`, { status: 200, headers: { 'content-type': 'text/html' } })
}

function currentScripts(...scripts: readonly string[]): void {
  document.head.innerHTML = scripts.map(src => `<script type="module" src="${src}"></script>`).join('')
  onTestFinished(() => {
    document.head.innerHTML = ''
  })
}

describe('useLazyChunk', () => {
  it('还没点：什么也不下载；点了之后下载中，好了给出模块；再要直接给出，不再下载', async () => {
    const importer = vi.fn(async () => ({ feature: '分享' }))
    const { result } = renderHook(() => useLazyChunk(importer))
    expect(result.current.chunk).toEqual({ state: 'idle' })
    expect(importer).not.toHaveBeenCalled()
    let loaded: unknown
    await act(async () => {
      loaded = await result.current.load()
    })
    expect(loaded).toEqual({ feature: '分享' })
    expect(result.current.chunk).toEqual({ state: 'ready', module: { feature: '分享' } })
    await act(async () => {
      await result.current.load()
    })
    expect(importer).toHaveBeenCalledTimes(1)
  })

  it('下载中再点：等同一次，不重复下载', async () => {
    let finish: (module: { readonly ok: true }) => void = () => {}
    const importer = vi.fn(async () => new Promise<{ readonly ok: true }>((resolve) => {
      finish = resolve
    }))
    const { result } = renderHook(() => useLazyChunk(importer))
    let first: Promise<unknown> = Promise.resolve()
    let second: Promise<unknown> = Promise.resolve()
    act(() => {
      first = result.current.load()
      second = result.current.load()
    })
    expect(result.current.chunk).toEqual({ state: 'loading' })
    finish({ ok: true })
    await act(async () => {
      await Promise.all([first, second])
    })
    expect(importer).toHaveBeenCalledTimes(1)
  })

  it('没能下载下来：先是"还在判断原因"，再给出原因；部署了新版本时不自动整页重新加载（说明已部署新版本）', async () => {
    currentScripts('/assets/index-old.js')
    let answer: (response: Response) => void = () => {}
    installFakeApi({ 'GET /': async () => new Promise<Response>((resolve) => {
      answer = resolve
    }) })
    const { result } = renderHook(() => useLazyChunk(async () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))))
    let loaded: unknown = 'not yet'
    act(() => {
      void result.current.load().then((module) => {
        loaded = module
      })
    })
    await waitFor(() => expect(result.current.chunk).toEqual({ state: 'failed', problem: undefined }))
    answer(entryPage('/assets/index-new.js')())
    await waitFor(() => expect(result.current.chunk).toEqual({ state: 'failed', problem: 'updated' }))
    expect(loaded).toBeUndefined()
    // 没有为这个版本整页重新加载（路由级的做法会记下为哪个版本重新加载过）
    expect(sessionStorage.length).toBe(0)
  })

  it('连不上服务器是 offline；失败之后再点会重新下载一次（有的浏览器记住了失败的模块，说明里的"重试"另外整页重新加载）', async () => {
    installFakeApi({})
    const importer = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')))
    const { result } = renderHook(() => useLazyChunk(importer))
    await act(async () => {
      await result.current.load()
    })
    expect(result.current.chunk).toEqual({ state: 'failed', problem: 'offline' })
    await act(async () => {
      await result.current.load()
    })
    expect(importer).toHaveBeenCalledTimes(2)
  })

  it('下载期间入口已经卸载：之后不再更新状态（不报错）', async () => {
    let finish: (module: { readonly ok: true }) => void = () => {}
    const { result, unmount } = renderHook(() => useLazyChunk(async () => new Promise<{ readonly ok: true }>((resolve) => {
      finish = resolve
    })))
    let loading: Promise<unknown> = Promise.resolve()
    act(() => {
      loading = result.current.load()
    })
    unmount()
    finish({ ok: true })
    await expect(loading).resolves.toEqual({ ok: true })
  })
})
