import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeLocalSaveEdit } from './local-save-timing.ts'

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture() {
  vi.useFakeTimers()
  const status = document.createElement('span')
  status.dataset.slot = 'local-save-status'
  status.dataset.localSaveState = 'saved'
  document.body.append(status)
  const state = { seq: 4, round: 3, completed: true, stopped: false, settled: true }
  const setValue = vi.fn((_value: string | number) => {
    vi.advanceTimersByTime(7)
    state.seq += 1
    status.dataset.localSaveState = 'unsaved'
  })
  const getRange = vi.fn(() => ({ setValue }))
  const sheet = { getRange }
  const workbook = { getActiveSheet: () => sheet, getSheetByName: vi.fn(() => sheet) }
  const probe = {
    univerAPI: { getActiveWorkbook: () => workbook },
    changeSeq: () => state.seq,
    formulaProgress: () => ({ round: state.round, completed: state.completed, stopped: state.stopped }),
    formulasSettled: () => state.settled,
  }
  vi.stubGlobal('__nerveEditorProbe', probe)
  const disconnected = vi.spyOn(MutationObserver.prototype, 'disconnect')
  return { status, state, probe, workbook, setValue, getRange, disconnected }
}

const edit = { cell: 'B2', value: '本轮', formula: false }

// 立即接住失败，模拟时钟推进后再断言；失败的实现不能制造未处理拒绝噪音。
async function resultOf<T>(promise: Promise<T>): Promise<T | Error> {
  return promise.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
}

function errorMessage(value: unknown): string {
  if (!(value instanceof Error))
    throw new Error('测量未按预期失败')
  return value.message
}

describe('浏览器内本机保存计时', () => {
  it('起点包含同步命令，必须先观察新一轮未保存，再以本轮 saved 结束并清理', async () => {
    const f = fixture()
    vi.advanceTimersByTime(100)
    let finished = false
    const measured = resultOf(observeLocalSaveEdit(edit).then((value) => {
      finished = true
      return value
    }))
    await Promise.resolve()
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(93)
    f.status.dataset.localSaveState = 'saved'
    expect(await measured).toEqual({ startedAt: 100, savedAt: 200, localSavedMs: 100, commandMs: 7, formulaSettledMs: 0, editorSeq: 5 })
    expect(f.getRange).toHaveBeenCalledWith('B2')
    expect(f.setValue).toHaveBeenCalledWith('本轮')
    expect(f.disconnected).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('指定工作表并只接受新一轮已完成且未停止的公式', async () => {
    const f = fixture()
    f.state.completed = false
    f.state.settled = false
    const measured = resultOf(observeLocalSaveEdit({ ...edit, sheet: '明细', formula: true }))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)
    f.state.round = 4
    f.state.completed = true
    f.state.settled = true
    await vi.advanceTimersByTimeAsync(20)
    f.status.dataset.localSaveState = 'saved'
    const result = await measured
    if (result instanceof Error)
      throw result
    expect(result.formulaSettledMs).toBeGreaterThanOrEqual(57)
    expect(result.formulaSettledMs).toBeLessThanOrEqual(result.localSavedMs)
    expect(result.editorSeq).toBe(5)
    expect(f.workbook.getSheetByName).toHaveBeenCalledWith('明细')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['旧 saved 没有变化', '只收到 saved 变动'] as const)('%s 不可结束本轮，15 秒后失败并清理', async (kind) => {
    const f = fixture()
    f.setValue.mockImplementation(() => {
      f.state.seq += 1
    })
    const measured = resultOf(observeLocalSaveEdit(edit))
    await Promise.resolve()
    if (kind === '只收到 saved 变动')
      f.status.dataset.localSaveState = 'saved'
    await vi.advanceTimersByTimeAsync(15_000)
    expect(errorMessage(await measured)).toContain('15 秒内未观察到本轮本机保存完成')
    expect(f.disconnected).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('序号没有增加时立即失败，不留下观察器或定时器', async () => {
    const f = fixture()
    f.setValue.mockImplementation(() => {})
    await expect(observeLocalSaveEdit(edit)).rejects.toThrow('没有产生新的编辑序号')
    expect(f.disconnected).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('公开修改命令报错时传播原错并清理', async () => {
    const f = fixture()
    const error = new Error('公开修改失败')
    f.setValue.mockImplementation(() => {
      throw error
    })
    await expect(observeLocalSaveEdit(edit)).rejects.toBe(error)
    expect(f.disconnected).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { label: '旧轮', round: 3, completed: true, stopped: false, settled: true },
    { label: '未完成', round: 4, completed: false, stopped: false, settled: true },
    { label: '已停止', round: 4, completed: true, stopped: true, settled: true },
    { label: '未收齐', round: 4, completed: true, stopped: false, settled: false },
  ])('本机 saved 时公式仍为 $label，拒绝形成成功样本', async ({ label: _label, ...progress }) => {
    const f = fixture()
    const measured = resultOf(observeLocalSaveEdit({ ...edit, formula: true }))
    await Promise.resolve()
    Object.assign(f.state, progress)
    f.status.dataset.localSaveState = 'saved'
    expect(errorMessage(await measured)).toContain('本轮公式尚未完成')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('实际未保存状态持续到期限时失败', async () => {
    const f = fixture()
    const measured = resultOf(observeLocalSaveEdit(edit))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(errorMessage(await measured)).toContain('sawUnsaved=true')
    expect(f.disconnected).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['probe', 'status', 'workbook', 'sheet'] as const)('缺少 %s 前提时不开始计时', async (missing) => {
    const f = fixture()
    if (missing === 'probe')
      vi.stubGlobal('__nerveEditorProbe', undefined)
    if (missing === 'status')
      f.status.remove()
    if (missing === 'workbook')
      Object.assign(f.probe.univerAPI, { getActiveWorkbook: () => null })
    if (missing === 'sheet')
      Object.assign(f.workbook, { getActiveSheet: () => null })
    await expect(observeLocalSaveEdit(edit)).rejects.toThrow(/没有准备好|工作簿|工作表/)
    expect(f.setValue).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
