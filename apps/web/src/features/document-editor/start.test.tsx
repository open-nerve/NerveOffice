// 编辑器页的启动（M6-P1 S8c 起在共用编辑会话层：startEditorPage(elements, kit)，S8 spec §3.3）：可释放的挂载、pagehide 的移交、页面自检的挂接
// 先于载入；新增的用例另核对测试构建里的先后（探针、kit 的测试钩子与刷新诊断、再判一次已停止、组装）。用假的 kit，通用页面与页头都换成假件，
// 与文档类型无关；表格的 kit 由 sheet-editor/start.test.tsx 核对
import type { EditorChromeSlots } from './editor-chrome.tsx'
import type { ImageOperationState } from './editor-page.ts'
import type { EditorPageKit, InstalledTestHooks } from './start.tsx'
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from './editing-session.test-support.ts'
import { startEditorPage } from './start.tsx'

const h = vi.hoisted(() => ({
  load: vi.fn(async () => {}),
  dispose: vi.fn(),
  stopConnection: vi.fn(),
  stopGuards: vi.fn(),
  stopMaintenance: vi.fn(),
  create: vi.fn(),
  reloadSnapshot: vi.fn(),
  observeReloadStart: vi.fn(),
  installOutboxProbe: vi.fn(),
  installCrashProbe: vi.fn(),
}))
vi.mock('./editor-chrome.tsx', () => ({ EditorChrome: () => <p>正式页头</p> }))
vi.mock('../local-data/notice.ts', () => ({ LocalDataNotice: () => null }))
vi.mock('../../shared/lib/draft-maintenance.ts', () => ({ startDraftMaintenance: () => h.stopMaintenance }))
vi.mock('../../shared/lib/browser-connection.ts', () => ({ watchBrowserConnection: () => h.stopConnection }))
// 页面的守卫与通用页面：会话层的 start.tsx 引用同目录的文件（不经自己的公开入口），按路径 mock 这两个文件，其余名字取原实现。
// 通用页面的假件只有 load 与 dispose，所以按路径 mock，不按模块的类型核对返回值
vi.mock('./page-guards.ts', async importOriginal => ({ ...await importOriginal<typeof import('./page-guards.ts')>(), installPageGuards: () => h.stopGuards, isApplePlatform: () => false }))
vi.mock('./editor-page.ts', async importOriginal => ({ ...await importOriginal<typeof import('./editor-page.ts')>(), createEditorPage: (options: unknown) => {
  h.create(options)
  return { load: h.load, dispose: h.dispose }
} }))
vi.mock('../../shared/lib/session-channel.ts', () => ({ openSessionChannel: () => ({}) }))
// 测试构建里由会话层的 start.tsx 自己引入的：刷新诊断、发件箱与崩溃探针
vi.mock('./recovery/testing/reload-diagnostics.ts', () => ({ observeReloadStart: h.observeReloadStart }))
vi.mock('./outbox/testing/outbox-probe.ts', () => ({ installOutboxProbe: h.installOutboxProbe }))
vi.mock('./outbox/testing/crash-probe.ts', () => ({ installCrashProbe: h.installCrashProbe }))

/** 页面扩展交给使用方的成员：只有页头的插槽（页头在这里是假件，用不到它） */
interface Members {
  readonly chrome: EditorChromeSlots<object, ImageOperationState>
}

/** 假的 kit：装配表是空的（通用页面整个换成了假件），加载失败一律不算；测试构建的加载器按用例给 */
function kitOf(loaders: Pick<EditorPageKit<Members, object, ImageOperationState>, 'testHooks' | 'selftest'> = {}): EditorPageKit<Members, object, ImageOperationState> {
  return { assemblies: {}, isLoadFailure: () => false, ...loaders }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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
    const mounted = await act(async () => startEditorPage({ chrome, surface, heading }, kitOf()))
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
    const mounted = await act(async () => startEditorPage({ chrome, surface }, kitOf()))
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
    const mounted = await act(async () => startEditorPage({ chrome, surface }, kitOf()))
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
    const kit = kitOf({ selftest: async () => (await module.promise).watchForSelftest })
    const chrome = document.createElement('header')
    const mounted = await act(async () => startEditorPage({ chrome, surface: document.createElement('div') }, kit))
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
    const kit = kitOf({ selftest: async () => async (_page: unknown, _elements: unknown, _diagnostics: unknown, lifetime?: AbortSignal) => {
      signal = lifetime
      entered.resolve()
      return preparation.promise
    } })
    const mounted = await act(async () => startEditorPage({ chrome: document.createElement('header'), surface: document.createElement('div') }, kit))
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
    const kit = kitOf({ selftest: async () => {
      const ready = await module.promise
      if (outcome === 'import-failure')
        throw new Error('controlled module failure')
      return ready.watchForSelftest
    } })
    const onHide = vi.fn()
    h.load.mockImplementationOnce(async () => window.addEventListener('pagehide', onHide))
    const mounted = await act(async () => startEditorPage({ chrome: document.createElement('header'), surface: document.createElement('div') }, kit))
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

// M6-P1 S8c 新增：测试构建里的先后（S8 spec §3.3）——探针发出即不管、没有文档身份时只装探针就返回；kit 的测试钩子与刷新诊断同时引入，
// 没引入成照常组装、不上报；再判一次已停止；依次装刷新诊断、自动保存的控制、交接日志，再组装页面；别的构建里不调 kit 的加载器
describe('测试构建里的先后（S8 spec §3.3）', () => {
  const DOCUMENT_PAGE = '/documents/01a0fb60-a504-7c95-8bdf-8aeaec893aaf'
  const elements = () => ({ chrome: document.createElement('header'), surface: document.createElement('div') })

  it('等 kit 的测试钩子引入之后才组装：依次装刷新诊断、自动保存的控制与交接日志，组装时交给页面；刷新诊断的快照交给自检的挂接', async () => {
    vi.stubEnv('MODE', 'e2e')
    window.history.replaceState(null, '', `${DOCUMENT_PAGE}?selftest=crash-recovery`)
    const order: string[] = []
    h.observeReloadStart.mockImplementationOnce(() => {
      order.push('reload-diagnostics')
      return { snapshot: h.reloadSnapshot }
    })
    h.create.mockImplementationOnce(() => order.push('page'))
    const control = { tuning: undefined, observe: undefined, attach: undefined }
    const trace = vi.fn()
    const hooks = deferred<(target: Window) => InstalledTestHooks>()
    const watch = vi.fn()
    const kit = kitOf({ testHooks: async () => hooks.promise, selftest: async () => watch })
    const page = elements()
    const mounting = startEditorPage(page, kit)
    await act(async () => {})
    expect(h.create).not.toHaveBeenCalled()
    expect(order).toEqual([])
    hooks.resolve((target) => {
      order.push(target === window ? 'test-hooks' : 'test-hooks:wrong-target')
      return { autosaveControl: control, handoverTrace: trace }
    })
    const mounted = await act(async () => mounting)
    try {
      await mounted?.loaded
      expect(order).toEqual(['reload-diagnostics', 'test-hooks', 'page'])
      expect(h.create.mock.calls[0]?.[0]).toMatchObject({ autosaveControl: control, handoverTrace: trace })
      expect(watch).toHaveBeenCalledExactlyOnceWith(mounted?.page, page, h.reloadSnapshot, expect.any(AbortSignal))
      expect(h.load).toHaveBeenCalledOnce()
    }
    finally {
      act(() => mounted?.dispose())
    }
  })

  it('kit 的测试钩子没引入成：照常组装，没有那两样，不上报', async () => {
    vi.stubEnv('MODE', 'e2e')
    vi.stubGlobal('reportError', vi.fn())
    window.history.replaceState(null, '', DOCUMENT_PAGE)
    const mounted = await act(async () => startEditorPage(elements(), kitOf({ testHooks: async () => Promise.reject(new Error('测试钩子没能引入')) })))
    try {
      await mounted?.loaded
      expect(h.create).toHaveBeenCalledOnce()
      expect(h.create.mock.calls[0]?.[0]).toMatchObject({ autosaveControl: undefined, handoverTrace: undefined })
      expect(h.load).toHaveBeenCalledOnce()
      expect(reportError).not.toHaveBeenCalled()
    }
    finally {
      act(() => mounted?.dispose())
    }
  })

  it('等测试钩子期间已停止（pagehide）：再判一次已停止，不装钩子、不组装', async () => {
    vi.stubEnv('MODE', 'e2e')
    window.history.replaceState(null, '', DOCUMENT_PAGE)
    const hooks = deferred<(target: Window) => InstalledTestHooks>()
    const install = vi.fn(() => ({ autosaveControl: undefined, handoverTrace: undefined }))
    const mounting = startEditorPage(elements(), kitOf({ testHooks: async () => hooks.promise }))
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    hooks.resolve(install)
    expect(await act(async () => mounting)).toBeUndefined()
    expect(install).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
    expect(h.stopConnection).toHaveBeenCalledOnce()
  })

  it('地址带探针参数：探针发出即不管地引入、装在 window 上；没有文档身份时只装探针就返回，不调 kit 的加载器、不组装', async () => {
    vi.stubEnv('MODE', 'e2e')
    window.history.replaceState(null, '', '/probe.html?outboxProbe=1&crashProbe=1')
    const kit = kitOf({ testHooks: vi.fn(async () => undefined), selftest: vi.fn(async () => undefined) })
    try {
      expect(await act(async () => startEditorPage(elements(), kit))).toBeUndefined()
      await vi.waitFor(() => {
        expect(h.installOutboxProbe).toHaveBeenCalledOnce()
        expect(h.installCrashProbe).toHaveBeenCalledExactlyOnceWith(window)
      })
      expect(h.installOutboxProbe.mock.calls[0]?.[0]).toBe(window)
      expect(kit.testHooks).not.toHaveBeenCalled()
      expect(h.create).not.toHaveBeenCalled()
    }
    finally {
      // 只装探针就返回时组装处的监听留着（原来如此），这里收掉，免得影响后面的用例
      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })
    }
  })

  it('别的构建里不调 kit 的两个加载器：地址带 selftest 也直接载入', async () => {
    window.history.replaceState(null, '', `${DOCUMENT_PAGE}?selftest=read-only`)
    const kit = kitOf({ testHooks: vi.fn(async () => undefined), selftest: vi.fn(async () => undefined) })
    const mounted = await act(async () => startEditorPage(elements(), kit))
    try {
      await mounted?.loaded
      expect(kit.testHooks).not.toHaveBeenCalled()
      expect(kit.selftest).not.toHaveBeenCalled()
      expect(h.create).toHaveBeenCalledOnce()
      expect(h.load).toHaveBeenCalledOnce()
    }
    finally {
      act(() => mounted?.dispose())
    }
  })
})
