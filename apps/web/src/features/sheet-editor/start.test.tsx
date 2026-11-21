// 表格的启动装配（kit，M6-P1 S8c，S8 spec §3.3、§3.6）：装配表只有表格；编辑器的加载失败只认适配层的 SheetEditorLoadError；
// 两个测试构建的加载器只在测试构建里（MODE 是 e2e）引入、交回东西，别的构建里交回 undefined、不引入；
// 测试钩子装的先后是自动保存的控制、交接日志，两个各自引入，一个没引入成不影响另一个。
// 组装处怎样用 kit（先后、停止、上报）由 document-editor/start.test.tsx 核对
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SheetEditorLoadError } from '../../editor/index.ts'
import { clientFormatOf } from '../../shared/api/client-format.ts'
import { DEFAULT_AUTOSAVE_LIMITS } from '../document-editor/index.ts'
import { sheetEditorPageKit } from './start.tsx'

// jsdom 没有 Path2D：表格的界面包在模块求值时就创建它（kit 引用适配层的公开入口）。这里不渲染
vi.hoisted(() => vi.stubGlobal('Path2D', class {}))

const h = vi.hoisted(() => {
  /** 测试构建的模块被引入（求值）的记录，与装上的先后 */
  const imported: string[] = []
  const installed: string[] = []
  const control = { tuning: undefined, observe: undefined, attach: undefined }
  const observe = (): void => {}
  return {
    imported,
    installed,
    control,
    observe,
    failControl: false,
    installControl: vi.fn((_target: Window, _limits: unknown) => {
      installed.push('autosave-control')
      return control
    }),
    installLog: vi.fn((_target: Window) => {
      installed.push('handover-log')
      return { observe }
    }),
    watch: vi.fn(),
  }
})

// 每条用例重新登记测试构建的三个模块（vi.doMock 让下一次动态引入重新求值，vi.resetModules 不重置 mock 的模块）：
// 引入了没有，按 mock 的工厂有没有被调用看；自动保存的控制没引入成，是它的工厂抛出
beforeEach(() => {
  vi.doMock('../../editor/testing/autosave-control.ts', () => {
    h.imported.push('autosave-control')
    if (h.failControl)
      throw new Error('自动保存的控制没能引入')
    return { installAutosaveControl: h.installControl }
  })
  vi.doMock('../../editor/testing/handover-log.ts', () => {
    h.imported.push('handover-log')
    return { installHandoverLog: h.installLog }
  })
  vi.doMock('./selftest-hook.ts', () => {
    h.imported.push('selftest-hook')
    return { watchForSelftest: h.watch }
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  h.imported.splice(0)
  h.installed.splice(0)
  h.failControl = false
})

describe('表格的启动装配（kit）', () => {
  it('装配表只有表格一项，档案是表格的', () => {
    expect(Object.keys(sheetEditorPageKit.assemblies)).toEqual(['sheet'])
    expect(sheetEditorPageKit.assemblies.sheet?.format).toEqual(clientFormatOf('sheet'))
  })

  it('编辑器的加载失败只认适配层的 SheetEditorLoadError（交给“页面开始离开之后不报”的上报）；别的错误不算', () => {
    expect(sheetEditorPageKit.isLoadFailure(new SheetEditorLoadError('worker-failed', '公式 Worker 没能启动'))).toBe(true)
    expect(sheetEditorPageKit.isLoadFailure(new TypeError('Importing a module script failed.'))).toBe(false)
    expect(sheetEditorPageKit.isLoadFailure(new Error('别的错误'))).toBe(false)
    expect(sheetEditorPageKit.isLoadFailure(undefined)).toBe(false)
  })

  it('加载器只在测试构建里有：别的构建里交回 undefined，测试构建的模块一个也不引入', async () => {
    expect(import.meta.env.MODE).not.toBe('e2e')
    await expect(sheetEditorPageKit.testHooks?.()).resolves.toBeUndefined()
    await expect(sheetEditorPageKit.selftest?.()).resolves.toBeUndefined()
    expect(h.imported).toEqual([])
    expect(h.installControl).not.toHaveBeenCalled()
    expect(h.installLog).not.toHaveBeenCalled()
  })

  it('测试构建里：测试钩子引入之后不立即装，install(window) 时先装自动保存的控制、再装交接日志，交回两者', async () => {
    vi.stubEnv('MODE', 'e2e')
    const install = await sheetEditorPageKit.testHooks?.()
    expect(h.imported).toEqual(expect.arrayContaining(['autosave-control', 'handover-log']))
    expect(h.installed).toEqual([])
    const installed = install?.(window)
    expect(h.installed).toEqual(['autosave-control', 'handover-log'])
    expect(h.installControl).toHaveBeenCalledExactlyOnceWith(window, DEFAULT_AUTOSAVE_LIMITS)
    expect(h.installLog).toHaveBeenCalledExactlyOnceWith(window)
    expect(installed).toEqual({ autosaveControl: h.control, handoverTrace: h.observe })
    expect(h.imported).not.toContain('selftest-hook')
  })

  it('测试构建里：两个钩子各自引入，自动保存的控制没引入成时交接日志照常装上', async () => {
    vi.stubEnv('MODE', 'e2e')
    h.failControl = true
    const install = await sheetEditorPageKit.testHooks?.()
    const installed = install?.(window)
    expect(h.installControl).not.toHaveBeenCalled()
    expect(h.installed).toEqual(['handover-log'])
    expect(installed).toEqual({ autosaveControl: undefined, handoverTrace: h.observe })
  })

  it('测试构建里：自检的加载器交回页面自检的挂接', async () => {
    vi.stubEnv('MODE', 'e2e')
    await expect(sheetEditorPageKit.selftest?.()).resolves.toBe(h.watch)
    expect(h.imported).toEqual(['selftest-hook'])
    expect(h.watch).not.toHaveBeenCalled()
  })
})
