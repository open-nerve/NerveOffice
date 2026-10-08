import type { SaveContentResponse } from '@nerve-office/contracts'
import type { PreparedCapture, SaveEditor, SaveFailure, SaveOptions, SaveOutcome, SaveRequest, SnapshotCapture } from './save-coordinator.ts'
import type { CaptureEditor } from './snapshot-capture.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, ResponseFormatError } from '../../shared/api/index.ts'
import { classifySaveError, createSaveCoordinator } from './save-coordinator.ts'
import { explicitCaptureSource } from './snapshot-capture.test-support.ts'

const ME = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const OTHER_TAB = '0199a2c4-1f2e-4a3b-8c4d-00000000bbbb'

/** 显式保存（保存按钮、快捷键）：一律上传，在途时排一次 */
const EXPLICIT: SaveOptions = { dedupe: false }

/**
 * 假的编辑器：edit() 是一次修改；可以设定正在编辑、提交的结果与公式收齐的结果。还没写进模型的输入按适配层的口径合成一个状态
 * （uncommitted-input.ts）：startCellEditing 打开单元格编辑器，typed 为真时编辑中的内容已经改动（还没提交的输入）；typeInPanel 是面板里
 * 按 SDK 的防抖还没写进模型的输入，panelSettled 是它到点（给了 text 时 SDK 这时把它写进模型，是一次修改；没给时是没有改动）
 */
function fakeEditor() {
  let seq = 0
  let content = '初始'
  let editing = false
  let pendingInput = false
  let panelInput = false
  const listeners = new Set<() => void>()
  const inputListeners = new Set<() => void>()
  const notify = (): void => listeners.forEach(listener => listener())
  const notifyInput = (): void => inputListeners.forEach(listener => listener())
  const setPendingInput = (next: boolean): void => {
    pendingInput = next
    notifyInput()
  }
  const control = {
    commitResult: true,
    settle: 'settled' as 'settled' | 'timeout',
    edit(text: string): void {
      content = text
      seq += 1
      notify()
    },
    startCellEditing(text: string, typed = true): void {
      editing = true
      content = text
      setPendingInput(typed)
    },
    /** 编辑中的内容改动了（例如双击打开之后键入） */
    typeInCellEditor(): void {
      setPendingInput(true)
    },
    /** 按 Esc 放弃编辑 */
    cancelCellEditing(): void {
      editing = false
      setPendingInput(false)
    },
    /** 在面板里键入（批注浮层、数据验证面板）：按 SDK 的防抖还没写进模型 */
    typeInPanel(): void {
      panelInput = true
      notifyInput()
    },
    /** 面板的防抖到点：text 是 SDK 这时写进模型的内容，没给时是没有改动 */
    panelSettled(text?: string): void {
      if (text !== undefined)
        control.edit(text)
      panelInput = false
      notifyInput()
    },
  }
  const editor: SaveEditor & CaptureEditor = {
    changeSeq: () => seq,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    isCellEditing: () => editing,
    uncommittedInput: () => pendingInput || panelInput ? 'pending' : editing ? 'open' : 'none',
    onUncommittedInputChange: (listener) => {
      inputListeners.add(listener)
      return () => inputListeners.delete(listener)
    },
    commitCellEditing: vi.fn(async () => {
      if (!control.commitResult)
        return false
      editing = false
      seq += 1
      setPendingInput(false)
      notify()
      return true
    }),
    settleFormulas: vi.fn(async () => control.settle),
    settlePanels: vi.fn(async () => {}),
    capture: vi.fn(() => JSON.stringify({ content })),
  }
  return { editor, control }
}

interface PendingSend {
  readonly request: SaveRequest
  /** 压缩之后的正文（假的压缩：快照的 UTF-8 字节） */
  readonly body: Uint8Array
  resolve: (response: SaveContentResponse) => void
  reject: (error: unknown) => void
}

/** 假的上传：每次调用挂起，由测试决定结果 */
function fakeSend() {
  const calls: PendingSend[] = []
  const send = vi.fn(async (request: SaveRequest, body: Uint8Array<ArrayBuffer>) => new Promise<SaveContentResponse>((resolve, reject) => {
    calls.push({ request, body, resolve, reject })
  }))
  return { send, calls }
}

/** 假的压缩：快照的 UTF-8 字节 */
const fakeCompress = vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot))

let idSequence = 0
function setup(overrides: { baseRevision?: number, maxSnapshotBytes?: number, initialFormulasPending?: boolean } = {}) {
  const { editor, control } = fakeEditor()
  const { send, calls } = fakeSend()
  const onUnauthenticated = vi.fn()
  const onSessionStale = vi.fn()
  const reportError = vi.fn()
  // 每次新建：模块级的 fakeCompress 是同一个 mock，包一层的调用次数会跨用例累计
  const compress = vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot))
  const real = createSaveCoordinator({
    editor,
    compress,
    send,
    baseRevision: overrides.baseRevision ?? 1,
    clientInstanceId: ME,
    newRequestId: () => {
      idSequence += 1
      return `request-${idSequence}`
    },
    onUnauthenticated,
    onSessionStale,
    reportError,
    maxSnapshotBytes: overrides.maxSnapshotBytes,
    initialFormulasPending: overrides.initialFormulasPending,
  })
  // 下面的用例大多按"按一次保存"写：coordinator.save() 是显式保存——先提交单元格、等公式至多 3 秒再捕获（snapshot-capture.ts 的来源），
  // 一律上传。M3-P4 起保存的状态机不自己捕获，捕获由来源给出（设计 §3.1），新入口的用例直接用 real.save(来源, 选项)
  const coordinator = { ...real, save: async () => real.save(explicitCaptureSource(editor), EXPLICIT) }
  return { coordinator, real, editor, control, compress, send, calls, onUnauthenticated, onSessionStale, reportError }
}

/** 等保存流程走到发出请求（提交编辑、等公式收齐都是异步的） */
async function sent(calls: PendingSend[], count: number): Promise<PendingSend> {
  await vi.waitFor(() => expect(calls.length).toBe(count))
  const call = calls[count - 1]
  if (call === undefined)
    throw new Error('没有发出请求')
  return call
}

function saved(revision: number): SaveContentResponse {
  return { revision, savedAt: '2026-09-27T08:00:00.000Z', unchanged: false }
}

function conflictError(currentRevision: number, source: { clientInstanceId: string, localSeq: number } | null): ApiError {
  return new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', '别处保存了更新的版本', { details: { currentRevision, source } })
}

describe('保存状态', () => {
  it('打开时已保存；修改之后有未保存的修改；保存中；成功后已保存到云端，基准修订号前进', async () => {
    const { coordinator, control, calls } = setup({ baseRevision: 4 })
    expect(coordinator.view().status).toBe('clean')
    control.edit('甲')
    expect(coordinator.view().status).toBe('dirty')

    const saving = coordinator.save()
    // 保存中仍可以再按（排一次，M3-P4 设计 §3.9：保存按钮不再随"保存中"变灰）
    expect(coordinator.view()).toMatchObject({ status: 'saving', canSave: true })
    const first = await sent(calls, 1)
    expect(first.request).toMatchObject({ baseRevision: 4, clientInstanceId: ME, localSeq: 1, snapshot: '{"content":"甲"}' })
    first.resolve(saved(5))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'clean', canSave: true, problem: undefined })

    control.edit('乙')
    const again = coordinator.save()
    ;(await sent(calls, 2)).resolve(saved(6))
    await again
    expect(calls[1]?.request).toMatchObject({ baseRevision: 5, localSeq: 2 })
    expect(calls[1]?.request.requestId).not.toBe(calls[0]?.request.requestId)
  })

  // M3-P4 设计 §3.4、§3.9：原来"保存中再按不做任何事"，改为在途时按下排一次——在途的那一次结束之后立即再存一次（捕获的是那一刻的内容）；
  // 同一时间仍只有一个请求在途。连按只排一次由自动保存的调度合并（autosave.test.ts，审查 A2），这里每次调用都是自己的一次
  it('保存中再按：排在后面，在途的结束之后立即再存一次（捕获的是那一刻的内容）；同一时间只有一个请求在途', async () => {
    const { coordinator, control, calls, send } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    const first = await sent(calls, 1)
    control.edit('甲乙')
    const again = coordinator.save()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    first.resolve(saved(2))
    await saving
    const second = await sent(calls, 2)
    expect(second.request).toMatchObject({ baseRevision: 2, localSeq: 2, snapshot: '{"content":"甲乙"}' })
    expect(coordinator.view().status).toBe('saving')
    second.resolve(saved(3))
    await expect(again).resolves.toEqual({ kind: 'saved', requestId: second.request.requestId })
    expect(send).toHaveBeenCalledTimes(2)
    expect(coordinator.view().status).toBe('clean')
  })

  it('保存期间继续修改：回包后仍是有未保存的修改（已保存的序号只前进到捕获时，A08）', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    const request = await sent(calls, 1)
    control.edit('甲乙')
    expect(coordinator.view().status).toBe('saving')
    request.resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('dirty')
    expect(coordinator.hasUnsavedWork()).toBe(true)
  })

  it('没有修改也可以保存：照常上传', async () => {
    const { coordinator, calls } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(calls[0]?.request.localSeq).toBe(0)
    expect(coordinator.view().status).toBe('clean')
  })

  it('没有变化时不重复通知：视图对象不变', () => {
    const { coordinator, control } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    const before = coordinator.view()
    control.edit('甲')
    control.edit('乙')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(coordinator.view()).not.toBe(before)
    const dirty = coordinator.view()
    control.edit('丙')
    expect(coordinator.view()).toBe(dirty)
  })
})

describe('有没有服务端还没确认的内容（unsaved：只看内容，不看保存的状态，M3-P1 审查 B3）', () => {
  it('打开时没有；修改之后有；保存成功之后没有', async () => {
    const { coordinator, control, calls } = setup()
    expect(coordinator.view().unsaved).toBe(false)
    control.edit('甲')
    expect(coordinator.view().unsaved).toBe(true)
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view().unsaved).toBe(false)
  })

  it('没有修改时按保存、保存被拒：状态是保存失败，内容却都已确认，不算有；有修改时被拒才算有', async () => {
    const denied = new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
    const clean = setup()
    const first = clean.coordinator.save()
    ;(await sent(clean.calls, 1)).reject(denied)
    await first
    expect(clean.coordinator.view()).toMatchObject({ status: 'failed', unsaved: false })

    const dirty = setup()
    dirty.control.edit('甲')
    const second = dirty.coordinator.save()
    ;(await sent(dirty.calls, 1)).reject(denied)
    await second
    expect(dirty.coordinator.view()).toMatchObject({ status: 'failed', unsaved: true })
  })

  it('单元格里还有没提交的输入：算有；按 Esc 放弃之后不算', () => {
    const { coordinator, control } = setup()
    control.startCellEditing('甲')
    expect(coordinator.view().unsaved).toBe(true)
    control.cancelCellEditing()
    expect(coordinator.view().unsaved).toBe(false)
  })

  it('公式结果尚未保存：算有', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('=SUM(A1:A9)')
    control.settle = 'timeout'
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view()).toMatchObject({ formulasPending: true, unsaved: true })
  })

  it('版本冲突之后：本页的内容没有存进去，算有', async () => {
    const { coordinator, calls } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(conflictError(3, { clientInstanceId: OTHER_TAB, localSeq: 7 }))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'conflict', unsaved: true })
  })
})

describe('单元格里还没提交的输入（Codex 评审 CX6）', () => {
  it('键入之后还没回车：有未保存的修改；按 Esc 放弃，回到已保存到云端', () => {
    const { coordinator, control } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    control.startCellEditing('还没回车')
    expect(coordinator.view().status).toBe('dirty')
    expect(listener).toHaveBeenCalledOnce()
    control.cancelCellEditing()
    expect(coordinator.view().status).toBe('clean')
    expect(coordinator.hasUnsavedWork()).toBe(false)
  })

  it('只是打开单元格编辑器、还没改动：仍是已保存到云端，离开时照样提示；改动之后有未保存的修改', () => {
    const { coordinator, control } = setup()
    control.startCellEditing('初始', false)
    expect(coordinator.view().status).toBe('clean')
    expect(coordinator.hasUnsavedWork()).toBe(true)
    control.typeInCellEditor()
    expect(coordinator.view().status).toBe('dirty')
  })

  it('保存成功之后又在单元格里键入：立即是有未保存的修改', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('clean')
    control.startCellEditing('乙')
    expect(coordinator.view().status).toBe('dirty')
  })

  it('保存期间在单元格里键入：仍显示保存中，回包之后是有未保存的修改', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    const request = await sent(calls, 1)
    control.startCellEditing('乙')
    expect(coordinator.view().status).toBe('saving')
    request.resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('dirty')
  })

  it('销毁之后不再通知', () => {
    const { coordinator, control } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    coordinator.dispose()
    control.startCellEditing('甲')
    control.typeInPanel()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('面板里还没写进模型的输入（Codex 评审 CX4，M3-P6 设计 §3.13）', () => {
  it('防抖中：页头是有未保存的修改，离开提示拦下；写进模型之后由修改序号接着算，存上之后回到已保存到云端', async () => {
    const { coordinator, control, calls } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    control.typeInPanel()
    expect(coordinator.view()).toMatchObject({ status: 'dirty', unsaved: true, unsavedEdits: true })
    expect(coordinator.hasUnsavedWork()).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    control.panelSettled('面板里改的')
    expect(coordinator.view()).toMatchObject({ status: 'dirty', unsavedEdits: true })
    expect(coordinator.hasUnsavedWork()).toBe(true)
    const saving = coordinator.save()
    expect((await sent(calls, 1)).request).toMatchObject({ localSeq: 1, snapshot: '{"content":"面板里改的"}' })
    calls[0]?.resolve(saved(2))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'clean', unsaved: false, unsavedEdits: false })
    expect(coordinator.hasUnsavedWork()).toBe(false)
  })

  it('防抖到点却没有改动：随之清除，回到已保存到云端，离开不再提示', () => {
    const { coordinator, control } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    control.typeInPanel()
    expect(coordinator.view().status).toBe('dirty')
    control.panelSettled()
    expect(coordinator.view()).toMatchObject({ status: 'clean', unsaved: false, unsavedEdits: false })
    expect(coordinator.hasUnsavedWork()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('旧的保存确认在防抖期间到来：确认的是之前那次捕获，仍是有未保存的修改、离开提示拦下，不把还没写进模型的输入说成已保存', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    const request = await sent(calls, 1)
    control.typeInPanel()
    expect(coordinator.view().status).toBe('saving')
    request.resolve(saved(2))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'dirty', unsaved: true, unsavedEdits: true })
    expect(coordinator.hasUnsavedWork()).toBe(true)
    // 到点写进模型：是新的一处修改，再存一次才回到已保存
    control.panelSettled('甲与面板里改的')
    expect(coordinator.view().status).toBe('dirty')
    const again = coordinator.save()
    expect((await sent(calls, 2)).request).toMatchObject({ baseRevision: 2, localSeq: 2, snapshot: '{"content":"甲与面板里改的"}' })
    calls[1]?.resolve(saved(3))
    await again
    expect(coordinator.view().status).toBe('clean')
  })

  it('单元格里与面板里先后都有还没写进模型的输入：两样都结束才回到已保存到云端', () => {
    const { coordinator, control } = setup()
    control.typeInPanel()
    control.startCellEditing('还没回车')
    control.panelSettled()
    expect(coordinator.view().status).toBe('dirty')
    expect(coordinator.hasUnsavedWork()).toBe(true)
    control.cancelCellEditing()
    expect(coordinator.view().status).toBe('clean')
    expect(coordinator.hasUnsavedWork()).toBe(false)
  })
})

describe('保存之前：提交正在编辑的单元格、等公式收齐、检查体积', () => {
  it('单元格正在编辑：先提交（等同回车），提交的内容一起保存', async () => {
    const { coordinator, editor, control, calls } = setup()
    control.startCellEditing('编辑中的值')
    expect(coordinator.hasUnsavedWork()).toBe(true)
    const saving = coordinator.save()
    const request = await sent(calls, 1)
    expect(editor.commitCellEditing).toHaveBeenCalledOnce()
    expect(request.request).toMatchObject({ localSeq: 1, snapshot: '{"content":"编辑中的值"}' })
    request.resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('clean')
  })

  it('提交不了：中止保存，提示先完成单元格的编辑，不上传，状态照旧', async () => {
    const { coordinator, control, send } = setup()
    control.edit('甲')
    control.startCellEditing('不合格的值')
    control.commitResult = false
    await coordinator.save()
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.view()).toMatchObject({ status: 'dirty', problem: { kind: 'cell-editing' }, canSave: true })
  })

  it('先提交编辑，再等公式收齐（最多 3 秒），然后捕获', async () => {
    const { coordinator, editor, control, calls } = setup()
    control.startCellEditing('=A1+1')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(editor.settleFormulas).toHaveBeenCalledWith(3000)
    const commitOrder = vi.mocked(editor.commitCellEditing).mock.invocationCallOrder[0] ?? 0
    const settleOrder = vi.mocked(editor.settleFormulas).mock.invocationCallOrder[0] ?? 0
    const captureOrder = vi.mocked(editor.capture).mock.invocationCallOrder[0] ?? 0
    expect(commitOrder).toBeLessThan(settleOrder)
    expect(settleOrder).toBeLessThan(captureOrder)
  })

  it('公式 3 秒没收齐：照常保存，成功后提示公式结果尚未保存，仍算有未保存的修改；下一次收齐的保存之后消失', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('=SUM(A1:A9)')
    control.settle = 'timeout'
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'dirty', formulasPending: true })
    expect(coordinator.hasUnsavedWork()).toBe(true)

    control.settle = 'settled'
    const again = coordinator.save()
    ;(await sent(calls, 2)).resolve(saved(3))
    await again
    expect(coordinator.view()).toMatchObject({ status: 'clean', formulasPending: false })
  })

  it('序列化之后超过上限：提示容量上限，不上传', async () => {
    const { coordinator, control, send } = setup({ maxSnapshotBytes: 20 })
    control.edit('这段内容按 UTF-8 超过二十个字节')
    await coordinator.save()
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'too-large' } })
  })
})

describe('版本冲突', () => {
  it('别处保存了更新的版本：进入冲突，保留本页内容，禁止继续保存，离开时提示', async () => {
    const { coordinator, control, calls, send } = setup()
    control.edit('本页的修改')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(conflictError(3, { clientInstanceId: OTHER_TAB, localSeq: 7 }))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'conflict', canSave: false, conflict: { currentRevision: 3, source: { clientInstanceId: OTHER_TAB, localSeq: 7 } } })
    expect(coordinator.hasUnsavedWork()).toBe(true)
    await coordinator.save()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('冲突的详情认不出来：仍是冲突', async () => {
    const { coordinator, calls } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', 'x', { details: { currentRevision: 'x' } }))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'conflict', conflict: null })
  })

  it('自己追自己：上一次保存没收到回包却已提交，冲突的来源是它；换上当前修订号，用新的 requestId 立即重发一次', async () => {
    const { coordinator, control, calls } = setup({ baseRevision: 1 })
    control.edit('甲')
    const first = coordinator.save()
    const lost = await sent(calls, 1)
    lost.reject(new NetworkError('回包丢了'))
    await first
    expect(coordinator.view().status).toBe('failed')

    control.edit('甲乙')
    const second = coordinator.save()
    const stale = await sent(calls, 2)
    expect(stale.request).toMatchObject({ baseRevision: 1, localSeq: 2 })
    stale.reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    const resent = await sent(calls, 3)
    expect(resent.request).toMatchObject({ baseRevision: 2, localSeq: 2, snapshot: '{"content":"甲乙"}' })
    expect(new Set(calls.map(call => call.request.requestId)).size).toBe(3)
    resent.resolve(saved(3))
    await second
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })
  })

  it('自己追自己只重发一次：重发又冲突，就是真正的冲突', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('回包丢了'))
    await first
    control.edit('甲乙')
    const second = coordinator.save()
    ;(await sent(calls, 2)).reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    ;(await sent(calls, 3)).reject(conflictError(3, { clientInstanceId: OTHER_TAB, localSeq: 4 }))
    await second
    expect(coordinator.view()).toMatchObject({ status: 'conflict', conflict: { currentRevision: 3 } })
    expect(calls).toHaveLength(3)
  })

  it('两次都没收到回包，其实是较早的一次提交了：同样认得出来', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('回包丢了'))
    await first
    control.edit('甲乙')
    const second = coordinator.save()
    ;(await sent(calls, 2)).reject(new NetworkError('请求没有到达'))
    await second
    control.edit('甲乙丙')
    const third = coordinator.save()
    ;(await sent(calls, 3)).reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    const resent = await sent(calls, 4)
    expect(resent.request).toMatchObject({ baseRevision: 2, localSeq: 3 })
    resent.resolve(saved(3))
    await third
    expect(coordinator.view().status).toBe('clean')
  })

  it('来源是本页、却不是结果未知的保存：真正的冲突', async () => {
    const { coordinator, calls } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(conflictError(5, { clientInstanceId: ME, localSeq: 99 }))
    await saving
    expect(coordinator.view().status).toBe('conflict')
    expect(calls).toHaveLength(1)
  })
})

describe('编辑权续上时认出期间的那一版是本页自己的保存（adoptOwnRevision，M3-P1 审查 B1）', () => {
  /** 一次结果未知的保存（其实已经提交，回包丢了）：本页的修改序号 1，基准 4 */
  async function unknownSave() {
    const context = setup({ baseRevision: 4 })
    context.control.edit('甲')
    const saving = context.coordinator.save()
    ;(await sent(context.calls, 1)).reject(new NetworkError('断网'))
    await saving
    return context
  }

  it('来源是本页一次结果未知的保存：那次其实已经提交——按它确认，基准前进到那一版，不再说保存失败；之后的修改照常保存', async () => {
    const { coordinator, control, calls } = await unknownSave()
    control.edit('甲乙')
    expect(coordinator.view()).toMatchObject({ status: 'failed', unsaved: true })
    expect(coordinator.adoptOwnRevision(5, { clientInstanceId: ME, localSeq: 1 })).toBe(true)
    expect(coordinator.baseRevision()).toBe(5)
    expect(coordinator.view()).toMatchObject({ status: 'dirty', problem: undefined, unsaved: true })
    const saving = coordinator.save()
    const next = await sent(calls, 2)
    expect(next.request).toMatchObject({ baseRevision: 5, localSeq: 2 })
    expect(next.request.requestId).not.toBe(calls[0]?.request.requestId)
    next.resolve(saved(6))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'clean', unsaved: false })
  })

  it('之后没有再修改：确认之后就是已保存到云端', async () => {
    const { coordinator } = await unknownSave()
    expect(coordinator.adoptOwnRevision(5, { clientInstanceId: ME, localSeq: 1 })).toBe(true)
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined, unsaved: false })
    expect(coordinator.hasUnsavedWork()).toBe(false)
  })

  it('之后又有一次保存被明确拒绝（例如快照不合格）：认出之后照样显示那次的失败——它说的是之后的内容，与认出的那一次无关', async () => {
    const { coordinator, control, calls } = await unknownSave()
    control.edit('甲乙')
    const saving = coordinator.save()
    const invalid = new ApiError(422, 'SNAPSHOT_INVALID', '表格内容的格式不正确')
    ;(await sent(calls, 2)).reject(invalid)
    await saving
    expect(coordinator.adoptOwnRevision(5, { clientInstanceId: ME, localSeq: 1 })).toBe(true)
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request', error: invalid } })
  })

  it.each([
    ['来源是别的标签页', { clientInstanceId: OTHER_TAB, localSeq: 1 }],
    ['没有来源（新建、复制出来的）', null],
    ['来源是本页、却不是结果未知的那几次', { clientInstanceId: ME, localSeq: 9 }],
  ] as const)('%s：不是本页自己的，返回 false，什么也不变', async (_case, source) => {
    const { coordinator } = await unknownSave()
    const before = coordinator.view()
    expect(coordinator.adoptOwnRevision(5, source)).toBe(false)
    expect(coordinator.baseRevision()).toBe(4)
    expect(coordinator.view()).toBe(before)
  })

  it('版本冲突之后（终态）：不认，返回 false', async () => {
    const { coordinator, control, calls } = await unknownSave()
    control.edit('甲乙')
    const saving = coordinator.save()
    ;(await sent(calls, 2)).reject(conflictError(6, { clientInstanceId: OTHER_TAB, localSeq: 7 }))
    await saving
    expect(coordinator.view().status).toBe('conflict')
    expect(coordinator.adoptOwnRevision(5, { clientInstanceId: ME, localSeq: 1 })).toBe(false)
    expect(coordinator.baseRevision()).toBe(4)
  })

  it('保存先得知编辑权中断：在途的那一次按旧的基准发出，续上之后重发得到冲突、来源正是认出的那一次——照常换上新的基准重发一次，不报冲突', async () => {
    const { coordinator, control, calls } = await unknownSave()
    control.edit('甲乙')
    const saving = coordinator.save()
    const inFlight = await sent(calls, 2)
    expect(inFlight.request.baseRevision).toBe(4)
    // 页面这时续上（这次保存得到编辑权中断），认出期间的那一版是本页的第一次保存；用新的一代重发同一个请求，得到冲突
    expect(coordinator.adoptOwnRevision(5, { clientInstanceId: ME, localSeq: 1 })).toBe(true)
    inFlight.reject(conflictError(5, { clientInstanceId: ME, localSeq: 1 }))
    const rebased = await sent(calls, 3)
    expect(rebased.request).toMatchObject({ baseRevision: 5, localSeq: 2 })
    expect(rebased.request.requestId).not.toBe(inFlight.request.requestId)
    rebased.resolve(saved(6))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'clean', conflict: undefined, unsaved: false })
  })

  /** 在途的保存（修改序号 1，基准 4）：它其实已经提交（修订 5），回包还在路上 */
  async function inFlightSave() {
    const context = setup({ baseRevision: 4 })
    context.control.edit('甲')
    const saving = context.coordinator.save()
    const inFlight = await sent(context.calls, 1)
    return { ...context, saving, inFlight }
  }

  it('续上时认出的正是在途的那一次，随后它自己的回包以结果未知失败（断网）：就是提交了、回包丢了——按成功收尾，不说保存失败，也不留着原样再发（复验 C3）', async () => {
    const { coordinator, calls, saving, inFlight } = await inFlightSave()
    expect(coordinator.adoptOwnRevision(5, { clientInstanceId: ME, localSeq: 1 })).toBe(true)
    expect(coordinator.view()).toMatchObject({ status: 'saving', unsaved: false })
    inFlight.reject(new NetworkError('断网'))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined, unsaved: false })
    expect(coordinator.hasUnsavedWork()).toBe(false)
    expect(coordinator.baseRevision()).toBe(5)
    expect(calls).toHaveLength(1)
    // 再按保存（内容没变也照常上传）：以认出的那一版为基准的新请求，不是原样再发旧基准的那一个
    const again = coordinator.save()
    const next = await sent(calls, 2)
    expect(next.request).toMatchObject({ baseRevision: 5, localSeq: 1 })
    expect(next.request.requestId).not.toBe(inFlight.request.requestId)
    next.resolve(saved(6))
    await again
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })
  })

  it('认出在途的那一次之后，它的回包其实成功返回：照常确认，已保存到云端', async () => {
    const { coordinator, saving, inFlight } = await inFlightSave()
    expect(coordinator.adoptOwnRevision(5, { clientInstanceId: ME, localSeq: 1 })).toBe(true)
    inFlight.resolve(saved(5))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined, unsaved: false })
    expect(coordinator.baseRevision()).toBe(5)
  })

  it('认出在途的那一次之后，它的回包是明确的拒绝（例如登录已过期）：照常按失败处理——说的是这一次没有生效的原因，会话交给页面确认；内容仍算已保存', async () => {
    const { coordinator, saving, inFlight, onUnauthenticated } = await inFlightSave()
    expect(coordinator.adoptOwnRevision(5, { clientInstanceId: ME, localSeq: 1 })).toBe(true)
    const expired = new ApiError(401, 'SESSION_EXPIRED', '登录已过期')
    inFlight.reject(expired)
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request', error: expired }, unsaved: false })
    expect(onUnauthenticated).toHaveBeenCalledExactlyOnceWith(expired)
  })

  it('认出的是更早的那一次、在途的这一次内容更新：它的回包以结果未知失败时照常是保存失败（认出那一次不说明这一次）', async () => {
    const { coordinator, control, calls } = await unknownSave()
    control.edit('甲乙')
    const saving = coordinator.save()
    const inFlight = await sent(calls, 2)
    expect(coordinator.adoptOwnRevision(5, { clientInstanceId: ME, localSeq: 1 })).toBe(true)
    const offline = new NetworkError('断网')
    inFlight.reject(offline)
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request', error: offline }, unsaved: true })
  })
})

describe('重试原样再发结果未知的请求（Codex 评审 CX2）', () => {
  /** 修改之后保存，回包丢了：服务端可能已经提交；返回那次请求 */
  async function lostSave(context: ReturnType<typeof setup>, text: string): Promise<SaveRequest> {
    const { coordinator, control, calls } = context
    control.edit(text)
    const saving = coordinator.save()
    const request = await sent(calls, calls.length + 1)
    request.reject(new NetworkError('回包丢了'))
    await saving
    return request.request
  }

  it('改了又撤销、内容回到原样：重试原样再发，序号仍是第一次的；成功后确认到这次捕获的序号', async () => {
    const context = setup()
    const { coordinator, control, calls } = context
    const first = await lostSave(context, '甲')
    control.edit('甲乙')
    control.edit('甲')
    const retry = coordinator.save()
    const second = await sent(calls, 2)
    expect(second.request).toBe(first)
    expect(second.request.localSeq).toBe(1)
    second.resolve(saved(2))
    await retry
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })
  })

  it('原样再发的回包又丢了，之后继续修改再保存：冲突的来源是第一次的序号，认得出自己追自己', async () => {
    const context = setup()
    const { coordinator, control, calls } = context
    await lostSave(context, '甲')
    control.edit('甲乙')
    control.edit('甲')
    const retry = coordinator.save()
    ;(await sent(calls, 2)).reject(new NetworkError('回包又丢了'))
    await retry

    control.edit('甲丙')
    const third = coordinator.save()
    const stale = await sent(calls, 3)
    expect(stale.request).toMatchObject({ baseRevision: 1, localSeq: 4 })
    stale.reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    const resent = await sent(calls, 4)
    expect(resent.request).toMatchObject({ baseRevision: 2, localSeq: 4, snapshot: '{"content":"甲丙"}' })
    resent.resolve(saved(3))
    await third
    expect(coordinator.view()).toMatchObject({ status: 'clean', conflict: undefined })
  })

  it('原样再发被明确拒绝（登录过期）：更早那次仍可能已经提交，记录留着；重新登录后继续修改再保存，认得出自己追自己', async () => {
    const context = setup()
    const { coordinator, control, calls, onUnauthenticated } = context
    const first = await lostSave(context, '甲')
    const retry = coordinator.save()
    const second = await sent(calls, 2)
    expect(second.request).toBe(first)
    second.reject(new ApiError(401, 'SESSION_EXPIRED', '登录已过期'))
    await retry
    expect(onUnauthenticated).toHaveBeenCalledOnce()

    control.edit('甲乙')
    const third = coordinator.save()
    ;(await sent(calls, 3)).reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    const resent = await sent(calls, 4)
    expect(resent.request).toMatchObject({ baseRevision: 2, localSeq: 2 })
    resent.resolve(saved(3))
    await third
    expect(coordinator.view()).toMatchObject({ status: 'clean', conflict: undefined, problem: undefined })
  })

  it('原样再发被明确拒绝之后，内容没变再保存：仍原样再发那个请求', async () => {
    const context = setup()
    const { coordinator, calls } = context
    const first = await lostSave(context, '甲')
    const retry = coordinator.save()
    ;(await sent(calls, 2)).reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await retry
    const again = coordinator.save()
    const third = await sent(calls, 3)
    expect(third.request).toBe(first)
    third.resolve(saved(2))
    await again
    expect(coordinator.view().status).toBe('clean')
  })

  it('原样再发得到 requestId 被占用：原样再发也一样，下一次换新的 requestId', async () => {
    const context = setup()
    const { coordinator, calls } = context
    const first = await lostSave(context, '甲')
    const retry = coordinator.save()
    ;(await sent(calls, 2)).reject(new ApiError(409, 'REQUEST_ID_CONFLICT', 'requestId 已被使用'))
    await retry
    const again = coordinator.save()
    const third = await sent(calls, 3)
    expect(third.request.requestId).not.toBe(first.requestId)
    expect(third.request).toMatchObject({ baseRevision: 1, localSeq: 1, snapshot: first.snapshot })
    third.resolve(saved(2))
    await again
  })
})

describe('保存失败', () => {
  it.each([
    ['网络错误', new NetworkError('断网')],
    ['5xx', new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用')],
    ['回包与契约不一致', new ResponseFormatError('回包不对')],
  ])('%s：保存失败；内容没变时重试沿用同一个 requestId，内容变了就换一个', async (_case, error) => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(error)
    await first
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request', error } })
    expect(coordinator.hasUnsavedWork()).toBe(true)

    const retry = coordinator.save()
    const second = await sent(calls, 2)
    expect(second.request).toEqual(calls[0]?.request)
    second.reject(error)
    await retry

    control.edit('甲乙')
    const changed = coordinator.save()
    const third = await sent(calls, 3)
    expect(third.request.requestId).not.toBe(calls[0]?.request.requestId)
    third.resolve(saved(2))
    await changed
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })
  })

  it.each([
    ['超过上限（413）', new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体解压后超过上限')],
    ['快照不合格（422）', new ApiError(422, 'SNAPSHOT_INVALID', '表格内容的格式不正确')],
    ['文档不在了（404）', new ApiError(404, 'NOT_FOUND', '不存在')],
  ])('%s：保存失败，显示原因；确定没有提交，重试换新的 requestId', async (_case, error) => {
    const { coordinator, calls } = setup()
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(error)
    await first
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request', error } })
    const retry = coordinator.save()
    const second = await sent(calls, 2)
    expect(second.request.requestId).not.toBe(calls[0]?.request.requestId)
    second.resolve(saved(2))
    await retry
  })

  it('未登录或登录已过期：交给页面向服务端确认会话', async () => {
    const { coordinator, calls, onUnauthenticated } = setup()
    const saving = coordinator.save()
    const error = new ApiError(401, 'SESSION_EXPIRED', '登录已过期')
    ;(await sent(calls, 1)).reject(error)
    await saving
    expect(onUnauthenticated).toHaveBeenCalledWith(error)
    expect(coordinator.view().status).toBe('failed')
  })

  it('CSRF 令牌不对：交给页面向服务端确认会话', async () => {
    const { coordinator, calls, onSessionStale } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await saving
    expect(onSessionStale).toHaveBeenCalledOnce()
    expect(coordinator.view().status).toBe('failed')
  })

  // M3-P4 设计 §3.9：原来"再保存时先清掉上一次的原因"，改为原因保留到这一次有结果——自动重试期间失败的说明不清掉再出现；
  // 页头照常说保存中（状态先看在途），成功之后清掉，又失败时换成这一次的原因
  it('失败之后再保存：保存中照样说保存中，上一次的原因留到这一次有结果；成功之后清掉，又失败换成新的原因', async () => {
    const { coordinator, calls } = setup()
    const offline = new NetworkError('断网')
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(offline)
    await first
    const retry = coordinator.save()
    expect(coordinator.view()).toMatchObject({ status: 'saving', problem: { kind: 'request', error: offline } })
    const busy = new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用')
    ;(await sent(calls, 2)).reject(busy)
    await retry
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request', error: busy } })
    const last = coordinator.save()
    ;(await sent(calls, 3)).resolve(saved(2))
    await last
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })
  })
})

describe('保存流程本身出错（审查 B5）', () => {
  it('捕获时出错：显示保存失败并上报，不发请求；save 不会被拒绝', async () => {
    const { coordinator, editor, control, send, reportError } = setup()
    control.edit('甲')
    const failure = new Error('SDK 的 save() 出错')
    vi.mocked(editor.capture).mockImplementationOnce(() => {
      throw failure
    })
    // save 不会被拒绝：结果里是意外的错误（M3-P4 起 save 交回这一次的结果，调度据此决定之后怎么办）
    await expect(coordinator.save()).resolves.toEqual({ kind: 'failed', failure: { kind: 'unexpected' }, requestId: undefined })
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'unexpected', error: failure }, canSave: true })
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(coordinator.hasUnsavedWork()).toBe(true)
  })

  it('压缩时出错：同样按意外的错误处理，不当作结果未知的请求，下一次换新的 requestId（复验 RB8）', async () => {
    const { coordinator, control, compress, send, calls, reportError } = setup()
    control.edit('甲')
    const failure = new Error('压缩出错')
    compress.mockRejectedValueOnce(failure)
    await coordinator.save()
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'unexpected', error: failure } })
    expect(reportError).toHaveBeenCalledWith(failure)
    const saving = coordinator.save()
    const call = await sent(calls, 1)
    expect(new TextDecoder().decode(call.body)).toBe(call.request.snapshot)
    call.resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('clean')
  })

  it('提交编辑或等公式收齐时出错：同样', async () => {
    const { coordinator, editor, control, reportError } = setup()
    control.startCellEditing('x')
    vi.mocked(editor.commitCellEditing).mockRejectedValueOnce(new Error('提交出错'))
    await coordinator.save()
    expect(coordinator.view().problem?.kind).toBe('unexpected')
    vi.mocked(editor.settleFormulas).mockRejectedValueOnce(new Error('收齐出错'))
    control.commitResult = true
    await coordinator.save()
    expect(coordinator.view().problem?.kind).toBe('unexpected')
    expect(reportError).toHaveBeenCalledTimes(2)
  })
})

describe('会话恢复之后清掉会话类的失败（复验 RB2）', () => {
  it.each([
    ['登录已过期', new ApiError(401, 'SESSION_EXPIRED', '登录已过期')],
    ['令牌失效', new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')],
  ])('%s：会话确认有效之后说明不再成立，回到有未保存的修改', async (_case, error) => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(error)
    await saving
    expect(coordinator.view().status).toBe('failed')
    coordinator.dismissSessionProblem()
    expect(coordinator.view()).toMatchObject({ status: 'dirty', problem: undefined })
  })

  it('其他失败不清掉', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('断网'))
    await saving
    coordinator.dismissSessionProblem()
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request' } })
  })
})

describe('停止保存与离开', () => {
  it('页面停止保存（别的标签页换了人）：之后的保存不做；恢复之后照常保存', async () => {
    const { coordinator, control, send, calls } = setup()
    control.edit('甲')
    coordinator.stop()
    expect(coordinator.view().canSave).toBe(false)
    await coordinator.save()
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.hasUnsavedWork()).toBe(true)
    coordinator.resume()
    expect(coordinator.view().canSave).toBe(true)
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('clean')
  })

  it('没有修改、没有正在编辑、没有在途的保存：离开不提示', async () => {
    const { coordinator, calls } = setup()
    expect(coordinator.hasUnsavedWork()).toBe(false)
    const saving = coordinator.save()
    expect(coordinator.hasUnsavedWork()).toBe(true)
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.hasUnsavedWork()).toBe(false)
  })

  it('销毁之后不再通知', () => {
    const { coordinator, control } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    coordinator.dispose()
    control.edit('甲')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('失去编辑权时核对结果未知的保存（M3-P2 设计 §3.4）', () => {
  it('settled：等进行中的保存结束；没有在途的保存时立即兑现', async () => {
    const { coordinator, control, calls } = setup()
    await coordinator.settled()
    control.edit('甲')
    const saving = coordinator.save()
    let settled = false
    const waiting = coordinator.settled().then(() => {
      settled = true
    })
    const first = await sent(calls, 1)
    await Promise.resolve()
    expect(settled).toBe(false)
    first.reject(new NetworkError('断网'))
    await saving
    await waiting
    expect(settled).toBe(true)
  })

  it('没有结果未知的保存：none，不发请求', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.hasUnknownOutcome()).toBe(false)
    await expect(coordinator.replayUnknownOutcome()).resolves.toBe('none')
    expect(calls).toHaveLength(1)
  })

  it('原样重发（requestId、序号、正文都不变）；其实已经提交：按那次捕获确认，没有没保存的内容了，"保存失败"不再说；停住保存时照样发', async () => {
    const { coordinator, control, calls } = setup({ baseRevision: 3 })
    control.edit('甲')
    const saving = coordinator.save()
    const first = await sent(calls, 1)
    first.reject(new NetworkError('断网'))
    await saving
    expect(coordinator.hasUnknownOutcome()).toBe(true)
    expect(coordinator.view()).toMatchObject({ status: 'failed', unsaved: true })
    coordinator.stop()
    const replaying = coordinator.replayUnknownOutcome()
    const replay = await sent(calls, 2)
    expect(replay.request).toEqual(first.request)
    expect(replay.body).toEqual(first.body)
    replay.resolve(saved(4))
    await expect(replaying).resolves.toBe('committed')
    expect(coordinator.view()).toMatchObject({ unsaved: false, problem: undefined })
    expect(coordinator.baseRevision()).toBe(4)
    expect(coordinator.hasUnknownOutcome()).toBe(false)
  })

  it('其实已经提交、之后本页又有修改：确认到那一次，仍有没保存的内容', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('断网'))
    await saving
    control.edit('乙')
    const replaying = coordinator.replayUnknownOutcome()
    ;(await sent(calls, 2)).resolve(saved(2))
    await expect(replaying).resolves.toBe('committed')
    expect(coordinator.view().unsaved).toBe(true)
  })

  it.each([
    ['编辑权已失效（EDIT_LEASE_LOST）', new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'revoked' } })],
    ['不能编辑（403）', new ApiError(403, 'PERMISSION_DENIED', '只能查看')],
    ['修订号冲突', conflictError(5, null)],
  ])('确定被拒绝（%s）：它没有提交——仍有没保存的内容，不再当作结果未知', async (_case, rejection) => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('断网'))
    await saving
    const replaying = coordinator.replayUnknownOutcome()
    ;(await sent(calls, 2)).reject(rejection)
    await expect(replaying).resolves.toBe('not-committed')
    expect(coordinator.view().unsaved).toBe(true)
    expect(coordinator.hasUnknownOutcome()).toBe(false)
  })

  it.each([
    ['读不到了（404：重放也要求能访问）', new ApiError(404, 'NOT_FOUND', '不存在')],
    ['未登录（到不了重放那一步）', new ApiError(401, 'SESSION_EXPIRED', '登录已过期')],
    ['令牌失效', new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')],
    ['结果仍然未知', new NetworkError('断网')],
  ])('说不准（%s）：unknown，仍算没保存，记录留着', async (_case, failure) => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('断网'))
    await saving
    const replaying = coordinator.replayUnknownOutcome()
    ;(await sent(calls, 2)).reject(failure)
    await expect(replaying).resolves.toBe('unknown')
    expect(coordinator.view().unsaved).toBe(true)
    expect(coordinator.hasUnknownOutcome()).toBe(true)
  })

  it('有保存在途时先等它结束再核对：在途的那一次结果未知，核对的就是它', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    const first = await sent(calls, 1)
    const replaying = coordinator.replayUnknownOutcome()
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    first.reject(new NetworkError('断网'))
    await saving
    const replay = await sent(calls, 2)
    expect(replay.request).toEqual(first.request)
    replay.resolve(saved(2))
    await expect(replaying).resolves.toBe('committed')
  })
})

describe('保存协议加固（M3-P3 设计 §3.7、§3.8、§3.10）', () => {
  it('"公式待更新"：捕获时公式没收齐就带上标记；内容相同（unchanged）的确认照"已保存"处理，基准是确认里的修订号', async () => {
    const { coordinator, control, calls } = setup({ baseRevision: 3 })
    control.edit('甲')
    control.settle = 'timeout'
    const first = coordinator.save()
    expect((await sent(calls, 1)).request.formulasPending).toBe(true)
    calls[0]?.resolve(saved(4))
    await first
    expect(coordinator.view()).toMatchObject({ status: 'dirty', formulasPending: true })
    control.settle = 'settled'
    const second = coordinator.save()
    const again = await sent(calls, 2)
    expect(again.request).toMatchObject({ baseRevision: 4, formulasPending: false })
    again.resolve({ revision: 4, savedAt: '2026-09-27T08:00:00.000Z', unchanged: true })
    await second
    expect(coordinator.view()).toMatchObject({ status: 'clean', formulasPending: false })
    expect(coordinator.baseRevision()).toBe(4)
  })

  it('原样重发的判断连"公式待更新"一起比：内容与基准没变、标记变了，就是另一个请求（换新的 requestId，服务端把标记算进摘要）', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    control.settle = 'timeout'
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('断网'))
    await first
    // 同样的内容、同样的标记：原样再发
    const same = coordinator.save()
    ;(await sent(calls, 2)).reject(new NetworkError('断网'))
    await same
    expect(calls[1]?.request).toEqual(calls[0]?.request)
    // 公式收齐了：标记不同，换新的 requestId
    control.settle = 'settled'
    const changed = coordinator.save()
    const third = await sent(calls, 3)
    expect(third.request.formulasPending).toBe(false)
    expect(third.request.requestId).not.toBe(calls[0]?.request.requestId)
    third.resolve(saved(2))
    await changed
  })

  it.each([
    ['CLIENT_OUTDATED', 'outdated'],
    ['DOCUMENT_TOO_NEW', 'too-new'],
  ] as const)('保存得到 %s：转入终态 %s，不能再保存（按保存不发请求），不另记失败；本页的修改仍算没保存', async (code, status) => {
    const { coordinator, control, calls, send } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new ApiError(409, code, '不兼容'))
    await saving
    expect(coordinator.view()).toMatchObject({ status, canSave: false, problem: undefined, unsaved: true })
    expect(coordinator.hasUnsavedWork()).toBe(true)
    await coordinator.save()
    expect(send).toHaveBeenCalledTimes(1)
    // 终态之后续上认出的"自己的保存"不再采纳
    expect(coordinator.adoptOwnRevision(2, { clientInstanceId: ME, localSeq: 1 })).toBe(false)
  })

  it('续租得知不兼容（block）：同样转入终态；冲突之后、已经不兼容时不变', async () => {
    const outdated = setup()
    outdated.coordinator.block('client-outdated')
    expect(outdated.coordinator.view()).toMatchObject({ status: 'outdated', canSave: false })
    outdated.coordinator.block('document-too-new')
    expect(outdated.coordinator.view().status).toBe('outdated')

    const conflicted = setup()
    conflicted.control.edit('甲')
    const saving = conflicted.coordinator.save()
    ;(await sent(conflicted.calls, 1)).reject(conflictError(5, null))
    await saving
    conflicted.coordinator.block('client-outdated')
    expect(conflicted.coordinator.view().status).toBe('conflict')
  })

  describe('转入不兼容的终态时有一次结果未知的保存（审查 B5）：先原样重发它一次再定说法（重放先于拦截旧客户端，设计 §3.1）', () => {
    const OUTDATED = new ApiError(409, 'CLIENT_OUTDATED', '页面的版本过旧', { details: { reason: 'build' } })

    /** 改一处、保存，结果未知（断网）：交回那一次的请求 */
    async function unknownSave(context: ReturnType<typeof setup>): Promise<PendingSend> {
      context.control.edit('甲')
      const saving = context.coordinator.save()
      const first = await sent(context.calls, 1)
      first.reject(new NetworkError('断网'))
      await saving
      expect(context.coordinator.hasUnknownOutcome()).toBe(true)
      return first
    }

    it('busy（M3-P4：页面关闭时有保存在途不释放编辑权）：在途、排着与转入终态之后核对（原样重发）的期间都为真，都结束了为假', async () => {
      const context = setup({ baseRevision: 3 })
      expect(context.coordinator.busy()).toBe(false)
      context.control.edit('甲')
      const saving = context.coordinator.save()
      expect(context.coordinator.busy()).toBe(true)
      ;(await sent(context.calls, 1)).reject(new NetworkError('断网'))
      await saving
      expect(context.coordinator.busy()).toBe(false)
      context.coordinator.block('client-outdated')
      expect(context.coordinator.view().checking).toBe(true)
      expect(context.coordinator.busy()).toBe(true)
      ;(await sent(context.calls, 2)).resolve(saved(4))
      await context.coordinator.settled()
      expect(context.coordinator.busy()).toBe(false)
    })

    it('续租得知过旧（block）：核对期间 checking 为真、还说不准；原样重发拿到原来的结果（其实已经提交）——按它确认，修改都已保存，"保存失败"不再说；settled 等核对完', async () => {
      const context = setup({ baseRevision: 3 })
      const first = await unknownSave(context)
      context.coordinator.block('client-outdated')
      expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: true, unsaved: true, canSave: false })
      let settled = false
      const waiting = context.coordinator.settled().then(() => {
        settled = true
      })
      const replay = await sent(context.calls, 2)
      expect(replay.request).toEqual(first.request)
      expect(replay.body).toEqual(first.body)
      await Promise.resolve()
      expect(settled).toBe(false)
      replay.resolve(saved(4))
      await waiting
      expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: false, unsavedEdits: false, problem: undefined })
      expect(context.coordinator.hasUnsavedWork()).toBe(false)
      expect(context.coordinator.baseRevision()).toBe(4)
      // 终态照旧：按保存不发请求
      await context.coordinator.save()
      expect(context.calls).toHaveLength(2)
    })

    it.each([
      ['同样被拒（它没有提交）', OUTDATED, false],
      ['结果仍然未知（断网）', new NetworkError('断网'), true],
    ])('原样重发%s：仍是修改没有保存，核对结束', async (_case, failure, stillUnknown) => {
      const context = setup()
      await unknownSave(context)
      context.coordinator.block('document-too-new')
      const replay = await sent(context.calls, 2)
      replay.reject(failure)
      await context.coordinator.settled()
      expect(context.coordinator.view()).toMatchObject({ status: 'too-new', checking: false, unsaved: true, unsavedEdits: true })
      expect(context.coordinator.hasUnknownOutcome()).toBe(stillUnknown)
      expect(context.calls).toHaveLength(2)
    })

    it('保存自己得知过旧（这一次的内容与结果未知的那次不同）：照样原样重发那一次；它提交了，这一次的修改仍没保存', async () => {
      const context = setup({ baseRevision: 3 })
      const first = await unknownSave(context)
      context.control.edit('乙')
      const saving = context.coordinator.save()
      const second = await sent(context.calls, 2)
      expect(second.request.requestId).not.toBe(first.request.requestId)
      second.reject(OUTDATED)
      await saving
      const replay = await sent(context.calls, 3)
      expect(replay.request).toEqual(first.request)
      replay.resolve(saved(4))
      await context.coordinator.settled()
      expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: true, unsavedEdits: true })
      expect(context.coordinator.baseRevision()).toBe(4)
    })

    it('没有结果未知的保存：不重发，不核对', async () => {
      const context = setup()
      context.control.edit('甲')
      context.coordinator.block('client-outdated')
      await context.coordinator.settled()
      expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: true, unsavedEdits: true })
      expect(context.send).not.toHaveBeenCalled()
    })

    describe('续租得知时正有一次保存在途（复验 C1）：它的结果还没有着落，同样先核对——等它结束，以结果未知结束的原样重发一次', () => {
      /** 改一处、保存，在途时续租得知过旧：核对随即开始（checking 为真），交回在途的那一次与 save 的结果 */
      async function blockedWhileSaving(context: ReturnType<typeof setup>): Promise<{ readonly inFlight: PendingSend, readonly saving: Promise<unknown> }> {
        context.control.edit('甲')
        const saving = context.coordinator.save()
        const inFlight = await sent(context.calls, 1)
        context.coordinator.block('client-outdated')
        expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: true, unsaved: true, canSave: false })
        return { inFlight, saving }
      }

      it('它随后以结果未知结束（回包丢了）：原样重发它一次，核对期间 checking 为真；拿到原来的结果（其实已经提交）——按它确认，修改都已保存，"保存失败"不再说', async () => {
        const context = setup({ baseRevision: 3 })
        const { inFlight, saving } = await blockedWhileSaving(context)
        inFlight.reject(new NetworkError('断网'))
        await saving
        const replay = await sent(context.calls, 2)
        expect(replay.request).toEqual(inFlight.request)
        expect(replay.body).toEqual(inFlight.body)
        expect(context.coordinator.view().checking).toBe(true)
        replay.resolve(saved(4))
        await context.coordinator.settled()
        expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: false, unsavedEdits: false, problem: undefined })
        expect(context.coordinator.hasUnknownOutcome()).toBe(false)
        expect(context.coordinator.hasUnsavedWork()).toBe(false)
        expect(context.coordinator.baseRevision()).toBe(4)
      })

      it.each([
        ['同样被拒（它没有提交）', OUTDATED, false],
        ['结果仍然未知（断网）', new NetworkError('断网'), true],
      ])('它随后以结果未知结束，原样重发%s：仍是修改没有保存，核对结束', async (_case, failure, stillUnknown) => {
        const context = setup()
        const { inFlight, saving } = await blockedWhileSaving(context)
        inFlight.reject(new NetworkError('断网'))
        await saving
        ;(await sent(context.calls, 2)).reject(failure)
        await context.coordinator.settled()
        expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: true, unsavedEdits: true })
        expect(context.coordinator.hasUnknownOutcome()).toBe(stillUnknown)
        expect(context.calls).toHaveLength(2)
      })

      it('它随后成功：它的结果就是答案，不重发；核对结束，修改都已保存', async () => {
        const context = setup({ baseRevision: 3 })
        const { inFlight, saving } = await blockedWhileSaving(context)
        inFlight.resolve(saved(4))
        await saving
        await context.coordinator.settled()
        expect(context.calls).toHaveLength(1)
        expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: false, unsavedEdits: false, problem: undefined })
        expect(context.coordinator.baseRevision()).toBe(4)
      })

      it('它随后得到确定的拒绝（它自己也得知过旧）：没有提交，不重发；核对结束，仍是修改没有保存', async () => {
        const context = setup()
        const { inFlight, saving } = await blockedWhileSaving(context)
        inFlight.reject(OUTDATED)
        await saving
        await context.coordinator.settled()
        expect(context.calls).toHaveLength(1)
        expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: true, unsavedEdits: true })
        expect(context.coordinator.hasUnknownOutcome()).toBe(false)
      })
    })

    it('保存自己得知过旧、此前没有结果未知的保存：在途的就是得到拒绝的这一次，结果确定——不核对，通知里 checking 一直为假', async () => {
      const context = setup()
      const checking: boolean[] = []
      context.coordinator.subscribe(() => checking.push(context.coordinator.view().checking))
      context.control.edit('甲')
      const saving = context.coordinator.save()
      ;(await sent(context.calls, 1)).reject(OUTDATED)
      await saving
      await context.coordinator.settled()
      expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: true })
      expect(checking.length).toBeGreaterThan(0)
      expect(checking).not.toContain(true)
      expect(context.calls).toHaveLength(1)
    })

    it('修改都已保存、只有公式的结果没有存上：unsaved 为真而 unsavedEdits 为假（页面单说一句）', async () => {
      const context = setup({ baseRevision: 3 })
      context.control.edit('甲')
      context.control.settle = 'timeout'
      const saving = context.coordinator.save()
      ;(await sent(context.calls, 1)).resolve(saved(4))
      await saving
      context.coordinator.block('client-outdated')
      expect(context.coordinator.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: true, unsavedEdits: false, formulasPending: true })
      expect(context.send).toHaveBeenCalledOnce()
    })
  })

  it('最近一次捕获的大小（与服务端解压后的字节同一个口径）：第一次保存之前是载入的内容的大小，捕获之后换成捕获的；超过上限的照样记下', async () => {
    const { editor, control } = fakeEditor()
    const { send, calls } = fakeSend()
    const coordinator = createSaveCoordinator({
      editor,
      compress: fakeCompress,
      send,
      baseRevision: 1,
      clientInstanceId: ME,
      newRequestId: () => 'request-size',
      onUnauthenticated: vi.fn(),
      onSessionStale: vi.fn(),
      reportError: vi.fn(),
      initialSnapshotBytes: 4_200_000,
      maxSnapshotBytes: 30,
    })
    expect(coordinator.view().snapshotBytes).toBe(4_200_000)
    control.edit('甲乙')
    const saving = coordinator.save(explicitCaptureSource(editor), EXPLICIT)
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    // {"content":"甲乙"}：14 个 ASCII 字符加两个汉字各 3 字节
    expect(coordinator.view().snapshotBytes).toBe(20)
    control.edit('很长的内容超过了上限的字节数')
    await coordinator.save(explicitCaptureSource(editor), EXPLICIT)
    expect(coordinator.view()).toMatchObject({ problem: { kind: 'too-large' }, snapshotBytes: new TextEncoder().encode('{"content":"很长的内容超过了上限的字节数"}').byteLength })
  })
})

/** 自动保存、切到后台、退出编辑与交出：会话内去重 */
const AUTO: SaveOptions = { dedupe: true }

/** 一次给定的捕获：内容 content，摘要按内容（同样的内容同样的摘要） */
function captureOf(seq: number, content: string, extra: Partial<SnapshotCapture> = {}): SnapshotCapture {
  const snapshot = JSON.stringify({ content })
  return { seq, snapshot, bytes: new TextEncoder().encode(snapshot).byteLength, formulasPending: false, digest: `sha256:${content}`, ...extra }
}

/** 来源：交回给定的捕获，记下被调用了几次 */
function given(capture: PreparedCapture) {
  return vi.fn((): PreparedCapture => capture)
}

describe('上传给定的捕获（M3-P4 设计 §3.1：保存的状态机不自己捕获，捕获由来源给出）', () => {
  it('请求按捕获的序号、快照与"公式待更新"发出，不调用编辑器的捕获；大小按捕获的；确认只到捕获时的序号（之后的修改仍算没保存，A08）', async () => {
    const { real, control, editor, calls } = setup({ baseRevision: 3 })
    control.edit('甲')
    control.edit('甲乙')
    const saving = real.save(given(captureOf(1, '甲', { formulasPending: true })), AUTO)
    const request = await sent(calls, 1)
    expect(request.request).toMatchObject({ baseRevision: 3, localSeq: 1, snapshot: '{"content":"甲"}', formulasPending: true })
    expect(editor.capture).not.toHaveBeenCalled()
    request.resolve(saved(4))
    await expect(saving).resolves.toEqual({ kind: 'saved', requestId: request.request.requestId })
    // {"content":"甲"}：14 个 ASCII 字符加一个汉字 3 字节
    expect(real.view()).toMatchObject({ status: 'dirty', unsavedEdits: true, formulasPending: true, snapshotBytes: 17 })
    expect(real.baseRevision()).toBe(4)
  })

  it('一个接一个：前面还有保存时排着，轮到时才向来源要捕获（上传的总是那一刻最新的，先后不会颠倒）', async () => {
    const { real, control, calls } = setup()
    control.edit('甲')
    const first = real.save(given(captureOf(1, '甲')), AUTO)
    const inFlight = await sent(calls, 1)
    control.edit('甲乙')
    const source = given(captureOf(2, '甲乙'))
    const second = real.save(source, AUTO)
    expect(real.view().status).toBe('saving')
    await Promise.resolve()
    expect(source).not.toHaveBeenCalled()
    inFlight.resolve(saved(2))
    await first
    const next = await sent(calls, 2)
    expect(source).toHaveBeenCalledOnce()
    expect(next.request).toMatchObject({ baseRevision: 2, localSeq: 2 })
    next.resolve(saved(3))
    await second
    expect(real.view().status).toBe('clean')
  })

  it('排着的时候不算已保存：settled 等排着的那一次也结束，离开照样提示', async () => {
    const { real, control, calls } = setup()
    control.edit('甲')
    void real.save(given(captureOf(1, '甲')), AUTO)
    const inFlight = await sent(calls, 1)
    void real.save(given(captureOf(1, '甲')), EXPLICIT)
    let settled = false
    const waiting = real.settled().then(() => {
      settled = true
    })
    inFlight.resolve(saved(2))
    const queued = await sent(calls, 2)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(real.hasUnsavedWork()).toBe(true)
    queued.resolve(saved(2))
    await waiting
    expect(real.hasUnsavedWork()).toBe(false)
  })

  it('来源说单元格的编辑提交不了：中止，提示先完成单元格的编辑，不上传', async () => {
    const { real, send } = setup()
    await expect(real.save(given('cell-editing'), EXPLICIT)).resolves.toEqual({ kind: 'failed', failure: { kind: 'cell-editing' }, requestId: undefined })
    expect(send).not.toHaveBeenCalled()
    expect(real.view()).toMatchObject({ status: 'clean', problem: { kind: 'cell-editing' } })
  })

  it('捕获超过上限：不压缩、不上传，提示容量上限；归为要等新内容', async () => {
    const { real, control, compress, send } = setup({ maxSnapshotBytes: 10 })
    control.edit('超过十个字节的内容')
    await expect(real.save(given(captureOf(1, '超过十个字节的内容')), AUTO)).resolves.toEqual({ kind: 'failed', failure: { kind: 'content' }, requestId: undefined })
    expect(compress).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(real.view()).toMatchObject({ status: 'failed', problem: { kind: 'too-large' } })
  })

  it('来源出错：按意外的错误处理（上报、保存失败），交回 unexpected，不发请求', async () => {
    const { real, send, reportError } = setup()
    const failure = new Error('SDK 的 save() 出错')
    const outcome = await real.save(() => {
      throw failure
    }, AUTO)
    expect(outcome).toEqual({ kind: 'failed', failure: { kind: 'unexpected' }, requestId: undefined })
    expect(send).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(real.view()).toMatchObject({ status: 'failed', problem: { kind: 'unexpected', error: failure } })
  })
})

describe('结果交给调用方的时机（onOutcome，M3-P4 S4）', () => {
  it('结果出来时、视图更新之前同步交给调用方：调用方此刻读到的视图还是保存中，之后的视图变化里已经有它记下的', async () => {
    const { real, control, calls } = setup()
    control.edit('甲')
    const order: string[] = []
    real.subscribe(() => order.push(`view:${real.view().status}`))
    const onOutcome = vi.fn((outcome: SaveOutcome) => order.push(`outcome:${outcome.kind}:${real.view().status}`))
    const saving = real.save(given(captureOf(1, '甲')), { ...AUTO, onOutcome })
    ;(await sent(calls, 1)).reject(new NetworkError('断网'))
    const outcome = await saving
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith(outcome)
    expect(order).toEqual(['view:saving', 'outcome:failed:saving', 'view:failed'])
  })

  it('调用方出错：上报，保存照常收尾', async () => {
    const { real, control, calls, reportError } = setup()
    control.edit('甲')
    const failure = new Error('调用方出错')
    const saving = real.save(given(captureOf(1, '甲')), { ...AUTO, onOutcome: () => {
      throw failure
    } })
    ;(await sent(calls, 1)).resolve(saved(2))
    await expect(saving).resolves.toMatchObject({ kind: 'saved' })
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(real.view().status).toBe('clean')
  })

  it('排着的每一次各自交一次自己的结果（连按的显式保存由调度合并，审查 A2）；停住、终态时直接交回的结果不调用（调用方等 save 兑现再处理）', async () => {
    const { real, control, calls } = setup()
    control.edit('甲')
    const first = real.save(given(captureOf(1, '甲')), EXPLICIT)
    const inFlight = await sent(calls, 1)
    const second = vi.fn()
    const third = vi.fn()
    const queued = real.save(given(captureOf(1, '甲')), { ...EXPLICIT, onOutcome: second })
    const later = real.save(given(captureOf(1, '甲')), { ...EXPLICIT, onOutcome: third })
    inFlight.resolve(saved(2))
    await first
    ;(await sent(calls, 2)).resolve(saved(3))
    await expect(queued).resolves.toEqual({ kind: 'saved', requestId: calls[1]?.request.requestId })
    ;(await sent(calls, 3)).resolve(saved(3))
    await expect(later).resolves.toEqual({ kind: 'saved', requestId: calls[2]?.request.requestId })
    expect(second).toHaveBeenCalledExactlyOnceWith({ kind: 'saved', requestId: calls[1]?.request.requestId })
    expect(third).toHaveBeenCalledExactlyOnceWith({ kind: 'saved', requestId: calls[2]?.request.requestId })
    real.stop()
    const stopped = vi.fn()
    await expect(real.save(given(captureOf(1, '甲')), { ...AUTO, onOutcome: stopped })).resolves.toEqual({ kind: 'skipped', reason: 'stopped' })
    expect(stopped).not.toHaveBeenCalled()
  })
})

describe('停住与终态时不做（skipped）', () => {
  it('停住时：不向来源要捕获，交回 skipped；恢复之后照常', async () => {
    const { real, control, calls } = setup()
    control.edit('甲')
    real.stop()
    const source = given(captureOf(1, '甲'))
    await expect(real.save(source, AUTO)).resolves.toEqual({ kind: 'skipped', reason: 'stopped' })
    expect(source).not.toHaveBeenCalled()
    real.resume()
    const saving = real.save(source, AUTO)
    ;(await sent(calls, 1)).resolve(saved(2))
    await expect(saving).resolves.toMatchObject({ kind: 'saved' })
  })

  it('排着的时候停住了：轮到时不做', async () => {
    const { real, control, calls } = setup()
    control.edit('甲')
    void real.save(given(captureOf(1, '甲')), AUTO)
    const inFlight = await sent(calls, 1)
    const source = given(captureOf(1, '甲'))
    const queued = real.save(source, EXPLICIT)
    real.stop()
    inFlight.resolve(saved(2))
    await expect(queued).resolves.toEqual({ kind: 'skipped', reason: 'stopped' })
    expect(source).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it('准备期间（提交单元格、等公式）停住了：捕获了也不发', async () => {
    const { real, control, send } = setup()
    control.edit('甲')
    let finish: ((capture: PreparedCapture) => void) | undefined
    const saving = real.save(async () => new Promise<PreparedCapture>((resolve) => {
      finish = resolve
    }), EXPLICIT)
    await vi.waitFor(() => expect(finish).toBeDefined())
    real.stop()
    finish?.(captureOf(1, '甲'))
    await expect(saving).resolves.toEqual({ kind: 'skipped', reason: 'stopped' })
    expect(send).not.toHaveBeenCalled()
  })

  it('终态（版本冲突、不兼容）之后：交回 ended，不向来源要捕获', async () => {
    const { real, control, calls } = setup()
    control.edit('甲')
    const saving = real.save(given(captureOf(1, '甲')), AUTO)
    ;(await sent(calls, 1)).reject(conflictError(5, { clientInstanceId: OTHER_TAB, localSeq: 2 }))
    await expect(saving).resolves.toEqual({ kind: 'failed', failure: { kind: 'terminal' }, requestId: calls[0]?.request.requestId })
    const source = given(captureOf(1, '甲'))
    await expect(real.save(source, EXPLICIT)).resolves.toEqual({ kind: 'skipped', reason: 'ended' })
    expect(source).not.toHaveBeenCalled()

    const blocked = setup()
    blocked.real.block('client-outdated')
    await expect(blocked.real.save(source, AUTO)).resolves.toEqual({ kind: 'skipped', reason: 'ended' })
  })

  it('续租得知不兼容时有保存排着：在途与排着的都算"结果没有着落"，先等它们（排着的轮到时不做），在途的以结果未知结束就原样重发一次', async () => {
    const { real, control, calls } = setup({ baseRevision: 3 })
    control.edit('甲')
    void real.save(given(captureOf(1, '甲')), AUTO)
    const inFlight = await sent(calls, 1)
    // 排着的是显式保存：轮到时已经是终态，不向来源要捕获（不提交用户正在编辑的单元格、不捕获）
    const source = given(captureOf(1, '甲'))
    const queued = real.save(source, EXPLICIT)
    real.block('client-outdated')
    expect(real.view()).toMatchObject({ status: 'outdated', checking: true })
    inFlight.reject(new NetworkError('断网'))
    await expect(queued).resolves.toEqual({ kind: 'skipped', reason: 'ended' })
    expect(source).not.toHaveBeenCalled()
    const replay = await sent(calls, 2)
    expect(replay.request).toEqual(inFlight.request)
    replay.resolve(saved(4))
    await real.settled()
    expect(real.view()).toMatchObject({ status: 'outdated', checking: false, unsaved: false })
  })
})

describe('会话内去重（M3-P4 设计 §3.7：键是快照字节的摘要连同"公式待更新"，与最近一次确认过的相同就不上传）', () => {
  /** 改一处、自动保存确认（摘要 sha256:甲，修订 2）：交回状态机与假接口 */
  async function confirmedOnce(extra: Partial<SnapshotCapture> = {}) {
    const context = setup()
    context.control.edit('甲')
    const saving = context.real.save(given(captureOf(1, '甲', extra)), AUTO)
    ;(await sent(context.calls, 1)).resolve(saved(2))
    await saving
    return context
  }

  it('打开时不知道服务端的键：第一次照常上传', async () => {
    const { real, control, calls } = setup()
    control.edit('甲')
    void real.save(given(captureOf(1, '甲')), AUTO)
    expect((await sent(calls, 1)).request.localSeq).toBe(1)
  })

  it('改了又撤销（内容与最近一次确认过的相同）：不压缩、不上传，按这次捕获的序号确认，基准不变', async () => {
    const { real, control, calls, compress } = await confirmedOnce()
    control.edit('甲乙')
    control.edit('甲')
    expect(real.view().status).toBe('dirty')
    await expect(real.save(given(captureOf(3, '甲')), AUTO)).resolves.toEqual({ kind: 'deduped' })
    expect(calls).toHaveLength(1)
    expect(compress).toHaveBeenCalledOnce()
    expect(real.view()).toMatchObject({ status: 'clean', unsaved: false, problem: undefined })
    expect(real.baseRevision()).toBe(2)
  })

  it('内容相同、"公式待更新"不同：不被挡（补存要清掉服务端的标记）', async () => {
    const { real, calls } = await confirmedOnce({ formulasPending: true })
    expect(real.view()).toMatchObject({ formulasPending: true, unsaved: true })
    const saving = real.save(given(captureOf(1, '甲')), AUTO)
    const recapture = await sent(calls, 2)
    expect(recapture.request).toMatchObject({ localSeq: 1, formulasPending: false })
    recapture.resolve({ revision: 2, savedAt: '2026-09-27T08:00:00.000Z', unchanged: true })
    await saving
    expect(real.view()).toMatchObject({ status: 'clean', formulasPending: false })
  })

  it('显式保存不去重：内容相同也上传（服务端只写回执，不加修订号）', async () => {
    const { real, calls } = await confirmedOnce()
    const saving = real.save(given(captureOf(1, '甲')), EXPLICIT)
    ;(await sent(calls, 2)).resolve({ revision: 2, savedAt: '2026-09-27T08:00:00.000Z', unchanged: true })
    await expect(saving).resolves.toMatchObject({ kind: 'saved' })
  })

  it('没有摘要（算不出）：这一次不去重；确认之后也不留键，下一次相同的内容照常上传', async () => {
    const { real, control, calls } = await confirmedOnce()
    control.edit('乙')
    const first = real.save(given(captureOf(2, '乙', { digest: undefined })), AUTO)
    ;(await sent(calls, 2)).resolve(saved(3))
    await first
    const second = real.save(given(captureOf(2, '乙')), AUTO)
    ;(await sent(calls, 3)).resolve({ revision: 3, savedAt: '2026-09-27T08:00:00.000Z', unchanged: true })
    await expect(second).resolves.toMatchObject({ kind: 'saved' })
  })

  it('有一次结果未知的请求（服务端上可能是它的内容）：内容回到确认过的那样也照常上传，不当作已确认；冲突的来源是它时照常自己追自己', async () => {
    const { real, control, calls } = await confirmedOnce()
    control.edit('甲乙')
    const lost = real.save(given(captureOf(2, '甲乙')), AUTO)
    const unknown = await sent(calls, 2)
    unknown.reject(new NetworkError('回包丢了'))
    await lost
    control.edit('甲')
    const undo = real.save(given(captureOf(3, '甲')), AUTO)
    const stale = await sent(calls, 3)
    expect(stale.request).toMatchObject({ baseRevision: 2, localSeq: 3, snapshot: '{"content":"甲"}' })
    stale.reject(conflictError(3, { clientInstanceId: ME, localSeq: 2 }))
    const rebased = await sent(calls, 4)
    expect(rebased.request).toMatchObject({ baseRevision: 3, localSeq: 3 })
    rebased.resolve(saved(4))
    await expect(undo).resolves.toEqual({ kind: 'saved', requestId: rebased.request.requestId })
    expect(real.view()).toMatchObject({ status: 'clean', unsaved: false })
  })

  it('原样重发核对出那一次其实已经提交：按它的键确认，之后同样的内容去重', async () => {
    const { real, control, calls } = await confirmedOnce()
    control.edit('甲乙')
    const lost = real.save(given(captureOf(2, '甲乙')), AUTO)
    ;(await sent(calls, 2)).reject(new NetworkError('回包丢了'))
    await lost
    const replaying = real.replayUnknownOutcome()
    ;(await sent(calls, 3)).resolve(saved(3))
    await expect(replaying).resolves.toBe('committed')
    await expect(real.save(given(captureOf(2, '甲乙')), AUTO)).resolves.toEqual({ kind: 'deduped' })
    expect(calls).toHaveLength(3)
  })
})

describe('被拒、再试也一样的内容（M3-P4 设计 §3.8：同一个去重键不重试，有新的捕获才再试）', () => {
  const INVALID = new ApiError(422, 'SNAPSHOT_INVALID', '表格内容的格式不正确')

  it('同样的内容不再发（说明照旧），显式保存照发；新的内容照常发，成功之后忘掉被拒的那个', async () => {
    const { real, control, calls } = setup()
    control.edit('坏')
    const first = real.save(given(captureOf(1, '坏')), AUTO)
    ;(await sent(calls, 1)).reject(INVALID)
    await expect(first).resolves.toEqual({ kind: 'failed', failure: { kind: 'content' }, requestId: calls[0]?.request.requestId })
    await expect(real.save(given(captureOf(1, '坏')), AUTO)).resolves.toEqual({ kind: 'failed', failure: { kind: 'content' }, requestId: undefined })
    expect(calls).toHaveLength(1)
    expect(real.view()).toMatchObject({ status: 'failed', problem: { kind: 'request', error: INVALID } })
    // 显式保存一律上传（用户在强制同步）
    const forced = real.save(given(captureOf(1, '坏')), EXPLICIT)
    ;(await sent(calls, 2)).reject(INVALID)
    await forced
    control.edit('好')
    const fixed = real.save(given(captureOf(2, '好')), AUTO)
    ;(await sent(calls, 3)).resolve(saved(2))
    await fixed
    expect(real.view()).toMatchObject({ status: 'clean', problem: undefined })
    control.edit('坏')
    void real.save(given(captureOf(3, '坏')), AUTO)
    await sent(calls, 4)
  })

  it('同样的内容但"公式待更新"不同：键不同，照常发', async () => {
    const { real, control, calls } = setup()
    control.edit('坏')
    const first = real.save(given(captureOf(1, '坏')), AUTO)
    ;(await sent(calls, 1)).reject(INVALID)
    await first
    void real.save(given(captureOf(1, '坏', { formulasPending: true })), AUTO)
    await sent(calls, 2)
  })
})

describe('"公式待更新"的初值（M3-P4 设计 §3.5：进入编辑时申请编辑权的响应里的标记）', () => {
  it('带标记进入编辑：修改都已保存、只差公式（离开会提示）；重算收齐之后的补存确认了，标记随之清掉', async () => {
    const { real, calls } = setup({ initialFormulasPending: true })
    expect(real.view()).toMatchObject({ status: 'dirty', formulasPending: true, unsaved: true, unsavedEdits: false })
    expect(real.hasUnsavedWork()).toBe(true)
    const saving = real.save(given(captureOf(0, '重算之后')), AUTO)
    const recapture = await sent(calls, 1)
    expect(recapture.request).toMatchObject({ localSeq: 0, formulasPending: false })
    recapture.resolve(saved(2))
    await saving
    expect(real.view()).toMatchObject({ status: 'clean', formulasPending: false, unsaved: false })
    expect(real.hasUnsavedWork()).toBe(false)
  })

  it('不带标记（默认）：打开时已保存到云端', () => {
    expect(setup().real.view()).toMatchObject({ status: 'clean', formulasPending: false })
  })
})

describe('失败的归类（M3-P4 设计 §3.8：会自动重试 / 要等新内容 / 要等会话 / 终态）', () => {
  it.each<[string, unknown, SaveFailure]>([
    ['网络错误', new NetworkError('断网'), { kind: 'retry', retryAfterMs: undefined }],
    ['5xx', new ApiError(500, 'INTERNAL_ERROR', '出错了'), { kind: 'retry', retryAfterMs: undefined }],
    ['回包读不出来', new ResponseFormatError('回包不对'), { kind: 'retry', retryAfterMs: undefined }],
    ['503 带 Retry-After（检查池满、每个账户 2 份、数据库繁忙）', new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙', { retryAfterSeconds: 7 }), { kind: 'retry', retryAfterMs: 7000 }],
    ['503 不带 Retry-After', new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙'), { kind: 'retry', retryAfterMs: undefined }],
    ['反向代理自己回的 503（不是约定的格式）带 Retry-After（审查 A10）', new ApiError(503, 'UNKNOWN', '意外的响应', { retryAfterSeconds: 20 }), { kind: 'retry', retryAfterMs: 20_000 }],
    ['429 带 Retry-After', new ApiError(429, 'TOO_MANY_REQUESTS', '太频繁', { retryAfterSeconds: 3 }), { kind: 'retry', retryAfterMs: 3000 }],
    ['requestId 被占用（下次换新的）', new ApiError(409, 'REQUEST_ID_CONFLICT', '被占用'), { kind: 'retry', retryAfterMs: undefined }],
    ['编辑权中断（编辑租约在续上）', new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'expired' } }), { kind: 'retry', retryAfterMs: undefined }],
    ['不能编辑了（编辑租约处理，失效了页面停住保存）', new ApiError(403, 'PERMISSION_DENIED', '只能查看'), { kind: 'retry', retryAfterMs: undefined }],
    ['读不到了（同上）', new ApiError(404, 'NOT_FOUND', '不存在'), { kind: 'retry', retryAfterMs: undefined }],
    ['未登录', new ApiError(401, 'UNAUTHENTICATED', '未登录'), { kind: 'session' }],
    ['登录已过期', new ApiError(401, 'SESSION_EXPIRED', '登录已过期'), { kind: 'session' }],
    ['令牌失效', new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'), { kind: 'session' }],
    ['快照不合格', new ApiError(422, 'SNAPSHOT_INVALID', '格式不正确'), { kind: 'content' }],
    ['超过上限', new ApiError(413, 'PAYLOAD_TOO_LARGE', '太大'), { kind: 'content' }],
    ['请求不合法', new ApiError(400, 'REQUEST_INVALID', '不合法'), { kind: 'content' }],
    ['版本冲突', conflictError(3, null), { kind: 'terminal' }],
    ['本页过旧', new ApiError(409, 'CLIENT_OUTDATED', '过旧'), { kind: 'terminal' }],
    ['文档太新', new ApiError(409, 'DOCUMENT_TOO_NEW', '太新'), { kind: 'terminal' }],
  ])('%s', (_case, error, expected) => {
    expect(classifySaveError(error)).toEqual(expected)
  })

  it('保存的结果带上归类与发出的 requestId', async () => {
    const { real, control, calls } = setup()
    control.edit('甲')
    const busy = new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙', { retryAfterSeconds: 5 })
    const saving = real.save(given(captureOf(1, '甲')), AUTO)
    ;(await sent(calls, 1)).reject(busy)
    await expect(saving).resolves.toEqual({ kind: 'failed', failure: { kind: 'retry', retryAfterMs: 5000 }, requestId: calls[0]?.request.requestId })
    // 503 是服务端说没有生效，但原样重发同一个 requestId 也安全（P3 交接单）：内容没变就原样重发
    const retry = real.save(given(captureOf(1, '甲')), AUTO)
    const again = await sent(calls, 2)
    expect(again.request).toEqual(calls[0]?.request)
    again.resolve(saved(2))
    await expect(retry).resolves.toEqual({ kind: 'saved', requestId: calls[0]?.request.requestId })
  })
})

describe('定时捕获的大小与出错（autosave.ts 在保存之外捕获）', () => {
  it('捕获了一次：视图的大小随之更新（80% 的提示不等上传），通知订阅者', () => {
    const { real } = setup()
    const listener = vi.fn()
    real.subscribe(listener)
    real.noteCapture(captureOf(1, '甲'))
    expect(real.view().snapshotBytes).toBe(17)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('捕获出错：上报，显示保存失败（意外的错误）；之后一次保存成功时清掉；终态之后只上报', async () => {
    const { real, control, calls, reportError } = setup()
    control.edit('甲')
    const failure = new Error('捕获出错')
    real.captureFailed(failure)
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(real.view()).toMatchObject({ status: 'failed', problem: { kind: 'unexpected', error: failure } })
    const saving = real.save(given(captureOf(1, '甲')), AUTO)
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(real.view()).toMatchObject({ status: 'clean', problem: undefined })

    real.block('document-too-new')
    real.captureFailed(failure)
    expect(reportError).toHaveBeenCalledTimes(2)
    expect(real.view()).toMatchObject({ status: 'too-new', problem: undefined })
  })
})
