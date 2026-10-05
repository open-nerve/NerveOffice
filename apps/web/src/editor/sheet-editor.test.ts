// 表格编辑器以 E2E 为主（规范 §8.3）；这里只测 E2E 做不出来的部分：创建过程中出错时，已经创建的都要销毁（审查 B8）；
// 按打开方式组合的是哪些（M2-P3 设计 §3.1–§3.4：授权服务、插件档案、只读守卫在创建工作簿之前装上）；
// 只读时的编排（P3 审查 A3）：防火墙与变更检测用同一份判定的配置，创建工作簿之后设权限点，就绪时装界面的处理、清空撤销栈；
// 链接的改写（M3-P3 设计 §3.6）：阅读与编辑都在入口守卫之后、创建工作簿之前装上；
// 语言服务换成销毁之后不抛错的实现（internal-api 的 disposalSafeLocaleOverride，子类本身的行为由 locale-service.test.ts 测）；
// 打开自检（M3-P4 设计 §3.11）：jsdom 里真实的 Univer core 与档案的数据插件，模板与正常的快照通过，损坏的给出失败；两次核对的时机
import type { UnitModel } from '@univerjs/core'
import type { EditorAccess } from './editor-access.ts'
import type { PluginEntry } from './profile/plugin-entry.ts'
import type { ReadOnlyGuard } from './read-only/read-only-guard.ts'
import { profileResourceNames, sheetSnapshotFor } from '@nerve-office/contracts'
import { LifecycleStages, Univer, UniverInstanceType } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChangeTracker } from './change-tracking/change-tracker.ts'
import { imagePolicyReport } from './image-function/worker-report.ts'
import { createResourceLoadGuard, disposalSafeLocaleOverride, IAuthzIoService, injectorOf, WorkbookViewPermission } from './internal-api/index.ts'
import { dataPluginEntries, snapshotWithResources } from './profile/data-plugins.test-support.ts'
import { installEntryGuards } from './profile/entry-guards.ts'
import { installLinkPolicy } from './profile/link-policy.ts'
import { CHANGE_DETECTION_EXCLUDED_MUTATIONS, sheetPluginEntries } from './profile/sheet-profile.ts'
import { installReadOnlyGuard } from './read-only/read-only-guard.ts'
import { SheetEditorLoadError } from './sheet-editor-error.ts'
import { createSheetEditor, EDITOR_ACCESS_ATTRIBUTE } from './sheet-editor.ts'
import { readViewState, restoreViewState } from './view-state.ts'

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
// 入口守卫与链接的改写同样照常装上；装的先后由用例换成记录调用顺序的实现核对
vi.mock('./profile/entry-guards.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./profile/entry-guards.ts')>()
  return { ...actual, installEntryGuards: vi.fn(actual.installEntryGuards) }
})
vi.mock('./profile/link-policy.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./profile/link-policy.ts')>()
  return { ...actual, installLinkPolicy: vi.fn(actual.installLinkPolicy) }
})
// 没有注册插件时装不上 IMAGE() 的限制（没有函数服务）：编排的用例要走到就绪，这里当作装上了
vi.mock('./image-function/install-image-policy.ts', () => ({ installRestrictedImageFunction: vi.fn(() => true) }))
// 资源守卫照常创建；打开自检的时机由用例换成记录调用顺序的守卫核对
vi.mock('./internal-api/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./internal-api/index.ts')>()
  return { ...actual, createResourceLoadGuard: vi.fn(actual.createResourceLoadGuard) }
})
// 视图状态的取出与恢复本身由 view-state.test.ts 测；这里只核对编排（何时恢复、交给谁）
vi.mock('./view-state.ts', () => ({ readViewState: vi.fn(() => undefined), restoreViewState: vi.fn(() => 'restored') }))

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
  vi.mocked(installEntryGuards).mockClear()
  vi.mocked(installLinkPolicy).mockClear()
  vi.mocked(readViewState).mockClear()
  vi.mocked(restoreViewState).mockClear()
  vi.mocked(createResourceLoadGuard).mockClear()
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
    // BeforeCommandExecute：入口守卫、链接的改写与防火墙各一个
    expect(recorded.atCreateWorkbook).toMatchObject({ BeforeCommandExecute: 3, BeforeUndo: 1, BeforeRedo: 1 })
    expect(subscribed()).toBe(0)
    expect(FakeWorker.created[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('能编辑：不装只读守卫，没有撤销与重做的拦截', async () => {
    const { recorded, subscribed } = fakeFacade()
    await createFailingAtWorkbook('edit')
    expect(vi.mocked(installReadOnlyGuard)).not.toHaveBeenCalled()
    // 入口守卫与链接的改写
    expect(recorded.atCreateWorkbook).toMatchObject({ BeforeCommandExecute: 2 })
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
  const workbook = { getId: () => unitId }
  const api = {
    Event: new Proxy({}, { get: (_target, name) => String(name) }),
    addEvent: (name: string, listener: (event: { stage: LifecycleStages }) => void) => {
      if (name === 'LifeCycleChanged')
        lifecycle.add(listener)
      return { dispose: () => lifecycle.delete(listener) }
    },
    createWorkbook: () => {
      log.push('createWorkbook')
      return workbook
    },
  }
  let created: Univer | undefined
  vi.spyOn(FUniver, 'newAPI').mockImplementation((univer) => {
    created = univer as Univer
    return api as unknown as FUniver
  })
  return {
    /** createWorkbook 给出的工作簿 */
    workbook,
    /** 编辑器创建的 Univer 实例（FUniver.newAPI 收到的） */
    univer(): Univer {
      if (created === undefined)
        throw new Error('编辑器还没有创建 Univer')
      return created
    },
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

describe('链接的改写（M3-P3 设计 §3.6，DEF-021）', () => {
  it.each([
    ['edit', ['installEntryGuards', 'installLinkPolicy', 'createWorkbook']],
    ['read', ['installEntryGuards', 'installLinkPolicy', 'installReadOnlyGuard', 'createWorkbook', 'applyWorksheetPoints']],
  ] as const)('%s：在入口守卫之后、创建工作簿之前装上（打开过程中的写入也改写）；销毁时先于入口守卫卸下（入口守卫直到最后才退订）', async (access, beforeReady) => {
    const log: string[] = []
    const facade = steppingFacade(log, 'unit-p3')
    vi.mocked(installEntryGuards).mockImplementationOnce(() => {
      log.push('installEntryGuards')
      return { dispose: () => log.push('disposeEntryGuards') }
    })
    vi.mocked(installLinkPolicy).mockImplementationOnce(() => {
      log.push('installLinkPolicy')
      return { dispose: () => log.push('disposeLinkPolicy') }
    })
    if (access === 'read') {
      vi.mocked(installReadOnlyGuard).mockImplementationOnce(() => {
        log.push('installReadOnlyGuard')
        return recordingGuard(log)
      })
    }
    vi.mocked(sheetPluginEntries).mockReturnValue([])
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-p3'), access })
    expect(log).toEqual(beforeReady)
    expect(vi.mocked(installLinkPolicy)).toHaveBeenCalledOnce()
    await reachReady(facade)
    const editor = await creating
    editor.dispose()
    expect(log.filter(step => step.startsWith('dispose') && step !== 'dispose')).toEqual(['disposeLinkPolicy', 'disposeEntryGuards'])
  })
})

/** 走到就绪：推进生命周期、Worker 回报装好了 IMAGE() 的限制 */
async function reachReady(facade: Pick<ReturnType<typeof steppingFacade>, 'reach'>): Promise<void> {
  facade.reach(LifecycleStages.Ready)
  facade.reach(LifecycleStages.Rendered)
  await new Promise(resolve => setTimeout(resolve, 0))
  FakeWorker.created[0]?.dispatchEvent(new MessageEvent('message', { data: imagePolicyReport(true) }))
}

/** 编辑器的 Univer 里的语言服务：标识符取自依赖替换本身（internal-api 之外不直接引用 LocaleService，lint 拦着） */
function localeServiceOf(univer: Univer): { readonly t: (key: string) => string } {
  const identifier = disposalSafeLocaleOverride()[0]?.[0]
  if (identifier === undefined)
    throw new Error('依赖替换里没有语言服务')
  return injectorOf(univer).get(identifier) as { readonly t: (key: string) => string }
}

describe('销毁之后的语言服务（internal-api 的 disposalSafeLocaleOverride）', () => {
  // sheets-formula 的进度计时器在计算开始 1 秒后调用它（取"正在分析公式..."），编辑器销毁时不清（main 16f8a1d 的 CI 上的页面异常）
  const ANALYZING = 'sheets-formula.progress.analyzing'

  it('编辑器的 Univer 用的是销毁之后不抛错的语言服务：销毁之前照常翻译，销毁之后 t() 交回键本身', async () => {
    const facade = steppingFacade([], 'unit-l1')
    vi.mocked(sheetPluginEntries).mockReturnValue([])
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-l1'), access: 'edit' })
    await reachReady(facade)
    const editor = await creating
    const locale = localeServiceOf(facade.univer())
    expect(locale.t(ANALYZING)).toBe('正在分析公式...')
    editor.dispose()
    expect(locale.t(ANALYZING)).toBe(ANALYZING)
  })
})

describe('模式切换一律重建（M3-P2 设计 §3.1、§3.3）', () => {
  const STATE = { sheetId: 'sheet-2', topLeft: { row: 40, column: 3 }, selection: undefined }

  it('容器上写着这一个编辑器的打开方式，销毁时去掉；创建失败时同样去掉', async () => {
    const container = document.createElement('div')
    const facade = steppingFacade([], 'unit-p2')
    vi.mocked(installReadOnlyGuard).mockImplementationOnce(() => recordingGuard([]))
    vi.mocked(sheetPluginEntries).mockReturnValue([])
    const creating = createSheetEditor({ container, snapshot: sheetSnapshotFor('unit-p2'), access: 'read' })
    expect(container.getAttribute(EDITOR_ACCESS_ATTRIBUTE)).toBe('read')
    await reachReady(facade)
    const editor = await creating
    expect(container.getAttribute(EDITOR_ACCESS_ATTRIBUTE)).toBe('read')
    editor.dispose()
    expect(container.hasAttribute(EDITOR_ACCESS_ATTRIBUTE)).toBe(false)

    fakeFacade()
    const failing = document.createElement('div')
    await createSheetEditor({ container: failing, snapshot: sheetSnapshotFor('unit-p2'), access: 'edit' }).catch(() => undefined)
    expect(failing.hasAttribute(EDITOR_ACCESS_ATTRIBUTE)).toBe(false)
  })

  it('给了重建之前的视图状态：就绪之后（渲染完成）恢复到这个工作簿上，然后才返回', async () => {
    const log: string[] = []
    const facade = steppingFacade(log, 'unit-p2')
    vi.mocked(restoreViewState).mockImplementationOnce(() => {
      log.push('restoreViewState')
      return 'restored'
    })
    vi.mocked(sheetPluginEntries).mockReturnValue([])
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-p2'), access: 'edit', viewState: STATE })
    expect(log).toEqual(['createWorkbook'])
    await reachReady(facade)
    const editor = await creating
    expect(log).toEqual(['createWorkbook', 'rendered', 'restoreViewState'])
    expect(vi.mocked(restoreViewState)).toHaveBeenCalledExactlyOnceWith(facade.workbook, STATE)
    editor.dispose()
  })

  it('没有给视图状态：不恢复（默认视图）', async () => {
    const facade = steppingFacade([], 'unit-p2')
    vi.mocked(sheetPluginEntries).mockReturnValue([])
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-p2'), access: 'edit' })
    await reachReady(facade)
    const editor = await creating
    expect(vi.mocked(restoreViewState)).not.toHaveBeenCalled()
    editor.dispose()
  })

  it('viewState()：取这个工作簿现在的视图状态；销毁之后为 undefined', async () => {
    const facade = steppingFacade([], 'unit-p2')
    vi.mocked(sheetPluginEntries).mockReturnValue([])
    vi.mocked(readViewState).mockReturnValue(STATE)
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-p2'), access: 'edit' })
    await reachReady(facade)
    const editor = await creating
    expect(editor.viewState()).toEqual(STATE)
    expect(vi.mocked(readViewState)).toHaveBeenCalledExactlyOnceWith(facade.workbook)
    editor.dispose()
    expect(editor.viewState()).toBeUndefined()
    expect(vi.mocked(readViewState)).toHaveBeenCalledOnce()
  })
})

/**
 * 真实插件下的假 Facade：createWorkbook 用这个 Univer 建表格单元（档案的数据插件照常注册资源 hook、加载资源），
 * 记下"创建工作簿"；生命周期由用例推进（与 steppingFacade 相同）
 */
function realUnitFacade(log: string[]) {
  const lifecycle = new Set<(event: { stage: LifecycleStages }) => void>()
  vi.spyOn(FUniver, 'newAPI').mockImplementation(univer => ({
    Event: new Proxy({}, { get: (_target, name) => String(name) }),
    addEvent: (name: string, listener: (event: { stage: LifecycleStages }) => void) => {
      if (name === 'LifeCycleChanged')
        lifecycle.add(listener)
      return { dispose: () => lifecycle.delete(listener) }
    },
    createWorkbook: (data: object) => {
      log.push('createWorkbook')
      const unit = (univer as Univer).createUnit<object, UnitModel>(UniverInstanceType.UNIVER_SHEET, data)
      return { getId: () => unit.getUnitId() }
    },
  }) as unknown as FUniver)
  return {
    reach(stage: LifecycleStages): void {
      if (stage === LifecycleStages.Rendered)
        log.push('rendered')
      for (const listener of [...lifecycle])
        listener({ stage })
    },
  }
}

/** 真实的资源守卫（被 vi.mock 包了一层的那一个的原样） */
const { createResourceLoadGuard: realResourceGuard } = await vi.importActual<typeof import('./internal-api/index.ts')>('./internal-api/index.ts')

/** 记下打开自检取事实的时机的资源守卫：其余照常；readyHookNames 给出时，第二次取 hook 名换成它（就绪之后 hook 集合变了） */
function recordingResourceGuard(log: string[], readyHookNames?: readonly string[]): void {
  vi.mocked(createResourceLoadGuard).mockImplementationOnce(() => {
    const guard = realResourceGuard()
    let asked = 0
    return {
      ...guard,
      sheetHookNames: () => {
        asked += 1
        log.push('sheetHookNames')
        return asked > 1 && readyHookNames !== undefined ? readyHookNames : guard.sheetHookNames()
      },
      captureSheetResources: (unitId) => {
        log.push('captureSheetResources')
        return guard.captureSheetResources(unitId)
      },
    }
  })
}

describe('打开自检（M3-P4 设计 §3.11）：jsdom 里真实的 Univer core 与档案的数据插件', () => {
  beforeEach(() => {
    vi.mocked(sheetPluginEntries).mockReturnValue(dataPluginEntries())
  })

  it.each([
    ['edit', '模板', sheetSnapshotFor('unit-oc')],
    ['edit', '六项内容资源都非空的快照', snapshotWithResources('unit-oc')],
    ['read', '模板', sheetSnapshotFor('unit-oc')],
    ['read', '六项内容资源都非空的快照', snapshotWithResources('unit-oc')],
  ] as const)('%s：%s 的 openCheck 通过（无误报）', async (access, _name, snapshot) => {
    const facade = realUnitFacade([])
    if (access === 'read')
      vi.mocked(installReadOnlyGuard).mockImplementationOnce(() => recordingGuard([]))
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot, access })
    await reachReady(facade)
    const editor = await creating
    expect(editor.openCheck).toEqual({ ok: true })
    editor.dispose()
  })

  it('截断的筛选：openCheck 给出 parse-threw（SyntaxError）与 resource-emptied；编辑器照常返回（不是加载失败，能不能编辑由编辑器页决定）', async () => {
    const facade = realUnitFacade([])
    const filter = (JSON.parse(snapshotWithResources('unit-oc')) as { resources: { name: string, data: string }[] }).resources.find(item => item.name === 'SHEET_FILTER_PLUGIN')?.data ?? ''
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: snapshotWithResources('unit-oc', { SHEET_FILTER_PLUGIN: filter.slice(0, 30) }), access: 'edit' })
    await reachReady(facade)
    const editor = await creating
    expect(editor.openCheck).toEqual({ ok: false, failures: [
      { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' },
      { kind: 'resource-emptied', resource: 'SHEET_FILTER_PLUGIN' },
    ] })
    editor.dispose()
  })

  it('第一次核对在 createWorkbook 刚返回时（只读守卫设权限点之前），就绪之后再核对一次 hook 集合', async () => {
    const log: string[] = []
    const facade = realUnitFacade(log)
    recordingResourceGuard(log)
    vi.mocked(installReadOnlyGuard).mockImplementationOnce(() => recordingGuard(log))
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-oc'), access: 'read' })
    expect(log).toEqual(['createWorkbook', 'sheetHookNames', 'captureSheetResources', 'applyWorksheetPoints'])
    await reachReady(facade)
    const editor = await creating
    expect(log).toEqual(['createWorkbook', 'sheetHookNames', 'captureSheetResources', 'applyWorksheetPoints', 'rendered', 'applyRenderedGuards', 'clearUndoStack', 'sheetHookNames'])
    expect(editor.openCheck).toEqual({ ok: true })
    editor.dispose()
  })

  it('就绪之后 hook 集合少了一个：openCheck 带上 profile-missing-hook（再核对接在结果上）', async () => {
    const facade = realUnitFacade([])
    recordingResourceGuard([], profileResourceNames('sheet@1').filter(name => name !== 'SHEET_NOTE_PLUGIN'))
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-oc'), access: 'edit' })
    await reachReady(facade)
    const editor = await creating
    expect(editor.openCheck).toEqual({ ok: false, failures: [{ kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' }] })
    editor.dispose()
  })

  it('比较的"之前"一侧是载入的原样：SDK 改动交给 createWorkbook 的对象（这里在建出单元之后往里写进一项资源）不影响结果', async () => {
    const lifecycle = new Set<(event: { stage: LifecycleStages }) => void>()
    vi.spyOn(FUniver, 'newAPI').mockImplementation(univer => ({
      Event: new Proxy({}, { get: (_target, name) => String(name) }),
      addEvent: (name: string, listener: (event: { stage: LifecycleStages }) => void) => {
        if (name === 'LifeCycleChanged')
          lifecycle.add(listener)
        return { dispose: () => lifecycle.delete(listener) }
      },
      createWorkbook: (data: { resources: { name: string, data: string }[] }) => {
        const unit = (univer as Univer).createUnit<object, UnitModel>(UniverInstanceType.UNIVER_SHEET, data)
        const note = data.resources.find(item => item.name === 'SHEET_NOTE_PLUGIN')
        if (note !== undefined)
          note.data = '{"sheet-1":{"0":{"0":{"note":"SDK 写进来的"}}}}'
        return { getId: () => unit.getUnitId() }
      },
    }) as unknown as FUniver)
    const creating = createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-oc'), access: 'edit' })
    await reachReady({
      reach: (stage) => {
        for (const listener of [...lifecycle])
          listener({ stage })
      },
    })
    const editor = await creating
    expect(editor.openCheck).toEqual({ ok: true })
    editor.dispose()
  })

  it('打开自检取不到事实（资源守卫没有生效）：按加载失败处理，已经创建的都销毁', async () => {
    realUnitFacade([])
    const failure = new Error('资源守卫没有生效')
    vi.mocked(createResourceLoadGuard).mockImplementationOnce(() => ({
      ...realResourceGuard(),
      sheetHookNames: () => {
        throw failure
      },
    }))
    const univerDispose = vi.spyOn(Univer.prototype, 'dispose')
    await expect(createSheetEditor({ container: document.createElement('div'), snapshot: sheetSnapshotFor('unit-oc'), access: 'edit' })).rejects.toBe(failure)
    expect(univerDispose).toHaveBeenCalledOnce()
    expect(FakeWorker.created[0]?.terminate).toHaveBeenCalledOnce()
  })
})
