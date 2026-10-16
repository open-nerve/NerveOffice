import type { FormulaWorkerFailure, SheetEditor } from '../../editor/index.ts'
import type { CreateModeEditor } from './editor-slot.ts'
import { describe, expect, it, vi } from 'vitest'
import { FormulaWorkerError, SheetEditorLoadError } from '../../editor/index.ts'
import { deferred, editorFixture } from './editing-session.test-support.ts'
import { createFormulaFallback } from './formula-fallback.ts'

vi.hoisted(() => {
  // 与适配层档案测试相同：公开出口会求值 UI 档案，此处只用真实错误类型，不运行 Canvas。
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

function setup() {
  const created: SheetEditor = {
    ...editorFixture().editor,
    unitId: 'unit-1',
    formulaMode: 'main-thread',
    workerFailure: () => undefined,
    onWorkerFailure: () => () => {},
    lifecycle: () => 'rendered',
    onLifecycle: () => () => {},
    viewState: () => undefined,
    openCheck: { ok: true },
    dispose: vi.fn(async () => {}),
  }
  const createEditor = vi.fn<CreateModeEditor>(async () => created)
  const onChange = vi.fn()
  return { created, createEditor, onChange, fallback: createFormulaFallback({ createEditor, onChange }) }
}

const INPUT: Parameters<CreateModeEditor>[0] = { snapshot: '{"v":1}', access: 'edit', viewState: { sheetId: 'sheet-1', topLeft: { row: 7, column: 3 }, selection: undefined } }

describe('本页公式执行模式的退路', () => {
  it('没有故障时完整透传原参数，不主动选择模式或强制重算', async () => {
    const { fallback, created, createEditor, onChange } = setup()
    await expect(fallback.createEditor(INPUT)).resolves.toBe(created)
    expect(createEditor).toHaveBeenCalledExactlyOnceWith(INPUT)
    expect(fallback.mode()).toBeUndefined()
    expect(fallback.failure()).toBeUndefined()
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each<FormulaWorkerFailure>(['create', 'error-before-ready', 'messageerror-before-ready', 'ready-timeout', 'image-policy', 'error-after-ready', 'messageerror-after-ready'])('%s 后只重建一次，原输入/access/视图保持，强制重算', async (failure) => {
    const { fallback, created, createEditor, onChange } = setup()
    createEditor.mockRejectedValueOnce(new FormulaWorkerError(failure))
    await expect(fallback.createEditor(INPUT)).resolves.toBe(created)
    expect(createEditor.mock.calls.map(([input]) => input)).toEqual([INPUT, { ...INPUT, formulaMode: 'main-thread', recalculate: true }])
    expect(fallback.mode()).toBe('main-thread')
    expect(fallback.failure()).toBe(failure)
    expect(onChange).toHaveBeenCalledOnce()
    expect(created.dispose).not.toHaveBeenCalled()
    await fallback.createEditor({ snapshot: '{"v":2}', access: 'read' })
    expect(createEditor).toHaveBeenLastCalledWith({ snapshot: '{"v":2}', access: 'read', formulaMode: 'main-thread', recalculate: true })
  })

  it.each([
    new SheetEditorLoadError('ready-timeout', '渲染没有完成'),
    new SheetEditorLoadError('image-policy-failed', '主线程 IMAGE 失败'),
    new Error('创建编辑器时普通失败'),
  ])('普通错误不触发退路：$message', async (error) => {
    const { fallback, createEditor, onChange } = setup()
    createEditor.mockRejectedValueOnce(error)
    await expect(fallback.createEditor(INPUT)).rejects.toBe(error)
    expect(createEditor).toHaveBeenCalledOnce()
    expect(fallback.mode()).toBeUndefined()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('主线程重建也失败只交回这次错误，不循环尝试', async () => {
    const { fallback, createEditor, onChange } = setup()
    const failure = new Error('主线程渲染失败')
    createEditor.mockRejectedValueOnce(new FormulaWorkerError('create')).mockRejectedValueOnce(failure)
    await expect(fallback.createEditor(INPUT)).rejects.toBe(failure)
    expect(createEditor).toHaveBeenCalledTimes(2)
    expect(fallback.failure()).toBe('create')
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('显式主线程不再降级；原模式被本页真实故障更新后不能切回 Worker', async () => {
    const { fallback, createEditor } = setup()
    const error = new FormulaWorkerError('create')
    createEditor.mockRejectedValueOnce(error)
    await expect(fallback.createEditor({ ...INPUT, formulaMode: 'main-thread' })).rejects.toBe(error)
    expect(createEditor).toHaveBeenCalledOnce()
    expect(fallback.mode()).toBeUndefined()
    fallback.failed('error-after-ready')
    await fallback.createEditor({ ...INPUT, formulaMode: 'worker', recalculate: false })
    expect(createEditor).toHaveBeenLastCalledWith({ ...INPUT, formulaMode: 'main-thread', recalculate: true })
  })

  it('运行期首错锁存，重复或另一种故障不重复通知', () => {
    const { fallback, onChange } = setup()
    fallback.failed('error-after-ready')
    fallback.failed('messageerror-after-ready')
    fallback.failed('error-after-ready')
    expect(fallback.failure()).toBe('error-after-ready')
    expect(fallback.mode()).toBe('main-thread')
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('等待失败工厂完成自己的清理，之后才调用主线程创建', async () => {
    const { fallback, createEditor } = setup()
    const cleanup = deferred<void>()
    createEditor.mockImplementationOnce(async () => {
      await cleanup.promise
      throw new FormulaWorkerError('error-before-ready')
    })
    const creating = fallback.createEditor(INPUT)
    await Promise.resolve()
    expect(createEditor).toHaveBeenCalledOnce()
    cleanup.resolve()
    await creating
    expect(createEditor).toHaveBeenCalledTimes(2)
  })
})
