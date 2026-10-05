import type { CaptureEditor } from './snapshot-capture.ts'
import { describe, expect, it, vi } from 'vitest'
import { EXPLICIT_SETTLE_TIMEOUT_MS, explicitCaptureSource } from './snapshot-capture.test-support.ts'
import { captureSettled, settleInputs, takeSnapshot, utf8Length } from './snapshot-capture.ts'

/**
 * 假的编辑器：seq 与内容可设；单元格编辑中时提交按 commitResult，提交成功算一处修改。与 SDK 一样，提交在调用的这一刻就关上单元格编辑器
 * （提交之后仍在编辑的情形按 commitResult 为假时重新打开），写入在之后的一个微任务里
 */
function fakeEditor(initial: { seq?: number, content?: string, editing?: boolean } = {}) {
  const state = { seq: initial.seq ?? 0, content: initial.content ?? '甲', editing: initial.editing ?? false, commitResult: true, settle: 'settled' as 'settled' | 'timeout' }
  const order: string[] = []
  const editor: CaptureEditor = {
    changeSeq: vi.fn(() => {
      order.push('seq')
      return state.seq
    }),
    isCellEditing: () => state.editing,
    commitCellEditing: vi.fn(async () => {
      order.push('commit')
      state.editing = false
      await Promise.resolve()
      if (!state.commitResult) {
        state.editing = true
        return false
      }
      state.seq += 1
      return true
    }),
    settleFormulas: vi.fn(async () => {
      order.push('settle')
      return state.settle
    }),
    settlePanels: vi.fn(async () => {
      order.push('panels')
    }),
    capture: vi.fn(() => {
      order.push('capture')
      return JSON.stringify({ content: state.content })
    }),
  }
  return { editor, state, order }
}

describe('同步捕获（计划书 §7.2：localSeq 在捕获这一步分配）', () => {
  it('序号与快照在同一个同步段里读出；大小是 UTF-8 字节；摘要另算（undefined）', () => {
    const { editor, order } = fakeEditor({ seq: 4, content: '甲乙' })
    expect(takeSnapshot(editor, true)).toEqual({ seq: 4, snapshot: '{"content":"甲乙"}', bytes: 20, formulasPending: true, digest: undefined })
    expect(order).toEqual(['seq', 'capture'])
    expect(utf8Length('a甲')).toBe(4)
  })
})

describe('立即上传在按下这一刻的准备：提交这一刻开着的单元格编辑、再等面板（P4 设计 §3.4，审查 A1）', () => {
  it('单元格在编辑：调用的这一刻就提交（同步关上单元格编辑器，之后才开始的输入不在其中），再等面板的防抖；提交算一处修改', async () => {
    const { editor, state, order } = fakeEditor({ seq: 2, editing: true })
    const settling = settleInputs(editor)
    // 还没有任何 await 执行完：提交已经发起，单元格编辑器已经关上
    expect(order).toEqual(['commit'])
    expect(state.editing).toBe(false)
    await expect(settling).resolves.toBe('settled')
    expect(order).toEqual(['commit', 'panels'])
    expect(state.seq).toBe(3)
  })

  it('没有在编辑：不提交，只等面板', async () => {
    const { editor, order } = fakeEditor()
    await expect(settleInputs(editor)).resolves.toBe('settled')
    expect(order).toEqual(['panels'])
    expect(editor.commitCellEditing).not.toHaveBeenCalled()
  })

  it('提交不了（提交之后仍在编辑）：交回 cell-editing', async () => {
    const { editor, state } = fakeEditor({ editing: true })
    state.commitResult = false
    await expect(settleInputs(editor)).resolves.toBe('cell-editing')
  })

  it('面板的防抖还没到点：等它写进模型之后才兑现（批注里刚键入的字随后在捕获里）', async () => {
    const { editor, state } = fakeEditor({ content: '甲' })
    let land: () => void = () => {}
    vi.mocked(editor.settlePanels).mockImplementationOnce(async () => new Promise<void>((resolve) => {
      land = () => {
        state.content = '甲乙'
        state.seq += 1
        resolve()
      }
    }))
    let done = false
    const settling = settleInputs(editor).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    land()
    await settling
    expect(takeSnapshot(editor, false)).toMatchObject({ seq: 1, snapshot: '{"content":"甲乙"}' })
  })

  it('出错原样抛出（保存的状态机按意外的错误处理）', async () => {
    const { editor } = fakeEditor({ editing: true })
    const failure = new Error('SDK 出错')
    vi.mocked(editor.commitCellEditing).mockRejectedValueOnce(failure)
    await expect(settleInputs(editor)).rejects.toBe(failure)
  })
})

describe('轮到这一次上传时：等公式（至多到时限），然后捕获', () => {
  it('公式收齐：不带标记；时限在调用时才取（从按下算，排队与准备用掉的不再给公式）', async () => {
    const { editor, order } = fakeEditor({ seq: 2 })
    const remaining = vi.fn(() => {
      order.push('timeout')
      return 1234
    })
    await expect(captureSettled(editor, { settleTimeoutMs: remaining, take: pending => takeSnapshot(editor, pending) })).resolves.toMatchObject({ seq: 2, formulasPending: false })
    expect(order).toEqual(['timeout', 'settle', 'seq', 'capture'])
    expect(editor.settleFormulas).toHaveBeenCalledWith(1234)
  })

  it('公式在时限内没收齐：照常捕获，带上"公式待更新"；算出负数的时限按 0', async () => {
    const { editor, state } = fakeEditor()
    state.settle = 'timeout'
    await expect(captureSettled(editor, { settleTimeoutMs: () => -5, take: pending => takeSnapshot(editor, pending) })).resolves.toMatchObject({ formulasPending: true })
    expect(editor.settleFormulas).toHaveBeenCalledWith(0)
  })

  it('交回 take 给出的那一份（自动保存记进"最近一次捕获"的同一个对象）', async () => {
    const { editor } = fakeEditor({ content: '乙' })
    const entry = { ...takeSnapshot(editor, false), serial: 7 }
    await expect(captureSettled(editor, { settleTimeoutMs: () => 0, take: () => entry })).resolves.toBe(entry)
  })

  it('出错原样抛出（保存的状态机按意外的错误处理）', async () => {
    const { editor } = fakeEditor()
    const failure = new Error('SDK 出错')
    vi.mocked(editor.capture).mockImplementationOnce(() => {
      throw failure
    })
    await expect(captureSettled(editor, { settleTimeoutMs: () => 0, take: pending => takeSnapshot(editor, pending) })).rejects.toBe(failure)
  })
})

describe('显式保存的捕获来源（保存的状态机的单元测试用：轮到时整套做完）', () => {
  it('提交单元格、等面板、等公式至多 3 秒（与捕获的上限同一个数）、捕获，不算摘要', async () => {
    expect(EXPLICIT_SETTLE_TIMEOUT_MS).toBe(3000)
    const { editor, order } = fakeEditor({ seq: 1, editing: true })
    await expect(explicitCaptureSource(editor)()).resolves.toEqual({ seq: 2, snapshot: '{"content":"甲"}', bytes: 17, formulasPending: false, digest: undefined })
    expect(order).toEqual(['commit', 'panels', 'settle', 'seq', 'capture'])
    expect(editor.settleFormulas).toHaveBeenCalledWith(3000)
  })

  it('提交不了：中止，交回 cell-editing，不等公式、不捕获', async () => {
    const { editor, state } = fakeEditor({ editing: true })
    state.commitResult = false
    await expect(explicitCaptureSource(editor)()).resolves.toBe('cell-editing')
    expect(editor.settleFormulas).not.toHaveBeenCalled()
    expect(editor.capture).not.toHaveBeenCalled()
  })
})
