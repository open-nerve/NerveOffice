// 表格编辑器以 E2E 为主（规范 §8.3）；这里只测 E2E 做不出来的部分：创建过程中出错时，已经创建的都要销毁（审查 B8）；
// 按打开方式组合的是哪些（M2-P3 设计 §3.1–§3.4：授权服务、插件档案、只读守卫在创建工作簿之前装上）
import type { EditorAccess } from './editor-access.ts'
import type { PluginEntry } from './profile/plugin-entry.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IAuthzIoService, injectorOf, WorkbookViewPermission } from './internal-api/index.ts'
import { sheetPluginEntries } from './profile/sheet-profile.ts'
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
    expect(recorded.atCreateWorkbook).toMatchObject({ BeforeCommandExecute: 1 })
    expect(recorded.atCreateWorkbook).not.toHaveProperty('BeforeUndo')
    expect(recorded.atCreateWorkbook).not.toHaveProperty('BeforeRedo')
    expect(subscribed()).toBe(0)
  })
})
