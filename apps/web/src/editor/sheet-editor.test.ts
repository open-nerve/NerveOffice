// 表格编辑器以 E2E 为主（规范 §8.3）；这里只测 E2E 做不出来的部分：创建过程中出错时，已经创建的都要销毁（审查 B8）；
// 按打开方式组合的是哪些（M2-P3 设计 §3.1–§3.4：授权服务、插件档案、只读守卫在创建工作簿之前装上）；
// 只读时的编排（P3 审查 A3）：防火墙与变更检测用同一份判定的配置，创建工作簿之后设权限点，就绪时装界面的处理、清空撤销栈
import type { EditorAccess } from './editor-access.ts'
import type { PluginEntry } from './profile/plugin-entry.ts'
import type { ReadOnlyGuard } from './read-only/read-only-guard.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { LifecycleStages, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChangeTracker } from './change-tracking/change-tracker.ts'
import { imagePolicyReport } from './image-function/worker-report.ts'
import { IAuthzIoService, injectorOf, WorkbookViewPermission } from './internal-api/index.ts'
import { CHANGE_DETECTION_EXCLUDED_MUTATIONS, sheetPluginEntries } from './profile/sheet-profile.ts'
import { installReadOnlyGuard } from './read-only/read-only-guard.ts'
import { SheetEditorLoadError } from './sheet-editor-error.ts'
import { createSheetEditor } from './sheet-editor.ts'

vi.hoisted(() => {
  // jsdom 没有 Path2D：表格的界面包在模块求值时就创建它。这里不渲染
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

vi.mock('./profile/sheet-profile.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./profile/sheet-profile.ts')>(),
  sheetPluginEntries: vi.fn(),
}))

// 只读守卫与变更检测照常创建（记下调用的参数）；编排的用例换成记录调用顺序的守卫
vi.mock('./read-only/read-only-guard.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./read-only/read-only-guard.ts')>()
  return { ...actual, installReadOnlyGuard: vi.fn(actual.installReadOnlyGuard) }
})
vi.mock('./change-tracking/change-tracker.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./change-tracking/change-tracker.ts')>()
  return { ...actual, createChangeTracker: vi.fn(actual.createChangeTracker) }
})
// 没有注册插件时装不上 IMAGE() 的限制（没有函数服务）：编排的用例要走到就绪，这里当作装上了
vi.mock('./image-function/install-image-policy.ts', () => ({ installRestrictedImageFunction: vi.fn(() => true) }))

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

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker)
  FakeWorker.created = []
  vi.mocked(sheetPluginEntries).mockReset()
  vi.mocked(installReadOnlyGuard).mockClear()
  vi.mocked(createChangeTracker).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('创建表格编辑器的过程中出错（审查 B8）', () => {
  it('注册插件时出错：销毁 Univer、终止 Worker，抛出原来的错误', async () => {
    const univerDispose = vi.spyOn(Univer.prototype, 'dispose')
    const failure = new Error('插件注册出错')
    vi.mocked(sheetPluginEntries).mockReturnValue([failingEntry(failure)])

    await expect(createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-b8'), access: 'edit' })).rejects.toBe(failure)
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

    await expect(createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-b8'), access: 'edit' })).rejects.toBe(failure)
    expect(FakeWorker.created[0]?.terminate).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledExactlyOnceWith(disposeFailure)
  })

  it('快照读不出来：什么都不创建', async () => {
    await expect(createSheetEditor({ container: document.createElement('div'), snapshot: '{', access: 'edit' })).rejects.toThrow()
    expect(FakeWorker.created).toHaveLength(0)
  })
})

/**
 * 假的 Facade：记下每个事件当前的订阅数；createWorkbook 记下那时的订阅数后抛错（按创建失败处理，之后的步骤都不执行）。
 * 没有注册插件时真的 Facade 建不出来（它要取渲染服务），所以换掉 FUniver.newAPI，同时取出那个 Univer 实例里的授权服务
 * （失败之后 Univer 已经销毁，注入器不能再用）
 */
function fakeFacade() {
  const active = new Map<string, number>()
  const recorded: { atCreateWorkbook?: Record<string, number>, authz?: IAuthzIoService } = {}
  const api = {
    // 事件名就是属性名（与 Facade 的 FEventName 相同）
    Event: new Proxy({}, { get: (_target, name) => String(name) }),
    addEvent: (name: string) => {
      active.set(name, (active.get(name) ?? 0) + 1)
      return { dispose: () => active.set(name, (active.get(name) ?? 0) - 1) }
    },
    createWorkbook: () => {
      recorded.atCreateWorkbook = Object.fromEntries(active)
      throw new Error('创建工作簿出错')
    },
  }
  vi.spyOn(FUniver, 'newAPI').mockImplementation((univer) => {
    recorded.authz = injectorOf(univer as Univer).get(IAuthzIoService)
    return api as unknown as FUniver
  })
  const subscribed = (): number => [...active.values()].reduce((sum, count) => sum + count, 0)
  return { recorded, subscribed }
}

async function createFailingAtWorkbook(access: EditorAccess): Promise<unknown> {
  vi.mocked(sheetPluginEntries).mockReturnValue([])
  return createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-p3'), access }).catch((error: unknown) => error)
}

describe('按打开方式创建（M2-P3 设计 §3.1–§3.4）', () => {
  it('插件档案拿到打开方式（界面的配置按它组合）', async () => {
    fakeFacade()
    await createFailingAtWorkbook('read')
    expect(vi.mocked(sheetPluginEntries)).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ access: 'read' }))
  })

  it.each([
    ['edit', true],
    ['read', false],
  ] as const)('授权服务按打开方式回答（%s：编辑 %s，查看总是允许）', async (access, canEdit) => {
    const { recorded } = fakeFacade()
    await createFailingAtWorkbook(access)
    const view = new WorkbookViewPermission('unit-p3').subType
    // UnitAction.Edit = 1
    const request = { objectID: 'unit-p3', objectType: 1, unitID: 'unit-p3', actions: [1, view] } as Parameters<IAuthzIoService['allowed']>[0]
    await expect(recorded.authz?.allowed(request)).resolves.toEqual([{ action: 1, allowed: canEdit }, { action: view, allowed: true }])
  })

  it('只读：在创建工作簿之前装上只读守卫（防火墙与撤销、重做的拦截）；之后出错时随其他资源一并销毁', async () => {
    const { recorded, subscribed } = fakeFacade()
    const error = await createFailingAtWorkbook('read')
    expect(error).toBeInstanceOf(SheetEditorLoadError)
    expect((error as SheetEditorLoadError).reason).toBe('create-failed')
    // BeforeCommandExecute：入口守卫与防火墙各一个
    expect(recorded.atCreateWorkbook).toMatchObject({ BeforeCommandExecute: 2, BeforeUndo: 1, BeforeRedo: 1 })
    expect(subscribed()).toBe(0)
    expect(FakeWorker.created[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('能编辑：不装只读守卫，没有撤销与重做的拦截', async () => {
    const { recorded, subscribed } = fakeFacade()
    await createFailingAtWorkbook('edit')
    expect(vi.mocked(installReadOnlyGuard)).not.toHaveBeenCalled()
    expect(recorded.atCreateWorkbook).toMatchObject({ BeforeCommandExecute: 1 })
    expect(recorded.atCreateWorkbook).not.toHaveProperty('BeforeUndo')
    expect(recorded.atCreateWorkbook).not.toHaveProperty('BeforeRedo')
    expect(subscribed()).toBe(0)
  })
})

/**
 * 能走到就绪的假 Facade：createWorkbook 记下"创建工作簿"，给出 id 对得上的工作簿；生命周期由用例推进（reach），
 * 到 Rendered 时记下"渲染完成"
 */
function steppingFacade(log: string[], unitId: string) {
  const lifecycle = new Set<(event: { stage: LifecycleStages }) => void>()
  const api = {
    Event: new Proxy({}, { get: (_target, name) => String(name) }),
    addEvent: (name: string, listener: (event: { stage: LifecycleStages }) => void) => {
      if (name === 'LifeCycleChanged')
        lifecycle.add(listener)
      return { dispose: () => lifecycle.delete(listener) }
    },
    createWorkbook: () => {
      log.push('createWorkbook')
      return { getId: () => unitId }
    },
  }
  vi.spyOn(FUniver, 'newAPI').mockReturnValue(api as unknown as FUniver)
  return {
    reach(stage: LifecycleStages): void {
      if (stage === LifecycleStages.Rendered)
        log.push('rendered')
      for (const listener of [...lifecycle])
        listener({ stage })
    },
  }
}

/** 记录调用顺序的只读守卫 */
function recordingGuard(log: string[]): ReadOnlyGuard {
  return {
    applyWorksheetPoints: () => log.push('applyWorksheetPoints'),
    applyRenderedGuards: () => log.push('applyRenderedGuards'),
    clearUndoStack: () => log.push('clearUndoStack'),
    dispose: () => log.push('dispose'),
  }
}

describe('只读时的编排（M2-P3 设计 §3.3，P3 审查 A3）', () => {
  it('防火墙与变更检测拿到同一份判定的配置；创建工作簿之后设权限点；就绪时（渲染已经完成）装界面的处理、清空撤销栈', async () => {
    const log: string[] = []
    const facade = steppingFacade(log, 'unit-p3')
    vi.mocked(installReadOnlyGuard).mockImplementationOnce(() => {
      log.push('installReadOnlyGuard')
      return recordingGuard(log)
    })
    vi.mocked(sheetPluginEntries).mockReturnValue([])
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-p3'), access: 'read' })
    // 同步的部分：在创建工作簿之前装上守卫，创建之后设权限点
    expect(log).toEqual(['installReadOnlyGuard', 'createWorkbook', 'applyWorksheetPoints'])

    facade.reach(LifecycleStages.Ready)
    facade.reach(LifecycleStages.Rendered)
    await new Promise(resolve => setTimeout(resolve, 0))
    // Worker 还没回报：没有就绪，界面的处理与撤销栈都不动
    expect(log).toEqual(['installReadOnlyGuard', 'createWorkbook', 'applyWorksheetPoints', 'rendered'])
    FakeWorker.created[0]?.dispatchEvent(new MessageEvent('message', { data: imagePolicyReport(true) }))
    const editor = await creating
    expect(log).toEqual(['installReadOnlyGuard', 'createWorkbook', 'applyWorksheetPoints', 'rendered', 'applyRenderedGuards', 'clearUndoStack'])

    // 防火墙的条件与变更检测一致：两者拿到的是同一个配置对象（本文档的 unitId、排除名单）
    const guardConfig = vi.mocked(installReadOnlyGuard).mock.calls[0]?.[2]
    expect(guardConfig).toBe(vi.mocked(createChangeTracker).mock.calls[0]?.[2])
    expect(guardConfig).toEqual({ unitId: 'unit-p3', excludedMutationIds: CHANGE_DETECTION_EXCLUDED_MUTATIONS })

    editor.dispose()
    expect(log.at(-1)).toBe('dispose')
  })
})
