import type { Univer } from '@univerjs/core'
import type { CommandEvent } from '../change-tracking/command-event.ts'
import type { FormulaProgress } from '../change-tracking/formula-settle-tracker.ts'
import type { ProbeTarget } from './e2e-probe.ts'
import { canonicalLink } from '@nerve-office/contracts'
import { CommandType } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { FRange, FWorksheet } from '@univerjs/sheets/facade'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY } from '../internal-api/index.ts'
import { IEditorService, IShortcutService } from '../internal-api/ui.ts'
import { installEditorProbe as install } from './e2e-probe.ts'

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

interface FakeServices {
  /** 快捷键服务 getAllShortcuts 给出的各项 */
  shortcuts?: readonly Record<string, unknown>[]
  /** 编辑栏的编辑器的文档；null 时没有这个编辑器 */
  formulaBar?: { body?: { dataStream: string } } | null
}

/** 假的 Univer：注入器只给出快捷键服务与编辑器管理（编辑器按 id 取，只有编辑栏的那个） */
function fakeUniver({ shortcuts = [], formulaBar = { body: { dataStream: '\r\n' } } }: FakeServices = {}): Univer {
  const services = new Map<unknown, unknown>([
    [IShortcutService, { getAllShortcuts: () => [...shortcuts] }],
    [IEditorService, { getEditor: (id: string) => id === DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY && formulaBar !== null ? { getDocumentData: () => formulaBar } : null }],
  ])
  return {
    __getInjector: () => ({
      get: (id: unknown) => {
        if (!services.has(id))
          throw new Error('探针只取快捷键服务与编辑器管理')
        return services.get(id)
      },
    }),
  } as unknown as Univer
}

/** 跟踪器的假实现：本地修改序号、公式收齐与进度由用例给出 */
const IDLE_PROGRESS: FormulaProgress = { round: 0, started: false, stopped: false, completed: false, resultSheets: null, appliedSheets: [], queued: false }

function fakeChanges(state: { seq: number, settled: boolean, progress: FormulaProgress } = { seq: 0, settled: true, progress: IDLE_PROGRESS }): ProbeTarget['changes'] {
  return { changeSeq: () => state.seq, formulasSettled: () => state.settled, formulaProgress: () => state.progress }
}

function installEditorProbe(univerAPI: FUniver, workbook: Workbook, services?: FakeServices, target: Partial<Pick<ProbeTarget, 'changes' | 'formulaMode'>> = {}): () => void {
  return install({ univer: fakeUniver(services), univerAPI, workbook, changes: target.changes ?? fakeChanges(), formulaMode: target.formulaMode ?? 'worker' })
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

    // 时刻（at）另有一条用例核对
    expect(window.__nerveEditorProbe?.commands().map(({ seq, phase, id, kind, canceled, unitId, flags }) => ({ seq, phase, id, kind, canceled, unitId, flags }))).toEqual([
      { seq: 1, phase: 'before', id: command.id, kind: 'command', canceled: false, unitId: undefined, flags: [] },
      { seq: 2, phase: 'before', id: mutation.id, kind: 'mutation', canceled: true, unitId: 'unit-1', flags: ['fromFormula'] },
      { seq: 3, phase: 'executed', id: command.id, kind: 'command', canceled: false, unitId: undefined, flags: [] },
    ])
  })

  it('命令日志的每条带记下时的时刻（performance.now()，M3-P4 设计 §3.15）', () => {
    const { api, fire } = fakeFacade()
    installEditorProbe(api, fakeWorkbook(() => ({})))
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValueOnce(1200.5)
    fire('BeforeCommandExecute', { ...command })
    now.mockReturnValueOnce(1203.25)
    fire('CommandExecuted', { ...command })
    expect(window.__nerveEditorProbe?.commands().map(entry => [entry.seq, entry.at])).toEqual([[1, 1200.5], [2, 1203.25]])
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

describe('探针的快捷键清单与编辑栏（M2-P6 复核 F1、F2 之后）', () => {
  it('shortcuts：每次调用时重新读取快捷键服务的全部项，只取命令、各平台的绑定、优先级与有没有前提条件', () => {
    const { api } = fakeFacade()
    const registered: Record<string, unknown>[] = [
      { id: 'ui.operation.open-feature-search', binding: 4096 | 1024 | 80, description: '搜索功能', group: '10_global-shortcut' },
      { id: 'formula-ui.operation.insert-function', binding: 2048 | 187, mac: 4096 | 2048 | 187, priority: 2, preconditions: () => true, staticParameters: { value: 'SUM' } },
      { id: 'sheet.command.set-range-bold', binding: 4096 | 66, eventPreconditions: () => true },
    ]
    installEditorProbe(api, fakeWorkbook(() => ({})), { shortcuts: registered })
    expect(window.__nerveEditorProbe?.shortcuts()).toEqual([
      { id: 'ui.operation.open-feature-search', binding: 4096 | 1024 | 80, mac: undefined, win: undefined, linux: undefined, priority: 0, conditional: false },
      { id: 'formula-ui.operation.insert-function', binding: 2048 | 187, mac: 4096 | 2048 | 187, win: undefined, linux: undefined, priority: 2, conditional: true },
      { id: 'sheet.command.set-range-bold', binding: 4096 | 66, mac: undefined, win: undefined, linux: undefined, priority: 0, conditional: true },
    ])
    registered.push({ id: 'univer.command.undo', binding: 4096 | 90 })
    expect(window.__nerveEditorProbe?.shortcuts().map(item => item.id)).toContain('univer.command.undo')
  })

  it('formulaBarText：编辑栏的编辑器的文档正文，去掉结尾的段落与节的标记；空的编辑栏是空串', () => {
    const { api } = fakeFacade()
    const formulaBar = { body: { dataStream: '=SUM(B2:B9\r\n' } }
    installEditorProbe(api, fakeWorkbook(() => ({})), { formulaBar })
    expect(window.__nerveEditorProbe?.formulaBarText()).toBe('=SUM(B2:B9')
    formulaBar.body.dataStream = '\r\n'
    expect(window.__nerveEditorProbe?.formulaBarText()).toBe('')
    // 只去掉结尾的一组：正文里的换行照样留着
    formulaBar.body.dataStream = '第一行\r第二行\r\n'
    expect(window.__nerveEditorProbe?.formulaBarText()).toBe('第一行\r第二行')
  })

  it('formulaBarText：按编辑栏的单元 id 取不到编辑器、或者文档没有正文时抛错，不返回空串（M2-P6 复验 N3）', () => {
    const { api } = fakeFacade()
    // 假的编辑器管理只按编辑栏的单元 id 给出编辑器：SDK 改了这个 id（或者探针按别的 id 取）时就是这样
    installEditorProbe(api, fakeWorkbook(() => ({})), { formulaBar: null })
    expect(() => window.__nerveEditorProbe?.formulaBarText()).toThrow(`取不到编辑栏的编辑器（${DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY}）`)
    installEditorProbe(api, fakeWorkbook(() => ({})), { formulaBar: {} })
    expect(() => window.__nerveEditorProbe?.formulaBarText()).toThrow('编辑栏的文档没有正文')
  })
})

describe('探针露出变更检测、公式收齐与进度、公式在哪里计算（M3-P4 设计 §3.15）', () => {
  it('读的是编辑器的跟踪器（每次调用时现读）与创建时定下的公式模式', () => {
    const { api } = fakeFacade()
    const state = { seq: 0, settled: true, progress: IDLE_PROGRESS }
    installEditorProbe(api, fakeWorkbook(() => ({})), undefined, { changes: fakeChanges(state), formulaMode: 'main-thread' })
    const probe = window.__nerveEditorProbe
    expect([probe?.changeSeq(), probe?.formulasSettled(), probe?.formulaProgress(), probe?.formulaMode]).toEqual([0, true, IDLE_PROGRESS, 'main-thread'])
    const running: FormulaProgress = { ...IDLE_PROGRESS, round: 1, started: true }
    Object.assign(state, { seq: 3, settled: false, progress: running })
    expect([probe?.changeSeq(), probe?.formulasSettled(), probe?.formulaProgress()]).toEqual([3, false, running])
  })
})

describe('探针给出页面里打包的链接地址判定（M3-P3 S2）', () => {
  it('canonicalLink 就是 contracts 的那一个（链接的改写器经 normalizeCellLinks 用的同一份代码）', () => {
    const { api } = fakeFacade()
    installEditorProbe(api, fakeWorkbook(() => ({})))
    expect(window.__nerveEditorProbe?.canonicalLink).toBe(canonicalLink)
    expect(window.__nerveEditorProbe?.canonicalLink('HTTPS://Example.COM')).toEqual({ ok: true, href: 'https://example.com/' })
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
