import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from './editing-session.test-support.ts'
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
vi.mock('../../editor/testing/autosave-control.ts', () => ({ installAutosaveControl: () => undefined }))
vi.mock('../../editor/testing/handover-log.ts', () => ({ installHandoverLog: () => ({ observe: undefined }) }))

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.doUnmock('./selftest-hook.ts')
  window.history.replaceState(null, '', '/')
})

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

  it.each(['dispose', 'pagehide'] as const)('selftest 模块晚到：先 %s 后不安装 hook、不载入旧页', async (leave) => {
    vi.stubEnv('MODE', 'e2e')
    window.history.replaceState(null, '', '/documents/01a0fb60-a504-7c95-8bdf-8aeaec893aaf?selftest=read-only')
    const module = deferred<{ watchForSelftest: () => void }>()
    const watchForSelftest = vi.fn()
    vi.doMock('./selftest-hook.ts', async () => module.promise)
    const chrome = document.createElement('header')
    const mounted = await act(async () => startSheetEditorPage({ chrome, surface: document.createElement('div') }))
    try {
      expect(mounted).toBeDefined()
      expect(h.load).not.toHaveBeenCalled()
      act(() => {
        if (leave === 'dispose')
          mounted?.dispose()
        else
          window.dispatchEvent(new Event('pagehide'))
      })
      await act(async () => {
        module.resolve({ watchForSelftest })
        await mounted?.loaded
      })
      expect(watchForSelftest).not.toHaveBeenCalled()
      expect(h.load).not.toHaveBeenCalled()
      expect(h.dispose).toHaveBeenCalledOnce()
      expect(h.stopConnection).toHaveBeenCalledOnce()
      expect(chrome.textContent).toBe('')
    }
    finally {
      module.resolve({ watchForSelftest })
      await mounted?.loaded
      act(() => mounted?.dispose())
    }
  })

  it('hook 的异步准备尚未完成时 pagehide 取消本挂载，晚到完成不触发 load', async () => {
    vi.stubEnv('MODE', 'e2e')
    window.history.replaceState(null, '', '/documents/01a0fb60-a504-7c95-8bdf-8aeaec893aaf?selftest=read-only')
    const preparation = deferred<void>()
    const entered = deferred<void>()
    let signal: AbortSignal | undefined
    vi.doMock('./selftest-hook.ts', () => ({ watchForSelftest: async (_page: unknown, _elements: unknown, _diagnostics: unknown, lifetime?: AbortSignal) => {
      signal = lifetime
      entered.resolve()
      return preparation.promise
    } }))
    const mounted = await act(async () => startSheetEditorPage({ chrome: document.createElement('header'), surface: document.createElement('div') }))
    await entered.promise
    try {
      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })
      await act(async () => {
        preparation.resolve()
        await mounted?.loaded
      })
      expect(signal?.aborted).toBe(true)
      expect(h.dispose).toHaveBeenCalledOnce()
      expect(h.load).not.toHaveBeenCalled()
    }
    finally {
      preparation.resolve()
      await mounted?.loaded
      act(() => mounted?.dispose())
    }
  })

  it.each(['success', 'import-failure'] as const)('selftest %s 后实际 load 接管 pagehide，原在途保存处理仍优先', async (outcome) => {
    vi.stubEnv('MODE', 'e2e')
    vi.stubGlobal('reportError', vi.fn())
    window.history.replaceState(null, '', '/documents/01a0fb60-a504-7c95-8bdf-8aeaec893aaf?selftest=read-only')
    const module = deferred<{ watchForSelftest: () => void }>()
    vi.doMock('./selftest-hook.ts', async () => {
      const ready = await module.promise
      if (outcome === 'import-failure')
        throw new Error('controlled module failure')
      return ready
    })
    const onHide = vi.fn()
    h.load.mockImplementationOnce(async () => window.addEventListener('pagehide', onHide))
    const mounted = await act(async () => startSheetEditorPage({ chrome: document.createElement('header'), surface: document.createElement('div') }))
    try {
      await act(async () => {
        module.resolve({ watchForSelftest: () => {} })
        await mounted?.loaded
      })
      expect(h.load).toHaveBeenCalledOnce()
      if (outcome === 'import-failure')
        expect(reportError).toHaveBeenCalledOnce()
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
})
