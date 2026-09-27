// 表格编辑器以 E2E 为主（规范 §8.3）；这里只测 E2E 做不出来的失败路径：创建过程中出错时，已经创建的都要销毁（审查 B8）
import type { PluginEntry } from './profile/plugin-entry.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { Univer } from '@univerjs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sheetPluginEntries } from './profile/sheet-profile.ts'
import { createSheetEditor } from './sheet-editor.ts'

vi.hoisted(() => {
  // jsdom 没有 Path2D：表格的界面包在模块求值时就创建它。这里不渲染
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

vi.mock('./profile/sheet-profile.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./profile/sheet-profile.ts')>(),
  sheetPluginEntries: vi.fn(),
}))

class FakeWorker extends EventTarget {
  static created: FakeWorker[] = []
  readonly terminate = vi.fn()

  constructor() {
    super()
    FakeWorker.created.push(this)
  }
}

function failingEntry(error: Error): PluginEntry {
  return {
    plugin: class {} as unknown as PluginEntry['plugin'],
    config: undefined,
    register: () => {
      throw error
    },
  }
}

describe('创建表格编辑器的过程中出错（审查 B8）', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker)
    FakeWorker.created = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('注册插件时出错：销毁 Univer、终止 Worker，抛出原来的错误', async () => {
    const univerDispose = vi.spyOn(Univer.prototype, 'dispose')
    const failure = new Error('插件注册出错')
    vi.mocked(sheetPluginEntries).mockReturnValue([failingEntry(failure)])

    await expect(createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-b8') })).rejects.toBe(failure)
    expect(univerDispose).toHaveBeenCalledOnce()
    expect(FakeWorker.created).toHaveLength(1)
    expect(FakeWorker.created[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('销毁 Univer 时也出错：Worker 照样终止，销毁的错误上报，抛出的是原来的错误', async () => {
    const report = vi.fn()
    vi.stubGlobal('reportError', report)
    const disposeFailure = new Error('销毁出错')
    vi.spyOn(Univer.prototype, 'dispose').mockImplementation(() => {
      throw disposeFailure
    })
    const failure = new Error('插件注册出错')
    vi.mocked(sheetPluginEntries).mockReturnValue([failingEntry(failure)])

    await expect(createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-b8') })).rejects.toBe(failure)
    expect(FakeWorker.created[0]?.terminate).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledExactlyOnceWith(disposeFailure)
  })

  it('快照读不出来：什么都不创建', async () => {
    await expect(createSheetEditor({ container: document.createElement('div'), snapshot: '{' })).rejects.toThrow()
    expect(FakeWorker.created).toHaveLength(0)
  })
})
