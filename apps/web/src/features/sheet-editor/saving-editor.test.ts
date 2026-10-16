import type { SavingEditorSource } from './saving-editor.ts'
import { describe, expect, it, vi } from 'vitest'
import { createSavingEditor, SavingEditorInputError } from './saving-editor.ts'

function signal() {
  const listeners = new Set<() => void>()
  return {
    listeners,
    listen: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit: () => listeners.forEach(listener => listener()),
  }
}

function fixture(initialSeq = 7) {
  let seq = initialSeq
  const changes = signal()
  const input = signal()
  const formulas = signal()
  const composition = signal()
  const source = {
    changeSeq: vi.fn(() => seq),
    onChange: changes.listen,
    uncommittedInput: vi.fn<SavingEditorSource['uncommittedInput']>(() => 'none'),
    onUncommittedInputChange: input.listen,
    formulasSettled: vi.fn(() => true),
    onFormulaProgress: formulas.listen,
    composing: vi.fn(() => false),
    onCompositionChange: composition.listen,
    isCellEditing: vi.fn(() => false),
    commitCellEditing: vi.fn(async () => true),
    settlePanels: vi.fn(async () => {}),
    settleFormulas: vi.fn<SavingEditorSource['settleFormulas']>(async () => 'settled'),
    capture: vi.fn(() => `{"v":${seq}}`),
    dispose: vi.fn(),
  } satisfies SavingEditorSource & { dispose: () => void }
  return {
    source,
    signals: [changes, input, formulas, composition],
    edit: () => {
      seq += 1
      changes.emit()
    },
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('稳定的保存编辑器入口', () => {
  it('初次透传正文、序号、输入和公式；异步操作交给调用时的源', async () => {
    const { source } = fixture()
    const { editor } = createSavingEditor(source, vi.fn())
    expect(editor.changeSeq()).toBe(7)
    expect(editor.capture()).toBe('{"v":7}')
    expect(editor.uncommittedInput()).toBe('none')
    source.uncommittedInput.mockReturnValue('pending')
    expect(editor.uncommittedInput()).toBe('pending')
    source.isCellEditing.mockReturnValue(true)
    source.composing.mockReturnValue(true)
    expect(editor.isCellEditing()).toBe(true)
    expect(editor.composing()).toBe(true)
    expect(editor.formulasSettled()).toBe(true)
    await expect(editor.commitCellEditing()).resolves.toBe(true)
    await editor.settlePanels()
    await expect(editor.settleFormulas(51)).resolves.toBe('settled')
    expect(source.commitCellEditing).toHaveBeenCalledOnce()
    expect(source.settlePanels).toHaveBeenCalledOnce()
    expect(source.settleFormulas).toHaveBeenCalledWith(51)
  })

  it('冻结只捕获一次，之后不读旧模型；新源 3→4 对应会话 7→8', async () => {
    const old = fixture()
    const next = fixture(3)
    const binding = createSavingEditor(old.source, vi.fn())
    const progress = vi.fn()
    const changes = vi.fn()
    binding.editor.onFormulaProgress(progress)
    binding.editor.onChange(changes)
    const frozen = binding.freeze()
    expect(frozen).toEqual({ snapshot: '{"v":7}', editorSeq: 7 })
    old.source.capture.mockImplementation(() => {
      throw new Error('旧模型已销毁')
    })
    old.source.changeSeq.mockImplementation(() => {
      throw new Error('旧序号已销毁')
    })
    expect(binding.freeze()).toBe(frozen)
    expect(binding.editor.capture()).toBe('{"v":7}')
    expect(binding.editor.changeSeq()).toBe(7)
    expect(binding.editor.formulasSettled()).toBe(false)
    await expect(binding.editor.settleFormulas(500)).resolves.toBe('timeout')
    expect(binding.editor.isCellEditing()).toBe(false)
    expect(binding.editor.composing()).toBe(false)
    expect(binding.editor.uncommittedInput()).toBe('none')
    await expect(binding.editor.commitCellEditing()).resolves.toBe(true)
    await binding.editor.settlePanels()
    expect(old.source.commitCellEditing).not.toHaveBeenCalled()
    expect(old.source.settlePanels).not.toHaveBeenCalled()
    expect(progress).toHaveBeenCalledOnce()
    binding.bind(next.source)
    expect(binding.editor.changeSeq()).toBe(7)
    expect(binding.editor.capture()).toBe('{"v":3}')
    expect(changes).not.toHaveBeenCalled()
    expect(progress).toHaveBeenCalledTimes(2)
    next.edit()
    expect(binding.editor.changeSeq()).toBe(8)
    expect(changes).toHaveBeenCalledOnce()
    expect(binding.freeze()).toEqual({ snapshot: '{"v":4}', editorSeq: 8 })
    expect(old.source.dispose).not.toHaveBeenCalled()
  })

  it.each(['composing', 'isCellEditing', 'pending', 'open'] as const)('拒绝未完成输入 %s，之后仍跟踪原源', (kind) => {
    const old = fixture()
    if (kind === 'composing' || kind === 'isCellEditing')
      old.source[kind].mockReturnValue(true)
    else
      old.source.uncommittedInput.mockReturnValue(kind)
    const binding = createSavingEditor(old.source, vi.fn())
    const changed = vi.fn()
    binding.editor.onChange(changed)
    expect(() => binding.freeze()).toThrow(SavingEditorInputError)
    expect(old.source.capture).not.toHaveBeenCalled()
    old.edit()
    expect(binding.editor.changeSeq()).toBe(8)
    expect(changed).toHaveBeenCalledOnce()
    expect(old.source.commitCellEditing).not.toHaveBeenCalled()
  })

  it('捕获抛错时保留旧源及订阅，修好后仍能冻结', () => {
    const old = fixture()
    const failure = new Error('捕获失败')
    old.source.capture.mockImplementationOnce(() => {
      throw failure
    })
    const binding = createSavingEditor(old.source, vi.fn())
    const changed = vi.fn()
    binding.editor.onChange(changed)
    expect(() => binding.freeze()).toThrow(failure)
    old.edit()
    expect(changed).toHaveBeenCalledOnce()
    expect(binding.freeze()).toEqual({ snapshot: '{"v":8}', editorSeq: 8 })
  })

  it('四类信号在重绑后转交新源，挡住旧排队回调；逐一退订有效', () => {
    const old = fixture()
    const next = fixture(3)
    const binding = createSavingEditor(old.source, vi.fn())
    const observers = Array.from({ length: 4 }, () => vi.fn())
    const methods = ['onChange', 'onUncommittedInputChange', 'onFormulaProgress', 'onCompositionChange'] as const
    const stops = methods.map((method, index) => binding.editor[method](observers[index]!))
    old.signals.forEach(event => event.emit())
    observers.forEach(observer => expect(observer).toHaveBeenCalledOnce())
    const queued = old.signals.flatMap(event => [...event.listeners])
    binding.freeze()
    old.signals.forEach(event => expect(event.listeners.size).toBe(0))
    binding.bind(next.source)
    observers.forEach(observer => observer.mockClear())
    queued.forEach(listener => listener())
    old.signals.forEach(event => event.emit())
    observers.forEach(observer => expect(observer).not.toHaveBeenCalled())
    next.signals.forEach(event => event.emit())
    observers.forEach(observer => expect(observer).toHaveBeenCalledOnce())
    stops.forEach((stop, index) => {
      stop()
      next.signals[index]!.emit()
      expect(observers[index]).toHaveBeenCalledOnce()
    })
    binding.dispose()
    next.signals.forEach(event => expect(event.listeners.size).toBe(0))
  })

  it.each([false, true])('旧公式 Promise 结束时按新模型是否收齐 %s 返回', async (settled) => {
    const old = fixture()
    const next = fixture(3)
    const wait = deferred<'settled' | 'timeout'>()
    old.source.settleFormulas.mockReturnValue(wait.promise)
    next.source.formulasSettled.mockReturnValue(settled)
    const binding = createSavingEditor(old.source, vi.fn())
    const result = binding.editor.settleFormulas(200)
    binding.freeze()
    binding.bind(next.source)
    wait.resolve('settled')
    await expect(result).resolves.toBe(settled ? 'settled' : 'timeout')
    expect(next.source.settleFormulas).not.toHaveBeenCalled()
  })

  it('旧公式等待结束时仍冻结，不能说公式已收齐', async () => {
    const old = fixture()
    const wait = deferred<'settled' | 'timeout'>()
    old.source.settleFormulas.mockReturnValue(wait.promise)
    const binding = createSavingEditor(old.source, vi.fn())
    const result = binding.editor.settleFormulas(200)
    binding.freeze()
    wait.resolve('settled')
    await expect(result).resolves.toBe('timeout')
  })

  it('旧输入 Promise 结束不提交新源的后来输入，也不重新等待新面板', async () => {
    const old = fixture()
    const next = fixture(3)
    const commit = deferred<boolean>()
    const panels = deferred<void>()
    old.source.commitCellEditing.mockReturnValue(commit.promise)
    old.source.settlePanels.mockReturnValue(panels.promise)
    const binding = createSavingEditor(old.source, vi.fn())
    const committing = binding.editor.commitCellEditing()
    const waiting = binding.editor.settlePanels()
    binding.freeze()
    binding.bind(next.source)
    next.source.isCellEditing.mockReturnValue(true)
    commit.resolve(false)
    panels.resolve()
    await expect(committing).resolves.toBe(false)
    await waiting
    expect(next.source.commitCellEditing).not.toHaveBeenCalled()
    expect(next.source.settlePanels).not.toHaveBeenCalled()
  })

  it('一个观察者抛错仍通知其他观察者，并上报原错误', () => {
    const old = fixture()
    const report = vi.fn()
    const binding = createSavingEditor(old.source, report)
    const failure = new Error('观察者失败')
    const observer = vi.fn()
    binding.editor.onChange(() => {
      throw failure
    })
    binding.editor.onChange(observer)
    old.edit()
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
    expect(observer).toHaveBeenCalledOnce()
  })

  it('只允许冻结后绑定，dispose 释放正文和订阅而不销毁 SDK', () => {
    const old = fixture()
    const binding = createSavingEditor(old.source, vi.fn())
    expect(() => binding.bind(fixture().source)).toThrow()
    binding.freeze()
    binding.dispose()
    binding.dispose()
    expect(() => binding.bind(fixture().source)).toThrow()
    expect(() => binding.freeze()).toThrow()
    expect(() => binding.editor.capture()).toThrow()
    old.signals.forEach(event => expect(event.listeners.size).toBe(0))
    expect(old.source.dispose).not.toHaveBeenCalled()
  })
})
