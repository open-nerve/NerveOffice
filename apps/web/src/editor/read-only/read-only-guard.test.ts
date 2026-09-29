import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { CommandEvent } from '../change-tracking/command-event.ts'
import type { ReadOnlyGuard } from './read-only-guard.ts'
import { CommandType, createInterceptorKey, InterceptorManager } from '@univerjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyCommand, EXCLUDED_EXECUTION_OPTIONS } from '../change-tracking/change-classifier.ts'
import { toCommandRecord } from '../change-tracking/command-event.ts'
import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, FOCUSING_FX_BAR_EDITOR, FORMULA_BAR_INPUT_SELECTOR, getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel, IContextService, IDrawingManagerService, IPermissionService, IUndoRedoService, NOTE_TEXTAREA_SELECTOR, WorksheetCopyPermission, WorksheetViewPermission } from '../internal-api/index.ts'
import { HeaderFreezeRenderController, IEditorService, IRenderManagerService } from '../internal-api/ui.ts'
import { closedWorksheetPoints, installReadOnlyGuard as install, READ_ONLY_GUARDED_COMMANDS } from './read-only-guard.ts'

/** Facade 在执行前送出的事件：BeforeCommandExecute、BeforeUndo、BeforeRedo 都是这一种 */
type FakeEvent = CommandEvent

/** 装上的守卫在每个用例之后销毁：批注与编辑栏的处理挂在页面上，不能留给下一个用例 */
const installed: ReadOnlyGuard[] = []

function installReadOnlyGuard(...args: Parameters<typeof install>): ReadOnlyGuard {
  const guard = install(...args)
  installed.push(guard)
  return guard
}

afterEach(() => {
  for (const guard of installed.splice(0))
    guard.dispose()
  document.body.replaceChildren()
})

const UNIT = 'unit-1'
const config = { unitId: UNIT, excludedMutationIds: ['sheet.operation.clear-drawing-transformer'] }

/** 与 sheets-ui 的冻结线控制器同样的拦截点（freeze.render-controller.ts 的 FREEZE_PERMISSION_CHECK） */
const FREEZE_PERMISSION_CHECK = createInterceptorKey<boolean, null>('freezePermissionCheck')

/**
 * 假的 Facade：记下 BeforeCommandExecute、BeforeUndo、BeforeRedo 的订阅者，由测试模拟 SDK 在执行前同步派发；
 * getWorkbook 给出本文档的工作表（sheetIds 为 null 时工作簿还没有创建）
 */
function fakeFacade(sheetIds: readonly string[] | null = ['sheet-1']) {
  const listeners = new Map<string, Set<(event: FakeEvent) => void>>()
  const api = {
    Event: { BeforeCommandExecute: 'BeforeCommandExecute', BeforeUndo: 'BeforeUndo', BeforeRedo: 'BeforeRedo' },
    addEvent: vi.fn((name: string, listener: (event: FakeEvent) => void) => {
      const subscribed = listeners.get(name) ?? new Set()
      listeners.set(name, subscribed)
      subscribed.add(listener)
      return { dispose: () => subscribed.delete(listener) }
    }),
    getWorkbook: (id: string) => id === UNIT && sheetIds !== null
      ? { getSheets: () => sheetIds.map(sheetId => ({ getSheetId: () => sheetId })) }
      : null,
  }
  const fire = (name: string, event: FakeEvent): FakeEvent => {
    for (const listener of listeners.get(name) ?? [])
      listener(event)
    return event
  }
  const listenerCount = (): number => [...listeners.values()].reduce((count, subscribed) => count + subscribed.size, 0)
  return { api: api as unknown as FUniver, fire, listenerCount }
}

interface FakePoint { id: string, value: boolean }

/** 假的权限服务与撤销栈：权限点按 id 存（与 SDK 的 PermissionService 一样，update 改的是同一个对象），记下加入了哪些 */
function fakeServices(existing: readonly string[] = []) {
  const points = new Map<string, FakePoint>(existing.map(id => [id, { id, value: true }]))
  const added: string[] = []
  const permissions = {
    getPermissionPoint: (id: string) => points.get(id),
    addPermissionPoint: (point: FakePoint) => {
      added.push(point.id)
      points.set(point.id, point)
      return true
    },
    updatePermissionPoint: (id: string, value: boolean) => {
      const point = points.get(id)
      if (point !== undefined)
        point.value = value
    },
  }
  const undoRedo = { clearUndoRedo: vi.fn<(unitId: string) => void>() }
  const drawings = { setDrawingEditable: vi.fn<(editable: boolean) => void>() }
  // 渲染之后的两项：本文档渲染单元里的冻结线控制器（它的拦截点），编辑器管理（focus$ 的订阅者）与上下文
  const freeze = new InterceptorManager({ FREEZE_PERMISSION_CHECK })
  const renders = { getRenderUnitById: (id: string) => id === UNIT ? { with: (dependency: unknown) => dependency === HeaderFreezeRenderController ? { interceptor: freeze } : undefined } : null }
  const focusListeners = new Set<() => void>()
  let focusId: string | null = null
  const editors = {
    focus$: { subscribe: (listener: () => void) => {
      focusListeners.add(listener)
      return { unsubscribe: () => focusListeners.delete(listener) }
    } },
    getFocusId: () => focusId,
    blur: vi.fn((_force?: boolean) => {
      focusId = null
    }),
  }
  // SDK 点编辑栏时把 FOCUSING_FX_BAR_EDITOR 置真；放开时值没变就不写（复验 S3）
  const contextValues = new Map<string, boolean>([[FOCUSING_FX_BAR_EDITOR, true]])
  const context = {
    getContextValue: vi.fn<(key: string) => boolean>(key => contextValues.get(key) ?? false),
    setContextValue: vi.fn<(key: string, value: boolean) => void>((key, value) => void contextValues.set(key, value)),
  }
  const focus = (id: string): void => {
    focusId = id
    for (const listener of [...focusListeners])
      listener()
  }
  const univer = {
    __getInjector: () => ({
      get: (id: unknown) => {
        if (id === IPermissionService)
          return permissions
        if (id === IUndoRedoService)
          return undoRedo
        if (id === IDrawingManagerService)
          return drawings
        if (id === IRenderManagerService)
          return renders
        if (id === IEditorService)
          return editors
        if (id === IContextService)
          return context
        throw new Error('只读守卫只取权限服务、撤销栈、图片管理、渲染管理、编辑器管理与上下文服务')
      },
    }),
  } as unknown as Univer
  const canDragFreeze = (): unknown => freeze.fetchThroughInterceptors(FREEZE_PERMISSION_CHECK)(true, null)
  return { univer, points, added, undoRedo, drawings, editors, context, focus, focusListeners, canDragFreeze }
}

const edit: FakeEvent = { id: 'sheet.mutation.set-range-values', type: CommandType.MUTATION, params: { unitId: UNIT, subUnitId: 'sheet-1' } }
const undo: FakeEvent = { id: 'univer.command.undo', type: CommandType.COMMAND, params: undefined }
const redo: FakeEvent = { id: 'univer.command.redo', type: CommandType.COMMAND, params: undefined }

function pointIds(points: readonly (new (unitId: string, subUnitId: string) => { id: string })[], subUnitId: string): string[] {
  return points.map(Point => new Point(UNIT, subUnitId).id)
}

/** 一张工作表上只读时关掉的权限点的 id */
const closedIds = (subUnitId: string): string[] => pointIds(closedWorksheetPoints(), subUnitId)
/** 一张工作表上保留的查看与复制的 id */
const keptIds = (subUnitId: string): string[] => pointIds([WorksheetViewPermission, WorksheetCopyPermission], subUnitId)

describe('只读时关掉的工作表权限点（M2-P3 设计 §3.3）', () => {
  it('SDK 的两份清单去重，去掉查看与复制：1.0.x 共 16 个，没有重复', () => {
    const closed = closedWorksheetPoints()
    expect(closed).toHaveLength(16)
    expect(new Set(closed).size).toBe(closed.length)
    expect(closed).not.toContain(WorksheetViewPermission)
    expect(closed).not.toContain(WorksheetCopyPermission)
  })

  it('加上保留的查看与复制，正好是 SDK 的全部工作表权限点', () => {
    const all = new Set([...getAllWorksheetPermissionPoint(), ...getAllWorksheetPermissionPointByPointPanel()])
    expect(new Set([...closedWorksheetPoints(), WorksheetViewPermission, WorksheetCopyPermission])).toEqual(all)
  })
})

describe('只读守卫：mutation 防火墙（与变更检测同一个判定）', () => {
  it('本文档的修改被取消：参数里的 unitId 是本文档，或者没有 unitId', () => {
    const facade = fakeFacade()
    installReadOnlyGuard(fakeServices().univer, facade.api, config)
    expect(facade.fire('BeforeCommandExecute', { ...edit }).cancel).toBe(true)
    expect(facade.fire('BeforeCommandExecute', { ...edit, id: 'sheet.mutation.insert-sheet', params: {} }).cancel).toBe(true)
    expect(facade.fire('BeforeCommandExecute', { ...edit, params: undefined }).cancel).toBe(true)
  })

  it.each([
    // 公式结果的写回与 Worker 同步回来的 mutation 都带 onlyLocal
    ...EXCLUDED_EXECUTION_OPTIONS.map(option => [`带 ${option} 标记的 mutation`, { ...edit, options: { [option]: true } }] as const),
    ['其他单元的 mutation：单元格编辑器写内部文档单元（M0-P3 审查 R2）', { id: 'doc.mutation.rich-text-editing', type: CommandType.MUTATION, params: { unitId: '__INTERNAL_EDITOR__DOCS_NORMAL', actions: [] } }],
    ['排除名单里的 mutation：只清除界面上的图片变换框', { id: 'sheet.operation.clear-drawing-transformer', type: CommandType.MUTATION, params: [UNIT] }],
    ['命令：它执行的 mutation 各自经过防火墙', { id: 'sheet.command.set-range-values', type: CommandType.COMMAND, params: { unitId: UNIT } }],
    ['操作：选区、切换工作表等只改视图', { id: 'sheet.operation.set-selections', type: CommandType.OPERATION, params: { unitId: UNIT } }],
  ] as const)('不取消%s', (_case, event) => {
    const facade = fakeFacade()
    installReadOnlyGuard(fakeServices().univer, facade.api, config)
    expect(facade.fire('BeforeCommandExecute', { ...event }).cancel).toBeUndefined()
  })

  it('不变量：取消的正好是变更检测认作修改的（classifyCommand 为 change）', () => {
    const samples: FakeEvent[] = [
      edit,
      { ...edit, params: {} },
      { ...edit, params: { unitId: 42 } },
      { ...edit, params: { unitId: 'unit-2' } },
      { ...edit, options: { onlyLocal: false, trigger: 'x' } },
      ...EXCLUDED_EXECUTION_OPTIONS.map(option => ({ ...edit, options: { [option]: true } })),
      { id: 'sheet.operation.clear-drawing-transformer', type: CommandType.MUTATION, params: [UNIT] },
      { id: 'sheet.command.insert-sheet', type: CommandType.COMMAND, params: { unitId: UNIT } },
      { id: 'sheet.operation.set-worksheet-active', type: CommandType.OPERATION, params: { unitId: UNIT } },
    ]
    const facade = fakeFacade()
    installReadOnlyGuard(fakeServices().univer, facade.api, config)
    for (const sample of samples) {
      const verdict = classifyCommand(toCommandRecord(sample), config)
      expect(facade.fire('BeforeCommandExecute', { ...sample }).cancel === true, `${sample.id}：${verdict}`).toBe(verdict === 'change')
    }
  })
})

describe('只读守卫：只读时没有意义的界面操作（M2-P3 S3 之后的修复）', () => {
  it('打开替换（查找面板里的"替换 / 高级查找"与 Ctrl/Cmd+H 都走它）在执行前取消；打开查找照常', () => {
    const facade = fakeFacade()
    installReadOnlyGuard(fakeServices().univer, facade.api, config)
    expect(facade.fire('BeforeCommandExecute', { id: 'ui.operation.open-replace-dialog', type: CommandType.OPERATION, params: undefined }).cancel).toBe(true)
    expect(facade.fire('BeforeCommandExecute', { id: 'ui.operation.open-find-dialog', type: CommandType.OPERATION, params: undefined }).cancel).toBeUndefined()
  })

  it('清单的每一项写明来源与原因，id 不重复', () => {
    const ids = READ_ONLY_GUARDED_COMMANDS.map(command => command.id)
    expect(ids).toEqual(['ui.operation.open-replace-dialog'])
    expect(READ_ONLY_GUARDED_COMMANDS.every(command => command.source.trim() !== '')).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('只读守卫：批注浮层与编辑栏（M2-P3 S3 之后的修复）', () => {
  /** MutationObserver 的回调在微任务里送达：等一个宏任务 */
  async function mutationsDelivered(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  function notePopup(): HTMLTextAreaElement {
    const popup = document.createElement('div')
    popup.innerHTML = '<textarea data-u-comp="note-textarea"></textarea>'
    document.body.append(popup)
    const textarea = popup.querySelector<HTMLTextAreaElement>(NOTE_TEXTAREA_SELECTOR)
    if (textarea === null)
      throw new Error('没有造出批注的文本框')
    return textarea
  }

  function formulaBarEditor(): HTMLElement {
    const bar = document.createElement('div')
    bar.innerHTML = '<div data-u-comp="formula-bar"><div><div data-u-comp="formula-editor"><div class="input"></div></div></div></div>'
    document.body.append(bar)
    const input = bar.querySelector<HTMLElement>('.input')
    if (input === null || input.closest(FORMULA_BAR_INPUT_SELECTOR) === null)
      throw new Error('没有造出编辑栏的编辑框')
    return input
  }

  it('装上守卫：之后出现的批注文本框设为只读；销毁之后不再处理', async () => {
    const guard = installReadOnlyGuard(fakeServices().univer, fakeFacade().api, config)
    const first = notePopup()
    await mutationsDelivered()
    expect(first.readOnly).toBe(true)
    guard.dispose()
    const later = notePopup()
    await mutationsDelivered()
    expect(later.readOnly).toBe(false)
  })

  it('装上守卫：落在编辑栏编辑框上的按下被拦下；销毁之后照常', () => {
    const guard = installReadOnlyGuard(fakeServices().univer, fakeFacade().api, config)
    const input = formulaBarEditor()
    const received = vi.fn()
    input.addEventListener('pointerdown', received)
    const blocked = new Event('pointerdown', { bubbles: true, cancelable: true })
    input.dispatchEvent(blocked)
    expect(received).not.toHaveBeenCalled()
    expect(blocked.defaultPrevented).toBe(true)
    guard.dispose()
    input.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(received).toHaveBeenCalledOnce()
  })
})

describe('只读守卫：渲染完成之后的界面处理（P3 审查 A1、B2）', () => {
  it('装上与设权限点时不取渲染与编辑器的服务：它们在渲染完成之后才装', () => {
    const services = fakeServices()
    const guard = installReadOnlyGuard(services.univer, fakeFacade().api, config)
    guard.applyWorksheetPoints()
    expect(services.canDragFreeze()).toBe(true)
    expect(services.focusListeners.size).toBe(0)
  })

  it('applyRenderedGuards：本文档的冻结线拖不动；编辑栏的编辑器一被聚焦就放开', async () => {
    const services = fakeServices()
    const guard = installReadOnlyGuard(services.univer, fakeFacade().api, config)
    guard.applyRenderedGuards()
    expect(services.canDragFreeze()).toBe(false)
    services.focus(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
    await Promise.resolve()
    expect(services.editors.blur).toHaveBeenCalledExactlyOnceWith(true)
    expect(services.context.setContextValue).toHaveBeenCalledExactlyOnceWith(FOCUSING_FX_BAR_EDITOR, false)
  })

  it('销毁时撤掉：冻结线照常可以拖，编辑栏的聚焦不再放开', async () => {
    const services = fakeServices()
    const guard = installReadOnlyGuard(services.univer, fakeFacade().api, config)
    guard.applyRenderedGuards()
    guard.dispose()
    expect(services.canDragFreeze()).toBe(true)
    expect(services.focusListeners.size).toBe(0)
    services.focus(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
    await Promise.resolve()
    expect(services.editors.blur).not.toHaveBeenCalled()
  })

  it('销毁之后再装：报错，不静默装上撤不掉的处理（复验 S1）', () => {
    const services = fakeServices()
    const guard = installReadOnlyGuard(services.univer, fakeFacade().api, config)
    guard.dispose()
    expect(() => guard.applyRenderedGuards()).toThrow('只读守卫已经销毁')
    expect(services.canDragFreeze()).toBe(true)
    expect(services.focusListeners.size).toBe(0)
  })
})

describe('只读守卫：撤销与重做', () => {
  it('撤销与重做都被取消', () => {
    const facade = fakeFacade()
    installReadOnlyGuard(fakeServices().univer, facade.api, config)
    expect(facade.fire('BeforeUndo', { ...undo }).cancel).toBe(true)
    expect(facade.fire('BeforeRedo', { ...redo }).cancel).toBe(true)
  })

  it('清空的是本文档的撤销栈', () => {
    const facade = fakeFacade()
    const services = fakeServices()
    const guard = installReadOnlyGuard(services.univer, facade.api, config)
    expect(services.undoRedo.clearUndoRedo).not.toHaveBeenCalled()
    guard.clearUndoStack()
    expect(services.undoRedo.clearUndoRedo).toHaveBeenCalledExactlyOnceWith(UNIT)
  })
})

describe('只读守卫：工作表的本地权限点', () => {
  it('每张工作表：查看与复制之外的权限点设为不允许，查看与复制不动；已有的不再加入', () => {
    const facade = fakeFacade(['sheet-1', 'sheet-2'])
    // SDK 在工作簿创建时已为每张表加入全部权限点，初值都允许（sheets 的 worksheet-permission.service.ts:50-60）
    const services = fakeServices([...closedIds('sheet-1'), ...keptIds('sheet-1'), ...closedIds('sheet-2'), ...keptIds('sheet-2')])
    installReadOnlyGuard(services.univer, facade.api, config).applyWorksheetPoints()
    for (const sheet of ['sheet-1', 'sheet-2']) {
      expect(closedIds(sheet).map(id => services.points.get(id)?.value), sheet).toEqual(closedIds(sheet).map(() => false))
      expect(keptIds(sheet).map(id => services.points.get(id)?.value), sheet).toEqual([true, true])
    }
    expect(services.added).toEqual([])
  })

  it('不存在的权限点先加入再设为不允许；查看与复制不加入', () => {
    const facade = fakeFacade(['sheet-1'])
    const services = fakeServices()
    installReadOnlyGuard(services.univer, facade.api, config).applyWorksheetPoints()
    expect(services.added).toEqual(closedIds('sheet-1'))
    expect(closedIds('sheet-1').every(id => services.points.get(id)?.value === false)).toBe(true)
    expect(keptIds('sheet-1').map(id => services.points.has(id))).toEqual([false, false])
  })

  it('同一步里浮动图片设为不可编辑：渲染按图片管理服务的标志决定是否挂变换框（M2-P3 S3 之后的修复）', () => {
    const facade = fakeFacade(['sheet-1'])
    const services = fakeServices()
    const guard = installReadOnlyGuard(services.univer, facade.api, config)
    expect(services.drawings.setDrawingEditable).not.toHaveBeenCalled()
    guard.applyWorksheetPoints()
    expect(services.drawings.setDrawingEditable).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('工作簿还没有创建：报错，不改任何权限点', () => {
    const facade = fakeFacade(null)
    const services = fakeServices()
    const guard = installReadOnlyGuard(services.univer, facade.api, config)
    expect(() => guard.applyWorksheetPoints()).toThrow(UNIT)
    expect(services.points.size).toBe(0)
  })
})

describe('只读守卫的销毁', () => {
  it('移除全部订阅：之后修改、撤销与重做都不再取消；可以重复销毁', () => {
    const facade = fakeFacade()
    const guard = installReadOnlyGuard(fakeServices().univer, facade.api, config)
    expect(facade.listenerCount()).toBe(3)
    guard.dispose()
    guard.dispose()
    expect(facade.listenerCount()).toBe(0)
    expect(facade.fire('BeforeCommandExecute', { ...edit }).cancel).toBeUndefined()
    expect(facade.fire('BeforeUndo', { ...undo }).cancel).toBeUndefined()
    expect(facade.fire('BeforeRedo', { ...redo }).cancel).toBeUndefined()
  })

  it('权限点与图片的可编辑不恢复：M3 的原地切换另外恢复', () => {
    const facade = fakeFacade(['sheet-1'])
    const services = fakeServices()
    const guard = installReadOnlyGuard(services.univer, facade.api, config)
    guard.applyWorksheetPoints()
    guard.dispose()
    expect(closedIds('sheet-1').every(id => services.points.get(id)?.value === false)).toBe(true)
    expect(services.drawings.setDrawingEditable.mock.calls).toEqual([[false]])
  })
})
