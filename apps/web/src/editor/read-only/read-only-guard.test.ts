import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { CommandEvent } from '../change-tracking/command-event.ts'
import { CommandType } from '@univerjs/core'
import { describe, expect, it, vi } from 'vitest'
import { classifyCommand, EXCLUDED_EXECUTION_OPTIONS } from '../change-tracking/change-classifier.ts'
import { toCommandRecord } from '../change-tracking/command-event.ts'
import { getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel, IPermissionService, IUndoRedoService, WorksheetCopyPermission, WorksheetViewPermission } from '../internal-api/index.ts'
import { closedWorksheetPoints, installReadOnlyGuard } from './read-only-guard.ts'

/** Facade 在执行前送出的事件：BeforeCommandExecute、BeforeUndo、BeforeRedo 都是这一种 */
type FakeEvent = CommandEvent

const UNIT = 'unit-1'
const config = { unitId: UNIT, excludedMutationIds: ['sheet.operation.clear-drawing-transformer'] }

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
  const univer = {
    __getInjector: () => ({
      get: (id: unknown) => {
        if (id === IPermissionService)
          return permissions
        if (id === IUndoRedoService)
          return undoRedo
        throw new Error('只读守卫只取权限服务与撤销栈')
      },
    }),
  } as unknown as Univer
  return { univer, points, added, undoRedo }
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

  it('权限点不恢复：M3 的原地切换另外恢复', () => {
    const facade = fakeFacade(['sheet-1'])
    const services = fakeServices()
    const guard = installReadOnlyGuard(services.univer, facade.api, config)
    guard.applyWorksheetPoints()
    guard.dispose()
    expect(closedIds('sheet-1').every(id => services.points.get(id)?.value === false)).toBe(true)
  })
})
