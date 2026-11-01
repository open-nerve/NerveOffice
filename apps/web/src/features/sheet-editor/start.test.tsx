import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSheetEditorPage } from './start.tsx'

const h = vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
  return { load: vi.fn(async () => {}), dispose: vi.fn(), stopConnection: vi.fn(), stopGuards: vi.fn(), stopMaintenance: vi.fn(), create: vi.fn() }
})
vi.mock('./editor-page.ts', () => ({ createEditorPage: (options: unknown) => {
  h.create(options)
  return { load: h.load, dispose: h.dispose }
} }))
vi.mock('./editor-chrome.tsx', () => ({ EditorChrome: () => <p>正式页头</p> }))
vi.mock('../local-data/notice.ts', () => ({ LocalDataNotice: () => null }))
vi.mock('../../shared/lib/draft-maintenance.ts', () => ({ startDraftMaintenance: () => h.stopMaintenance }))
vi.mock('../../shared/lib/browser-connection.ts', () => ({ watchBrowserConnection: () => h.stopConnection }))
vi.mock('./page-guards.ts', () => ({ installPageGuards: () => h.stopGuards, isApplePlatform: () => false }))
vi.mock('../../shared/lib/session-channel.ts', () => ({ openSessionChannel: () => ({}) }))

afterEach(() => vi.clearAllMocks())

describe('正式编辑器页的可释放挂载', () => {
  it('页头可放子容器，交互屏障仍拿完整 chrome；卸载只清本挂载', async () => {
    const chrome = document.createElement('header')
    const flow = document.createElement('div')
    flow.textContent = '创建状态'
    const heading = document.createElement('div')
    chrome.append(flow, heading)
    const surface = document.createElement('div')
    const mounted = await act(async () => startSheetEditorPage({ chrome, surface, heading }))
    expect(mounted).toBeDefined()
    await mounted?.loaded
    expect(chrome.textContent).toBe('创建状态正式页头')
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({ chrome, surface })
    expect(h.load).toHaveBeenCalledOnce()
    act(() => mounted?.dispose())
    act(() => mounted?.dispose())
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.stopGuards).toHaveBeenCalledOnce()
    expect(h.stopConnection).toHaveBeenCalledOnce()
    expect(h.stopMaintenance).toHaveBeenCalledOnce()
    expect(chrome.textContent).toBe('创建状态')
  })

  it('pagehide 保留正式页自己的在途保存处理，不能抢先普通 dispose', async () => {
    const chrome = document.createElement('header')
    const surface = document.createElement('div')
    const onHide = vi.fn()
    h.load.mockImplementationOnce(async () => {
      window.addEventListener('pagehide', onHide)
    })
    h.dispose.mockImplementationOnce(() => window.removeEventListener('pagehide', onHide))
    const mounted = await act(async () => startSheetEditorPage({ chrome, surface }))
    await mounted?.loaded
    try {
      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })
      expect(onHide).toHaveBeenCalledOnce()
      expect(h.dispose).not.toHaveBeenCalled()
    }
    finally {
      window.removeEventListener('pagehide', onHide)
      act(() => mounted?.dispose())
    }
  })

  it('普通入口沿用完整 chrome 并保留同一加载结果', async () => {
    const chrome = document.createElement('header')
    const surface = document.createElement('div')
    const mounted = await act(async () => startSheetEditorPage({ chrome, surface }))
    await mounted?.loaded
    expect(chrome.textContent).toBe('正式页头')
    expect(h.load).toHaveBeenCalledOnce()
    act(() => mounted?.dispose())
  })
})
