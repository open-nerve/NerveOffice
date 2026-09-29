import type { CommandEvent } from '../change-tracking/command-event.ts'
import { CommandType } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { FRange, FWorksheet } from '@univerjs/sheets/facade'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installEditorProbe } from './e2e-probe.ts'

vi.hoisted(() => {
  // jsdom 没有 Path2D：探针补上的插件 Facade 引用表格的界面包，它们在模块求值时就创建它。这里不渲染
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

type Workbook = ReturnType<FUniver['createWorkbook']>
type FakeEvent = CommandEvent & { cancel?: boolean }

const EVENTS = ['BeforeCommandExecute', 'CommandExecuted', 'BeforeUndo', 'BeforeRedo', 'Undo', 'Redo'] as const

/**
 * 假的 Facade：按订阅的顺序记下每个事件的订阅者（与 SDK 相同），由测试模拟派发。
 * earlier 是在探针之前订阅的（入口守卫、只读守卫），它们先收到事件、可以设 cancel
 */
function fakeFacade() {
  const listeners = new Map<string, ((event: FakeEvent) => void)[]>()
  const subscribe = (name: string, listener: (event: FakeEvent) => void) => {
    const subscribed = listeners.get(name) ?? []
    listeners.set(name, subscribed)
    subscribed.push(listener)
    return { dispose: () => subscribed.splice(subscribed.indexOf(listener), 1) }
  }
  const api = {
    Event: Object.fromEntries(EVENTS.map(name => [name, name])),
    addEvent: subscribe,
  }
  const fire = (name: (typeof EVENTS)[number], event: FakeEvent): void => {
    for (const listener of [...listeners.get(name) ?? []])
      listener(event)
  }
  const listenerCount = (): number => [...listeners.values()].reduce((count, subscribed) => count + subscribed.length, 0)
  return { api: api as unknown as FUniver, fire, earlier: subscribe, listenerCount }
}

function fakeWorkbook(content: () => unknown): Workbook {
  return { save: content } as unknown as Workbook
}

const mutation: FakeEvent = { id: 'sheet.mutation.set-range-values', type: CommandType.MUTATION, params: { unitId: 'unit-1', subUnitId: 'sheet-1' } }
const command: FakeEvent = { id: 'sheet.command.set-range-values', type: CommandType.COMMAND, params: { value: { v: 1 } } }
const undo: FakeEvent = { id: 'univer.command.undo', type: CommandType.COMMAND, params: undefined }

afterEach(() => {
  delete window.__nerveEditorProbe
})

describe('E2E 的探针（M2-P3 设计 §3.7）', () => {
  it('装上之后 window.__nerveEditorProbe 给出 Facade 与内存里的快照（每次读取时重新保存）', () => {
    const { api } = fakeFacade()
    let cell = 'A'
    installEditorProbe(api, fakeWorkbook(() => ({ id: 'unit-1', cell })))
    const probe = window.__nerveEditorProbe
    expect(probe?.univerAPI).toBe(api)
    expect(probe?.snapshot()).toBe('{"id":"unit-1","cell":"A"}')
    cell = 'B'
    expect(probe?.snapshot()).toBe('{"id":"unit-1","cell":"B"}')
  })

  it('命令日志：执行前与执行后按发生的顺序各记一条；canceled 是之前的订阅者给出的结果，执行选项里为真的标记', () => {
    const { api, fire, earlier } = fakeFacade()
    // 在探针之前订阅的守卫：取消本文档的 mutation
    earlier('BeforeCommandExecute', (event) => {
      if (event.type === CommandType.MUTATION)
        event.cancel = true
    })
    installEditorProbe(api, fakeWorkbook(() => ({})))
    fire('BeforeCommandExecute', { ...command })
    fire('BeforeCommandExecute', { ...mutation, options: { onlyLocal: false, fromFormula: true } })
    fire('CommandExecuted', { ...command, options: {} })

    expect(window.__nerveEditorProbe?.commands()).toEqual([
      { seq: 1, phase: 'before', id: command.id, kind: 'command', canceled: false, unitId: undefined, flags: [] },
      { seq: 2, phase: 'before', id: mutation.id, kind: 'mutation', canceled: true, unitId: 'unit-1', flags: ['fromFormula'] },
      { seq: 3, phase: 'executed', id: command.id, kind: 'command', canceled: false, unitId: undefined, flags: [] },
    ])
  })

  it('撤销与重做：Facade 另有专门的事件，同样记下（取消的结果来自之前订阅的只读守卫）', () => {
    const { api, fire, earlier } = fakeFacade()
    earlier('BeforeUndo', (event) => {
      event.cancel = true
    })
    installEditorProbe(api, fakeWorkbook(() => ({})))
    fire('BeforeUndo', { ...undo })
    fire('BeforeRedo', { ...undo, id: 'univer.command.redo' })
    fire('Redo', { ...undo, id: 'univer.command.redo' })
    fire('Undo', { ...undo })

    expect(window.__nerveEditorProbe?.commands().map(({ phase, id, canceled }) => [phase, id, canceled])).toEqual([
      ['before', 'univer.command.undo', true],
      ['before', 'univer.command.redo', false],
      ['executed', 'univer.command.redo', false],
      ['executed', 'univer.command.undo', false],
    ])
  })

  it('commands(after)：只给出序号大于 after 的各条；给出的是副本', () => {
    const { api, fire } = fakeFacade()
    installEditorProbe(api, fakeWorkbook(() => ({})))
    for (let n = 0; n < 3; n += 1)
      fire('CommandExecuted', { ...command })
    const probe = window.__nerveEditorProbe
    expect(probe?.commands(2).map(entry => entry.seq)).toEqual([3])
    expect(probe?.commands(3)).toEqual([])
    const all = probe?.commands() as unknown[] | undefined
    all?.splice(0)
    expect(probe?.commands()).toHaveLength(3)
  })

  it('移除：退订命令事件，删掉 window 上的探针；已经换成别的探针时不动它', () => {
    const { api, fire, listenerCount } = fakeFacade()
    const remove = installEditorProbe(api, fakeWorkbook(() => ({})))
    expect(listenerCount()).toBe(EVENTS.length)
    remove()
    expect(listenerCount()).toBe(0)
    expect('__nerveEditorProbe' in window).toBe(false)
    fire('CommandExecuted', { ...command })

    const removeFirst = installEditorProbe(api, fakeWorkbook(() => ({ n: 1 })))
    installEditorProbe(api, fakeWorkbook(() => ({ n: 2 })))
    removeFirst()
    expect(window.__nerveEditorProbe?.snapshot()).toBe('{"n":2}')
  })
})

describe('探针补上的插件 Facade（probe-facades.ts）', () => {
  it('M0 的 Facade 入口用到的方法都在：筛选、排序、图片、条件格式、数据验证、超链接、批注、查找替换', () => {
    const range = FRange.prototype as unknown as Record<string, unknown>
    const worksheet = FWorksheet.prototype as unknown as Record<string, unknown>
    const univer = FUniver.prototype as unknown as Record<string, unknown>
    for (const method of ['createFilter', 'sort', 'setDataValidation', 'setHyperLink', 'cancelHyperLink', 'createOrUpdateNote'])
      expect(range[method], `FRange.${method}`).toBeTypeOf('function')
    for (const method of ['getImages', 'addConditionalFormattingRule', 'newConditionalFormattingRule'])
      expect(worksheet[method], `FWorksheet.${method}`).toBeTypeOf('function')
    for (const method of ['newDataValidation', 'createTextFinderAsync'])
      expect(univer[method], `FUniver.${method}`).toBeTypeOf('function')
  })
})
