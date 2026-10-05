// 编辑器槽位：同一个容器里至多一个编辑器、至多一次创建在途（审查 A1）；视图状态交给下一个；接上之后随编辑器的生命周期。
import type { EditorAccess, SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { createEditorSlot } from './editor-slot.ts'
import { settle } from './fake-lease-clock.test-support.ts'

interface FakeEditor {
  readonly editor: SheetEditor
  readonly access: EditorAccess
  readonly snapshot: string
  readonly viewState: SheetViewState | undefined
  disposed: boolean
  enter: (stage: SheetEditorLifecycle) => void
}

/** 第 n 个编辑器给出的视图状态 */
function viewStateOf(index: number): SheetViewState {
  return { sheetId: `sheet-${index}`, topLeft: { row: index, column: index }, selection: undefined }
}

/** 由测试决定何时建好、建成什么样的工厂：每次创建排一个"闸"，release 放行、fail 让它失败；记下同时在建的个数 */
function fakeFactory() {
  const created: FakeEditor[] = []
  const gates: { release: () => void, fail: (error: unknown) => void }[] = []
  let building = 0
  let mostBuilding = 0
  const createEditor = vi.fn(async (options: { snapshot: string, access: EditorAccess, viewState?: SheetViewState | undefined }): Promise<SheetEditor> => {
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
    const fake: FakeEditor = {
      access: options.access,
      snapshot: options.snapshot,
      viewState: options.viewState,
      disposed: false,
      enter: (next) => {
        stage = next
        listeners.forEach(listener => listener(next))
      },
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
        hasPendingCellInput: () => false,
        onCellEditingChange: () => () => {},
        commitCellEditing: async () => true,
        settleFormulas: async () => 'settled',
        capture: () => options.snapshot,
        viewState: () => fake.disposed ? undefined : viewStateOf(index),
        openCheck: { ok: true },
        dispose: () => {
          fake.disposed = true
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
