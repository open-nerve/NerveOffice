// 编辑器槽位：同一个容器里至多一个编辑器、至多一次创建在途（审查 A1）；视图状态交给下一个；接上之后随编辑器的生命周期。
// 销毁可能要等（M3-P4 设计 §3.14：主线程模式下先停下正在算的一轮）：旧的销毁完才新建，同一个容器里不同时有两个实例。
import type { EditorAccess, SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { createEditorSlot } from './editor-slot.ts'
import { settle } from './fake-lease-clock.test-support.ts'

interface FakeEditor {
  readonly editor: SheetEditor
  readonly access: EditorAccess
  readonly snapshot: string
  readonly viewState: SheetViewState | undefined
  /** dispose 被调用了 */
  disposed: boolean
  /** 真正销毁完了（holdDispose 时要等 finishDispose） */
  gone: boolean
  enter: (stage: SheetEditorLifecycle) => void
  /** 之后的 dispose 要等 finishDispose 才销毁完（主线程模式下等正在算的一轮停下） */
  holdDispose: () => void
  finishDispose: () => void
}

/** 第 n 个编辑器给出的视图状态 */
function viewStateOf(index: number): SheetViewState {
  return { sheetId: `sheet-${index}`, topLeft: { row: index, column: index }, selection: undefined }
}

/**
 * 由测试决定何时建好、建成什么样的工厂：每次创建排一个"闸"，release 放行、fail 让它失败；记下同时在建的个数，
 * 以及开始新建的那一刻还没销毁完的编辑器（应当一直是 0）
 */
function fakeFactory() {
  const created: FakeEditor[] = []
  const gates: { release: () => void, fail: (error: unknown) => void }[] = []
  let building = 0
  let mostBuilding = 0
  const aliveAtCreate: number[] = []
  /** 第几次创建出的编辑器一开始就让销毁要等 */
  const heldFromStart = new Set<number>()
  const createEditor = vi.fn(async (options: { snapshot: string, access: EditorAccess, viewState?: SheetViewState | undefined }): Promise<SheetEditor> => {
    aliveAtCreate.push(created.filter(fake => fake.disposed && !fake.gone).length)
    building += 1
    mostBuilding = Math.max(mostBuilding, building)
    try {
      await new Promise<void>((resolve, reject) => {
        gates.push({ release: resolve, fail: reject })
      })
    }
    finally {
      building -= 1
    }
    const index = created.length
    let stage: SheetEditorLifecycle = 'rendered'
    const listeners = new Set<(stage: SheetEditorLifecycle) => void>()
    let held = heldFromStart.has(index)
    let finish: () => void = () => {}
    const fake: FakeEditor = {
      access: options.access,
      snapshot: options.snapshot,
      viewState: options.viewState,
      disposed: false,
      gone: false,
      enter: (next) => {
        stage = next
        listeners.forEach(listener => listener(next))
      },
      holdDispose: () => {
        held = true
      },
      finishDispose: () => finish(),
      editor: {
        unitId: 'unit-1',
        changeSeq: () => 0,
        onChange: () => () => {},
        lifecycle: () => stage,
        onLifecycle: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        isCellEditing: () => false,
        uncommittedInput: () => 'none',
        onUncommittedInputChange: () => () => {},
        commitCellEditing: async () => true,
        settleFormulas: async () => 'settled',
        formulasSettled: () => true,
        onFormulaProgress: () => () => {},
        composing: () => false,
        onCompositionChange: () => () => {},
        settlePanels: async () => {},
        capture: () => options.snapshot,
        viewState: () => fake.disposed ? undefined : viewStateOf(index),
        openCheck: { ok: true },
        dispose: async () => {
          fake.disposed = true
          if (held) {
            await new Promise<void>((resolve) => {
              finish = resolve
            })
          }
          fake.gone = true
        },
      },
    }
    created.push(fake)
    return fake.editor
  })
  return {
    createEditor,
    created,
    /** 第 n 次创建（从 0 数）放行或失败 */
    gate: (index: number) => {
      const gate = gates[index]
      if (gate === undefined)
        throw new Error(`第 ${index} 次创建还没开始`)
      return gate
    },
    /** 同时在建的最多个数 */
    mostBuilding: () => mostBuilding,
    /** 每次开始新建的那一刻，已经开始销毁、还没销毁完的编辑器个数 */
    aliveAtCreate: () => [...aliveAtCreate],
    /** 第 n 次创建（从 0 数）出的编辑器，销毁要等它的 finishDispose */
    holdDisposeOf: (index: number) => {
      heldFromStart.add(index)
    },
  }
}

function setup() {
  const factory = fakeFactory()
  const onChange = vi.fn()
  const reportError = vi.fn()
  const slot = createEditorSlot({ createEditor: factory.createEditor, onChange, reportError })
  return { slot, factory, onChange, reportError }
}

/** 换一次并接上：交回接上的编辑器 */
async function replaced(context: ReturnType<typeof setup>, access: EditorAccess, snapshot: string): Promise<FakeEditor> {
  const replacing = context.slot.replace(access, snapshot)
  await settle()
  context.factory.gate(context.factory.createEditor.mock.calls.length - 1).release()
  const created = await replacing
  if (created === undefined)
    throw new Error('没有建好')
  context.slot.attach(created)
  const fake = context.factory.created.at(-1)
  if (fake === undefined)
    throw new Error('没有建好')
  return fake
}

describe('编辑器槽位（审查 A1）', () => {
  it('换编辑器：新建期间是 creating（还没有接上的编辑器）；建好交回、接上之后随它的生命周期；再换时先取出视图状态、销毁旧的', async () => {
    const context = setup()
    expect([context.slot.surface(), context.slot.editor()]).toEqual(['none', undefined])
    const replacing = context.slot.replace('read', 'A')
    expect(context.slot.surface()).toBe('creating')
    await settle()
    context.factory.gate(0).release()
    const created = await replacing
    // 交回了、还没接上：仍是 creating（页面的屏障挂着），调用方先建好要的东西再接上
    expect([context.slot.surface(), context.slot.editor()]).toEqual(['creating', undefined])
    context.slot.attach(created as SheetEditor)
    expect([context.slot.surface(), context.slot.editor()]).toEqual(['rendered', created])
    const first = context.factory.created[0] as FakeEditor
    first.enter('steady')
    expect(context.slot.surface()).toBe('steady')

    const second = await replaced(context, 'edit', 'B')
    expect(first.disposed).toBe(true)
    expect([second.access, second.snapshot, second.viewState]).toEqual(['edit', 'B', viewStateOf(0)])
    // 旧的编辑器的生命周期不再改 surface
    first.enter('rendered')
    expect(context.slot.surface()).toBe('rendered')
    second.enter('steady')
    expect(context.slot.surface()).toBe('steady')
    expect(context.onChange).toHaveBeenCalled()
  })

  it('强制全量重算（M3-P4 设计 §3.5）：replace 的 recalculate 交给工厂；不给时不带这一项', async () => {
    const context = setup()
    await replaced(context, 'read', 'A')
    const recalculating = context.slot.replace('edit', 'B', { recalculate: true })
    await settle()
    context.factory.gate(1).release()
    await recalculating
    expect(context.factory.createEditor.mock.calls.map(call => call[0])).toEqual([
      { snapshot: 'A', access: 'read', viewState: undefined },
      { snapshot: 'B', access: 'edit', viewState: viewStateOf(0), recalculate: true },
    ])
    expect(context.factory.createEditor.mock.calls[0]?.[0]).not.toHaveProperty('recalculate')
  })

  it('单飞：上一次创建还在途时再换，先等它结束、销毁它的结果（它交回 undefined），再建新的——同一时刻至多一次创建、至多一个编辑器', async () => {
    const context = setup()
    const reader = await replaced(context, 'read', 'A')
    const refreshing = context.slot.replace('read', 'B')
    await settle()
    const entering = context.slot.replace('edit', 'A')
    await settle()
    // 第二次还没开始建：等第一次
    expect(context.factory.createEditor).toHaveBeenCalledTimes(2)
    context.factory.gate(1).release()
    expect(await refreshing).toBeUndefined()
    await settle()
    expect(context.factory.createEditor).toHaveBeenCalledTimes(3)
    context.factory.gate(2).release()
    const writer = await entering
    expect(writer).toBeDefined()
    context.slot.attach(writer as SheetEditor)
    expect(context.factory.mostBuilding()).toBe(1)
    expect(context.factory.created.map(fake => [fake.access, fake.disposed])).toEqual([['read', true], ['read', true], ['edit', false]])
    // 被取代的那次没有接上过：视图状态照旧是最初那个编辑器的
    expect(context.factory.created[2]?.viewState).toEqual(viewStateOf(0))
    expect(reader.disposed).toBe(true)
    expect(context.slot.editor()).toBe(writer)
  })

  it('等着的不止一次：只有最后一次真的新建，中间的直接交回 undefined', async () => {
    const context = setup()
    const first = context.slot.replace('read', 'A')
    await settle()
    const second = context.slot.replace('read', 'B')
    const third = context.slot.replace('edit', 'C')
    context.factory.gate(0).release()
    expect(await first).toBeUndefined()
    expect(await second).toBeUndefined()
    await settle()
    context.factory.gate(1).release()
    expect(await third).toBeDefined()
    expect(context.factory.createEditor.mock.calls.map(call => call[0].snapshot)).toEqual(['A', 'C'])
    expect(context.factory.mostBuilding()).toBe(1)
  })

  it('交回之后、接上之前又换了：交回的那个由槽位销毁，再接上它什么也不做', async () => {
    const context = setup()
    const replacing = context.slot.replace('read', 'A')
    await settle()
    context.factory.gate(0).release()
    const stale = await replacing as SheetEditor
    const next = context.slot.replace('read', 'B')
    await settle()
    expect(context.factory.created[0]?.disposed).toBe(true)
    context.slot.attach(stale)
    expect([context.slot.surface(), context.slot.editor()]).toEqual(['creating', undefined])
    context.factory.gate(1).release()
    context.slot.attach(await next as SheetEditor)
    expect(context.slot.surface()).toBe('rendered')
  })

  it('新建失败：上报，surface 为 none、没有编辑器，交回 undefined；下一次照样恢复失败之前那个编辑器的视图状态', async () => {
    const context = setup()
    const reader = await replaced(context, 'read', 'A')
    const failing = context.slot.replace('edit', 'A')
    await settle()
    const error = new Error('Worker 起不来')
    context.factory.gate(1).fail(error)
    expect(await failing).toBeUndefined()
    expect(context.reportError).toHaveBeenCalledExactlyOnceWith(error)
    expect([context.slot.surface(), context.slot.editor()]).toEqual(['none', undefined])
    expect(reader.disposed).toBe(true)
    const fallback = await replaced(context, 'read', 'A')
    expect(fallback.viewState).toEqual(viewStateOf(0))
  })

  it('被取代的那次创建失败：不上报（没有人再关心它），不改 surface', async () => {
    const context = setup()
    const first = context.slot.replace('read', 'A')
    await settle()
    const second = context.slot.replace('read', 'B')
    context.factory.gate(0).fail(new Error('超时'))
    expect(await first).toBeUndefined()
    await settle()
    expect(context.reportError).not.toHaveBeenCalled()
    expect(context.slot.surface()).toBe('creating')
    context.factory.gate(1).release()
    expect(await second).toBeDefined()
  })

  it('清空（读不到了、页面卸载）：销毁现在的编辑器，在途的创建建好之后随即销毁，surface 为 none', async () => {
    const context = setup()
    const reader = await replaced(context, 'read', 'A')
    context.slot.clear()
    expect(reader.disposed).toBe(true)
    expect([context.slot.surface(), context.slot.editor()]).toEqual(['none', undefined])
    const replacing = context.slot.replace('read', 'B')
    await settle()
    context.slot.clear()
    context.factory.gate(1).release()
    expect(await replacing).toBeUndefined()
    expect(context.factory.created[1]?.disposed).toBe(true)
    expect(context.slot.surface()).toBe('none')
  })
})

describe('销毁要等时（M3-P4 设计 §3.14：主线程模式下先停下正在算的一轮）', () => {
  it('换编辑器：旧的销毁完才新建，等的期间 surface 已是 creating；同一个容器里不同时有两个实例', async () => {
    const context = setup()
    const reader = await replaced(context, 'read', 'A')
    reader.holdDispose()
    const entering = context.slot.replace('edit', 'A')
    expect(context.slot.surface()).toBe('creating')
    await settle()
    // 旧的还在销毁：没有开始新建
    expect(reader.disposed).toBe(true)
    expect(context.factory.createEditor).toHaveBeenCalledTimes(1)
    reader.finishDispose()
    await settle()
    expect(context.factory.createEditor).toHaveBeenCalledTimes(2)
    context.factory.gate(1).release()
    expect(await entering).toBeDefined()
    expect(context.factory.aliveAtCreate()).toEqual([0, 0])
  })

  it('等旧的销毁的期间又换了一次：这一次不建了（交回 undefined），最后一次在旧的销毁完之后才建', async () => {
    const context = setup()
    const reader = await replaced(context, 'read', 'A')
    reader.holdDispose()
    const first = context.slot.replace('edit', 'A')
    await settle()
    const second = context.slot.replace('read', 'B')
    await settle()
    expect(context.factory.createEditor).toHaveBeenCalledTimes(1)
    reader.finishDispose()
    expect(await first).toBeUndefined()
    await settle()
    expect(context.factory.createEditor).toHaveBeenCalledTimes(2)
    context.factory.gate(1).release()
    expect(await second).toBeDefined()
    expect(context.factory.createEditor.mock.calls.map(call => call[0].snapshot)).toEqual(['A', 'B'])
    expect(context.factory.aliveAtCreate()).toEqual([0, 0])
  })

  it('被取代的那次创建建好之后由槽位销毁：它销毁完之前不新建', async () => {
    const context = setup()
    context.factory.holdDisposeOf(0)
    const first = context.slot.replace('read', 'A')
    await settle()
    const second = context.slot.replace('read', 'B')
    context.factory.gate(0).release()
    expect(await first).toBeUndefined()
    await settle()
    // 第一次建好时已被取代：槽位开始销毁它，它还没销毁完，第二次还没开始建
    const stale = context.factory.created[0] as FakeEditor
    expect([stale.disposed, stale.gone]).toEqual([true, false])
    expect(context.factory.createEditor).toHaveBeenCalledTimes(1)
    stale.finishDispose()
    await settle()
    expect(context.factory.createEditor).toHaveBeenCalledTimes(2)
    context.factory.gate(1).release()
    expect(await second).toBeDefined()
    expect(context.factory.aliveAtCreate()).toEqual([0, 0])
  })

  it('先取后放（审查 B2）：交回了、还没接上的编辑器（可编辑的自检失败）销毁要等时，以只读重建要等它销毁完', async () => {
    const context = setup()
    context.factory.holdDisposeOf(0)
    const entering = context.slot.replace('edit', 'A')
    await settle()
    context.factory.gate(0).release()
    expect(await entering).toBeDefined()
    // 自检失败：不接上它，直接以只读重建（edit-mode.ts 的 backToReading）
    const reading = context.slot.replace('read', 'A')
    await settle()
    const handedOut = context.factory.created[0] as FakeEditor
    expect([handedOut.disposed, handedOut.gone]).toEqual([true, false])
    expect(context.factory.createEditor).toHaveBeenCalledTimes(1)
    handedOut.finishDispose()
    await settle()
    expect(context.factory.createEditor).toHaveBeenCalledTimes(2)
    context.factory.gate(1).release()
    expect(await reading).toBeDefined()
    expect(context.factory.aliveAtCreate()).toEqual([0, 0])
  })

  it('清空之后的销毁还没完：之后的换编辑器等它销毁完再建', async () => {
    const context = setup()
    const reader = await replaced(context, 'read', 'A')
    reader.holdDispose()
    context.slot.clear()
    expect([context.slot.surface(), context.slot.editor()]).toEqual(['none', undefined])
    const replacing = context.slot.replace('read', 'B')
    await settle()
    expect(context.factory.createEditor).toHaveBeenCalledTimes(1)
    reader.finishDispose()
    await settle()
    context.factory.gate(1).release()
    expect(await replacing).toBeDefined()
    expect(context.factory.aliveAtCreate()).toEqual([0, 0])
  })
})
