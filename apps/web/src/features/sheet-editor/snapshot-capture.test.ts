import type { CaptureEditor } from './snapshot-capture.ts'
import { describe, expect, it, vi } from 'vitest'
import { EXPLICIT_SETTLE_TIMEOUT_MS, explicitCaptureSource } from './snapshot-capture.test-support.ts'
import { prepareCapture, takeSnapshot, utf8Length } from './snapshot-capture.ts'

/** 假的编辑器：seq 与内容可设；单元格编辑中时提交按 commitResult，提交成功算一处修改 */
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
      if (!state.commitResult)
        return false
      state.editing = false
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

describe('立即上传的准备：先等面板、提交单元格、再等公式，然后捕获（P4 设计 §3.4）', () => {
  it('单元格在编辑：先等面板的防抖，再提交（等同回车），再等公式，再捕获；提交算一处修改，捕获里有它', async () => {
    const { editor, order } = fakeEditor({ seq: 2, editing: true })
    const prepared = await prepareCapture(editor, { settleTimeoutMs: () => 1234, take: pending => takeSnapshot(editor, pending) })
    expect(order).toEqual(['panels', 'commit', 'settle', 'seq', 'capture'])
    expect(editor.settleFormulas).toHaveBeenCalledWith(1234)
    expect(prepared).toMatchObject({ seq: 3, formulasPending: false })
  })

  it('提交不了：中止，交回 cell-editing，不等公式、不捕获', async () => {
    const { editor, state } = fakeEditor({ editing: true })
    state.commitResult = false
    await expect(prepareCapture(editor, { settleTimeoutMs: () => 3000, take: pending => takeSnapshot(editor, pending) })).resolves.toBe('cell-editing')
    expect(editor.settleFormulas).not.toHaveBeenCalled()
    expect(editor.capture).not.toHaveBeenCalled()
  })

  it('公式在时限内没收齐：照常捕获，带上"公式待更新"', async () => {
    const { editor, state } = fakeEditor()
    state.settle = 'timeout'
    await expect(prepareCapture(editor, { settleTimeoutMs: () => 3000, take: pending => takeSnapshot(editor, pending) })).resolves.toMatchObject({ formulasPending: true })
  })

  it('交回 take 给出的那一份（自动保存记进"最近一次捕获"的同一个对象）', async () => {
    const { editor } = fakeEditor({ content: '乙' })
    const entry = { ...takeSnapshot(editor, false), serial: 7 }
    await expect(prepareCapture(editor, { settleTimeoutMs: () => 0, take: () => entry })).resolves.toBe(entry)
  })

  it('出错原样抛出（保存的状态机按意外的错误处理）', async () => {
    const { editor } = fakeEditor()
    const failure = new Error('SDK 出错')
    vi.mocked(editor.capture).mockImplementationOnce(() => {
      throw failure
    })
    await expect(prepareCapture(editor, { settleTimeoutMs: () => 0, take: pending => takeSnapshot(editor, pending) })).rejects.toBe(failure)
  })

  it('等公式的时限在等完面板、提交了单元格之后才取（从按下算，前面用掉的不再给公式）；算出负数时按 0', async () => {
    const { editor, order } = fakeEditor({ editing: true })
    const remaining = vi.fn(() => {
      order.push('timeout')
      return -5
    })
    await prepareCapture(editor, { settleTimeoutMs: remaining, take: pending => takeSnapshot(editor, pending) })
    expect(order).toEqual(['panels', 'commit', 'timeout', 'settle', 'seq', 'capture'])
    expect(editor.settleFormulas).toHaveBeenCalledWith(0)
  })

  it('面板的防抖还没到点：等它写进模型之后才捕获（批注里刚键入的字在捕获里）', async () => {
    const { editor, state } = fakeEditor({ content: '甲' })
    let land: () => void = () => {}
    vi.mocked(editor.settlePanels).mockImplementationOnce(async () => new Promise<void>((resolve) => {
      land = () => {
        state.content = '甲乙'
        state.seq += 1
        resolve()
      }
    }))
    const preparing = prepareCapture(editor, { settleTimeoutMs: () => 0, take: pending => takeSnapshot(editor, pending) })
    await Promise.resolve()
    expect(editor.capture).not.toHaveBeenCalled()
    land()
    await expect(preparing).resolves.toMatchObject({ seq: 1, snapshot: '{"content":"甲乙"}' })
  })
})

describe('显式保存的捕获来源', () => {
  it('等公式至多 3 秒（与捕获的上限同一个数），不算摘要', async () => {
    expect(EXPLICIT_SETTLE_TIMEOUT_MS).toBe(3000)
    const { editor } = fakeEditor({ seq: 1 })
    await expect(explicitCaptureSource(editor)()).resolves.toEqual({ seq: 1, snapshot: '{"content":"甲"}', bytes: 17, formulasPending: false, digest: undefined })
    expect(editor.settleFormulas).toHaveBeenCalledWith(3000)
  })
})
